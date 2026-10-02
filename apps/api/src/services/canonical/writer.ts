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

import { resolveCanonicalAccountForTransactions } from '../account-lineage/policy';
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
  accountId: true,
  referenceType: true,
  externalId: true,
  occurredAt: true,
  amount: true,
  currency: true,
  connection: { select: { kind: true, platformAccountId: true } },
} as const;

type SelectedRow = {
  id: string;
  connectionId: string | null;
  accountId: string | null;
  referenceType: string | null;
  externalId: string | null;
  occurredAt: Date | null;
  amount: Prisma.Decimal | null;
  currency: string;
  connection: { kind: string; platformAccountId: string | null } | null;
};

function project(row: SelectedRow): TransactionProjection {
  return {
    id: row.id,
    connectionId: row.connectionId,
    connectionKind: (row.connection?.kind ?? null) as TransactionProjection['connectionKind'],
    // 服务端派生：优先已持久化的 accountId，其次连接上下文（迁移窗口内的历史行）。
    accountId: row.accountId ?? row.connection?.platformAccountId ?? null,
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

/**
 * TRACK C2 M4：作用域相等 ≠ 字段相等。
 * scope(row) = stored accountId ?? connection.platformAccountId（迁移窗口内历史行的 accountId 仍为 NULL）。
 * 在内存中判定，而不是写成 SQL 的 relation OR —— 后者会让 1 万行导入退化成超时。
 */
function accountScopeOf(row: SelectedRow): string | null {
  return row.accountId ?? row.connection?.platformAccountId ?? null;
}

/** Every raw row that belongs to the same fact keys, so conflict detection sees all sources. */
async function loadRelatedRows(
  tx: Prisma.TransactionClient,
  input: WriteCanonicalFactsInput,
  seed: readonly TransactionProjection[],
): Promise<SelectedRow[]> {
  // TRACK C2 M4：关联行必须在**同一 account 作用域**内加载；否则同一 externalId
  // 在不同 account 之间会被错误地合并成一条事实（或误判为来源冲突）。
  const referenced = new Map<
    string,
    { referenceType: string | null; externalId: string; accountId: string | null }
  >();
  const unkeyedIds: string[] = [];
  for (const row of seed) {
    if (row.externalId) {
      const scope = row.accountId ?? '';
      const key = `${scope}\u0000${(row.referenceType ?? 'UNKNOWN').toUpperCase()}:${row.externalId.toUpperCase()}`;
      if (!referenced.has(key)) {
        referenced.set(key, {
          referenceType: row.referenceType,
          externalId: row.externalId,
          accountId: row.accountId ?? null,
        });
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

/**
 * TRACK C2 M4/M5：事实身份在 account 作用域内唯一。
 *
 * 复合唯一键 (organizationId, accountId, factKey) 在 accountId 为 NULL 时**不**构成
 * PostgreSQL 唯一约束（NULL 互不相等），因此：
 *   - accountId 非空 → CanonicalFact_organizationId_accountId_factKey_key 保证；
 *   - accountId 为空 → CanonicalFact_org_factkey_legacy_key（partial index）保证。
 * 这里使用 find-first + create，并在 P2002 时**重读同一条事实**再更新；并发下仍然最多
 * 落一条行 —— 数据库唯一索引才是 correctness source，应用层检查不是。
 */
async function persistCanonicalFact(
  tx: Prisma.TransactionClient,
  input: WriteCanonicalFactsInput,
  fact: DerivedFact,
): Promise<string> {
  const accountId = fact.accountId ?? null;
  const identity = {
    organizationId: input.organizationId,
    accountId,
    factKey: fact.factKey,
  };
  const update = {
    referenceType: fact.referenceType,
    externalId: fact.externalId,
    occurredAt: fact.occurredAt,
    amount: fact.amount === null ? null : new Prisma.Decimal(fact.amount),
    currency: fact.currency,
    status: fact.status,
    sourceCount: fact.sourceCount,
    confirmedAcrossModes: fact.confirmedAcrossModes,
  };

  const existing = await tx.canonicalFact.findFirst({ where: identity, select: { id: true } });
  if (existing) {
    await tx.canonicalFact.update({ where: { id: existing.id }, data: update });
    return existing.id;
  }

  try {
    const created = await tx.canonicalFact.create({
      data: {
        organizationId: input.organizationId,
        domain: input.domain,
        channel: input.channel,
        accountId,
        factKey: fact.factKey,
        firstSeenAt: input.observedAt,
        ...update,
      },
      select: { id: true },
    });
    return created.id;
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
      throw error;
    }
    const raced = await tx.canonicalFact.findFirst({ where: identity, select: { id: true } });
    if (!raced) throw error;
    await tx.canonicalFact.update({ where: { id: raced.id }, data: update });
    return raced.id;
  }
}

export async function writeCanonicalFactsForTransactions(
  tx: Prisma.TransactionClient,
  input: WriteCanonicalFactsInput,
): Promise<WriteCanonicalFactsResult> {
  if (input.transactionIds.length === 0) return { factsWritten: 0, conflicts: [] };

  const seedRows = await loadRows(tx, input);
  if (seedRows.length === 0) return { factsWritten: 0, conflicts: [] };
  const seed = seedRows.map(project);
  // TRACK B BATCH 2 / B2-1：新事实必须有唯一 canonical account（缺失 / 多账户 / 含 NULL → fail-closed）。
  const canonicalAccountId = await resolveCanonicalAccountForTransactions(tx, {
    organizationId: input.organizationId,
    transactionIds: seedRows.map((row) => row.id),
  });
  const relatedRows = await loadRelatedRows(tx, input, seed);
  // TRACK C2 M4：只保留与本次 seed 同一 account 作用域的关联行（内存判定，不写进 SQL）。
  const seedScopes = new Set(seedRows.map((row) => accountScopeOf(row)));
  const related = relatedRows.filter((row) => seedScopes.has(accountScopeOf(row))).map(project);

  const derived = deriveFactsFromTransactions(related.map(toFactSourceTransaction));
  const batchIds = new Set(input.transactionIds);
  const kindOf = new Map(seed.map((row) => [row.id, row.connectionKind]));

  let factsWritten = 0;
  const conflicts: DerivedFact[] = [];

  for (const fact of derived) {
    // 作用域由策略层派生：不再使用 fact.accountId ?? null 作为 active-write 语义。
    const persistedId = await persistCanonicalFact(tx, input, { ...fact, accountId: canonicalAccountId });
    factsWritten += 1;

    for (const transactionId of fact.transactionIds) {
      // Only rows from this batch carry this observation time; older sources keep theirs.
      if (!batchIds.has(transactionId)) continue;
      await tx.canonicalFactSource.upsert({
        where: {
          canonicalFactId_sourceTransactionId: {
            canonicalFactId: persistedId,
            sourceTransactionId: transactionId,
          },
        },
        create: {
          organizationId: input.organizationId,
          canonicalFactId: persistedId,
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
