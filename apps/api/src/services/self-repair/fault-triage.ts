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

import { INTERNAL_FAULT_INCIDENT_KIND } from './fault-classification';

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
  requiresRuntimeRecheck: true,
  autoRecoverIsNotExecutionAuthorization: true,
  phase3RepairAgentImplemented: false,
} as const;
