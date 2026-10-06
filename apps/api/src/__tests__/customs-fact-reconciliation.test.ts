// CUSTOMS / DUTY RECOVERY — slice B-S4 — OCR trust boundary + 候选 → Customs Fact 对账回归
// ---------------------------------------------------------------------------
// 覆盖：五态对账（AGREED/CONFLICT/OCR_ONLY/LOW_CONFIDENCE/MISSING）、OCR 永不独占、
// 跨源冲突禁 last-write-wins、规范化失败候选不参与取值、整体状态与可采纳清单、
// 制度边界不变量、确定性摘要。

import { describe, expect, it } from 'vitest';

import * as providerSupport from '../services/provider-support';
import {
  CUSTOMS_RECONCILIATION_VERSION,
  CustomsReconciliationError,
  OCR_TRUST_BOUNDARY,
  SOURCE_TRUST,
  assertReconciliationDidNotWriteTruth,
  listPromotableFields,
  reconcileCustomsFields,
  type CustomsFieldCandidate,
} from '../services/provider-support';

const NOW = new Date('2026-10-06T16:00:00.000Z');
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

function candidate(overrides: Partial<CustomsFieldCandidate> = {}): CustomsFieldCandidate {
  return {
    field: 'entryNumber',
    rawValue: 'ABC-123456',
    normalizedValue: 'ABC-123456',
    page: 1,
    boundingBox: null,
    confidenceBp: 9_500,
    sourceKind: 'STRUCTURED',
    provider: 'structured:csv',
    providerVersion: 'v1',
    sourceFileSha256: SHA_A,
    lineNumber: null,
    ...overrides,
  };
}

function reconcile(candidates: readonly CustomsFieldCandidate[], extra: Record<string, unknown> = {}) {
  return reconcileCustomsFields({
    candidates,
    fields: ['entryNumber', 'hts'],
    now: NOW,
    ...extra,
  });
}

function fieldOf(result: ReturnType<typeof reconcile>, field: string) {
  const found = result.fields.find((entry) => entry.field === field);
  if (!found) throw new Error('字段缺失：' + field);
  return found;
}

describe('B-S4 对账 — 五态判定', () => {
  it('单一可信任来源（STRUCTURED）→ AGREED，值可进入人工确认', () => {
    const result = reconcile([candidate()]);
    const entryNumber = fieldOf(result, 'entryNumber');
    expect(entryNumber.status).toBe('AGREED');
    expect(entryNumber.value).toBe('ABC-123456');
    expect(entryNumber.promotion.allowed).toBe(true);
    expect(entryNumber.promotion.requiresHumanApproval).toBe(true);
    expect(entryNumber.reasons).toContain('AGREED_BY_STRUCTURED');
    expect(result.overallStatus).toBe('READY_FOR_HUMAN_REVIEW');
    expect(result.promotableFields).toEqual(['entryNumber']);
  });

  it('NATIVE_TEXT 高置信同样 AGREED', () => {
    const result = reconcile([candidate({ sourceKind: 'NATIVE_TEXT', confidenceBp: 9_000, provider: 'pdf:mock' })]);
    expect(fieldOf(result, 'entryNumber').status).toBe('AGREED');
    expect(fieldOf(result, 'entryNumber').reasons).toContain('AGREED_BY_NATIVE_TEXT');
  });

  it('仅 OCR 支撑 → OCR_ONLY（永不采纳，值只作提示）', () => {
    const result = reconcile([
      candidate({ sourceKind: 'OCR_DERIVED', confidenceBp: 9_800, provider: 'ocr:mock' }),
    ]);
    const entryNumber = fieldOf(result, 'entryNumber');
    expect(entryNumber.status).toBe('OCR_ONLY');
    expect(entryNumber.value).toBeNull();
    expect(entryNumber.proposedValue).toBe('ABC-123456');
    expect(entryNumber.promotion.allowed).toBe(false);
    expect(entryNumber.promotion.forbiddenReason).toBe('OCR_NEVER_SUFFICIENT_ALONE');
    expect(result.ocrOnlyFields).toEqual(['entryNumber']);
    expect(result.promotableFields).toEqual([]);
    expect(result.overallStatus).toBe('INSUFFICIENT_EVIDENCE');
  });

  it('非 OCR 但全部低于阈值 → LOW_CONFIDENCE（不采纳）', () => {
    const result = reconcile([candidate({ sourceKind: 'NATIVE_TEXT', confidenceBp: 4_000 })]);
    const entryNumber = fieldOf(result, 'entryNumber');
    expect(entryNumber.status).toBe('LOW_CONFIDENCE');
    expect(entryNumber.value).toBeNull();
    expect(entryNumber.proposedValue).toBe('ABC-123456');
    expect(entryNumber.promotion.forbiddenReason).toBe('BELOW_CONFIDENCE_THRESHOLD');
  });

  it('无候选 → MISSING（不推断、不填补）', () => {
    const result = reconcile([candidate({ field: 'entryNumber' })]);
    const hts = fieldOf(result, 'hts');
    expect(hts.status).toBe('MISSING');
    expect(hts.value).toBeNull();
    expect(hts.sources).toEqual([]);
    expect(hts.promotion.forbiddenReason).toBe('NO_CANDIDATE');
  });
});

