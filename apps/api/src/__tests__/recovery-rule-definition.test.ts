/**
 * SEO-2（REVISE 后）单元验收：RecoveryRuleDefinition v1 的跨域提交语义 / 真实引擎绑定 /
 * 当前生效版本唯一 canonical / renderer-derived 收录信号 / typed codec 双事实源消除。
 */

import { describe, expect, it } from 'vitest';

import {
  detectRecoveryRuleVersionConflicts,
  parseRecoveryRuleDefinition,
  seoIndexabilityGate,
  selectCurrentlyEffectiveRecoveryRuleVersion,
  validateRecoveryRuleDefinition,
  type RecoveryRuleDefinition,
  type SeoRenderMetrics,
} from '../services/recovery-rules/recovery-rule-definition';

const DIGEST = 'a'.repeat(64);

const base = (overrides: Partial<RecoveryRuleDefinition> = {}): RecoveryRuleDefinition => ({
  definitionVersion: 'v1',
  platform: 'CUSTOMS',
  category: 'customs',
  recoveryType: 'drawback',
  jurisdictionScope: 'COUNTRY',
  jurisdictionCodes: ['US'],
  region: null,
  title: 'US Customs drawback recovery',
  slug: 'us-customs-drawback',
  problemDescription: 'Duty paid on re-exported goods may be recoverable.',
  eligibility: {
    requiresIorIdentity: true,
    requiresAuthorizedSigner: false,
    requiresBrokerPoa: true,
    requiresFilingAuthorization: true,
    minimumEvidenceCount: 2,
  },
  eligibilityMethod: { kind: 'DECISION_TABLE', basisKey: 'engine:customs-drawback-eligibility' },
  requiredEvidence: ['evidence:entry-summary', 'evidence:export-proof'],
  calculationMethod: { kind: 'DUTY_DIFFERENCE', basisKey: 'engine:customs-duty-difference' },
  filingDeadline: { kind: 'STATUTORY', days: 90, sourceReferenceId: 'src:cfr-1900' },
  submissionMode: 'BROKER_FILED',
  feeModel: 'SUCCESS_FEE',
  supportedMode: 'ASSISTED',
  relatedRuleRefs: ['rule:customs-protest'],
  sourceReferences: [{ id: 'src:cfr-1900', label: '19 CFR 190' }],
  capabilities: { checker: true, calculator: true },
  ctaMode: 'FREE_AUDIT_THEN_START',
  ruleVersion: '2026.10.1',
  effectiveFrom: '2026-10-01T00:00:00.000Z',
  effectiveTo: null,
  ...overrides,
});

const NOW = new Date('2026-10-04T06:00:00.000Z');
const REGISTERED = ['engine:customs-drawback-eligibility', 'engine:customs-duty-difference'];

const metrics = (overrides: Partial<SeoRenderMetrics> = {}): SeoRenderMetrics => ({
  problemContentLength: 600,
  eligibilityContentLength: 600,
  evidenceContentLength: 600,
  calculationContentLength: 600,
  uniqueContentDigest: DIGEST,
  sourceBackedSections: 3,
  ...overrides,
});

const errorsOf = (rule: RecoveryRuleDefinition): readonly string[] => {
  const result = validateRecoveryRuleDefinition(rule);
  return result.ok ? [] : result.errors;
};

