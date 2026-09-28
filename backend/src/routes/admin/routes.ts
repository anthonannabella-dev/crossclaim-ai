import { Router } from 'express';
import * as XLSX from 'xlsx';
import prisma from '../../config/database';
import { authenticateAdmin } from '../../middleware/auth';
import { getUsage } from '../../services/usageTracker';
import { getMinio } from '../../config/minio';
import { getFeatureUsageStats, getActiveUserStats } from '../../services/analyticsService';

const router = Router();

// 所有管理后台路由需要管理员认证
router.use(authenticateAdmin);

// ========== 数据大盘 ==========

router.get('/stats', async (_req, res) => {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const weekEnd = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  const [
    totalTenants, trialCount, paidCount, frozenCount,
    enterpriseCount, expiringCount,
    revenueMonth, revenueTotal,
    apiCallMonth, apiCallTotal,
    documentCount, auditCount, onlineUsers,
  ] = await Promise.all([
    prisma.tenant.count(),
    prisma.tenant.count({ where: { status: 'TRIAL' } }),
    prisma.tenant.count({ where: { status: 'ACTIVE' } }),
    prisma.tenant.count({ where: { status: { in: ['FROZEN', 'DISABLED'] } } }),
    prisma.tenant.count({ where: { planTier: 'ENTERPRISE' } }),
    prisma.tenant.count({
      where: {
        status: { in: ['ACTIVE', 'TRIAL'] },
        OR: [
          { expiresAt: { lte: weekEnd, not: null } },
          { trialEndAt: { lte: weekEnd } },
        ],
      },
    }),
    prisma.payment.aggregate({
      where: { status: 'success', paidAt: { gte: monthStart } },
      _sum: { amount: true },
    }),
    prisma.payment.aggregate({
      where: { status: 'success' },
      _sum: { amount: true },
    }),
    prisma.apiCallLog.count({ where: { createdAt: { gte: monthStart } } }),
    prisma.apiCallLog.count(),
    prisma.document.count(),
    prisma.auditLog.count(),
    prisma.apiToken.count({
      where: {
        lastUsedAt: { gte: new Date(Date.now() - 15 * 60 * 1000) },
      },
    }),
  ]);

  res.json({
    totalTenants, trialCount, paidCount, frozenCount,
    enterpriseCount, expiringCount,
    revenueMonth: revenueMonth._sum?.amount || 0,
    revenueTotal: revenueTotal._sum?.amount || 0,
    apiCallMonth, apiCallTotal,
    documentCount, auditCount, onlineUsers,
  });
});

// ========== 客户档案 ==========

router.get('/tenants', async (req, res) => {
  const { status } = req.query;
  const where: any = {};
  if (status && status !== 'all') {
    where.status = status;
  }
  const tenants = await prisma.tenant.findMany({
    where,
    orderBy: { createdAt: 'desc' },
  });
  tenants.forEach((t: any) => { (t as any).passwordHash = undefined; });
  res.json(tenants);
});

// 冻结租户
router.post('/tenants/:id/freeze', async (req, res) => {
  await prisma.tenant.update({
    where: { id: req.params.id },
    data: { status: 'FROZEN', frozenAt: new Date() },
  });

  await prisma.auditLog.create({
    data: {
      action: 'admin_freeze',
      detail: `管理员冻结企业 ${req.params.id}`,
      operatorId: (req as any).admin.adminId,
    },
  });

  res.json({ message: '已冻结' });
});

// 解除登录锁定
router.post('/tenants/:id/unlock', async (req, res) => {
  await prisma.tenant.update({
    where: { id: req.params.id },
    data: { failedLoginAttempts: 0, lockedUntil: null },
  });
  await prisma.auditLog.create({
    data: {
      action: 'admin_unlock',
      detail: `管理员解除企业登录锁定 ${req.params.id}`,
      operatorId: (req as any).admin.adminId,
    },
  });
  res.json({ message: '已解除登录锁定' });
});

// 解封租户
router.post('/tenants/:id/unfreeze', async (req, res) => {
  await prisma.tenant.update({
    where: { id: req.params.id },
    data: { status: 'ACTIVE', frozenAt: null },
  });

  await prisma.auditLog.create({
    data: {
      action: 'admin_unfreeze',
      detail: `管理员解封企业 ${req.params.id}`,
      operatorId: (req as any).admin.adminId,
    },
  });

  res.json({ message: '已解封' });
});

// ========== 收费台账 ==========

router.get('/payments', async (_req, res) => {
  const payments = await prisma.payment.findMany({
    orderBy: { createdAt: 'desc' },
    include: { tenant: { select: { companyName: true } } },
  });
  res.json(payments);
});

