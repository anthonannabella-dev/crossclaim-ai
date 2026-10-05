/**
 * RSI / CrossClaim SI —— Cheap → Strong 质量门与有界升级契约（C1，零 Schema）
 * ---------------------------------------------------------------
 * 授权：MSG-20261005-30（3.4/3.5 = A；C1 必测含「cheap PASS 不调用 strong」、
 *      「cheap quality FAIL 最多一次受控 escalation」、「maxAttempt / maxEscalation 生效」、「no recursive model loop」）。
 *
 * 严格路径：
 *   LOW_COST → schema validation → deterministic evaluator → quality threshold
 *     PASS → STOP（不得调用 strong）
 *     FAIL / LOW_CONFIDENCE → bounded escalation → STRONG MODEL（最多 maxEscalations 次）
 *   禁止 cheap → retry → cheap → retry → strong → retry → strong ... 形式无限循环；
 *   **LLM Judge 不得自行批准再次调用 LLM**（judge 结论只作为质量输入，不能作为升级授权）。
 */

export const AI_QUALITY_VERDICTS = ['PASS', 'FAIL', 'LOW_CONFIDENCE'] as const;
export type AiQualityVerdict = (typeof AI_QUALITY_VERDICTS)[number];

export type AiModelTier = 'LOW_COST' | 'STRONG';

export interface AiEscalationLimits {
  maxAttempts: number;
  maxEscalations: number;
}

/** 固定上限（不得由调用方放大；如需调整必须走架构裁决） */
export const AI_ESCALATION_DEFAULTS: AiEscalationLimits = { maxAttempts: 2, maxEscalations: 1 };

/** 硬上限（CHANGE B：任何配置都不得放大） */
export const AI_ESCALATION_HARD_CAPS: AiEscalationLimits = { maxAttempts: 2, maxEscalations: 1 };

/**
 * 把请求的上限钳制到硬上限内：`effective = min(requested, hardCap)`。
 * 任何试图放大（例如 999/999）的配置都会被压回 2/1，并在 `clamped` 中如实报告。
 */
export function clampAiEscalationLimits(requested?: Partial<AiEscalationLimits> | null): {
  effective: AiEscalationLimits;
  clamped: boolean;
} {
  const askedAttempts = typeof requested?.maxAttempts === 'number' && Number.isFinite(requested.maxAttempts) ? requested.maxAttempts : AI_ESCALATION_HARD_CAPS.maxAttempts;
  const askedEscalations = typeof requested?.maxEscalations === 'number' && Number.isFinite(requested.maxEscalations) ? requested.maxEscalations : AI_ESCALATION_HARD_CAPS.maxEscalations;
  const effective: AiEscalationLimits = {
    maxAttempts: Math.max(1, Math.min(askedAttempts, AI_ESCALATION_HARD_CAPS.maxAttempts)),
    maxEscalations: Math.max(0, Math.min(askedEscalations, AI_ESCALATION_HARD_CAPS.maxEscalations)),
  };
  return {
    effective,
    clamped: effective.maxAttempts !== askedAttempts || effective.maxEscalations !== askedEscalations,
  };
}

export const AI_ESCALATION_BOUNDARY = {
  cheapPassCallsStrong: false,
  escalationRequiresQualityFailure: true,
  escalationAuthorizationProvenance: 'SERVER_SIDE_DETERMINISTIC_EVALUATOR_ONLY（caller 自报 quality/state 不构成授权）',
  judgeMayAuthorizeModelCall: false,
  judgeVerdictIsQualityInputOnly: true,
  maxAttempts: AI_ESCALATION_DEFAULTS.maxAttempts,
  maxEscalations: AI_ESCALATION_DEFAULTS.maxEscalations,
  recursiveModelLoop: 'FORBIDDEN',
  providerHttp200ImpliesQuality: false,
  hostMayRaiseHardCaps: false,
} as const;

export interface AiEscalationState {
  /** 本任务已发生的 provider attempt 总数（含失败） */
  attempts: number;
  /** 本任务已发生的 LOW_COST → STRONG 升级次数 */
  escalations: number;
}

