/**
 * RSI / CrossClaim SI —— AI Necessity Gate（C1，零 Schema 契约层）
 * ---------------------------------------------------------------
 * 授权：MSG-20261005-30（SI-COST-OPTIMIZATION 设计 = PASS WITH REVISE / APPROVED FOR STAGED IMPLEMENTATION；
 *      `C1 IMPLEMENTATION = AUTHORIZED`）。
 *
 * 硬规则（不可放宽）：
 *   · DETERMINISTIC FIRST → AI ONLY WHEN NEEDED；`LEVEL_0_RULE` 为默认（zero token）；
 *   · 唯一入口必须位于 Model Gateway（`rsi-model-router`）；**不得存在旁路**；
 *   · `RULE_SOLVABLE` → `MODEL_CALL_FORBIDDEN`；
 *   · `HIGH_CONFIDENCE` 的确定性结果 → `MODEL_CALL_FORBIDDEN`；
 *   · `AMBIGUOUS` / `SEMANTIC_REQUIRED` → `LEVEL_1_ELIGIBLE`（**只允许 LEVEL_1**）；
 *   · `UNKNOWN` / 缺少确定性证据 → **FAIL_CLOSED**（不自动升级昂贵模型）；
 *   · caller 仅声明 `requiredCapability` **不构成**模型调用权限（本模块显式拒绝）。
 */

export const AI_DETERMINISTIC_OUTCOMES = [
  'RULE_SOLVABLE',
  'HIGH_CONFIDENCE',
  'AMBIGUOUS',
  'SEMANTIC_REQUIRED',
  'UNKNOWN',
] as const;
export type AiDeterministicOutcome = (typeof AI_DETERMINISTIC_OUTCOMES)[number];

export const AI_NECESSITY_DECISIONS = ['MODEL_CALL_FORBIDDEN', 'LEVEL_1_ELIGIBLE', 'FAIL_CLOSED'] as const;
export type AiNecessityDecision = (typeof AI_NECESSITY_DECISIONS)[number];

/**
 * 确定性证据：由确定性引擎（rule / state machine / validation / reconciliation）产出。
 * 本结构只承载身份与版本，**不得**包含 prompt 正文、模型输出、凭据或客户敏感 payload。
 */
export interface AiDeterministicEvidence {
  outcome: AiDeterministicOutcome;
  /** 规则版本（缺失 → fail-closed） */
  ruleVersion: string;
  /** 结果 schema 版本（缺失 → fail-closed） */
  schemaVersion: string;
  /** 确定性输入摘要（缺失 → fail-closed） */
  inputDigest: string;
  /** 确定性结论的置信度（可选；HIGH 时与 outcome=HIGH_CONFIDENCE 等价） */
  confidence?: 'HIGH' | 'LOW' | 'UNKNOWN';
  /** 高风险任务标记（用于 cache stale 与升级策略的收紧） */
  highRisk?: boolean;
}

export interface AiNecessityInput {
  taskType: string;
  /** caller 声明（**不构成调用权限**，仅用于诊断/审计） */
  requiredCapability?: string | null;
  evidence?: AiDeterministicEvidence | null;
}

export interface AiNecessityResult {
  decision: AiNecessityDecision;
  /** 允许的执行等级（FORBIDDEN/FAIL_CLOSED 时恒为 LEVEL_0_RULE） */
  permittedLevel: 'LEVEL_0_RULE' | 'LEVEL_1_LOW_COST';
  reason: string;
  reasons: readonly string[];
  /** caller 能力声明是否被忽略（恒为 true：声明永远不构成权限） */
  callerCapabilityIgnored: true;
}

export const AI_NECESSITY_BOUNDARY = {
  singleChokePoint: 'rsi-model-router',
  bypassAllowed: false,
  callerDeclaredCapabilityGrantsModelCall: false,
  ruleSolvableModelCall: 'FORBIDDEN',
  highConfidenceModelCall: 'FORBIDDEN',
  ambiguousOrSemanticLevel: 'LEVEL_1_LOW_COST',
  strongModelFromGate: 'NEVER（strong 只能经 bounded escalation 合同）',
  unknownOutcome: 'FAIL_CLOSED',
  level0RuleDefault: true,
} as const;

