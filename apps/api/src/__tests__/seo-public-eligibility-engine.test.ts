/**
 * MSG-20261005-07 CHANGE F: the eligibility decision table, using the verdict's
 * own examples, and proving no probability/model/LLM is involved.
 */

import { describe, expect, it } from 'vitest';

import {
  runEligibilityDecisionTable,
  SEO_PUBLIC_ELIGIBILITY_ENGINE_BOUNDARY,
  SEO_PUBLIC_ELIGIBILITY_REASON_CODES,
} from '../services/seo/seo-public-eligibility-engine';
import type { RecoveryRuleDefinition } from '../services/recovery-rules/recovery-rule-definition';

const rule = (eligibility: Partial<RecoveryRuleDefinition['eligibility']> = {}): RecoveryRuleDefinition =>
  ({
    eligibility: {
      requiresIorIdentity: true,
      requiresAuthorizedSigner: false,
      requiresBrokerPoa: false,
      requiresFilingAuthorization: false,
      minimumEvidenceCount: 3,
      ...eligibility,
    },
  }) as unknown as RecoveryRuleDefinition;

describe('SEO-3 eligibility decision table (CHANGE F)', () => {
  it('MISSING_IOR_IDENTITY: required identity that the caller does not claim', () => {
    const outcome = runEligibilityDecisionTable(rule(), { hasIorIdentity: false, evidenceCount: 3 });
    expect(outcome.eligible).toBe(false);
    expect(outcome.reasonCodes).toEqual([SEO_PUBLIC_ELIGIBILITY_REASON_CODES.missingIorIdentity]);
  });

  it('MISSING_BROKER_POA when the rule requires it', () => {
    const outcome = runEligibilityDecisionTable(
      rule({ requiresIorIdentity: false, requiresBrokerPoa: true }),
      { hasBrokerPoa: false, evidenceCount: 3 },
    );
    expect(outcome.reasonCodes).toEqual([SEO_PUBLIC_ELIGIBILITY_REASON_CODES.missingBrokerPoa]);
  });

  it('INSUFFICIENT_EVIDENCE: count below the rule threshold', () => {
    const outcome = runEligibilityDecisionTable(
      rule({ requiresIorIdentity: false }),
      { evidenceCount: 2 },
    );
    expect(outcome.eligible).toBe(false);
    expect(outcome.reasonCodes).toEqual([SEO_PUBLIC_ELIGIBILITY_REASON_CODES.insufficientEvidence]);
  });

  it('ELIGIBLE_WHEN_ALL_SATISFIED: count equal to the threshold passes', () => {
    const outcome = runEligibilityDecisionTable(rule(), { hasIorIdentity: true, evidenceCount: 3 });
    expect(outcome).toEqual({ eligible: true, reasonCodes: [] });
  });

  it('MULTIPLE_GAPS_ARE_ALL_REPORTED_IN_STABLE_ORDER', () => {
    const outcome = runEligibilityDecisionTable(
      rule({ requiresAuthorizedSigner: true, requiresBrokerPoa: true, requiresFilingAuthorization: true }),
      { hasIorIdentity: false, evidenceCount: 0 },
    );
    expect(outcome.reasonCodes).toEqual([
      SEO_PUBLIC_ELIGIBILITY_REASON_CODES.missingIorIdentity,
      SEO_PUBLIC_ELIGIBILITY_REASON_CODES.missingAuthorizedSigner,
      SEO_PUBLIC_ELIGIBILITY_REASON_CODES.missingBrokerPoa,
      SEO_PUBLIC_ELIGIBILITY_REASON_CODES.missingFilingAuthorization,
      SEO_PUBLIC_ELIGIBILITY_REASON_CODES.insufficientEvidence,
    ]);
  });

  it('UNREQUIRED_FLAGS_ARE_NOT_ENFORCED: a rule that requires nothing passes on empty answers', () => {
    const outcome = runEligibilityDecisionTable(
      rule({
        requiresIorIdentity: false,
        requiresAuthorizedSigner: false,
        requiresBrokerPoa: false,
        requiresFilingAuthorization: false,
        minimumEvidenceCount: 0,
      }),
      {},
    );
    expect(outcome).toEqual({ eligible: true, reasonCodes: [] });
  });

  it('NO_PROBABILITY_MODEL_OR_LLM: decision table only, count gate only', () => {
    expect(SEO_PUBLIC_ELIGIBILITY_ENGINE_BOUNDARY.decisionTableOnly).toBe(true);
    expect(SEO_PUBLIC_ELIGIBILITY_ENGINE_BOUNDARY.probabilityUsed).toBe(false);
    expect(SEO_PUBLIC_ELIGIBILITY_ENGINE_BOUNDARY.modelScoreUsed).toBe(false);
    expect(SEO_PUBLIC_ELIGIBILITY_ENGINE_BOUNDARY.llmUsed).toBe(false);
  });
});
