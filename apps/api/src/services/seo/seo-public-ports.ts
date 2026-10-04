/**
 * SEO-3 PUBLIC PORTS composition (MSG-20261005-05 follow-up).
 * The checker consumes ports; this module composes them from:
 *   - a rules provider (server-resolved RecoveryRuleDefinition v1),
 *   - an explicit engine registry (basisKey -> engine),
 *   - a clock.
 * Fail-closed rules:
 *   - no registry entry => listRegisteredBasisKeys does not advertise the key,
 *     and run* returns an explicit "unavailable" outcome (never fabricated money);
 *   - resolveActiveRule returns null for 0 effective rows OR for >1 effective
 *     versions of the same slug (canonical selector must be unique).
 * No I/O, no writes, no tenant data.
 */

import { isRecoveryRuleEffective, type RecoveryRuleDefinition } from '../recovery-rules/recovery-rule-definition';
import type { PublicInputSchema } from './seo-public-input-schema';
import type {
  SeoPublicAnswerValue,
  SeoPublicCalculationOutcome,
  SeoPublicCheckerPorts,
  SeoPublicEligibilityOutcome,
} from './seo-public-checker';

export interface SeoPublicEngine {
  basisKey: string;
  getPublicInputSchema(rule: RecoveryRuleDefinition): PublicInputSchema | null;
  runEligibility(input: {
    rule: RecoveryRuleDefinition;
    answers: Record<string, SeoPublicAnswerValue>;
  }): SeoPublicEligibilityOutcome | Promise<SeoPublicEligibilityOutcome>;
  runCalculation(input: {
    rule: RecoveryRuleDefinition;
    answers: Record<string, SeoPublicAnswerValue>;
  }): SeoPublicCalculationOutcome | Promise<SeoPublicCalculationOutcome>;
}

export interface SeoPublicEngineRegistry {
  list(): readonly string[];
  get(basisKey: string): SeoPublicEngine | null;
}

/** Default registry: nothing registered. Used until real engines are composed. */
export function createSeoPublicEngineRegistry(engines: readonly SeoPublicEngine[] = []): SeoPublicEngineRegistry {
  const byKey = new Map<string, SeoPublicEngine>();
  for (const engine of engines) {
    const key = String(engine.basisKey ?? '').trim();
    if (key === '') throw new Error('SEO_PUBLIC_ENGINE_KEY_REQUIRED');
    if (byKey.has(key)) throw new Error('SEO_PUBLIC_ENGINE_DUPLICATE:' + key);
    byKey.set(key, engine);
  }
  return {
    list: () => [...byKey.keys()].sort(),
    get: (basisKey: string) => byKey.get(basisKey) ?? null,
  };
}

export const SEO_PUBLIC_ENGINE_UNAVAILABLE = 'ENGINE_UNAVAILABLE';
export const SEO_PUBLIC_DISCLAIMER_KEY = 'seo.disclaimer.estimateOnly';

/** Explicit "engine not available": eligible=false, no numbers at all. */
export function unavailableEligibilityOutcome(): SeoPublicEligibilityOutcome {
  return { eligible: false, reasonCodes: [SEO_PUBLIC_ENGINE_UNAVAILABLE] };
}

/** Explicit "engine not available": estimate=null (never a fabricated range). */
export function unavailableCalculationOutcome(basisKey: string): SeoPublicCalculationOutcome {
  return { estimate: null, basisKey, disclaimerKey: SEO_PUBLIC_DISCLAIMER_KEY };
}

export interface CreateSeoPublicCheckerPortsInput {
  loadRules: () => Promise<readonly RecoveryRuleDefinition[]>;
  registry: SeoPublicEngineRegistry;
  now?: () => Date;
}

export function createSeoPublicCheckerPorts(input: CreateSeoPublicCheckerPortsInput): SeoPublicCheckerPorts {
  const clock = input.now ?? (() => new Date());
  return {
    async resolveActiveRule({ slug, now }) {
      const rules = await input.loadRules();
      const effective = rules.filter((rule) => rule.slug === slug && isRecoveryRuleEffective(rule, now));
      // Canonical selector must be unique: 0 rows or >1 effective version => not usable.
      if (effective.length !== 1) return null;
      return effective[0]!;
    },
    async listRegisteredBasisKeys() {
      return input.registry.list();
    },
    async getPublicInputSchema({ basisKey, rule }) {
      // MSG-20261005-07 CHANGE G: hand the rule to the engine so it can build
      // a rule-aware schema instead of a static one.
      return input.registry.get(basisKey)?.getPublicInputSchema(rule) ?? null;
    },
    async runEligibility({ basisKey, rule, answers }) {
      const engine = input.registry.get(basisKey);
      if (engine === null) return unavailableEligibilityOutcome();
      return engine.runEligibility({ rule, answers });
    },
    async runCalculation({ basisKey, rule, answers }) {
      const engine = input.registry.get(basisKey);
      if (engine === null) return unavailableCalculationOutcome(basisKey);
      return engine.runCalculation({ rule, answers });
    },
    now: clock,
  };
}

export const SEO_PUBLIC_PORTS_BOUNDARY = {
  fabricatedEngineOutput: false,
  unregisteredBasisKeyAdvertised: false,
  ambiguousRuleAccepted: false,
  externalWritePerformed: false,
  databaseWritePerformed: false,
  tenantDataIncluded: false,
} as const;
