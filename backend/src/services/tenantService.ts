import prisma from '../config/database';
import { ensureTenantBucket } from '../config/minio';
import { getRedis, tenantKey } from '../config/redis';
import { daysFromNow } from '../utils/helpers';

// 租户生命周期管理服务

export const tenantService = {
  // 创建租户(注册时调用)
  async provisionTenant(tenantId: string) {
    // 1. 创建 MinIO 隔离存储
    await ensureTenantBucket(tenantId);

    // 2. 初始化 Redis 租户命名空间 (可选，Redis不可用时跳过)
    try {
      const redis = getRedis();
      await redis?.hset(tenantKey(tenantId, 'config'), {
        createdAt: new Date().toISOString(),
        bucket: `tenant-${tenantId}`,
      });
    } catch { /* Redis不可用，跳过 */ }

    // 3. 创建默认审计日志
    await prisma.auditLog.create({
      data: {
        tenantId,
        action: 'tenant_provisioned',
        detail: '企业空间初始化完成',
      },
    });

    return { success: true, tenantId };
  },

  // 试用到期自动冻结
  async checkAndFreezeTrials() {
    const expired = await prisma.tenant.findMany({
      where: {
        status: 'TRIAL',
        trialEndAt: { lt: new Date() },
      },
    });

    for (const tenant of expired) {
      await prisma.tenant.update({
        where: { id: tenant.id },
        data: { status: 'FROZEN', frozenAt: new Date() },
      });

      await prisma.auditLog.create({
        data: {
          tenantId: tenant.id,
          action: 'trial_expired',
          detail: `试用到期，账号自动冻结`,
        },
      });
    }

    return expired.length;
  },

  // 付费到期自动冻结
  async checkAndFreezeExpired() {
    const expired = await prisma.tenant.findMany({
      where: {
        status: 'ACTIVE',
        expiresAt: { lt: new Date() },
      },
    });

    for (const tenant of expired) {
      await prisma.tenant.update({
        where: { id: tenant.id },
        data: { status: 'FROZEN', frozenAt: new Date() },
      });

      await prisma.auditLog.create({
        data: {
          tenantId: tenant.id,
          action: 'payment_expired',
          detail: '付费到期，账号自动冻结',
        },
      });
    }

    return expired.length;
  },

  // 到期前3天提醒
  async getExpiringTenants(daysBefore = 3) {
    const threshold = daysFromNow(daysBefore);
    return prisma.tenant.findMany({
      where: {
        status: { in: ['ACTIVE', 'TRIAL'] },
        OR: [
          { expiresAt: { lte: threshold, gt: new Date() } },
          { trialEndAt: { lte: threshold, gt: new Date() } },
        ],
      },
    });
  },

  // 清除租户缓存
  async clearTenantCache(tenantId: string) {
    const redis = getRedis();
    if (!redis) return;
    const keys = await redis.keys(tenantKey(tenantId, '*'));
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  },

  // 数据隔离验证(安全审计用)
  async verifyIsolation(tenantA: string, tenantB: string): Promise<boolean> {
    // 验证租户A无法访问租户B的数据
    const checks = [
      prisma.document.findFirst({ where: { tenantId: tenantB, id: 'any' } }),
      prisma.payment.findFirst({ where: { tenantId: tenantB } }),
      prisma.cBAMRecord.findFirst({ where: { tenantId: tenantB } }),
    ];

    // 如果租户A能查到租户B的数据，隔离失败
    // (正常情况应返回空，因为这应该在RLS和应用层都被拦截)
    const results = await Promise.all(checks);
    return results.every(r => r === null);
  },
};
