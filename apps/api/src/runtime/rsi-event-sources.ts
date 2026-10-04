/**
 * RSI 事件源适配（CI / 测试 / verdict → 续跑事件）
 * ---------------------------------------------------------------
 * 目的：把「外部结果」转成续跑引擎能消费的事件，并**按指纹去重**——同一 CI run / 同一 verdict
 * 绝不重复触发（防止 event + watchdog 之外的第二类重复）。
 *
 * 纯函数：只读入参（CI 结果、测试输出摘要、verdict 文本摘要），不读文件、不写库、不调网络。
 * 文件/API 读取由宿主完成并注入。
 */

import type { RsiContinuationEvent } from '../services/autonomy/rsi-continuation-engine';

export interface RsiCiOutcome {
  runId: string;
  head: string;
  status: 'completed' | 'in_progress' | 'queued';
  conclusion: 'success' | 'failure' | null;
}

export interface RsiVerdictOutcome {
  messageId: string;
  verdict: 'PASS' | 'REVISE' | 'BLOCK';
}

export interface RsiDerivedEvent {
  event: RsiContinuationEvent;
  /** 去重指纹：同指纹只触发一次。 */
  fingerprint: string;
  /** 失败类结果的建议动作。 */
  action: 'CONTINUE' | 'FIX' | 'REVISION' | 'OWNER_ACTION_REQUIRED';
}

export function deriveContinuationEvents(input: {
  ci?: readonly RsiCiOutcome[] | undefined;
  tests?: { fingerprint: string; passed: boolean } | undefined;
  verdict?: RsiVerdictOutcome | undefined;
}): readonly RsiDerivedEvent[] {
  const events: RsiDerivedEvent[] = [];

  for (const run of input.ci ?? []) {
    if (run.status !== 'completed' || run.conclusion === null) continue; // in_progress/queued 不触发
    events.push(
      run.conclusion === 'success'
        ? {
            event: 'CI_COMPLETED',
            fingerprint: `CI:${run.runId}:${run.head}:success`,
            action: 'CONTINUE',
          }
        : {
            event: 'CI_COMPLETED',
            fingerprint: `CI:${run.runId}:${run.head}:failure`,
            action: 'FIX',
          },
    );
  }

  if (input.tests !== undefined) {
    events.push({
      event: 'TEST_COMPLETED',
      fingerprint: `TEST:${input.tests.fingerprint}`,
      action: input.tests.passed ? 'CONTINUE' : 'FIX',
    });
  }

  if (input.verdict !== undefined) {
    events.push({
      event: 'JUDGE_VERDICT_RECEIVED',
      fingerprint: `VERDICT:${input.verdict.messageId}:${input.verdict.verdict}`,
      action:
        input.verdict.verdict === 'PASS'
          ? 'CONTINUE'
          : input.verdict.verdict === 'REVISE'
            ? 'REVISION'
            : 'OWNER_ACTION_REQUIRED',
    });
  }

  return events;
}

/** 指纹去重器：同一指纹只放行一次（事件源侧的第二道保险）。 */
export function createEventFingerprintGate() {
  const seen = new Set<string>();
  return {
    accept(events: readonly RsiDerivedEvent[]): readonly RsiDerivedEvent[] {
      const accepted: RsiDerivedEvent[] = [];
      for (const derived of events) {
        if (seen.has(derived.fingerprint)) continue;
        seen.add(derived.fingerprint);
        accepted.push(derived);
      }
      return accepted;
    },
    size: () => seen.size,
  };
}

export const RSI_EVENT_SOURCES_BOUNDARY = {
  readOnlyInputs: true,
  readsFiles: false,
  performsNetworkCalls: false,
  writesDatabase: false,
  dedupesByFingerprint: true,
} as const;
