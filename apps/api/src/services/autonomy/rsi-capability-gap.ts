/**
 * RSI 能力缺口信号（把 GoldenFixture 覆盖报告接进 Weekly Review）
 * ---------------------------------------------------------------
 * 依据 OWNER《Continuous Inspection》第 3 节：Weekly Review 必须能发现 **capability gap**。
 * 本模块把 `goldenCoverageReport()` 的缺失域转成 Weekly Review 的 `CAPABILITY_GAP` 套件结果：
 *   · 缺域 → FAIL（Weekly Review 据此产 Incident）；
 *   · 全覆盖 → PASS（静默）；
 *   · 被拒 fixture 一并计入 detail（不静默丢弃），但**不含任何内容/PII**。
 */

import type { RsiGoldenCoverageReport } from './rsi-golden-fixtures';
import type { RsiSuiteResult } from './rsi-weekly-review';

export function capabilityGapSuiteFromCoverage(report: RsiGoldenCoverageReport): RsiSuiteResult {
  const metrics = {
    coveredDomains: report.covered.length,
    missingDomains: report.missing.length,
    rejectedFixtures: report.rejected.length,
  };

  if (report.missing.length === 0 && report.rejected.length === 0) {
    return { status: 'PASS', metrics };
  }

  // 仅列出**域名标识**与数量，不包含 fixture 内容（避免把语料带进审核面）。
  const detailParts: string[] = [];
  if (report.missing.length > 0) detailParts.push(`missing domains: ${report.missing.join(', ')}`);
  if (report.rejected.length > 0) detailParts.push(`rejected fixtures: ${report.rejected.length}`);
  return { status: 'FAIL', metrics, detail: detailParts.join('; ') };
}

export const RSI_CAPABILITY_GAP_BOUNDARY = {
  derivesFromCoverageOnly: true,
  includesFixtureContent: false,
  writesDatabase: false,
  performsExternalWrite: false,
} as const;
