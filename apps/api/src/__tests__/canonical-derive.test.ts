/**
 * C-0006-A — canonical fact derivation unit tests (no database needed).
 */

import { describe, expect, it } from 'vitest';

import {
  activeFacts,
  conflictFacts,
  deriveFactsFromTransactions,
  toFactSourceTransaction,
  type TransactionProjection,
} from '../services/canonical';

const row = (over: Partial<TransactionProjection> & { id: string }): TransactionProjection => ({
  connectionId: null,
  connectionKind: 'API',
  referenceType: 'INVOICE',
  externalId: 'INV-1001',
  occurredAt: new Date('2026-09-01T00:00:00Z'),
  amount: '152.7500',
  currency: 'USD',
  ...over,
});

const derive = (rows: TransactionProjection[]) =>
  deriveFactsFromTransactions(rows.map(toFactSourceTransaction));

describe('C-0006-A — canonical fact derivation', () => {
  it('derives one ACTIVE fact when both modes agree', () => {
    const facts = derive([
      row({ id: 'file-1', connectionKind: 'FILE_UPLOAD' }),
      row({ id: 'api-1', connectionKind: 'API' }),
    ]);

    expect(facts).toHaveLength(1);
    const fact = facts[0];
    expect(fact.status).toBe('ACTIVE');
    expect(fact.factKey).toBe('INVOICE:INV-1001');
    expect(fact.sourceCount).toBe(2);
    expect(fact.confirmedAcrossModes).toBe(true);
    expect(fact.amount).toBe('152.75');
    expect(fact.transactionIds.sort()).toEqual(['api-1', 'file-1']);
    expect(conflictFacts(facts)).toHaveLength(0);
    expect(activeFacts(facts)).toHaveLength(1);
  });

  it('marks a disagreeing fact as CONFLICT and keeps every raw id', () => {
    const facts = derive([
      row({ id: 'file-1', connectionKind: 'FILE_UPLOAD', amount: '152.7500' }),
      row({ id: 'api-1', connectionKind: 'API', amount: '160.0000' }),
    ]);

    expect(facts).toHaveLength(1);
    const fact = facts[0];
    expect(fact.status).toBe('CONFLICT');
    expect(fact.conflictReason).toBe('AMOUNT_MISMATCH');
    expect(fact.sourceCount).toBe(2);
    expect(fact.confirmedAcrossModes).toBe(true);
    expect(activeFacts(facts)).toHaveLength(0);
    expect(conflictFacts(facts)).toHaveLength(1);
  });

  it('keeps rows without an external reference as their own facts', () => {
    const facts = derive([
      row({ id: 'a', externalId: null, amount: '10.0000' }),
      row({ id: 'b', externalId: '', amount: '20.0000' }),
    ]);

    expect(facts).toHaveLength(2);
    expect(facts.map((fact) => fact.factKey)).toEqual(['UNKEYED:a', 'UNKEYED:b']);
    expect(facts.every((fact) => fact.status === 'ACTIVE')).toBe(true);
  });

  it('is deterministic for a single source fact', () => {
    const facts = derive([row({ id: 'api-1', connectionKind: 'API' })]);
    expect(facts).toHaveLength(1);
    expect(facts[0].status).toBe('ACTIVE');
    expect(facts[0].confirmedAcrossModes).toBe(false);
    expect(facts[0].transactionIds).toEqual(['api-1']);
  });
});
