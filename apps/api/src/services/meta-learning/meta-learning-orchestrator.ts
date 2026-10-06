// SI/RSI GAP-CLOSURE — 单元 D — META LEARNING / CONTROLLED IMPROVEMENT v1（编排 + 闸门）
// ---------------------------------------------------------------------------
// 审计结论（先查现有实现，不重复造轮子）：
//   `services/outcome-learning/*` 已实现链上各段——learning-evidence（append-only 证据 + verified projection）、
//   offline-evaluation（resolved 口径指标）、meta-improvement-candidate（PROPOSAL_ONLY 候选 + fingerprint）、
//   candidate-approval（评审票据 + approval/rejection verdict，single-use / 过期 / 撤销）、rollback-plan、
//   controlled-config-proposal、canary-shadow-evaluation、controlled-adoption-review。
//   真实缺口：**没有把这条链串成一个可判定「是否允许改进」的端到端闸门**，也没有对
//   「无可验证收益不得 promote」与「RSI 不得扩权」做统一 fail-closed 断言。
//
// 本模块只做**编排与判定**（纯函数、无写入、无外部调用）：
//   Outcome → Experience → Proposal → Candidate → Replay → Benchmark → Security Eval → Policy Eval →
//   Independent Judge → Guard → Sandbox Adoption → Observation →（Regression → Rollback）
// 硬边界：
//   ① 无 verifiable reward / measurable KPI（或 Δ 低于阈值）→ **不得自动 promote**；
//   ② Experience 不足（FAIL_CLOSED / NO_AUTOMATIC_LEARNING / IGNORED）→ 不得进入候选评估；
//   ③ Independent Judge 必须与 builder 不同 actor（Builder/Judge 分离）；
//   ④ 采用范围只能是 SANDBOX；任何 PRODUCTION 采用/推广/回滚请求一律 fail-closed；
//   ⑤ RSI 不得改/绕唯一 Policy Core、不得建第二 Guard、不得绕 Action Catalog、不得自行关 Kill Switch、
//      不得自行扩权 / 开 Payment / 开 Customs Filing / 取 Production Credentials（请求即抛错）；
//   ⑥ META_IMPROVEMENT_INTEGRATED 只有在**全链 12 段齐备且通过**时才为 true。

import { digestOf } from '../config-execution-durability/digests';
import type { ExperienceDecisionSupport } from '../experience-memory/experience-memory';

export const META_LEARNING_VERSION = 'meta-learning-orchestrator/v1';

/** 端到端链的固定顺序（缺段或乱序一律 fail-closed） */
export const META_LEARNING_STAGES = [
  'OUTCOME',
  'EXPERIENCE',
  'PROPOSAL',
  'CANDIDATE',
  'REPLAY',
  'BENCHMARK',
  'SECURITY_EVALUATION',
  'POLICY_EVALUATION',
  'INDEPENDENT_JUDGE',
  'GUARD',
  'SANDBOX_ADOPTION',
  'OBSERVATION',
] as const;
export type MetaLearningStage = (typeof META_LEARNING_STAGES)[number];

export const META_LEARNING_DISPOSITIONS = [
  'BLOCKED_MISSING_STAGE',
  'BLOCKED_OUT_OF_ORDER',
  'BLOCKED_BY_EXPERIENCE',
  'BLOCKED_BY_REWARD',
  'BLOCKED_BY_EVALUATION',
  'BLOCKED_BY_JUDGE',
  'BLOCKED_BY_GUARD',
  'BLOCKED_BY_SCOPE',
  'SANDBOX_ADOPTION_APPROVED',
  'OBSERVED_STABLE',
  'REGRESSION_DETECTED_ROLLBACK_REQUIRED',
  'ROLLED_BACK',
] as const;
export type MetaLearningDisposition = (typeof META_LEARNING_DISPOSITIONS)[number];

/** 允许的采用范围：v1 只允许 SANDOX；生产采用/推广/回滚 = false */
export const META_LEARNING_ADOPTION_SCOPES = ['SANDBOX'] as const;
export type MetaLearningAdoptionScope = (typeof META_LEARNING_ADOPTION_SCOPES)[number];

/** 明确禁止 RSI 自行取得的能力（出现即 fail-closed 抛错） */
export const FORBIDDEN_META_CAPABILITIES = [
  'POLICY_CORE_MUTATION',
  'SECOND_GUARD_IMPLEMENTATION',
  'ACTION_CATALOG_BYPASS',
  'KILL_SWITCH_CHANGE',
  'PERMISSION_EXPANSION',
  'PAYMENT_ENABLEMENT',
  'CUSTOMS_FILING_ENABLEMENT',
  'PRODUCTION_CREDENTIAL_ACCESS',
  'AUTO_PRODUCTION_PROMOTION',
  'AUTO_PRODUCTION_ROLLOUT',
  'AUTO_PRODUCTION_ROLLBACK',
] as const;
export type ForbiddenMetaCapability = (typeof FORBIDDEN_META_CAPABILITIES)[number];

