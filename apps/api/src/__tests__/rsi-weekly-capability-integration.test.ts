/**
 * 集成证据：GoldenFixture 覆盖缺口 → Weekly Review 的 CAPABILITY_GAP 套件。
 * 证明「能力缺口会作为失败套件进入周审并要求 Incident」，而不是只停留在报告里。
 */

import { describe, expect, it } from 'vitest';

import { capabilityGapSuiteFromCoverage } from '../services/autonomy/rsi-capability-gap';
import {
  goldenCoverageReport,
  type RsiGoldenFixture,
  type RsiGoldenFixtureDomain,
} from '../services/autonomy/rsi-golden-fixtures';
import { RSI_WEEKLY_SUITES, runWeeklyReview, type RsiSuiteResult } from '../services/autonomy/rsi-weekly-review';

const D = 'a'.repeat(64);
const fixture = (domain: RsiGoldenFixtureDomain): RsiGoldenFixture => ({
  fixtureId: `fx-${domain}`,
  domain,
  sourceKind: 'SYNTHETIC',
  sanitized: true,
  inputDigest: D,
  expectedDigest: D,
  invariants: ['no_external_write'],
  recordedAt: '2026-10-05T00:00:00.000Z',
});

const allDomains: RsiGoldenFixtureDomain[] = [
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
];

const NOW = new Date('2026-10-05T04:00:00.000Z');

const greenSuites = (overrides: Record<string, () => Promise<RsiSuiteResult>>) => ({
  ...Object.fromEntries(
    RSI_WEEKLY_SUITES.filter((suite) => !(suite in overrides)).map((suite) => [
      suite,
      async () => ({ status: 'PASS' as const }),
    ]),
  ),
  ...overrides,
});

describe('Weekly Review × 能力缺口集成', () => {
  it('RSI_WEEKLY_CAPABILITY_GAP_FAILS_REVIEW：覆盖缺口 → CAPABILITY_GAP FAIL → 要求 Incident', async () => {
    const coverage = goldenCoverageReport([fixture('AMAZON_SETTLEMENT')]);
    expect(coverage.capabilityGap).toBe(true);

    const report = await runWeeklyReview({
      now: NOW,
      suites: greenSuites({ CAPABILITY_GAP: async () => capabilityGapSuiteFromCoverage(coverage) }),
    });

    expect(report.summary.failed).toBe(1);
    expect(report.incidentRequired).toBe(true);
    const finding = report.findings.find((entry) => entry.suite === 'CAPABILITY_GAP')!;
    expect(finding.reasonCode).toBe('CAPABILITY_GAP');
    expect(finding.incidentRequired).toBe(true);
    expect(finding.dedupeKey).toBe('WEEKLY_REVIEW:CAPABILITY_GAP:2026-10-05');
    const metrics = report.suites.find((entry) => entry.suite === 'CAPABILITY_GAP')!.metrics;
    expect(metrics.coveredDomains).toBe(1);
    expect(metrics.missingDomains).toBe(allDomains.length - 1);
  });

  it('RSI_WEEKLY_CAPABILITY_GAP_PASSES_WHEN_COVERED：全覆盖 → PASS，周审零 Incident', async () => {
    const coverage = goldenCoverageReport(allDomains.map((domain) => fixture(domain)));
    expect(coverage.capabilityGap).toBe(false);

    const report = await runWeeklyReview({
      now: NOW,
      suites: greenSuites({ CAPABILITY_GAP: async () => capabilityGapSuiteFromCoverage(coverage) }),
    });
    expect(report.summary).toEqual({ passed: RSI_WEEKLY_SUITES.length, failed: 0, skipped: 0 });
    expect(report.incidentRequired).toBe(false);
    expect(report.findings).toEqual([]);
  });
});
