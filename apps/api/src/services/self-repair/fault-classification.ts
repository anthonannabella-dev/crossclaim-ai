/**
 * INTERNAL CODE REPAIR V1 / PHASE 1 —— 内部故障诊断中心（确定性分类，纯函数）
 * ---------------------------------------------------------------
 * 依据 HOST 指令《SI/RSI INTERNAL AUTONOMOUS CODE REPAIR V1》第四节：
 *   · 至少覆盖 12 类：API_TIMEOUT / API_RATE_LIMIT / TOKEN_EXPIRED / PROVIDER_SCHEMA_CHANGED /
 *     PARSER_FAILURE / WORKFLOW_PLANNING_ERROR / DATA_CONFLICT / DATABASE_TRANSACTION_ERROR /
 *     RUNTIME_EXCEPTION / INTEGRATION_CONTRACT_MISMATCH / REGRESSION_FAILURE / UNKNOWN_ERROR；
 *   · **优先使用确定性分类**：本模块是纯函数（零 IO、零模型调用），只按**可核验证据**
 *     （错误码 / 错误类名 / HTTP 状态 / Prisma 码 / 阶段标记）判定，不做猜测、不补事实；
 *   · 模型只能**辅助归因**：`annotateUntrustedModelHint()` 只记录「模型声称了什么」，
 *     `authority='NONE'`，绝不参与分类结果，也绝不放宽风险等级 / 重试资格 / 权限判定；
 *   · 故障数据一律脱敏：客户原始订单、Token、密码、密钥、授权串、绝对路径不进模型也不落库；
 *   · 无法由证据判定的，一律 `UNKNOWN_ERROR`（**不猜**）。
 *
 * 边界：不新增第二套 runtime / scheduler / controller；本模块只产出**可信 Incident 意图**，
 * 由既有 `AutonomyIncident` 容器持久化（见 `fault-incident-intake.ts`）。
 */

import { createHash } from 'node:crypto';

import { truncate } from '../audit/sanitize';
import { requiresOwnerApproval, type RsiOwnerGatedAction, type RsiRiskClass } from '../autonomy/rsi-lifecycle';
import { sanitizeSignalText } from '../autonomy/rsi-observer';

/** 修复平面的 Incident 容器 kind（与客户执行面的 `CUSTOMER_GOAL_QUEUE` **必须不同**）。 */
export const INTERNAL_FAULT_INCIDENT_KIND = 'INTERNAL_FAULT';

/** 指令第四节要求覆盖的故障类（顺序即指令顺序，逐字一致）。 */
export const FAULT_CLASSES = [
  'API_TIMEOUT',
  'API_RATE_LIMIT',
  'TOKEN_EXPIRED',
  'PROVIDER_SCHEMA_CHANGED',
  'PARSER_FAILURE',
  'WORKFLOW_PLANNING_ERROR',
  'DATA_CONFLICT',
  'DATABASE_TRANSACTION_ERROR',
  'RUNTIME_EXCEPTION',
  'INTEGRATION_CONTRACT_MISMATCH',
  'REGRESSION_FAILURE',
  'UNKNOWN_ERROR',
] as const;
export type FaultClass = (typeof FAULT_CLASSES)[number];

export const FAULT_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type FaultSeverity = (typeof FAULT_SEVERITIES)[number];

export const FAULT_ENVIRONMENTS = ['LOCAL', 'TEST', 'STAGING', 'PRODUCTION'] as const;
export type FaultEnvironment = (typeof FAULT_ENVIRONMENTS)[number];

/** 重试资格：只有**确定性可重试**的类别才允许自动重试；其余必须走代码修复 / 人工。 */
export const RETRY_ELIGIBILITIES = [
  'AUTO_RETRY_BACKOFF',
  'NOT_RETRYABLE',
  'CODE_FIX_REQUIRED',
  'NEEDS_CLASSIFICATION',
] as const;
export type RetryEligibility = (typeof RETRY_ELIGIBILITIES)[number];

