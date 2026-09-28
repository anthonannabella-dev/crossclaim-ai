/**
 * 导入编排：parse → normalize → validate → ImportBatch → SourceTransaction
 * ---------------------------------------------------------------
 * 关键语义（与旧项目的"批次留痕 + 行级失败 + PARTIAL"一致，但用干净实现）：
 *   - 批次先落 PENDING，结束时按结果落 IMPORTED / PARTIAL / FAILED
 *   - 行级问题不中断整批：好行照常写入，坏行进 errorReport
 *   - 幂等靠 SourceTransaction.dedupeKey（唯一键 + skipDuplicates）
 *   - raw 原样保留，禁止在导入层做任何金额结论
 */

import type { Channel, RecoveryDomain } from '@prisma/client';
import { parseCsv } from './csv';
import { autoMap, toRawRows, validateMapping } from './mapping';
import { normalizeRow } from './normalize';
import { IngestError, type ColumnMapping, type ImportContext, type ImportResult, type RowIssue } from './types';

export type ImportBatchStatus = 'PENDING' | 'PARSING' | 'IMPORTED' | 'PARTIAL' | 'FAILED';

export interface ImportBatchDraft {
  organizationId: string;
  connectionId: string | null;
  fileAssetId: string | null;
  domain: RecoveryDomain;
  channel: Channel;
  status: ImportBatchStatus;
  rowsTotal: number;
  rowsOk: number;
  rowsFailed: number;
  columnMapping: unknown;
  errorReport: unknown;
  finishedAt: Date | null;
  createdBy: string | null;
}

export interface TransactionInsert {
  organizationId: string;
  connectionId: string | null;
  importBatchId: string;
  domain: RecoveryDomain;
  channel: Channel;
  externalId: string | null;
  referenceType: string | null;
  occurredAt: Date | null;
  amount: string | null;
  currency: string;
  dedupeKey: string;
  raw: unknown;
}

export interface ImportRepository {
  createBatch(data: ImportBatchDraft): Promise<{ id: string }>;
  updateBatch(id: string, data: Partial<ImportBatchDraft>): Promise<void>;
  /** 幂等写入：已存在的 dedupeKey 必须被跳过，并返回真实插入行数 */
  insertTransactions(rows: TransactionInsert[]): Promise<{ inserted: number }>;
}

export interface RunImportInput {
  context: ImportContext;
  csvText: string;
  repository: ImportRepository;
  fileAssetId?: string;
  /** 显式列映射；缺省则按别名自动推断 */
  mapping?: ColumnMapping;
  delimiter?: ',' | ';' | '\t';
  now?: () => Date;
  /** errorReport 里最多保留多少行问题（默认 100），避免审计表被坏文件塞爆 */
  maxReportedIssues?: number;
}

function buildInsertRow(
  context: ImportContext,
  batchId: string,
  transaction: ReturnType<typeof normalizeRow>['transaction'],
): TransactionInsert {
  if (!transaction) throw new IngestError('内部错误：缺少归一化结果');
  return {
    organizationId: context.organizationId,
    connectionId: context.connectionId ?? null,
    importBatchId: batchId,
    domain: context.domain,
    channel: context.channel,
    externalId: transaction.externalId,
    referenceType: transaction.referenceType,
    occurredAt: transaction.occurredAt,
    amount: transaction.amount,
    currency: transaction.currency,
    dedupeKey: transaction.dedupeKey,
    raw: transaction.raw,
  };
}

export async function runImport(input: RunImportInput): Promise<ImportResult> {
  const now = input.now ?? (() => new Date());
  const maxReportedIssues = input.maxReportedIssues ?? 100;
  const { context, repository } = input;

  const batch = await repository.createBatch({
    organizationId: context.organizationId,
    connectionId: context.connectionId ?? null,
    fileAssetId: input.fileAssetId ?? null,
    domain: context.domain,
    channel: context.channel,
    status: 'PENDING',
    rowsTotal: 0,
    rowsOk: 0,
    rowsFailed: 0,
    columnMapping: null,
    errorReport: null,
    finishedAt: null,
    createdBy: context.createdBy ?? null,
  });

  const fail = async (stage: string, message: string): Promise<ImportResult> => {
    await repository.updateBatch(batch.id, {
      status: 'FAILED',
      rowsTotal: 0,
      rowsOk: 0,
      rowsFailed: 0,
      errorReport: { stage, message },
      finishedAt: now(),
    });
    return {
      batchId: batch.id,
      status: 'FAILED',
      rowsTotal: 0,
      rowsOk: 0,
      rowsFailed: 0,
      duplicates: 0,
      issues: [],
    };
  };

  let parsed;
  try {
    parsed = parseCsv(input.csvText, input.delimiter ? { delimiter: input.delimiter } : {});
  } catch (err) {
    return fail('parse', err instanceof Error ? err.message : 'CSV 解析失败');
  }

  let mapping: ColumnMapping;
  try {
    mapping = validateMapping(parsed.header, input.mapping ?? autoMap(parsed.header));
  } catch (err) {
    await repository.updateBatch(batch.id, { columnMapping: input.mapping ?? null });
    return fail('mapping', err instanceof Error ? err.message : '列映射校验失败');
  }
  await repository.updateBatch(batch.id, { status: 'PARSING', columnMapping: mapping });

  const rawRows = toRawRows(parsed.header, parsed.rows);
  const issues: RowIssue[] = [];
  const inserts: TransactionInsert[] = [];

  rawRows.forEach((raw, index) => {
    const rowNumber = index + 1;
    const result = normalizeRow(raw, mapping, context, rowNumber);
    if (result.transaction) inserts.push(buildInsertRow(context, batch.id, result.transaction));
    for (const issue of result.issues) {
      // 空行不算失败：直接跳过（常见于文件末尾）
      if (issue.code === 'EMPTY_ROW') return;
      issues.push(issue);
    }
  });

  const rowsTotal = rawRows.length;
  let inserted = 0;
  if (inserts.length > 0) {
    const writeResult = await repository.insertTransactions(inserts);
    inserted = writeResult.inserted;
  }
  const rowsFailed = issues.length;
  const rowsOk = inserted;
  const duplicates = inserts.length - inserted;

  const status: ImportResult['status'] =
    rowsFailed === 0 ? 'IMPORTED' : rowsOk > 0 ? 'PARTIAL' : 'FAILED';

  await repository.updateBatch(batch.id, {
    status,
    rowsTotal,
    rowsOk,
    rowsFailed,
    finishedAt: now(),
    errorReport: {
      issues: issues.slice(0, maxReportedIssues),
      issuesTruncated: Math.max(0, issues.length - maxReportedIssues),
      duplicates,
    },
  });

  return { batchId: batch.id, status, rowsTotal, rowsOk, rowsFailed, duplicates, issues };
}
