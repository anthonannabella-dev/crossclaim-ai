/**
 * MSG-20261005-06 item (1): requirement must come from the rule, not a static
 * list. Proves the verdict's exact examples: a required answer is enforced, and
 * an answer the rule does not require must not make a request invalid when omitted.
 */

import { describe, expect, it } from 'vitest';

import {
  buildPublicEligibilitySchemaForRule,
  SEO_PUBLIC_ELIGIBILITY_LABEL,
  SEO_PUBLIC_ENGINE_SCHEMA_BOUNDARY,
} from '../services/seo/seo-public-engine-schema';
import { validatePublicAnswersAgainstSchema } from '../services/seo/seo-public-input-schema';
import type { RecoveryRuleDefinition } from '../services/recovery-rules/recovery-rule-definition';

const rule = (eligibility: Partial<RecoveryRuleDefinition['eligibility']> = {}): RecoveryRuleDefinition => ({
  eligibility: {
    requiresIorIdentity: true,
    requiresAuthorizedSigner: false,
    requiresBrokerPoa: false,
    requiresFilingAuthorization: false,
    minimumEvidenceCount: 0,
    ...eligibility,
  },
}) as unknown as RecoveryRuleDefinition;

describe('SEO-3 rule-aware eligibility schema', () => {
  it('REQUIRED_FOLLOWS_THE_RULE: requiresIorIdentity=true => hasIorIdentity required', () => {
    const schema = buildPublicEligibilitySchemaForRule(rule());
    expect(schema.fields.hasIorIdentity).toEqual({ kind: 'boolean', required: true });
    expect(schema.fields.hasAuthorizedSigner).toEqual({ kind: 'boolean', required: false });
    expect(schema.fields.hasBrokerPoa).toEqual({ kind: 'boolean', required: false });
    expect(schema.fields.hasFilingAuthorization).toEqual({ kind: 'boolean', required: false });
  });

  it('NOT_REQUIRED_IS_NOT_ENFORCED: omitting an unrequired answer is valid', () => {
    const schema = buildPublicEligibilitySchemaForRule(rule());
    // hasAuthorizedSigner / hasBrokerPoa / hasFilingAuthorization are not required by this rule.
    const checked = validatePublicAnswersAgainstSchema({ answers: { hasIorIdentity: true }, schema });
    expect(checked.ok).toBe(true);
  });

  it('REQUIRED_IS_ENFORCED: omitting the rule-required answer fails closed', () => {
    const schema = buildPublicEligibilitySchemaForRule(rule());
    const checked = validatePublicAnswersAgainstSchema({ answers: {}, schema });
    expect(checked.ok).toBe(false);
    expect(checked.code).toBe('REQUIRED_ANSWER_MISSING');
  });

  it('RULE_THAT_REQUIRES_NOTHING_ACCEPTS_AN_EMPTY_BODY: no static required list', () => {
    const schema = buildPublicEligibilitySchemaForRule(
      rule({
        requiresIorIdentity: false,
        requiresAuthorizedSigner: false,
        requiresBrokerPoa: false,
        requiresFilingAuthorization: false,
        minimumEvidenceCount: 0,
      }),
    );
    const checked = validatePublicAnswersAgainstSchema({ answers: {}, schema });
    expect(checked.ok).toBe(true);
  });

  it('EVIDENCE_COUNT_REQUIRED_ONLY_WHEN_THRESHOLD_POSITIVE', () => {
    expect(buildPublicEligibilitySchemaForRule(rule({ minimumEvidenceCount: 0 })).fields.evidenceCount.required).toBe(false);
    expect(buildPublicEligibilitySchemaForRule(rule({ minimumEvidenceCount: 2 })).fields.evidenceCount.required).toBe(true);
  });

  it('STILL_REJECTS_UNKNOWN_KEYS: the builder does not widen the whitelist', () => {
    const schema = buildPublicEligibilitySchemaForRule(rule());
    const checked = validatePublicAnswersAgainstSchema({ answers: { phone: 'x' }, schema });
    expect(checked.ok).toBe(false);
    expect(checked.code).toBe('UNKNOWN_ANSWER_KEY');
  });

  it('LABELS_ARE_EXPLICIT: preliminary self-reported, evidence validity not performed', () => {
    expect(SEO_PUBLIC_ELIGIBILITY_LABEL).toBe('PRELIMINARY_SELF_REPORTED');
    expect(SEO_PUBLIC_ENGINE_SCHEMA_BOUNDARY.requiredDerivedFromRule).toBe(true);
    expect(SEO_PUBLIC_ENGINE_SCHEMA_BOUNDARY.evidenceValidityVerification).toBe('NOT_PERFORMED');
    expect(SEO_PUBLIC_ENGINE_SCHEMA_BOUNDARY.staticRequiredList).toBe(false);
  });
});