/** 故障要求的下一步动作（PHASE 2 的 A/B/C 分流会消费这个字段）。 */
export const FAULT_REQUIRED_ACTIONS = [
  'AUTO_RECOVER',
  'CODE_REPAIR_CANDIDATE',
  'HUMAN_REVIEW',
  'OWNER_ACTION',
  'INVESTIGATE',
] as const;
export type FaultRequiredAction = (typeof FAULT_REQUIRED_ACTIONS)[number];

/** 原始观察（调用方只填**证据**，不填结论；全部字段都会被脱敏后使用）。 */
export interface FaultObservation {
  /** 故障发生模块（相对模块名，例如 `services/adapters`）。 */
  sourceModule: string;
  environment: FaultEnvironment;
  errorName?: string | null;
  errorCode?: string | null;
  message?: string | null;
  httpStatus?: number | null;
  /** `RsiProviderFailureReason`（模型网关失败原因）。 */
  providerFailureReason?: string | null;
  /** 适配器错误码（`AdapterError.code`）。 */
  adapterErrorCode?: string | null;
  /** 承运商只读失败码（`CarrierProviderReadError.code`）。 */
  carrierReadErrorCode?: string | null;
  /** Prisma 错误码（`PrismaClientKnownRequestError.code`）。 */
  prismaCode?: string | null;
  /** 处理阶段标记（PARSER / SCHEMA_VALIDATION / PLANNING / TEST / TYPECHECK / CI）。 */
  stage?: string | null;
  /** 发生环境标签（LOCAL / TEST / STAGING / PRODUCTION），用于 Incident 归档。 */
  occurrenceCount?: number | null;
  durationMs?: number | null;
  timeoutMs?: number | null;
  providerRef?: string | null;
  /** 客户组织 id：**只以脱敏后的不可逆引用落库**（见 `opaqueRef`）。 */
  organizationRef?: string | null;
  domain?: string | null;
  taskRefs?: readonly string[] | null;
  evidenceRefs?: readonly string[] | null;
  /** 该故障是否触及安全边界（Action Guard / HOLD / 租户隔离）。 */
  securityAffecting?: boolean;
  /** 该故障是否改变权限语义。 */
  privilegeAffecting?: boolean;
  /** 模型给出的**非权威**归因提示（永不影响分类结果）。 */
  modelHint?: UntrustedModelHint | null;
}

export interface UntrustedModelHint {
  claimedClass?: string | null;
  rationale?: string | null;
}

/** 模型提示的归档形态：只留「模型说过什么」，并明确 `authority='NONE'`。 */
export interface ModelHintAnnotation {
  source: 'MODEL';
  authority: 'NONE';
  claimedClass: string | null;
  agreesWithDeterministicClass: boolean;
  rationale: string;
}

