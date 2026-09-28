import type { Prisma, RecoveryChannel } from '@prisma/client';
import prisma from '../../../config/database';
import { adaptRows } from './adapters';
import { detectFileType, parseTabular } from './parseFile';
import type { ColumnMapping, ImportFileInput, SkippedRow } from './types';

/**
 * 导入编排（唯一碰数据库的一层）。
 *
 * 契约：
 *   - 每次导入都留痕（ImportBatch），成功/部分/失败都记状态
 *   - 行级失败不阻断整批（PARTIAL），但记进 errorReport
 *   - 产出的 LossSignal 一律 status=NEW，是否升级为案件由规则引擎/人工决定
 */

export interface ImportFileResult {
  batchId: string;
  rowsTotal: number;
  imported: number;
  skipped: SkippedRow[];
  resolvedColumns: Record<string, number>;
}

export async function importChannelFile(input: ImportFileInput): Promise<ImportFileResult> {
  const fileType = detectFileType(input.fileName);

  const batch = await prisma.importBatch.create({
    data: {
      tenantId: input.tenantId,
      channel: input.channel,
      fileName: input.fileName,
      fileType,
      status: 'PARSING',
      createdBy: input.createdBy,
    },
  });

  try {
    const matrix = await parseTabular(input.fileName, input.buffer);
    const { rows, skipped, resolvedColumns } = adaptRows(
      input.channel,
      matrix,
      input.mapping as ColumnMapping | undefined,
    );

    if (rows.length > 0) {
      await prisma.lossSignal.createMany({
        data: rows.map((row) => ({
          tenantId: input.tenantId,
          channel: input.channel,
          signalType: row.signalType,
          sourceRef: row.sourceRef,
          sourceFileId: batch.id,
          detectedAt: row.occurredAt ?? new Date(),
          amountExpected: row.amountExpected,
          amountActual: row.amountActual,
          currency: row.currency,
          rawPayload: row.raw as Prisma.InputJsonValue,
        })),
      });
    }

    await prisma.importBatch.update({
      where: { id: batch.id },
      data: {
        status: rows.length === 0 ? 'FAILED' : skipped.length > 0 ? 'PARTIAL' : 'IMPORTED',
        rowsTotal: rows.length + skipped.length,
        rowsOk: rows.length,
        rowsFailed: skipped.length,
        errorReport: skipped.length > 0 ? (skipped as unknown as Prisma.InputJsonValue) : undefined,
        finishedAt: new Date(),
      },
    });

    return {
      batchId: batch.id,
      rowsTotal: rows.length + skipped.length,
      imported: rows.length,
      skipped,
      resolvedColumns,
    };
  } catch (err) {
    await prisma.importBatch
      .update({
        where: { id: batch.id },
        data: {
          status: 'FAILED',
          finishedAt: new Date(),
          errorReport: { message: err instanceof Error ? err.message : String(err) } as Prisma.InputJsonValue,
        },
      })
      .catch(() => undefined);
    throw err;
  }
}

export { adaptRows, parseAmount, parseDate } from './adapters';
export { DEFAULT_MAPPINGS, DEFAULT_SIGNAL_TYPE, mergeMapping, resolveColumns } from './columns';
export { detectFileType, parseCsv, parseXlsx, parseTabular } from './parseFile';
export type { ColumnMapping, ImportFileInput, NormalizedRow, SkippedRow } from './types';

