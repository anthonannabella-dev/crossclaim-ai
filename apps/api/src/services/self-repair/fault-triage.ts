/**
 * INTERNAL CODE REPAIR V1 / PHASE 2 —— 确定性故障分流（安全范围）
 * ---------------------------------------------------------------
 * 授权依据：MSG-20261009-08 —— `PHASE2_IMPLEMENTATION_AUTHORIZED = YES_SAFE_SCOPE_ONLY`，边界为：
 *   · 复用 **ONE SI Runtime**（本模块不新增 Scheduler / Controller / 第二个执行器，**不执行任何业务动作**）；
 *   · 以**可信 Incident 与既有持久化事实**为输入做确定性分流；
 *   · 把 `RECONCILE_FIRST` / `FORBIDDEN` / `NEEDS_CLASSIFICATION` 分别映射到明确的安全路径；
 *   · **不得**因 PHASE 1 的 `AUTO_RECOVER` 分类结果直接执行外部业务写入；
 *   · 不得绕过既有租户认证、Incident kind、生命周期与可信事实来源（GATE-2/3）。
 *
 * 本模块是**纯函数**：输入 = 已持久化的 INTERNAL_FAULT 载荷 + 服务端可信事实复核结果；
 * 输出 = 分流结论（含原因码、待办动作、对账要求与逐项检查结果）。任何执行仍由既有运行时路径负责。
 */

import { RSI_OWNER_GATED_ACTIONS } from '../autonomy/rsi-lifecycle';

import {
  FAULT_CLASSES,
  FAULT_IDEMPOTENCY_GUARANTEES,
  FAULT_OPERATION_KINDS,
  FAULT_REQUIRED_ACTIONS,
  INTERNAL_FAULT_INCIDENT_KIND,
  REPLAY_DISPOSITIONS,
} from './fault-classification';

export const TRIAGE_DISPOSITIONS = [
  /** A：可恢复业务故障 —— **只是把候选交回既有 ONE SI Runtime**（本层不执行动作）。 */
  'AUTO_RECOVER_VIA_RUNTIME',
  /** 先对账：副作用状态不明，禁止直接重放。 */
  'RECONCILE',
  /** B：可复现缺陷 —— 交 PHASE 3 修复代理（尚未实现；本层只登记候选）。 */
  'CODE_REPAIR_CANDIDATE',
  /** C：需外部权限 / 人工 —— BLOCK。 */
  'BLOCK_HUMAN_REVIEW',
  /** 未分类故障 —— 默认禁止自动恢复。 */
  'NEEDS_CLASSIFICATION',
] as const;
export type TriageDisposition = (typeof TRIAGE_DISPOSITIONS)[number];

/**
 * MSG-20261009-09 / CHANGE 3 —— **可信事实来源契约**。
 * 三个可信事实各自只允许一个来源；请求参数 / 客户端输入 / 模型输出 **一律禁止**。
 * 该契约可执行：任何适配器都必须声明来源，声明违规即在**接线时**失败（而不是运行期悄悄放行）。
 */
export const TRUSTED_FACT_SOURCE_KINDS = [
  'TRUSTED_PERSISTED_IDENTITY',
  'SERVER_AUTHORIZATION_STATE',
  'TRUSTED_EXECUTION_CONTEXT',
  'REQUEST_PARAM',
  'CLIENT_INPUT',
  'MODEL_OUTPUT',
  'UNKNOWN',
] as const;
export type TrustedFactSourceKind = (typeof TRUSTED_FACT_SOURCE_KINDS)[number];

/** 禁止作为可信事实来源的种类（含 `UNKNOWN`：未声明即不可信）。 */
export const FORBIDDEN_TRUSTED_FACT_SOURCES = [
  'REQUEST_PARAM',
  'CLIENT_INPUT',
  'MODEL_OUTPUT',
  'UNKNOWN',
] as const;

