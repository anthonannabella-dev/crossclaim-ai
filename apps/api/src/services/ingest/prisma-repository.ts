/**
 * Prisma 仓储端口实现（+ C-0006-A 双写）
 * ---------------------------------------------------------------
 * 只做"我方结构 → Prisma 调用"的翻译；去重交给
 * `createMany({ skipDuplicates: true })`（依赖 SourceTransaction 的
 * @@unique([organizationId, dedupeKey])）。
 *
 * C-0006-A：原始行与业务事实必须在**同一个事务**里落库。
 * 因此 insertTransactions 内部：
 *   transaction {
 *     写 SourceTransaction
 *     重新读取本次涉及的原始行
 *     派生并 upsert CanonicalFact / CanonicalFactSource
 *   }
 * 这样 Detection 永远不会看到"有原始行、没有事实"的半状态。
 *
 * 冲突（CONFLICT）事实在事务提交后做 best-effort 审计，审计失败不会吞掉
 * 已成功的导入结果。
 */

import { Prisma, type PrismaClient } from '@prisma/client';

import type { AuditWriter } from '../audit';
import { writeCanonicalFactsForTransactions } from '../canonical';
import type { ImportBatchDraft, ImportRepository, TransactionInsert } from './import-service';

export interface PrismaImportRepositoryOptions {
  /** 提供时，事实冲突会写审计事件（best effort）。 */
  audit?: AuditWriter;
  /** 观测时间来源；默认墙上时钟。 */
  now?: () => Date;
}

export function createPrismaImportRepository(
  prisma: PrismaClient,
  options: PrismaImportRepositoryOptions = {},
): ImportRepository {
  const now = options.now ?? (() => new Date());

  return {
    async createBatch(data: ImportBatchDraft): Promise<{ id: string }> {
      const created = await prisma.importBatch.create({
        data: {
          organizationId: data.organizationId,
          connectionId: data.connectionId,
          fileAssetId: data.fileAssetId,
          domain: data.domain,
          channel: data.channel,
          status: data.status,
          rowsTotal: data.rowsTotal,
          rowsOk: data.rowsOk,
          rowsFailed: data.rowsFailed,
          columnMapping: (data.columnMapping ?? undefined) as Prisma.InputJsonValue | undefined,
          errorReport: (data.errorReport ?? undefined) as Prisma.InputJsonValue | undefined,
          finishedAt: data.finishedAt,
          createdBy: data.createdBy,
        },
      });
      return { id: created.id };
    },

    async updateBatch(id: string, data: Partial<ImportBatchDraft>): Promise<void> {
      const patch: Prisma.ImportBatchUpdateInput = {};
      if (data.status !== undefined) patch.status = data.status;
      if (data.rowsTotal !== undefined) patch.rowsTotal = data.rowsTotal;
      if (data.rowsOk !== undefined) patch.rowsOk = data.rowsOk;
      if (data.rowsFailed !== undefined) patch.rowsFailed = data.rowsFailed;
      if (data.finishedAt !== undefined) patch.finishedAt = data.finishedAt;
      if (data.columnMapping !== undefined) {
        patch.columnMapping = (data.columnMapping ?? undefined) as Prisma.InputJsonValue | undefined;
      }
      if (data.errorReport !== undefined) {
        patch.errorReport = (data.errorReport ?? undefined) as Prisma.InputJsonValue | undefined;
      }
      await prisma.importBatch.update({ where: { id }, data: patch });
    },

    async insertTransactions(rows: TransactionInsert[]): Promise<{ inserted: number }> {
      if (rows.length === 0) return { inserted: 0 };
      const first = rows[0];
      const observedAt = now();
      const dedupeKeys = rows.map((row) => row.dedupeKey);

      const result = await prisma.$transaction(async (tx) => {
        const written = await tx.sourceTransaction.createMany({
          data: rows.map((row) => ({
            organizationId: row.organizationId,
            connectionId: row.connectionId,
            importBatchId: row.importBatchId,
            domain: row.domain,
            channel: row.channel,
            externalId: row.externalId,
            referenceType: row.referenceType,
            occurredAt: row.occurredAt,
            amount: row.amount === null ? null : new Prisma.Decimal(row.amount),
            currency: row.currency,
            dedupeKey: row.dedupeKey,
            raw: row.raw as Prisma.InputJsonValue,
          })),
          skipDuplicates: true,
        });

        // C-0006-A dual write: same transaction as the raw rows.
        const persisted = await tx.sourceTransaction.findMany({
          where: { organizationId: first.organizationId, dedupeKey: { in: dedupeKeys } },
          select: { id: true },
        });
        const facts = await writeCanonicalFactsForTransactions(tx, {
          organizationId: first.organizationId,
          domain: first.domain,
          channel: first.channel,
          transactionIds: persisted.map((row) => row.id),
          observedAt,
        });

        return { inserted: written.count, conflicts: facts.conflicts };
      });

      if (options.audit && result.conflicts.length > 0) {
        for (const conflict of result.conflicts) {
          try {
            await options.audit.record({
              organizationId: first.organizationId,
              actorType: 'SYSTEM',
              actorRef: 'canonical-fact-writer',
              action: 'canonical_fact.conflict',
              entityType: 'CanonicalFact',
              entityId: conflict.factKey,
              changes: {
                factKey: conflict.factKey,
                referenceType: conflict.referenceType,
                externalId: conflict.externalId,
                reason: conflict.conflictReason ?? null,
                sourceCount: conflict.sourceCount,
                transactionIds: conflict.transactionIds,
              },
            });
          } catch {
            // best effort: an audit outage must not mask a successful import
          }
        }
      }

      return { inserted: result.inserted };
    },
  };
}
