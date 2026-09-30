/**
 * ACTION GUARD — RUNTIME ENFORCEMENT（MSG-20260930-03 授权项 ②「RUNTIME BUSINESS BLOCKING」）
 * ---------------------------------------------------------------------------------------
 * 目标：让「生产危险动作」在真正执行前**必须**经过 Action Guard，并且：
 *   - 未满足 Production Gate / platform enablement / write 能力 → 直接拒绝；
 *   - 需要人工审批而缺 approvalId → 抛 REQUIRE_APPROVAL（不得静默继续）；
 *   - 能力状态不可用（端口异常 / 未返回快照）→ fail closed（DENY），不猜测、不放行；
 *   - 每次评估都写审计事件；**审计不可写时，ALLOW 降级为 DENY**（不可审计的动作不得执行）；
 *   - 错误码稳定（见 ACTION_GUARD_RUNTIME_CODES），供 route/job/service 统一处理。
 *
 * 边界：
 *   - 本模块**不读 env、不写库、不发外部请求**：能力快照与审计都通过注入端口提供。
 *   - 本模块不执行任何被保护动作，只做「是否允许」判定与抛错；
 *     service / route / job runner 必须调用 assertAllowed 后才能继续（禁止绕过）。
 *   - 生产启用、真实外写、资金动作、客户提交、生产凭据仍然 HOLD：
 *     即使闸门全部满足，真实外写也只在后续（另行授权的）启用阶段才会发生。
 */

import {
  buildActionGuardAuditEvent,
  evaluateActionGuard,
  type ActionGuardInput,
  type ActionGuardResult,
  type ActionRiskClass,
} from './action-guard';

export const ACTION_GUARD_RUNTIME_CODES = [
  'ACTION_GUARD_UNKNOWN_ACTION',
  'ACTION_GUARD_STATE_UNAVAILABLE',
  'ACTION_GUARD_REQUIREMENTS_NOT_MET',
  'ACTION_GUARD_HUMAN_APPROVAL_REQUIRED',
  'ACTION_GUARD_AUDIT_UNAVAILABLE',
  'ACTION_GUARD_ALLOWED',
] as const;
export type ActionGuardRuntimeCode = (typeof ACTION_GUARD_RUNTIME_CODES)[number];

/** 能力快照端口：返回值缺失或抛异常都按「状态不可用」处理（fail closed）。 */
export interface ActionGuardCapabilityPort {
  resolve(query: { organizationId: string; action: string }): Promise<ActionGuardInput['capabilities'] | undefined>;
}

export interface ActionGuardAuditRecord {
  action: 'action_guard.evaluated';
  actionName: string;
  decision: ActionGuardResult['decision'];
  code: string;
  risk: ActionRiskClass | 'UNKNOWN';
  actorUserId: string;
  organizationId: string;
  approvalId: string | null;
  reasonCodes: string[];
  evaluatedAt: string;
}

/** 审计端口：只负责持久化；实现方不得反向修改判定结果。 */
export interface ActionGuardAuditPort {
  write(record: ActionGuardAuditRecord): Promise<void> | void;
}

export interface RuntimeActionGuardDeps {
  capabilities: ActionGuardCapabilityPort;
  audit?: ActionGuardAuditPort;
  /** 注入时钟，便于测试；默认 new Date().toISOString() */
  now?: () => string;
}

export class ActionGuardError extends Error {
  readonly code: string;
  readonly action: string;
  readonly risk: ActionRiskClass | 'UNKNOWN';
  readonly reasons: string[];
  readonly decision: ActionGuardResult['decision'];

  constructor(result: ActionGuardResult) {
    super(`${result.code}: ${result.action}`);
    this.name = 'ActionGuardError';
    this.code = result.code;
    this.action = result.action;
    this.risk = result.risk;
    this.reasons = [...result.reasons];
    this.decision = result.decision;
  }
}

export class ActionGuardDeniedError extends ActionGuardError {
  constructor(result: ActionGuardResult) {
    super(result);
    this.name = 'ActionGuardDeniedError';
  }
}

export class ActionGuardApprovalRequiredError extends ActionGuardError {
  constructor(result: ActionGuardResult) {
    super(result);
    this.name = 'ActionGuardApprovalRequiredError';
  }
}

export interface RuntimeActionGuard {
  /** 只评估，不抛错（用于只读展示 / 运营面板 / 预检）。 */
  evaluate(input: ActionGuardInput): Promise<ActionGuardResult>;
  /** 强制执行：DENY → ActionGuardDeniedError；REQUIRE_APPROVAL → ActionGuardApprovalRequiredError。 */
  assertAllowed(input: ActionGuardInput): Promise<ActionGuardResult>;
}

export function createRuntimeActionGuard(deps: RuntimeActionGuardDeps): RuntimeActionGuard {
  if (!deps?.capabilities) throw new Error('ACTION_GUARD_MISSING_CAPABILITY_PORT');
  const now = deps.now ?? (() => new Date().toISOString());

  async function resolveCapabilities(input: ActionGuardInput) {
    try {
      const snapshot = await deps.capabilities.resolve({
        organizationId: String(input?.organizationId ?? ''),
        action: String(input?.action ?? ''),
      });
      return snapshot ?? undefined;
    } catch {
      // 端口异常等同于「状态不可用」：交给 evaluateActionGuard 返回 STATE_UNAVAILABLE / DENY
      return undefined;
    }
  }

  async function evaluate(input: ActionGuardInput): Promise<ActionGuardResult> {
    const capabilities = await resolveCapabilities(input);
    const result = evaluateActionGuard({ ...input, capabilities });
    return writeAudit(result, input.actorUserId, input.organizationId, input.approvalId);
  }

  /** 审计失败时：ALLOW 降级为 DENY（不可审计的动作不得执行）；其它判定保持不变。 */
  async function writeAudit(
    result: ActionGuardResult,
    actorUserId: string,
    organizationId: string,
    approvalId?: string,
  ): Promise<ActionGuardResult> {
    if (!deps.audit) {
      return result.decision === 'ALLOW'
        ? { ...result, decision: 'DENY', code: 'ACTION_GUARD_AUDIT_UNAVAILABLE', reasons: [...result.reasons, '审计端口缺失：不可审计的动作不得执行'] }
        : result;
    }
    const event = buildActionGuardAuditEvent(result, {
      action: result.action,
      actorUserId: actorUserId ?? '',
      organizationId: organizationId ?? '',
      approvalId,
    }) as unknown as Omit<ActionGuardAuditRecord, 'evaluatedAt'>;
    const record: ActionGuardAuditRecord = { ...event, evaluatedAt: now() };
    try {
      await deps.audit.write(record);
      return result;
    } catch {
      return result.decision === 'ALLOW'
        ? { ...result, decision: 'DENY', code: 'ACTION_GUARD_AUDIT_UNAVAILABLE', reasons: [...result.reasons, '审计写入失败：不可审计的动作不得执行'] }
        : result;
    }
  }

  async function assertAllowed(input: ActionGuardInput): Promise<ActionGuardResult> {
    const result = await evaluate(input);
    if (result.decision === 'DENY') throw new ActionGuardDeniedError(result);
    if (result.decision === 'REQUIRE_APPROVAL') throw new ActionGuardApprovalRequiredError(result);
    return result;
  }

  return { evaluate, assertAllowed };
}
