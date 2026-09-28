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
} from './types';
import { toCanonicalRows, withSourceEvidence } from './canonical';
import { assertSafeSource } from './source-guard';
import { assertAdapterCapabilities } from './registry';
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

function assertPositiveInt(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new AdapterCapabilityError(`${name} 必须是正整数（收到 ${String(value)}）`);
  }
}

export async function runAdapterImport(input: AdapterImportInput): Promise<AdapterImportResult> {
  const { adapter, credentials, context, repository } = input;
  const now = input.now ?? (() => new Date());
  const maxPages = input.maxPages ?? 20;
  const maxRecords = input.maxRecords ?? 50_000;
  // CHANGE #35：公共执行函数本身必须安全 —— 直接调用也要过完整能力体检（不能只依赖 Registry）
  const caps = assertAdapterCapabilities(adapter);

  if (!caps.domains.includes(context.domain) || !caps.channels.includes(context.channel)) {
    throw new AdapterCapabilityError(
      `适配器 ${caps.platform} 不支持 domain=${context.domain} / channel=${context.channel}`,
    );
  }
  // CHANGE #32：分页容量必须真正执行，而不是只信适配器自报
  assertPositiveInt('maxPages', maxPages);
  assertPositiveInt('maxRecords', maxRecords);
  if (input.pageSize !== undefined) {
    assertPositiveInt('pageSize', input.pageSize);
    if (input.pageSize > caps.maxPageSize) {
      throw new AdapterCapabilityError(
        `pageSize=${input.pageSize} 超过适配器 ${caps.platform} 自报上限 ${caps.maxPageSize}`,
      );
    }
  }
  const effectivePageSize = Math.min(input.pageSize ?? caps.maxPageSize, caps.maxPageSize);

  const records: AdapterRecord[] = [];
  let pages = 0;
  let cursor: string | null = input.cursor ?? null;
  let pullError: AdapterPullFailure | undefined;

  try {
    const session: AdapterSession = await adapter.authenticate(credentials);
    if (session.platform !== caps.platform) {
      throw new AdapterResponseError(
        `session.platform=${session.platform} 与适配器 ${caps.platform} 不一致；拒绝继续拉取`,
      );
    }

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
      if (!Array.isArray(page.records)) {
        throw new AdapterResponseError(`适配器 ${caps.platform} 返回的 records 不是数组`);
      }
      // 超页必须先拒绝，不能先 push 进内存（否则声明 maxPageSize 形同虚设）
      if (page.records.length > effectivePageSize) {
        throw new AdapterResponseError(
          `适配器 ${caps.platform} 单页返回 ${page.records.length} 条，超过声明上限 ${effectivePageSize}；拒绝累积`,
        );
      }
      // CHANGE #33：每页到达即校验 source 边界，通过以后才累计进内存
      page.records.forEach((record, index) => {
        assertSafeSource(record.source, {
          platform: caps.platform,
          rowNumber: records.length + index + 1,
        });
      });
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
 * 提交闸门（Phase 1 硬闸门 / CHANGE #28）。
 *
 * **永不调用任何第三方写入方法**：Phase 1 期间 `adapter.submitClaim` 一律不执行，
 * 直接返回 NEEDS_MANUAL 人工卡口。这里曾经是"写完才报警"（先调用、再对 SUBMITTED 抛错），
 * 那样真实世界的提交动作已经不可撤销，属于安全缺陷。
 *
 * 未来开放第三方写入时，必须新增 ExternalWriteAdapter 并先经架构方审计。
 */
export function submitClaimThroughAdapter(
  adapter: ExternalAdapter,
  _request: AdapterClaimSubmission,
): Promise<AdapterSubmissionResult> {
  return Promise.resolve({
    status: 'NEEDS_MANUAL',
    reason:
      `${adapter.platform}：Phase 1 为只读通道，第三方提交（Claim / Appeal）一律走人工卡口；` +
      '自动化写入必须先经架构方审计并通过 ExternalWriteAdapter 单独设计',
  });
}
