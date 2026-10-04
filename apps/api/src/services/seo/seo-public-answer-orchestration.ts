/**
 * SEO-3 / MSG-20261005-06 item (5): dual-schema answer orchestration.
 * The checker previously validated answers against ONE schema (eligibility when
 * the checker was ready, otherwise calculation), so a request carrying
 * calculation fields was rejected as UNKNOWN_ANSWER_KEY. This module builds a
 * request-level union whitelist from BOTH schemas, refuses conflicting field
 * definitions, and projects the answers into two disjoint sets so eligibility
 * and calculation engines each only see their own keys.
 * Pure function: no I/O, no writes, no tenant data.
 */

import {
  validatePublicAnswersAgainstSchema,
  type PublicInputField,
  type PublicInputSchema,
} from './seo-public-input-schema';
import type { SeoPublicAnswerValue } from './seo-public-checker';

export type PublicAnswerOrchestrationCode =
  | 'SCHEMA_NOT_REGISTERED'
  | 'SCHEMA_CONFLICT'
  | 'UNKNOWN_ANSWER_KEY'
  | 'INVALID_REQUEST';

export type PublicAnswerOrchestrationResult =
  | {
      ok: true;
      eligibilityAnswers: Record<string, SeoPublicAnswerValue>;
      calculationAnswers: Record<string, SeoPublicAnswerValue>;
    }
  | { ok: false; code: PublicAnswerOrchestrationCode };

export interface PublicAnswerOrchestrationInput {
  answers: Record<string, SeoPublicAnswerValue>;
  eligibility: { active: boolean; schema: PublicInputSchema | null };
  calculation: { active: boolean; schema: PublicInputSchema | null };
}

const keysOf = (schema: PublicInputSchema | null): string[] =>
  schema === null ? [] : Object.keys(schema.fields);

const pick = (
  answers: Record<string, SeoPublicAnswerValue>,
  keys: readonly string[],
): Record<string, SeoPublicAnswerValue> => {
  const out: Record<string, SeoPublicAnswerValue> = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(answers, key)) out[key] = answers[key]!;
  }
  return out;
};

/**
 * Union whitelist + conflict detection + projection.
 * - an active capability whose schema is not registered => SCHEMA_NOT_REGISTERED
 * - the same key defined differently by both schemas => SCHEMA_CONFLICT (fail closed)
 * - an answer key in neither schema => UNKNOWN_ANSWER_KEY
 * - per-side value/type/range checks are delegated to the schema validator
 */
export function orchestratePublicAnswerSchemas(
  input: PublicAnswerOrchestrationInput,
): PublicAnswerOrchestrationResult {
  const { answers } = input;

  if (input.eligibility.active && input.eligibility.schema === null) {
    return { ok: false, code: 'SCHEMA_NOT_REGISTERED' };
  }
  if (input.calculation.active && input.calculation.schema === null) {
    return { ok: false, code: 'SCHEMA_NOT_REGISTERED' };
  }

  const eligibilityKeys = keysOf(input.eligibility.schema);
  const calculationKeys = keysOf(input.calculation.schema);

  // Conflict: the same key must not be defined differently on both sides.
  if (input.eligibility.schema !== null && input.calculation.schema !== null) {
    for (const key of eligibilityKeys) {
      const other: PublicInputField | undefined = input.calculation.schema.fields[key];
      if (other === undefined) continue;
      const a = JSON.stringify(input.eligibility.schema.fields[key]);
      const b = JSON.stringify(other);
      if (a !== b) return { ok: false, code: 'SCHEMA_CONFLICT' };
    }
  }

  const allowed = new Set<string>([...eligibilityKeys, ...calculationKeys]);
  for (const key of Object.keys(answers)) {
    if (!allowed.has(key)) return { ok: false, code: 'UNKNOWN_ANSWER_KEY' };
  }

  // Project first, then run the per-side validator so each engine only sees its own keys.
  let eligibilityAnswers: Record<string, SeoPublicAnswerValue> = {};
  if (input.eligibility.active && input.eligibility.schema !== null) {
    const projected = pick(answers, eligibilityKeys);
    const checked = validatePublicAnswersAgainstSchema({
      answers: projected,
      schema: input.eligibility.schema,
    });
    if (!checked.ok) {
      return { ok: false, code: checked.code === 'UNKNOWN_ANSWER_KEY' ? 'UNKNOWN_ANSWER_KEY' : 'INVALID_REQUEST' };
    }
    eligibilityAnswers = (checked.answers ?? projected) as Record<string, SeoPublicAnswerValue>;
  }

  let calculationAnswers: Record<string, SeoPublicAnswerValue> = {};
  if (input.calculation.active && input.calculation.schema !== null) {
    const projected = pick(answers, calculationKeys);
    const checked = validatePublicAnswersAgainstSchema({
      answers: projected,
      schema: input.calculation.schema,
    });
    if (!checked.ok) {
      return { ok: false, code: checked.code === 'UNKNOWN_ANSWER_KEY' ? 'UNKNOWN_ANSWER_KEY' : 'INVALID_REQUEST' };
    }
    calculationAnswers = (checked.answers ?? projected) as Record<string, SeoPublicAnswerValue>;
  }

  return { ok: true, eligibilityAnswers, calculationAnswers };
}

export const SEO_PUBLIC_ANSWER_ORCHESTRATION_BOUNDARY = {
  singleSchemaShortcut: false,
  conflictFailsClosed: true,
  projectionsAreDisjoint: true,
  externalWritePerformed: false,
  tenantDataIncluded: false,
} as const;
