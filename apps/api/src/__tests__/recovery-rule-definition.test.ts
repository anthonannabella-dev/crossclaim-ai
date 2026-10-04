/** SEO-2 单元验收：RecoveryRuleDefinition v1 契约 + 收录门 + canonical 版本选择。 */

import { describe, expect, it } from 'vitest';

import {
  detectRecoveryRuleVersionConflicts,
  RECOVERY_RULE_DEFINITION_VERSION,
  seoIndexabilityGate,
  selectCanonicalRecoveryRuleVersion,
  validateRecoveryRuleDefinition,
  type RecoveryRuleDefinition,
} from '../services/recovery-rules/recovery-rule-definition';

const NOW = new Date('2026-10-04T06:00:00.000Z');

const base = (overrides: Partial<RecoveryRuleDefinition> = {}): RecoveryRuleDefinition => ({
  definitionVersion: RECOVERY_RULE_DEFINITION_VERSION,
  platform: 'CUSTOMS',
  category: 'DUTY_RECOVERY',
  recoveryType: 'duty-overpayment',
  country: 'US',
  region: null,
  title: 'Import duty overpayment recovery',
  slug: 'customs-duty-overpayment',
  problemDescription: 'Duties may have been overpaid on an entry and can potentially be recovered.',
  eligibility: {
    requiresIorIdentity: true,
    requiresAuthorizedSigner: false,
    requiresBrokerPoa: false,
    requiresFilingAuthorization: true,
    minimumEvidenceCount: 2,
  },
  requiredEvidence: ['ENTRY_SUMMARY', 'COMMERCIAL_INVOICE'],
  calculationMethod: { kind: 'DUTY_DIFFERENCE', basisKey: 'duty-truth-v1' },
  filingDeadline: { kind: 'STATUTORY', days: 180, sourceReferenceId: 'src:19-usc-1514' },
  submissionMethod: 'BROKER_FILED',
  feeModel: 'SUCCESS_FEE',
  supportedMode: 'FREE_AUDIT',
  ruleVersion: 'v1',
  effectiveFrom: '2026-09-01T00:00:00.000Z',
  effectiveTo: null,
  sourceReferences: [{ id: 'src:19-usc-1514', label: '19 U.S.C. §1514' }],
  capabilities: { checker: true, calculator: true },
  ctaMode: 'FREE_AUDIT_THEN_START',
  ...overrides,
});

const fullSections = { problem: true, eligibility: true, evidence: true, calculation: true };

