import prisma from '../config/database';

// 用户行为埋点服务 — 轻量级，不阻塞请求

type EventName =
  | 'page_view'
  | 'feature_use'
  | 'search'
  | 'export'
  | 'upload'
  | 'download'
  | 'api_call';

interface TrackEvent {
  tenantId?: string;
  event: EventName;
  feature?: string;
  detail?: string;
  ip?: string;
}

export function trackEvent(payload: TrackEvent) {
  // 异步记录，不阻塞请求
  prisma.auditLog.create({
    data: {
      tenantId: payload.tenantId,
      action: `analytics:${payload.event}`,
      detail: [payload.feature, payload.detail].filter(Boolean).join(': ') || payload.event,
      ip: payload.ip,
    },
  }).catch(() => {});
}

// 获取功能使用统计
export async function getFeatureUsageStats(days = 30) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [totalEvents, featureBreakdown, dailyActive, topUsers] = await Promise.all([
    prisma.auditLog.count({
      where: {
        action: { startsWith: 'analytics:' },
        createdAt: { gte: since },
      },
    }),
    prisma.auditLog.groupBy({
      by: ['action'],
      where: {
        action: { startsWith: 'analytics:' },
        createdAt: { gte: since },
      },
      _count: true,
      orderBy: { _count: { action: 'desc' } },
    }),
    prisma.auditLog.groupBy({
      by: ['tenantId'],
      where: {
        createdAt: { gte: since },
      },
      _count: true,
    }),
    prisma.auditLog.groupBy({
      by: ['tenantId'],
      where: {
        action: { startsWith: 'analytics:' },
        createdAt: { gte: since },
      },
      _count: true,
      orderBy: { _count: { action: 'desc' } },
      take: 10,
    }),
  ]);

  return {
    totalEvents,
    featureBreakdown: featureBreakdown.map((f: any) => ({
      feature: f.action.replace('analytics:', ''),
      count: f._count,
    })),
    dailyActiveUsers: dailyActive.filter((d: any) => d.tenantId).length,
    topUsers: topUsers.map((u: any) => ({
      tenantId: u.tenantId,
      events: u._count,
    })),
  };
}

// 获取DAU/MAU
export async function getActiveUserStats() {
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);

  const [dau, mau, wau] = await Promise.all([
    prisma.auditLog.groupBy({
      by: ['tenantId'],
      where: {
        tenantId: { not: null },
        createdAt: { gte: new Date(today) },
      },
    }),
    prisma.auditLog.groupBy({
      by: ['tenantId'],
      where: {
        tenantId: { not: null },
        createdAt: { gte: new Date(monthStart) },
      },
    }),
    prisma.auditLog.groupBy({
      by: ['tenantId'],
      where: {
        tenantId: { not: null },
        createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
      },
    }),
  ]);

  return { dau: dau.length, wau: wau.length, mau: mau.length };
}
