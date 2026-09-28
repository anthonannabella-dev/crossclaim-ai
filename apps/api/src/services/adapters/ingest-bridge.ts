/**
 * Adapter → Import foundation 的桥
 * ---------------------------------------------------------------
 * 职责边界（架构方 Checkpoint 2 明确）：
 *   适配器只做 authenticate / read → fetch external data → 映射到规范导入格式；
 *   幂等、租户归属、行级校验、批次状态机全部交给 Import foundation（runImportRows）。
 *
 *   pull（分页，有页数/条数上限） → toCanonicalRows → runImportRows → ImportResult
 *
 * 本层**不做任何业务裁决**：不判断追回机会、不算金额归属、不写 Ledger、不提交 Claim。
 *
 * 拉取中途失败的处理约定：
 *   - 一条记录都没拉到 → 直接把 AdapterError 抛给调用方（由调用方按 SourceConnection
 *     lastError 记录同步失败），不会留下空批次；
 *   - 已经拉到记录 → 已拉到的部分照常按幂等导入（重跑安全），错误放进
 *     `pullError` 与批次 errorReport，绝不让部分失败变成静默成功。
 */

import type {
  AdapterClaimSubmission,
  AdapterCredentialRef,
  AdapterRecord,
  AdapterSession,
  AdapterSubmissionResult,
  ExternalAdapter,
} from './types';
import {
  AdapterError,
  AdapterCapabilityError,
  AdapterRateLimitError,
  AdapterResponseError,
  AdapterWriteNotAllowedError,
} from './types';
import { toCanonicalRows, withSourceEvidence } from './canonical';
import { runImportRows, type ImportContext, type ImportRepository, type ImportResult } from '../ingest';

export interface AdapterImportInput {
  adapter: ExternalAdapter;
  credentials: AdapterCredentialRef;
  /** 租户、渠道、domain、connection 一律由调用方（SourceConnection）提供，适配器无权指定 */
  context: ImportContext;
  repository: ImportRepository;
  since?: string;
  until?: string;
  cursor?: string | null;
  pageSize?: number;
  fileAssetId?: string;
  /** 本次最多拉取多少页（默认 20）；到上限后 nextCursor 供下次续拉 */
  maxPages?: number;
  /** 软上限（默认 50000，与 CSV maxRows 对齐）：整页保留，绝不截断半页导致丢数据 */
  maxRecords?: number;
  now?: () => Date;
}

export interface AdapterPullFailure {
  code: string;
  message: string;
  retryAfterMs?: number;
}

export interface AdapterImportResult {
  platform: string;
  pages: number;
  recordsPulled: number;
  /** 还有下一页时给出续拉游标；已拉完或被错误中断则为 null */
  nextCursor: string | null;
  /** 拉取中途失败（已拉到部分记录并已导入）时给出，供调用方决定重试 */
  pullError?: AdapterPullFailure;
  import: ImportResult;
}

function describePullFailure(err: AdapterError): AdapterPullFailure {
  const failure: AdapterPullFailure = { code: err.code, message: err.message };
  if (err instanceof AdapterRateLimitError && err.retryAfterMs !== undefined) {
    failure.retryAfterMs = err.retryAfterMs;
  }
  return failure;
}

export async function runAdapterImport(input: AdapterImportInput): Promise<AdapterImportResult> {
  const { adapter, credentials, context, repository } = input;
  const now = input.now ?? (() => new Date());
  const maxPages = input.maxPages ?? 20;
  const maxRecords = input.maxRecords ?? 50_000;
  const caps = adapter.capabilities();

  if (!caps.domains.includes(context.domain) || !caps.channels.includes(context.channel)) {
    throw new AdapterCapabilityError(
      `适配器 ${caps.platform} 不支持 domain=${context.domain} / channel=${context.channel}`,
    );
  }

  const records: AdapterRecord[] = [];
  let pages = 0;
  let cursor: string | null = input.cursor ?? null;
  let pullError: AdapterPullFailure | undefined;

  try {
    const session: AdapterSession = await adapter.authenticate(credentials);

    for (;;) {
      if (pages >= maxPages || records.length >= maxRecords) break;

      const page = await adapter.pull(
        {
          organizationId: context.organizationId,
          connectionId: context.connectionId,
          domain: context.domain,
          channel: context.channel,
          since: input.since,
          until: input.until,
          cursor,
          pageSize: input.pageSize,
        },
        session,
      );
      pages += 1;
      records.push(...page.records);

      if (!page.hasMore) {
        cursor = null;
        break;
      }
      const nextCursor = page.nextCursor ?? null;
      if (nextCursor === null) {
        throw new AdapterResponseError(
          `适配器 ${caps.platform} 返回 hasMore=true 但没有 nextCursor`,
        );
      }
      cursor = nextCursor;
    }
  } catch (err) {
    if (!(err instanceof AdapterError)) throw err;
    // 一条都没拉到：不建空批次，直接把失败交给调用方（SourceConnection.lastError）
    if (records.length === 0) throw err;
    pullError = describePullFailure(err);
  }

  const canonical = toCanonicalRows(records);
  const provenance: Record<string, unknown> = {
    source: `adapter:${caps.platform}`,
    cursor: input.cursor ?? null,
    since: input.since ?? null,
    until: input.until ?? null,
  };
  if (pullError) provenance.pullError = pullError;

  const importResult = await runImportRows({
    context,
    header: canonical.header,
    rows: canonical.rows,
    mapping: canonical.mapping,
    repository,
    fileAssetId: input.fileAssetId,
    rawProjection: (row, index) => withSourceEvidence(row, canonical.sources[index]),
    provenance,
    now,
  });

  return {
    platform: caps.platform,
    pages,
    recordsPulled: records.length,
    nextCursor: pullError ? null : cursor,
    ...(pullError ? { pullError } : {}),
    import: importResult,
  };
}

/**
 * 通过适配器提交（Phase 1 硬闸门）。
 * 未实现 API 提交、或适配器自报 NEEDS_MANUAL 时，返回人工提交卡口；
 * 任何声称已经真实提交（SUBMITTED）的实现都会被拒绝 ——
 * 第三方写入必须先过架构方审计（ARCHITECTURE_CONTRACT §6）。
 */
export async function submitClaimThroughAdapter(
  adapter: ExternalAdapter,
  request: AdapterClaimSubmission,
  session: AdapterSession,
): Promise<AdapterSubmissionResult> {
  if (!adapter.submitClaim) {
    return {
      status: 'NEEDS_MANUAL',
      reason: `${adapter.platform} 未实现 API 提交（Phase 1 默认半自动卡口）`,
    };
  }

  const result = await adapter.submitClaim(request, session);
  if (result.status === 'SUBMITTED') {
    throw new AdapterWriteNotAllowedError(
      `适配器 ${adapter.platform} 执行了第三方写入：Phase 1 未开启，需先回架构方审计`,
    );
  }
  return result;
}
