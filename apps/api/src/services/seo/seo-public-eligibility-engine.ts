/**
 * SEO-3 / MSG-20261005-07 CHANGE F: eligibility decision-table engine.
 *
 * The audit found that the eligibility *input schema* and the *output label*
 * existed but the actual judgement did not, so the public eligibility engine
 * could not be called implementation-complete. This is the missing piece:
 * a pure decision table over the rule's own requirements and the caller's
 * self-reported answers.
 *
 * Deliberately minimal - no probability, no model score, no LLM:
 *   requiresX && !hasX          -> MISSING_<X>
 *   evidenceCount < minimum     -> INSUFFICIENT_EVIDENCE
 *   eligible = reasonCodes.length === 0
 *
 * Semantics stay preliminary: a positive result means "based on what you told
 * us", never "we verified you".
 */

import type { RecoveryRuleDefinition } from '../recovery-rules/recovery-rule-definition';
import type { SeoPublicAnswerValue, SeoPublicEligibilityOutcome } from './seo-public-checker';

export const SEO_PUBLIC_ELIGIBILITY_REASON_CODES = {
  missingIorIdentity: 'MISSING_IOR_IDENTITY',
  missingAuthorizedSigner: 'MISSING_AUTHORIZED_SIGNER',
  missingBrokerPoa: 'MISSING_BROKER_POA',
  missingFilingAuthorization: 'MISSING_FILING_AUTHORIZATION',
  insufficientEvidence: 'INSUFFICIENT_EVIDENCE',
} as const;

const isTrue = (value: SeoPublicAnswerValue | undefined): boolean => value === true;

const countOf = (value: SeoPublicAnswerValue | undefined): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;

/** Pure decision table: (rule.eligibility, answers) -> { eligible, reasonCodes }. */
export function runEligibilityDecisionTable(
  rule: RecoveryRuleDefinition,
  answers: Record<string, SeoPublicAnswerValue>,
): SeoPublicEligibilityOutcome {
  const required = rule.eligibility;
  const reasonCodes: string[] = [];

  if (required.requiresIorIdentity && !isTrue(answers.hasIorIdentity)) {
    reasonCodes.push(SEO_PUBLIC_ELIGIBILITY_REASON_CODES.missingIorIdentity);
  }
  if (required.requiresAuthorizedSigner && !isTrue(answers.hasAuthorizedSigner)) {
    reasonCodes.push(SEO_PUBLIC_ELIGIBILITY_REASON_CODES.missingAuthorizedSigner);
  }
  if (required.requiresBrokerPoa && !isTrue(answers.hasBrokerPoa)) {
    reasonCodes.push(SEO_PUBLIC_ELIGIBILITY_REASON_CODES.missingBrokerPoa);
  }
  if (required.requiresFilingAuthorization && !isTrue(answers.hasFilingAuthorization)) {
    reasonCodes.push(SEO_PUBLIC_ELIGIBILITY_REASON_CODES.missingFilingAuthorization);
  }
  if (countOf(answers.evidenceCount) < Math.max(0, required.minimumEvidenceCount)) {
    reasonCodes.push(SEO_PUBLIC_ELIGIBILITY_REASON_CODES.insufficientEvidence);
  }

  return { eligible: reasonCodes.length === 0, reasonCodes };
}

export const SEO_PUBLIC_ELIGIBILITY_ENGINE_BOUNDARY = {
  decisionTableOnly: true,
  probabilityUsed: false,
  modelScoreUsed: false,
  llmUsed: false,
  countGateOnly: true,
  externalWritePerformed: false,
  tenantDataIncluded: false,
} as const;