export interface MetaLearningStageEvidence {
  stage: MetaLearningStage;
  /** 该段证据的稳定引用（指向既有模块输出，例如 candidate fingerprint / verdict id / guard decision id） */
  ref: string;
  /** 该段输出 digest（64 hex，用于绑定与防篡改） */
  digest: string;
  /** 该段状态：必须 PASSED 才可能继续 */
  status: 'PASSED' | 'FAILED' | 'SKIPPED';
}

export interface MetaLearningRewardEvidence {
  kpiKey: string;
  /** 基线值 / 候选值（同口径、同分母） */
  baselineValue: number;
  candidateValue: number;
  /** 观测样本量 */
  sampleCount: number;
  /** 要求的**最小**相对提升（basis points） */
  minDeltaBp: number;
  /** 证据引用（例如 offline-evaluation digest） */
  evidenceRef: string;
}

export interface MetaLearningAdoption {
  scope: string;
  adoptionRef: string;
  /** 回滚计划（采用前必须齐备） */
  rollbackPlanRef: string;
}

export interface MetaLearningObservation {
  windowDays: number;
  sampleCount: number;
  regressionDetected: boolean;
  rollbackExecuted: boolean;
  observationRef: string;
}

export interface MetaLearningInput {
  scope: { organizationId: string; platformAccountId: string | null };
  /** 链上各段证据（顺序无关，由编排器校验完整性/顺序） */
  stages: readonly MetaLearningStageEvidence[];
  experience: {
    experienceDigest: string;
    sourceCount: number;
    decisionSupport: ExperienceDecisionSupport;
  };
  builderRef: string;
  judgeRef: string;
  guardAllowed: boolean;
  guardDecisionRef: string;
  reward: MetaLearningRewardEvidence | null;
  adoption: MetaLearningAdoption | null;
  observation: MetaLearningObservation | null;
  /** 本次改进请求涉及的能力（用于 forbidden 断言） */
  requestedCapabilities?: readonly string[];
  now: Date;
}

export interface MetaLearningResult {
  kind: 'META_LEARNING_RESULT';
  version: string;
  organizationId: string;
  platformAccountId: string | null;
  disposition: MetaLearningDisposition;
  /** 只有全链通过（且观测无回归）才为 true */
  metaImprovementIntegrated: boolean;
  adoptionScope: string | null;
  rollbackRequired: boolean;
  rollbackExecuted: boolean;
  stagesPresent: MetaLearningStage[];
  stagesMissing: MetaLearningStage[];
  outOfOrder: boolean;
  reward: {
    evaluated: boolean;
    kpiKey: string | null;
    deltaBp: number | null;
    minDeltaBp: number | null;
    sampleCount: number | null;
    verifiable: boolean;
  };
  judgeSeparated: boolean;
  guardAllowed: boolean;
  /** 恒为 false：本模块不执行采用，只判定 */
  adoptionPerformed: false;
  externalWritePerformed: false;
  productionAdoptionAllowed: false;
  policyCoreMutationAllowed: false;
  secondGuardAllowed: false;
  reasonCodes: string[];
  decidedAt: string;
  decisionDigest: string;
}

export type MetaLearningErrorCode =
  | 'META_LEARNING_FORBIDDEN_CAPABILITY'
  | 'META_LEARNING_CANNOT_PROMOTE_WITHOUT_REWARD'
  | 'META_LEARNING_CANNOT_EXCEED_SANDBOX';

export class MetaLearningError extends Error {
  readonly code: MetaLearningErrorCode;

  constructor(code: MetaLearningErrorCode, message: string) {
    super(message);
    this.name = 'MetaLearningError';
    this.code = code;
  }
}

const DIGEST_RE = /^[a-f0-9]{64}$/;

/** 请求能力里出现任何 FORBIDDEN 项 → 立即抛错（程序化越权尝试不接受） */
export function assertNoForbiddenCapabilities(requested: readonly string[]): void {
  const hit = requested.filter((capability) =>
    (FORBIDDEN_META_CAPABILITIES as readonly string[]).includes(capability.toUpperCase()),
  );
  if (hit.length > 0) {
    throw new MetaLearningError(
      'META_LEARNING_FORBIDDEN_CAPABILITY',
      'RSI 不得自行取得以下能力：' + hit.join(', '),
    );
  }
}

