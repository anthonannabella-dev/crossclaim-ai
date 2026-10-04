/** GoldenFixture 语料契约验收：覆盖报告、脱敏强制、digest 与不变量必填、拒收显式上报。 */

import { describe, expect, it } from 'vitest';

import {
  RSI_GOLDEN_FIXTURE_BOUNDARY,
  RSI_GOLDEN_FIXTURE_DOMAINS,
  goldenCoverageReport,
  validateGoldenFixture,
  type RsiGoldenFixture,
  type RsiGoldenFixtureDomain,
} from '../services/autonomy/rsi-golden-fixtures';

const D = 'a'.repeat(64);

const fixture = (domain: RsiGoldenFixtureDomain, over: Partial<RsiGoldenFixture> = {}): RsiGoldenFixture => ({
  fixtureId: `fx-${domain}`,
  domain,
  sourceKind: 'SYNTHETIC',
  sanitized: true,
  inputDigest: D,
  expectedDigest: D,
  invariants: ['no_external_write'],
  recordedAt: '2026-10-05T00:00:00.000Z',
  ...over,
});

describe('RSI GoldenFixture 契约', () => {
  it('RSI_GOLDEN_DOMAIN_COVERAGE_REPORT：缺域即 capability gap，且被拒 fixture 显式上报', () => {
    const report = goldenCoverageReport([fixture('AMAZON_SETTLEMENT'), fixture('POD_EVIDENCE')]);
    expect(report.covered).toEqual(['AMAZON_SETTLEMENT', 'POD_EVIDENCE']);
    expect(report.missing).toHaveLength(RSI_GOLDEN_FIXTURE_DOMAINS.length - 2);
    expect(report.capabilityGap).toBe(true);
    expect(report.rejected).toEqual([]);

    const full = goldenCoverageReport(RSI_GOLDEN_FIXTURE_DOMAINS.map((domain) => fixture(domain)));
    expect(full.missing).toEqual([]);
    expect(full.capabilityGap).toBe(false);

    // 被拒收的必须上报，不静默丢弃
    const withRejected = goldenCoverageReport([
      fixture('AMAZON_SETTLEMENT'),
      fixture('TIKTOK_SETTLEMENT', { inputDigest: 'not-a-digest' }),
    ]);
    expect(withRejected.rejected).toEqual([
      { fixtureId: 'fx-TIKTOK_SETTLEMENT', reasons: ['INVALID_DIGEST'] },
    ]);
    expect(RSI_GOLDEN_FIXTURE_BOUNDARY.silentlyDropsRejectedFixtures).toBe(false);
  });

  it('RSI_GOLDEN_REJECTS_UNSANITIZED_PRODUCTION：生产来源必须脱敏，否则拒收', () => {
    const dirty = fixture('CARRIER_INVOICE', { sourceKind: 'PRODUCTION_SANITIZED', sanitized: false });
    expect(validateGoldenFixture(dirty)).toEqual({ ok: false, reasons: ['UNSANITIZED_PRODUCTION_SOURCE'] });

    const clean = fixture('CARRIER_INVOICE', { sourceKind: 'PRODUCTION_SANITIZED', sanitized: true });
    expect(validateGoldenFixture(clean).ok).toBe(true);
    expect(RSI_GOLDEN_FIXTURE_BOUNDARY.requiresSanitizedProductionSources).toBe(true);
  });

  it('RSI_GOLDEN_REQUIRES_INVARIANTS_DIGESTS_AND_NO_PII：不变量/digest 必填，含 PII 或凭据字段拒收', () => {
    expect(validateGoldenFixture(fixture('AUTHORIZATION', { invariants: [] }))).toEqual({
      ok: false,
      reasons: ['NO_INVARIANTS'],
    });
    expect(validateGoldenFixture(fixture('AUTHORIZATION', { expectedDigest: 'zz' }))).toEqual({
      ok: false,
      reasons: ['INVALID_DIGEST'],
    });

    const withPii = { ...fixture('CLAIM_PACKAGE'), email: 'owner@example.com' } as unknown as RsiGoldenFixture;
    expect(validateGoldenFixture(withPii)).toEqual({ ok: false, reasons: ['FORBIDDEN_FIELD'] });
    const withSecret = { ...fixture('PAYMENT_FEE_GUARD'), meta: { apiKey: 'sk-live' } } as unknown as RsiGoldenFixture;
    expect(validateGoldenFixture(withSecret)).toEqual({ ok: false, reasons: ['FORBIDDEN_FIELD'] });

    // 未知域拒收
    const unknown = { ...fixture('AMAZON_SETTLEMENT'), domain: 'SOMETHING_ELSE' } as unknown as RsiGoldenFixture;
    expect(validateGoldenFixture(unknown)).toEqual({ ok: false, reasons: ['UNKNOWN_DOMAIN'] });

    expect(RSI_GOLDEN_FIXTURE_BOUNDARY.rejectsForbiddenFields).toBe(true);
    expect(RSI_GOLDEN_FIXTURE_BOUNDARY.writesDatabase).toBe(false);
  });
});