const isDigestLike = (value: unknown): boolean =>
  typeof value === 'string' && /^[0-9a-f]{8,64}$/i.test(value.trim());

const isNonEmptyString = (value: unknown): boolean => typeof value === 'string' && value.trim() !== '';

/** 证据完整性校验：任一缺失/畸形 → 视为无效（fail-closed）。 */
export function validateAiDeterministicEvidence(evidence: AiDeterministicEvidence | null | undefined): {
  ok: boolean;
  problems: readonly string[];
} {
  if (!evidence) return { ok: false, problems: ['EVIDENCE_MISSING'] };
  const problems: string[] = [];
  if (!(AI_DETERMINISTIC_OUTCOMES as readonly string[]).includes(evidence.outcome)) {
    problems.push('OUTCOME_UNKNOWN');
  }
  if (!isNonEmptyString(evidence.ruleVersion)) problems.push('RULE_VERSION_MISSING');
  if (!isNonEmptyString(evidence.schemaVersion)) problems.push('SCHEMA_VERSION_MISSING');
  if (!isDigestLike(evidence.inputDigest)) problems.push('INPUT_DIGEST_INVALID');
  return { ok: problems.length === 0, problems };
}

/**
 * AI Necessity 判定（纯函数）：
 *   caller 声明能力 → 忽略；只认确定性证据。
 */
export function evaluateAiNecessity(input: AiNecessityInput): AiNecessityResult {
  const callerCapabilityIgnored = true as const;
  const base = { permittedLevel: 'LEVEL_0_RULE' as const, callerCapabilityIgnored };
  const validated = validateAiDeterministicEvidence(input.evidence);
  if (!validated.ok) {
    return {
      ...base,
      decision: 'FAIL_CLOSED',
      reason: 'AI_NECESSITY_EVIDENCE_INVALID',
      reasons: [
        '缺少/畸形确定性证据 → fail-closed（不因 caller 声明 requiredCapability 而获得模型调用权）',
        ...validated.problems,
      ],
    };
  }
  const evidence = input.evidence as AiDeterministicEvidence;
  switch (evidence.outcome) {
    case 'RULE_SOLVABLE':
      return {
        ...base,
        decision: 'MODEL_CALL_FORBIDDEN',
        // 保持既有消费者可读的措辞：规则级信号仍报告 RULE_ENGINE（但确实禁止模型调用）
        reason: 'RULE_ENGINE',
        reasons: ['规则可解 → 禁止模型调用（LEVEL_0_RULE，zero token）'],
      };
    case 'HIGH_CONFIDENCE':
      return {
        ...base,
        decision: 'MODEL_CALL_FORBIDDEN',
        reason: 'HIGH_CONFIDENCE_DETERMINISTIC',
        reasons: ['确定性结论高置信 → 禁止模型调用（LEVEL_0_RULE，zero token）'],
      };
    case 'AMBIGUOUS':
      return {
        ...base,
        decision: 'LEVEL_1_ELIGIBLE',
        permittedLevel: 'LEVEL_1_LOW_COST',
        reason: 'AMBIGUOUS_LEVEL_1_ELIGIBLE',
        reasons: ['确定性无法收敛（ambiguity）→ 允许 LEVEL_1 低成本调用（strong 仍需 bounded escalation）'],
      };
    case 'SEMANTIC_REQUIRED':
      return {
        ...base,
        decision: 'LEVEL_1_ELIGIBLE',
        permittedLevel: 'LEVEL_1_LOW_COST',
        reason: 'SEMANTIC_REQUIRED_LEVEL_1_ELIGIBLE',
        reasons: ['需要语义理解 → 允许 LEVEL_1 低成本调用（strong 仍需 bounded escalation）'],
      };
    default:
      return {
        ...base,
        decision: 'FAIL_CLOSED',
        reason: 'UNKNOWN_FAIL_CLOSED',
        reasons: ['确定性结果未知 → fail-closed（不自动升级昂贵模型）'],
      };
  }
}
