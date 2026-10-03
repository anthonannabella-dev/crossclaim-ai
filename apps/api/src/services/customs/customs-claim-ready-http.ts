/**
 * G11（MASTER GAP CLOSURE）— Customs G4 只读 HTTP 边界。
 * ---------------------------------------------------------------
 *   · GET /customs-entry-facts/:id → tenant-scoped 只读读模型：事实摘要 + 四类 latest 计算投影。
 *   · 只读：不触发 filing、不外写、不扣款；响应显式带 filingSubmitted=false / transportEnabled=false。
 *   · RBAC：OWNER / ADMIN / OPS / FINANCE 可读；VIEWER / 未知角色拒绝（403）。
 *   · 不返回 credential / raw payload；投影 payload 由调用方决定裁剪（本模块只做 envelope 与边界声明）。
 */

import type { CustomsEntryFactStore, CustomsProjectionKind } from './customs-entry-fact-store';

export const CUSTOMS_CLAIM_READ_ROLES = ['OWNER', 'ADMIN', 'OPS', 'FINANCE'] as const;
export type CustomsClaimReadRole = (typeof CUSTOMS_CLAIM_READ_ROLES)[number];

export const CUSTOMS_CLAIM_READ_PROJECTION_KINDS: readonly CustomsProjectionKind[] = [
  'DUTY_TRUTH',
  'DISCREPANCY',
  'ELIGIBILITY',
  'ESTIMATE',
];

export interface CustomsClaimHttpSession {
  organizationId: string;
  actorUserId: string;
  role: string;
}

export interface CustomsClaimHttpDeps {
  store: CustomsEntryFactStore;
}

export interface CustomsClaimHttpResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * GET /customs-entry-facts/:entryFactId —— 只读读模型（事实 + 四类 latest 投影）。
 */
export async function getCustomsEntryFactReadModel(input: {
  session: CustomsClaimHttpSession;
  deps: CustomsClaimHttpDeps;
  entryFactId: string;
}): Promise<CustomsClaimHttpResult> {
  const { session, deps } = input;
  if (!(CUSTOMS_CLAIM_READ_ROLES as readonly string[]).includes(session.role)) {
    return { status: 403, body: { error: 'FORBIDDEN', reason: 'ROLE_NOT_PERMITTED' } };
  }
  if (typeof input.entryFactId !== 'string' || input.entryFactId.trim() === '') {
    return { status: 400, body: { error: 'INVALID_REQUEST', reason: 'ENTRY_FACT_ID_REQUIRED' } };
  }

  const fact = await deps.store.loadFact({ organizationId: session.organizationId, factId: input.entryFactId });
  if (!fact) {
    return { status: 404, body: { error: 'NOT_FOUND' } };
  }

  const projections: Record<string, unknown> = {};
  for (const kind of CUSTOMS_CLAIM_READ_PROJECTION_KINDS) {
    const latest = await deps.store.loadLatestProjection({
      organizationId: session.organizationId,
      inputFactId: fact.id,
      kind,
    });
    projections[kind] = latest
      ? {
          projectionId: latest.id,
          computedAt: latest.computedAt,
          algorithmVersion: latest.algorithmVersion,
          inputDigest: latest.inputDigest,
          resultDigest: latest.resultDigest,
          policyId: latest.policyId,
          policyVersion: latest.policyVersion,
          payload: latest.payload,
        }
      : null;
  }

  return {
    status: 200,
    body: {
      entryFact: {
        id: fact.id,
        entryNumber: fact.entryNumber,
        entryDate: fact.entryDate,
        jurisdiction: fact.jurisdiction,
        source: fact.source,
        contentDigest: fact.contentDigest,
        lineCount: fact.lines.length,
        totalDutyAmountByCurrency: fact.totalDutyAmountByCurrency,
      },
      projections,
      boundary: {
        readOnly: true,
        filingSubmitted: false,
        transportEnabled: false,
        externalWritePerformed: false,
        productionCredentials: 'ABSENT',
      },
    },
  };
}

/** GET /customs-entry-facts/:id/claim-ready-package —— 只返回已持久化的最新投影（不在 HTTP 层重算）。 */
export async function getCustomsClaimReadyView(input: {
  session: CustomsClaimHttpSession;
  deps: CustomsClaimHttpDeps;
  entryFactId: string;
}): Promise<CustomsClaimHttpResult> {
  const base = await getCustomsEntryFactReadModel(input);
  if (base.status !== 200) return base;
  const projections = base.body.projections as Record<string, unknown>;
  const eligibility = projections.ELIGIBILITY as { payload?: unknown } | null;
  const estimate = projections.ESTIMATE as { payload?: unknown } | null;
  return {
    status: 200,
    body: {
      entryFact: base.body.entryFact,
      eligibility: eligibility?.payload ?? null,
      estimate: estimate?.payload ?? null,
      dutyTruth: (projections.DUTY_TRUTH as { payload?: unknown } | null)?.payload ?? null,
      discrepancy: (projections.DISCREPANCY as { payload?: unknown } | null)?.payload ?? null,
      boundary: {
        readOnly: true,
        estimateOnly: true,
        billable: false,
        filingSubmitted: false,
        submissionPerformed: false,
        transportEnabled: false,
        externalWritePerformed: false,
        productionCredentials: 'ABSENT',
      },
    },
  };
}
