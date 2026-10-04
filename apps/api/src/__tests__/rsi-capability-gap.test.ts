/** 能力缺口信号验收：缺域即 FAIL、全覆盖 PASS、被拒 fixture 计入但不泄露内容。 */

import { describe, expect, it } from 'vitest';

import { RSI_CAPABILITY_GAP_BOUNDARY, capabilityGapSuiteFromCoverage } from '../services/autonomy/rsi-capability-gap';
import type { RsiGoldenCoverageReport } from '../services/autonomy/rsi-golden-fixtures';

const report = (over: Partial<RsiGoldenCoverageReport> = {}): RsiGoldenCoverageReport => ({
  covered: ['AMAZON_SETTLEMENT', 'POD_EVIDENCE'],
  missing: ['TIKTOK_SETTLEMENT', 'CARRIER_INVOICE'],
  capabilityGap: true,
  rejected: [],
  ...over,
});

describe('RSI 能力缺口信号', () => {
  it('RSI_CAPABILITY_GAP_FAILS_WITH_MISSING_DOMAINS：缺域 → FAIL 且 detail 只列域名标识', () => {
    const result = capabilityGapSuiteFromCoverage(report());
    expect(result.status).toBe('FAIL');
    expect(result.detail).toContain('TIKTOK_SETTLEMENT');
    expect(result.metrics).toEqual({ coveredDomains: 2, missingDomains: 2, rejectedFixtures: 0 });
    // 不含任何 fixture 内容（仅域名与计数）
    expect(result.detail).not.toMatch(/@|\d{6,}/);
  });

  it('RSI_CAPABILITY_GAP_PASSES_WHEN_FULLY_COVERED：全覆盖且无拒收 → PASS（Weekly 静默）', () => {
    const full = capabilityGapSuiteFromCoverage(
      report({
        covered: [
          'AMAZON_SETTLEMENT',
          'TIKTOK_SETTLEMENT',
          'WALMART_SETTLEMENT',
          'SHOPIFY',
          'CARRIER_INVOICE',
          'POD_EVIDENCE',
          'RECOVERY_OPPORTUNITY',
          'CLAIM_PACKAGE',
          'CUSTOMS_MATCHING',
          'CUSTOMS_ELIGIBILITY',
          'AUTHORIZATION',
          'PAYMENT_FEE_GUARD',
        ],
        missing: [],
        capabilityGap: false,
      }),
    );
    expect(full.status).toBe('PASS');
    expect(full.detail).toBeUndefined();
  });

  it('RSI_CAPABILITY_GAP_COUNTS_REJECTED_WITHOUT_LEAKING：被拒 fixture 计入并触发 FAIL，但不泄露内容', () => {
    const withRejected = capabilityGapSuiteFromCoverage(
      report({ missing: [], rejected: [{ fixtureId: 'fx-1', reasons: ['INVALID_DIGEST'] }] }),
    );
    expect(withRejected.status).toBe('FAIL');
    expect(withRejected.metrics?.rejectedFixtures).toBe(1);
    expect(withRejected.detail).toBe('rejected fixtures: 1');
    expect(withRejected.detail).not.toContain('fx-1'); // 不暴露 fixture 身份之外的细节

    expect(RSI_CAPABILITY_GAP_BOUNDARY.includesFixtureContent).toBe(false);
    expect(RSI_CAPABILITY_GAP_BOUNDARY.derivesFromCoverageOnly).toBe(true);
    expect(RSI_CAPABILITY_GAP_BOUNDARY.writesDatabase).toBe(false);
  });
});