router.get('/payments/summary', async (_req, res) => {
  const successPayments = await prisma.payment.findMany({
    where: { status: 'success' },
  });
  const pendingPayments = await prisma.payment.findMany({
    where: { status: 'pending' },
  });

  const totalCollected = successPayments.reduce((s: number, p: { amount: number }) => s + p.amount, 0);
  const totalReceivable = pendingPayments.reduce((s: number, p: { amount: number }) => s + p.amount, 0);

  res.json({
    totalCollected,
    totalReceivable,
    totalTransactions: successPayments.length,
  });
});

// ========== 到期管控 ==========

router.get('/expiring', async (req, res) => {
  const { days = '7' } = req.query;
  const threshold = new Date(Date.now() + Number(days) * 24 * 60 * 60 * 1000);

  const expiring = await prisma.tenant.findMany({
    where: {
      status: { in: ['ACTIVE', 'TRIAL'] },
      OR: [
        { expiresAt: { lte: threshold, not: null } },
        { trialEndAt: { lte: threshold } },
      ],
    },
    orderBy: { expiresAt: 'asc' },
  });
  expiring.forEach((t: any) => { (t as any).passwordHash = undefined; });

  res.json(expiring);
});

// 批量发送续费提醒
router.post('/send-renewal-reminders', async (req, res) => {
  const { tenantIds } = req.body;

  await prisma.auditLog.create({
    data: {
      action: 'admin_renewal_reminder',
      detail: `批量发送续费提醒: ${tenantIds?.join(',')}`,
      operatorId: (req as any).admin.adminId,
    },
  });

  // 通过统一通知中心发送企微/飞书消息
  try {
    const { sendBatchReminders } = await import('../../services/notificationHub');
    await sendBatchReminders(
      tenantIds,
      'subscription_expiring',
      '续费提醒',
      '您的平台订阅即将到期，请及时续费以保持服务不中断。如需帮助，请联系客服。'
    );
  } catch {
    // 通知发送失败不影响主流程
  }

  res.json({ message: `已向${tenantIds?.length || 0}名客户发送续费提醒` });
});

// ========== API监控 ==========

router.get('/api-tokens', async (_req, res) => {
  const tokens = await prisma.apiToken.findMany({
    include: { tenant: { select: { companyName: true } } },
    orderBy: { totalCalls: 'desc' },
  });
  res.json(tokens);
});

router.get('/api-tokens/:id/logs', async (req, res) => {
  const logs = await prisma.apiCallLog.findMany({
    where: { tokenId: req.params.id },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  res.json(logs);
});

// ========== 赠时管理 ==========

// 赠时列表
router.get('/time-grants', async (_req, res) => {
  const grants = await prisma.timeGrant.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      tenant: { select: { companyName: true } },
      admin: { select: { username: true } },
    },
  });
  res.json(grants);
});

// 赠时操作 (单选/批量)
router.post('/time-grants', async (req, res) => {
  const { tenantIds, daysGranted, monthsGranted, reason } = req.body;
  const adminId = (req as any).admin.adminId;

  if (!tenantIds || !Array.isArray(tenantIds) || tenantIds.length === 0) {
    res.status(400).json({ error: '请选择至少一个客户' });
    return;
  }

  if (!daysGranted && !monthsGranted) {
    res.status(400).json({ error: '赠送天数或月数至少填写一项' });
    return;
  }

  const results = [];

  for (const tenantId of tenantIds) {
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) continue;

    // 计算新的到期时间
    const totalDays = (daysGranted || 0) + (monthsGranted || 0) * 30;
    const currentExpiry = tenant.expiresAt || new Date();
    const newExpiry = new Date(currentExpiry.getTime() + totalDays * 24 * 60 * 60 * 1000);

    await prisma.tenant.update({
      where: { id: tenantId },
      data: { expiresAt: newExpiry },
    });

    const grant = await prisma.timeGrant.create({
      data: {
        tenantId,
        adminId,
        daysGranted: daysGranted || 0,
        monthsGranted: monthsGranted || 0,
        reason,
      },
    });

    await prisma.auditLog.create({
      data: {
        tenantId,
        action: 'time_grant',
        detail: `管理员赠时: ${daysGranted}天/${monthsGranted}月, 新到期: ${newExpiry.toISOString()}`,
        operatorId: adminId,
      },
    });

    results.push(grant);
  }

  res.status(201).json({ message: `成功为 ${results.length} 名客户赠时`, results });
});

// ========== 系统公告 ==========

router.get('/announcements', async (req, res) => {
  const { all } = req.query;
  const where: any = all === 'true' ? {} : { isActive: true };
  const announcements = await prisma.announcement.findMany({
    where,
    orderBy: { createdAt: 'desc' },
  });
  res.json(announcements);
});

router.post('/announcements', async (req, res) => {
  const { title, content } = req.body;
  const announcement = await prisma.announcement.create({
    data: { title, content },
  });
  await prisma.auditLog.create({
    data: {
      action: 'admin_announcement_create',
      detail: `管理员创建公告: ${title}`,
      operatorId: (req as any).admin.adminId,
    },
  });
  res.status(201).json(announcement);
});

