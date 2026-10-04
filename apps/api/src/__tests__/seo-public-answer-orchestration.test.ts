/**
 * MSG-20261005-06 item (5): union whitelist, conflict fail-closed and
 * per-engine projection for the dual-schema public inputs.
 */

import { describe, expect, it } from 'vitest';

import {
  orchestratePublicAnswerSchemas,
  SEO_PUBLIC_ANSWER_ORCHESTRATION_BOUNDARY,
} from '../services/seo/seo-public-answer-orchestration';
import type { PublicInputSchema } from '../services/seo/seo-public-input-schema';

const ELIGIBILITY: PublicInputSchema = {
  allowEmpty: true,
  fields: {
    hasIorIdentity: { kind: 'boolean' },
    evidenceCount: { kind: 'integer', min: 0, max: 50 },
  },
};

const CALCULATION: PublicInputSchema = {
  allowEmpty: true,
  fields: {
    dutyPaidAmount: { kind: 'number', min: 0, max: 1_000_000 },
    dutyActuallyDueAmount: { kind: 'number', min: 0, max: 1_000_000 },
    currency: { kind: 'enum', options: ['USD', 'EUR'] },
  },
};

const input = (over: Record<string, unknown> = {}) => ({
  answers: {},
  eligibility: { active: true, schema: ELIGIBILITY },
  calculation: { active: true, schema: CALCULATION },
  ...over,
});

describe('SEO-3 dual-schema answer orchestration', () => {
  it('BOTH_SCHEMAS_WORK_TOGETHER: calculation keys are no longer rejected', () => {
    const result = orchestratePublicAnswerSchemas(
      input({
        answers: { hasIorIdentity: true, evidenceCount: 3, dutyPaidAmount: 1000, dutyActuallyDueAmount: 600, currency: 'USD' },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.eligibilityAnswers).toEqual({ hasIorIdentity: true, evidenceCount: 3 });
    expect(result.calculationAnswers).toEqual({
      dutyPaidAmount: 1000,
      dutyActuallyDueAmount: 600,
      currency: 'USD',
    });
  });

  it('PROJECTIONS_ARE_DISJOINT: each engine sees only its own keys', () => {
    const result = orchestratePublicAnswerSchemas(input({ answers: { hasIorIdentity: true, currency: 'EUR' } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.eligibilityAnswers)).toEqual(['hasIorIdentity']);
    expect(Object.keys(result.calculationAnswers)).toEqual(['currency']);
  });

  it('UNKNOWN_KEY_STILL_REJECTED: a key in neither schema fails closed', () => {
    const result = orchestratePublicAnswerSchemas(input({ answers: { phone: 'x' } }));
    expect(result).toEqual({ ok: false, code: 'UNKNOWN_ANSWER_KEY' });
  });

  it('CONFLICT_FAILS_CLOSED: the same key defined differently on both sides is refused', () => {
    const conflicting: PublicInputSchema = {
      allowEmpty: true,
      fields: { evidenceCount: { kind: 'number', min: 0, max: 1 } },
    };
    const result = orchestratePublicAnswerSchemas(input({ calculation: { active: true, schema: conflicting } }));
    expect(result).toEqual({ ok: false, code: 'SCHEMA_CONFLICT' });
  });

  it('IDENTICAL_DUPLICATE_IS_NOT_A_CONFLICT: same definition on both sides is fine', () => {
    const result = orchestratePublicAnswerSchemas(
      input({
        calculation: { active: true, schema: { allowEmpty: true, fields: { evidenceCount: { kind: 'integer', min: 0, max: 50 } } } },
        answers: { evidenceCount: 2 },
      }),
    );
    expect(result.ok).toBe(true);
  });

  it('MISSING_SCHEMA_FOR_ACTIVE_CAPABILITY: SCHEMA_NOT_REGISTERED', () => {
    const result = orchestratePublicAnswerSchemas(input({ calculation: { active: true, schema: null } }));
    expect(result).toEqual({ ok: false, code: 'SCHEMA_NOT_REGISTERED' });
  });

  it('INACTIVE_CAPABILITY_IS_SKIPPED: calculator off => its keys are not required', () => {
    const result = orchestratePublicAnswerSchemas(
      input({ calculation: { active: false, schema: null }, answers: { hasIorIdentity: false } }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.calculationAnswers).toEqual({});
  });

  it('OUT_OF_RANGE_VALUE_STILL_REJECTED: schema ranges are enforced per side', () => {
    const result = orchestratePublicAnswerSchemas(input({ answers: { evidenceCount: 999 } }));
    expect(result).toEqual({ ok: false, code: 'INVALID_REQUEST' });
  });

  it('BOUNDARY: no single-schema shortcut, conflicts fail closed, no writes', () => {
    expect(SEO_PUBLIC_ANSWER_ORCHESTRATION_BOUNDARY.singleSchemaShortcut).toBe(false);
    expect(SEO_PUBLIC_ANSWER_ORCHESTRATION_BOUNDARY.conflictFailsClosed).toBe(true);
    expect(SEO_PUBLIC_ANSWER_ORCHESTRATION_BOUNDARY.tenantDataIncluded).toBe(false);
  });
});