export type AiEscalationAction =
  | 'STOP_PASS'
  | 'ESCALATE_TO_STRONG'
  | 'STOP_STRONG_ACCEPTED'
  | 'STOP_FAILED'
  | 'STOP_BOUNDED';

export interface AiEscalationDecision {
  action: AiEscalationAction;
  reason: string;
  /** 是否允许本次调用使用 STRONG tier */
  allowStrongCall: boolean;
  /** 是否允许再次调用 provider（false = 必须停止） */
  allowAnotherCall: boolean;
  notes: readonly string[];
}

/**
 * 升级判定（纯函数）：
 *   · PASS → STOP（无论 tier；strong 已在用则接受其结果）；
 *   · STRONG 仍未通过 → STOP_FAILED（不再升级/重试）；
 *   · LOW_COST 未通过 → 仅在 attempts/escalations 未触顶时允许**一次**受控升级；
 *   · `judgeAuthorizedMoreCalls` **被忽略**（judge 不得授权模型调用）。
 */
export function decideAiEscalation(input: {
  currentTier: AiModelTier;
  quality: AiQualityVerdict;
  state: AiEscalationState;
  limits?: AiEscalationLimits;
  /** 若为 true 也必须被忽略；仅用于审计提示 */
  judgeAuthorizedMoreCalls?: boolean;
}): AiEscalationDecision {
  const limits = input.limits ?? AI_ESCALATION_DEFAULTS;
  const notes: string[] = [];
  if (input.judgeAuthorizedMoreCalls === true) {
    notes.push('JUDGE_AUTHORIZATION_IGNORED（judge 不得授权模型调用）');
  }
  if (!Number.isFinite(limits.maxAttempts) || limits.maxAttempts <= 0) {
    return { action: 'STOP_BOUNDED', reason: 'AI_ESCALATION_LIMITS_INVALID', allowStrongCall: false, allowAnotherCall: false, notes };
  }
  if (!Number.isFinite(limits.maxEscalations) || limits.maxEscalations < 0) {
    return { action: 'STOP_BOUNDED', reason: 'AI_ESCALATION_LIMITS_INVALID', allowStrongCall: false, allowAnotherCall: false, notes };
  }

  if (input.quality === 'PASS') {
    return {
      action: input.currentTier === 'STRONG' ? 'STOP_STRONG_ACCEPTED' : 'STOP_PASS',
      reason: 'QUALITY_PASS',
      allowStrongCall: false,
      allowAnotherCall: false,
      notes,
    };
  }

  if (input.currentTier === 'STRONG') {
    return { action: 'STOP_FAILED', reason: 'STRONG_QUALITY_NOT_PASSED', allowStrongCall: false, allowAnotherCall: false, notes };
  }

  if (input.state.attempts >= limits.maxAttempts) {
    return { action: 'STOP_BOUNDED', reason: 'AI_ESCALATION_MAX_ATTEMPTS', allowStrongCall: false, allowAnotherCall: false, notes };
  }
  if (input.state.escalations >= limits.maxEscalations) {
    return { action: 'STOP_BOUNDED', reason: 'AI_ESCALATION_MAX_ESCALATIONS', allowStrongCall: false, allowAnotherCall: false, notes };
  }
  return {
    action: 'ESCALATE_TO_STRONG',
    reason: input.quality === 'LOW_CONFIDENCE' ? 'LOW_CONFIDENCE_BOUNDED_ESCALATION' : 'QUALITY_FAIL_BOUNDED_ESCALATION',
    allowStrongCall: true,
    allowAnotherCall: true,
    notes,
  };
}

/**
 * 合同断言：Judge / 模型输出**不得**成为再次调用模型的授权依据。
 * 任何把 judge 结论当作升级理由的路径都必须 fail-closed。
 */
export function assertJudgeCannotAuthorizeModelCall(input: {
  requestedStrongCall: boolean;
  escalation: AiEscalationDecision;
}): void {
  if (input.requestedStrongCall && input.escalation.action !== 'ESCALATE_TO_STRONG') {
    throw new Error(
      'AI_ESCALATION_NOT_AUTHORIZED: strong call requires deterministic bounded escalation (judge authorization is not accepted)',
    );
  }
}
