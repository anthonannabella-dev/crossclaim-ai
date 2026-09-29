/**
 * ADMIN — Import / Validation Operations（Admin Phase 2 / A4）
 * ---------------------------------------------------------------
 * 依据：ADMIN-IMPORT-VALIDATION-DESIGN.md（R1）+ MSG-20260929-36。
 *
 * 硬约束：
 *   · 只读：无写路径、无新表、不写 AuditLog；Admin 不是数据修复后台
 *   · 状态桶 = 固定映射 `ImportBatch.status` → bucket（**不在 Admin 内新建状态判断**）；
 *     运营工作流状态（等待人工确认/待处理/修复中）一律用**异常角标**表达
 *   · L3 行级只返回白名单字段：errorCode / rowNumber / field / sourceColumnName / action
 *     —— 不返回原始值、原始行 JSON、脱敏样本、完整文件内容（D2/D3）
 *   · Admin **一律不展示金额**（金额留在 Recovery / Billing / Finance 域，D4）
 *   · v1 不提供任何下载（D5）
 */

import type { PrismaClient } from '@prisma/client';

import { WorkflowError } from '../workflow/opportunity-review';
import {
  ADMIN_DEFAULT_PAGE_SIZE,
  ADMIN_MAX_PAGE_SIZE,
  assertAdminAccess,
  decodeAdminCursor,
  encodeAdminCursor,
} from './admin-console';

// ---------------------------------------------------------------- 状态桶（固定映射）

export const IMPORT_BUCKETS = [
  'in_progress',
  'succeeded',
  'retried_success',
  'partial',
  'failed',
] as const;
export type ImportBucket = (typeof IMPORT_BUCKETS)[number];

/** 固定映射：`ImportBatch.status` → Admin bucket（唯一映射点，Admin 不另建状态机） */
export function bucketForStatus(status: string, hasRetryEvent: boolean): ImportBucket {
  switch (status) {
    case 'PENDING':
    case 'PARSING':
      return 'in_progress';
    case 'IMPORTED':
      return hasRetryEvent ? 'retried_success' : 'succeeded';
    case 'PARTIAL':
      return 'partial';
    case 'FAILED':
      return 'failed';
    default:
      // 未知状态 fail-closed：归入 failed 并由角标标注，绝不静默当作成功
      return 'failed';
  }
}

/** 异常角标（projection flag）—— 用来替代新增工作流状态 */
export const IMPORT_FLAGS = ['QUALITY_WARNING', 'RETRIED', 'UNKNOWN_STATUS'] as const;
export type ImportFlag = (typeof IMPORT_FLAGS)[number];

export function flagsFor(input: {
  status: string;
  rowsFailed: number;
  hasRetryEvent: boolean;
}): ImportFlag[] {
  const flags: ImportFlag[] = [];
  if (input.rowsFailed > 0) flags.push('QUALITY_WARNING');
  if (input.hasRetryEvent) flags.push('RETRIED');
  if (!['PENDING', 'PARSING', 'IMPORTED', 'PARTIAL', 'FAILED'].includes(input.status)) {
    flags.push('UNKNOWN_STATUS');
  }
  return flags;
}

// ---------------------------------------------------------------- L3 白名单

export const IMPORT_ERROR_FIELD_WHITELIST = [
  'errorCode',
  'rowNumber',
  'field',
  'sourceColumnName',
  'action',
] as const;

export interface ImportErrorEntry {
  errorCode: string | null;
  rowNumber: number | null;
  field: string | null;
  sourceColumnName: string | null;
  action: string | null;
}

/**
 * 从既有 `errorReport` JSON 中**只提取白名单字段**，丢弃一切其他键
 * （含可能的原始值/原始行 JSON/客户数据）。这是 D2/D3 的实现落点。
 */
export function extractImportErrors(errorReport: unknown, limit = 100): ImportErrorEntry[] {
  if (!Array.isArray(errorReport)) return [];
  const entries: ImportErrorEntry[] = [];
  for (const raw of errorReport.slice(0, limit)) {
    if (raw === null || typeof raw !== 'object') continue;
    const record = raw as Record<string, unknown>;
    const str = (key: string): string | null => {
      const value = record[key];
      return typeof value === 'string' && value.length <= 200 ? value : null;
    };
    const rowNumberValue = record.rowNumber;
    entries.push({
      errorCode: str('errorCode'),
      rowNumber: typeof rowNumberValue === 'number' && Number.isInteger(rowNumberValue) ? rowNumberValue : null,
      field: str('field'),
      sourceColumnName: str('sourceColumnName'),
      action: str('action'),
    });
  }
  return entries;
}

