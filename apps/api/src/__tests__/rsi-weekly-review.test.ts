/** Weekly Full-System Review 验收：机器可读、失败/跳过必须显式、能力缺口成信号。 */

import { describe, expect, it } from 'vitest';

import {
  RSI_WEEKLY_REVIEW_BOUNDARY,
  RSI_WEEKLY_SUITES,
  runWeeklyReview,
} from '../services/autonomy/rsi-weekly-review';

const NOW = new Date('2026-10-05T04:00:00.000Z');
const pass = async () => ({ status: 'PASS' as const, metrics: { cases: 10 } });

describe('RSI Weekly Full-System Review', () => {
  it('RSI_WEEKLY_ALL_SUITES_LISTED：15 个套件全部登记在结果中（缺失即 SKIPPED，不静默）', async () => {
    const report = await runWeeklyReview({ now: NOW, suites: {} });
    expect(report.job).toBe('RSI_WEEKLY_FULL_SYSTEM_REVIEW');
    expect(report.schema).toBe('rsi-weekly-review-v1');
    expect(report.suites).toHaveLength(RSI_WEEKLY_SUITES.length);
    expect(report.summary.skipped).toBe(RSI_WEEKLY_SUITES.length);
    // 缺失套件必须产出显式 SKIPPED finding（不静默跳过）
    expect(report.findings.every((finding) => finding.reasonCode === 'SUITE_SKIPPED')).toBe(true);
    expect(report.incidentRequired).toBe(true);
    expect(RSI_WEEKLY_REVIEW_BOUNDARY.silentlySkippedSuites).toBe(false);
  });

  it('RSI_WEEKLY_MACHINE_READABLE_AND_SILENT_WHEN_ALL_PASS：全绿时零 finding，结果含指标', async () => {
    const suites = Object.fromEntries(RSI_WEEKLY_SUITES.map((suite) => [suite, pass]));
    const report = await runWeeklyReview({ now: NOW, suites });
    expect(report.summary).toEqual({ passed: RSI_WEEKLY_SUITES.length, failed: 0, skipped: 0 });
    expect(report.findings).toEqual([]);
    expect(report.incidentRequired).toBe(false);
    // 机器可读：每条结果都带结构化字段
    for (const entry of report.suites) {
      expect(entry).toHaveProperty('suite');
      expect(entry).toHaveProperty('status');
      expect(typeof entry.metrics).toBe('object');
    }
    expect(RSI_WEEKLY_REVIEW_BOUNDARY.machineReadable).toBe(true);
    expect(RSI_WEEKLY_REVIEW_BOUNDARY.writesDatabase).toBe(false);
    expect(RSI_WEEKLY_REVIEW_BOUNDARY.performsExternalWrite).toBe(false);
    expect(RSI_WEEKLY_REVIEW_BOUNDARY.readsCredentials).toBe(false);
  });

  it('RSI_WEEKLY_FAILURES_AND_CAPABILITY_GAP_REQUIRE_INCIDENTS：失败与能力缺口必须建 Incident', async () => {
    const report = await runWeeklyReview({
      now: NOW,
      suites: {
        POSTGRES_E2E: async () => ({ status: 'FAIL', metrics: { failed: 2 }, detail: 'pg e2e failed' }),
        CAPABILITY_GAP: async () => ({ status: 'FAIL', detail: 'no checker for carrier X' }),
        TOKEN_API_COST: async () => ({ status: 'PASS', metrics: { usd: 0.42 } }),
        BUSINESS_INVARIANTS: async () => ({ status: 'FAIL', privilegeAffecting: true }),
      },
    });
    const byCategory = new Map(report.findings.map((finding) => [finding.suite, finding]));
    expect(byCategory.get('POSTGRES_E2E')?.reasonCode).toBe('SUITE_FAILED');
    expect(byCategory.get('CAPABILITY_GAP')?.reasonCode).toBe('CAPABILITY_GAP');
    expect(byCategory.get('BUSINESS_INVARIANTS')?.riskClass).toBe('HIGH');
    expect(byCategory.get('BUSINESS_INVARIANTS')?.reasonCode).toBe('SECURITY_OR_PRIVILEGE');
    for (const finding of report.findings) {
      expect(finding.incidentRequired).toBe(true);
      expect(finding.dedupeKey).toBe(`WEEKLY_REVIEW:${finding.suite}:2026-10-05`);
    }
    expect(report.summary.failed).toBe(3);
    expect(report.summary.passed).toBe(1);
  });
});