describe('SEO-2 REVISE — RecoveryRuleDefinition v1', () => {
  it('基线定义通过完整 runtime 校验', () => {
    expect(validateRecoveryRuleDefinition(base())).toEqual({ ok: true });
  });

  it('① submissionMode 承载跨域执行语义，不再被迫伪装成 Customs 路由', () => {
    for (const mode of [
      'PLATFORM_CLAIM',
      'CARRIER_CLAIM',
      'PAYMENT_NETWORK_DISPUTE',
      'MERCHANT_BACKOFFICE_CLAIM',
      'AUTHORITY_FILING',
    ] as const) {
      expect(errorsOf(base({ submissionMode: mode }))).toEqual([]);
    }
    expect(errorsOf(base({ submissionMode: 'SERVICE_PROVIDER_TRANSMIT' as never }))).toContain(
      'INVALID_SUBMISSION_MODE',
    );
  });

  it('① jurisdictionScope：GLOBAL 必须为空或 [*]；COUNTRY 必须两位国家码；REGION 用区域码', () => {
    expect(errorsOf(base({ jurisdictionScope: 'GLOBAL', jurisdictionCodes: [] }))).toEqual([]);
    expect(errorsOf(base({ jurisdictionScope: 'GLOBAL', jurisdictionCodes: ['*'] }))).toEqual([]);
    expect(errorsOf(base({ jurisdictionScope: 'GLOBAL', jurisdictionCodes: ['US'] }))).toContain(
      'INVALID_JURISDICTION_CODE',
    );
    expect(errorsOf(base({ jurisdictionScope: 'COUNTRY', jurisdictionCodes: ['us'] }))).toContain(
      'INVALID_JURISDICTION_CODE',
    );
    expect(errorsOf(base({ jurisdictionScope: 'COUNTRY', jurisdictionCodes: [] }))).toContain(
      'INVALID_JURISDICTION_CODE',
    );
    expect(errorsOf(base({ jurisdictionScope: 'REGION', jurisdictionCodes: ['EU-27'] }))).toEqual([]);
    expect(errorsOf(base({ jurisdictionScope: 'WORLD' as never }))).toContain('INVALID_JURISDICTION_SCOPE');
  });

  it('② Checker / Calculator 必须有真实引擎 basisKey，否则 fail-closed', () => {
    expect(errorsOf(base({ eligibilityMethod: { kind: 'DECISION_TABLE', basisKey: '' } }))).toContain(
      'INVALID_ELIGIBILITY_METHOD',
    );
    expect(errorsOf(base({ eligibilityMethod: { kind: 'DECISION_TABLE', basisKey: '' } }))).toContain(
      'CHECKER_REQUIRES_ELIGIBILITY',
    );
    expect(errorsOf(base({ calculationMethod: { kind: 'NONE', basisKey: '' } }))).toContain(
      'CALCULATOR_REQUIRES_CALCULATION_METHOD',
    );
    expect(
      errorsOf(
        base({
          capabilities: { checker: true, calculator: false },
          calculationMethod: { kind: 'NONE', basisKey: '' },
        }),
      ),
    ).toEqual([]);
  });

  it('② relatedRuleRefs 必须 opaque、去重且不得自引用', () => {
    expect(errorsOf(base({ relatedRuleRefs: ['rule:customs-protest', 'rule:amazon-fba'] }))).toEqual([]);
    expect(errorsOf(base({ relatedRuleRefs: ['rule:customs-protest', 'rule:customs-protest'] }))).toContain(
      'INVALID_RELATED_RULE_REFS',
    );
    expect(errorsOf(base({ relatedRuleRefs: ['us-customs-drawback'] }))).toContain('INVALID_RELATED_RULE_REFS');
    expect(errorsOf(base({ relatedRuleRefs: ['https://example.com/rule'] }))).toContain(
      'INVALID_RELATED_RULE_REFS',
    );
  });

  it('⑤ 截止日：STATUTORY/POLICY 需要 > 0 的 days 且 sourceReferenceId 必须真实存在', () => {
    expect(errorsOf(base({ filingDeadline: { kind: 'POLICY', days: 0, sourceReferenceId: 'src:cfr-1900' } })))
      .toContain('DEADLINE_REQUIRES_POSITIVE_DAYS');
    expect(errorsOf(base({ filingDeadline: { kind: 'POLICY', days: 30 } }))).toContain(
      'STATUTORY_DEADLINE_REQUIRES_SOURCE',
    );
    expect(
      errorsOf(base({ filingDeadline: { kind: 'POLICY', days: 30, sourceReferenceId: 'src:missing' } })),
    ).toContain('DEADLINE_SOURCE_NOT_FOUND');
    expect(errorsOf(base({ filingDeadline: { kind: 'NONE' } }))).toEqual([]);
  });

  it('⑤ 证据一致性：minimumEvidenceCount 不得超过 requiredEvidence 实际条数', () => {
    expect(
      errorsOf(
        base({
          eligibility: { ...base().eligibility, minimumEvidenceCount: 3 },
          requiredEvidence: ['evidence:entry-summary', 'evidence:export-proof'],
        }),
      ),
    ).toContain('EVIDENCE_COUNT_MISMATCH');
    expect(
      errorsOf(
        base({
          eligibility: { ...base().eligibility, minimumEvidenceCount: 2 },
          requiredEvidence: ['evidence:entry-summary', 'evidence:export-proof'],
        }),
      ),
    ).toEqual([]);
  });

  it('⑤ sourceReferences 必须非空、id 唯一且可作引用目标', () => {
    expect(errorsOf(base({ sourceReferences: [] }))).toContain('MISSING_SOURCE_REFERENCES');
    expect(
      errorsOf(
        base({
          sourceReferences: [
            { id: 'src:cfr-1900', label: 'A' },
            { id: 'src:cfr-1900', label: 'B' },
          ],
        }),
      ),
    ).toContain('INVALID_SOURCE_REFERENCES');
  });

  it('⑤ typed codec：row 的 version/effectiveFrom/effectiveTo 是唯一权威源', () => {
    const full = base();
    const { ruleVersion, effectiveFrom, effectiveTo, ...json } = full;
    void ruleVersion;
    void effectiveFrom;
    void effectiveTo;

    const parsed = parseRecoveryRuleDefinition({
      version: '2026.10.1',
      effectiveFrom: '2026-10-01T00:00:00.000Z',
      effectiveTo: null,
      definition: json,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.rule.ruleVersion).toBe('2026.10.1');
    expect(parsed.rule.effectiveFrom).toBe('2026-10-01T00:00:00.000Z');
    expect(parsed.rule.effectiveTo).toBeNull();
  });

  it('⑤ typed codec：JSON 里重复保存 ruleVersion/effectiveFrom/effectiveTo 一律拒绝（双事实源）', () => {
    const duplicate = parseRecoveryRuleDefinition({
      version: '2026.10.1',
      effectiveFrom: '2026-10-01T00:00:00.000Z',
      effectiveTo: null,
      definition: base(),
    });
    expect(duplicate.ok).toBe(false);
    if (duplicate.ok) return;
    expect(duplicate.errors).toContain('DEFINITION_ROW_COLUMN_DUPLICATE');

    const notJson = parseRecoveryRuleDefinition({
      version: '2026.10.1',
      effectiveFrom: '2026-10-01T00:00:00.000Z',
      effectiveTo: null,
      definition: 'not-an-object',
    });
    expect(notJson.ok).toBe(false);
    if (notJson.ok) return;
    expect(notJson.errors).toContain('INVALID_DEFINITION_JSON');
  });

  it('③ canonical：按当前 now 过滤 —— 0 个无 canonical，1 个即 canonical，>1 个直接 conflict', () => {
    const expired = base({
      slug: 's-expired',
      ruleVersion: '2025.1',
      effectiveFrom: '2025-01-01T00:00:00.000Z',
      effectiveTo: '2025-12-31T00:00:00.000Z',
    });
    const future = base({
      slug: 's-future',
      ruleVersion: '2027.1',
      effectiveFrom: '2027-01-01T00:00:00.000Z',
      effectiveTo: null,
    });
    const active = base({ slug: 's-active' });

    expect(selectCurrentlyEffectiveRecoveryRuleVersion([expired, future], NOW)).toEqual({
      canonical: null,
      effectiveCount: 0,
      conflict: false,
    });

    const single = selectCurrentlyEffectiveRecoveryRuleVersion([expired, active], NOW);
    expect(single.conflict).toBe(false);
    expect(single.effectiveCount).toBe(1);
    expect(single.canonical?.slug).toBe('s-active');

    // 两个同时生效版本不得靠 ruleVersion 字符串排序偷偷选一个（v2 vs v10）。
    const overlapA = base({ slug: 's-overlap', ruleVersion: 'v2' });
    const overlapB = base({ slug: 's-overlap', ruleVersion: 'v10' });
    const overlapped = selectCurrentlyEffectiveRecoveryRuleVersion([overlapA, overlapB], NOW);
    expect(overlapped).toEqual({ canonical: null, effectiveCount: 2, conflict: true });
    expect(detectRecoveryRuleVersionConflicts([overlapA, overlapB], NOW)).toEqual(['s-overlap']);
  });

  it('③ canonical：本身不合法的定义不参与 canonical 竞争', () => {
    const invalid = base({ slug: 's-invalid', submissionMode: 'NOPE' as never });
    expect(selectCurrentlyEffectiveRecoveryRuleVersion([invalid], NOW)).toEqual({
      canonical: null,
      effectiveCount: 0,
      conflict: false,
    });
  });

  it('④ 收录门：缺少 renderer 指标时禁止 INDEX（不接受调用方 boolean 自证）', () => {
    const gate = seoIndexabilityGate({
      rule: base(),
      now: NOW,
      registeredBasisKeys: REGISTERED,
      conflictingVersions: false,
      canonicalExplicit: true,
    });
    expect(gate.indexable).toBe(false);
    expect(gate.reasons).toContain('RENDER_METRICS_REQUIRED');
  });

  it('④ 收录门：renderer 指标低于下限 → THIN_CONTENT', () => {
    const gate = seoIndexabilityGate({
      rule: base(),
      now: NOW,
      registeredBasisKeys: REGISTERED,
      renderMetrics: metrics({ evidenceContentLength: 40 }),
      conflictingVersions: false,
      canonicalExplicit: true,
    });
    expect(gate.indexable).toBe(false);
    expect(gate.reasons).toContain('THIN_CONTENT');
  });

  it('④ 收录门：basisKey 未注册 → NO_RECOVERY_CAPABILITY / NO_CHECKER_OR_CALCULATOR', () => {
    const gate = seoIndexabilityGate({
      rule: base(),
      now: NOW,
      registeredBasisKeys: [],
      renderMetrics: metrics(),
      conflictingVersions: false,
      canonicalExplicit: true,
    });
    expect(gate.indexable).toBe(false);
    expect(gate.reasons).toContain('NO_RECOVERY_CAPABILITY');
    expect(gate.reasons).toContain('NO_CHECKER_OR_CALCULATOR');
  });

  it('④ 收录门：全部条件满足才 INDEX；未生效 / 冲突 / canonical 缺失分别给理由', () => {
    const ok = seoIndexabilityGate({
      rule: base(),
      now: NOW,
      registeredBasisKeys: REGISTERED,
      renderMetrics: metrics(),
      conflictingVersions: false,
      canonicalExplicit: true,
    });
    expect(ok).toEqual({ indexable: true, reasons: [] });

    const notEffective = seoIndexabilityGate({
      rule: base({ effectiveFrom: '2027-01-01T00:00:00.000Z' }),
      now: NOW,
      registeredBasisKeys: REGISTERED,
      renderMetrics: metrics(),
      conflictingVersions: false,
      canonicalExplicit: true,
    });
    expect(notEffective.reasons).toContain('RULE_NOT_EFFECTIVE');

    const conflicted = seoIndexabilityGate({
      rule: base(),
      now: NOW,
      registeredBasisKeys: REGISTERED,
      renderMetrics: metrics(),
      conflictingVersions: true,
      canonicalExplicit: false,
    });
    expect(conflicted.reasons).toContain('RULE_VERSION_CONFLICT');
    expect(conflicted.reasons).toContain('CANONICAL_NOT_EXPLICIT');
  });

  it('④ 收录门：定义不合法直接 INVALID_DEFINITION（fail-closed）', () => {
    const gate = seoIndexabilityGate({
      rule: base({ sourceReferences: [] }),
      now: NOW,
      registeredBasisKeys: REGISTERED,
      renderMetrics: metrics(),
      conflictingVersions: false,
      canonicalExplicit: true,
    });
    expect(gate).toEqual({ indexable: false, reasons: ['INVALID_DEFINITION'] });
  });
});
