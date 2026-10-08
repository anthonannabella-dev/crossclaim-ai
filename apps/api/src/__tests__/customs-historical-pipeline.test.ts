// HISTORICAL_RECOVERY_SCAN_V1 / PHASE 8（纯函数 + 既有 drawback 路径）
// 断言：复用既有链、四种结果、未核验/缺证据/缺匹配不得 CLAIM_READY、申报请求被拒、边界恒为 false。

import { describe, expect, it } from 'vitest';

import {
  CUSTOMS_HISTORICAL_PIPELINE_BOUNDARY,
  CustomsHistoricalBoundaryError,
  evaluateCustomsHistoricalBatch,
  evaluateCustomsHistoricalCandidate,
} from '../services/historical-scan/customs-historical-pipeline';
import type { CustomsHistoricalCandidateInput } from '../services/historical-scan/customs-historical-pipeline';

const NOW = new Date('2026-10-08T00:00:00.000Z');
const SCOPE = { organizationId: 'org-1', platformAccountId: 'acct-1' };

// 说明：drawback route 只读取以下字段（chainStatus / status / dates / hts），
// 测试提供满足其读取契约的最小 fixture（不构造第二套模型）。
// drawback route 读取 chainStatus 与 chain.missing / partial / lowConfidence（用于缺件列表）
const COMPLETE_CHAIN = { chainStatus: 'COMPLETE', missing: [], partial: [], lowConfidence: [] } as never;
const EXACT_MATCH = { status: 'EXACT' } as never;
const PARTIAL_MATCH = { status: 'PARTIAL' } as never;
const VERIFIED_POLICY = {
  policyId: 'us-drawback-v1',
  policyVersion: '1.0.0',
  anchorField: 'exportDate' as const,
  daysFromAnchor: 1825,
  verification: 'LEGAL_VERIFIED' as const,
};

function candidate(
  overrides: Partial<CustomsHistoricalCandidateInput> = {},
): CustomsHistoricalCandidateInput {
  return {
    scope: SCOPE,
    entryNumber: 'ENTRY-1',
    hts: '8471.30.0100',
    jurisdiction: 'US',
    entryDate: '2025-01-01',
    liquidationDate: '2025-06-01',
    exportDate: '2026-06-01',
    destructionDate: null,
    evidenceChain: COMPLETE_CHAIN,
    counterpartMatch: EXACT_MATCH,
    verifiedDeadlinePolicy: VERIFIED_POLICY,
    requestFiling: false,
    now: NOW,
    ...overrides,
  };
}

