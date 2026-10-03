/**
 * Canonical fact derivation (C-0006-A).
 * ---------------------------------------------------------------
 * Pure mapping: SourceTransaction projections → CanonicalFact drafts.
 *
 * It reuses the approved reconciliation semantics (fact key, decimal
 * normalisation, conflict reasons) so the persisted business fact layer and the
 * C-0005 reconciliation can never disagree about what a fact is.
 *
 *   ACTIVE   : every source agrees; the fact may enter Detection
 *   CONFLICT : sources disagree; the fact is persisted for audit/review but
 *              must never enter Detection / RuleEvaluation / Opportunity
 *
 * Rows without an external reference stay their own fact (never merged).
 */

import type { SourceConnectionKind } from '@prisma/client';

import {
  factKeyOf,
  modeOf,
  reconcileSourceFacts,
  type FactMode,
  type FactSourceTransaction,
  type SourceConflictReason,
} from '../reconciliation';

export type CanonicalFactStatus = 'ACTIVE' | 'CONFLICT';

export interface TransactionProjection {
  id: string;
  connectionId: string | null;
  connectionKind: SourceConnectionKind | null;
  /** TRACK C2 M4：account scope（服务端从 connection.platformAccountId 派生）。 */
  accountId?: string | null;
  referenceType: string | null;
  externalId: string | null;
  occurredAt: Date | null;
  /** Decimal(18,4) as string; null when the source had no amount. */
  amount: string | null;
  currency: string;
}

export interface DerivedFact {
  factKey: string;
  /** TRACK C2 M4：account scope（null = legacy 行）。 */
  accountId: string | null;
  referenceType: string | null;
  externalId: string | null;
  occurredAt: Date | null;
  amount: string | null;
  currency: string;
  status: CanonicalFactStatus;
  sourceCount: number;
  confirmedAcrossModes: boolean;
  transactionIds: string[];
  conflictReason?: SourceConflictReason;
}

export function toFactSourceTransaction(row: TransactionProjection): FactSourceTransaction {
  return {
    id: row.id,
    connectionId: row.connectionId,
    connectionKind: row.connectionKind,
    accountId: row.accountId ?? null,
    referenceType: row.referenceType,
    externalId: row.externalId,
    occurredAt: row.occurredAt,
    amount: row.amount,
    currency: row.currency,
  };
}

function modesOf(rows: readonly FactSourceTransaction[]): Set<FactMode> {
  return new Set(rows.map((row) => modeOf(row.connectionKind)));
}

export function deriveFactsFromTransactions(
  rows: readonly FactSourceTransaction[],
): DerivedFact[] {
  if (rows.length === 0) return [];
  const reconciled = reconcileSourceFacts(rows);

  const active: DerivedFact[] = reconciled.facts.map((fact) => ({
    factKey: fact.factKey,
    accountId: fact.accountId,
    referenceType: fact.referenceType,
    externalId: fact.externalId,
    occurredAt: fact.occurredAt,
    amount: fact.amount,
    currency: fact.currency,
    status: 'ACTIVE',
    sourceCount: fact.transactionIds.length,
    confirmedAcrossModes: fact.confirmedAcrossModes,
    transactionIds: fact.transactionIds,
  }));

  const conflicts: DerivedFact[] = reconciled.conflicts.map((conflict) => {
    const rowsOfConflict = rows.filter((row) =>
      conflict.entries.some((entry) => entry.transactionId === row.id),
    );
    const modes = modesOf(rowsOfConflict);
    return {
      factKey: conflict.factKey,
      accountId: conflict.accountId,
      referenceType: conflict.referenceType,
      externalId: conflict.externalId,
      occurredAt: rowsOfConflict[0]?.occurredAt ?? null,
      amount: rowsOfConflict[0]?.amount ?? null,
      currency: rowsOfConflict[0]?.currency ?? 'USD',
      status: 'CONFLICT',
      sourceCount: conflict.entries.length,
      confirmedAcrossModes: modes.has('FILE_UPLOAD') && modes.has('API'),
      transactionIds: conflict.entries.map((entry) => entry.transactionId),
      conflictReason: conflict.reason,
    };
  });

  return [...active, ...conflicts];
}

/** Only ACTIVE facts may be handed to Detection. */
export function activeFacts(facts: readonly DerivedFact[]): DerivedFact[] {
  return facts.filter((fact) => fact.status === 'ACTIVE');
}

export function conflictFacts(facts: readonly DerivedFact[]): DerivedFact[] {
  return facts.filter((fact) => fact.status === 'CONFLICT');
}

export function affectedFactKeys(rows: readonly TransactionProjection[]): string[] {
  const keys = new Set<string>();
  for (const row of rows) {
    keys.add(factKeyOf(toFactSourceTransaction(row)) ?? `UNKEYED:${row.id}`);
  }
  return [...keys];
}
