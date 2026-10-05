/** RSI-P1-04 验收：Builder/Judge 隔离、独立证据要求、风险分级必需证据、append-only decision */

import { describe, expect, it } from 'vitest';

import { canAutoPromote, type RsiEvaluationKind } from '../services/autonomy/rsi-lifecycle';
import {
  RSI_JUDGE_ORCHESTRATION_BOUNDARY,
  RSI_REQUIRED_EVALUATIONS,
  judgeCandidate,
  recordPromotionDecision,
  type RsiEvaluationEvidence,
  type RsiEvaluationStatus,
  type RsiJudgementRequest,
} from '../services/autonomy/rsi-judge-orchestration';

const NOW = '2026-10-05T01:20:00.000Z';

const evidence = (
  kind: RsiEvaluationKind,
  status: RsiEvaluationStatus = 'PASSED',
  producedBy = 'judge-runner',
): RsiEvaluationEvidence => ({
  evaluationId: `ev-${kind}-${producedBy}-${status}`,
  kind,
  status,
  digest: `${kind.toLowerCase()}-digest-0123456789ab`,
  recordedAt: NOW,
  producedBy,
});

const request = (over: Partial<RsiJudgementRequest> = {}): RsiJudgementRequest => ({
  candidateId: 'cand-1',
  dedupeKey: 'PROMOTION:cand-1',
  builderRef: 'agent-builder',
  baselineRef: 'baseline-main',
  riskClass: 'MEDIUM',
  judgeRef: 'agent-judge',
  evidence: [evidence('TEST'), evidence('REPLAY')],
  ...over,
});

const judge = (over: Partial<RsiJudgementRequest> = {}, options: { autoPromoteEnabled?: boolean } = {}) =>
  judgeCandidate(request(over), { now: () => NOW, ...options });

