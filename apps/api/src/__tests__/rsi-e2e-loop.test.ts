/** RSI-P1-07 验收：脱敏信号 → incident/task → runner → 证据 → 独立 Judge → decision 的完整闭环 */

import { describe, expect, it } from 'vitest';

import { RSI_E2E_LOOP_BOUNDARY, runRsiE2eLoop } from '../runtime/rsi-e2e-loop';
import type { RsiSignal } from '../services/autonomy/rsi-observer';
import { RSI_DEFAULT_FLAGS } from '../services/autonomy/rsi-runtime-config';

const NOW_MS = 1_760_000_000_000;
const NOW_ISO = '2026-10-05T01:55:00.000Z';

const signal = (over: Partial<RsiSignal> = {}): RsiSignal => ({
  kind: 'CI_FAIL',
  dedupeKey: 'CI_FAIL:head-aaa:run-1',
  summary: 'CI failed on head-aaa (run 1)',
  refs: ['run:1'],
  riskClass: 'MEDIUM',
  ...over,
});

const pass = async () => ({ status: 'PASS' as const, evidenceDigest: 'digest-abc123' });

const base = {
  signals: [signal()],
  runner: pass,
  builderRef: 'agent-builder',
  judgeRef: 'agent-judge',
  riskClass: 'MEDIUM' as const,
  now: () => NOW_MS,
  nowIso: () => NOW_ISO,
};

const promoteFlags = {
  ...RSI_DEFAULT_FLAGS,
  stages: { ...RSI_DEFAULT_FLAGS.stages, AUTO_PROMOTE_LOW_RISK: true },
};

