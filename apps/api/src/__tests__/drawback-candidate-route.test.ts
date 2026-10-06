// CUSTOMS / DUTY RECOVERY — slice B-S8 — Drawback 专门路径回归（fail-closed，最高只到 CLAIM_READY）
// ---------------------------------------------------------------------------
// 覆盖：四态路由、9801/9802 直接 NOT_CANDIDATE、未核验期限不得 CLAIM_READY、
//   LEGAL_VERIFIED 期限政策才可放行、证据链/匹配门禁、冲突与歧义 → NEEDS_MANUAL_REVIEW、
//   不计算金额 / 不收费 / 不申报、边界断言、确定性摘要。

import { describe, expect, it } from 'vitest';

import {
  DRAWBACK_DISPOSITIONS,
  DRAWBACK_ROUTE_BOUNDARY,
  DRAWBACK_ROUTE_VERSION,
  DrawbackRouteError,
  assertDrawbackHtsNotSpecialProvision,
  assertDrawbackRouteIsFailClosed,
  evaluateDrawbackCandidateRoute,
  type DrawbackCandidateRouteInput,
} from '../services/customs/drawback/drawback-candidate-route';
import type {
  CustomsEvidenceChainResult,
  CustomsMatchResult,
} from '../services/provider-support';

const NOW = new Date('2026-10-06T19:00:00.000Z');
const SCOPE = { organizationId: 'org-db-1', platformAccountId: 'acct-db-a' };

function evidenceChain(status: CustomsEvidenceChainResult['chainStatus']): CustomsEvidenceChainResult {
  return {
    kind: 'CUSTOMS_EVIDENCE_CHAIN',
    version: 'customs-evidence-requirements/v1',
    organizationId: SCOPE.organizationId,
    platformAccountId: SCOPE.platformAccountId,
    tag: null,
    outcomes: [],
    chainStatus: status,
    found: [],
    partial: status === 'PARTIAL' ? ['ENTRY_LINE'] : [],
    missing: status === 'INSUFFICIENT' ? ['EXPORT_RECORD'] : [],
    lowConfidence: [],
    blockedBy: status === 'BLOCKED' ? ['ENTRY_RECORD'] : [],
    mayProceedToClaimPreparation: status === 'COMPLETE',
    evidenceCompleteDoesNotImplyEligibility: true,
    mutatesEvidence: false,
    decidesEligibility: false,
    requiresManualReview: status !== 'COMPLETE',
    reasons: [],
    evaluatedAt: NOW.toISOString(),
    chainDigest: 'digest-' + status,
  } as CustomsEvidenceChainResult;
}

function counterpartMatch(
  status: CustomsMatchResult['status'],
  recordId: string | null = status === 'EXACT' ? 'exp-1' : null,
): CustomsMatchResult {
  return {
    kind: 'CUSTOMS_IMPORT_EXPORT_MATCH',
    version: 'customs-import-export-matching/v1',
    organizationId: SCOPE.organizationId,
    platformAccountId: SCOPE.platformAccountId,
    lineId: 'line-1',
    status,
    matches: [],
    bestMatch: recordId
      ? {
          recordId,
          recordKind: 'EXPORT',
          status: 'EXACT',
          score: 5,
          matchedBy: 'TRACKING_NUMBER',
          dimensions: { hts: 'EXACT', currency: 'EXACT', jurisdiction: 'EXACT', customsValue: 'EXACT' },
          mismatchedDimensions: [],
          reasons: [],
        }
      : null,
    ambiguousBetween: status === 'AMBIGUOUS' ? ['exp-1', 'exp-2'] : [],
    rejectedForScope: [],
    consistency: { tenantScoped: true, accountScoped: true, missingDimensions: [] },
    automaticSelectionPerformed: false,
    decidesEligibility: false,
    canonicalWritePerformed: false,
    requiresManualReview: status !== 'EXACT',
    reasons: [],
    matchedAt: NOW.toISOString(),
    matchDigest: 'digest-match-' + status,
  } as CustomsMatchResult;
}