describe('RSI judge orchestration', () => {
  it('RSI_JUDGE_PROMOTES_WITH_INDEPENDENT_EVIDENCE：证据齐全且 judge 独立 → PROMOTED', () => {
    const result = judge();
    expect(result.decision).toBe('PROMOTED');
    expect(result.reasonCodes).toEqual([]);
    expect(result.satisfiedEvaluationIds).toHaveLength(2);
    expect(result.requiredEvaluationKinds).toEqual(['TEST', 'REPLAY']);
    expect(result.decidedAt).toBe(NOW);
  });

  it('RSI_JUDGE_SELF_JUDGE_FORBIDDEN：builder 自任 judge → REJECTED，即使证据齐全', () => {
    const result = judge({ judgeRef: 'agent-builder' });
    expect(result.decision).toBe('REJECTED');
    expect(result.reasonCodes).toEqual(['SELF_JUDGE_FORBIDDEN']);
  });

  it('RSI_JUDGE_REQUIRES_EVERY_KIND：缺一条必需证据 → REJECTED（EVIDENCE_MISSING）', () => {
    const result = judge({ evidence: [evidence('TEST')] });
    expect(result.decision).toBe('REJECTED');
    expect(result.reasonCodes).toEqual(['EVIDENCE_MISSING:REPLAY']);
  });

  it('RSI_JUDGE_REJECTS_SELF_PRODUCED_EVIDENCE：证据由 builder 自己产出 → 不算独立证据', () => {
    const result = judge({ evidence: [evidence('TEST', 'PASSED', 'agent-builder'), evidence('REPLAY')] });
    expect(result.decision).toBe('REJECTED');
    expect(result.reasonCodes).toEqual(['SELF_PRODUCED_EVIDENCE:TEST']);
  });

  it('RSI_JUDGE_REJECTS_FAILED_EVIDENCE：必需证据失败 → REJECTED（EVIDENCE_FAILED）', () => {
    const failed = judge({ evidence: [evidence('TEST', 'FAILED'), evidence('REPLAY')] });
    expect(failed.decision).toBe('REJECTED');
    expect(failed.reasonCodes).toEqual(['EVIDENCE_FAILED:TEST']);

    const inconclusive = judge({ evidence: [evidence('TEST', 'INCONCLUSIVE'), evidence('REPLAY')] });
    expect(inconclusive.reasonCodes).toEqual(['EVIDENCE_NOT_CONCLUDED:TEST']);
  });

  it('RSI_JUDGE_RISK_DECIDES_REQUIRED_KINDS：LOW 只需 TEST；HIGH 需要 5 类并逐条给出缺失码', () => {
    expect(RSI_REQUIRED_EVALUATIONS.LOW).toEqual(['TEST']);
    expect(RSI_REQUIRED_EVALUATIONS.HIGH).toEqual(['TEST', 'REPLAY', 'BENCHMARK', 'SECURITY', 'POLICY']);

    const low = judge({ riskClass: 'LOW', evidence: [evidence('TEST')] });
    expect(low.decision).toBe('PROMOTED');
    expect(low.requiredEvaluationKinds).toEqual(['TEST']);

    const high = judge({ riskClass: 'HIGH', evidence: [evidence('TEST'), evidence('REPLAY'), evidence('BENCHMARK')] });
    expect(high.decision).toBe('REJECTED');
    expect(high.reasonCodes).toEqual(['EVIDENCE_MISSING:POLICY', 'EVIDENCE_MISSING:SECURITY']);
  });

  it('RSI_JUDGE_DECISION_IS_DETERMINISTIC：evidence 顺序不影响判定结果', () => {
    const forward = judge();
    const reversed = judge({ evidence: [evidence('REPLAY'), evidence('TEST')] });
    expect(reversed.decision).toBe(forward.decision);
    expect(reversed.reasonCodes).toEqual(forward.reasonCodes);
    expect(reversed.satisfiedEvaluationIds).toEqual(forward.satisfiedEvaluationIds);
  });

  it('RSI_JUDGE_NEVER_SELF_APPLIES：autoPromoted 恒为 false；默认不允许自动升级', () => {
    const low = judge({ riskClass: 'LOW', evidence: [evidence('TEST')] });
    expect(low.autoPromoted).toBe(false);
    expect(low.autoPromoteEligible).toBe(false);
    expect(canAutoPromote('LOW')).toBe(false);

    const explicit = judge({ riskClass: 'LOW', evidence: [evidence('TEST')] }, { autoPromoteEnabled: true });
    expect(explicit.autoPromoteEligible).toBe(true);
    expect(explicit.autoPromoted).toBe(false); // 只标记资格，仍不自行应用
    const highExplicit = judge({ riskClass: 'HIGH', evidence: [
      evidence('TEST'),
      evidence('REPLAY'),
      evidence('BENCHMARK'),
      evidence('SECURITY'),
      evidence('POLICY'),
    ] }, { autoPromoteEnabled: true });
    expect(highExplicit.decision).toBe('PROMOTED');
    expect(highExplicit.autoPromoteEligible).toBe(false); // HIGH 永不自动升级
  });

  it('RSI_JUDGE_DECISION_APPEND_ONLY：同一 dedupeKey 只能记录一次', () => {
    const first = judge();
    const recorded = recordPromotionDecision([], first);
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) throw new Error('expected ok');
    const again = recordPromotionDecision([recorded.decision], judge());
    expect(again.ok).toBe(false);
    if (again.ok) throw new Error('expected immutable');
    expect(again.reason).toBe('DECISION_IMMUTABLE');
  });

  it('RSI_JUDGE_BOUNDARY：不落库、不发网络、不读凭据、不改 baseline、不做任何外部写', () => {
    expect(RSI_JUDGE_ORCHESTRATION_BOUNDARY.writesDatabase).toBe(false);
    expect(RSI_JUDGE_ORCHESTRATION_BOUNDARY.performsNetworkCalls).toBe(false);
    expect(RSI_JUDGE_ORCHESTRATION_BOUNDARY.readsCredentials).toBe(false);
    expect(RSI_JUDGE_ORCHESTRATION_BOUNDARY.selfJudgeForbidden).toBe(true);
    expect(RSI_JUDGE_ORCHESTRATION_BOUNDARY.requiresIndependentEvidence).toBe(true);
    expect(RSI_JUDGE_ORCHESTRATION_BOUNDARY.mutatesBaseline).toBe(false);
    expect(RSI_JUDGE_ORCHESTRATION_BOUNDARY.autoPromotionDefault).toBe(false);
    expect(RSI_JUDGE_ORCHESTRATION_BOUNDARY.externalWrite).toBe(false);
  });
});
