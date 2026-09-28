import prisma from '../config/database';
import { getQuota, DAILY_RESOURCES, MONTHLY_RESOURCES, RESOURCE_LABELS } from '../config/planQuotas';

function dailyKey(): string {
  return new Date().toISOString().slice(0, 10); // "2026-06-03"
}

function monthlyKey(): string {
  return new Date().toISOString().slice(0, 7); // "2026-06"
}

function periodFor(resource: string): 'daily' | 'monthly' {
  if (DAILY_RESOURCES.includes(resource)) return 'daily';
  return 'monthly';
}

function periodKeyFor(resource: string): string {
  return periodFor(resource) === 'daily' ? dailyKey() : monthlyKey();
}

function limitFor(planTier: string, resource: string): number {
  const quota = getQuota(planTier);
  const map: Record<string, number> = {
    ai_classify: quota.aiClassifyDaily,
    document_upload: quota.documentsMonthly,
    declaration_build: quota.declarationsMonthly,
    ocr: quota.ocrMonthly,
    cbam: quota.cbamMonthly,
    rcep: quota.rcepMonthly,
    tax_rebate: quota.taxRebateMonthly,
    api_call: quota.apiCallsDaily,
  };
  return map[resource] ?? 0;
}

function resetTime(resource: string): string {
  if (DAILY_RESOURCES.includes(resource)) {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  }
  const d = new Date();
  d.setMonth(d.getMonth() + 1);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

/** Atomically increment usage counter, return new count. */
export async function incrementUsage(tenantId: string, resource: string): Promise<number> {
  const period = periodFor(resource);
  const periodKey = periodKeyFor(resource);

  try {
    const result: any[] = await prisma.$queryRawUnsafe(
      `INSERT INTO "TenantUsage" ("id", "tenantId", "resource", "period", "periodKey", "count")
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 1)
       ON CONFLICT ("tenantId", "resource", "period", "periodKey")
       DO UPDATE SET "count" = "TenantUsage"."count" + 1
       RETURNING "count"`,
      tenantId, resource, period, periodKey,
    );
    return result[0]?.count ?? 1;
  } catch {
    // 幂等: 直接用 upsert (raw SQL 失败时 fallback)
    const record = await prisma.tenantUsage.upsert({
      where: { tenantId_resource_period_periodKey: { tenantId, resource, period, periodKey } },
      create: { tenantId, resource, period, periodKey, count: 1 },
      update: { count: { increment: 1 } },
    });
    return record.count;
  }
}

/** Check if tenant has remaining quota. Returns quota check result. */
export async function checkQuota(
  tenantId: string,
  planTier: string,
  resource: string,
): Promise<{ allowed: boolean; current: number; limit: number; remaining: number; resetAt: string }> {
  const limit = limitFor(planTier, resource);
  if (limit === 0) {
    return { allowed: false, current: 0, limit: 0, remaining: 0, resetAt: resetTime(resource) };
  }

  const period = periodFor(resource);
  const periodKey = periodKeyFor(resource);

  const record = await prisma.tenantUsage.findUnique({
    where: { tenantId_resource_period_periodKey: { tenantId, resource, period, periodKey } },
  });

  const current = record?.count ?? 0;
  const remaining = Math.max(0, limit - current);

  return {
    allowed: current < limit,
    current,
    limit,
    remaining,
    resetAt: resetTime(resource),
  };
}

/** Get full usage snapshot for a tenant. */
export async function getUsage(tenantId: string, planTier: string) {
  const quota = getQuota(planTier);
  const allResources = [...DAILY_RESOURCES, ...MONTHLY_RESOURCES];

  const periodKeys = allResources.map(r => ({
    resource: r,
    period: periodFor(r),
    periodKey: periodKeyFor(r),
  }));

  const records = await prisma.tenantUsage.findMany({
    where: {
      tenantId,
      OR: periodKeys.map(p => ({
        resource: p.resource,
        period: p.period,
        periodKey: p.periodKey,
      })),
    },
  });

  const recordMap = new Map<string, number>(records.map((r: any) => [`${r.resource}:${r.period}`, r.count] as [string, number]));

  const usage: Record<string, { current: number; limit: number; remaining: number; label: string; period: string }> = {};

  const limitMap: Record<string, number> = {
    ai_classify: quota.aiClassifyDaily,
    document_upload: quota.documentsMonthly,
    declaration_build: quota.declarationsMonthly,
    ocr: quota.ocrMonthly,
    cbam: quota.cbamMonthly,
    rcep: quota.rcepMonthly,
    tax_rebate: quota.taxRebateMonthly,
    api_call: quota.apiCallsDaily,
  };

  for (const resource of allResources) {
    const period = periodFor(resource);
    const current = recordMap.get(`${resource}:${period}`) ?? 0;
    const limit = limitMap[resource] ?? 0;
    usage[resource] = {
      current,
      limit,
      remaining: Math.max(0, limit - current),
      label: RESOURCE_LABELS[resource] || resource,
      period,
    };
  }

  // Storage usage (approximate: count documents * 1MB average)
  const docCount = await prisma.document.count({ where: { tenantId } });
  const storageUsedMB = Math.round(docCount * 1.5); // rough estimate

  return {
    plan: planTier,
    quotas: {
      aiClassifyDaily: quota.aiClassifyDaily,
      documentsMonthly: quota.documentsMonthly,
      declarationsMonthly: quota.declarationsMonthly,
      ocrMonthly: quota.ocrMonthly,
      cbamMonthly: quota.cbamMonthly,
      rcepMonthly: quota.rcepMonthly,
      taxRebateMonthly: quota.taxRebateMonthly,
      apiCallsDaily: quota.apiCallsDaily,
      storageMB: quota.storageMB,
      subAccounts: quota.subAccounts,
    },
    usage,
    storage: {
      usedMB: storageUsedMB,
      limitMB: quota.storageMB,
      remainingMB: Math.max(0, quota.storageMB - storageUsedMB),
    },
  };
}

/** Get daily usage history for a resource over N days. */
export async function getUsageHistory(tenantId: string, resource: string, days: number = 30) {
  const period = periodFor(resource);
  const records = await prisma.tenantUsage.findMany({
    where: {
      tenantId,
      resource,
      period,
    },
    orderBy: { periodKey: 'desc' },
    take: days,
  });

  return records.map((r: any) => ({
    date: r.periodKey,
    count: r.count,
  })).reverse();
}

/** Reset daily counters (called by cron at midnight). */
export async function resetDailyCounters(): Promise<void> {
  // Daily counters auto-reset by periodKey changing — nothing to delete
  // But we clean up old daily records (>30 days)
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  await prisma.tenantUsage.deleteMany({
    where: {
      period: 'daily',
      periodKey: { lt: cutoff.toISOString().slice(0, 10) },
    },
  });
}

/** Reset monthly counters (called by cron on 1st of month). */
export async function resetMonthlyCounters(): Promise<void> {
  // Monthly counters auto-reset by periodKey changing
  // Clean up old monthly records (>12 months)
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 1);
  await prisma.tenantUsage.deleteMany({
    where: {
      period: 'monthly',
      periodKey: { lt: cutoff.toISOString().slice(0, 7) },
    },
  });
}
