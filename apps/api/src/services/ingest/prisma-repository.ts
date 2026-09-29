/**
 * Prisma 仓储端口实现（C-0006-A 双写 + 批量分块）
 * ---------------------------------------------------------------
 * 只做「我方结构 → Prisma 调用」的翻译；去重交给
 * createMany({ skipDuplicates: true })（依赖 SourceTransaction 的
 * @@unique([organizationId, dedupeKey])）。
 *
 * C-0006-A：原始行与业务事实必须在**同一个事务**里落库。
 * 因此 insertTransactions 内部：
 *   transaction {
 *     写 SourceTransaction
 *     重新读取本次涉及的原始行
 *     派生并 upsert CanonicalFact / CanonicalFactSource
 *   }
 * 这样 Detection 永远不会看到「有原始行、没有事实」的半状态。
 *
 * O6（1 万行基准暴露的真实缺陷）：Prisma 交互事务默认 5s 超时，
 * 1 万行导入必然突破，表现为
 *   Transaction already closed: A query cannot be executed on an expired transaction.
 * 因此写入按 chunkSize 分块，每块一个**显式 timeout** 的事务；
 * 块内仍满足 C-0006-A（行 + 事实同事务）。代价是原子性粒度变成「块」：
 * 若第 N 块失败，前 N-1 块已提交的行会保留，但批次会被导入层推进到 FAILED/PARTIAL，
 * 且这些行仍带 importBatchId、仍受 dedupeKey 幂等保护 —— 重跑同一文件不会重复计数。
 * 跨块的事实冲突判定仍然正确：后写的块在事务内能读到已提交的前序行。
 *
 * 冲突（CONFLICT）事实在事务提交后做 best-effort 审计，审计失败不会吞掉
 * 已成功的导入结果。
 */

import { Prisma, type PrismaClient } from '@prisma/client';

import type { AuditWriter } from '../audit';
import { writeCanonicalFactsForTransactions, type DerivedFact } from '../canonical';
import type { ImportBatchDraft, ImportRepository, TransactionInsert } from './import-service';

export interface PrismaImportRepositoryOptions {
  /** 提供时，事实冲突会写审计事件（best effort）。 */
  audit?: AuditWriter;
  /** 观测时间来源；默认墙上时钟。 */
  now?: () => Date;
  /**
   * 单个事务最多写入多少行（默认 1000）。
   * 调小 → 事务更短但提交次数更多；调大 → 反向。上限受交互事务超时约束。
   */
  chunkSize?: number;
  /** 每块事务的显式超时（毫秒，默认 60000）。Prisma 默认 5000，批量导入必然不够。 */
  transactionTimeoutMs?: number;
  /** 等待一个连接可用的最长时间（毫秒，默认 30000）。 */
  transactionMaxWaitMs?: number;
}

/** 分块大小：1000 行 ≈ 单块 1~3s（含事实层 upsert），远低于 60s 事务上限。 */
export const DEFAULT_IMPORT_CHUNK_SIZE = 1000;
/** Prisma 默认事务超时是 5s；批量导入必须显式放宽，否则大文件直接失败。 */
export const DEFAULT_IMPORT_TRANSACTION_TIMEOUT_MS = 60_000;
export const DEFAULT_IMPORT_TRANSACTION_MAX_WAIT_MS = 30_000;

export function createPrismaImportRepository(
  prisma: PrismaClient,
  options: PrismaImportRepositoryOptions = {},
): ImportRepository {
  const now = options.now ?? (() => new Date());
  const chunkSize = Math.max(1, options.chunkSize ?? DEFAULT_IMPORT_CHUNK_SIZE);
  const transactionTimeoutMs =
    options.transactionTimeoutMs ?? DEFAULT_IMPORT_TRANSACTION_TIMEOUT_MS;
  const transactionMaxWaitMs =
    options.transactionMaxWaitMs ?? DEFAULT_IMPORT_TRANSACTION_MAX_WAIT_MS;

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

      let inserted = 0;
      const conflicts: DerivedFact[] = [];

      for (let offset = 0; offset < rows.length; offset += chunkSize) {
        const chunk = rows.slice(offset, offset + chunkSize);
        const dedupeKeys = chunk.map((row) => row.dedupeKey);

        const result = await prisma.$transaction(
          async (tx) => {
            const written = await tx.sourceTransaction.createMany({
              data: chunk.map((row) => ({
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
          },
          { timeout: transactionTimeoutMs, maxWait: transactionMaxWaitMs },
        );

        inserted += result.inserted;
        conflicts.push(...result.conflicts);
      }

      if (options.audit && conflicts.length > 0) {
        for (const conflict of conflicts) {
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

      return { inserted };
    },
  };
}