/** 每个可信事实的**唯一允许来源**。 */
export const TRUSTED_FACT_SOURCE_REQUIREMENTS = {
  /** 租户身份必须来自可信持久化身份关系（不是请求里的 organizationId）。 */
  organizationIdResolved: 'TRUSTED_PERSISTED_IDENTITY',
  /** 授权状态必须来自服务端当前授权状态（重新解析，而非调用方自报）。 */
  authorizationActive: 'SERVER_AUTHORIZATION_STATE',
  /** 操作复核必须来自可信执行上下文（只读 / 幂等未生效的再次确认）。 */
  operationRecheck: 'TRUSTED_EXECUTION_CONTEXT',
} as const;

export interface TrustedFactSourceDeclaration {
  organizationIdResolved: TrustedFactSourceKind;
  authorizationActive: TrustedFactSourceKind;
  operationRecheck: TrustedFactSourceKind;
}

/** 契约校验：返回违规字段清单（空数组 = 合法）。 */
export function assertTrustedFactSources(
  declaration: Partial<Record<keyof TrustedFactSourceDeclaration, TrustedFactSourceKind>>,
): { ok: true } | { ok: false; reason: 'FORBIDDEN_TRUSTED_FACT_SOURCE' | 'SOURCE_MISMATCH'; offending: readonly string[] } {
  const forbidden = FORBIDDEN_TRUSTED_FACT_SOURCES as readonly string[];
  const offenders: string[] = [];
  let reason: 'FORBIDDEN_TRUSTED_FACT_SOURCE' | 'SOURCE_MISMATCH' = 'SOURCE_MISMATCH';
  for (const fact of Object.keys(TRUSTED_FACT_SOURCE_REQUIREMENTS) as (keyof TrustedFactSourceDeclaration)[]) {
    const declared = declaration[fact];
    if (declared === undefined) {
      offenders.push(`${fact}:NOT_DECLARED`);
      reason = 'FORBIDDEN_TRUSTED_FACT_SOURCE';
      continue;
    }
    if (forbidden.includes(declared)) {
      offenders.push(`${fact}:${declared}`);
      reason = 'FORBIDDEN_TRUSTED_FACT_SOURCE';
      continue;
    }
    if (declared !== TRUSTED_FACT_SOURCE_REQUIREMENTS[fact]) {
      offenders.push(`${fact}:${declared}`);
    }
  }
  if (offenders.length > 0) return { ok: false, reason, offending: offenders };
  return { ok: true };
}

/** 契约违规错误（接线期抛出，属于 fail-closed）。 */
export class TrustedFactSourceContractError extends Error {
  readonly offending: readonly string[];

  constructor(reason: string, offending: readonly string[]) {
    super(`TRUSTED_FACTS_SOURCE_CONTRACT_VIOLATION:${reason}:${offending.join(',')}`);
    this.name = 'TrustedFactSourceContractError';
    this.offending = offending;
  }
}

/**
 * 可信事实解析器的**唯一推荐构造方式**：绑定来源声明并在创建时校验。
 * 生产接线必须经由本函数（契约测试会断言：违规声明在创建时即抛错）。
 */
export function defineTrustedFactsResolver(
  declaration: TrustedFactSourceDeclaration,
  resolver: (incident: { id: string; sourceRefs: unknown }) => Promise<TriageTrustedFacts>,
): {
  readonly trustedFactSources: TrustedFactSourceDeclaration;
  readonly resolveTrustedFacts: (incident: { id: string; sourceRefs: unknown }) => Promise<TriageTrustedFacts>;
} {
  const check = assertTrustedFactSources(declaration);
  if (!check.ok) throw new TrustedFactSourceContractError(check.reason, check.offending);
  return { trustedFactSources: declaration, resolveTrustedFacts: resolver };
}