describe('PHASE 8 · customs historical pipeline（复用既有链）', () => {
  it('边界声明：复用既有链、无第二引擎、最高 CLAIM_READY、永不申报', () => {
    expect(CUSTOMS_HISTORICAL_PIPELINE_BOUNDARY.reusesExistingChain).toBe(true);
    expect(CUSTOMS_HISTORICAL_PIPELINE_BOUNDARY.secondCustomsTruth).toBe(false);
    expect(CUSTOMS_HISTORICAL_PIPELINE_BOUNDARY.secondEligibilityEngine).toBe(false);
    expect(CUSTOMS_HISTORICAL_PIPELINE_BOUNDARY.secondDeadlineEngine).toBe(false);
    expect(CUSTOMS_HISTORICAL_PIPELINE_BOUNDARY.autoFilingAllowed).toBe(false);
    expect(CUSTOMS_HISTORICAL_PIPELINE_BOUNDARY.llmDecidesDeadlines).toBe(false);
  });

  it('证据完整 + EXACT 匹配 + 已核验政策 → CLAIM_READY（且仍不申报、不收费、不算金额）', () => {
    const result = evaluateCustomsHistoricalCandidate(candidate());
    expect(result.outcome).toBe('CLAIM_READY');
    expect(result.filingPerformed).toBe(false);
    expect(result.billable).toBe(false);
    expect(result.paymentPerformed).toBe(false);
    expect(result.externalWritePerformed).toBe(false);
    expect(result.route.amount.amountComputation).toBe('NOT_PERFORMED');
    expect(result.route.estimateOnly).toBe(true);
  });

  it('缺证据链 → 不得 CLAIM_READY（NEEDS_EVIDENCE）', () => {
    const result = evaluateCustomsHistoricalCandidate(candidate({ evidenceChain: null }));
    expect(result.outcome).toBe('NEEDS_EVIDENCE');
    expect(result.reasonCodes).toContain('EVIDENCE_CHAIN_MISSING');
  });

  it('匹配非 EXACT（PARTIAL）→ 不得 CLAIM_READY', () => {
    const result = evaluateCustomsHistoricalCandidate(candidate({ counterpartMatch: PARTIAL_MATCH }));
    expect(result.outcome).not.toBe('CLAIM_READY');
    expect(result.route.gates.find((gate) => gate.gate === 'COUNTERPART_MATCH_EXACT')?.passed).toBe(false);
  });

  it('未提供已核验政策 → 不得 CLAIM_READY（INDETERMINATE → NEEDS_MANUAL_REVIEW）', () => {
    const result = evaluateCustomsHistoricalCandidate(candidate({ verifiedDeadlinePolicy: null }));
    expect(result.outcome).not.toBe('CLAIM_READY');
  });

  it('HTS 9801/9802 特别条款 → 不是 drawback（NOT_CANDIDATE）', () => {
    const result = evaluateCustomsHistoricalCandidate(candidate({ hts: '9801.00.1012' }));
    expect(result.outcome).toBe('NOT_CANDIDATE');
    expect(result.reasonCodes).toContain('SPECIAL_PROVISION_IS_NOT_DRAWBACK');
  });

  it('请求申报（requestFiling=true）→ 显式拒绝（历史扫描永不申报）', () => {
    expect(() => evaluateCustomsHistoricalCandidate(candidate({ requestFiling: true }))).toThrowError(
      CustomsHistoricalBoundaryError,
    );
  });

  it('批量：统计四种结果 + 边界恒为 false；过期按 reason code 归类', () => {
    const batch = evaluateCustomsHistoricalBatch([
      candidate(),
      candidate({ entryNumber: 'ENTRY-2', evidenceChain: null }),
      candidate({ entryNumber: 'ENTRY-3', hts: '9802.00.8065' }),
      candidate({ entryNumber: 'ENTRY-4', verifiedDeadlinePolicy: null }),
    ]);
    expect(batch.summary.scanned).toBe(4);
    expect(batch.summary.claimReady).toBe(1);
    expect(batch.summary.needsEvidence).toBe(1);
    expect(batch.summary.notCandidate).toBe(1);
    expect(batch.summary.needsManualReview).toBe(1);
    expect(batch.summary.opportunitiesSurfaced).toBe(3);
    expect(batch.summary.filingPerformed).toBe(false);
    expect(batch.summary.billable).toBe(false);
    expect(batch.summary.paymentPerformed).toBe(false);
    expect(batch.summary.externalWritePerformed).toBe(false);
    expect(batch.summary.boundaryVerified).toBe(true);
  });

  // ============================================================
  // AUDIT-1 / CHANGE 1（MSG-20261008-01）：必须消费 Historical Window 的 blocksClaimReady
  // ============================================================
  it('CHANGE 1-①：缺 jurisdiction（其余条件完美）→ 永不 CLAIM_READY，且保留 MISSING_JURISDICTION', () => {
    const result = evaluateCustomsHistoricalCandidate(candidate({ jurisdiction: null }));
    expect(result.outcome).not.toBe('CLAIM_READY');
    expect(result.outcome).toBe('NEEDS_MANUAL_REVIEW');
    expect(result.reasonCodes).toContain('MISSING_JURISDICTION');
  });

  it('CHANGE 1-②：blocksClaimReady=true 且底层 route 本会 CLAIM_READY → 历史结果被降级阻断', () => {
    const result = evaluateCustomsHistoricalCandidate(
      candidate({
        historicalWindow: { blocksClaimReady: true, reasonCodes: ['RULE_UNVERIFIED', 'MISSING_ANCHOR'] },
      }),
    );
    expect(result.outcome).toBe('NEEDS_MANUAL_REVIEW');
    expect(result.reasonCodes).toContain('HISTORICAL_WINDOW_BLOCKS_CLAIM_READY');
    expect(result.reasonCodes).toContain('RULE_UNVERIFIED');
    expect(result.reasonCodes).toContain('MISSING_ANCHOR');
    expect(result.filingPerformed).toBe(false);
  });

  it('CHANGE 1-③：blocksClaimReady=false + 完整已核验 US candidate → CLAIM_READY 仍正常', () => {
    const result = evaluateCustomsHistoricalCandidate(
      candidate({ historicalWindow: { blocksClaimReady: false, reasonCodes: ['FULL_COVERAGE'] } }),
    );
    expect(result.outcome).toBe('CLAIM_READY');
    expect(result.reasonCodes).not.toContain('MISSING_JURISDICTION');
  });
});
