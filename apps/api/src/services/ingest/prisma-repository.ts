/**
 * Prisma 版导入端口实现
 * ---------------------------------------------------------------
 * 只做"我方结构 → Prisma 入参"的翻译；幂等交给
 * `createMany({ skipDuplicates: true })`（依赖 SourceTransaction 的
 * @@unique([organizationId, dedupeKey])）。
 */

import { Prisma, type PrismaClient } from '@prisma/client';
import type { ImportBatchDraft, ImportRepository, TransactionInsert } from './import-service';

export function createPrismaImportRepository(prisma: PrismaClient): ImportRepository {
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
      const result = await prisma.sourceTransaction.createMany({
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
      return { inserted: result.count };
    },
  };
}
