/**
 * C17 — CUSTOMS SUBMISSION LEDGER（MSG-20261003-124 ③④⑤⑥⑦⑧⑨）
 * ---------------------------------------------------------------
 * 两层结构：
 *   · CustomsSubmissionAttempt     —— 执行身份 / 幂等根（immutable；并发只允许一根）
 *   · CustomsSubmissionAttemptFact —— append-only 状态事实（状态演进只追加，不覆盖）
 * 永久规则（⑨）：request timeout != filing definitely failed →
 *   UNKNOWN_PROVIDER_RESPONSE → 只做对账，**不得**重新 POST filing。
 * 本模块不做任何外写；真实 filing 仍 HOLD_EXTERNAL / HOST APPROVAL REQUIRED。
 */

import { createHash } from 'node:crypto';

export const CUSTOMS_SUBMISSION_STATUSES = [
  'ATTEMPTED',
  'UNKNOWN_PROVIDER_RESPONSE',
  'RECONCILING',
  'SUBMITTED',
  'FAILED_CONFIRMED',
  'MANUAL_REVIEW',
] as const;
export type CustomsSubmissionAttemptStatus = (typeof CUSTOMS_SUBMISSION_STATUSES)[number];

export const CUSTOMS_SUBMISSION_SOURCES = ['PROVIDER_API', 'PROVIDER_WEBHOOK', 'PROVIDER_DOCUMENT', 'PROVIDER_PORTAL_ARTIFACT', 'MANUAL'] as const;
export type CustomsSubmissionSource = (typeof CUSTOMS_SUBMISSION_SOURCES)[number];

export const CUSTOMS_SUBMISSION_VERIFICATION_LEVELS = ['UNVERIFIED', 'PROVIDER_VERIFIED'] as const;
export type CustomsSubmissionVerificationLevel = (typeof CUSTOMS_SUBMISSION_VERIFICATION_LEVELS)[number];

export interface CustomsSubmissionAttempt {
  id: string;
  organizationId: string;
  opportunityId: string;
  caseId: string | null;
  claimItemId: string | null;
  packageId: string;
  packageDigest: string;
  provider: string;
  operation: string;
  jurisdiction: string;
  remedyType: string;
  idempotencyKey: string;
  createdAt: string;
}

export interface CustomsSubmissionAttemptFact {
  id: string;
  organizationId: string;
  attemptId: string;
  status: CustomsSubmissionAttemptStatus;
  providerSubmissionId: string | null;
  source: CustomsSubmissionSource;
  verificationLevel: CustomsSubmissionVerificationLevel;
  observedAt: string;
  recordedAt: string;
  providerReference: string | null;
  errorCode: string | null;
  reconciliationAttempt: number | null;
  createdAt: string;
}

export interface CustomsSubmissionLedgerStore {
  createRoot(root: CustomsSubmissionAttempt): Promise<{ created: boolean; root: CustomsSubmissionAttempt }>;
  findRoot(
    organizationId: string,
    provider: string,
    operation: string,
    idempotencyKey: string,
  ): Promise<CustomsSubmissionAttempt | null>;
  findRootById(organizationId: string, attemptId: string): Promise<CustomsSubmissionAttempt | null>;
  appendFact(fact: CustomsSubmissionAttemptFact): Promise<{ created: boolean; fact: CustomsSubmissionAttemptFact }>;
  /**
   * CHANGE A/C（MSG-20261003-125 CHANGE A/C）：在同一事务内锁定 root 行后重读事实、
   * 校验 providerSubmissionId 冲突与「同 id 事实完整等价」，再决定 append。
   * 冲突一律 fail-closed（不写新事实）。
   */
  appendFactGuarded(
    fact: CustomsSubmissionAttemptFact,
    constraints: { forbidProviderSubmissionIdConflict: boolean },
  ): Promise<{ created: boolean; fact: CustomsSubmissionAttemptFact | null; conflict: CustomsSubmissionGuardConflict | null }>;
  listFacts(organizationId: string, attemptId: string): Promise<CustomsSubmissionAttemptFact[]>;
}

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export type CustomsSubmissionGuardConflict = 'PROVIDER_SUBMISSION_ID_CONFLICT' | 'FACT_IMMUTABLE_MISMATCH';

function hash32(parts: readonly (string | number | null)[]): string {
  return createHash('sha256').update(parts.map((p) => (p === null ? '' : String(p))).join('|')).digest('hex').slice(0, 32);
}

