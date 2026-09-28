/**
 * Canonical fact writer (C-0006-A).
 * ---------------------------------------------------------------
 * MUST be called inside the same transaction as the SourceTransaction write:
 * the architecture review requires
 *
 *   transaction {
 *     create SourceTransaction
 *     create/update CanonicalFact
 *     create CanonicalFactSource
 *   }
 *
 * so Detection can never observe a half state (raw row without its fact).
 */

import { Prisma, type Channel, type RecoveryDomain } from '@prisma/client';

import { deriveFactsFromTransactions, toFactSourceTransaction, type DerivedFact, type TransactionProjection } from './derive';

export interface WriteCanonicalFactsInput {
  organizationId: string;
  domain: RecoveryDomain;
  channel: Channel;
  /** Rows written (or re-read) in this transaction. */
  transactionIds: string[];
  /** When this source observed the fact (never SourceTransaction.createdAt). */
  observedAt: Date;
}

export interface WriteCanonicalFactsResult {
  factsWritten: number;
  conflicts: DerivedFact[];
}

const ROW_SELECT = {
  id: true,
  connectionId: true,
  referenceType: true,
  externalId: true,
  occurredAt: true,
  amount: true,
  currency: true,
  connection: { select: { kind: true } },
} as const;

type SelectedRow = {
  id: string;
  connectionId: string | null;
  referenceType: string | null;
  externalId: string | null;
  occurredAt: Date | null;
  amount: Prisma.Decimal | null;
  currency: string;
  connection: { kind: string } | null;
};

function project(row: SelectedRow): TransactionProjection {
  return {
    id: row.id,
    connectionId: row.connectionId,
    connectionKind: (row.connection?.kind ?? null) as TransactionProjection['connectionKind'],
    referenceType: row.referenceType,
    externalId: row.externalId,
    occurredAt: row.occurredAt,
    amount: row.amount === null ? null : row.amount.toFixed(4),
    currency: row.currency,
  };
}

async function loadRows(
  tx: Prisma.TransactionClient,
  input: WriteCanonicalFactsInput,
): Promise<SelectedRow[]> {
  return tx.sourceTransaction.findMany({
    where: {
      organizationId: input.organizationId,
      domain: input.domain,
      channel: input.channel,
      id: { in: input.transactionIds },
    },
    select: ROW_SELECT,
  }) as Promise<SelectedRow[]>;
}

/** Every raw row that belongs to the same fact keys, so conflict detection sees all sources. */
async function loadRelatedRows(
  tx: Prisma.TransactionClient,
  input: WriteCanonicalFactsInput,
  seed: readonly TransactionProjection[],
): Promise<SelectedRow[]> {
  const referenced = new Map<string, { referenceType: string | null; externalId: string }>();
  const unkeyedIds: string[] = [];
  for (const row of seed) {
    if (row.externalId) {
      const key = `${(row.referenceType ?? 'UNKNOWN').toUpperCase()}:${row.externalId.toUpperCase()}`;
      if (!referenced.has(key)) {
        referenced.set(key, { referenceType: row.referenceType, externalId: row.externalId });
      }
    } else {
      unkeyedIds.push(row.id);
    }
  }

  const or: Prisma.SourceTransactionWhereInput[] = [...referenced.values()].map((pair) => ({
    ...(pair.referenceType === null
      ? { referenceType: null }
      : { referenceType: { equals: pair.referenceType, mode: 'insensitive' } }),
    externalId: { equals: pair.externalId, mode: 'insensitive' },
  }));
  if (unkeyedIds.length > 0) or.push({ id: { in: unkeyedIds } });
  if (or.length === 0) return [];

  return tx.sourceTransaction.findMany({
    where: {
      organizationId: input.organizationId,
      domain: input.domain,
      channel: input.channel,
      OR: or,
    },
    select: ROW_SELECT,
  }) as Promise<SelectedRow[]>;
}

export async function writeCanonicalFactsForTransactions(
  tx: Prisma.TransactionClient,
  input: WriteCanonicalFactsInput,
): Promise<WriteCanonicalFactsResult> {
  if (input.transactionIds.length === 0) return { factsWritten: 0, conflicts: [] };

  const seedRows = await loadRows(tx, input);
  if (seedRows.length === 0) return { factsWritten: 0, conflicts: [] };
  const seed = seedRows.map(project);
  const relatedRows = await loadRelatedRows(tx, input, seed);
  const related = relatedRows.map(project);

  const derived = deriveFactsFromTransactions(related.map(toFactSourceTransaction));
  const batchIds = new Set(input.transactionIds);
  const kindOf = new Map(seed.map((row) => [row.id, row.connectionKind]));

  let factsWritten = 0;
  const conflicts: DerivedFact[] = [];

  for (const fact of derived) {
    const persisted = await tx.canonicalFact.upsert({
      where: { organizationId_factKey: { organizationId: input.organizationId, factKey: fact.factKey } },
      create: {
        organizationId: input.organizationId,
        domain: input.domain,
        channel: input.channel,
        factKey: fact.factKey,
        referenceType: fact.referenceType,
        externalId: fact.externalId,
        occurredAt: fact.occurredAt,
        amount: fact.amount === null ? null : new Prisma.Decimal(fact.amount),
        currency: fact.currency,
        status: fact.status,
        sourceCount: fact.sourceCount,
        confirmedAcrossModes: fact.confirmedAcrossModes,
        firstSeenAt: input.observedAt,
      },
      update: {
        referenceType: fact.referenceType,
        externalId: fact.externalId,
        occurredAt: fact.occurredAt,
        amount: fact.amount === null ? null : new Prisma.Decimal(fact.amount),
        currency: fact.currency,
        status: fact.status,
        sourceCount: fact.sourceCount,
        confirmedAcrossModes: fact.confirmedAcrossModes,
      },
      select: { id: true },
    });
    factsWritten += 1;

    for (const transactionId of fact.transactionIds) {
      // Only rows from this batch carry this observation time; older sources keep theirs.
      if (!batchIds.has(transactionId)) continue;
      await tx.canonicalFactSource.upsert({
        where: {
          canonicalFactId_sourceTransactionId: {
            canonicalFactId: persisted.id,
            sourceTransactionId: transactionId,
          },
        },
        create: {
          organizationId: input.organizationId,
          canonicalFactId: persisted.id,
          sourceTransactionId: transactionId,
          connectionKind: kindOf.get(transactionId) ?? null,
          observedAt: input.observedAt,
        },
        update: {
          connectionKind: kindOf.get(transactionId) ?? null,
          observedAt: input.observedAt,
        },
      });
    }

    if (fact.status === 'CONFLICT') conflicts.push(fact);
  }

  return { factsWritten, conflicts };
}
