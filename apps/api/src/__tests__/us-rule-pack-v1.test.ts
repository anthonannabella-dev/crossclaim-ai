// CUSTOMS / DUTY RECOVERY — slice B-S7 — US Jurisdiction Rule Pack v1 回归
// ---------------------------------------------------------------------------
// 覆盖：规则包元数据与版本化、8 类恢复候选 → 既有 remedy 路由映射、证据需求引用（B-S5 需求 id）、
// 路由（不自动申报 / 报关行转交）、期限政策（v1 未核验 → INDETERMINATE，附 nominal 计算）、
// 9801/9802 ≠ drawback、未知 jurisdiction fail-closed、制度边界断言、摘要确定性。

import { describe, expect, it } from 'vitest';

import {
  CUSTOMS_RECOVERY_CANDIDATE_KINDS,
  RULE_PACK_SUBMISSION_MODES,
  US_RULE_PACK_BOUNDARY,
  US_RULE_PACK_ID,
  US_RULE_PACK_V1,
  US_RULE_PACK_V1_DIGEST,
  US_RULE_PACK_VERSION,
  UsRulePackError,
  assertNotDrawbackHeading,
  assertRulePackDoesNotDecideOrFile,
  evaluateUsRemedyDeadline,
  resolveJurisdictionRulePack,
} from '../services/customs/rule-pack/us-rule-pack-v1';
import { isOpaqueRecoveryRef } from '../services/recovery-rules/recovery-rule-definition';
import {
  CUSTOMS_REMEDY_ROUTES,
  evaluateRemedyDeadline,
} from '../services/customs/enterprise-ior/remedy-deadline';
import {
  CUSTOMS_EVIDENCE_REQUIREMENT_IDS,
  type CustomsEvidenceRequirementId,
} from '../services/provider-support';

const NOW = '2026-10-06T00:00:00.000Z';

