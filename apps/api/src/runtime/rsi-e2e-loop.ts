/**
 * RSI-P1-07 —— 端到端闭环 demo（脱敏信号 → incident/task → runner → 证据 → Judge → decision）
 * ---------------------------------------------------------------
 * 目的：把已经落地的各段（Observer 信号 / 任务生成 / 续跑领取 / 证据 / 独立 Judge / Policy）串成**一条可审计链**，
 * 并用同一份 transcript 证明「全程零外写、零网络、不落库」。
 *
 * 诚实说明：
 *   · runner 由调用方注入（测试里是本地仿真）；本模块自己不发网络、不读凭据、不写库；
 *   · demo 会为「该风险等级要求的每一类证据」各生成一条来自注入 runner 的确定性证据记录；
 *     真实部署应当由各自的执行器分别产出 TEST / REPLAY / BENCHMARK / SECURITY / POLICY 证据，
 *     因此这里只作为**链路演示**，不代表生产评估覆盖度；
 *   · 本模块只产出 decision，**不应用**任何变更（promote 仍受 L4 policy 与 OWNER 门禁约束）。
 */

import { RSI_REQUIRED_EVALUATIONS, judgeCandidate, recordPromotionDecision, type RsiEvaluationEvidence, type RsiJudgementResult } from '../services/autonomy/rsi-judge-orchestration';
import { createRsiContinuationEngine, type RsiSafeTask } from '../services/autonomy/rsi-continuation-engine';
import { decideRsiPolicyAction } from '../services/autonomy/rsi-policy-engine';
import { generateRsiWork, type RsiGenerationResult } from '../services/autonomy/rsi-task-generator';
import { RSI_DEFAULT_FLAGS, type RsiFlags } from '../services/autonomy/rsi-runtime-config';
import type { RsiRiskClass } from '../services/autonomy/rsi-lifecycle';
import type { RsiSignal } from '../services/autonomy/rsi-observer';

export interface RsiE2eRunnerResult {
  status: 'PASS' | 'REVISE' | 'BLOCK';
  evidenceDigest?: string;
}

export interface RsiE2eStep {
  step: string;
  outcome: string;
  reasonCodes: readonly string[];
}

export interface RsiE2eTranscript {
  steps: readonly RsiE2eStep[];
  generation: RsiGenerationResult | null;
  claimedTaskId: string | null;
  judgement: RsiJudgementResult | null;
  decisionRecorded: boolean;
  halted: string | null;
  externalWritePerformed: false;
  writesDatabase: false;
  networkCalls: 0;
}

const TRANSCRIPT_BOUNDARY = { externalWritePerformed: false as const, writesDatabase: false as const, networkCalls: 0 as const };

