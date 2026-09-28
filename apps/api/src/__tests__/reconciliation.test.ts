/**
 * C-0005 / Gate 3 — cross-source reconciliation unit tests (no database needed).
 * ---------------------------------------------------------------
 * Rules under test:
 *   - the same fact reached through FILE_UPLOAD and API is counted once, with
 *     both raw sources preserved (provenance is never destroyed)
 *   - disagreeing values fail closed (SOURCE_CONFLICT) instead of picking a winner
 *   - rows without an external reference are never merged with anything else
 */

import { describe, expect, it } from 'vitest';

import {
  SourceConflictError,
  assertNoSourceConflict,
  factKeyOf,
  normalizeDecimal,
  reconcileSourceFacts,
  type FactSourceTransaction,
} from '../services/reconciliation';

const tx = (over: Partial<FactSourceTransaction> & { id: string }): FactSourceTransaction => ({
  connectionId: null,
  connectionKind: 'API',
  referenceType: 'INVOICE',
  externalId: 'INV-1001',
  occurredAt: new Date('2026-09-01T00:00:00Z'),
  amount: '152.7500',
  currency: 'USD',
  ...over,
});

describe('C-0005 / Gate 3 — reconciliation primitives', () => {
  it('normalises decimal strings before comparing money', () => {
    expect(normalizeDecimal('152.7500')).toBe('152.75');
    expect(normalizeDecimal('152.75')).toBe('152.75');
    expect(normalizeDecimal('0.0000')).toBe('0');
    expect(normalizeDecimal('-0.5000')).toBe('-0.5');
    expect(normalizeDecimal(' 12 ')).toBe('12');
    expect(normalizeDecimal(null)).toBeNull();
  });

  it('keys a fact by reference type + external id, case-insensitively', () => {
    expect(factKeyOf(tx({ id: 'a' }))).toBe('INVOICE:INV-1001');
    expect(factKeyOf(tx({ id: 'b', externalId: 'inv-1001' }))).toBe('INVOICE:INV-1001');
    expect(factKeyOf(tx({ id: 'c', referenceType: null }))).toBe('UNKNOWN:INV-1001');
    expect(factKeyOf(tx({ id: 'd', externalId: '   ' }))).toBeNull();
    expect(factKeyOf(tx({ id: 'e', externalId: null }))).toBeNull();
  });
});

describe('C-0005 / Gate 3 — single fact reached through both modes', () => {
  it('counts the fact once and records that both modes confirmed it', () => {
    const result = reconcileSourceFacts([
      tx({ id: 'file-1', connectionId: 'conn-file', connectionKind: 'FILE_UPLOAD' }),
      tx({ id: 'api-1', connectionId: 'conn-api', connectionKind: 'API' }),
    ]);

    expect(result.status).toBe('OK');
    expect(result.conflicts).toHaveLength(0);
    expect(result.facts).toHaveLength(1);
    const fact = result.facts[0];
    expect(fact.factKey).toBe('INVOICE:INV-1001');
    expect(fact.transactionIds).toEqual(['file-1', 'api-1']);
    expect(fact.modes).toEqual({ FILE_UPLOAD: 1, API: 1, OTHER: 0 });
    expect(fact.confirmedAcrossModes).toBe(true);
    expect(fact.amount).toBe('152.75');
    expect(() => assertNoSourceConflict(result)).not.toThrow();
  });

  it('treats same-value duplicates inside one mode as one fact', () => {
    const result = reconcileSourceFacts([
      tx({ id: 'file-1', connectionId: 'conn-file-a', connectionKind: 'FILE_UPLOAD' }),
      tx({ id: 'file-2', connectionId: 'conn-file-b', connectionKind: 'FILE_UPLOAD' }),
    ]);

    expect(result.status).toBe('OK');
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0].modeDuplicates).toBe(1);
    expect(result.facts[0].modes.FILE_UPLOAD).toBe(2);
    expect(result.facts[0].confirmedAcrossModes).toBe(false);
  });

  it('keeps a single-mode fact when only one source saw it', () => {
    const result = reconcileSourceFacts([tx({ id: 'api-1', connectionKind: 'API' })]);

    expect(result.status).toBe('OK');
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0].confirmedAcrossModes).toBe(false);
    expect(result.facts[0].transactionIds).toEqual(['api-1']);
  });
});

