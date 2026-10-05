/**
 * RSI-P1-04 —— Builder / Judge 隔离编排（纯函数，零 IO / 零外写）
 * ---------------------------------------------------------------
 * 目标：候选（candidate）能否进入 PROMOTED，必须由**独立** Judge 依据**确定性证据**判定：
 *   · 写 patch 的 actor 永远不能当自己的 judge（复用 `assertBuilderJudgeSeparation`）；
 *   · 每条必需证据都不能由 builder 自己产出（自证不算证据）；
 *   · 必需证据缺一条、失败一条、或仍是 PENDING/RUNNING/INCONCLUSIVE → 一律 REJECTED，绝不“差不多就过”；
 *   · 风险等级决定必需证据集合（LOW: TEST；MEDIUM: +REPLAY；HIGH: +BENCHMARK +SECURITY +POLICY）；
 *   · 本模块只产出 **decision 记录**，不改 baseline、不落库、不发网络；
 *     L4 自动 promote 默认 OFF（沿用 `canAutoPromote`），本模块永远不自行应用变更。
 *   · decision 以 dedupeKey 唯一 → 重复记录直接 DECISION_IMMUTABLE（与 DB 唯一约束同语义）。
 */

import {
  RSI_EVALUATION_KINDS,
  assertBuilderJudgeSeparation,
  canAutoPromote,
  type RsiEvaluationKind,
  type RsiRiskClass,
} from './rsi-lifecycle';

export type RsiEvaluationStatus = 'PASSED' | 'FAILED' | 'INCONCLUSIVE' | 'PENDING' | 'RUNNING';
export const RSI_EVALUATION_STATUSES: readonly RsiEvaluationStatus[] = [
  'PASSED',
  'FAILED',
  'INCONCLUSIVE',
  'PENDING',
  'RUNNING',
];

export interface RsiEvaluationEvidence {
  evaluationId: string;
  kind: RsiEvaluationKind;
  status: RsiEvaluationStatus;
  /** 证据摘要（不可变内容摘要），只允许摘要素，不含原始输出 */
  digest: string;
  recordedAt: string;
  /** 谁产出的：等于 builderRef 即视为自证，不作为独立证据 */
  producedBy: string;
}

/** 风险等级 → 必需证据集合（顺序稳定） */
export const RSI_REQUIRED_EVALUATIONS: Record<RsiRiskClass, readonly RsiEvaluationKind[]> = {
  LOW: ['TEST'],
  MEDIUM: ['TEST', 'REPLAY'],
  HIGH: ['TEST', 'REPLAY', 'BENCHMARK', 'SECURITY', 'POLICY'],
};

export interface RsiJudgementRequest {
  candidateId: string;
  dedupeKey: string;
  builderRef: string;
  baselineRef: string;
  riskClass: RsiRiskClass;
  judgeRef: string;
  evidence: readonly RsiEvaluationEvidence[];
}

export interface RsiJudgementResult {
  decision: 'PROMOTED' | 'REJECTED';
  candidateId: string;
  dedupeKey: string;
  builderRef: string;
  judgeRef: string;
  riskClass: RsiRiskClass;
  /** 稳定 reason token（排序后，便于比对与去重） */
  reasonCodes: readonly string[];
  requiredEvaluationKinds: readonly RsiEvaluationKind[];
  satisfiedEvaluationIds: readonly string[];
  /** 本模块从不自行应用变更 */
  autoPromoted: false;
  /** 只有显式开启且风险为 LOW 时才为 true；默认 false */
  autoPromoteEligible: boolean;
  decidedAt: string;
}

const sorted = (values: readonly string[]): string[] => [...values].sort();

/**
 * 判定候选是否可 PROMOTED。纯函数：同样输入永远得到同样输出（与 evidence 顺序无关）。
 */
export function judgeCandidate(
  request: RsiJudgementRequest,
  options: { autoPromoteEnabled?: boolean; now?: () => string } = {},
): RsiJudgementResult {
  const requiredKinds = RSI_REQUIRED_EVALUATIONS[request.riskClass];
  const reasonCodes: string[] = [];
  const satisfied: string[] = [];

  const separation = assertBuilderJudgeSeparation(request.builderRef, request.judgeRef);
  if (!separation.ok) reasonCodes.push(separation.reason);

  const byKind = new Map<RsiEvaluationKind, RsiEvaluationEvidence[]>();
  for (const evidence of request.evidence) {
    if (!RSI_EVALUATION_KINDS.includes(evidence.kind)) continue;
    const bucket = byKind.get(evidence.kind);
    if (bucket === undefined) byKind.set(evidence.kind, [evidence]);
    else bucket.push(evidence);
  }

  for (const kind of requiredKinds) {
    const candidates = byKind.get(kind) ?? [];
    if (candidates.length === 0) {
      reasonCodes.push(`EVIDENCE_MISSING:${kind}`);
      continue;
    }
    const passed = candidates.find((evidence) => evidence.status === 'PASSED' && evidence.producedBy !== request.builderRef);
    if (passed !== undefined) {
      satisfied.push(passed.evaluationId);
      continue;
    }
    const selfProduced = candidates.some((evidence) => evidence.status === 'PASSED' && evidence.producedBy === request.builderRef);
    if (selfProduced) {
      reasonCodes.push(`SELF_PRODUCED_EVIDENCE:${kind}`);
      continue;
    }
    if (candidates.some((evidence) => evidence.status === 'FAILED')) {
      reasonCodes.push(`EVIDENCE_FAILED:${kind}`);
      continue;
    }
    reasonCodes.push(`EVIDENCE_NOT_CONCLUDED:${kind}`);
  }

  const decidedAt = (options.now ?? (() => new Date().toISOString()))();
  const autoPromoteEligible = canAutoPromote(request.riskClass, { autoPromoteEnabled: options.autoPromoteEnabled });
  const finalReasonCodes = sorted(reasonCodes);
  return {
    decision: finalReasonCodes.length === 0 ? 'PROMOTED' : 'REJECTED',
    candidateId: request.candidateId,
    dedupeKey: request.dedupeKey,
    builderRef: request.builderRef,
    judgeRef: request.judgeRef,
    riskClass: request.riskClass,
    reasonCodes: finalReasonCodes,
    requiredEvaluationKinds: requiredKinds,
    satisfiedEvaluationIds: sorted(satisfied),
    autoPromoted: false,
    autoPromoteEligible,
    decidedAt,
  };
}

export type RsiPromotionLedgerResult =
  | { ok: true; decision: RsiJudgementResult }
  | { ok: false; reason: 'DECISION_IMMUTABLE' };

/** append-only：同一 dedupeKey 只能记录一次（与 AutonomyPromotionDecision 唯一约束同语义） */
export function recordPromotionDecision(
  existing: readonly RsiJudgementResult[],
  next: RsiJudgementResult,
): RsiPromotionLedgerResult {
  if (existing.some((entry) => entry.dedupeKey === next.dedupeKey)) {
    return { ok: false, reason: 'DECISION_IMMUTABLE' };
  }
  return { ok: true, decision: next };
}

export const RSI_JUDGE_ORCHESTRATION_BOUNDARY = {
  writesDatabase: false,
  performsNetworkCalls: false,
  readsCredentials: false,
  selfJudgeForbidden: true,
  requiresIndependentEvidence: true,
  mutatesBaseline: false,
  autoPromotionDefault: false,
  decisionAppendOnly: true,
  externalWrite: false,
  payment: false,
  transport: false,
} as const;