export async function runRsiE2eLoop(input: {
  signals: readonly RsiSignal[];
  runner: (task: RsiSafeTask) => Promise<RsiE2eRunnerResult>;
  builderRef: string;
  judgeRef: string;
  riskClass: RsiRiskClass;
  /** 证据产出者（默认等于 judgeRef；必须 != builderRef，否则判定为自证） */
  evidenceProducedBy?: string;
  flags?: RsiFlags;
  autoPromoteEnabled?: boolean;
  now?: () => number;
  nowIso?: () => string;
}): Promise<RsiE2eTranscript> {
  const flags = input.flags ?? RSI_DEFAULT_FLAGS;
  const now = input.now ?? (() => Date.now());
  const nowIso = input.nowIso ?? (() => new Date(now()).toISOString());
  const steps: RsiE2eStep[] = [];
  const base = { generation: null as RsiGenerationResult | null, claimedTaskId: null as string | null, judgement: null as RsiJudgementResult | null, decisionRecorded: false, halted: null as string | null, ...TRANSCRIPT_BOUNDARY };

  // ① Policy：允许生成 incident 吗？
  const generatePolicy = decideRsiPolicyAction({ action: 'GENERATE_INCIDENT' }, { flags });
  steps.push({ step: 'POLICY_GENERATE', outcome: generatePolicy.allowedForRsi ? 'ALLOWED' : 'DENIED', reasonCodes: generatePolicy.reasonCodes });
  if (!generatePolicy.allowedForRsi) {
    return { ...base, steps, halted: 'POLICY_DENIED:GENERATE_INCIDENT' };
  }

  // ② 信号 → incident/task
  const generation = generateRsiWork({ signals: input.signals });
  steps.push({
    step: 'GENERATE',
    outcome: generation.tasks.length > 0 ? 'TASK_CREATED' : 'NO_TASK',
    reasonCodes: [...generation.duplicates.map((key) => 'DUPLICATE:' + key), ...generation.skipped.map((entry) => entry.reason + ':' + entry.dedupeKey)].sort(),
  });
  if (generation.tasks.length === 0) {
    return { ...base, generation, steps, halted: 'NO_TASK_GENERATED' };
  }
  const task = generation.tasks[0]!;

  // ③ 续跑引擎领取（事件驱动）
  const engine = createRsiContinuationEngine({
    tasks: generation.tasks.map((entry) => ({ id: entry.id, priority: entry.priority, dedupeKey: entry.dedupeKey })),
    now,
  });
  const claim = engine.handleEvent('CI_COMPLETED');
  const claimed = claim.claimed;
  steps.push({ step: 'CLAIM', outcome: claimed === null ? 'NOT_CLAIMED' : 'CLAIMED', reasonCodes: [claim.reason] });
  if (claimed === null) {
    return { ...base, generation, steps, halted: 'NOT_CLAIMED:' + claim.reason };
  }

  // ④ 执行（注入 runner；未配置/失败都必须如实反映，不伪造 PASS）
  const runResult = await input.runner(claimed);
  steps.push({ step: 'RUN', outcome: runResult.status, reasonCodes: [] });

  // ⑤ 证据：按风险等级为每一类必需证据各产出一条来自注入 runner 的记录
  const producedBy = input.evidenceProducedBy ?? input.judgeRef;
  const digest = runResult.evidenceDigest ?? 'digest-runner-default';
  const evidence: RsiEvaluationEvidence[] = RSI_REQUIRED_EVALUATIONS[input.riskClass].map((kind) => ({
    evaluationId: `ev-${kind.toLowerCase()}-1`,
    kind,
    status: runResult.status === 'PASS' ? 'PASSED' : 'FAILED',
    digest: `${kind.toLowerCase()}:${digest}`,
    recordedAt: nowIso(),
    producedBy,
  }));
  steps.push({
    step: 'EVIDENCE',
    outcome: runResult.status === 'PASS' ? 'PASSED' : 'NOT_PASSED',
    reasonCodes: RSI_REQUIRED_EVALUATIONS[input.riskClass].map((kind) => kind),
  });

  // ⑥ 独立 Judge
  const judgement = judgeCandidate(
    {
      candidateId: task.id,
      dedupeKey: `PROMOTION:${task.id}`,
      builderRef: input.builderRef,
      baselineRef: 'baseline',
      riskClass: input.riskClass,
      judgeRef: input.judgeRef,
      evidence,
    },
    { now: nowIso, ...(input.autoPromoteEnabled === undefined ? {} : { autoPromoteEnabled: input.autoPromoteEnabled }) },
  );
  steps.push({ step: 'JUDGE', outcome: judgement.decision, reasonCodes: judgement.reasonCodes });

  // ⑦ decision 记账（append-only；重复 dedupeKey 不允许）
  const recorded = recordPromotionDecision([], judgement);
  steps.push({
    step: 'RECORD',
    outcome: recorded.ok ? 'RECORDED' : 'REJECTED',
    reasonCodes: recorded.ok ? [judgement.decision] : [recorded.reason],
  });

  // ⑧ Policy：即便判为 PROMOTED，也只看 L4 是否允许自动提升（本模块从不应用变更）
  if (judgement.decision !== 'PROMOTED') {
    steps.push({ step: 'POLICY_PROMOTE', outcome: 'SKIPPED_NOT_PROMOTED', reasonCodes: [] });
  } else {
    const promotePolicy = decideRsiPolicyAction(
      { action: 'PROMOTE_LOW_RISK', riskClass: input.riskClass },
      { flags, ...(input.autoPromoteEnabled === undefined ? {} : { autoPromoteEnabled: input.autoPromoteEnabled }) },
    );
    steps.push({
      step: 'POLICY_PROMOTE',
      outcome: promotePolicy.allowedForRsi ? 'AUTO_PROMOTE_ELIGIBLE' : 'OWNER_GATE_REQUIRED',
      reasonCodes: promotePolicy.reasonCodes,
    });
  }

  return { ...base, generation, claimedTaskId: claimed.id, judgement, decisionRecorded: recorded.ok, steps };
}

export const RSI_E2E_LOOP_BOUNDARY = {
  runnerInjectedByHost: true,
  appliesChanges: false,
  externalWritePerformed: false,
  writesDatabase: false,
  performsNetworkCalls: false,
  readsCredentials: false,
  ownerGatedActionsExecuted: false,
} as const;