/** 契约登记（供文档与测试逐项核对）。 */
export const TRIAGE_TRUSTED_FACT_CONTRACT = {
  requiresDeclarationPerAdapter: true,
  verifiesAtWiringTime: true,
  forbiddenSources: FORBIDDEN_TRUSTED_FACT_SOURCES,
  requirements: TRUSTED_FACT_SOURCE_REQUIREMENTS,
  /** 分流结果是**快照**：未来运行时不得无条件信任，必须自行复核。 */
  snapshotNotAuthorization: true,
  /**
   * MSG-20261009-10 / CHANGE 5 —— **声明不是运行时授权**：
   * 来源声明只约束解析器**配置**；PHASE 3 必须通过受信服务端适配器取得事实，并在执行前**重新读取与校验**；
   * 禁止以声明对象、登记快照或模型输出代替授权。
   */
  declarationIsNotAuthorization: true,
  /** MSG-20261009-10 / CHANGE 6 —— 本层**没有**可验证的运行时来源真实性隔离（如实登记，不虚报）。 */
  runtimeSourceIsolationImplemented: false,
  phase3ImplementationPrerequisite: 'TRUSTED_ADAPTER_SOURCE_PROVENANCE_EXECUTION_TIME_RECHECK',
} as const;

/** PHASE 1 允许自动恢复的确定性可重试类别（与分类模块的白名单一致）。 */
const AUTO_RECOVER_FAULT_CLASSES = ['API_TIMEOUT', 'API_RATE_LIMIT', 'DATABASE_TRANSACTION_ERROR'] as const;

/** 只允许在**确认无副作用**的前提下重放的操作类型。 */
const REPLAYABLE_OPERATION_KINDS = ['READ_ONLY', 'MUTATING'] as const;

/** 服务端可信事实复核（**不得**来自请求参数 / 客户端输入 / 模型输出）。 */
export interface TriageTrustedFacts {
  /** 该 Incident 的租户身份是否已由可信库解析（有 organizationRef 时必填 true）。 */
  organizationIdResolved: boolean;
  /** 该组织当前是否存在未撤销、未过期的长期授权（服务端重新解析结果）。 */
  authorizationActive: boolean;
  /**
   * 运行时对「操作 / 幂等 / 副作用」的**再次确认**结果（不能只信落库时的声明）：
   *   · CONFIRMED_READ_ONLY —— 已确认是只读操作；
   *   · CONFIRMED_IDEMPOTENT_NOT_APPLIED —— 已确认可变操作未生效且具可信幂等；
   *   · NOT_CONFIRMED —— 未能确认（fail-closed）。
   */
  operationRecheck: 'CONFIRMED_READ_ONLY' | 'CONFIRMED_IDEMPOTENT_NOT_APPLIED' | 'NOT_CONFIRMED';
}

export interface PersistedFaultIncidentRow {
  id: string;
  kind: string;
  dedupeKey: string;
  status: string;
  riskClass: string;
  sourceRefs: unknown;
}

export interface FaultTriageInput {
  incident: PersistedFaultIncidentRow;
  trusted: TriageTrustedFacts;
}

export interface FaultTriageDecision {
  incidentId: string;
  disposition: TriageDisposition;
  /** 原因码（稳定、可断言、可审计）。 */
  reason: string;
  /** true 仅表示「**可交回**既有运行时再校验」，**不是**动作执行授权。 */
  runtimeHandoffAuthorized: boolean;
  /** 需要人工 / OWNER 时给出待办动作（OWNER 动作取自既有 OWNER-gated 清单）。 */
  requiredHumanAction: string | null;
  /** 对账要求（RECONCILE 时非空）。 */
  reconciliationRequirement: string | null;
  /** 逐项前置检查结果（供审计核对，失败项即为 reason 的来源）。 */
  checks: readonly { id: string; ok: boolean }[];
}

const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const bool = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);
const inSet = (value: string, set: readonly string[]): boolean => set.includes(value);

interface ParsedPayload {
  classificationAuthority: string;
  faultClass: string;
  requiredAction: string;
  ownerGatedAction: string | null;
  replayDisposition: string;
  requiresReconciliation: boolean;
  autoRecoverAuthorized: boolean;
  escalatedBySecuritySignal: boolean;
  operationKind: string;
  organizationRef: string | null;
}