describe('SEO-2 — recovery rule definition v1（unit）', () => {
  it('合法定义通过校验；一次生成 28 页的前置契约成立', () => {
    expect(validateRecoveryRuleDefinition(base())).toEqual({ ok: true });
  });

  it('结构校验 fail-closed：slug / 来源 / 能力一致性 / 法定期限依据 / 生效窗口', () => {
    expect(validateRecoveryRuleDefinition(base({ slug: 'Bad Slug' }))).toEqual({
      ok: false,
      errors: ['INVALID_SLUG'],
    });
    expect(validateRecoveryRuleDefinition(base({ sourceReferences: [] }))).toEqual({
      ok: false,
      errors: ['MISSING_SOURCE_REFERENCES'],
    });
    expect(
      validateRecoveryRuleDefinition(
        base({ capabilities: { checker: true, calculator: false }, calculationMethod: { kind: 'NONE', basisKey: 'x' } }),
      ),
    ).toEqual({ ok: true });
    expect(
      validateRecoveryRuleDefinition(
        base({ capabilities: { checker: false, calculator: true }, calculationMethod: { kind: 'NONE', basisKey: 'x' } }),
      ),
    ).toEqual({ ok: false, errors: ['CALCULATOR_REQUIRES_CALCULATION_METHOD'] });
    expect(
      validateRecoveryRuleDefinition(base({ filingDeadline: { kind: 'STATUTORY', days: 180 } })),
    ).toEqual({ ok: false, errors: ['STATUTORY_DEADLINE_REQUIRES_SOURCE'] });
    expect(
      validateRecoveryRuleDefinition(
        base({ effectiveFrom: '2026-10-01T00:00:00.000Z', effectiveTo: '2026-09-01T00:00:00.000Z' }),
      ),
    ).toEqual({ ok: false, errors: ['INVALID_EFFECTIVE_WINDOW'] });
  });

  it('收录门：全部条件满足才 INDEX', () => {
    const gate = seoIndexabilityGate({
      rule: base(),
      now: NOW,
      sections: fullSections,
      conflictingVersions: false,
      canonicalExplicit: true,
    });
    expect(gate.indexable).toBe(true);
    expect(gate.reasons).toEqual([]);
  });

  it('收录门 NOINDEX：过期规则 / 无工具 / 薄内容 / 无来源 / 版本冲突 / canonical 缺失', () => {
    const expired = seoIndexabilityGate({
      rule: base({ effectiveTo: '2026-09-30T00:00:00.000Z' }),
      now: NOW,
      sections: fullSections,
      conflictingVersions: false,
      canonicalExplicit: true,
    });
    expect(expired.indexable).toBe(false);
    expect(expired.reasons).toContain('RULE_NOT_EFFECTIVE');

    const noTools = seoIndexabilityGate({
      rule: base({ capabilities: { checker: false, calculator: false } }),
      now: NOW,
      sections: fullSections,
      conflictingVersions: false,
      canonicalExplicit: true,
    });
    expect(noTools.reasons).toContain('NO_CHECKER_OR_CALCULATOR');

    const thin = seoIndexabilityGate({
      rule: base(),
      now: NOW,
      sections: { ...fullSections, calculation: false },
      conflictingVersions: false,
      canonicalExplicit: true,
    });
    expect(thin.reasons).toContain('THIN_CONTENT');

    const conflict = seoIndexabilityGate({
      rule: base(),
      now: NOW,
      sections: fullSections,
      conflictingVersions: true,
      canonicalExplicit: true,
    });
    expect(conflict.reasons).toContain('RULE_VERSION_CONFLICT');

    const noCanonical = seoIndexabilityGate({
      rule: base(),
      now: NOW,
      sections: fullSections,
      conflictingVersions: false,
      canonicalExplicit: false,
    });
    expect(noCanonical.reasons).toContain('CANONICAL_NOT_EXPLICIT');

    // 结构非法直接 NOINDEX
    const invalid = seoIndexabilityGate({
      rule: base({ sourceReferences: [] }),
      now: NOW,
      sections: fullSections,
      conflictingVersions: false,
      canonicalExplicit: true,
    });
    expect(invalid).toEqual({ indexable: false, reasons: ['INVALID_DEFINITION'] });
  });

  it('canonical 选择确定性：取最晚生效开始的版本；同时间取 ruleVersion 更大者', () => {
    const older = base({ ruleVersion: 'v1', effectiveFrom: '2026-01-01T00:00:00.000Z' });
    const newer = base({ ruleVersion: 'v2', effectiveFrom: '2026-09-01T00:00:00.000Z' });
    expect(selectCanonicalRecoveryRuleVersion([older, newer])?.ruleVersion).toBe('v2');
    expect(selectCanonicalRecoveryRuleVersion([newer, older])?.ruleVersion).toBe('v2');

    const sameStartA = base({ ruleVersion: 'v2', effectiveFrom: '2026-09-01T00:00:00.000Z' });
    const sameStartB = base({ ruleVersion: 'v3', effectiveFrom: '2026-09-01T00:00:00.000Z' });
    expect(selectCanonicalRecoveryRuleVersion([sameStartA, sameStartB])?.ruleVersion).toBe('v3');
    expect(selectCanonicalRecoveryRuleVersion([])).toBeNull();
  });

  it('同 slug 多版本同时生效 → 冲突检测命中（必须 NOINDEX 并人工裁决）', () => {
    const a = base({ ruleVersion: 'v1', effectiveFrom: '2026-01-01T00:00:00.000Z' });
    const b = base({ ruleVersion: 'v2', effectiveFrom: '2026-09-01T00:00:00.000Z' });
    expect(detectRecoveryRuleVersionConflicts([a, b], NOW)).toEqual(['customs-duty-overpayment']);
    const closed = base({ ruleVersion: 'v1', effectiveFrom: '2026-01-01T00:00:00.000Z', effectiveTo: '2026-05-01T00:00:00.000Z' });
    expect(detectRecoveryRuleVersionConflicts([closed, b], NOW)).toEqual([]);
  });
});
