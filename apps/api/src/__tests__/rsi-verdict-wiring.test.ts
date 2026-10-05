/** RSI-RT-05：verdict artifact 取值归一化（无法识别不猜）。 */

import { describe, expect, it } from 'vitest';

import { normalizeRsiVerdict, RSI_RUNTIME_COMPOSITION_BOUNDARY } from '../runtime/rsi-run';

describe('RSI verdict 取值归一化', () => {
  it('ACCEPTS_STRING_AND_OBJECT_SHAPES', () => {
    expect(normalizeRsiVerdict('PASS')).toBe('PASS');
    expect(normalizeRsiVerdict(' revise ')).toBe('REVISE');
    expect(normalizeRsiVerdict({ verdict: 'BLOCK' })).toBe('BLOCK');
    expect(normalizeRsiVerdict({ status: 'pass' })).toBe('PASS');
  });

  it('UNRECOGNISED_YIELDS_NULL：不认识的值不猜', () => {
    expect(normalizeRsiVerdict('MAYBE')).toBeNull();
    expect(normalizeRsiVerdict(undefined)).toBeNull();
    expect(normalizeRsiVerdict({ other: 1 })).toBeNull();
  });

  it('BOUNDARY：默认 park-for-judge、取值来自 artifact', () => {
    expect(RSI_RUNTIME_COMPOSITION_BOUNDARY.parkForJudgeDefault).toBe(false); // opt-in：避免无裁决来源时卡死
    expect(RSI_RUNTIME_COMPOSITION_BOUNDARY.verdictValueFromArtifact).toBe(true);
    expect(RSI_RUNTIME_COMPOSITION_BOUNDARY.performsExternalWrite).toBe(false);
  });
});
