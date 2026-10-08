/**
 * PHASE 2 / CHANGE 3A（审计 MSG-20261008-20）—— 可信终局事实
 * ---------------------------------------------------------------
 * 复审原文要求：终局结果（`PROVIDER_CONFIRMED` / `SETTLEMENT_RECEIVED`）必须在
 * `businessOutcome` 生成、持久化与 `settle()` 的**完整调用链**上绑定
 * 「已验证的 provider/settlement evidence + 可信来源 + case/organization lineage」；
 * runner、任务输入与非可信调用者**不得自行声明**终局；外部 Provider HOLD 期间
 * **不得**用模拟终局事实把客户任务写成业务完成。
 *
 * 本模块的**门禁语义（fail-closed，默认关闭）**：
 *   1. 终局证据来源是一份**allow-list 注册表**，且生产默认**全部 disabled**
 *      （真实 Provider 写入 / 结算系统接入都是 HOLD ⇒ 当前没有任何来源可被信任）；
 *   2. `verified` 由**来源校验者**置位；`verifiedBy` 必须是该来源登记的校验者身份，
 *      且不得是 `RUNNER` / `TASK_INPUT` / `LOCAL_SIMULATION` / `CLIENT` 等自报方；
 *   3. `organizationId` 必须等于**服务端从 durable 事实解析出的权威租户**
 *      （绝不采用请求里的租户）；
 *   4. `taskDedupeKey` 必须等于**本 durable 任务的去重键** ⇒ 外部事实与具体任务行**强 lineage 绑定**
 *      （防止跨任务 / 错配归属把别的终局事实算到本任务头上）；
 *   5. 证据字段缺失、占位 token（`timeout` / `unconfigured` …）、时间不可解析等一律拒绝。
 *
 * 边界：本模块**只做判定**，不读取任何凭据、不写入数据库、不执行外部写（`REAL_PROVIDER_WRITE` = HOLD）。
 */

import type { RecoveryBusinessOutcome } from './recovery-business-outcome';
import { RSI_NO_EVIDENCE_TOKENS } from './rsi-evidence-verifier';

/** 终局证据类别 —— 一类外部事实只对应一个终局档 */
export type RecoveryTerminalEvidenceKind = 'PROVIDER_CONFIRMATION' | 'SETTLEMENT_LEDGER_ENTRY';

/** 类别 → 终局档（唯一映射，调用者不得自定义） */
export const TERMINAL_OUTCOME_FOR_KIND: Readonly<Record<RecoveryTerminalEvidenceKind, RecoveryBusinessOutcome>> = {
  PROVIDER_CONFIRMATION: 'PROVIDER_CONFIRMED',
  SETTLEMENT_LEDGER_ENTRY: 'SETTLEMENT_RECEIVED',
};

export interface RecoveryTerminalEvidenceSource {
  /** 来源系统标识（allow-list 键；未知来源一律拒绝） */
  id: string;
  kind: RecoveryTerminalEvidenceKind;
  /** 该来源唯一被承认的校验者身份 */
  verifierId: string;
  /** 是否已由 HOST 启用；**生产默认全部 false** */
  enabled: boolean;
  /** 启用依据（HOST 授权引用）。未启用时必须为空，避免「静默开闸」 */
  enabledByRef?: string;
}

/**
 * 生产注册表：**全部禁用**。
 * 真实 Provider 确认与结算入账都需要外部写/外部读能力，当前全部 HOLD，
 * 因此生产上不存在任何可被信任的终局来源 ⇒ 终局档不可达（这正是期望的 fail-closed）。
 */
export const PRODUCTION_TERMINAL_EVIDENCE_SOURCES: readonly RecoveryTerminalEvidenceSource[] = [
  {
    id: 'PROVIDER_OF_RECORD',
    kind: 'PROVIDER_CONFIRMATION',
    verifierId: 'PROVIDER_EVIDENCE_VERIFIER',
    enabled: false,
  },
  {
    id: 'SETTLEMENT_LEDGER',
    kind: 'SETTLEMENT_LEDGER_ENTRY',
    verifierId: 'SETTLEMENT_EVIDENCE_VERIFIER',
    enabled: false,
  },
];

