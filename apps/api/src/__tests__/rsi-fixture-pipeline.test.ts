/** 生产问题 → fixture 流水线验收：脱敏强制、契约校验、归档显式上报。 */

import { describe, expect, it } from 'vitest';

import {
  RSI_FIXTURE_PIPELINE_BOUNDARY,
  buildFixtureFromFailure,
  ingestFailureAsFixture,
  sanitizeFixturePayload,
} from '../services/autonomy/rsi-fixture-pipeline';

const failure = (over: Record<string, unknown> = {}) => ({
  failureId: 'f-1',
  domain: 'AMAZON_SETTLEMENT' as const,
  input: { settlementLine: 'fee 12.50', note: 'owner@example.com called +81 90-1234-5678' },
  expected: { refundable: true, amount: 12.5 },
  invariants: ['no_external_write'],
  observedAt: '2026-10-05T00:00:00.000Z',
  ...over,
});

describe('RSI 生产问题 → fixture 流水线', () => {
  it('RSI_FIXTURE_PIPELINE_PRODUCES_VALID_FIXTURE：脱敏后生成合法 fixture 并算出 64-hex digest', () => {
    const built = buildFixtureFromFailure(failure());
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error('unreachable');
    expect(built.fixture.sourceKind).toBe('PRODUCTION_SANITIZED');
    expect(built.fixture.sanitized).toBe(true);
    expect(built.fixture.inputDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(built.fixture.expectedDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(built.fixture.invariants).toEqual(['no_external_write']);
  });

  it('RSI_FIXTURE_PIPELINE_DROPS_PII_AND_SECRETS：PII/凭据键被丢弃，字符串被打码后 digest 稳定', () => {
    const sanitized = sanitizeFixturePayload({
      settlementLine: 'fee 12.50',
      email: 'owner@example.com',
      nested: { apiKey: 'sk-live', note: 'call +81 90-1234-5678' },
    }) as Record<string, unknown>;
    expect(sanitized).not.toHaveProperty('email');
    expect(sanitized).not.toHaveProperty('nested.apiKey');
    const nested = sanitized.nested as Record<string, unknown>;
    expect(nested).not.toHaveProperty('apiKey');
    expect(String(nested.note)).toContain('[redacted-phone]');

    // 同一输入重复生成 → digest 稳定（可回归比对）
    const a = buildFixtureFromFailure(failure());
    const b = buildFixtureFromFailure(failure());
    expect(a.ok && b.ok && a.inputDigest === b.inputDigest).toBe(true);
  });

  it('RSI_FIXTURE_PIPELINE_REJECTS_INVALID_INPUT：缺不变量/未知域 → 拒绝（不猜、不落库）', () => {
    expect(buildFixtureFromFailure(failure({ invariants: [] }))).toEqual({ ok: false, reason: 'NO_INVARIANTS' });
    const badDomain = buildFixtureFromFailure(failure({ domain: 'NOT_A_DOMAIN' }));
    expect(badDomain.ok).toBe(false);
    if (badDomain.ok) throw new Error('unreachable');
    expect(badDomain.reason).toBe('INVALID_DOMAIN');
  });

  it('RSI_FIXTURE_PIPELINE_ARCHIVE_IS_REPORTED：归档成功/失败均如实上报，不影响 fixture 生成结论', async () => {
    const okSink = { archive: async () => ({ ok: true, archiveRef: 'corpus/f-1' }) };
    const good = await ingestFailureAsFixture({ failure: failure(), sink: okSink });
    expect(good.ok).toBe(true);
    expect(good.archived).toBe(true);
    expect(good.reason).toBeUndefined();

    const badSink = { archive: async () => ({ ok: false }) };
    const partial = await ingestFailureAsFixture({ failure: failure(), sink: badSink });
    expect(partial.ok).toBe(true);
    expect(partial.archived).toBe(false);
    expect(partial.reason).toBe('ARCHIVE_FAILED');

    expect(RSI_FIXTURE_PIPELINE_BOUNDARY.sanitizesBeforePersisting).toBe(true);
    expect(RSI_FIXTURE_PIPELINE_BOUNDARY.dropsForbiddenKeys).toBe(true);
    expect(RSI_FIXTURE_PIPELINE_BOUNDARY.rejectsInsteadOfGuessing).toBe(true);
    expect(RSI_FIXTURE_PIPELINE_BOUNDARY.writesDatabase).toBe(false);
  });
});