/** 执行身份 id 由 immutable 输入派生（同 key 必然同 id，配合 DB UNIQUE 收敛并发）。 */
export function customsSubmissionAttemptId(input: {
  organizationId: string;
  provider: string;
  operation: string;
  idempotencyKey: string;
}): string {
  return 'csa_' + hash32([input.organizationId, input.provider, input.operation, input.idempotencyKey]);
}

export function customsSubmissionFactId(input: {
  organizationId: string;
  attemptId: string;
  status: string;
  providerSubmissionId: string | null;
  observedAt: string;
  reconciliationAttempt: number | null;
}): string {
  return (
    'csaf_' +
    hash32([
      input.organizationId,
      input.attemptId,
      input.status,
      input.providerSubmissionId,
      input.observedAt,
      input.reconciliationAttempt,
    ])
  );
}

export type OpenAttemptReason =
  | 'INVALID_REQUEST'
  | 'INVALID_DIGEST'
  | 'IDEMPOTENCY_KEY_CONFLICT';

export type OpenAttemptOutcome =
  | { ok: true; status: 'ROOT_CREATED' | 'ROOT_EXISTING'; root: CustomsSubmissionAttempt }
  | { ok: false; reason: OpenAttemptReason };

export async function openCustomsSubmissionAttempt(
  input: {
    organizationId: string;
    opportunityId: string;
    caseId?: string | null;
    claimItemId?: string | null;
    packageId: string;
    packageDigest: string;
    provider: string;
    operation: string;
    jurisdiction: string;
    remedyType: string;
    idempotencyKey: string;
  },
  deps: { store: CustomsSubmissionLedgerStore; now?: () => Date },
): Promise<OpenAttemptOutcome> {
  const required = [
    input.organizationId,
    input.opportunityId,
    input.packageId,
    input.provider,
    input.operation,
    input.jurisdiction,
    input.remedyType,
    input.idempotencyKey,
  ];
  if (required.some((v) => typeof v !== 'string' || v.trim().length === 0)) {
    return { ok: false, reason: 'INVALID_REQUEST' };
  }
  if (!DIGEST_PATTERN.test(input.packageDigest)) return { ok: false, reason: 'INVALID_DIGEST' };

  const now = deps.now ? deps.now() : new Date();
  const root: CustomsSubmissionAttempt = {
    id: customsSubmissionAttemptId(input),
    organizationId: input.organizationId,
    opportunityId: input.opportunityId,
    caseId: input.caseId ?? null,
    claimItemId: input.claimItemId ?? null,
    packageId: input.packageId,
    packageDigest: input.packageDigest,
    provider: input.provider,
    operation: input.operation,
    jurisdiction: input.jurisdiction,
    remedyType: input.remedyType,
    idempotencyKey: input.idempotencyKey,
    createdAt: now.toISOString(),
  };
  const created = await deps.store.createRoot(root);
  if (!created.created) {
    // CHANGE B（MSG-20261003-125 CHANGE B）：同 idempotencyKey 但 immutable payload 不一致 → fail-closed，
    // 不得静默当作正常 retry 复用旧 root。
    const same =
      created.root.opportunityId === root.opportunityId &&
      created.root.caseId === root.caseId &&
      created.root.claimItemId === root.claimItemId &&
      created.root.packageId === root.packageId &&
      created.root.packageDigest === root.packageDigest &&
      created.root.provider === root.provider &&
      created.root.operation === root.operation &&
      created.root.jurisdiction === root.jurisdiction &&
      created.root.remedyType === root.remedyType;
    if (!same) return { ok: false, reason: 'IDEMPOTENCY_KEY_CONFLICT' };
  }
  return { ok: true, status: created.created ? 'ROOT_CREATED' : 'ROOT_EXISTING', root: created.root };
}

export type RecordFactReason =
  | 'INVALID_REQUEST'
  | 'ATTEMPT_NOT_FOUND'
  | 'SUBMITTED_REQUIRES_PROVIDER_ID'
  | 'PROVIDER_SUBMISSION_ID_CONFLICT'
  | 'FACT_IMMUTABLE_MISMATCH'
  | 'INVALID_TIMESTAMP'
  | 'FUTURE_TIMESTAMP';

export type RecordFactOutcome =
  | { ok: true; status: 'FACT_RECORDED' | 'ALREADY_RECORDED'; fact: CustomsSubmissionAttemptFact }
  | { ok: false; reason: RecordFactReason };

