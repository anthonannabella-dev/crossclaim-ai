/**
 * C-0008-A — internal read-only data endpoints for the web app.
 * ---------------------------------------------------------------
 * Every request is resolved through the same three-step session check
 * (tokenHash → Session → Membership) and every query is tenant-scoped by the
 * session's organizationId. Read-only: no writes, no money calculations.
 *
 *   GET /imports                   → latest import batches
 *   GET /imports/:id/error-report  → sanitized per-row failure detail
 *   GET /opportunities             → latest recovery opportunities
 *
 * MSG-20260929-10 Q1（架构方裁定 GO，有限范围）：
 * 失败明细只允许返回 rowNumber / errorCode / errorCategory / field / action，
 * 禁止返回原始业务值、客户 PII、原始文件内容与敏感字段。因此本文件：
 *   · 绝不回传 RowIssue.message（自由文本可能夹带来源值）
 *   · 绝不回传批次 errorReport 的 provenance（平台名 / 游标 / 平台原始载荷）
 *   · 只按稳定错误码派生 category 与 action
 * 跨租户与不存在一律 404（不区分「不存在」与「无权」，避免泄漏存在性）。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import type { PrismaClient } from '@prisma/client';

import { parseCookies, readSessionToken } from './http-routes';
import { resolveSession, type SessionContext, type SessionDeps } from './session';

export interface DataRouteDeps {
  prisma: PrismaClient;
  session: SessionDeps;
  limit?: number;
}

/** 错误码 → 类别（未列出的码一律归 OTHER，不扩散自由文本） */
const ERROR_CATEGORY: Record<string, string> = {
  MISSING_REQUIRED_FIELD: 'MISSING_REQUIRED_FIELD',
  MISSING_REQUIRED_COLUMN: 'MISSING_REQUIRED_FIELD',
  INVALID_AMOUNT: 'INVALID_VALUE',
  INVALID_CURRENCY: 'INVALID_VALUE',
  INVALID_DATE: 'INVALID_VALUE',
  AMBIGUOUS_TRACKING: 'AMBIGUOUS_INPUT',
  UNKNOWN_FORMAT: 'UNSUPPORTED_FORMAT',
  PDF_STRUCTURE_ONLY_NO_OCR: 'UNSUPPORTED_FORMAT',
};

/** 错误码 → 运营可执行动作 */
const ERROR_ACTION: Record<string, string> = {
  MISSING_REQUIRED_FIELD: 'manual_confirmation_required',
  MISSING_REQUIRED_COLUMN: 'manual_confirmation_required',
  INVALID_AMOUNT: 'fix_source_row_then_reimport',
  INVALID_CURRENCY: 'fix_source_row_then_reimport',
  INVALID_DATE: 'fix_source_row_then_reimport',
  AMBIGUOUS_TRACKING: 'manual_confirmation_required',
  UNKNOWN_FORMAT: 'provide_supported_export',
  PDF_STRUCTURE_ONLY_NO_OCR: 'provide_supported_export',
};

const DEFAULT_CATEGORY = 'OTHER';
const DEFAULT_ACTION = 'manual_confirmation_required';

export interface SanitizedRowIssue {
  rowNumber: number;
  errorCode: string;
  errorCategory: string;
  field: string | null;
  action: string;
}

/**
 * 行级问题 → 允许暴露的最小投影。
 * 输入形状不可信（历史批次、连接器批次都可能不同），一律防御性读取。
 */
export function sanitizeRowIssues(errorReport: unknown): SanitizedRowIssue[] {
  if (!errorReport || typeof errorReport !== 'object') return [];
  const issues = (errorReport as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) return [];

  const out: SanitizedRowIssue[] = [];
  for (const raw of issues) {
    if (!raw || typeof raw !== 'object') continue;
    const issue = raw as { row?: unknown; field?: unknown; code?: unknown };
    const code = typeof issue.code === 'string' && issue.code !== '' ? issue.code : 'UNKNOWN';
    const row = typeof issue.row === 'number' && Number.isFinite(issue.row) ? issue.row : 0;
    out.push({
      rowNumber: row,
      errorCode: code,
      errorCategory: ERROR_CATEGORY[code] ?? DEFAULT_CATEGORY,
      field: typeof issue.field === 'string' && issue.field !== '' ? issue.field : null,
      action: ERROR_ACTION[code] ?? DEFAULT_ACTION,
    });
  }
  return out;
}

