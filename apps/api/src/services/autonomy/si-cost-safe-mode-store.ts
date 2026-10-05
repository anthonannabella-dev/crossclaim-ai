/**
 * SI-COST-OPTIMIZATION C3 FINAL-2（CHANGE C）—— **durable** Cost Safe Mode resolver
 * ---------------------------------------------------------------
 * 裁决要求（MSG-20261005-38 CHANGE C）：Safe Mode 必须使用与 C2 budget Guard **相同**的
 * per-policy-scope usage 语义，不能用「最窄 usage」对比「父级最紧 limit」。
 *
 * 语义（逐 policy 校验，任一触顶即 SAFE MODE）：
 *   PLATFORM      → 全平台 usage
 *   ORGANIZATION  → 该 org usage
 *   ACCOUNT       → 该 account usage（带 organizationId 约束）
 *   INCIDENT      → 该 incident usage
 *   TASK          → 该 task usage
 *   每个 policy 的 daily / monthly / token / strong-call 按**自身作用域**聚合；
 *   perIncidentLimitMicros 只统计**当前 incident**；本次调用无 incidentId → NOT_APPLICABLE。
 *
 * 只读：全部数据来自 durable `AiBudgetPolicy` + durable `AiCostLedgerEntry`；不写任何行。
 * tenant 安全：非 PLATFORM policy 必须与 refs.organizationId 同租户，否则不参与（fail-closed）。
 */

import type { PrismaClient } from '@prisma/client';

import { createAiCostSafeModeVerdict, type AiCostSafeModeVerdict } from './si-cost-safe-mode';
import type { AiBudgetScopeName } from './si-budget-policy-store';

export interface AiCostSafeModeRefs {
  organizationId?: string | null;
  accountId?: string | null;
  incidentId?: string | null;
  taskId?: string | null;
}

export interface AiCostSafeModePolicyBreach {
  scope: AiBudgetScopeName;
  scopeRef: string;
  breachedDimensions: readonly string[];
}

export interface AiCostSafeModeResolution {
  verdict: AiCostSafeModeVerdict;
  perIncidentDimension: 'APPLICABLE' | 'NOT_APPLICABLE';
  policiesEvaluated: number;
  breaches: readonly AiCostSafeModePolicyBreach[];
}

export const AI_COST_SAFE_MODE_STORE_BOUNDARY = {
  usageSource: 'DURABLE_LEDGER_ONLY（无第二 usage 事实源）',
  accounting: 'PER_POLICY_SCOPE（与 C2 budget Guard 相同；不用最窄 usage）',
  perIncident: 'CURRENT_INCIDENT_ONLY；无 incidentId → NOT_APPLICABLE',
  tenantBinding: 'REQUIRED（非 PLATFORM policy 必须与 refs.organizationId 同租户）',
  readOnly: true,
  level0RuleAffected: false,
} as const;

const startOfUtcDay = (now: Date): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
const startOfUtcMonth = (now: Date): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

/**
 * 逐 policy 计算 Safe Mode（只读）。
 * 任一 policy 的任一维度触顶 → COST_SAFE（fail-safe）；未知 / 非法 refs → fail-closed（抛错）。
 */