/** 严格解析：任何字段缺失 / 类型不符 / 授权来源不符 ⇒ fail-closed（不猜、不补默认值）。 */
export function parsePersistedFaultPayload(
  sourceRefs: unknown,
): { ok: true; payload: ParsedPayload } | { ok: false; reason: string } {
  if (typeof sourceRefs !== 'object' || sourceRefs === null || Array.isArray(sourceRefs)) {
    return { ok: false, reason: 'SOURCE_REFS_NOT_WHITELISTED_OBJECT' };
  }
  const raw = sourceRefs as Record<string, unknown>;
  const classificationAuthority = str(raw.classificationAuthority);
  const faultClass = str(raw.faultClass);
  const requiredAction = str(raw.requiredAction);
  const replayDisposition = str(raw.replayDisposition);
  const operationKind = str(raw.operationKind);
  const requiresReconciliation = bool(raw.requiresReconciliation);
  const autoRecoverAuthorized = bool(raw.autoRecoverAuthorized);
  const escalatedBySecuritySignal = bool(raw.escalatedBySecuritySignal);
  const ownerGatedAction = raw.ownerGatedAction === null ? null : str(raw.ownerGatedAction);
  const organizationRef = raw.organizationRef === null ? null : str(raw.organizationRef);

  if (classificationAuthority !== 'DETERMINISTIC_RULES_ONLY') {
    return { ok: false, reason: 'CLASSIFICATION_AUTHORITY_NOT_DETERMINISTIC' };
  }
  if (faultClass === null || requiredAction === null || replayDisposition === null || operationKind === null) {
    return { ok: false, reason: 'PAYLOAD_INCOMPLETE' };
  }
  if (requiresReconciliation === null || autoRecoverAuthorized === null || escalatedBySecuritySignal === null) {
    return { ok: false, reason: 'PAYLOAD_INCOMPLETE' };
  }
  /**
   * MSG-20261009-09 / CHANGE 1（GATE-5 负向验收）—— **值域校验**：
   * 所有枚举字段必须落在既有封闭值域内；否则整条载荷 fail-closed。
   * 这样「被篡改成携带任意文本」的字段既不会被当作语义使用，也不会经由返回值 / 登记字段外泄
   * （例如对账要求文本会拼接 `faultClass:operationKind`，值域校验后不可能夹带自由文本）。
   */
  if (!inSet(faultClass, FAULT_CLASSES)) return { ok: false, reason: 'PAYLOAD_VALUE_NOT_CANONICAL' };
  if (!inSet(requiredAction, FAULT_REQUIRED_ACTIONS)) return { ok: false, reason: 'PAYLOAD_VALUE_NOT_CANONICAL' };
  if (!inSet(replayDisposition, REPLAY_DISPOSITIONS)) return { ok: false, reason: 'PAYLOAD_VALUE_NOT_CANONICAL' };
  if (!inSet(operationKind, FAULT_OPERATION_KINDS)) return { ok: false, reason: 'PAYLOAD_VALUE_NOT_CANONICAL' };
  const idempotencyGuarantee = str(raw.idempotencyGuarantee);
  if (idempotencyGuarantee === null || !inSet(idempotencyGuarantee, FAULT_IDEMPOTENCY_GUARANTEES)) {
    return { ok: false, reason: 'PAYLOAD_VALUE_NOT_CANONICAL' };
  }
  if (ownerGatedAction !== null && !inSet(ownerGatedAction, RSI_OWNER_GATED_ACTIONS)) {
    return { ok: false, reason: 'PAYLOAD_VALUE_NOT_CANONICAL' };
  }
  return {
    ok: true,
    payload: {
      classificationAuthority,
      faultClass,
      requiredAction,
      ownerGatedAction,
      replayDisposition,
      requiresReconciliation,
      autoRecoverAuthorized,
      escalatedBySecuritySignal,
      operationKind,
      organizationRef,
    },
  };
}