function evaluate(overrides: Partial<DrawbackCandidateRouteInput> = {}) {
  return evaluateDrawbackCandidateRoute({
    scope: SCOPE,
    entryNumber: 'ABC-123456',
    hts: '8471.30.01',
    jurisdiction: 'US',
    entryDate: '2026-08-01',
    evidenceChain: evidenceChain('COMPLETE'),
    counterpartMatch: counterpartMatch('EXACT'),
    now: NOW,
    ...overrides,
  });
}

describe('B-S8 Drawback 路由 — 四态判定', () => {
  it('全部门禁通过 + 未核验期限 → 不得 CLAIM_READY（NEEDS_MANUAL_REVIEW）', () => {
    const route = evaluate();
    expect(route.kind).toBe('DRAWBACK_CANDIDATE_ROUTE');
    expect(route.version).toBe(DRAWBACK_ROUTE_VERSION);
    expect(route.disposition).toBe('NEEDS_MANUAL_REVIEW');
    expect(route.maxDisposition).toBe('CLAIM_READY');
    expect(route.deadline.status).toBe('INDETERMINATE');
    expect(route.deadline.reasonCodes).toContain('DEADLINE_POLICY_UNVERIFIED');
    expect(route.blockingReasons).toContain('DEADLINE_NOT_ELIGIBLE_WINDOW');
    expect(route.gates.find((g) => g.gate === 'DEADLINE_WINDOW_ELIGIBLE')?.passed).toBe(false);
  });

  it('提供 LEGAL_VERIFIED 期限政策且窗口有效 → CLAIM_READY（仍不申报、不计费）', () => {
    const route = evaluate({
      verifiedDeadlinePolicy: {
        policyId: 'legal:db:deadline',
        policyVersion: 'v1',
        anchorField: 'exportDate',
        daysFromAnchor: 1_825,
        verification: 'LEGAL_VERIFIED',
        verifiedBy: 'legal-counsel',
        verifiedAt: '2026-10-05',
      },
      exportDate: '2026-09-01',
    });
    expect(route.disposition).toBe('CLAIM_READY');
    expect(route.deadline.status).toBe('ELIGIBLE_WINDOW');
    expect(route.deadline.verification).toBe('LEGAL_VERIFIED');
    expect(route.deadline.reasonCodes).toContain('LEGAL_VERIFIED_POLICY_APPLIED');
    expect(route.filingPerformed).toBe(false);
    expect(route.billable).toBe(false);
    expect(route.autoFilingAllowed).toBe(false);
    expect(route.brokerFilingHandoffRequired).toBe(true);
  });

  it('LEGAL_VERIFIED 政策但窗口已过 → NEEDS_MANUAL_REVIEW（不得 CLAIM_READY）', () => {
    const route = evaluate({
      verifiedDeadlinePolicy: {
        policyId: 'legal:db:deadline',
        policyVersion: 'v1',
        anchorField: 'exportDate',
        daysFromAnchor: 30,
        verification: 'LEGAL_VERIFIED',
      },
      exportDate: '2026-01-01',
    });
    expect(route.disposition).toBe('NEEDS_MANUAL_REVIEW');
    expect(route.deadline.status).toBe('EXPIRED');
    expect(route.blockingReasons).toContain('DEADLINE_NOT_ELIGIBLE_WINDOW');
  });

  it('HTS 9801 / 9802 → NOT_CANDIDATE（特别条款不是 drawback）', () => {
    const de9810 = evaluate({ hts: '9801.00.10' });
    expect(de9810.disposition).toBe('NOT_CANDIDATE');
    expect(de9810.reasonCodes).toContain('SPECIAL_PROVISION_IS_NOT_DRAWBACK');
    expect(de9810.gates.find((g) => g.gate === 'HTS_NOT_SPECIAL_PROVISION_9801_9802')?.passed).toBe(false);

    const usGoods = evaluate({ hts: '9802.00.80' });
    expect(usGoods.disposition).toBe('NOT_CANDIDATE');
  });

  it('证据链未完整 → NEEDS_EVIDENCE（列出缺失需求）', () => {
    const route = evaluate({ evidenceChain: evidenceChain('INSUFFICIENT') });
    expect(route.disposition).toBe('NEEDS_EVIDENCE');
    expect(route.blockingReasons).toContain('EVIDENCE_NOT_COMPLETE');
    expect(route.requiredEvidenceMissing).toContain('EXPORT_RECORD');
  });

  it('无证据链 → NEEDS_EVIDENCE + EVIDENCE_CHAIN_MISSING', () => {
    const route = evaluate({ evidenceChain: null });
    expect(route.disposition).toBe('NEEDS_EVIDENCE');
    expect(route.reasonCodes).toContain('EVIDENCE_CHAIN_MISSING');
  });

  it('匹配非 EXACT（NO_MATCH / PARTIAL）→ NEEDS_EVIDENCE', () => {
    for (const status of ['NO_MATCH', 'PARTIAL'] as const) {
      const route = evaluate({ counterpartMatch: counterpartMatch(status) });
      expect(route.disposition).toBe('NEEDS_EVIDENCE');
      expect(route.reasonCodes).toContain(`COUNTERPART_MATCH_${status}`);
    }
  });

  it('证据链冲突或匹配歧义 → NEEDS_MANUAL_REVIEW（优先于缺证据）', () => {
    const blocked = evaluate({
      evidenceChain: evidenceChain('BLOCKED'),
      counterpartMatch: counterpartMatch('NO_MATCH'),
    });
    expect(blocked.disposition).toBe('NEEDS_MANUAL_REVIEW');
    expect(blocked.reasonCodes).toContain('HUMAN_REVIEW_REQUIRED_FOR_CONFLICT_OR_AMBIGUITY');

    const ambiguous = evaluate({ counterpartMatch: counterpartMatch('AMBIGUOUS') });
    expect(ambiguous.disposition).toBe('NEEDS_MANUAL_REVIEW');
  });

  it('非 US 辖区（无规则包）→ NEEDS_MANUAL_REVIEW + NO_RULE_PACK_FOR_JURISDICTION', () => {
    const route = evaluate({ jurisdiction: 'UK' });
    expect(route.disposition).toBe('NEEDS_MANUAL_REVIEW');
    expect(route.reasonCodes).toContain('NO_RULE_PACK_FOR_JURISDICTION');
    expect(route.ruleSetId).toBeNull();
  });
});