/**
 * 端到端受控改进闸门（纯函数）。
 * 输出 disposition 与 metaImprovementIntegrated；**不执行任何采用**。
 */
export function evaluateMetaLearning(input: MetaLearningInput): MetaLearningResult {
  assertNoForbiddenCapabilities(input.requestedCapabilities ?? []);

  const reasonCodes: string[] = [];
  const present = input.stages.map((stage) => stage.stage);
  const stagesPresent = META_LEARNING_STAGES.filter((stage) => present.includes(stage));
  const stagesMissing = META_LEARNING_STAGES.filter((stage) => !present.includes(stage));

  // 顺序校验：出现的段必须严格按固定顺序
  const indexes = present.map((stage) => META_LEARNING_STAGES.indexOf(stage));
  const outOfOrder = indexes.some((value, index) => index > 0 && value < indexes[index - 1]);

  const failed = input.stages.filter((stage) => stage.status !== 'PASSED');
  const badDigest = input.stages.filter((stage) => !DIGEST_RE.test(stage.digest));

  const judgeSeparated = input.judgeRef !== input.builderRef && input.judgeRef.trim().length > 0;

  const reward = input.reward;
  const rewardDeltaBp =
    reward === null || reward.baselineValue === 0
      ? null
      : Math.round(((reward.candidateValue - reward.baselineValue) / Math.abs(reward.baselineValue)) * 10_000);
  const rewardVerifiable =
    reward !== null &&
    Number.isFinite(reward.candidateValue) &&
    Number.isFinite(reward.baselineValue) &&
    reward.sampleCount > 0 &&
    reward.kpiKey.trim().length > 0 &&
    reward.evidenceRef.trim().length > 0 &&
    rewardDeltaBp !== null &&
    rewardDeltaBp >= reward.minDeltaBp;

  let disposition: MetaLearningDisposition;
  let rollbackRequired = false;
  let rollbackExecuted = false;

  const experienceBlocked = ['FAIL_CLOSED', 'NO_AUTOMATIC_LEARNING', 'IGNORED'].includes(
    input.experience.decisionSupport,
  );

  if (badDigest.length > 0) {
    disposition = 'BLOCKED_MISSING_STAGE';
    reasonCodes.push('INVALID_STAGE_DIGEST');
  } else if (stagesMissing.length > 0) {
    disposition = 'BLOCKED_MISSING_STAGE';
    reasonCodes.push('MISSING_STAGES:' + stagesMissing.join(','));
  } else if (outOfOrder) {
    disposition = 'BLOCKED_OUT_OF_ORDER';
    reasonCodes.push('STAGE_ORDER_VIOLATION');
  } else if (experienceBlocked) {
    disposition = 'BLOCKED_BY_EXPERIENCE';
    reasonCodes.push('EXPERIENCE_' + input.experience.decisionSupport);
  } else if (!rewardVerifiable) {
    disposition = 'BLOCKED_BY_REWARD';
    reasonCodes.push(reward === null ? 'NO_REWARD_EVIDENCE' : 'REWARD_NOT_VERIFIABLE');
  } else if (failed.length > 0) {
    disposition = 'BLOCKED_BY_EVALUATION';
    reasonCodes.push('STAGE_NOT_PASSED:' + failed.map((stage) => stage.stage).join(','));
  } else if (!judgeSeparated) {
    disposition = 'BLOCKED_BY_JUDGE';
    reasonCodes.push('BUILDER_JUDGE_SAME_ACTOR');
  } else if (!input.guardAllowed) {
    disposition = 'BLOCKED_BY_GUARD';
    reasonCodes.push('GUARD_DENIED');
  } else if (input.adoption !== null && !(META_LEARNING_ADOPTION_SCOPES as readonly string[]).includes(input.adoption.scope)) {
    disposition = 'BLOCKED_BY_SCOPE';
    reasonCodes.push('ADOPTION_SCOPE_NOT_SANDBOX');
  } else if (input.adoption !== null && input.adoption.rollbackPlanRef.trim().length === 0) {
    disposition = 'BLOCKED_BY_SCOPE';
    reasonCodes.push('ROLLBACK_PLAN_REQUIRED_BEFORE_ADOPTION');
  } else if (input.observation === null) {
    disposition = 'SANDBOX_ADOPTION_APPROVED';
    reasonCodes.push('SANDBOX_ADOPTION_APPROVED_PENDING_OBSERVATION');
  } else if (input.observation.regressionDetected) {
    disposition = input.observation.rollbackExecuted
      ? 'ROLLED_BACK'
      : 'REGRESSION_DETECTED_ROLLBACK_REQUIRED';
    rollbackRequired = !input.observation.rollbackExecuted;
    rollbackExecuted = input.observation.rollbackExecuted;
    reasonCodes.push('POST_ADOPTION_REGRESSION_DETECTED');
  } else {
    disposition = 'OBSERVED_STABLE';
    reasonCodes.push('OBSERVATION_WINDOW_STABLE');
  }

  const metaImprovementIntegrated = disposition === 'OBSERVED_STABLE';

  const body = {
    version: META_LEARNING_VERSION,
    organizationId: input.scope.organizationId,
    platformAccountId: input.scope.platformAccountId,
    disposition,
    metaImprovementIntegrated,
    adoptionScope: input.adoption?.scope ?? null,
    rollbackRequired,
    rollbackExecuted,
    stagesPresent,
    stagesMissing,
    outOfOrder,
    reward: {
      evaluated: reward !== null,
      kpiKey: reward?.kpiKey ?? null,
      deltaBp: rewardDeltaBp,
      minDeltaBp: reward?.minDeltaBp ?? null,
      sampleCount: reward?.sampleCount ?? null,
      verifiable: rewardVerifiable,
    },
    judgeSeparated,
    guardAllowed: input.guardAllowed,
    adoptionPerformed: false as const,
    externalWritePerformed: false as const,
    productionAdoptionAllowed: false as const,
    policyCoreMutationAllowed: false as const,
    secondGuardAllowed: false as const,
    reasonCodes: [...new Set(reasonCodes)].sort(),
    decidedAt: input.now.toISOString(),
  };

  return {
    kind: 'META_LEARNING_RESULT',
    ...body,
    decisionDigest: digestOf(body),
  };
}