router.put('/announcements/:id', async (req, res) => {
  const { title, content, isActive } = req.body;
  const data: any = {};
  if (title !== undefined) data.title = title;
  if (content !== undefined) data.content = content;
  if (isActive !== undefined) data.isActive = isActive;
  const announcement = await prisma.announcement.update({
    where: { id: req.params.id },
    data,
  });
  res.json(announcement);
});

router.delete('/announcements/:id', async (req, res) => {
  await prisma.announcement.update({
    where: { id: req.params.id },
    data: { isActive: false },
  });
  await prisma.auditLog.create({
    data: {
      action: 'admin_announcement_deactivate',
      detail: `管理员停用公告 ${req.params.id}`,
      operatorId: (req as any).admin.adminId,
    },
  });
  res.json({ message: '已停用' });
});

// ========== 法规预警管理 ==========

router.get('/policy-alerts', async (req, res) => {
  const { category } = req.query;
  const where: any = {};
  if (category) where.category = category;
  const alerts = await prisma.policyAlert.findMany({
    where,
    orderBy: { publishDate: 'desc' },
  });
  res.json(alerts);
});

router.post('/policy-alerts', async (req, res) => {
  const { title, content, summary, source, publishDate, category, hsCode } = req.body;
  const alert = await prisma.policyAlert.create({
    data: {
      title,
      content: content || '',
      summary: summary || '',
      source: source || '海关总署',
      publishDate: publishDate ? new Date(publishDate) : new Date(),
      category: category || 'customs',
      hsCode: hsCode || null,
    },
  });
  await prisma.auditLog.create({
    data: {
      action: 'admin_policy_create',
      detail: `管理员创建法规预警: ${title}`,
      operatorId: (req as any).admin.adminId,
    },
  });

  // Webhook广播事件（系统级，通知所有订阅租户）
  import('../../services/webhook/eventEmitter').then(({ eventEmitter }) =>
    eventEmitter.broadcast('policy.updated', {
      title,
      category,
      hsCode: hsCode || null,
      summary: summary || '',
      source: source || '海关总署',
    }).catch(() => {}),
  );

  res.status(201).json(alert);
});

router.put('/policy-alerts/:id', async (req, res) => {
  const { title, content, summary, source, publishDate, category, hsCode, isActive } = req.body;
  const data: any = {};
  if (title !== undefined) data.title = title;
  if (content !== undefined) data.content = content;
  if (summary !== undefined) data.summary = summary;
  if (source !== undefined) data.source = source;
  if (publishDate !== undefined) data.publishDate = new Date(publishDate);
  if (category !== undefined) data.category = category;
  if (hsCode !== undefined) data.hsCode = hsCode;
  if (isActive !== undefined) data.isActive = isActive;
  const alert = await prisma.policyAlert.update({
    where: { id: req.params.id },
    data,
  });
  res.json(alert);
});

router.delete('/policy-alerts/:id', async (req, res) => {
  await prisma.policyAlert.update({
    where: { id: req.params.id },
    data: { isActive: false },
  });
  await prisma.auditLog.create({
    data: {
      action: 'admin_policy_deactivate',
      detail: `管理员停用法规则预警 ${req.params.id}`,
      operatorId: (req as any).admin.adminId,
    },
  });
  res.json({ message: '已停用' });
});

// ========== 数据库备份 ==========

router.get('/backups', async (_req, res) => {
  const minio = getMinio();
  if (!minio) {
    res.json({ backups: [], note: 'MinIO not available' });
    return;
  }
  const backups: { name: string; size: number; date: Date }[] = [];
  try {
    const objects = await minio.listObjects('database-backups', '', true);
    for await (const obj of objects) {
      if (obj.name) {
        backups.push({
          name: obj.name,
          size: obj.size || 0,
          date: obj.lastModified || new Date(0),
        });
      }
    }
    backups.sort((a, b) => b.date.getTime() - a.date.getTime());
  } catch { /* bucket might not exist yet */ }
  res.json({ backups });
});

router.post('/backups/trigger', async (req, res) => {
  const { runDatabaseBackup } = await import('../../services/backupService');
  runDatabaseBackup().then(ok => {
    console.log(`[Admin] Manual backup ${ok ? 'succeeded' : 'failed'}`);
  });
  res.json({ message: '备份已触发，请稍后查看结果' });
});

// ========== 数据导出 (Excel) ==========

