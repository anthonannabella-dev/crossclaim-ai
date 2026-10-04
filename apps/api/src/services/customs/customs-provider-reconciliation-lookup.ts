/**
 * C18-8 — PROVIDER-NEUTRAL READ-ONLY RECONCILIATION LOOKUP（Layer 3 / P0，离线层）
 * ---------------------------------------------------------------
 * MSG-20261004-19 ③ 的唯一必修：AMBIGUOUS 场景下不得用第二次 `createSubmission()`
 * 去"查询"provider 是否已经收到请求——`createSubmission()` 是**写操作**，拿它当查询会
 * 掩盖真实语义（未知 provider 下可能就是第二次 POST）。
 *
 * 因此单独定义**只读**端口（不污染 C15 主接口）：
 *
 *   lookupSubmissionByIdempotencyKey(organizationId, idempotencyKey)
 *     → NOT_FOUND
 *     | FOUND { providerSubmissionId, payloadDigest, status }
 *
 * 对账判定只做内部 digest 比较：一致 → 采用既有提交；不一致 → 冲突（人工复核）；
 * 查不到 → 仍需人工复核（绝不自动重发）。
 */

const DIGEST_RE = /^[0-9a-f]{64}$/;
const OPAQUE_REF_RE = /^[A-Za-z0-9._:@#/-]{1,96}$/;
const RAW_URL_SCHEME_RE = /^(https?:\/\/|javascript:|data:|file:)/i;

export type ProviderReconciliationLookupOutcome =
  | { outcome: 'NOT_FOUND' }
  | {
      outcome: 'FOUND';
      providerSubmissionId: string;
      /** provider 侧记录的不变量摘要（用于与本地 expected digest 比较）。 */
      payloadDigest: string;
      status: string;
    };

/** 只读端口：实现方必须是**查询**语义，绝不产生或修改 provider 侧状态。 */
export interface CustomsProviderReconciliationLookup {
  lookupSubmissionByIdempotencyKey(input: {
    organizationId: string;
    idempotencyKey: string;
  }): Promise<ProviderReconciliationLookupOutcome>;
}

export type ProviderReconciliationVerdict =
  | 'ADOPT_EXISTING'
  | 'CONFLICT_MISMATCH'
  | 'NOT_FOUND_MANUAL_REVIEW'
  | 'INVALID_LOOKUP_RESULT';

export interface ProviderReconciliationLookupDecision {
  verdict: ProviderReconciliationVerdict;
  providerSubmissionId: string | null;
  providerPayloadDigest: string | null;
  reasonCode:
    | 'RECONCILIATION_DIGEST_MATCH'
    | 'RECONCILIATION_DIGEST_MISMATCH'
    | 'RECONCILIATION_NOT_FOUND'
    | 'RECONCILIATION_INVALID_RESULT';
  /** 任何 verdict 都不得触发重发。 */
  resubmitAllowed: false;
  externalWritePerformed: false;
  transportEnabled: false;
  productionCredentials: 'ABSENT';
}

const isOpaque = (value: unknown): boolean =>
  typeof value === 'string' && value.trim() !== '' && !RAW_URL_SCHEME_RE.test(value) && OPAQUE_REF_RE.test(value);

/**
 * 纯函数判定：把只读查询结果与本地 expected digest 做内部比较。
 * - FOUND + digest 一致 → ADOPT_EXISTING（采用既有 providerSubmissionId，不重发）
 * - FOUND + digest 不一致 → CONFLICT_MISMATCH（人工复核，不重发）
 * - NOT_FOUND → NOT_FOUND_MANUAL_REVIEW（无法证明已提交，也不得自动重发）
 * - 形状非法（缺 id / digest 非法）→ INVALID_LOOKUP_RESULT（fail-closed）
 */
export function decideProviderReconciliation(input: {
  lookup: ProviderReconciliationLookupOutcome;
  expectedPayloadDigest: string;
}): ProviderReconciliationLookupDecision {
  const deny = (
    verdict: ProviderReconciliationVerdict,
    reasonCode: ProviderReconciliationLookupDecision['reasonCode'],
  ): ProviderReconciliationLookupDecision => ({
    verdict,
    providerSubmissionId: null,
    providerPayloadDigest: null,
    reasonCode,
    resubmitAllowed: false,
    externalWritePerformed: false,
    transportEnabled: false,
    productionCredentials: 'ABSENT',
  });

  if (!DIGEST_RE.test(input.expectedPayloadDigest)) return deny('INVALID_LOOKUP_RESULT', 'RECONCILIATION_INVALID_RESULT');
  if (input.lookup === null || input.lookup === undefined) {
    return deny('INVALID_LOOKUP_RESULT', 'RECONCILIATION_INVALID_RESULT');
  }
  if (input.lookup.outcome === 'NOT_FOUND') {
    return deny('NOT_FOUND_MANUAL_REVIEW', 'RECONCILIATION_NOT_FOUND');
  }
  if (
    input.lookup.outcome !== 'FOUND' ||
    !isOpaque(input.lookup.providerSubmissionId) ||
    !DIGEST_RE.test(input.lookup.payloadDigest)
  ) {
    return deny('INVALID_LOOKUP_RESULT', 'RECONCILIATION_INVALID_RESULT');
  }

  const matches = input.lookup.payloadDigest === input.expectedPayloadDigest;
  return {
    verdict: matches ? 'ADOPT_EXISTING' : 'CONFLICT_MISMATCH',
    providerSubmissionId: matches ? input.lookup.providerSubmissionId : null,
    providerPayloadDigest: input.lookup.payloadDigest,
    reasonCode: matches ? 'RECONCILIATION_DIGEST_MATCH' : 'RECONCILIATION_DIGEST_MISMATCH',
    resubmitAllowed: false,
    externalWritePerformed: false,
    transportEnabled: false,
    productionCredentials: 'ABSENT',
  };
}

/** 边界自证：对账查询是只读路径。 */
export const CUSTOMS_PROVIDER_RECONCILIATION_LOOKUP_BOUNDARY = {
  readOnly: true,
  externalWritePerformed: false,
  providerStateMutationPerformed: false,
  filingSubmitted: false,
  transportEnabled: false,
  credentialReadPerformed: false,
  productionCredentials: 'ABSENT',
} as const;
