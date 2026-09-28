/**
 * 导入编排：parse → normalize → validate → ImportBatch → SourceTransaction
 * ---------------------------------------------------------------
 * 两个入口共用同一套核心（`importNormalizedRows`），因此幂等、租户与批次状态机
 * 在「文件上传」与「外部适配器」两条链路上完全一致：
 *   - runImport()      CSV / 文件上传：文本 → 行
 *   - runImportRows()  结构化行（Adapter 归一化结果等）：行 → SourceTransaction
 *
 * 关键语义（架构方已确认，两条路径一致）：
 *   - 批次先落 PENDING，再按阶段推进到 IMPORTED / PARTIAL / FAILED
 *   - 行级问题不中断整批：坏行跳过、好行照写，批次状态 PARTIAL
 *   - 幂等靠 SourceTransaction.dedupeKey（唯一键）+ skipDuplicates
 *   - raw 保留来源行；适配器路径可额外挂平台原始载荷（不参与幂等指纹）
 *   - 本层不做任何业务裁决：不判断追回机会、不算金额归属、不碰 Rule/Ledger
 */

import type { Channel, RecoveryDomain } from '@prisma/client';
import { parseCsv } from './csv';
import { autoMap, toRawRows, validateMapping } from './mapping';
import { normalizeRow } from './normalize';
import {
  IngestError,
  type ColumnMapping,
  type ImportContext,
  type ImportResult,
  type NormalizedTransaction,
  type RawRow,
  type RowIssue,
} from './types';

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
  /** 幂等写入：已存在的 dedupeKey 会被跳过，返回实际新增条数 */
  insertTransactions(rows: TransactionInsert[]): Promise<{ inserted: number }>;
}

export interface RunImportInput {
  context: ImportContext;
  csvText: string;
  repository: ImportRepository;
  fileAssetId?: string;
  /** 显式映射；缺省则按表头自动推断 */
  mapping?: ColumnMapping;
  delimiter?: ',' | ';' | '\t';
  now?: () => Date;
  /** errorReport 最多保留多少条行问题（默认 100），避免坏文件把批次记录撑爆 */
  maxReportedIssues?: number;
}

/**
 * 已有结构化行的导入入口（Adapter 归一化结果等）。
 * 与 CSV 路径**共用**同一套批次状态机、行级校验与幂等键计算。
 */
export interface ImportRowsInput {
  context: ImportContext;
  /** 源列名；mapping 只允许指向这里真实存在的列 */
  header: string[];
  rows: RawRow[];
  mapping: ColumnMapping;
  repository: ImportRepository;
  fileAssetId?: string;
  now?: () => Date;
  maxReportedIssues?: number;
  /**
   * 落库 raw 的投影（默认就是行本身）。
   * 幂等指纹始终基于**规范化后的行**计算，不受投影影响 ——
   * 适配器据此把平台原始载荷作为证据挂上去，而不会因此产生第二笔交易。
   */
  rawProjection?: (row: RawRow, index: number) => unknown;
  /** 额外写进批次 errorReport 的来源信息（平台名、游标、时间窗等） */
  provenance?: Record<string, unknown>;
}

interface ImportCoreInput {
  context: ImportContext;
  repository: ImportRepository;
  fileAssetId?: string;
  now?: () => Date;
  maxReportedIssues?: number;
  rawProjection?: (row: RawRow, index: number) => unknown;
  provenance?: Record<string, unknown>;
}

function pendingBatchDraft(context: ImportContext, fileAssetId: string | null): ImportBatchDraft {
  return {
    organizationId: context.organizationId,
    connectionId: context.connectionId ?? null,
    fileAssetId,
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
  };
}

async function failBatch(
  repository: ImportRepository,
  batchId: string,
  stage: string,
  message: string,
  now: () => Date,
): Promise<ImportResult> {
  await repository.updateBatch(batchId, {
    status: 'FAILED',
    rowsTotal: 0,
    rowsOk: 0,
    rowsFailed: 0,
    errorReport: { stage, message },
    finishedAt: now(),
  });
  return {
    batchId,
    status: 'FAILED',
    rowsTotal: 0,
    rowsOk: 0,
    rowsFailed: 0,
    duplicates: 0,
    issues: [],
  };
}

function buildInsertRow(
  context: ImportContext,
  batchId: string,
  transaction: NormalizedTransaction | undefined,
  raw: unknown,
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
    raw,
  };
}