describe('B-S4 — 冲突与 OCR 信任边界', () => {
  it('两个不同值 → CONFLICT，全部值保留且禁止自动择优', () => {
    const result = reconcile([
      candidate(),
      candidate({
        sourceKind: 'NATIVE_TEXT',
        rawValue: 'ABC-999999',
        normalizedValue: 'ABC-999999',
        provider: 'pdf:mock',
        sourceFileSha256: SHA_B,
      }),
    ]);
    const entryNumber = fieldOf(result, 'entryNumber');
    expect(entryNumber.status).toBe('CONFLICT');
    expect(entryNumber.value).toBeNull();
    expect(entryNumber.distinctValues).toEqual(['ABC-123456', 'ABC-999999']);
    expect(entryNumber.promotion.forbiddenReason).toBe('CROSS_SOURCE_CONFLICT');
    expect(entryNumber.reasons).toContain('LAST_WRITE_WINS_FORBIDDEN');
    expect(entryNumber.sources).toHaveLength(2);
    expect(result.overallStatus).toBe('BLOCKED_BY_CONFLICT');
    expect(result.conflictingFields).toEqual(['entryNumber']);
  });

  it('冲突中不允许 OCR 打破平局（OCR 也只是另一个来源）', () => {
    const result = reconcile([
      candidate(),
      candidate({ sourceKind: 'OCR_DERIVED', normalizedValue: 'ABC-999999', rawValue: 'ABC-999999', confidenceBp: 9_900 }),
    ]);
    expect(fieldOf(result, 'entryNumber').status).toBe('CONFLICT');
    expect(result.promotableFields).toEqual([]);
  });

  it('多来源一致（非 OCR）→ AGREED，并标记多来源一致', () => {
    const result = reconcile([
      candidate(),
      candidate({ sourceKind: 'NATIVE_TEXT', provider: 'pdf:mock', sourceFileSha256: SHA_B, confidenceBp: 9_000 }),
    ]);
    const entryNumber = fieldOf(result, 'entryNumber');
    expect(entryNumber.status).toBe('AGREED');
    expect(entryNumber.reasons).toContain('MULTI_SOURCE_AGREEMENT');
    expect(entryNumber.confidenceBp).toBe(9_500);
  });

  it('非 OCR + OCR 一致 → AGREED（OCR 只作佐证，不当唯一依据）', () => {
    const result = reconcile([
      candidate(),
      candidate({ sourceKind: 'OCR_DERIVED', provider: 'ocr:mock', confidenceBp: 9_800 }),
    ]);
    const entryNumber = fieldOf(result, 'entryNumber');
    expect(entryNumber.status).toBe('AGREED');
    expect(entryNumber.reasons).toContain('OCR_CORROBORATION_ONLY');
    expect(entryNumber.reasons).toContain('AGREED_BY_STRUCTURED');
  });

  it('规范化失败的候选不参与取值，但保留在来源中（可审计）', () => {
    const result = reconcile([
      candidate({ field: 'hts', normalizedValue: null, rawValue: '????' }),
      candidate({ field: 'hts', normalizedValue: '8471.30.01', rawValue: '8471.30.01' }),
    ]);
    const hts = fieldOf(result, 'hts');
    expect(hts.status).toBe('AGREED');
    expect(hts.value).toBe('8471.30.01');
    expect(hts.distinctValues).toEqual(['8471.30.01']);
    expect(hts.sources).toHaveLength(2);
    expect(hts.reasons.some((r) => r.startsWith('UNNORMALIZED_CANDIDATE_IGNORED'))).toBe(true);
  });

  it('只有不可规范化候选 → MISSING（不猜）', () => {
    const result = reconcile([candidate({ field: 'hts', normalizedValue: null, rawValue: '????' })]);
    const hts = fieldOf(result, 'hts');
    expect(hts.status).toBe('MISSING');
    expect(hts.promotion.forbiddenReason).toBe('ONLY_UNNORMALIZED_CANDIDATES');
  });

  it('来源信任序：STRUCTURED > NATIVE_TEXT > OCR_DERIVED', () => {
    expect(SOURCE_TRUST.STRUCTURED).toBeGreaterThan(SOURCE_TRUST.NATIVE_TEXT);
    expect(SOURCE_TRUST.NATIVE_TEXT).toBeGreaterThan(SOURCE_TRUST.OCR_DERIVED);
  });
});

