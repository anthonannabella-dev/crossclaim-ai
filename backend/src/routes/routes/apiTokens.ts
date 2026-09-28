import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';
import prisma from '../../config/database';
import { authenticate } from '../../middleware/auth';
import { generateAppKey } from '../../utils/helpers';

const router = Router();
router.use(authenticate);

// 获取当前租户的API Tokens
router.get('/', async (req, res) => {
  const tenantId = req.tenant!.tenantId || (req as any).user?.id || (req as any).tenant?.id;

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { planTier: true },
  });

  if (tenant?.planTier !== 'ENTERPRISE') {
    res.status(403).json({ error: '仅企业版支持API访问' });
    return;
  }

  const tokens = await prisma.apiToken.findMany({
    where: { tenantId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      appKey: true,
      name: true,
      isActive: true,
      rateLimit: true,
      totalCalls: true,
      monthlyCalls: true,
      lastUsedAt: true,
      createdAt: true,
    },
  });

  res.json(tokens);
});

// 创建新的API Token
router.post('/', async (req, res) => {
  const tenantId = req.tenant!.tenantId || (req as any).user?.id || (req as any).tenant?.id;
  const { name } = req.body;

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { planTier: true },
  });

  if (tenant?.planTier !== 'ENTERPRISE') {
    res.status(403).json({ error: '仅企业版支持API访问' });
    return;
  }

  const tokenCount = await prisma.apiToken.count({ where: { tenantId, isActive: true } });
  if (tokenCount >= 5) {
    res.status(400).json({ error: '最多创建5个有效API Token' });
    return;
  }

  const appKey = generateAppKey();
  const rawToken = `ct_${uuid().replace(/-/g, '')}`;
  const tokenHash = await bcrypt.hash(rawToken, 12);

  const apiToken = await prisma.apiToken.create({
    data: {
      tenantId,
      appKey,
      tokenHash,
      name: name || `Token-${tokenCount + 1}`,
      rateLimit: 100,
    },
  });

  await prisma.auditLog.create({
    data: {
      tenantId,
      action: 'api_token_created',
      detail: `创建API Token: ${appKey}`,
    },
  });

  res.status(201).json({
    id: apiToken.id,
    appKey: apiToken.appKey,
    name: apiToken.name,
    token: rawToken, // 只在创建时返回一次
    rateLimit: apiToken.rateLimit,
    createdAt: apiToken.createdAt,
  });
});

// 重新生成Token
router.post('/:id/regenerate', async (req, res) => {
  const tenantId = req.tenant!.tenantId || (req as any).user?.id || (req as any).tenant?.id;
  const { id } = req.params;

  const existing = await prisma.apiToken.findFirst({
    where: { id, tenantId },
  });

  if (!existing) {
    res.status(404).json({ error: 'Token不存在' });
    return;
  }

  const rawToken = `ct_${uuid().replace(/-/g, '')}`;
  const tokenHash = await bcrypt.hash(rawToken, 12);

  await prisma.apiToken.update({
    where: { id },
    data: { tokenHash },
  });

  await prisma.auditLog.create({
    data: {
      tenantId,
      action: 'api_token_regenerated',
      detail: `重新生成API Token: ${existing.appKey}`,
    },
  });

  res.json({ token: rawToken });
});

// 启用/禁用Token
router.post('/:id/toggle', async (req, res) => {
  const tenantId = req.tenant!.tenantId || (req as any).user?.id || (req as any).tenant?.id;
  const { id } = req.params;

  const existing = await prisma.apiToken.findFirst({
    where: { id, tenantId },
  });

  if (!existing) {
    res.status(404).json({ error: 'Token不存在' });
    return;
  }

  const updated = await prisma.apiToken.update({
    where: { id },
    data: { isActive: !existing.isActive },
  });

  await prisma.auditLog.create({
    data: {
      tenantId,
      action: 'api_token_toggled',
      detail: `${updated.isActive ? '启用' : '禁用'}API Token: ${existing.appKey}`,
    },
  });

  res.json({ isActive: updated.isActive });
});

export default router;
