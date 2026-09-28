import { Router } from 'express';
import crypto from 'crypto';
import prisma from '../../config/database';
import { authenticate } from '../../middleware/auth';
import { WEBHOOK_EVENT_TYPES } from '../../services/webhook/eventTypes';
import { deliverWebhook } from '../../services/webhook/deliverer';

const router = Router();
router.use(authenticate);

// 获取可用事件类型列表
router.get('/event-types', (_req, res) => {
  res.json(WEBHOOK_EVENT_TYPES);
});

// 列出当前租户的订阅
router.get('/', async (req, res) => {
  const subscriptions = await prisma.webhookSubscription.findMany({
    where: { tenantId: req.tenant!.tenantId },
    orderBy: { createdAt: 'desc' },
  });
  res.json(subscriptions);
});

// 创建订阅
router.post('/', async (req, res) => {
  const { name, url, events } = req.body;
  const tenantId = req.tenant!.tenantId;

  if (!name || !url || !events || !Array.isArray(events) || events.length === 0) {
    res.status(400).json({ error: '请填写订阅名称、回调URL和至少一个事件类型' });
    return;
  }

  if (!/^https?:\/\/.+/.test(url)) {
    res.status(400).json({ error: '回调URL必须以 http:// 或 https:// 开头' });
    return;
  }

  const validTypes = new Set(WEBHOOK_EVENT_TYPES.map(e => e.type));
  const invalid = events.filter((e: string) => !validTypes.has(e));
  if (invalid.length > 0) {
    res.status(400).json({ error: `无效的事件类型: ${invalid.join(', ')}` });
    return;
  }

  const secret = crypto.randomBytes(24).toString('hex');

  const subscription = await prisma.webhookSubscription.create({
    data: {
      tenantId,
      name,
      url,
      secret,
      events: JSON.stringify(events),
    },
  });

  res.status(201).json(subscription);
});

// 编辑订阅
router.put('/:id', async (req, res) => {
  const { name, url, events } = req.body;
  const sub = await prisma.webhookSubscription.findFirst({
    where: { id: req.params.id, tenantId: req.tenant!.tenantId },
  });

  if (!sub) {
    res.status(404).json({ error: '订阅不存在' });
    return;
  }

  const data: Record<string, unknown> = {};
  if (name !== undefined) data.name = name;
  if (url !== undefined) {
    if (!/^https?:\/\/.+/.test(url)) {
      res.status(400).json({ error: '回调URL必须以 http:// 或 https:// 开头' });
      return;
    }
    data.url = url;
  }
  if (events !== undefined) {
    const validTypes = new Set(WEBHOOK_EVENT_TYPES.map(e => e.type));
    const invalid = events.filter((e: string) => !validTypes.has(e));
    if (invalid.length > 0) {
      res.status(400).json({ error: `无效的事件类型: ${invalid.join(', ')}` });
      return;
    }
    data.events = JSON.stringify(events);
  }

  const updated = await prisma.webhookSubscription.update({
    where: { id: req.params.id },
    data,
  });

  res.json(updated);
});

// 删除订阅
router.delete('/:id', async (req, res) => {
  const sub = await prisma.webhookSubscription.findFirst({
    where: { id: req.params.id, tenantId: req.tenant!.tenantId },
  });

  if (!sub) {
    res.status(404).json({ error: '订阅不存在' });
    return;
  }

  await prisma.webhookDelivery.deleteMany({ where: { subscriptionId: sub.id } });
  await prisma.webhookSubscription.delete({ where: { id: sub.id } });

  res.json({ message: '已删除' });
});

// 启用/停用
router.post('/:id/toggle', async (req, res) => {
  const sub = await prisma.webhookSubscription.findFirst({
    where: { id: req.params.id, tenantId: req.tenant!.tenantId },
  });

  if (!sub) {
    res.status(404).json({ error: '订阅不存在' });
    return;
  }

  const updated = await prisma.webhookSubscription.update({
    where: { id: sub.id },
    data: { isActive: !sub.isActive },
  });

  res.json(updated);
});

// 发送测试 Ping 事件
router.post('/:id/test', async (req, res) => {
  const sub = await prisma.webhookSubscription.findFirst({
    where: { id: req.params.id, tenantId: req.tenant!.tenantId },
  });

  if (!sub) {
    res.status(404).json({ error: '订阅不存在' });
    return;
  }

  const result = await deliverWebhook(sub, 'ping', {
    message: 'Webhook连接测试成功',
    timestamp: new Date().toISOString(),
  });

  await prisma.auditLog.create({
    data: {
      tenantId: req.tenant!.tenantId,
      action: 'webhook_test',
      detail: `Webhook测试: ${sub.name} → ${sub.url}, 结果: ${result.success ? '成功' : '失败'}`,
    },
  });

  res.json({
    success: result.success,
    statusCode: result.statusCode,
    durationMs: result.durationMs,
    error: result.error,
    attempt: result.attempt,
  });
});

// 投递历史（分页）
router.get('/:id/deliveries', async (req, res) => {
  const { page = '1', pageSize = '20' } = req.query;
  const skip = (Number(page) - 1) * Number(pageSize);
  const take = Math.min(Number(pageSize), 100);

  const sub = await prisma.webhookSubscription.findFirst({
    where: { id: req.params.id, tenantId: req.tenant!.tenantId },
  });

  if (!sub) {
    res.status(404).json({ error: '订阅不存在' });
    return;
  }

  const [deliveries, total] = await Promise.all([
    prisma.webhookDelivery.findMany({
      where: { subscriptionId: sub.id },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    prisma.webhookDelivery.count({ where: { subscriptionId: sub.id } }),
  ]);

  res.json({ data: deliveries, total, page: Number(page), pageSize: take });
});

export default router;
