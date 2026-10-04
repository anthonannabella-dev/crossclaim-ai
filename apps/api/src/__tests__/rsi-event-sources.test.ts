/** 事件源适配验收：CI/测试/verdict 映射 + 指纹去重 + 只读边界。 */

import { describe, expect, it } from 'vitest';

import {
  RSI_EVENT_SOURCES_BOUNDARY,
  createEventFingerprintGate,
  deriveContinuationEvents,
} from '../runtime/rsi-event-sources';

describe('RSI 事件源适配', () => {
  it('RSI_EVENTS_CI_MAPPING：成功→继续；失败→修复；未完成不触发', () => {
    const derived = deriveContinuationEvents({
      ci: [
        { runId: '1', head: 'aaa', status: 'completed', conclusion: 'success' },
        { runId: '2', head: 'bbb', status: 'completed', conclusion: 'failure' },
        { runId: '3', head: 'ccc', status: 'in_progress', conclusion: null },
      ],
    });
    expect(derived.map((d) => d.action)).toEqual(['CONTINUE', 'FIX']);
    expect(derived[0]!.fingerprint).toBe('CI:1:aaa:success');
    expect(derived[1]!.fingerprint).toBe('CI:2:bbb:failure');
  });

  it('RSI_EVENTS_TESTS_AND_VERDICT：测试失败→修复；verdict PASS/REVISE/BLOCK 动作正确', () => {
    expect(deriveContinuationEvents({ tests: { fingerprint: 't1', passed: false } })[0]).toMatchObject({
      event: 'TEST_COMPLETED',
      action: 'FIX',
    });
    expect(deriveContinuationEvents({ verdict: { messageId: 'm1', verdict: 'PASS' } })[0]).toMatchObject({
      event: 'JUDGE_VERDICT_RECEIVED',
      action: 'CONTINUE',
    });
    expect(deriveContinuationEvents({ verdict: { messageId: 'm2', verdict: 'REVISE' } })[0]!.action).toBe('REVISION');
    expect(deriveContinuationEvents({ verdict: { messageId: 'm3', verdict: 'BLOCK' } })[0]!.action).toBe(
      'OWNER_ACTION_REQUIRED',
    );
  });

  it('RSI_EVENTS_FINGERPRINT_GATE_DEDUPES：同一指纹只放行一次（CI 重跑/verdict 重读不重复触发）', () => {
    const gate = createEventFingerprintGate();
    const batch = deriveContinuationEvents({
      ci: [{ runId: '9', head: 'zzz', status: 'completed', conclusion: 'failure' }],
      verdict: { messageId: 'm9', verdict: 'REVISE' },
    });
    expect(gate.accept(batch)).toHaveLength(2);
    expect(gate.accept(batch)).toHaveLength(0); // 第二次全部被去重
    expect(gate.size()).toBe(2);

    // 新指纹仍然放行
    const newer = deriveContinuationEvents({
      ci: [{ runId: '10', head: 'zzz', status: 'completed', conclusion: 'success' }],
    });
    expect(gate.accept(newer)).toHaveLength(1);

    expect(RSI_EVENT_SOURCES_BOUNDARY.readOnlyInputs).toBe(true);
    expect(RSI_EVENT_SOURCES_BOUNDARY.readsFiles).toBe(false);
    expect(RSI_EVENT_SOURCES_BOUNDARY.performsNetworkCalls).toBe(false);
    expect(RSI_EVENT_SOURCES_BOUNDARY.writesDatabase).toBe(false);
  });
});