describe('B-S8 — 金额 / 计费 / 申报边界', () => {
  it('永不计算金额、永不收费、永不申报', () => {
    const route = evaluate({
      verifiedDeadlinePolicy: {
        policyId: 'legal:db:deadline',
        policyVersion: 'v1',
        anchorField: 'exportDate',
        daysFromAnchor: 1_825,
        verification: 'LEGAL_VERIFIED',
      },
      exportDate: '2026-09-01',
    });
    expect(route.amount.estimatedRecoverableAmountUsd).toBeNull();
    expect(route.amount.amountComputation).toBe('NOT_PERFORMED');
    expect(route.estimateOnly).toBe(true);
    expect(route.billable).toBe(false);
    expect(route.filingPerformed).toBe(false);
    expect(route.llmDecided).toBe(false);
    expect(() => assertDrawbackRouteIsFailClosed(route)).not.toThrow();
  });

  it('试图直接申报（requestFiling=true）→ fail-closed 抛错', () => {
    expect(() => evaluate({ requestFiling: true })).toThrowError(DrawbackRouteError);
    try {
      evaluate({ requestFiling: true });
    } catch (error) {
      expect((error as { code?: string }).code).toBe('DRAWBACK_ROUTE_CANNOT_EXCEED_CLAIM_READY');
    }
  });

  it('assertDrawbackRouteIsFailClosed：已申报 / 已计费 / 已算金额 / 非法状态一律拒绝', () => {
    expect(() => assertDrawbackRouteIsFailClosed({ filingPerformed: true as never })).toThrowError(DrawbackRouteError);
    expect(() => assertDrawbackRouteIsFailClosed({ billable: true as never })).toThrowError(DrawbackRouteError);
    expect(() => assertDrawbackRouteIsFailClosed({ autoFilingAllowed: true as never })).toThrowError(
      DrawbackRouteError,
    );
    expect(() => assertDrawbackRouteIsFailClosed({ amountComputation: 'COMPUTED' })).toThrowError(DrawbackRouteError);
    expect(() => assertDrawbackRouteIsFailClosed({ disposition: 'FILED' as never })).toThrowError(DrawbackRouteError);
    expect(DRAWBACK_DISPOSITIONS).not.toContain('FILED' as never);
  });

  it('边界常量：最高 CLAIM_READY、不自动申报、不计费、不判佣金、9801·9802 不是 drawback', () => {
    expect(DRAWBACK_ROUTE_BOUNDARY.maxDisposition).toBe('CLAIM_READY');
    expect(DRAWBACK_ROUTE_BOUNDARY.autoFilingAllowed).toBe(false);
    expect(DRAWBACK_ROUTE_BOUNDARY.filingPerformed).toBe(false);
    expect(DRAWBACK_ROUTE_BOUNDARY.billable).toBe(false);
    expect(DRAWBACK_ROUTE_BOUNDARY.estimateOnly).toBe(true);
    expect(DRAWBACK_ROUTE_BOUNDARY.computesRecoverableAmount).toBe(false);
    expect(DRAWBACK_ROUTE_BOUNDARY.determinesSuccessFeeEligibility).toBe(false);
    expect(DRAWBACK_ROUTE_BOUNDARY.specialProvisions9801And9802AreNotDrawback).toBe(true);
    expect(DRAWBACK_ROUTE_BOUNDARY.unverifiedDeadlineBlocksClaimReady).toBe(true);
    expect(DRAWBACK_ROUTE_BOUNDARY.forbidden).toContain('filing or transmitting a drawback claim');
    expect(DRAWBACK_ROUTE_BOUNDARY.forbidden).toContain('reaching CLAIM_READY with an unverified deadline policy');
  });

  it('assertDrawbackHtsNotSpecialProvision 与规则包口径一致', () => {
    expect(() => assertDrawbackHtsNotSpecialProvision('9801.00.10')).toThrowError(DrawbackRouteError);
    expect(() => assertDrawbackHtsNotSpecialProvision('9802.00.80')).toThrowError(DrawbackRouteError);
    expect(() => assertDrawbackHtsNotSpecialProvision('8471.30.01')).not.toThrow();
  });

  it('确定性：同输入同 now → 同 routeDigest；门禁变化 → 摘要变', () => {
    const a = evaluate();
    const b = evaluate();
    const c = evaluate({ evidenceChain: evidenceChain('INSUFFICIENT') });
    expect(a.routeDigest).toBe(b.routeDigest);
    expect(a.routeDigest).not.toBe(c.routeDigest);
    expect(a.routeDigest).toHaveLength(64);
    expect(a.evaluatedAt).toBe(NOW.toISOString());
  });

  it('门禁清单完整（规则包 / 特别条款 / 证据链 / 匹配 / 期限）', () => {
    const route = evaluate();
    expect(route.gates.map((g) => g.gate)).toEqual([
      'RULE_PACK_PRESENT',
      'HTS_NOT_SPECIAL_PROVISION_9801_9802',
      'EVIDENCE_CHAIN_COMPLETE',
      'COUNTERPART_MATCH_EXACT',
      'DEADLINE_WINDOW_ELIGIBLE',
    ]);
    for (const gate of route.gates) {
      expect(gate.detail.length).toBeGreaterThan(0);
    }
  });
});