/** 批次级（阶段失败）：只给阶段名，不给 message 自由文本 */
export function sanitizeFailureStage(errorReport: unknown): string | null {
  if (!errorReport || typeof errorReport !== 'object') return null;
  const stage = (errorReport as { stage?: unknown }).stage;
  return typeof stage === 'string' && stage !== '' ? stage : null;
}

function numberOrNull(errorReport: unknown, key: string): number | null {
  if (!errorReport || typeof errorReport !== 'object') return null;
  const value = (errorReport as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function sendJson(res: ServerResponse, code: number, payload: unknown): void {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

async function requireSession(
  req: IncomingMessage,
  res: ServerResponse,
  deps: DataRouteDeps,
): Promise<SessionContext | null> {
  const token = readSessionToken(parseCookies(req.headers.cookie));
  const context = token ? await resolveSession(token, deps.session) : null;
  if (!context) {
    sendJson(res, 401, { error: 'UNAUTHENTICATED' });
    return null;
  }
  return context;
}

const IMPORT_ERROR_REPORT_PATH = /^\/imports\/([^/]+)\/error-report$/;

export async function handleDataRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: DataRouteDeps,
): Promise<boolean> {
  const path = (req.url ?? '/').split('?')[0] ?? '/';
  const method = req.method ?? 'GET';
  const limit = Math.min(Math.max(deps.limit ?? 20, 1), 100);
  const errorReportPath = IMPORT_ERROR_REPORT_PATH.exec(path);

  if (
    method !== 'GET' ||
    (path !== '/imports' && path !== '/opportunities' && errorReportPath === null)
  ) {
    return false;
  }

  const context = await requireSession(req, res, deps);
  if (!context) return true;

  // MSG-20260929-10 Q1：失败明细（只读、脱敏、租户作用域）
  if (errorReportPath) {
    const batch = await deps.prisma.importBatch.findFirst({
      where: { id: errorReportPath[1], organizationId: context.organizationId },
      select: {
        id: true,
        status: true,
        rowsTotal: true,
        rowsOk: true,
        rowsFailed: true,
        errorReport: true,
      },
    });
    if (!batch) {
      // 不存在与跨租户同一个响应，避免泄漏批次是否存在
      sendJson(res, 404, { error: 'NOT_FOUND' });
      return true;
    }
    sendJson(res, 200, {
      batchId: batch.id,
      status: batch.status,
      rowsTotal: batch.rowsTotal,
      rowsOk: batch.rowsOk,
      rowsFailed: batch.rowsFailed,
      failureStage: sanitizeFailureStage(batch.errorReport),
      issues: sanitizeRowIssues(batch.errorReport),
      issuesTruncated: numberOrNull(batch.errorReport, 'issuesTruncated'),
      duplicates: numberOrNull(batch.errorReport, 'duplicates'),
      emptyRowsSkipped: numberOrNull(batch.errorReport, 'emptyRowsSkipped'),
    });
    return true;
  }

  if (path === '/imports') {
    const rows = await deps.prisma.importBatch.findMany({
      where: { organizationId: context.organizationId },
      orderBy: { startedAt: 'desc' },
      take: limit,
      select: {
        id: true,
        status: true,
        rowsTotal: true,
        rowsOk: true,
        rowsFailed: true,
        startedAt: true,
        finishedAt: true,
        fileAssetId: true,
        connectionId: true,
      },
    });
    sendJson(res, 200, { items: rows });
    return true;
  }

  const opportunities = await deps.prisma.recoveryOpportunity.findMany({
    where: { organizationId: context.organizationId },
    orderBy: { detectedAt: 'desc' },
    take: limit,
    select: {
      id: true,
      status: true,
      opportunityType: true,
      title: true,
      amountExpected: true,
      amountActual: true,
      recoverableAmount: true,
      currency: true,
      detectedAt: true,
    },
  });
  sendJson(res, 200, {
    items: opportunities.map((row) => ({
      id: row.id,
      status: row.status,
      opportunityType: row.opportunityType,
      title: row.title,
      amountExpected: row.amountExpected === null ? null : row.amountExpected.toFixed(4),
      amountActual: row.amountActual === null ? null : row.amountActual.toFixed(4),
      recoverableAmount: row.recoverableAmount === null ? null : row.recoverableAmount.toFixed(4),
      currency: row.currency,
      detectedAt: row.detectedAt,
    })),
  });
  return true;
}