router.get('/export/:type', async (req, res) => {
  const { type } = req.params;
  const { startDate, endDate } = req.query;

  let data: any[] = [];

  switch (type) {
    case 'tenants':
      data = await prisma.tenant.findMany(); data.forEach(t => { (t as any).passwordHash = undefined; });
      break;
    case 'payments':
      data = await prisma.payment.findMany({
        where: {
          ...(startDate && endDate ? {
            createdAt: { gte: new Date(startDate as string), lte: new Date(endDate as string) },
          } : {}),
        },
      });
      break;
    case 'time-grants':
      data = await prisma.timeGrant.findMany({
        include: { tenant: { select: { companyName: true } }, admin: { select: { username: true } } },
      });
      break;
    default:
      res.status(400).json({ error: '不支持的导出类型' });
      return;
  }

  // 生成Excel文件
  const exportMap: Record<string, { sheetName: string; headers: string[]; rows: (d: any) => any[] }> = {
    tenants: {
      sheetName: '客户档案',
      headers: ['企业名称', '联系人', '联系电话', '邮箱', '套餐', '付费方式', '状态', '注册时间', '到期时间'],
      rows: (d: any) => [d.companyName, d.contactName, d.contactPhone, d.contactEmail, d.planTier, d.paymentCycle, d.status, d.createdAt ? new Date(d.createdAt).toLocaleDateString('zh-CN') : '', d.expiresAt ? new Date(d.expiresAt).toLocaleDateString('zh-CN') : ''],
    },
    payments: {
      sheetName: '收费台账',
      headers: ['订单号', '金额', '套餐', '付费周期', '支付方式', '状态', '时间'],
      rows: (d: any) => [d.transactionId?.slice(0, 16), d.amount, d.planTier, d.paymentCycle === 'ANNUAL' ? '年付' : '月付', d.paymentMethod === 'wechat' ? '微信' : '支付宝', d.status, d.createdAt ? new Date(d.createdAt).toLocaleString('zh-CN') : ''],
    },
    'time-grants': {
      sheetName: '赠时台账',
      headers: ['客户名称', '赠送天数', '赠送月数', '操作人', '备注', '操作时间'],
      rows: (d: any) => [d.tenant?.companyName || '', d.daysGranted, d.monthsGranted, d.admin?.username || '', d.reason || '', d.createdAt ? new Date(d.createdAt).toLocaleString('zh-CN') : ''],
    },
  };

  const cfg = exportMap[type];
  const sheetData = [cfg.headers, ...data.map(cfg.rows)];
  const ws = XLSX.utils.aoa_to_sheet(sheetData);
  ws['!cols'] = cfg.headers.map(() => ({ wch: 20 }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, cfg.sheetName);
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  const filename = encodeURIComponent(`${cfg.sheetName}_${new Date().toISOString().slice(0, 10)}.xlsx`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename}`);
  res.send(buf);
});

// ========== 用户行为分析 ==========

router.get('/analytics/features', async (req, res) => {
  const days = Number(req.query.days) || 30;
  const stats = await getFeatureUsageStats(days);
  res.json(stats);
});

router.get('/analytics/active-users', async (_req, res) => {
  const stats = await getActiveUserStats();
  res.json(stats);
});

// ========== 用量监控 ==========

// 全平台用量总览
router.get('/usage/overview', async (_req, res) => {
  const [tenantCount, totalDocuments, todayUsage] = await Promise.all([
    prisma.tenant.count(),
    prisma.document.count(),
    prisma.tenantUsage.findMany({
      where: {
        period: 'daily',
        periodKey: new Date().toISOString().slice(0, 10),
      },
    }),
  ]);

  const resourceTotals: Record<string, number> = {};
  for (const u of todayUsage) {
    resourceTotals[u.resource] = (resourceTotals[u.resource] || 0) + u.count;
  }

  const aiCallsToday = resourceTotals['ai_classify'] || 0;
  const apiCallsToday = resourceTotals['api_call'] || 0;

  const planDistribution = {
    TRIAL: await prisma.tenant.count({ where: { planTier: 'TRIAL' } }),
    BASIC: await prisma.tenant.count({ where: { planTier: 'BASIC' } }),
    PROFESSIONAL: await prisma.tenant.count({ where: { planTier: 'PROFESSIONAL' } }),
    ENTERPRISE: await prisma.tenant.count({ where: { planTier: 'ENTERPRISE' } }),
  };

  res.json({
    tenantCount,
    totalDocuments,
    aiCallsToday,
    apiCallsToday,
    planDistribution,
    resourceBreakdown: resourceTotals,
  });
});

// 单个租户用量详情
router.get('/usage/:tenantId', async (req, res) => {
  const tenant = await prisma.tenant.findUnique({
    where: { id: req.params.tenantId },
    select: { id: true, companyName: true, planTier: true, status: true },
  });

  if (!tenant) {
    res.status(404).json({ error: '租户不存在' });
    return;
  }

  const usage = await getUsage(tenant.id, tenant.planTier);
  res.json({ tenant, usage });
});

export default router;
