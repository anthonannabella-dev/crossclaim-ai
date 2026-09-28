import { Request, Response, NextFunction } from 'express';
import prisma from '../config/database';
import { getRedis, tenantKey } from '../config/redis';
import { ensureTenantBucket } from '../config/minio';

export function tenantContext(req: Request, res: Response, next: NextFunction): void {
  const tenantId = req.tenant?.tenantId;
  if (!tenantId) {
    res.status(401).json({ error: '未认证' });
    return;
  }

  (async () => {
    // 1. 尝试从缓存或DB加载租户信息
    const cacheKey = tenantKey(tenantId, 'profile');
    let tenant = (req as any).tenantRecord;

    if (!tenant) {
      try {
        const redis = getRedis();
        const cached = await redis?.get(cacheKey);
        if (cached) {
          tenant = JSON.parse(cached);
        }
      } catch { /* Redis不可用 */ }

      if (!tenant) {
        tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
        if (tenant) {
          try {
            const redis = getRedis();
            await redis?.set(cacheKey, JSON.stringify(tenant), 'EX', 300);
          } catch { /* Redis不可用 */ }
        }
      }
    }

    if (!tenant) {
      res.status(404).json({ error: '企业不存在' });
      return;
    }

    // 2. 检查试用过期
    if (tenant.status === 'TRIAL' && new Date() > new Date(tenant.trialEndAt)) {
      await prisma.tenant.update({
        where: { id: tenantId },
        data: { status: 'FROZEN', frozenAt: new Date() },
      });
      try {
        const redis = getRedis();
        await redis?.del(cacheKey);
      } catch { /* Redis不可用 */ }
      res.status(403).json({ error: '试用已过期，请付费激活账号' });
      return;
    }

    // 3. 检查付费到期
    if (tenant.status === 'ACTIVE' && tenant.expiresAt && new Date() > new Date(tenant.expiresAt)) {
      await prisma.tenant.update({
        where: { id: tenantId },
        data: { status: 'FROZEN', frozenAt: new Date() },
      });
      try {
        const redis = getRedis();
        await redis?.del(cacheKey);
      } catch { /* Redis不可用 */ }
      res.status(403).json({ error: '付费已到期，请续费' });
      return;
    }

    // 4. 检查冻结/禁用
    if (tenant.status === 'FROZEN') {
      res.status(403).json({ error: '账号已冻结' });
      return;
    }
    if (tenant.status === 'DISABLED') {
      res.status(403).json({ error: '账号已被禁用' });
      return;
    }

    // 5. 确保 MinIO bucket
    await ensureTenantBucket(tenantId);

    (req as any).tenantRecord = tenant;
    next();
  })().catch(next);
}

export function adminContext(req: Request, _res: Response, next: NextFunction): void {
  next();
}