describe('RSI end-to-end loop', () => {
  it('RSI_E2E_HAPPY_PATH：信号走到独立 Judge 并产出 decision，全程零外写', async () => {
    const transcript = await runRsiE2eLoop(base);
    expect(transcript.halted).toBeNull();
    expect(transcript.claimedTaskId).not.toBeNull();
    expect(transcript.judgement?.decision).toBe('PROMOTED');
    expect(transcript.decisionRecorded).toBe(true);
    expect(transcript.steps.map((step) => step.step)).toEqual([
      'POLICY_GENERATE',
      'GENERATE',
      'CLAIM',
      'RUN',
      'EVIDENCE',
      'JUDGE',
      'RECORD',
      'POLICY_PROMOTE',
    ]);
    // MEDIUM 风险不允许自动提升 → 必须回到 OWNER 门禁
    const promote = transcript.steps.at(-1)!;
    expect(promote.outcome).toBe('OWNER_GATE_REQUIRED');
    expect(promote.reasonCodes).toContain('AUTO_PROMOTE_LOW_RISK_ONLY');
    expect(transcript.externalWritePerformed).toBe(false);
    expect(transcript.writesDatabase).toBe(false);
    expect(transcript.networkCalls).toBe(0);
  });

  it('RSI_E2E_KILL_SWITCH_HALTS_BEFORE_WORK：Kill Switch 触发 → 连 incident 都不生成', async () => {
    const transcript = await runRsiE2eLoop({ ...base, flags: { ...RSI_DEFAULT_FLAGS, paused: true } });
    expect(transcript.halted).toBe('POLICY_DENIED:GENERATE_INCIDENT');
    expect(transcript.claimedTaskId).toBeNull();
    expect(transcript.judgement).toBeNull();
    expect(transcript.steps).toHaveLength(1);
    expect(transcript.steps[0]!.reasonCodes).toEqual(['KILL_SWITCH_PAUSED']);
  });

  it('RSI_E2E_SENSITIVE_SIGNAL_HALTS：信号摘要含敏感数据 → 不生成任务，闭环停止', async () => {
    const transcript = await runRsiE2eLoop({
      ...base,
      signals: [signal({ dedupeKey: 'CI_FAIL:pii:run-2', summary: 'failed for ops@example.com' })],
    });
    expect(transcript.halted).toBe('NO_TASK_GENERATED');
    expect(transcript.generation?.skipped[0]?.reason).toBe('SENSITIVE_SIGNAL');
    expect(transcript.judgement).toBeNull();
  });

  it('RSI_E2E_BLOCKED_RUNNER_NEVER_PROMOTES：runner BLOCK → 证据未通过 → REJECTED 且不申请提升', async () => {
    const transcript = await runRsiE2eLoop({
      ...base,
      runner: async () => ({ status: 'BLOCK' as const }),
    });
    expect(transcript.judgement?.decision).toBe('REJECTED');
    // MEDIUM 需要 TEST + REPLAY 两类证据，两类都随 runner 结果变成 FAILED
    expect(transcript.judgement?.reasonCodes).toEqual(['EVIDENCE_FAILED:REPLAY', 'EVIDENCE_FAILED:TEST']);
    expect(transcript.decisionRecorded).toBe(true);
    expect(transcript.steps.at(-1)!.outcome).toBe('SKIPPED_NOT_PROMOTED');
  });

  it('RSI_E2E_SELF_JUDGE_REJECTED：builder 自任 judge → REJECTED（自判禁止贯穿闭环）', async () => {
    const transcript = await runRsiE2eLoop({ ...base, judgeRef: 'agent-builder' });
    expect(transcript.judgement?.decision).toBe('REJECTED');
    // 自任 judge 时证据产出者也默认等于该 actor → 同时命中“自证”规则
    expect(transcript.judgement?.reasonCodes).toEqual([
      'SELF_JUDGE_FORBIDDEN',
      'SELF_PRODUCED_EVIDENCE:REPLAY',
      'SELF_PRODUCED_EVIDENCE:TEST',
    ]);
  });

  it('RSI_E2E_HIGH_RISK_NEVER_AUTO_PROMOTES：HIGH 风险判定通过也仍回 OWNER 门禁', async () => {
    const transcript = await runRsiE2eLoop({
      ...base,
      riskClass: 'HIGH',
      flags: promoteFlags,
      autoPromoteEnabled: true,
    });
    expect(transcript.judgement?.decision).toBe('PROMOTED');
    expect(transcript.steps.at(-1)!.outcome).toBe('OWNER_GATE_REQUIRED');
    expect(transcript.steps.at(-1)!.reasonCodes).toContain('AUTO_PROMOTE_LOW_RISK_ONLY');
  });

  it('RSI_E2E_LOW_RISK_EXPLICIT_ENABLE：LOW 风险 + stage 与显式开关同时打开 → 仅标记可自动提升', async () => {
    const transcript = await runRsiE2eLoop({
      ...base,
      riskClass: 'LOW',
      flags: promoteFlags,
      autoPromoteEnabled: true,
    });
    expect(transcript.judgement?.decision).toBe('PROMOTED');
    expect(transcript.steps.at(-1)!.outcome).toBe('AUTO_PROMOTE_ELIGIBLE');
    expect(transcript.externalWritePerformed).toBe(false); // 仍然只产 decision，不应用变更
  });

  it('RSI_E2E_LOOP_BOUNDARY：链路本身零外写、零网络、不落库、不执行 OWNER 级动作', () => {
    expect(RSI_E2E_LOOP_BOUNDARY.runnerInjectedByHost).toBe(true);
    expect(RSI_E2E_LOOP_BOUNDARY.appliesChanges).toBe(false);
    expect(RSI_E2E_LOOP_BOUNDARY.externalWritePerformed).toBe(false);
    expect(RSI_E2E_LOOP_BOUNDARY.writesDatabase).toBe(false);
    expect(RSI_E2E_LOOP_BOUNDARY.performsNetworkCalls).toBe(false);
    expect(RSI_E2E_LOOP_BOUNDARY.readsCredentials).toBe(false);
    expect(RSI_E2E_LOOP_BOUNDARY.ownerGatedActionsExecuted).toBe(false);
  });
});