export const META_LEARNING_BOUNDARY = {
  orchestratesOnly: true,
  executesAdoption: false,
  externalWritePerformed: false,
  productionAdoptionAllowed: false,
  autoProductionPromotion: false,
  autoProductionRollout: false,
  autoProductionRollback: false,
  requiresVerifiableReward: true,
  requiresIndependentJudge: true,
  requiresSandboxScope: true,
  requiresRollbackPlanBeforeAdoption: true,
  policyCoreMutationAllowed: false,
  secondGuardAllowed: false,
  actionCatalogBypassAllowed: false,
  killSwitchChangeAllowed: false,
  permissionExpansionAllowed: false,
  runsEndToEndOnlyWithAllStages: true,
  forbiddenCapabilities: FORBIDDEN_META_CAPABILITIES,
  forbidden: [
    'promoting an improvement without a verifiable reward / measurable KPI',
    'adopting anything outside SANDBOX',
    'letting the same actor build and judge',
    'adopting without a rollback plan',
    'mutating the single Policy Core or creating a second Guard',
    'bypassing the Action Catalog or changing the Kill Switch',
    'expanding permissions, enabling Payment / Customs Filing, or reading production credentials',
  ],
} as const;

/** 边界断言：任何声称已自动 promote / 已生产采用 / 已扩权的记录都必须被拒绝 */
export function assertMetaLearningIsControlled(record: {
  productionAdoptionAllowed?: boolean;
  policyCoreMutationAllowed?: boolean;
  secondGuardAllowed?: boolean;
  metaImprovementIntegrated?: boolean;
  reward?: { verifiable?: boolean };
  disposition?: MetaLearningDisposition;
}): void {
  if (
    record.productionAdoptionAllowed === true ||
    record.policyCoreMutationAllowed === true ||
    record.secondGuardAllowed === true ||
    (record.metaImprovementIntegrated === true &&
      (record.reward?.verifiable !== true || record.disposition !== 'OBSERVED_STABLE'))
  ) {
    throw new MetaLearningError(
      'META_LEARNING_CANNOT_PROMOTE_WITHOUT_REWARD',
      'Meta Learning 必须保持受控：无 verifiable reward 不得 promote，且不得越出 SANDBOX / 扩权。',
    );
  }
}

/** 采用范围守卫：任何非 SANDBOX 采用请求一律抛错 */
export function assertSandboxOnlyAdoption(scope: string): void {
  if (!(META_LEARNING_ADOPTION_SCOPES as readonly string[]).includes(scope)) {
    throw new MetaLearningError(
      'META_LEARNING_CANNOT_EXCEED_SANDBOX',
      'Controlled Improvement v1 只允许 SANDBOX 采用；生产采用/推广/回滚 = false。',
    );
  }
}
