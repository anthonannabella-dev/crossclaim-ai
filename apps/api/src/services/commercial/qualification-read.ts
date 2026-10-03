/**
 * CHANGE A（MSG-20261003-141）— **Platform Qualification Read Projection**（只读）。
 * ---------------------------------------------------------------
 * 复用既有持久化判定 `RecoveryQualificationAssessmentRecord`（P0-2 Qualification Gate），
 * 让 Platform 域的关键链在 UI 上真实可见：Opportunity → **Qualification** → Claim-ready → Submission → Recovered/Fee/Billing。
 *
 * 硬约束：
 *   · 只读：不重算、不写库、不触发任何外部调用（`recomputedOnRead=false`）。
 *   · `INDETERMINATE` / `NOT_QUALIFIED` / `CONDITIONAL` 原样展示，不做任何"美化"。
 *   · 判定 ≠ filing 授权：`filingAuthorized=false` 恒成立。
 *   · 跨租户与未知账户一律 404（不泄漏存在性）。
 */

export const QUALIFICATION_READ_ROLES = ['OWNER', 'ADMIN', 'OPS', 'FINANCE'] as const;

export interface QualificationReadSession {
  organizationId: string;
  actorUserId: string;
  role: string;
}

export interface QualificationReadDeps {
  loadLatest(input: { organizationId: string; platformAccountId: string }): Promise<Record<string, unknown> | null>;
}

export interface QualificationReadResult {
  status: number;
  body: Record<string, unknown>;
}

function asString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null && 'toString' in value) return String(value);
  return String(value);
}

function asReasonCodes(payload: unknown): string[] {
  if (payload === null || typeof payload !== 'object') return [];
  const codes = (payload as { reasonCodes?: unknown }).reasonCodes;
  if (!Array.isArray(codes)) return [];
  return codes.filter((item): item is string => typeof item === 'string');
}

/**
 * GET /platform-accounts/:platformAccountId/qualification —— 只读判定投影。
 */
export async function getQualificationReadProjection(input: {
  session: QualificationReadSession;
  deps: QualificationReadDeps;
  platformAccountId: string;
}): Promise<QualificationReadResult> {
  const { session, deps } = input;
  if (!(QUALIFICATION_READ_ROLES as readonly string[]).includes(session.role)) {
    return { status: 403, body: { error: 'FORBIDDEN', reason: 'ROLE_NOT_PERMITTED' } };
  }
  const platformAccountId = String(input.platformAccountId ?? '').trim();
  if (platformAccountId === '') {
    return { status: 400, body: { error: 'INVALID_REQUEST', reason: 'PLATFORM_ACCOUNT_ID_REQUIRED' } };
  }

  const record = await deps.loadLatest({ organizationId: session.organizationId, platformAccountId });
  if (!record) {
    return { status: 404, body: { error: 'NOT_FOUND' } };
  }

  return {
    status: 200,
    body: {
      qualification: {
        platformAccountId,
        status: asString(record.qualificationStatus),
        reasonCodes: asReasonCodes(record.payload),
        policyId: asString(record.policyId),
        policyVersion: asString(record.policyVersion),
        algorithmVersion: asString(record.algorithmVersion),
        currency: asString(record.currency),
        estimatedRecoveryAmount: asString(record.estimatedRecoveryAmount),
        estimatedExternalApiCost: asString(record.estimatedExternalApiCost),
        estimatedBrokerCost: asString(record.estimatedBrokerCost),
        expectedNetRecovery: asString(record.expectedNetRecovery),
        costRatio: asString(record.costRatio),
        inputDigest: asString(record.inputDigest),
        resultDigest: asString(record.resultDigest),
        computedAt: record.computedAt instanceof Date ? record.computedAt.toISOString() : asString(record.computedAt),
      },
      boundary: {
        readOnly: true,
        recomputedOnRead: false,
        filingAuthorized: false,
        transportEnabled: false,
        externalWritePerformed: false,
        productionCredentials: 'ABSENT',
      },
    },
  };
}

export const QUALIFICATION_READ_BOUNDARY = {
  readOnly: true,
  recomputedOnRead: false,
  qualificationIsNotFilingAuthorization: true,
  indeterminateShownAsIs: true,
  productionCredentials: 'ABSENT',
} as const;
