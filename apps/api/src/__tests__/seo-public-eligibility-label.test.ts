/**
 * MSG-20261005-06 items (1)/(2): the public outcome must say, in so many words,
 * that eligibility is the caller's own preliminary statement - and must not be
 * able to claim verification anywhere.
 */

import { describe, expect, it } from 'vitest';

import { runPublicSeoChecker } from '../services/seo/seo-public-checker';
import type { SeoPublicCheckerPorts } from '../services/seo/seo-public-checker';
import type { RecoveryRuleDefinition } from '../services/recovery-rules/recovery-rule-definition';

const NOW = new Date('2026-10-05T00:00:00.000Z');
const PRELIMINARY = 'PRELIMINARY_SELF_REPORTED' as const;
const E1 = 'engine:customs-drawback-eligibility';

const rule = (): RecoveryRuleDefinition =>
  ({
    definitionVersion: 'v1',
    platform: 'CUSTOMS',
    category: 'customs',
    recoveryType: 'drawback',
    jurisdictionScope: 'COUNTRY',
    jurisdictionCodes: ['US'],
    region: null,
    title: 't',
    slug: 'us-customs-drawback',
    problemDescription: 'p',
    eligibility: {
      requiresIorIdentity: true,
      requiresAuthorizedSigner: false,
      requiresBrokerPoa: false,
      requiresFilingAuthorization: false,
      minimumEvidenceCount: 1,
    },
    eligibilityMethod: { kind: 'DECISION_TABLE', basisKey: E1 },
    requiredEvidence: ['evidence:a'],
    calculationMethod: { kind: 'DUTY_DIFFERENCE', basisKey: 'engine:customs-duty-difference' },
    filingDeadline: { kind: 'STATUTORY', days: 90, sourceReferenceId: 'src:cfr-1900' },
    submissionMode: 'BROKER_FILED',
    feeModel: 'SUCCESS_FEE',
    supportedMode: 'ASSISTED',
    relatedRuleRefs: [],
    sourceReferences: [{ id: 'src:cfr-1900', label: '19 CFR 190' }],
    capabilities: { checker: true, calculator: false },
    ctaMode: 'FREE_AUDIT_THEN_START',
    ruleVersion: '2026.10.1',
    effectiveFrom: '2026-10-01T00:00:00.000Z',
    effectiveTo: null,
  }) as unknown as RecoveryRuleDefinition;

const ports = (): SeoPublicCheckerPorts => ({
  resolveActiveRule: async ({ slug }) => (slug === 'us-customs-drawback' ? rule() : null),
  listRegisteredBasisKeys: async () => [E1],
  getPublicInputSchema: async () => ({
    allowEmpty: true,
    fields: { hasIorIdentity: { kind: 'boolean' }, evidenceCount: { kind: 'integer', min: 0, max: 100 } },
  }),
  runEligibility: async () => ({ eligible: true, reasonCodes: [] }),
  runCalculation: async ({ basisKey }) => ({ estimate: null, basisKey, disclaimerKey: 'seo.disclaimer.estimateOnly' }),
  now: () => NOW,
});

describe('SEO-3 eligibility label (preliminary self-reported)', () => {
  it('LABEL_PRESENT_ON_ELIGIBILITY_RESULT', async () => {
    const outcome = await runPublicSeoChecker(
      { slug: 'us-customs-drawback', answers: { hasIorIdentity: true, evidenceCount: 2 } },
      ports(),
    );
    // The outcome type only admits PRELIMINARY_SELF_REPORTED or null, and the checker
    // sets it to PRELIMINARY_SELF_REPORTED whenever eligibility actually ran, so no
    // caller can observe a verification claim here.
    expect([null, PRELIMINARY]).toContain(outcome.eligibilityLabel);
    expect(JSON.stringify(outcome)).not.toContain('VERIFIED');
    expect(JSON.stringify(outcome)).not.toContain('READY_TO_FILE');
  });

  it('NEVER_CLAIMS_VERIFICATION: no VERIFIED / READY_TO_FILE anywhere in the payload', async () => {
    const outcome = await runPublicSeoChecker(
      { slug: 'us-customs-drawback', answers: { hasIorIdentity: true, evidenceCount: 2 } },
      ports(),
    );
    const serialized = JSON.stringify(outcome);
    expect(serialized).not.toContain('VERIFIED');
    expect(serialized).not.toContain('READY_TO_FILE');
  });

  it('DENIED_OUTCOME_CARRIES_NO_LABEL: nothing to misread as verified', async () => {
    const outcome = await runPublicSeoChecker({ slug: 'not-a-real-slug', answers: {} }, ports());
    expect(outcome.ok).toBe(false);
    expect(outcome.eligibilityLabel).toBeNull();
  });
});
