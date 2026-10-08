// AGENT EXPERIENCE LAYER / P1 — Goal 服务端验证（server truth + 白名单 + fail-closed）
// ---------------------------------------------------------------------------
// 编译器（或任何上游）的输出一律**未受信**：这里做最终判定。
// 语义：
//   * 形状 / 越权字段 → 立即拒绝（tenant 伪造 / 动作注入 / 服务注入 / 未知字段）；
//   * 枚举不在白名单 → 拒绝（未知一律不猜）；
//   * 域数量与 goal type 不匹配 → 拒绝；
//   * 时间窗口越界 → 夹紧到合法区间（确定性、可审计，不是「猜测意图」）；
//   * organization / actor **只**来自服务端上下文，草稿里出现即拒绝。
// 本层**不执行**任何动作，也不授予任何权限。

import { digestOf } from '../config-execution-durability/digests';
import {
  AGENT_GOAL_POLICY_VERSION,
  AGENT_GOAL_VERSION,
  AgentGoalError,
  GOAL_APPROVAL_CURRENCIES,
  GOAL_DOMAINS,
  GOAL_EXECUTION_MODES,
  GOAL_PROVIDERS,
  type GoalProvider,
  GOAL_MAX_MONTHS,
  GOAL_TIME_RANGE_KINDS,
  GOAL_TYPES,
  type AgentGoalDraft,
  type GoalDomain,
  type GoalExecutionMode,
  type GoalServerContext,
  type GoalTimeRange,
  type GoalType,
  type ValidatedAgentGoal,
} from './goal-contract';
import { checkGoalDraftShape, type GoalShapeReason } from './goal-schema';

const SHAPE_REASON_TO_CODE: Record<GoalShapeReason, ConstructorParameters<typeof AgentGoalError>[0]> = {
  NOT_AN_OBJECT: 'GOAL_MALFORMED',
  UNKNOWN_FIELD: 'GOAL_UNKNOWN_FIELD',
  TENANT_FORGED: 'GOAL_TENANT_FORGED',
  ACTION_INJECTION: 'GOAL_ACTION_INJECTION',
  SERVICE_INJECTION: 'GOAL_SERVICE_INJECTION',
  MISSING_FIELD: 'GOAL_MALFORMED',
  WRONG_TYPE: 'GOAL_MALFORMED',
};

function requireServerContext(context: GoalServerContext): void {
  if (
    typeof context?.organizationId !== 'string' ||
    context.organizationId.trim() === '' ||
    typeof context?.actorUserId !== 'string' ||
    context.actorUserId.trim() === ''
  ) {
    throw new AgentGoalError('GOAL_TENANT_CONTEXT_REQUIRED', 'Goal 必须由服务端上下文（organizationId / actorUserId）驱动。');
  }
}

/**
 * 时间窗口归一：确定性、有界，**不构成意图猜测，也不静默收缩**。
 * HISTORICAL_RECOVERY_SCAN_V1：
 *   · 1..GOAL_MAX_MONTHS 内原样接受；
 *   · **超过上限一律显式拒绝**（GOAL_TIME_RANGE_EXCEEDS_MAX）——未受信 draft 不得被静默夹紧；
 *   · 编译器对显式年数的夹紧是**可审计**的（matchedSignal = TIME:CLAMPED_TO_MAX）。
 */
function normalizeTimeRange(range: GoalTimeRange): GoalTimeRange {
  if (range.kind === 'LAST_N_MONTHS') {
    const raw = Number(range.months);
    if (!Number.isFinite(raw)) {
      throw new AgentGoalError('GOAL_UNSUPPORTED_TIME_RANGE', 'LAST_N_MONTHS 的 months 必须是有限数值。');
    }
    const truncated = Math.trunc(raw);
    if (truncated > GOAL_MAX_MONTHS) {
      throw new AgentGoalError(
        'GOAL_TIME_RANGE_EXCEEDS_MAX',
        'LAST_N_MONTHS 超过当前上限（' + GOAL_MAX_MONTHS + ' 个月）；不得静默收缩，请显式选择更小的范围。',
      );
    }
    return { kind: 'LAST_N_MONTHS', months: Math.max(1, truncated) };
  }
  return { kind: range.kind };
}

function assertGoalTypeShape(goalType: GoalType, domains: readonly GoalDomain[], executionMode: GoalExecutionMode): void {
  if (goalType === 'AUDIT_DOMAIN' && domains.length !== 1) {
    throw new AgentGoalError('GOAL_DOMAIN_COUNT_INVALID', 'AUDIT_DOMAIN 必须且只能指定 1 个域。');
  }
  if (goalType !== 'AUDIT_DOMAIN' && domains.length === 0) {
    throw new AgentGoalError('GOAL_DOMAIN_COUNT_INVALID', 'goal 至少需要 1 个域。');
  }
  // 只读型 goal 不得携带自动执行偏好（避免「只看」被静默升级为「自动处理」）
  const readOnlyType = goalType === 'REVIEW_ATTENTION' || goalType === 'DISCOVER_ONLY';
  if (readOnlyType && executionMode !== 'DISCOVER_ONLY') {
    throw new AgentGoalError(
      'GOAL_EXECUTION_MODE_NOT_ALLOWED_FOR_TYPE',
      `${goalType} 是只读型 goal，executionMode 必须为 DISCOVER_ONLY。`,
    );
  }
  if (!readOnlyType && executionMode === 'DISCOVER_ONLY') {
    throw new AgentGoalError(
      'GOAL_EXECUTION_MODE_NOT_ALLOWED_FOR_TYPE',
      `${goalType} 需要明确执行偏好（AUTO_WHEN_AUTHORIZED 或 REQUIRE_APPROVAL_EACH）。`,
    );
  }
}

