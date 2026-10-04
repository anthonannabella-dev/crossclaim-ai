/** RSI Phase-1 只读 Observer 验收：绿即静默、失败成信号、文本必须脱敏、停滞才报警。 */

import { describe, expect, it } from 'vitest';

import { observeBacklogStall, observeBuildOutput, observeCiRuns, sanitizeSignalText } from '../services/autonomy/rsi-observer';

describe('RSI Phase-1 Observer', () => {
  it('RSI_OBSERVER_GREEN_IS_SILENT：成功与进行中的 CI 不产生任何信号（不用噪声证明在运行）', () => {
    expect(
      observeCiRuns([
        { head: 'abc1234', status: 'completed', conclusion: 'success', runId: '1' },
        { head: 'def5678', status: 'in_progress', conclusion: null, runId: '2' },
        { head: 'aaa1111', status: 'queued', conclusion: null, runId: '3' },
      ]),
    ).toEqual([]);
  });

  it('RSI_OBSERVER_CI_FAILURE_SIGNAL：completed + failure 才产生 CI_FAIL，且带稳定 dedupeKey', () => {
    const signals = observeCiRuns([{ head: 'abc1234', status: 'completed', conclusion: 'failure', runId: '42' }]);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.kind).toBe('CI_FAIL');
    expect(signals[0]!.dedupeKey).toBe('CI_FAIL:abc1234:42');
    expect(signals[0]!.riskClass).toBe('MEDIUM');
    // 同输入重复观察 → 同一个 dedupeKey（交给 P1-03 去重）
    expect(observeCiRuns([{ head: 'abc1234', status: 'completed', conclusion: 'failure', runId: '42' }])[0]!.dedupeKey).toBe(
      signals[0]!.dedupeKey,
    );
  });

  it('RSI_OBSERVER_SANITIZES_PII：邮箱/电话/长数字/带 token 的 URL/本机绝对路径一律打码', () => {
    const dirty =
      'owner@example.com called +81 90-1234-5678 about account 1234567890 at https://x.io/cb?token=SECRETVALUE from D:\\crossclaim-ai\\apps\\api\\src\\a.ts';
    const clean = sanitizeSignalText(dirty);
    expect(clean).not.toContain('owner@example.com');
    expect(clean).not.toContain('1234-5678');
    expect(clean).not.toContain('1234567890');
    expect(clean).not.toContain('SECRETVALUE');
    expect(clean).not.toContain('D:\\crossclaim-ai');
    expect(clean).toContain('[redacted-email]');
    expect(clean).toContain('[redacted-phone]');
    expect(clean).toContain('[redacted-url]');
    expect(clean).toContain('[redacted-path]');
  });

  it('RSI_OBSERVER_BUILD_OUTPUT_SIGNALS：失败用例与 TS 错误被提取并脱敏', () => {
    const output = [
      '   × tenant isolation for owner@example.com (1234567890)',
      'src/x.ts(12,3): error TS2322: Type X not assignable to Y',
      '   ✓ passing case',
    ].join('\n');
    const signals = observeBuildOutput(output, 'ref:vitest');
    expect(signals.map((s) => s.kind).sort()).toEqual(['TEST_FAILURE', 'TYPECHECK_FAILURE']);
    const testSignal = signals.find((s) => s.kind === 'TEST_FAILURE')!;
    const tscSignal = signals.find((s) => s.kind === 'TYPECHECK_FAILURE')!;
    expect(testSignal.summary).not.toContain('owner@example.com');
    expect(tscSignal.summary).toContain('error TS2322');
  });

  it('RSI_OBSERVER_BACKLOG_STALL_SIGNAL：队列非空且 HEAD 连续两轮未前进才报警', () => {
    expect(observeBacklogStall({ queueLength: 3, headAtPreviousTick: null, headNow: 'aaa' })).toEqual([]);
    expect(observeBacklogStall({ queueLength: 0, headAtPreviousTick: 'aaa', headNow: 'aaa' })).toEqual([]);
    expect(observeBacklogStall({ queueLength: 3, headAtPreviousTick: 'aaa', headNow: 'bbb' })).toEqual([]);

    const stalled = observeBacklogStall({ queueLength: 3, headAtPreviousTick: 'aaa', headNow: 'aaa' });
    expect(stalled).toHaveLength(1);
    expect(stalled[0]!.kind).toBe('BACKLOG_STALL');
    expect(stalled[0]!.dedupeKey).toBe('BACKLOG_STALL:aaa');
  });
});