/** 非可信宣告者：这些身份自报的 `verified=true` 一律不构成证据 */
export const UNTRUSTED_TERMINAL_DECLARERS: readonly string[] = [
  'RUNNER',
  'TASK_INPUT',
  'LOCAL_SIMULATION',
  'LOCAL_SIM',
  'CLIENT',
  'UNKNOWN',
];

export interface RecoveryTerminalEvidence {
  kind: RecoveryTerminalEvidenceKind;
  /** 来源系统 id（必须命中注册表） */
  source: string;
  /** 由来源校验者置位；调用者自报不构成证据 */
  verified: boolean;
  /** 校验者身份（必须等于来源登记的 verifierId） */
  verifiedBy: string;
  /** 校验凭据引用（不得为空、不得为占位 token） */
  verificationRef: string;
  /** 外部事件身份（幂等 / 可追溯） */
  providerEventId: string;
  /** 观测时刻（ISO 8601） */
  observedAt: string;
  /** 事实所属租户（必须等于权威租户） */
  organizationId: string;
  /** lineage：该事实指向的 durable 任务去重键 */
  taskDedupeKey: string;
  /** 账户（若权威侧声明了账户，则必须匹配） */
  accountId?: string;
  /** 金额（分）与币种（仅记录，不参与放行判定） */
  amountMinor?: number;
  currency?: string;
}

/** 判定上下文：权威值**只能**由服务端从 durable 事实解析 */
export interface RecoveryTerminalEvidenceContext {
  authoritativeOrganizationId: string;
  authoritativeTaskDedupeKey: string;
  authoritativeAccountId?: string;
  sources?: readonly RecoveryTerminalEvidenceSource[];
}

export const TERMINAL_EVIDENCE_DECISION = {
  TRUSTED: 'TERMINAL_EVIDENCE_TRUSTED',
  OUTCOME_NOT_TERMINAL: 'TERMINAL_EVIDENCE_OUTCOME_NOT_TERMINAL',
  MISSING: 'TERMINAL_EVIDENCE_MISSING',
  KIND_MISMATCH: 'TERMINAL_EVIDENCE_KIND_MISMATCH',
  SOURCE_UNKNOWN: 'TERMINAL_EVIDENCE_SOURCE_UNKNOWN',
  SOURCE_KIND_MISMATCH: 'TERMINAL_EVIDENCE_SOURCE_KIND_MISMATCH',
  SOURCE_DISABLED: 'TERMINAL_EVIDENCE_SOURCE_DISABLED',
  NOT_VERIFIED: 'TERMINAL_EVIDENCE_NOT_VERIFIED',
  SELF_DECLARED: 'TERMINAL_EVIDENCE_SELF_DECLARED',
  VERIFIER_NOT_AUTHORIZED: 'TERMINAL_EVIDENCE_VERIFIER_NOT_AUTHORIZED',
  NO_VERIFICATION_REF: 'TERMINAL_EVIDENCE_NO_VERIFICATION_REF',
  MISSING_EVENT_ID: 'TERMINAL_EVIDENCE_MISSING_EVENT_ID',
  OBSERVED_AT_INVALID: 'TERMINAL_EVIDENCE_OBSERVED_AT_INVALID',
  TENANT_MISMATCH: 'TERMINAL_EVIDENCE_TENANT_MISMATCH',
  TASK_LINEAGE_MISMATCH: 'TERMINAL_EVIDENCE_TASK_LINEAGE_MISMATCH',
  ACCOUNT_MISMATCH: 'TERMINAL_EVIDENCE_ACCOUNT_MISMATCH',
  NO_TRUSTED_TENANT: 'TERMINAL_EVIDENCE_NO_TRUSTED_TENANT',
} as const;

export type TerminalEvidenceReason =
  (typeof TERMINAL_EVIDENCE_DECISION)[keyof typeof TERMINAL_EVIDENCE_DECISION];

