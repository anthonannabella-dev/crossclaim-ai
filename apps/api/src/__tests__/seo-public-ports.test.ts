/**
 * SEO-3 public ports composition contract.
 * Locks the fail-closed rules: an empty registry advertises no basis keys and
 * never fabricates an estimate, an ambiguous slug (two effective versions) is
 * refused, and a registered engine is delegated to verbatim.
 */

import { describe, expect, it } from 'vitest';

import { runPublicSeoChecker } from '../services/seo/seo-public-checker';
import {
  createSeoPublicCheckerPorts,
  createSeoPublicEngineRegistry,
  SEO_PUBLIC_ENGINE_UNAVAILABLE,
  SEO_PUBLIC_PORTS_BOUNDARY,
} from '../services/seo/seo-public-ports';
import type { RecoveryRuleDefinition } from '../services/recovery-rules/recovery-rule-definition';

const NOW = new Date('2026-10-05T00:00:00.000Z');
const E1 = 'engine:customs-drawback-eligibility';
const E2 = 'engine:customs-duty-difference';

const rule = (over: Partial<RecoveryRuleDefinition> = {}): RecoveryRuleDefinition =>
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
      requiresBrokerPoa: true,
      requiresFilingAuthorization: true,
      minimumEvidenceCount: 2,
    },
    eligibilityMethod: { kind: 'DECISION_TABLE', basisKey: E1 },
    requiredEvidence: ['evidence:a', 'evidence:b'],
    calculationMethod: { kind: 'DUTY_DIFFERENCE', basisKey: E2 },
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
    ...over,
  }) as unknown as RecoveryRuleDefinition;

const engine = (basisKey: string, estimate = { min: 100, max: 200, currency: 'USD' }) => ({
  basisKey,
  getPublicInputSchema: () => ({ fields: { reexported: { kind: 'boolean' as const } }, allowEmpty: true }),
  runEligibility: () => ({ eligible: true, reasonCodes: [] }),
  runCalculation: () => ({ estimate, basisKey, disclaimerKey: 'seo.disclaimer.estimateOnly' }),
});

const ports = (rules: readonly RecoveryRuleDefinition[], registry = createSeoPublicEngineRegistry()) =>
  createSeoPublicCheckerPorts({ loadRules: async () => rules, registry, now: () => NOW });

describe('SEO-3 public ports composition', () => {
  it('EMPTY_REGISTRY_ADVERTISES_NOTHING: no basis keys, no fabricated estimate', async () => {
    const p = ports([rule()]);
    expect(await p.listRegisteredBasisKeys()).toEqual([]);

    const eligibility = await p.runEligibility({ basisKey: E1, rule: rule(), answers: {} });
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.reasonCodes).toContain(SEO_PUBLIC_ENGINE_UNAVAILABLE);

    const calculation = await p.runCalculation({ basisKey: E2, rule: rule(), answers: {} });
    expect(calculation.estimate).toBeNull();
    expect(calculation.basisKey).toBe(E2);
  });

  it('UNREGISTERED_ENGINE_NEVER_200: checker fails closed instead of returning numbers', async () => {
    const p = ports([rule()]);
    const outcome = await runPublicSeoChecker({ slug: 'us-customs-drawback', answers: {} }, p);
    // With nothing registered the checker must never claim a successful estimate.
    expect(outcome.ok).toBe(false);
    expect(JSON.stringify(outcome)).not.toContain('"min"');
  });

  it('REGISTERED_ENGINE_IS_DELEGATED: values come from the engine, not the composition layer', async () => {
    const registry = createSeoPublicEngineRegistry([engine(E1), engine(E2, { min: 7, max: 9, currency: 'EUR' })]);
    const p = ports([rule()], registry);
    expect(await p.listRegisteredBasisKeys()).toEqual([E1, E2].sort());
    const calculation = await p.runCalculation({ basisKey: E2, rule: rule(), answers: {} });
    expect(calculation.estimate).toEqual({ min: 7, max: 9, currency: 'EUR' });
  });

  it('AMBIGUOUS_SLUG_IS_REFUSED: two effective versions => null (canonical must be unique)', async () => {
    const p = ports([rule({ ruleVersion: '2026.10.1' }), rule({ ruleVersion: '2026.10.2' })]);
    expect(await p.resolveActiveRule({ slug: 'us-customs-drawback', now: NOW })).toBeNull();
  });

  it('SINGLE_EFFECTIVE_RULE_RESOLVES: exactly one effective version is returned', async () => {
    const p = ports([rule()]);
    const resolved = await p.resolveActiveRule({ slug: 'us-customs-drawback', now: NOW });
    expect(resolved?.ruleVersion).toBe('2026.10.1');
  });

  it('NON_EFFECTIVE_RULE_IS_NOT_RESOLVED: outside its window => null', async () => {
    const p = ports([rule({ effectiveFrom: '2027-01-01T00:00:00.000Z' })]);
    expect(await p.resolveActiveRule({ slug: 'us-customs-drawback', now: NOW })).toBeNull();
  });

  it('BOUNDARY: no fabrication, no writes, no tenant data', () => {
    expect(SEO_PUBLIC_PORTS_BOUNDARY.fabricatedEngineOutput).toBe(false);
    expect(SEO_PUBLIC_PORTS_BOUNDARY.unregisteredBasisKeyAdvertised).toBe(false);
    expect(SEO_PUBLIC_PORTS_BOUNDARY.tenantDataIncluded).toBe(false);
  });
});