describe('B-S7 US Rule Pack v1 — 元数据与版本化', () => {
  it('规则包标识 / 版本 / 辖区 / 生效窗口 / 来源齐备，且未经法务核验时不伪称已核验', () => {
    expect(US_RULE_PACK_V1.ruleSetId).toBe(US_RULE_PACK_ID);
    expect(US_RULE_PACK_V1.ruleSetVersion).toBe(US_RULE_PACK_VERSION);
    expect(US_RULE_PACK_V1.jurisdiction).toBe('US');
    expect(US_RULE_PACK_V1.jurisdictionScope).toBe('COUNTRY');
    expect(US_RULE_PACK_V1.effectiveFrom).toBe('2026-10-06');
    expect(US_RULE_PACK_V1.effectiveTo).toBeNull();
    expect(US_RULE_PACK_V1.source.length).toBeGreaterThan(0);
    expect(US_RULE_PACK_V1.lastVerified).toBeNull();
    expect(US_RULE_PACK_V1_DIGEST).toHaveLength(64);
  });

  it('legalBasis 引用为 opaque id（禁止裸 URL），无重复', () => {
    const ids = US_RULE_PACK_V1.legalBasis.map((ref) => ref.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    for (const ref of US_RULE_PACK_V1.legalBasis) {
      expect(isOpaqueRecoveryRef(ref.id)).toBe(true);
      expect(ref.label.length).toBeGreaterThan(0);
    }
  });

  it('resolveJurisdictionRulePack：US/USA 命中；其它辖区与空值 → null（fail-closed）', () => {
    expect(resolveJurisdictionRulePack('US')).toBe(US_RULE_PACK_V1);
    expect(resolveJurisdictionRulePack('us')).toBe(US_RULE_PACK_V1);
    expect(resolveJurisdictionRulePack('USA')).toBe(US_RULE_PACK_V1);
    expect(resolveJurisdictionRulePack('UK')).toBeNull();
    expect(resolveJurisdictionRulePack('EU')).toBeNull();
    expect(resolveJurisdictionRulePack(null)).toBeNull();
    expect(resolveJurisdictionRulePack(undefined)).toBeNull();
    expect(resolveJurisdictionRulePack('')).toBeNull();
  });
});

describe('B-S7 — 8 类候选与既有 remedy 词表对齐', () => {
  it('每类候选都有规则，且 route 必须落在既有 CUSTOMS_REMEDY_ROUTES 内（不新建词表）', () => {
    expect(Object.keys(US_RULE_PACK_V1.remedies).sort()).toEqual([...CUSTOMS_RECOVERY_CANDIDATE_KINDS].sort());
    for (const candidate of CUSTOMS_RECOVERY_CANDIDATE_KINDS) {
      const remedy = US_RULE_PACK_V1.remedies[candidate];
      expect(remedy.candidate).toBe(candidate);
      expect(CUSTOMS_REMEDY_ROUTES).toContain(remedy.route);
      expect(remedy.title.length).toBeGreaterThan(0);
      expect(remedy.description.length).toBeGreaterThan(0);
      expect(remedy.limitations.length).toBeGreaterThan(0);
    }
  });

  it('HOST 词表 → route 映射符合预期（PSC / RATE_OVERPAYMENT → POST_SUMMARY_CORRECTION 等）', () => {
    expect(US_RULE_PACK_V1.remedies.DUPLICATE_DUTY.route).toBe('DUPLICATE_DUTY');
    expect(US_RULE_PACK_V1.remedies.DRAWBACK_CANDIDATE.route).toBe('DRAWBACK');
    expect(US_RULE_PACK_V1.remedies.MISSED_EXCLUSION.route).toBe('EXCLUSION_REFUND');
    expect(US_RULE_PACK_V1.remedies.PSC.route).toBe('POST_SUMMARY_CORRECTION');
    expect(US_RULE_PACK_V1.remedies.RATE_OVERPAYMENT.route).toBe('POST_SUMMARY_CORRECTION');
    expect(US_RULE_PACK_V1.remedies.PROTEST.route).toBe('PROTEST');
    expect(US_RULE_PACK_V1.remedies.CLASSIFICATION_CORRECTION.route).toBe('CLASSIFICATION_CORRECTION');
    expect(US_RULE_PACK_V1.remedies.BROKER_REVIEW.route).toBe('OTHER');
  });

  it('证据需求引用 B-S5 的既有需求 id（不新造证据词汇）', () => {
    for (const candidate of CUSTOMS_RECOVERY_CANDIDATE_KINDS) {
      const remedy = US_RULE_PACK_V1.remedies[candidate];
      expect(remedy.requiredEvidence.length).toBeGreaterThan(0);
      for (const id of [...remedy.requiredEvidence, ...remedy.optionalEvidence]) {
        expect(CUSTOMS_EVIDENCE_REQUIREMENT_IDS).toContain(id as CustomsEvidenceRequirementId);
      }
    }
    expect(US_RULE_PACK_V1.remedies.DRAWBACK_CANDIDATE.requiredEvidence).toEqual(['ENTRY_RECORD', 'DUTY_PAYMENT']);
    expect(US_RULE_PACK_V1.remedies.DRAWBACK_CANDIDATE.optionalEvidence).toEqual([
      'EXPORT_RECORD',
      'DESTRUCTION_RECORD',
      'RETURN_RECORD',
    ]);
  });

  it('路由：一律不允许自动申报；报关行类路由使用 BROKER_HANDOFF / BROKER_FILED', () => {
    for (const candidate of CUSTOMS_RECOVERY_CANDIDATE_KINDS) {
      const routing = US_RULE_PACK_V1.remedies[candidate].routing;
      expect(routing.autoFilingAllowed).toBe(false);
      expect(RULE_PACK_SUBMISSION_MODES).toContain(routing.submissionMode);
      expect(routing.requiresBroker).toBe(true);
    }
    expect(US_RULE_PACK_V1.remedies.BROKER_REVIEW.routing.submissionMode).toBe('BROKER_HANDOFF');
    expect(US_RULE_PACK_V1.remedies.DUPLICATE_DUTY.routing.submissionMode).toBe('BROKER_FILED');
  });
});

describe('B-S7 — 期限政策（未核验 → INDETERMINATE）', () => {
  it('v1 所有期限政策都标记 UNVERIFIED，且锚点/天数/来源齐备', () => {
    for (const candidate of CUSTOMS_RECOVERY_CANDIDATE_KINDS) {
      const policy = US_RULE_PACK_V1.remedies[candidate].deadlinePolicy;
      expect(policy.verification).toBe('UNVERIFIED');
      expect(policy.policyId).toContain(US_RULE_PACK_ID);
      expect(policy.policyVersion).toBe(US_RULE_PACK_VERSION);
      expect(policy.daysFromAnchor).toBeGreaterThan(0);
      expect(policy.sourceReferenceId.length).toBeGreaterThan(0);
    }
  });

  it('评估结果：未核验政策 → INDETERMINATE + DEADLINE_POLICY_UNVERIFIED，并给出 nominal 计算', () => {
    const assessment = evaluateUsRemedyDeadline({
      jurisdiction: 'US',
      candidate: 'DUPLICATE_DUTY',
      entryDate: '2026-08-01',
      now: NOW,
    });
    expect(assessment.status).toBe('INDETERMINATE');
    expect(assessment.reasonCodes).toContain('DEADLINE_POLICY_UNVERIFIED');
    expect(assessment.autoFilingAllowed).toBe(false);
    expect(assessment.requiresLegalReview).toBe(true);
    expect(assessment.nominalStatus).toBe('ELIGIBLE_WINDOW');
    expect(assessment.nominalDeadline).toBe('2027-01-28'); // 2026-08-01 + 180 天
    expect(assessment.anchorUsed).toBe('entryDate');
  });

  it('锚点过早时 nominal 计算显示 EXPIRED（仅供人工参考，对外仍 INDETERMINATE）', () => {
    const assessment = evaluateUsRemedyDeadline({
      jurisdiction: 'US',
      candidate: 'DUPLICATE_DUTY',
      entryDate: '2026-01-01',
      now: NOW,
    });
    expect(assessment.nominalStatus).toBe('EXPIRED');
    expect(assessment.nominalDeadline).toBe('2026-06-30');
    expect(assessment.status).toBe('INDETERMINATE');
  });

  it('nominal 计算与既有 evaluateRemedyDeadline 引擎一致（复用而非另写）', () => {
    const policy = US_RULE_PACK_V1.remedies.PROTEST.deadlinePolicy;
    const engine = evaluateRemedyDeadline(
      {
        jurisdiction: 'US',
        remedy: 'PROTEST',
        entryDate: null,
        liquidationDate: '2026-03-01',
        exportDate: null,
        destructionDate: null,
        exclusionEffectiveDate: null,
      },
      [
        {
          policyId: policy.policyId,
          policyVersion: policy.policyVersion,
          jurisdiction: 'US',
          remedy: 'PROTEST',
          anchorField: policy.anchorField,
          daysFromAnchor: policy.daysFromAnchor,
        },
      ],
      NOW,
    );
    const assessment = evaluateUsRemedyDeadline({
      jurisdiction: 'US',
      candidate: 'PROTEST',
      liquidationDate: '2026-03-01',
      now: NOW,
    });
    expect(assessment.nominalDeadline).toBe(engine.deadline);
    expect(assessment.nominalStatus).toBe(engine.status);
  });

  it('缺锚点日期 → INDETERMINATE + MISSING_ANCHOR_DATE（不猜测）', () => {
    const assessment = evaluateUsRemedyDeadline({
      jurisdiction: 'US',
      candidate: 'MISSED_EXCLUSION',
      now: NOW,
    });
    expect(assessment.status).toBe('INDETERMINATE');
    expect(assessment.nominalDeadline).toBeNull();
    expect(assessment.reasonCodes).toContain('MISSING_ANCHOR_DATE:exclusionEffectiveDate');
  });

  it('未知 jurisdiction → INDETERMINATE + NO_RULE_PACK_FOR_JURISDICTION', () => {
    const assessment = evaluateUsRemedyDeadline({
      jurisdiction: 'UK',
      candidate: 'DUPLICATE_DUTY',
      entryDate: '2026-01-01',
      now: NOW,
    });
    expect(assessment.status).toBe('INDETERMINATE');
    expect(assessment.reasonCodes).toContain('NO_RULE_PACK_FOR_JURISDICTION');
    expect(assessment.policyId).toBeNull();
  });

  it('未知候选类型 → INDETERMINATE + UNKNOWN_REMEDY_CANDIDATE', () => {
    const assessment = evaluateUsRemedyDeadline({
      jurisdiction: 'US',
      candidate: 'MAGIC_REMEDY',
      entryDate: '2026-01-01',
      now: NOW,
    });
    expect(assessment.status).toBe('INDETERMINATE');
    expect(assessment.reasonCodes).toContain('UNKNOWN_REMEDY_CANDIDATE');
  });
});

describe('B-S7 — 9801 / 9802 ≠ drawback 与制度边界', () => {
  it('规则包显式声明 9801 / 9802 不是 drawback', () => {
    expect(US_RULE_PACK_V1.exclusionRules.hts9801IsNotDrawback).toBe(true);
    expect(US_RULE_PACK_V1.exclusionRules.hts9802IsNotDrawback).toBe(true);
    expect(US_RULE_PACK_V1.remedies.DRAWBACK_CANDIDATE.limitations.join(' ')).toContain('9801');
    expect(US_RULE_PACK_V1.remedies.DRAWBACK_CANDIDATE.exclusionClauses.join(' ')).toContain('9802');
  });

  it('assertNotDrawbackHeading：9801/9802 抛错，普通 HTS 通过', () => {
    expect(() => assertNotDrawbackHeading('9801.00.10')).toThrowError(UsRulePackError);
    expect(() => assertNotDrawbackHeading('9802.00.80')).toThrowError(UsRulePackError);
    expect(() => assertNotDrawbackHeading('8471.30.01')).not.toThrow();
    expect(() => assertNotDrawbackHeading(null)).not.toThrow();
  });

  it('制度边界：只描述规则，不判 eligibility / 不算金额 / 不自动申报', () => {
    expect(US_RULE_PACK_BOUNDARY.readOnly).toBe(true);
    expect(US_RULE_PACK_BOUNDARY.decidesEligibility).toBe(false);
    expect(US_RULE_PACK_BOUNDARY.computesRecoverableAmount).toBe(false);
    expect(US_RULE_PACK_BOUNDARY.determinesSuccessFeeEligibility).toBe(false);
    expect(US_RULE_PACK_BOUNDARY.autoFilingAllowed).toBe(false);
    expect(US_RULE_PACK_BOUNDARY.llmCannotDecideEligibility).toBe(true);
    expect(US_RULE_PACK_BOUNDARY.unverifiedDeadlineIsIndeterminate).toBe(true);
    expect(US_RULE_PACK_BOUNDARY.forbidden).toContain('filing or transmitting anything to an authority or broker');
    expect(() => assertRulePackDoesNotDecideOrFile(US_RULE_PACK_BOUNDARY)).not.toThrow();
    expect(() => assertRulePackDoesNotDecideOrFile({ autoFilingAllowed: true as never })).toThrowError(
      UsRulePackError,
    );
    expect(() => assertRulePackDoesNotDecideOrFile({ decidesEligibility: true as never })).toThrowError(
      UsRulePackError,
    );
    expect(() => assertRulePackDoesNotDecideOrFile({ computesRecoverableAmount: true as never })).toThrowError(
      UsRulePackError,
    );
  });

  it('确定性：规则包 digest 稳定（同内容同摘要）', () => {
    const a = evaluateUsRemedyDeadline({ jurisdiction: 'US', candidate: 'PSC', liquidationDate: '2026-02-01', now: NOW });
    const b = evaluateUsRemedyDeadline({ jurisdiction: 'US', candidate: 'PSC', liquidationDate: '2026-02-01', now: NOW });
    expect(a).toEqual(b);
    expect(US_RULE_PACK_V1_DIGEST).toBe(US_RULE_PACK_V1_DIGEST);
  });
});