describe('B-S4 — 汇总、边界与确定性', () => {
  it('可采纳清单只包含 AGREED 且有可信任来源的字段', () => {
    const result = reconcile([
      candidate({ field: 'entryNumber' }),
      candidate({ field: 'hts', sourceKind: 'OCR_DERIVED', normalizedValue: '8471.30.01', rawValue: '8471.30.01' }),
    ]);
    expect(listPromotableFields(result)).toEqual(['entryNumber']);
    expect(result.agreedFields).toEqual(['entryNumber']);
    expect(result.ocrOnlyFields).toEqual(['hts']);
    expect(result.blockedFields).toEqual(['hts']);
    expect(result.requiresManualReview).toBe(true);
  });

  it('自定义阈值可收紧（调用方策略）', () => {
    const strict = reconcile([candidate({ sourceKind: 'NATIVE_TEXT', confidenceBp: 9_000 })], {
      confidenceThresholdBp: 9_500,
    });
    expect(fieldOf(strict, 'entryNumber').status).toBe('LOW_CONFIDENCE');
  });

  it('organizationId 透传（默认 null），不用于任何判定', () => {
    expect(reconcile([candidate()]).organizationId).toBeNull();
    expect(reconcile([candidate()], { organizationId: 'org-1' }).organizationId).toBe('org-1');
  });

  it('制度边界：本模块从不写 Canonical / Customs Truth', () => {
    const result = reconcile([candidate()]);
    expect(result.kind).toBe('CUSTOMS_FACT_RECONCILIATION');
    expect(result.version).toBe(CUSTOMS_RECONCILIATION_VERSION);
    expect(result.canonicalWritePerformed).toBe(false);
    expect(result.customsTruthEligible).toBe(false);
    expect(result.ocrNeverSufficientAlone).toBe(true);
    expect(result.crossSourceConflictAutoResolved).toBe(false);
    expect(() => assertReconciliationDidNotWriteTruth(result)).not.toThrow();
    expect(() => assertReconciliationDidNotWriteTruth({ canonicalWritePerformed: true as never })).toThrowError(
      CustomsReconciliationError,
    );
    expect(() => assertReconciliationDidNotWriteTruth({ customsTruthEligible: true as never })).toThrowError(
      CustomsReconciliationError,
    );
  });

  it('OCR 信任边界常量：OCR 不即事实、不独占、不自动解决冲突', () => {
    expect(OCR_TRUST_BOUNDARY.ocrIsNotCustomsTruth).toBe(true);
    expect(OCR_TRUST_BOUNDARY.ocrNeverSufficientAlone).toBe(true);
    expect(OCR_TRUST_BOUNDARY.ocrRequiresHumanVerification).toBe(true);
    expect(OCR_TRUST_BOUNDARY.crossSourceConflictNeverAutoResolved).toBe(true);
    expect(OCR_TRUST_BOUNDARY.lastWriteWinsForbidden).toBe(true);
    expect(OCR_TRUST_BOUNDARY.promotionRequiresHumanApproval).toBe(true);
    expect(OCR_TRUST_BOUNDARY.forbidden).toContain('promoting an OCR-only value to a Customs Fact');
    expect(OCR_TRUST_BOUNDARY.forbidden).toContain('resolving a cross-source conflict by last-write-wins');
  });

  it('确定性：同输入同 now → 同 reconciliationDigest；值变 → 摘要变', () => {
    const a = reconcile([candidate()]);
    const b = reconcile([candidate()]);
    const c = reconcile([candidate({ normalizedValue: 'XYZ-000001', rawValue: 'XYZ-000001' })]);
    expect(a.reconciliationDigest).toBe(b.reconciliationDigest);
    expect(a.reconciliationDigest).not.toBe(c.reconciliationDigest);
    expect(a.reconciliationDigest).toHaveLength(64);
    expect(a.reconciledAt).toBe(NOW.toISOString());
  });

  it('模块不导出任何把对账结果写成事实的入口', () => {
    for (const name of Object.keys(providerSupport)) {
      expect(name).not.toMatch(/writeCustomsFact|promoteCandidateToTruth|persistReconciliationAsTruth|autoResolveConflict/i);
    }
  });
});