/** 安全键扫描：任何响应都不得出现这些键（用于测试与自检） */
export const FORBIDDEN_RESPONSE_KEYS = [
  'rawRow',
  'rawPayload',
  'rawValue',
  'storageKey',
  'token',
  'secret',
  'credential',
  'amount',
  'currency',
  'unitPrice',
  'orderValue',
] as const;

export function containsForbiddenKey(value: unknown): string | null {
  const seen = new Set<unknown>();
  const walk = (node: unknown): string | null => {
    if (node === null || typeof node !== 'object') return null;
    if (seen.has(node)) return null;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) {
        const hit = walk(item);
        if (hit) return hit;
      }
      return null;
    }
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      if ((FORBIDDEN_RESPONSE_KEYS as readonly string[]).includes(key)) return key;
      const hit = walk(child);
      if (hit) return hit;
    }
    return null;
  };
  return walk(value);
}

// ---------------------------------------------------------------- 读侧

export interface AdminImportDeps {
  prisma: PrismaClient;
  now?: () => number | Date;
}

const RETRY_ACTIONS = ['import.retry_completed'];

export interface ImportBatchListItem {
  batchId: string;
  status: string;
  bucket: ImportBucket;
  flags: ImportFlag[];
  channel: string;
  domain: string;
  rowsTotal: number;
  rowsOk: number;
  rowsFailed: number;
  startedAt: string;
  finishedAt: string | null;
}

export interface ImportBatchDetail extends ImportBatchListItem {
  /** 时间线只取既有导入审计动作（不新增事件类型） */
  timeline: Array<{ action: string; at: string }>;
  errorCount: number;
}

function nowOf(deps: AdminImportDeps): Date {
  const value = deps.now ? deps.now() : new Date();
  return value instanceof Date ? value : new Date(value);
}

export async function listImportBatches(
  deps: AdminImportDeps,
  input: {
    organizationId: string;
    role: string | null | undefined;
    filter?: { bucket?: unknown; channel?: unknown; cursor?: unknown; limit?: unknown };
  },
): Promise<{ items: ImportBatchListItem[]; nextCursor: string | null }> {
  assertAdminAccess(input.role, 'importValidation');
  const filter = input.filter ?? {};
  const limit = normalizeLimit(filter.limit);
  const cursor = decodeAdminCursor(filter.cursor);

  const where: Record<string, unknown> = { organizationId: input.organizationId };
  if (typeof filter.channel === 'string' && filter.channel !== '') where.channel = filter.channel;
  if (cursor) {
    where.OR = [
      { startedAt: { lt: new Date(cursor.sortValue) } },
      { startedAt: new Date(cursor.sortValue), id: { lt: cursor.id } },
    ];
  }

  const rows = await deps.prisma.importBatch.findMany({
    where: where as never,
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: {
      id: true,
      status: true,
      channel: true,
      domain: true,
      rowsTotal: true,
      rowsOk: true,
      rowsFailed: true,
      startedAt: true,
      finishedAt: true,
    },
  });
  const page = rows.slice(0, limit);
  const retrySet = await retryBatchIds(deps, input.organizationId, page.map((row) => row.id));

  const items = page
    .map((row) => {
      const hasRetry = retrySet.has(row.id);
      return {
        batchId: row.id,
        status: row.status,
        bucket: bucketForStatus(row.status, hasRetry),
        flags: flagsFor({ status: row.status, rowsFailed: row.rowsFailed, hasRetryEvent: hasRetry }),
        channel: row.channel,
        domain: row.domain,
        rowsTotal: row.rowsTotal,
        rowsOk: row.rowsOk,
        rowsFailed: row.rowsFailed,
        startedAt: row.startedAt.toISOString(),
        finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
      } satisfies ImportBatchListItem;
    })
    .filter((row) => {
      const wanted = typeof filter.bucket === 'string' ? filter.bucket : '';
      return wanted === '' || row.bucket === wanted;
    });

  const last = page[page.length - 1];
  return {
    items,
    nextCursor: rows.length > limit && last ? encodeAdminCursor(last.startedAt.getTime(), last.id) : null,
  };
}

async function retryBatchIds(
  deps: AdminImportDeps,
  organizationId: string,
  batchIds: string[],
): Promise<Set<string>> {
  if (batchIds.length === 0) return new Set();
  const rows = await deps.prisma.auditLog.findMany({
    where: {
      organizationId,
      entityType: 'ImportBatch',
      action: { in: RETRY_ACTIONS },
      entityId: { in: batchIds },
    },
    select: { entityId: true },
  });
  return new Set(rows.map((row) => row.entityId ?? ''));
}