export interface RecoveryTerminalEvidenceVerdict {
  trusted: boolean;
  reason: TerminalEvidenceReason | string;
}

const TERMINAL_OUTCOMES: readonly RecoveryBusinessOutcome[] = ['PROVIDER_CONFIRMED', 'SETTLEMENT_RECEIVED'];

const nonEmpty = (value: unknown): boolean => typeof value === 'string' && value.trim() !== '';

/**
 * 判定一份「终局事实」是否可被信任。
 * 任何一步不满足即返回 `{ trusted: false, reason }`；调用方**必须**据此拒绝落终态。
 */
export function evaluateRecoveryTerminalEvidence(input: {
  outcome: RecoveryBusinessOutcome;
  evidence?: RecoveryTerminalEvidence;
  context: RecoveryTerminalEvidenceContext;
}): RecoveryTerminalEvidenceVerdict {
  const { outcome, evidence, context } = input;
  const sources = context.sources ?? PRODUCTION_TERMINAL_EVIDENCE_SOURCES;

  if (!TERMINAL_OUTCOMES.includes(outcome)) {
    return { trusted: false, reason: TERMINAL_EVIDENCE_DECISION.OUTCOME_NOT_TERMINAL };
  }
  if (evidence === undefined) {
    return { trusted: false, reason: TERMINAL_EVIDENCE_DECISION.MISSING };
  }
  if (TERMINAL_OUTCOME_FOR_KIND[evidence.kind] !== outcome) {
    return { trusted: false, reason: TERMINAL_EVIDENCE_DECISION.KIND_MISMATCH };
  }
  const source = sources.find((candidate) => candidate.id === evidence.source);
  if (source === undefined) {
    return { trusted: false, reason: TERMINAL_EVIDENCE_DECISION.SOURCE_UNKNOWN };
  }
  if (source.kind !== evidence.kind) {
    return { trusted: false, reason: TERMINAL_EVIDENCE_DECISION.SOURCE_KIND_MISMATCH };
  }
  if (source.enabled !== true) {
    return { trusted: false, reason: TERMINAL_EVIDENCE_DECISION.SOURCE_DISABLED };
  }
  if (evidence.verified !== true) {
    return { trusted: false, reason: TERMINAL_EVIDENCE_DECISION.NOT_VERIFIED };
  }
  const verifier = typeof evidence.verifiedBy === 'string' ? evidence.verifiedBy.trim().toUpperCase() : '';
  if (verifier === '' || UNTRUSTED_TERMINAL_DECLARERS.includes(verifier)) {
    return { trusted: false, reason: TERMINAL_EVIDENCE_DECISION.SELF_DECLARED };
  }
  if (verifier !== source.verifierId) {
    return { trusted: false, reason: TERMINAL_EVIDENCE_DECISION.VERIFIER_NOT_AUTHORIZED };
  }
  const ref = typeof evidence.verificationRef === 'string' ? evidence.verificationRef.trim() : '';
  if (ref === '' || RSI_NO_EVIDENCE_TOKENS.includes(ref)) {
    return { trusted: false, reason: TERMINAL_EVIDENCE_DECISION.NO_VERIFICATION_REF };
  }
  if (!nonEmpty(evidence.providerEventId)) {
    return { trusted: false, reason: TERMINAL_EVIDENCE_DECISION.MISSING_EVENT_ID };
  }
  if (!nonEmpty(evidence.observedAt) || !Number.isFinite(Date.parse(evidence.observedAt))) {
    return { trusted: false, reason: TERMINAL_EVIDENCE_DECISION.OBSERVED_AT_INVALID };
  }
  if (!nonEmpty(context.authoritativeOrganizationId)) {
    return { trusted: false, reason: TERMINAL_EVIDENCE_DECISION.NO_TRUSTED_TENANT };
  }
  if (evidence.organizationId !== context.authoritativeOrganizationId) {
    return { trusted: false, reason: TERMINAL_EVIDENCE_DECISION.TENANT_MISMATCH };
  }
  if (evidence.taskDedupeKey !== context.authoritativeTaskDedupeKey) {
    return { trusted: false, reason: TERMINAL_EVIDENCE_DECISION.TASK_LINEAGE_MISMATCH };
  }
  if (
    context.authoritativeAccountId !== undefined &&
    context.authoritativeAccountId !== '' &&
    evidence.accountId !== context.authoritativeAccountId
  ) {
    return { trusted: false, reason: TERMINAL_EVIDENCE_DECISION.ACCOUNT_MISMATCH };
  }
  return { trusted: true, reason: TERMINAL_EVIDENCE_DECISION.TRUSTED };
}