/** 把已经变成「行」的数据写进批次：映射校验 → 行级校验 → 幂等写入 → 批次收口 */
async function importNormalizedRows(
  input: ImportCoreInput & {
    batchId: string;
    header: string[];
    rows: RawRow[];
    mapping: ColumnMapping;
  },
): Promise<ImportResult> {
  const { context, repository, rows } = input;
  const now = input.now ?? (() => new Date());
  const maxReportedIssues = input.maxReportedIssues ?? 100;
  const rawProjection = input.rawProjection ?? ((row: RawRow) => row as unknown);

  let mapping: ColumnMapping;
  try {
    mapping = validateMapping(input.header, input.mapping);
  } catch (err) {
    await repository.updateBatch(input.batchId, { columnMapping: input.mapping });
    return failBatch(
      repository,
      input.batchId,
      'mapping',
      err instanceof Error ? err.message : '列映射校验失败',
      now,
    );
  }
  await repository.updateBatch(input.batchId, { status: 'PARSING', columnMapping: mapping });

  // CHANGE #29：PARSING 之后的任何预期外失败都必须尽最大努力进入 FAILED 终态，
  // 不允许把批次永久留在 PARSING（否则库里会留下"看起来还在跑"的死批次）。
  let stage: 'normalize' | 'persist' | 'finalize' = 'normalize';
  try {
    const issues: RowIssue[] = [];
    const inserts: TransactionInsert[] = [];

    rows.forEach((raw, index) => {
      const rowNumber = index + 1;
      const result = normalizeRow(raw, mapping, context, rowNumber);
      if (result.transaction) {
        inserts.push(
          buildInsertRow(context, input.batchId, result.transaction, rawProjection(raw, index)),
        );
      }
      for (const issue of result.issues) {
        // 空行不算失败：直接跳过，不污染 errorReport
        if (issue.code === 'EMPTY_ROW') return;
        issues.push(issue);
      }
    });

    stage = 'persist';
    const rowsTotal = rows.length;
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

    stage = 'finalize';
    await repository.updateBatch(input.batchId, {
      status,
      rowsTotal,
      rowsOk,
      rowsFailed,
      finishedAt: now(),
      errorReport: {
        ...(input.provenance ?? {}),
        issues: issues.slice(0, maxReportedIssues),
        issuesTruncated: Math.max(0, issues.length - maxReportedIssues),
        duplicates,
      },
    });

    return { batchId: input.batchId, status, rowsTotal, rowsOk, rowsFailed, duplicates, issues };
  } catch (err) {
    await bestEffortMarkFailed(repository, input.batchId, stage, err, now);
    throw err;
  }
}

/** 尽力把批次推进到 FAILED 终态；连终态都写不进（数据库不可用）时不掩盖原始异常 */
async function bestEffortMarkFailed(
  repository: ImportRepository,
  batchId: string,
  stage: 'normalize' | 'persist' | 'finalize',
  err: unknown,
  now: () => Date,
): Promise<void> {
  const message = err instanceof Error ? err.message : '未知错误';
  try {
    await repository.updateBatch(batchId, {
      status: 'FAILED',
      finishedAt: now(),
      errorReport: { stage, message: message.slice(0, 500), terminalized: 'best-effort' },
    });
  } catch {
    // 数据库不可用时无解；原始异常仍然向上抛出
  }
}

export async function runImport(input: RunImportInput): Promise<ImportResult> {
  const now = input.now ?? (() => new Date());
  const batch = await input.repository.createBatch(
    pendingBatchDraft(input.context, input.fileAssetId ?? null),
  );

  let parsed;
  try {
    parsed = parseCsv(input.csvText, input.delimiter ? { delimiter: input.delimiter } : {});
  } catch (err) {
    return failBatch(
      input.repository,
      batch.id,
      'parse',
      err instanceof Error ? err.message : 'CSV 解析失败',
      now,
    );
  }

  return importNormalizedRows({
    ...input,
    batchId: batch.id,
    header: parsed.header,
    rows: toRawRows(parsed.header, parsed.rows),
    mapping: input.mapping ?? autoMap(parsed.header),
    now,
  });
}

export async function runImportRows(input: ImportRowsInput): Promise<ImportResult> {
  const now = input.now ?? (() => new Date());
  const batch = await input.repository.createBatch(
    pendingBatchDraft(input.context, input.fileAssetId ?? null),
  );
  return importNormalizedRows({ ...input, batchId: batch.id, now });
}