export async function getImportBatch(
  deps: AdminImportDeps,
  input: { organizationId: string; role: string | null | undefined; batchId: string },
): Promise<ImportBatchDetail> {
  assertAdminAccess(input.role, 'importValidation');
  const row = await deps.prisma.importBatch.findFirst({
    where: { id: input.batchId, organizationId: input.organizationId },
    select: {
      id: true,
      status: true,
      channel: true,
      domain: true,
      rowsTotal: true,
      rowsOk: true,
      rowsFailed: true,
      startedAt: true,
      finishedAt: true,
      errorReport: true,
    },
  });
  if (!row) throw new WorkflowError('NOT_FOUND', '导入批次不存在或不属于该租户');

  const retrySet = await retryBatchIds(deps, input.organizationId, [row.id]);
  const hasRetry = retrySet.has(row.id);
  const timeline = await deps.prisma.auditLog.findMany({
    where: { organizationId: input.organizationId, entityType: 'ImportBatch', entityId: row.id },
    orderBy: { createdAt: 'asc' },
    take: 50,
    select: { action: true, createdAt: true },
  });

  return {
    batchId: row.id,
    status: row.status,
    bucket: bucketForStatus(row.status, hasRetry),
    flags: flagsFor({ status: row.status, rowsFailed: row.rowsFailed, hasRetryEvent: hasRetry }),
    channel: row.channel,
    domain: row.domain,
    rowsTotal: row.rowsTotal,
    rowsOk: row.rowsOk,
    rowsFailed: row.rowsFailed,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    timeline: timeline.map((event) => ({ action: event.action, at: event.createdAt.toISOString() })),
    errorCount: extractImportErrors(row.errorReport).length,
  };
}

/** L3：行级定位（白名单字段，无任何原始值/样本） */
export async function listImportErrors(
  deps: AdminImportDeps,
  input: {
    organizationId: string;
    role: string | null | undefined;
    batchId: string;
    limit?: unknown;
  },
): Promise<{ batchId: string; items: ImportErrorEntry[]; truncated: boolean }> {
  assertAdminAccess(input.role, 'importValidation');
  const limit = normalizeLimit(input.limit, 100);
  const row = await deps.prisma.importBatch.findFirst({
    where: { id: input.batchId, organizationId: input.organizationId },
    select: { id: true, errorReport: true },
  });
  if (!row) throw new WorkflowError('NOT_FOUND', '导入批次不存在或不属于该租户');
  const entries = extractImportErrors(row.errorReport, limit + 1);
  return {
    batchId: row.id,
    items: entries.slice(0, limit),
    truncated: entries.length > limit,
  };
}

export interface ImportQualitySummary {
  /** 显式标注：这是投影，不是事实源（MSG-20260929-36 要求） */
  projection: true;
  generatedAt: string;
  buckets: Array<{ bucket: ImportBucket; count: number; flagCount: number }>;
}

/** 数据质量摘要：按固定桶聚合 + 角标计数（投影，不含金额） */
export async function getImportQualitySummary(
  deps: AdminImportDeps,
  input: { organizationId: string; role: string | null | undefined; limit?: unknown },
): Promise<ImportQualitySummary> {
  assertAdminAccess(input.role, 'importValidation');
  const limit = normalizeLimit(input.limit, 200);
  const rows = await deps.prisma.importBatch.findMany({
    where: { organizationId: input.organizationId },
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    take: limit,
    select: { id: true, status: true, rowsFailed: true },
  });
  const retrySet = await retryBatchIds(deps, input.organizationId, rows.map((row) => row.id));
  const counts = new Map<ImportBucket, { count: number; flagCount: number }>(
    IMPORT_BUCKETS.map((bucket) => [bucket, { count: 0, flagCount: 0 }]),
  );
  for (const row of rows) {
    const hasRetry = retrySet.has(row.id);
    const bucket = bucketForStatus(row.status, hasRetry);
    const current = counts.get(bucket) ?? { count: 0, flagCount: 0 };
    current.count += 1;
    if (flagsFor({ status: row.status, rowsFailed: row.rowsFailed, hasRetryEvent: hasRetry }).length > 0) {
      current.flagCount += 1;
    }
    counts.set(bucket, current);
  }
  return {
    projection: true,
    generatedAt: nowOf(deps).toISOString(),
    buckets: IMPORT_BUCKETS.map((bucket) => ({
      bucket,
      count: counts.get(bucket)?.count ?? 0,
      flagCount: counts.get(bucket)?.flagCount ?? 0,
    })),
  };
}

function normalizeLimit(raw: unknown, fallback = ADMIN_DEFAULT_PAGE_SIZE): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new WorkflowError('INVALID_INPUT', 'limit 必须是正整数');
  }
  return Math.min(value, ADMIN_MAX_PAGE_SIZE);
}
