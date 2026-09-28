import { Router } from 'express';
import prisma from '../../config/database';
import { authenticate } from '../../middleware/auth';
import { requireActiveTenant } from '../../middleware/tenant';
import { hashPassword, comparePassword } from '../../utils/crypto';
import { PLAN_QUOTAS } from '../../config/planQuotas';

// 租户自助管理（子账号 / 企业资料 / 修改密码）。
// 以独立文件挂载到 /tenant,不覆盖可能含真实实现的 tenant.ts；复用与登录一致的
// hashPassword/comparePassword 原语,不自造加密逻辑。子账号(SubAccountsPage)、设置(SettingsPage)依赖。
const router = Router();
router.use(authenticate);
router.use(requireActiveTenant);

const planTierOf = (req: any) => req.tenantRecord?.planTier || 'TRIAL';

// ---------- 子账号 ----------
router.get('/sub-accounts', async (req, res) => {
  try {
    const list = await prisma.subAccount.findMany({
      where: { tenantId: req.tenant!.tenantId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, username: true, role: true, isActive: true, createdAt: true },
    });
    res.json(list); // 前端 setSubAccounts(res.data) 直接用数组
  } catch (err: any) {
    res.status(500).json({ error: err.message || '获取子账号失败' });
  }
});

router.post('/sub-accounts', async (req, res) => {
  const tenantId = req.tenant!.tenantId;
  const { username, password, role } = req.body;
  if (!username || !password) { res.status(400).json({ error: '请填写用户名和密码' }); return; }
  if (String(password).length < 8) { res.status(400).json({ error: '密码至少8位' }); return; }

  try {
    // 席位配额：按当前套餐 subAccounts 上限
    const limit = (PLAN_QUOTAS[planTierOf(req)] || PLAN_QUOTAS.TRIAL).subAccounts;
    const count = await prisma.subAccount.count({ where: { tenantId } });
    if (count >= limit) {
      res.status(400).json({ error: `当前套餐子账号上限为 ${limit} 个,如需更多请升级套餐` });
      return;
    }
    const exists = await prisma.subAccount.findFirst({ where: { tenantId, username } });
    if (exists) { res.status(400).json({ error: '该用户名已存在' }); return; }

    const sub = await prisma.subAccount.create({
      data: { tenantId, username, passwordHash: await hashPassword(password), role: role || 'operator' },
      select: { id: true, username: true, role: true, isActive: true, createdAt: true },
    });
    await prisma.auditLog.create({ data: { tenantId, action: 'sub_account_created', detail: `创建子账号 ${username}(${sub.role})` } });
    res.json(sub);
  } catch (err: any) {
    res.status(500).json({ error: err.message || '创建子账号失败' });
  }
});

router.patch('/sub-accounts/:id', async (req, res) => {
  const tenantId = req.tenant!.tenantId;
  const { id } = req.params;
  const { isActive, role } = req.body;
  try {
    const sub = await prisma.subAccount.findFirst({ where: { id, tenantId } });
    if (!sub) { res.status(404).json({ error: '子账号不存在' }); return; }
    const data: any = {};
    if (isActive !== undefined) data.isActive = !!isActive;
    if (role !== undefined) data.role = role;
    const updated = await prisma.subAccount.update({
      where: { id }, data,
      select: { id: true, username: true, role: true, isActive: true, createdAt: true },
    });
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message || '更新子账号失败' });
  }
});

router.delete('/sub-accounts/:id', async (req, res) => {
  const tenantId = req.tenant!.tenantId;
  const { id } = req.params;
  try {
    const sub = await prisma.subAccount.findFirst({ where: { id, tenantId } });
    if (!sub) { res.status(404).json({ error: '子账号不存在' }); return; }
    await prisma.subAccount.delete({ where: { id } });
    await prisma.auditLog.create({ data: { tenantId, action: 'sub_account_deleted', detail: `删除子账号 ${sub.username}` } });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message || '删除子账号失败' });
  }
});

// ---------- 企业资料 ----------
router.patch('/profile', async (req, res) => {
  const tenantId = req.tenant!.tenantId;
  const { companyName, contactName, contactPhone, contactEmail } = req.body;
  const data: any = {};
  if (companyName !== undefined) data.companyName = companyName;
  if (contactName !== undefined) data.contactName = contactName;
  if (contactPhone !== undefined) data.contactPhone = contactPhone;
  if (contactEmail !== undefined) data.contactEmail = contactEmail;

  try {
    const updated = await prisma.tenant.update({
      where: { id: tenantId }, data,
      select: { id: true, companyName: true, contactName: true, contactPhone: true, contactEmail: true, planTier: true, status: true, trialEndAt: true, expiresAt: true },
    });
    await prisma.auditLog.create({ data: { tenantId, action: 'tenant_profile_updated', detail: '修改企业资料' } });
    res.json(updated); // 前端 setTenant(res.data)
  } catch (err: any) {
    if (err.code === 'P2002') { res.status(400).json({ error: '该联系邮箱已被占用' }); return; }
    res.status(500).json({ error: err.message || '更新企业资料失败' });
  }
});

// ---------- 修改密码 ----------
router.patch('/change-password', async (req, res) => {
  const tenantId = req.tenant!.tenantId;
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) { res.status(400).json({ error: '请填写当前密码和新密码' }); return; }
  if (String(newPassword).length < 6) { res.status(400).json({ error: '新密码至少6位' }); return; }

  try {
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) { res.status(404).json({ error: '租户不存在' }); return; }
    if (!tenant.passwordHash) { res.status(400).json({ error: '该账号未设置密码,无法通过此方式修改' }); return; }
    const ok = await comparePassword(currentPassword, tenant.passwordHash);
    if (!ok) { res.status(400).json({ error: '当前密码不正确' }); return; }

    await prisma.tenant.update({ where: { id: tenantId }, data: { passwordHash: await hashPassword(newPassword) } });
    await prisma.auditLog.create({ data: { tenantId, action: 'tenant_password_changed', detail: '修改登录密码' } });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message || '修改密码失败' });
  }
});

export default router;
