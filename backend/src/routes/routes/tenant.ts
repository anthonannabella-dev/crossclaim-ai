import { Router } from 'express';
import prisma from '../../config/database';
import { authenticate } from '../../middleware/auth';
import { hashPassword } from '../../utils/crypto';

const router = Router();

router.use(authenticate);

// 获取租户信息
router.get('/profile', async (req, res) => {
  const tenant = await prisma.tenant.findUnique({
    where: { id: req.tenant!.tenantId || (req.tenant as any).id },
  });
  if (tenant) {
    (tenant as any).passwordHash = undefined;
  }
  if (!tenant) {
    res.status(404).json({ error: '企业不存在' });
    return;
  }
  res.json(tenant);
});

// 更新企业信息
router.patch('/profile', async (req, res) => {
  const { companyName, contactName, contactPhone, contactEmail } = req.body;
  const tenantId = req.tenant!.tenantId;

  if (contactEmail) {
    const existing = await prisma.tenant.findUnique({ where: { contactEmail } });
    if (existing && existing.id !== tenantId) {
      res.status(409).json({ error: '该邮箱已被其他企业使用' });
      return;
    }
  }

  const updated = await prisma.tenant.update({
    where: { id: tenantId },
    data: {
      ...(companyName ? { companyName } : {}),
      ...(contactName ? { contactName } : {}),
      ...(contactPhone ? { contactPhone } : {}),
      ...(contactEmail ? { contactEmail } : {}),
    },
  });
  (updated as any).passwordHash = undefined;
  res.json(updated);
});

// 修改密码
router.patch('/change-password', async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const tenant = await prisma.tenant.findUnique({ where: { id: req.tenant!.tenantId } });
  if (!tenant) {
    res.status(404).json({ error: '企业不存在' });
    return;
  }

  const { comparePassword } = await import('../../utils/crypto');
  const valid = await comparePassword(currentPassword, tenant.passwordHash);
  if (!valid) {
    res.status(400).json({ error: '当前密码错误' });
    return;
  }

  const newHash = await hashPassword(newPassword);
  await prisma.tenant.update({
    where: { id: req.tenant!.tenantId || (req.tenant as any).id },
    data: { passwordHash: newHash },
  });

  await prisma.auditLog.create({
    data: {
      tenantId: req.tenant!.tenantId,
      action: 'password_change',
      detail: '修改登录密码',
    },
  });

  res.json({ message: '密码修改成功' });
});

// ========== 子账号管理 ==========

// 列出子账号
router.get('/sub-accounts', async (req, res) => {
  const tenant = await prisma.tenant.findUnique({ where: { id: req.tenant!.tenantId } });
  if (tenant?.planTier !== 'ENTERPRISE') {
    res.status(403).json({ error: '仅企业版支持子账号管理' });
    return;
  }

  const subs = await prisma.subAccount.findMany({
    where: { tenantId: req.tenant!.tenantId },
    select: { id: true, username: true, role: true, isActive: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });
  res.json(subs);
});

// 创建子账号
router.post('/sub-accounts', async (req, res) => {
  const { username, password, role } = req.body;

  const tenant = await prisma.tenant.findUnique({ where: { id: req.tenant!.tenantId } });
  if (tenant?.planTier !== 'ENTERPRISE') {
    res.status(403).json({ error: '仅企业版支持子账号' });
    return;
  }

  const existing = await prisma.subAccount.findFirst({
    where: { tenantId: req.tenant!.tenantId, username },
  });
  if (existing) {
    res.status(409).json({ error: '用户名已存在' });
    return;
  }

  const passwordHash = await hashPassword(password);
  const sub = await prisma.subAccount.create({
    data: { tenantId: req.tenant!.tenantId, username, passwordHash, role: role || 'operator' },
    select: { id: true, username: true, role: true, isActive: true, createdAt: true },
  });

  await prisma.auditLog.create({
    data: {
      tenantId: req.tenant!.tenantId,
      action: 'sub_account_create',
      detail: `创建子账号: ${username}, 角色: ${role || 'operator'}`,
    },
  });

  res.status(201).json(sub);
});

// 更新子账号 (启用/禁用/修改角色)
router.patch('/sub-accounts/:id', async (req, res) => {
  const { isActive, role } = req.body;
  const sub = await prisma.subAccount.findUnique({ where: { id: req.params.id } });

  if (!sub || sub.tenantId !== req.tenant!.tenantId) {
    res.status(404).json({ error: '子账号不存在' });
    return;
  }

  const updated = await prisma.subAccount.update({
    where: { id: req.params.id },
    data: { ...(isActive !== undefined ? { isActive } : {}), ...(role ? { role } : {}) },
    select: { id: true, username: true, role: true, isActive: true, createdAt: true },
  });

  res.json(updated);
});

// 删除子账号
router.delete('/sub-accounts/:id', async (req, res) => {
  const sub = await prisma.subAccount.findUnique({ where: { id: req.params.id } });

  if (!sub || sub.tenantId !== req.tenant!.tenantId) {
    res.status(404).json({ error: '子账号不存在' });
    return;
  }

  await prisma.subAccount.delete({ where: { id: req.params.id } });

  await prisma.auditLog.create({
    data: {
      tenantId: req.tenant!.tenantId,
      action: 'sub_account_delete',
      detail: `删除子账号: ${sub.username}`,
    },
  });

  res.json({ message: '子账号已删除' });
});

// 操作日志查询(本租户):支持按动作/关键词/时间检索 + 分页
router.get('/audit-logs', async (req, res) => {
  try {
    const tenantId = req.tenant!.tenantId;
    const { action, q, from, to, entityType, entityId, page = '1', pageSize = '20' } = req.query as Record<string, string>;
    const take = Math.min(parseInt(pageSize) || 20, 100);
    const skip = ((parseInt(page) || 1) - 1) * take;

    const where: any = { tenantId };
    if (action && action.trim()) where.action = action.trim();
    if (q && q.trim()) where.detail = { contains: q.trim() };
    if (entityType && entityType.trim()) where.entityType = entityType.trim();
    if (entityId && entityId.trim()) {
      // 精确实体匹配; 兼容存量未打标日志: entityId 命中 或 detail 包含该值
      where.OR = [
        { entityId: entityId.trim() },
        { detail: { contains: entityId.trim() } },
      ];
    }
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = new Date(from);
      if (to) where.createdAt.lte = new Date(to + 'T23:59:59');
    }

    const [logs, total, actions] = await Promise.all([
      prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
      prisma.auditLog.count({ where }),
      // 该租户出现过的动作类型(供前端筛选下拉)
      prisma.auditLog.findMany({ where: { tenantId }, distinct: ['action'], select: { action: true }, take: 100 }),
    ]);

    res.json({
      success: true,
      total,
      actions: actions.map((a: any) => a.action).sort(),
      data: logs.map((l: any) => ({
        id: l.id,
        action: l.action,
        detail: l.detail,
        entityType: l.entityType || null,
        entityId: l.entityId || null,
        operatorId: l.operatorId || null,
        ip: l.ip || null,
        createdAt: l.createdAt ? new Date(l.createdAt).toISOString() : null,
      })),
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || '查询操作日志失败' });
  }
});

export default router;