const block = (
  incidentId: string,
  reason: string,
  checks: readonly { id: string; ok: boolean }[],
  requiredHumanAction: string | null = null,
): FaultTriageDecision => ({
  incidentId,
  disposition: 'BLOCK_HUMAN_REVIEW',
  reason,
  runtimeHandoffAuthorized: false,
  requiredHumanAction,
  reconciliationRequirement: null,
  checks,
});

/**
 * 确定性分流：**先结构、再安全、后动作**。任一步不满足即 fail-closed 到 BLOCK / 对账 / 人工，
 * 绝不因「看起来像可重试」而放行任何执行。
 */
export function triageFaultIncident(input: FaultTriageInput): FaultTriageDecision {
  const { incident, trusted } = input;
  const id = incident.id;
  const checks: { id: string; ok: boolean }[] = [];
  const record = (checkId: string, ok: boolean): boolean => {
    checks.push({ id: checkId, ok });
    return ok;
  };

  // ① 结构 / 容器 / 生命周期（GATE-2：不得绕过 kind 与生命周期）
  if (!record('INCIDENT_KIND_INTERNAL_FAULT', incident.kind === INTERNAL_FAULT_INCIDENT_KIND)) {
    return block(id, 'INCIDENT_KIND_NOT_INTERNAL_FAULT', checks);
  }
  if (!record('INCIDENT_STATUS_DIAGNOSED', incident.status === 'DIAGNOSED')) {
    return block(id, 'INCIDENT_NOT_DIAGNOSED', checks);
  }
  const parsed = parsePersistedFaultPayload(incident.sourceRefs);
  if (!parsed.ok) {
    record('PAYLOAD_WHITELISTED_AND_COMPLETE', false);
    return block(id, parsed.reason, checks);
  }
  const payload = parsed.payload;
  record('PAYLOAD_WHITELISTED_AND_COMPLETE', true);
  record('CLASSIFICATION_DETERMINISTIC', true);

  // ② 安全 / 权限信号与 OWNER-gated 动作：任何情况下都不得自动恢复
  if (!record('NO_SECURITY_OR_PRIVILEGE_SIGNAL', payload.escalatedBySecuritySignal === false)) {
    return block(id, 'SECURITY_OR_PRIVILEGE_SIGNAL', checks);
  }
  if (!record('NO_OWNER_GATED_ACTION', payload.ownerGatedAction === null)) {
    return block(id, 'OWNER_GATED_ACTION_REQUIRES_OWNER', checks, payload.ownerGatedAction);
  }
  if (payload.requiredAction === 'OWNER_ACTION') {
    record('NO_OWNER_GATED_ACTION', false);
    return block(id, 'REQUIRED_ACTION_OWNER_ACTION', checks, payload.ownerGatedAction);
  }

  // ③ 未分类 ⇒ 人工（默认禁止自动恢复）
  if (payload.replayDisposition === 'NEEDS_CLASSIFICATION') {
    return {
      incidentId: id,
      disposition: 'NEEDS_CLASSIFICATION',
      reason: 'FAULT_UNCLASSIFIED',
      runtimeHandoffAuthorized: false,
      requiredHumanAction: null,
      reconciliationRequirement: null,
      checks,
    };
  }

  // ④ 先对账：副作用状态不明 / 外部写 ⇒ 禁止直接重放
  if (payload.replayDisposition === 'RECONCILE_FIRST' || payload.requiresReconciliation) {
    return {
      incidentId: id,
      disposition: 'RECONCILE',
      reason: 'RECONCILE_BEFORE_ANY_REPLAY',
      runtimeHandoffAuthorized: false,
      requiredHumanAction: null,
      reconciliationRequirement: `${payload.faultClass}:${payload.operationKind} 需先完成副作用对账，禁止直接重放`,
      checks,
    };
  }

  // ⑤ FORBIDDEN：可修缺陷走修复候选，其余人工
  if (payload.replayDisposition === 'FORBIDDEN') {
    if (payload.requiredAction === 'CODE_REPAIR_CANDIDATE') {
      return {
        incidentId: id,
        disposition: 'CODE_REPAIR_CANDIDATE',
        reason: 'CODE_FIX_REQUIRED',
        runtimeHandoffAuthorized: false,
        requiredHumanAction: null,
        reconciliationRequirement: null,
        checks,
      };
    }
    return block(id, 'REPLAY_FORBIDDEN', checks);
  }

  // ⑥ A 路径：仅当 PHASE 1 给出显式重放授权 **且** 服务端可信事实复核通过
  if (!record('PHASE1_AUTO_RECOVER_AUTHORIZED', payload.autoRecoverAuthorized === true)) {
    return block(id, 'NO_REPLAY_AUTHORIZATION_FROM_CLASSIFIER', checks);
  }
  if (!record('FAULT_CLASS_IN_RETRY_WHITELIST', (AUTO_RECOVER_FAULT_CLASSES as readonly string[]).includes(payload.faultClass))) {
    return block(id, 'FAULT_CLASS_NOT_RETRYABLE', checks);
  }
  // 外部写永远不进入自动恢复（PHASE 1 应已映射为 RECONCILE，这里是纵深防御）
  if (!record('OPERATION_NOT_EXTERNAL_WRITE', payload.operationKind !== 'EXTERNAL_WRITE')) {
    return block(id, 'EXTERNAL_WRITE_ALWAYS_HOLD', checks);
  }
  if (!record('OPERATION_KIND_REPLAYABLE', (REPLAYABLE_OPERATION_KINDS as readonly string[]).includes(payload.operationKind))) {
    return block(id, 'OPERATION_KIND_NOT_REPLAYABLE', checks);
  }
  // 租户维度：有组织引用就必须已由可信库解析
  if (!record('TENANT_IDENTITY_TRUSTED', payload.organizationRef === null || trusted.organizationIdResolved)) {
    return block(id, 'TENANT_CONTEXT_NOT_TRUSTED', checks);
  }
  if (!record('AUTHORIZATION_ACTIVE', trusted.authorizationActive)) {
    return block(id, 'AUTHORIZATION_NOT_ACTIVE', checks);
  }
  // 运行时复核：不能只信落库声明（GATE-3）
  const recheckOk =
    (payload.operationKind === 'READ_ONLY' && trusted.operationRecheck === 'CONFIRMED_READ_ONLY') ||
    (payload.operationKind === 'MUTATING' && trusted.operationRecheck === 'CONFIRMED_IDEMPOTENT_NOT_APPLIED');
  if (!record('RUNTIME_RECHECK_CONFIRMS_REPLAY_SAFETY', recheckOk)) {
    return block(id, 'RUNTIME_RECHECK_NOT_CONFIRMED', checks);
  }

  /**
   * A 路径**仍不执行任何动作**：只把候选交回既有 ONE SI Runtime，
   * 由它按既有路径再次校验（授权重解析 / 租约 / fencing / Action Guard / 外写 HOLD）。
   */
  return {
    incidentId: id,
    disposition: 'AUTO_RECOVER_VIA_RUNTIME',
    reason: 'HANDOFF_TO_EXISTING_RUNTIME',
    runtimeHandoffAuthorized: true,
    requiredHumanAction: null,
    reconciliationRequirement: null,
    checks,
  };
}

/** 边界声明（供审计与源码级测试断言）。 */
export const FAULT_TRIAGE_BOUNDARY = {
  pure: true,
  executesNothing: true,
  reusesOneSiRuntimeOnly: true,
  createsSchedulerOrController: false,
  requiresTrustedServerFacts: true,
  externalWriteAlwaysHold: true,
  failClosedOnMalformedPayload: true,
  validatesPayloadValueDomains: true,
  requiresRuntimeRecheck: true,
  autoRecoverIsNotExecutionAuthorization: true,
  phase3RepairAgentImplemented: false,
} as const;
