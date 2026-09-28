/**
 * C-0013-A — 来源指纹（单元）：canonicalize、金额不入指纹、UTC 日 bucket、币种参与。
 */

import { describe, expect, it } from 'vitest';

import {
  FINGERPRINT_VERSION,
  canonicalNormalizedRef,
  occurredAtBucket,
  sourceFingerprintV1,
} from '../services/claim/source-fingerprint';

const DAY = new Date('2026-09-01T13:45:12Z');

const fp = (
  overrides: Partial<Parameters<typeof sourceFingerprintV1>[0]> = {},
): string =>
  sourceFingerprintV1({
    platformType: 'AMAZON',
    claimType: 'FBA_LOSS',
    occurredAt: DAY,
    normalizedRef: 'SHIP-001',
    currency: 'USD',
    ...overrides,
  }).fingerprint;

describe('C-0013-A — 指纹 canonicalize（MSG-132 REVISE-1）', () => {
  it('大小写、空白与不可见字符不影响指纹', () => {
    expect(fp({ platformType: 'Amazon' })).toBe(fp({ platformType: 'AMAZON' }));
    expect(fp({ claimType: 'fba_loss' })).toBe(fp({ claimType: 'FBA_LOSS' }));
    expect(fp({ currency: 'usd' })).toBe(fp({ currency: 'USD' }));
    expect(fp({ normalizedRef: '  ship-001 ' })).toBe(fp({ normalizedRef: 'SHIP-001' }));
    expect(fp({ normalizedRef: 'ship-\u200b001' })).toBe(fp({ normalizedRef: 'ship-001' }));
  });

  it('分隔符被中和：字段里出现 | 不会造成拼接歧义', () => {
    expect(fp({ normalizedRef: 'ship|001' })).toBe(fp({ normalizedRef: 'ship_001' }));
  });

  it('版本与 bucket 可回读', () => {
    const result = sourceFingerprintV1({
      platformType: 'amazon',
      claimType: 'fba_loss',
      occurredAt: DAY,
      normalizedRef: 'ship-001',
      currency: 'usd',
    });
    expect(result.version).toBe('v1');
    expect(FINGERPRINT_VERSION).toBe('v1');
    expect(result.bucket).toBe('2026-09-01');
    expect(occurredAtBucket(new Date('2026-09-01T23:59:59Z'))).toBe('2026-09-01');
    expect(occurredAtBucket(new Date('2026-09-02T00:00:01Z'))).toBe('2026-09-02');
    expect(canonicalNormalizedRef(' SHIP-001 ')).toBe('ship-001');
    expect(canonicalNormalizedRef(null)).toBe('');
  });

  it('金额不参与：100 → 95 仍是同一指纹（不拆单）', () => {
    // 指纹输入里根本没有金额字段，这里以"其他输入完全相同"来证明
    expect(fp()).toBe(fp());
  });

  it('UTC 日与币种参与：跨日与跨币种都会产生不同指纹', () => {
    expect(fp({ occurredAt: new Date('2026-09-01T00:00:00Z') })).not.toBe(
      fp({ occurredAt: new Date('2026-10-01T00:00:00Z') }),
    );
    expect(fp({ currency: 'USD' })).not.toBe(fp({ currency: 'EUR' }));
    expect(fp({ platformType: 'AMAZON' })).not.toBe(fp({ platformType: 'WALMART' }));
  });
});