export async function resolveAiCostSafeMode(
  prisma: PrismaClient,
  input: { refs: AiCostSafeModeRefs; now?: Date },
): Promise<AiCostSafeModeResolution> {
  const refs = input.refs;
  if ((refs.accountId || refs.incidentId || refs.taskId) && !refs.organizationId) {
    throw new Error('AI_BUDGET_TENANT_IDENTITY_REQUIRED');
  }
  const now = input.now ?? new Date();
  const dayStart = startOfUtcDay(now);
  const monthStart = startOfUtcMonth(now);

  const policies = await prisma.aiBudgetPolicy.findMany({
    where: {
      OR: [
        { scope: 'PLATFORM', scopeRef: '*', organizationId: '' },
        ...(refs.organizationId
          ? [
              { scope: 'ORGANIZATION', scopeRef: refs.organizationId, organizationId: refs.organizationId },
              ...(refs.accountId
                ? [{ scope: 'ACCOUNT', scopeRef: refs.accountId, organizationId: refs.organizationId }]
                : []),
              ...(refs.incidentId
                ? [{ scope: 'INCIDENT', scopeRef: refs.incidentId, organizationId: refs.organizationId }]
                : []),
              ...(refs.taskId
                ? [{ scope: 'TASK', scopeRef: refs.taskId, organizationId: refs.organizationId }]
                : []),
            ]
          : []),
      ] as never,
    },
  });

  // perIncident 维度只统计当前 incident（带 tenant 约束）；无 incidentId → NOT_APPLICABLE
  const perIncidentDimension: 'APPLICABLE' | 'NOT_APPLICABLE' = refs.incidentId ? 'APPLICABLE' : 'NOT_APPLICABLE';
  let incidentUsageMicros = 0;
  if (refs.incidentId) {
    const incidentAgg = await prisma.aiCostLedgerEntry.aggregate({
      where: {
        incidentId: refs.incidentId,
        ...(refs.organizationId ? { organizationId: refs.organizationId } : {}),
      },
      _sum: { costMicros: true },
    });
    incidentUsageMicros = incidentAgg._sum.costMicros ?? 0;
  }

  const breachedDimensions: string[] = [];
  const breaches: AiCostSafeModePolicyBreach[] = [];

  for (const policy of policies) {
    // 非 PLATFORM policy 必须与同一 tenant 绑定，否则不参与（与 guarded write 一致）
    if (policy.scope !== 'PLATFORM' && (!policy.organizationId || policy.organizationId !== refs.organizationId)) {
      continue;
    }
    const scopeWhere =
      policy.scope === 'ORGANIZATION'
        ? { organizationId: policy.scopeRef }
        : policy.scope === 'ACCOUNT'
          ? { accountId: policy.scopeRef, organizationId: policy.organizationId }
          : policy.scope === 'INCIDENT'
            ? { incidentId: policy.scopeRef, organizationId: policy.organizationId }
            : policy.scope === 'TASK'
              ? { taskId: policy.scopeRef, organizationId: policy.organizationId }
              : {};
    const day = await prisma.aiCostLedgerEntry.aggregate({
      where: { ...scopeWhere, createdAt: { gte: dayStart } },
      _sum: { costMicros: true, inputTokens: true, outputTokens: true },
    });
    const month = await prisma.aiCostLedgerEntry.aggregate({
      where: { ...scopeWhere, createdAt: { gte: monthStart } },
      _sum: { costMicros: true },
    });
    const policyBreaches: string[] = [];
    const dayMicros = day._sum.costMicros ?? 0;
    const monthMicros = month._sum.costMicros ?? 0;
    const tokens = (day._sum.inputTokens ?? 0) + (day._sum.outputTokens ?? 0);
    if (policy.dailyLimitMicros !== null && dayMicros >= policy.dailyLimitMicros) policyBreaches.push('DAILY');
    if (policy.monthlyLimitMicros !== null && monthMicros >= policy.monthlyLimitMicros) policyBreaches.push('MONTHLY');
    if (policy.tokenLimit !== null && tokens >= policy.tokenLimit) policyBreaches.push('TOKEN');
    if (policy.strongCallLimit !== null) {
      const strongCalls = await prisma.aiCostLedgerEntry.count({
        where: { ...scopeWhere, executionLevel: 'LEVEL_2_STRONG', createdAt: { gte: dayStart } },
      });
      if (strongCalls >= policy.strongCallLimit) policyBreaches.push('STRONG_CALL');
    }
    if (policy.perIncidentLimitMicros !== null && refs.incidentId) {
      if (incidentUsageMicros >= policy.perIncidentLimitMicros) policyBreaches.push('INCIDENT');
    }
    if (policyBreaches.length > 0) {
      breachedDimensions.push(...policyBreaches);
      breaches.push({ scope: policy.scope as AiBudgetScopeName, scopeRef: policy.scopeRef, breachedDimensions: policyBreaches });
    }
  }

  return {
    verdict: createAiCostSafeModeVerdict(breachedDimensions),
    perIncidentDimension,
    policiesEvaluated: policies.length,
    breaches,
  };
}
