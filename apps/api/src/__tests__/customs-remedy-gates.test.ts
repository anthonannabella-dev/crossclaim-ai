// HISTORICAL_RECOVERY_SCAN_V1 / PHASE 5（纯函数）
// Customs remedy-specific 双 gate：未核验 → INDETERMINATE 且不得 CLAIM_READY；不以统一「5 年」兜底。

import { describe, expect, it } from 'vitest';

import {
  evaluateRemedyGates,
  REMEDY_GATE_BOUNDARY,
  type RemedyGatePolicy,
} from '../services/customs/enterprise-ior/remedy-gates';

const NOW = '2026-10-08T00:00:00.000Z';

const DRAWBACK_UNVERIFIED: RemedyGatePolicy = {
  policyId: 'us-drawback-v1',
  policyVersion: '1.0.0',
  jurisdiction: 'US',
  remedy: 'DRAWBACK',
  verification: 'UNVERIFIED',
  claimFilingDeadline: null,
  qualifyingWindow: { anchorField: 'exportDate', daysFromAnchor: 1825 },
};

const DRAWBACK_VERIFIED: RemedyGatePolicy = {
  ...DRAWBACK_UNVERIFIED,
  verification: 'LEGAL_VERIFIED',
  claimFilingDeadline: { anchorField: 'liquidationDate', daysFromAnchor: 365 },
};

const PROTEST_VERIFIED: RemedyGatePolicy = {
  policyId: 'us-protest-v1',
  policyVersion: '1.0.0',
  jurisdiction: 'US',
  remedy: 'PROTEST',
  verification: 'LEGAL_VERIFIED',
  claimFilingDeadline: { anchorField: 'liquidationDate', daysFromAnchor: 180 },
  qualifyingWindow: null,
};

describe('PHASE 5 · Customs remedy 双 gate', () => {
  it('边界声明：不存在全球统一年限规则；未核验阻断 CLAIM_READY；不做外部动作', () => {
    expect(REMEDY_GATE_BOUNDARY.globalUniformYearRule).toBe(false);
    expect(REMEDY_GATE_BOUNDARY.unverifiedBlocksClaimReady).toBe(true);
    expect(REMEDY_GATE_BOUNDARY.autoFilingAllowed).toBe(false);
  });

  it('drawback：未 LEGAL_VERIFIED → INDETERMINATE，claimReadyAllowed=false（即使窗口内）', () => {
    const result = evaluateRemedyGates({
      jurisdiction: 'US',
      remedy: 'DRAWBACK',
      facts: { entryDate: '2022-01-01', exportDate: '2024-01-01' },
      now: NOW,
      policies: [DRAWBACK_UNVERIFIED],
    });
    expect(result.status).toBe('INDETERMINATE');
    expect(result.reasonCodes).toContain('RULE_UNVERIFIED');
    expect(result.claimReadyAllowed).toBe(false);
    expect(result.autoFilingAllowed).toBe(false);
    expect(result.qualifyingGate.status).toBe('PASS'); // 窗口本身在有效期内
  });

  it('drawback：已核验但缺 filing gate 建模 → 仍然 INDETERMINATE（不兜底）', () => {
    const result = evaluateRemedyGates({
      jurisdiction: 'US',
      remedy: 'DRAWBACK',
      facts: { entryDate: '2022-01-01', exportDate: '2024-01-01', liquidationDate: '2026-01-01' },
      now: NOW,
      policies: [{ ...DRAWBACK_VERIFIED, claimFilingDeadline: null }],
    });
    expect(result.status).toBe('INDETERMINATE');
    expect(result.reasonCodes).toContain('FILING_GATE_NOT_MODELED');
    expect(result.claimReadyAllowed).toBe(false);
  });

  it('drawback：已核验 + 两 gate 都在窗口内 → CLAIM_READY（但仍不 filing）', () => {
    const result = evaluateRemedyGates({
      jurisdiction: 'US',
      remedy: 'DRAWBACK',
      facts: { entryDate: '2022-01-01', exportDate: '2025-06-01', liquidationDate: '2026-06-01' },
      now: NOW,
      policies: [DRAWBACK_VERIFIED],
    });
    expect(result.status).toBe('CLAIM_READY');
    expect(result.claimReadyAllowed).toBe(true);
    expect(result.autoFilingAllowed).toBe(false);
    expect(result.filingGate.status).toBe('PASS');
    expect(result.qualifyingGate.status).toBe('PASS');
  });

  it('drawback：缺出口/销毁事实 → QUALIFYING gate INDETERMINATE（缺 anchor 不猜测）', () => {
    const result = evaluateRemedyGates({
      jurisdiction: 'US',
      remedy: 'DRAWBACK',
      facts: { entryDate: '2022-01-01', liquidationDate: '2026-06-01' },
      now: NOW,
      policies: [DRAWBACK_VERIFIED],
    });
    expect(result.qualifyingGate.status).toBe('INDETERMINATE');
    expect(result.reasonCodes).toContain('MISSING_ANCHOR:exportDate');
    expect(result.claimReadyAllowed).toBe(false);
  });

  it('drawback：出口窗口已过 1825 天 → EXPIRED（不得 CLAIM_READY）', () => {
    const result = evaluateRemedyGates({
      jurisdiction: 'US',
      remedy: 'DRAWBACK',
      facts: { entryDate: '2019-01-01', exportDate: '2019-06-01', liquidationDate: '2026-06-01' },
      now: NOW,
      policies: [DRAWBACK_VERIFIED],
    });
    expect(result.status).toBe('EXPIRED');
    expect(result.reasonCodes).toContain('GATE_EXPIRED');
    expect(result.claimReadyAllowed).toBe(false);
  });

  it('不同 remedy 使用各自窗口（PROTEST 无 qualifying window → INDETERMINATE，不被 drawback 的 5 年覆盖）', () => {
    const protest = evaluateRemedyGates({
      jurisdiction: 'US',
      remedy: 'PROTEST',
      facts: { liquidationDate: '2026-06-01' },
      now: NOW,
      policies: [PROTEST_VERIFIED],
    });
    expect(protest.status).toBe('INDETERMINATE');
    expect(protest.reasonCodes).toContain('QUALIFYING_GATE_NOT_MODELED');
    expect(protest.claimReadyAllowed).toBe(false);
  });

  it('无适用政策 → INDETERMINATE（不套用统一年限）', () => {
    const result = evaluateRemedyGates({
      jurisdiction: 'DE',
      remedy: 'DRAWBACK',
      facts: { exportDate: '2024-01-01' },
      now: NOW,
      policies: [DRAWBACK_VERIFIED],
    });
    expect(result.status).toBe('INDETERMINATE');
    expect(result.reasonCodes).toContain('NO_POLICY_FOR_JURISDICTION_REMEDY');
  });
});