export async function recordCustomsSubmissionAttemptFact(
  input: {
    organizationId: string;
    attemptId: string;
    status: CustomsSubmissionAttemptStatus;
    providerSubmissionId?: string | null;
    source: CustomsSubmissionSource;
    verificationLevel: CustomsSubmissionVerificationLevel;
    observedAt: string;
    providerReference?: string | null;
    errorCode?: string | null;
    reconciliationAttempt?: number | null;
  },
  deps: { store: CustomsSubmissionLedgerStore; now?: () => Date },
): Promise<RecordFactOutcome> {
  if (
    !CUSTOMS_SUBMISSION_STATUSES.includes(input.status) ||
    !CUSTOMS_SUBMISSION_SOURCES.includes(input.source) ||
    !CUSTOMS_SUBMISSION_VERIFICATION_LEVELS.includes(input.verificationLevel)
  ) {
    return { ok: false, reason: 'INVALID_REQUEST' };
  }
  const root = await deps.store.findRootById(input.organizationId, input.attemptId);
  if (root === null) return { ok: false, reason: 'ATTEMPT_NOT_FOUND' };

  const providerSubmissionId = input.providerSubmissionId ?? null;
  if (input.status === 'SUBMITTED' && providerSubmissionId === null) {
    return { ok: false, reason: 'SUBMITTED_REQUIRES_PROVIDER_ID' };
  }
  // CHANGE A：冲突检测已下沉到 store 事务（root 行锁内重读事实后判定）。

  const now = deps.now ? deps.now() : new Date();
  const observedMs = Date.parse(input.observedAt);
  if (Number.isNaN(observedMs)) return { ok: false, reason: 'INVALID_TIMESTAMP' };
  if (observedMs > now.getTime()) return { ok: false, reason: 'FUTURE_TIMESTAMP' };

  const fact: CustomsSubmissionAttemptFact = {
    id: customsSubmissionFactId({
      organizationId: input.organizationId,
      attemptId: input.attemptId,
      status: input.status,
      providerSubmissionId,
      observedAt: input.observedAt,
      reconciliationAttempt: input.reconciliationAttempt ?? null,
    }),
    organizationId: input.organizationId,
    attemptId: input.attemptId,
    status: input.status,
    providerSubmissionId,
    source: input.source,
    verificationLevel: input.verificationLevel,
    observedAt: input.observedAt,
    recordedAt: now.toISOString(),
    providerReference: input.providerReference ?? null,
    errorCode: input.errorCode ?? null,
    reconciliationAttempt: input.reconciliationAttempt ?? null,
    createdAt: now.toISOString(),
  };
  const appended = await deps.store.appendFactGuarded(fact, { forbidProviderSubmissionIdConflict: true });
  if (appended.conflict !== null) return { ok: false, reason: appended.conflict };
  if (appended.fact === null) return { ok: false, reason: 'INVALID_REQUEST' };
  return { ok: true, status: appended.created ? 'FACT_RECORDED' : 'ALREADY_RECORDED', fact: appended.fact };
}

/** ⑧ 退避对账（1/5/15/60 分钟；24h → MANUAL_REVIEW）；永不重发 filing。 */
export const CUSTOMS_RECONCILIATION_BACKOFF_MINUTES = [1, 5, 15, 60] as const;
export const CUSTOMS_MANUAL_REVIEW_AFTER_HOURS = 24;

export function evaluateReconciliationSchedule(input: {
  lastAttemptAt: string;
  now: Date;
  reconciliationAttempt: number;
}): { disposition: 'RETRY_RECONCILE' | 'MANUAL_REVIEW'; nextDelayMinutes: number | null } {
  const elapsedMs = input.now.getTime() - Date.parse(input.lastAttemptAt);
  if (elapsedMs >= CUSTOMS_MANUAL_REVIEW_AFTER_HOURS * 60 * 60 * 1000) {
    return { disposition: 'MANUAL_REVIEW', nextDelayMinutes: null };
  }
  const index = Math.min(input.reconciliationAttempt, CUSTOMS_RECONCILIATION_BACKOFF_MINUTES.length - 1);
  return { disposition: 'RETRY_RECONCILE', nextDelayMinutes: CUSTOMS_RECONCILIATION_BACKOFF_MINUTES[index] };
}

/** 边界自证（⑫）：账本不存凭据 / 原始 payload，也不做任何外写。 */
export const CUSTOMS_SUBMISSION_LEDGER_BOUNDARY = {
  filingSubmitted: false,
  externalWritePerformed: false,
  transportEnabled: false,
  platformWriteEnabled: false,
  storesCredential: false,
  storesRawPayload: false,
  productionCredentials: 'ABSENT',
} as const;
