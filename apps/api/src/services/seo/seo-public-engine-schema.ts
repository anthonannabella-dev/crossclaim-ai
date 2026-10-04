/**
 * SEO-3 / MSG-20261005-06 item (1): rule-aware public eligibility schema.
 * The verdict rejected a static schema that treats all five answers as required:
 * if a rule does not require an IOR identity, a request must not be rejected for
 * omitting that answer. Here each field's `required` flag mirrors the rule's own
 * eligibility flags, so requirement is derived from the rule (single source) and
 * never from a hardcoded list.
 * Pure function: no I/O, no writes, no tenant data. Values stay self-reported.
 */

import type { RecoveryRuleDefinition } from '../recovery-rules/recovery-rule-definition';
import type { PublicInputSchema } from './seo-public-input-schema';

export const SEO_PUBLIC_ELIGIBILITY_LABEL = 'PRELIMINARY_SELF_REPORTED' as const;
export const SEO_PUBLIC_EVIDENCE_VALIDITY = 'NOT_PERFORMED' as const;

/** Upper bound for the self-reported evidence count (a count gate, nothing more). */
export const SEO_PUBLIC_MAX_EVIDENCE_COUNT = 1000;

export function buildPublicEligibilitySchemaForRule(rule: RecoveryRuleDefinition): PublicInputSchema {
  const required = rule.eligibility;
  return {
    // Field-level `required` is the enforcement point, so an empty object stays
    // acceptable whenever the rule requires none of these answers.
    allowEmpty: true,
    fields: {
      hasIorIdentity: { kind: 'boolean', required: required.requiresIorIdentity },
      hasAuthorizedSigner: { kind: 'boolean', required: required.requiresAuthorizedSigner },
      hasBrokerPoa: { kind: 'boolean', required: required.requiresBrokerPoa },
      hasFilingAuthorization: { kind: 'boolean', required: required.requiresFilingAuthorization },
      evidenceCount: {
        kind: 'integer',
        min: 0,
        max: SEO_PUBLIC_MAX_EVIDENCE_COUNT,
        required: required.minimumEvidenceCount > 0,
      },
    },
  };
}

export const SEO_PUBLIC_ENGINE_SCHEMA_BOUNDARY = {
  requiredDerivedFromRule: true,
  staticRequiredList: false,
  evidenceCountIsQuantityOnly: true,
  evidenceValidityVerification: SEO_PUBLIC_EVIDENCE_VALIDITY,
  eligibilityLabel: SEO_PUBLIC_ELIGIBILITY_LABEL,
  externalWritePerformed: false,
  tenantDataIncluded: false,
} as const;