/**
 * 「已授权的终局档」——只在证据判定为 trusted 时产生。
 * `deriveRecoveryBusinessOutcome` 只接受本对象作为终局来源，因此
 * **调用者无法用布尔自报**把任务推导成 `PROVIDER_CONFIRMED` / `SETTLEMENT_RECEIVED`。
 */
export interface AuthorizedTerminalOutcome {
  readonly outcome: RecoveryBusinessOutcome;
  readonly source: string;
  readonly evidenceRef: string;
  readonly providerEventId: string;
}

/** 只有证据通过时才返回授权对象；否则返回 `null`（fail-closed） */
export function createAuthorizedTerminalOutcome(input: {
  outcome: RecoveryBusinessOutcome;
  evidence?: RecoveryTerminalEvidence;
  context: RecoveryTerminalEvidenceContext;
}): { authorization: AuthorizedTerminalOutcome | null; verdict: RecoveryTerminalEvidenceVerdict } {
  const verdict = evaluateRecoveryTerminalEvidence(input);
  if (!verdict.trusted || input.evidence === undefined) {
    return { authorization: null, verdict };
  }
  return {
    authorization: {
      outcome: input.outcome,
      source: input.evidence.source,
      evidenceRef: input.evidence.verificationRef,
      providerEventId: input.evidence.providerEventId,
    },
    verdict,
  };
}

/** 仅供**测试/同构验收**：显式启用一个可信来源。生产代码不得调用。 */
export function createTestTerminalEvidenceSource(
  overrides: Partial<RecoveryTerminalEvidenceSource> = {},
): RecoveryTerminalEvidenceSource {
  return {
    id: 'SETTLEMENT_LEDGER',
    kind: 'SETTLEMENT_LEDGER_ENTRY',
    verifierId: 'SETTLEMENT_EVIDENCE_VERIFIER',
    enabled: true,
    enabledByRef: 'test-only://CHANGE-3A',
    ...overrides,
  };
}

/**
 * 便捷入口（**唯一**可把终局档交给 `deriveRecoveryBusinessOutcome` 的路径）：
 * 证据通过 ⇒ 返回已授权终局档；否则 ⇒ `null`（fail-closed，调用方只能继续用非终局档）。
 */
export function deriveTrustedOutcomeOf(
  evidence: RecoveryTerminalEvidence | undefined,
  context: RecoveryTerminalEvidenceContext,
): AuthorizedTerminalOutcome | null {
  if (evidence === undefined) return null;
  const kindOutcome = TERMINAL_OUTCOME_FOR_KIND[evidence.kind];
  if (kindOutcome === undefined) return null;
  const { authorization } = createAuthorizedTerminalOutcome({ outcome: kindOutcome, evidence, context });
  return authorization;
}

export const RECOVERY_TERMINAL_EVIDENCE_BOUNDARY = {
  defaultSourcesEnabled: false,
  trustedSourcesRequireHostEnablement: true,
  runnerSelfDeclarationAccepted: false,
  taskInputSelfDeclarationAccepted: false,
  lineageBinding: 'evidence.taskDedupeKey == durable AutonomyTask.dedupeKey',
  tenantBinding: 'evidence.organizationId == incident.sourceRefs[0].organizationId（服务端解析）',
  readsCredentials: false,
  writesDatabase: false,
  performsExternalWrite: false,
  realProviderWrite: false,
  payment: false,
  customsFiling: false,
} as const;