describe('C-0005 / Gate 3 — conflicts fail closed', () => {
  it('flags an amount mismatch across modes and drops the fact', () => {
    const result = reconcileSourceFacts([
      tx({ id: 'file-1', connectionKind: 'FILE_UPLOAD', amount: '152.7500' }),
      tx({ id: 'api-1', connectionKind: 'API', amount: '152.7000' }),
    ]);

    expect(result.status).toBe('CONFLICT');
    expect(result.droppedFacts).toBe(1);
    expect(result.facts).toHaveLength(0);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].reason).toBe('AMOUNT_MISMATCH');
    expect(result.conflicts[0].entries.map((entry) => entry.mode)).toEqual(['FILE_UPLOAD', 'API']);

    expect(() => assertNoSourceConflict(result)).toThrow(SourceConflictError);
    try {
      assertNoSourceConflict(result);
    } catch (err) {
      expect((err as SourceConflictError).code).toBe('SOURCE_CONFLICT');
      expect((err as SourceConflictError).conflicts).toHaveLength(1);
    }
  });

  it('flags currency and date mismatches', () => {
    const currency = reconcileSourceFacts([
      tx({ id: 'file-1', connectionKind: 'FILE_UPLOAD', currency: 'USD' }),
      tx({ id: 'api-1', connectionKind: 'API', currency: 'EUR' }),
    ]);
    expect(currency.conflicts[0].reason).toBe('CURRENCY_MISMATCH');

    const date = reconcileSourceFacts([
      tx({ id: 'file-1', connectionKind: 'FILE_UPLOAD', occurredAt: new Date('2026-09-01T00:00:00Z') }),
      tx({ id: 'api-1', connectionKind: 'API', occurredAt: new Date('2026-09-02T00:00:00Z') }),
    ]);
    expect(date.conflicts[0].reason).toBe('DATE_MISMATCH');
  });

  it('accepts the same day with different timestamps and notes a date gap instead', () => {
    const sameDay = reconcileSourceFacts([
      tx({ id: 'file-1', connectionKind: 'FILE_UPLOAD', occurredAt: new Date('2026-09-01T00:10:00Z') }),
      tx({ id: 'api-1', connectionKind: 'API', occurredAt: new Date('2026-09-01T22:30:00Z') }),
    ]);
    expect(sameDay.status).toBe('OK');
    expect(sameDay.facts[0].dateGap).toBe(false);

    const gap = reconcileSourceFacts([
      tx({ id: 'file-1', connectionKind: 'FILE_UPLOAD', occurredAt: null }),
      tx({ id: 'api-1', connectionKind: 'API', occurredAt: new Date('2026-09-01T00:00:00Z') }),
    ]);
    expect(gap.status).toBe('OK');
    expect(gap.facts[0].dateGap).toBe(true);
  });

  it('keeps rows without an external reference separate instead of merging them', () => {
    const result = reconcileSourceFacts([
      tx({ id: 'a', externalId: null, connectionKind: 'FILE_UPLOAD', amount: '10.0000' }),
      tx({ id: 'b', externalId: '', connectionKind: 'API', amount: '20.0000' }),
    ]);

    expect(result.status).toBe('OK');
    expect(result.facts).toHaveLength(2);
    expect(result.facts.map((fact) => fact.factKey)).toEqual(['UNKEYED:a', 'UNKEYED:b']);
    expect(result.facts.every((fact) => fact.confirmedAcrossModes === false)).toBe(true);
  });

  it('reports the scanned transaction count', () => {
    const result = reconcileSourceFacts([
      tx({ id: 'a' }),
      tx({ id: 'b' }),
      tx({ id: 'c', externalId: 'INV-2000' }),
    ]);
    expect(result.transactions).toBe(3);
    expect(result.facts).toHaveLength(2);
  });
});