export interface FaultDiagnosis {
  faultClass: FaultClass;
  /** 命中的确定性规则 id（可追溯「为什么是这一类」）。 */
  ruleId: string;
  severity: FaultSeverity;
  riskClass: RsiRiskClass;
  retryEligibility: RetryEligibility;
  requiredAction: FaultRequiredAction;
  /** 仅当 `requiredAction='OWNER_ACTION'` 时给出**既有** OWNER-gated 动作名。 */
  ownerGatedAction: RsiOwnerGatedAction | null;
  /** 已脱敏的一句话摘要（可安全落库 / 可送模型）。 */
  summary: string;
  /** 去重键：同一故障反复发生聚合到同一 Incident。 */
  dedupeKey: string;
  /** 模型提示归档（`authority='NONE'`）；无提示时为 null。 */
  untrustedModelHint: ModelHintAnnotation | null;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g;
const BEARER_RE = /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi;
const ASSIGNMENT_RE =
  /\b(api[_-]?key|secret|password|passwd|token|access[_-]?token|refresh[_-]?token|client[_-]?secret|signature|authorization|x-api-key)\b\s*[:=]\s*"?[^\s"',;]{4,}"?/gi;
const CLOUD_KEY_RE = /\b(AKIA|ASIA)[0-9A-Z]{12,}\b/g;
const PREFIXED_KEY_RE = /\b(sk|pk|rk|gh[pousr])[-_][A-Za-z0-9_-]{8,}\b/g;
const LONG_HEX_RE = /\b[0-9a-f]{32,}\b/gi;
const QUERY_SECRET_RE = /([?&](?:token|key|secret|signature)=)[^\s&#]+/gi;

/**
 * 故障文本脱敏：先掩掉密钥/授权串/订单号形状的内容，再复用既有 `sanitizeSignalText()`
 * （邮箱 / 电话 / 长数字 / 带 token 的 URL / 绝对路径），最后截断。
 * 输出可安全落库，也可安全送入模型做**辅助**归因。
 */
export function redactFaultText(input: unknown, maxLength = 300): string {
  if (typeof input !== 'string' || input.trim() === '') return '';
  const masked = input
    .replace(JWT_RE, '[redacted-jwt]')
    .replace(BEARER_RE, '[redacted-authorization]')
    .replace(ASSIGNMENT_RE, '[redacted-secret]')
    .replace(CLOUD_KEY_RE, '[redacted-key]')
    .replace(PREFIXED_KEY_RE, '[redacted-key]')
    .replace(QUERY_SECRET_RE, '$1[redacted]')
    .replace(LONG_HEX_RE, '[redacted-hash]')
    .replace(EMAIL_RE, '[redacted-email]');
  return truncate(sanitizeSignalText(masked), maxLength);
}

/** 不可逆引用：用于组织 / Provider 关联，落库不存原始 id。 */
function opaqueRef(kind: 'org' | 'provider' | 'tenant', raw: string): string {
  const digest = createHash('sha256').update(`${kind}|${raw}`, 'utf8').digest('hex').slice(0, 16);
  return `${kind}-${digest}`;
}

function normalizeToken(value: unknown): string {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

/** 归一化后的**证据**（规则只读这里；不含任何脱敏后会被破坏的判定依据）。 */
interface NormalizedEvidence {
  name: string;
  code: string;
  message: string;
  status: number | null;
  prismaCode: string;
  stage: string;
}

interface FaultRule {
  id: string;
  faultClass: FaultClass;
  test: (evidence: NormalizedEvidence) => boolean;
}

const inSet = (value: string, set: readonly string[]): boolean => set.includes(value);
const containsAny = (haystack: string, needles: readonly string[]): boolean =>
  needles.some((needle) => haystack.includes(needle));

const DATABASE_TRANSACTION_CODES = [
  'DATABASE_TRANSACTION_ERROR',
  'DEADLOCK',
  'SERIALIZATION_FAILURE',
  'TRANSACTION_CONFLICT',
  'SQLSTATE_40001',
  'SQLSTATE_40P01',
  'SQLSTATE_55P03',
] as const;
const DATABASE_TRANSACTION_PRISMA_CODES = ['P2034', 'P2028', 'P1001', 'P1002', 'P1008', 'P1017'] as const;

const DATA_CONFLICT_CODES = [
  'DATA_CONFLICT',
  'UNIQUE_VIOLATION',
  'DUPLICATE_KEY',
  'IDEMPOTENCY_CONFLICT',
  'CANONICAL_CONFLICT',
  'CONFLICTING_FACTS',
] as const;
const DATA_CONFLICT_PRISMA_CODES = ['P2002', 'P2003', 'P2004'] as const;

const EXPIRED_CREDENTIAL_CODES = [
  'AUTH_FAILED',
  'TOKEN_EXPIRED',
  'CREDENTIAL_EXPIRED',
  'INVALID_GRANT',
  'UNAUTHENTICATED',
  'OAUTH_TOKEN_EXPIRED',
  'REFRESH_TOKEN_EXPIRED',
  'TOKEN_REVOKED',
] as const;

const RATE_LIMIT_CODES = [
  'RATE_LIMITED',
  'RATE_LIMITED_429',
  'RATE_LIMIT',
  'RATE_LIMIT_EXCEEDED',
  'TOO_MANY_REQUESTS',
  'THROTTLED',
] as const;

const TIMEOUT_CODES = [
  'PROVIDER_TIMEOUT',
  'API_TIMEOUT',
  'REQUEST_TIMEOUT',
  'TIMEOUT',
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'DEADLINE_EXCEEDED',
] as const;

const PROVIDER_SCHEMA_CODES = [
  'PROVIDER_SCHEMA_CHANGED',
  'SCHEMA_CHANGED',
  'SCHEMA_MISMATCH',
  'OUTPUT_SCHEMA_INVALID',
  'RAW_PAYLOAD_INVALID',
  'UNEXPECTED_RESPONSE_SHAPE',
  'CONTRACT_DRIFT',
] as const;

const PARSER_CODES = [
  'PARSER_FAILURE',
  'PARSE_ERROR',
  'PARSING_FAILED',
  'MAPPING_FAILURE',
  'ADAPTER_MAPPING_ERROR',
  'ADAPTER_MAPPING_FAILURE',
  'JSON_PARSE_ERROR',
] as const;

const WORKFLOW_PLANNING_CODES = [
  'WORKFLOW_PLANNING_ERROR',
  'PLANNING_ERROR',
  'PLAN_INVALID',
  'GOAL_UNSUPPORTED_INTENT',
  'WORKFLOW_REJECTED',
  'TASK_PLANNING_ERROR',
] as const;

const INTEGRATION_CONTRACT_CODES = [
  'INTEGRATION_CONTRACT_MISMATCH',
  'CONTRACT_MISMATCH',
  'API_VERSION_UNSUPPORTED',
  'VERSION_MISMATCH',
  'UNSUPPORTED_PROVIDER_CONTRACT',
  'ADAPTER_UNSUPPORTED',
] as const;

const REGRESSION_CODES = [
  'REGRESSION_FAILURE',
  'TEST_FAILURE',
  'TYPECHECK_FAILURE',
  'CI_FAIL',
  'BUILD_FAILURE',
] as const;

const RUNTIME_EXCEPTION_NAMES = [
  'ERROR',
  'TYPEERROR',
  'RANGEERROR',
  'REFERENCEERROR',
  'SYNTAXERROR',
  'EVALERROR',
  'URIERROR',
] as const;

/**
 * 确定性规则表（**顺序即优先级**，先命中先定类）。
 * 每条的判定只依赖 `NormalizedEvidence`：同一输入必然得到同一输出。
 */
const FAULT_RULES: readonly FaultRule[] = [
  {
    id: 'R_DATABASE_TRANSACTION',
    faultClass: 'DATABASE_TRANSACTION_ERROR',
    test: (e) =>
      inSet(e.prismaCode, DATABASE_TRANSACTION_PRISMA_CODES) ||
      inSet(e.code, DATABASE_TRANSACTION_CODES),
  },
  {
    id: 'R_DATA_CONFLICT',
    faultClass: 'DATA_CONFLICT',
    test: (e) =>
      inSet(e.prismaCode, DATA_CONFLICT_PRISMA_CODES) || inSet(e.code, DATA_CONFLICT_CODES),
  },
  {
    id: 'R_EXPIRED_CREDENTIAL',
    faultClass: 'TOKEN_EXPIRED',
    test: (e) =>
      e.status === 401 ||
      inSet(e.code, EXPIRED_CREDENTIAL_CODES) ||
      e.name === 'ADAPTERAUTHERROR' ||
      containsAny(e.message, ['token expired', 'token has expired', 'invalid_grant', 'credential expired']),
  },
  {
    id: 'R_RATE_LIMIT',
    faultClass: 'API_RATE_LIMIT',
    test: (e) =>
      e.status === 429 || inSet(e.code, RATE_LIMIT_CODES) || e.name === 'ADAPTERRATELIMITERROR',
  },
  {
    id: 'R_TIMEOUT',
    faultClass: 'API_TIMEOUT',
    test: (e) =>
      e.status === 408 ||
      e.status === 504 ||
      inSet(e.code, TIMEOUT_CODES) ||
      e.name === 'ABORTERROR' ||
      e.name === 'TIMEOUTERROR' ||
      containsAny(e.message, ['timed out', 'timeout', 'deadline exceeded']),
  },
  {
    id: 'R_PROVIDER_SCHEMA_CHANGED',
    faultClass: 'PROVIDER_SCHEMA_CHANGED',
    test: (e) =>
      inSet(e.code, PROVIDER_SCHEMA_CODES) ||
      e.stage === 'SCHEMA_VALIDATION' ||
      e.stage === 'PROVIDER_SCHEMA',
  },
  {
    id: 'R_PARSER_FAILURE',
    faultClass: 'PARSER_FAILURE',
    test: (e) =>
      inSet(e.code, PARSER_CODES) || e.name === 'ADAPTERMAPPINGERROR' || e.stage === 'PARSER',
  },
  {
    id: 'R_WORKFLOW_PLANNING',
    faultClass: 'WORKFLOW_PLANNING_ERROR',
    test: (e) =>
      inSet(e.code, WORKFLOW_PLANNING_CODES) ||
      e.stage === 'PLANNING' ||
      e.stage === 'WORKFLOW_PLANNING',
  },
  {
    id: 'R_INTEGRATION_CONTRACT',
    faultClass: 'INTEGRATION_CONTRACT_MISMATCH',
    test: (e) =>
      inSet(e.code, INTEGRATION_CONTRACT_CODES) || e.name === 'ADAPTERCAPABILITYERROR',
  },
  {
    id: 'R_REGRESSION',
    faultClass: 'REGRESSION_FAILURE',
    test: (e) =>
      inSet(e.code, REGRESSION_CODES) ||
      e.stage === 'TEST' ||
      e.stage === 'TYPECHECK' ||
      e.stage === 'CI',
  },
  {
    id: 'R_RUNTIME_EXCEPTION',
    faultClass: 'RUNTIME_EXCEPTION',
    test: (e) => inSet(e.name, RUNTIME_EXCEPTION_NAMES) || e.code === 'RUNTIME_EXCEPTION',
  },
  {
    id: 'R_UNCLASSIFIED',
    faultClass: 'UNKNOWN_ERROR',
    test: () => true,
  },
];

interface FaultOutcome {
  severity: FaultSeverity;
  riskClass: RsiRiskClass;
  retryEligibility: RetryEligibility;
  requiredAction: FaultRequiredAction;
  ownerGatedAction?: RsiOwnerGatedAction;
}

/**
 * 类别 → 处置基线。**默认倾向保守**：无法确定性重试的类别一律 `CODE_FIX_REQUIRED` / 人工。
 * 仅 `API_TIMEOUT` / `API_RATE_LIMIT` / `DATABASE_TRANSACTION_ERROR` 属确定性可重试。
 */
const FAULT_OUTCOMES: Record<FaultClass, FaultOutcome> = {
  API_TIMEOUT: {
    severity: 'MEDIUM',
    riskClass: 'MEDIUM',
    retryEligibility: 'AUTO_RETRY_BACKOFF',
    requiredAction: 'AUTO_RECOVER',
  },
  API_RATE_LIMIT: {
    severity: 'LOW',
    riskClass: 'LOW',
    retryEligibility: 'AUTO_RETRY_BACKOFF',
    requiredAction: 'AUTO_RECOVER',
  },
  TOKEN_EXPIRED: {
    severity: 'HIGH',
    riskClass: 'HIGH',
    retryEligibility: 'NOT_RETRYABLE',
    requiredAction: 'OWNER_ACTION',
    ownerGatedAction: 'PRODUCTION_CREDENTIALS',
  },
  PROVIDER_SCHEMA_CHANGED: {
    severity: 'HIGH',
    riskClass: 'HIGH',
    retryEligibility: 'CODE_FIX_REQUIRED',
    requiredAction: 'CODE_REPAIR_CANDIDATE',
  },
  PARSER_FAILURE: {
    severity: 'MEDIUM',
    riskClass: 'MEDIUM',
    retryEligibility: 'CODE_FIX_REQUIRED',
    requiredAction: 'CODE_REPAIR_CANDIDATE',
  },
  WORKFLOW_PLANNING_ERROR: {
    severity: 'MEDIUM',
    riskClass: 'MEDIUM',
    retryEligibility: 'CODE_FIX_REQUIRED',
    requiredAction: 'CODE_REPAIR_CANDIDATE',
  },
  DATA_CONFLICT: {
    severity: 'MEDIUM',
    riskClass: 'MEDIUM',
    retryEligibility: 'NOT_RETRYABLE',
    requiredAction: 'INVESTIGATE',
  },
  DATABASE_TRANSACTION_ERROR: {
    severity: 'HIGH',
    riskClass: 'HIGH',
    retryEligibility: 'AUTO_RETRY_BACKOFF',
    requiredAction: 'AUTO_RECOVER',
  },
  RUNTIME_EXCEPTION: {
    severity: 'MEDIUM',
    riskClass: 'MEDIUM',
    retryEligibility: 'CODE_FIX_REQUIRED',
    requiredAction: 'CODE_REPAIR_CANDIDATE',
  },
  INTEGRATION_CONTRACT_MISMATCH: {
    severity: 'HIGH',
    riskClass: 'HIGH',
    retryEligibility: 'CODE_FIX_REQUIRED',
    requiredAction: 'CODE_REPAIR_CANDIDATE',
  },
  REGRESSION_FAILURE: {
    severity: 'MEDIUM',
    riskClass: 'MEDIUM',
    retryEligibility: 'CODE_FIX_REQUIRED',
    requiredAction: 'CODE_REPAIR_CANDIDATE',
  },
  UNKNOWN_ERROR: {
    severity: 'HIGH',
    riskClass: 'HIGH',
    retryEligibility: 'NEEDS_CLASSIFICATION',
    requiredAction: 'HUMAN_REVIEW',
  },
};

/** 触及安全 / 权限边界时**单向升级**：只允许更保守，不允许降级。 */
function escalateOutcome(base: FaultOutcome, observation: FaultObservation): FaultOutcome {
  if (observation.privilegeAffecting === true) {
    return {
      severity: 'HIGH',
      riskClass: 'HIGH',
      retryEligibility: 'NOT_RETRYABLE',
      requiredAction: 'HUMAN_REVIEW',
      ...(base.ownerGatedAction === undefined ? {} : { ownerGatedAction: base.ownerGatedAction }),
    };
  }
  if (observation.securityAffecting === true) {
    return {
      severity: base.severity === 'LOW' ? 'MEDIUM' : base.severity,
      riskClass: 'HIGH',
      retryEligibility: 'NOT_RETRYABLE',
      requiredAction: 'HUMAN_REVIEW',
      ...(base.ownerGatedAction === undefined ? {} : { ownerGatedAction: base.ownerGatedAction }),
    };
  }
  return base;
}

function normalizeEvidence(observation: FaultObservation): NormalizedEvidence {
  const codeCandidates = [
    observation.errorCode,
    observation.adapterErrorCode,
    observation.carrierReadErrorCode,
    observation.providerFailureReason,
  ];
  const code = codeCandidates.map(normalizeToken).find((candidate) => candidate !== '') ?? '';
  return {
    name: normalizeToken(observation.errorName),
    code,
    message: typeof observation.message === 'string' ? observation.message.toLowerCase() : '',
    status: typeof observation.httpStatus === 'number' ? observation.httpStatus : null,
    prismaCode: normalizeToken(observation.prismaCode),
    stage: normalizeToken(observation.stage),
  };
}

function fingerprint(parts: readonly (string | number | null)[]): string {
  return createHash('sha256')
    .update(parts.map((part) => (part === null ? '' : String(part))).join('\u0000'), 'utf8')
    .digest('hex')
    .slice(0, 16);
}

/**
 * 模型提示归档：**只记录，不采信**。
 * 即使模型声称的类别与确定性结论一致，`authority` 仍为 `NONE` —— 一致性不是授权。
 */
export function annotateUntrustedModelHint(
  hint: UntrustedModelHint | null | undefined,
  faultClass: FaultClass,
): ModelHintAnnotation | null {
  if (hint === null || hint === undefined) return null;
  const claimed = normalizeToken(hint.claimedClass);
  return {
    source: 'MODEL',
    authority: 'NONE',
    claimedClass: claimed === '' ? null : claimed,
    agreesWithDeterministicClass: claimed !== '' && claimed === faultClass,
    rationale: redactFaultText(hint.rationale, 200),
  };
}

/** 确定性分类：纯函数，同一观察必然得到同一结论。 */
export function classifyFault(observation: FaultObservation): FaultDiagnosis {
  const evidence = normalizeEvidence(observation);
  const rule = FAULT_RULES.find((candidate) => candidate.test(evidence)) ?? FAULT_RULES[FAULT_RULES.length - 1]!;
  const outcome = escalateOutcome(FAULT_OUTCOMES[rule.faultClass], observation);

  if (outcome.requiredAction === 'AUTO_RECOVER' && outcome.retryEligibility !== 'AUTO_RETRY_BACKOFF') {
    // 自我防护：两者不一致说明表被改坏了 —— fail-closed 到人工，而不是自动重试。
    return buildDiagnosis(rule, evidence, {
      ...outcome,
      retryEligibility: 'NOT_RETRYABLE',
      requiredAction: 'HUMAN_REVIEW',
    }, observation);
  }
  if (outcome.ownerGatedAction !== undefined && !requiresOwnerApproval(outcome.ownerGatedAction)) {
    return buildDiagnosis(rule, evidence, {
      ...outcome,
      requiredAction: 'HUMAN_REVIEW',
      retryEligibility: 'NOT_RETRYABLE',
    }, observation);
  }
  return buildDiagnosis(rule, evidence, outcome, observation);
}

function buildDiagnosis(
  rule: FaultRule,
  evidence: NormalizedEvidence,
  outcome: FaultOutcome,
  observation: FaultObservation,
): FaultDiagnosis {
  const summarized = redactFaultText(
    `${rule.faultClass}: ${observation.message ?? evidence.code ?? observation.errorName ?? rule.id}`,
  );
  const summary =
    summarized === ''
      ? `${rule.faultClass} in ${redactFaultText(observation.sourceModule, 80)}`
      : summarized;
  const dedupeKey = `${INTERNAL_FAULT_INCIDENT_KIND}:${rule.faultClass}:${redactFaultText(
    observation.sourceModule,
    80,
  )}:${fingerprint([
    rule.faultClass,
    observation.environment,
    redactFaultText(observation.sourceModule, 80),
    evidence.code,
    evidence.name,
    evidence.prismaCode,
    evidence.stage,
    evidence.status,
    summary,
  ])}`;

  return {
    faultClass: rule.faultClass,
    ruleId: rule.id,
    severity: outcome.severity,
    riskClass: outcome.riskClass,
    retryEligibility: outcome.retryEligibility,
    requiredAction: outcome.requiredAction,
    ownerGatedAction: outcome.ownerGatedAction ?? null,
    summary,
    dedupeKey,
    untrustedModelHint: annotateUntrustedModelHint(observation.modelHint, rule.faultClass),
  };
}

/** Incident 归档字段（`AutonomyIncident.sourceRefs`），全部已脱敏。 */
export interface FaultIncidentSourceRefs {
  classificationAuthority: 'DETERMINISTIC_RULES_ONLY';
  faultClass: FaultClass;
  ruleId: string;
  severity: FaultSeverity;
  retryEligibility: RetryEligibility;
  requiredAction: FaultRequiredAction;
  ownerGatedAction: RsiOwnerGatedAction | null;
  summary: string;
  errorCode: string | null;
  errorName: string | null;
  httpStatus: number | null;
  providerFailureReason: string | null;
  prismaCode: string | null;
  stage: string | null;
  sourceModule: string;
  environment: FaultEnvironment;
  organizationRef: string | null;
  providerRef: string | null;
  domain: string | null;
  affectedTaskRefs: readonly string[];
  evidenceRefs: readonly string[];
  occurrenceCount: number;
  detectedAt: string;
  untrustedModelHint: ModelHintAnnotation | null;
}

export interface FaultIncidentIntent {
  kind: typeof INTERNAL_FAULT_INCIDENT_KIND;
  dedupeKey: string;
  status: 'DIAGNOSED';
  riskClass: RsiRiskClass;
  sourceRefs: FaultIncidentSourceRefs;
  detectedAt: string;
}

function sanitizedRefList(values: readonly string[] | null | undefined, limit: number): readonly string[] {
  if (values === null || values === undefined) return [];
  return values
    .slice(0, limit)
    .map((value) => redactFaultText(value, 200))
    .filter((value) => value !== '');
}

function nullableRedacted(value: string | null | undefined, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const redacted = redactFaultText(value, maxLength);
  return redacted === '' ? null : redacted;
}

/**
 * 由观察构造**可信 Incident 意图**（纯函数，不落库）。
 * 组织 / 环境指纹只以不可逆引用落库；`occurrenceCount` 由持久化层原子累加。
 */
export function buildFaultIncidentIntent(
  observation: FaultObservation,
  options: { now?: Date } = {},
): { diagnosis: FaultDiagnosis; intent: FaultIncidentIntent } {
  const diagnosis = classifyFault(observation);
  const detectedAt = (options.now ?? new Date()).toISOString();
  const organizationRef =
    typeof observation.organizationRef === 'string' && observation.organizationRef.trim() !== ''
      ? opaqueRef('org', observation.organizationRef.trim())
      : null;
  const providerRef =
    typeof observation.providerRef === 'string' && observation.providerRef.trim() !== ''
      ? opaqueRef('provider', observation.providerRef.trim().toUpperCase())
      : null;

  const intent: FaultIncidentIntent = {
    kind: INTERNAL_FAULT_INCIDENT_KIND,
    dedupeKey: diagnosis.dedupeKey,
    status: 'DIAGNOSED',
    riskClass: diagnosis.riskClass,
    detectedAt,
    sourceRefs: {
      classificationAuthority: 'DETERMINISTIC_RULES_ONLY',
      faultClass: diagnosis.faultClass,
      ruleId: diagnosis.ruleId,
      severity: diagnosis.severity,
      retryEligibility: diagnosis.retryEligibility,
      requiredAction: diagnosis.requiredAction,
      ownerGatedAction: diagnosis.ownerGatedAction,
      summary: diagnosis.summary,
      errorCode: nullableRedacted(observation.errorCode, 80),
      errorName: nullableRedacted(observation.errorName, 80),
      httpStatus: typeof observation.httpStatus === 'number' ? observation.httpStatus : null,
      providerFailureReason: nullableRedacted(observation.providerFailureReason, 80),
      prismaCode: nullableRedacted(observation.prismaCode, 40),
      stage: nullableRedacted(observation.stage, 60),
      sourceModule: redactFaultText(observation.sourceModule, 120),
      environment: observation.environment,
      organizationRef,
      providerRef,
      domain: nullableRedacted(observation.domain, 60),
      affectedTaskRefs: sanitizedRefList(observation.taskRefs, 20),
      evidenceRefs: sanitizedRefList(observation.evidenceRefs, 20),
      occurrenceCount: typeof observation.occurrenceCount === 'number' ? observation.occurrenceCount : 1,
      detectedAt,
      untrustedModelHint: diagnosis.untrustedModelHint,
    },
  };
  return { diagnosis, intent };
}

/** 边界声明（供审计与源码级测试断言）。 */
export const FAULT_CLASSIFICATION_BOUNDARY = {
  pure: true,
  deterministicRulesOnly: true,
  modelMayClassify: false,
  modelMayGrantPermission: false,
  modelMayDeclareRootCauseVerified: false,
  redactsBeforePersistOrModel: true,
  unknownStaysUnknown: true,
  incidentKind: INTERNAL_FAULT_INCIDENT_KIND,
  customerExecutionKind: 'CUSTOMER_GOAL_QUEUE',
} as const;