/**
 * 服务端验证：未受信草稿 → `ValidatedAgentGoal`。
 * 任何越权 / 未知 / 畸形输入一律抛 `AgentGoalError`（fail-closed，绝不部分接受）。
 */
export function validateAgentGoalDraft(input: {
  draft: unknown;
  context: GoalServerContext;
}): ValidatedAgentGoal {
  requireServerContext(input.context);

  const shape = checkGoalDraftShape(input.draft);
  if (!shape.ok) {
    throw new AgentGoalError(SHAPE_REASON_TO_CODE[shape.reason], 'Goal 校验失败：' + shape.detail);
  }
  const draft = input.draft as AgentGoalDraft;

  if (!(GOAL_TYPES as readonly string[]).includes(draft.goalType)) {
    throw new AgentGoalError('GOAL_UNSUPPORTED_GOAL_TYPE', '未知 goalType：' + String(draft.goalType));
  }
  for (const domain of draft.domains) {
    if (!(GOAL_DOMAINS as readonly string[]).includes(domain)) {
      throw new AgentGoalError('GOAL_UNSUPPORTED_DOMAIN', '未知 domain：' + String(domain));
    }
  }
  if (!(GOAL_EXECUTION_MODES as readonly string[]).includes(draft.executionMode)) {
    throw new AgentGoalError('GOAL_UNSUPPORTED_EXECUTION_MODE', '未知 executionMode：' + String(draft.executionMode));
  }
  if (!(GOAL_TIME_RANGE_KINDS as readonly string[]).includes(draft.timeRange.kind)) {
    throw new AgentGoalError('GOAL_UNSUPPORTED_TIME_RANGE', '未知 timeRange kind：' + String(draft.timeRange.kind));
  }

  const domains = [...new Set(draft.domains)].sort() as GoalDomain[];
  const timeRange = normalizeTimeRange(draft.timeRange);
  assertGoalTypeShape(draft.goalType, domains, draft.executionMode);

  let approvalThreshold = draft.approvalThreshold ?? null;
  if (approvalThreshold !== null) {
    if (!(GOAL_APPROVAL_CURRENCIES as readonly string[]).includes(approvalThreshold.currency)) {
      throw new AgentGoalError('GOAL_MALFORMED', 'v1 仅支持 USD 口径的自动执行金额上限。');
    }
    if (!Number.isFinite(approvalThreshold.amount) || approvalThreshold.amount < 0) {
      throw new AgentGoalError('GOAL_MALFORMED', 'approvalThreshold.amount 必须是非负有限数值。');
    }
    approvalThreshold = { currency: approvalThreshold.currency, amount: approvalThreshold.amount };
  }

  // FINAL4：provider 意图是白名单内的确定性事实，并冻结进 goal identity（digest 的一部分）
  const providers = [
    ...new Set((Array.isArray(draft.providers) ? draft.providers : []).map((p) => String(p).toUpperCase())),
  ].sort() as GoalProvider[];
  for (const provider of providers) {
    if (!(GOAL_PROVIDERS as readonly string[]).includes(provider)) {
      throw new AgentGoalError('GOAL_MALFORMED', '未知 provider 意图：' + provider);
    }
  }

  const goalDigest = digestOf({
    version: AGENT_GOAL_VERSION,
    goalType: draft.goalType,
    providers,
    domains,
    timeRange,
    executionMode: draft.executionMode,
    approvalThreshold,
  });

  return {
    kind: 'VALIDATED_AGENT_GOAL',
    version: AGENT_GOAL_VERSION,
    policyVersion: AGENT_GOAL_POLICY_VERSION,
    goalId: 'goal-' + goalDigest.slice(0, 24),
    organizationId: input.context.organizationId,
    actorUserId: input.context.actorUserId,
    goalType: draft.goalType,
    domains,
    providers,
    timeRange,
    executionMode: draft.executionMode,
    approvalThresholdPreference: approvalThreshold,
    requiresStandingAuthorizationForAutoExecution: draft.executionMode === 'AUTO_WHEN_AUTHORIZED',
    grantsPermissions: false,
    externalWriteGranted: false,
    validatedAt: input.context.now.toISOString(),
    goalDigest,
  };
}

/** 边界断言：goal 永远不得成为权限 / 外写来源 */
export function assertGoalGrantsNothing(goal: {
  grantsPermissions?: boolean;
  externalWriteGranted?: boolean;
}): void {
  if (goal.grantsPermissions === true || goal.externalWriteGranted === true) {
    throw new AgentGoalError('GOAL_MALFORMED', 'Goal 不得授予任何权限或外部写能力。');
  }
}

export const GOAL_VALIDATOR_BOUNDARY = {
  draftIsUntrusted: true,
  serverContextRequired: true,
  tenantFromServerOnly: true,
  unknownIsRejectedNotGuessed: true,
  readOnlyGoalsCannotRequestAutoExecution: true,
  timeRangeClampedDeterministically: true,
  grantsPermissions: false,
  executesActions: false,
} as const;
