// PROVIDER FOLLOW-UP INTELLIGENCE / P2 —— Amazon Selling Partner **Support API** 只读 adapter
// ---------------------------------------------------------------------------
// 只实现官方已证明的读取能力：listCases / getCase / listContacts / attachment metadata。
// 明确禁止（本模块不导出任何对应入口）：
//   createSellerSupportCase / submitFbaReimbursementClaim / replyCase / uploadFollowUpEvidence。
// 真实 credential / transport 保持 HOLD：transport 必须由调用方注入；本模块不读 env、不发网络请求、不记录 token。

import { digestOf } from '../config-execution-durability/digests';
import {
  PROVIDER_CASE_STATUSES,
  PROVIDER_CONTACT_DIRECTIONS,
  PROVIDER_CONTACT_KINDS,
  PROVIDER_SUPPORT_BOUNDARY,
  ProviderSupportError,
  assertProviderReadScope,
  safeCredentialLabel,
  type ProviderAttachmentRef,
  type ProviderCase,
  type ProviderCasePage,
  type ProviderCaseStatus,
  type ProviderContact,
  type ProviderContactDirection,
  type ProviderContactKind,
  type ProviderReadScope,
} from './provider-case';

export const AMAZON_SUPPORT_ADAPTER_ID = 'amazon-support-read';
export const AMAZON_SUPPORT_ADAPTER_VERSION = 'amazon-support-read/v1';

/** 只读 operation 清单（与 PROVIDER_SUPPORT_BOUNDARY.allowed 一致）。 */
export const AMAZON_SUPPORT_READ_OPERATIONS = [
  'listCases',
  'getCase',
  'listContacts',
  'getAttachmentMetadata',
] as const;
export type AmazonSupportReadOperation = (typeof AMAZON_SUPPORT_READ_OPERATIONS)[number];

export interface AmazonSupportTransportRequest {
  path: string;
  params: Record<string, string>;
  scope: ProviderReadScope;
}

export interface AmazonSupportTransportResponse {
  status: number;
  body: unknown;
}

/** 只读 transport：实现方负责签名/鉴权；本模块只消费结构化结果（不接触 token）。 */
export interface AmazonSupportReadTransportPort {
  get(request: AmazonSupportTransportRequest): Promise<AmazonSupportTransportResponse>;
}

export interface AmazonSupportReadPort {
  listCases(input: ProviderReadScope & { pageSize?: number; nextToken?: string; createdAfter?: string }): Promise<ProviderCasePage<ProviderCase>>;
  getCase(input: ProviderReadScope & { caseId: string }): Promise<ProviderCase | null>;
  listContacts(input: ProviderReadScope & { caseId: string; pageSize?: number; nextToken?: string }): Promise<ProviderCasePage<ProviderContact>>;
  getAttachmentMetadata(input: ProviderReadScope & { caseId: string; attachmentId: string }): Promise<ProviderAttachmentRef | null>;
}

export interface CreateAmazonSupportAdapterDeps {
  transport: AmazonSupportReadTransportPort;
  now?: () => Date;
}

const MAX_PAGE_SIZE = 50;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeStatus(raw: unknown): ProviderCaseStatus {
  const value = (asString(raw) ?? '').toUpperCase().replace(/[\s-]/g, '_');
  if ((PROVIDER_CASE_STATUSES as readonly string[]).includes(value)) {
    return value as ProviderCaseStatus;
  }
  // Amazon 常见状态映射（只做等价归类，不猜测未知 → UNKNOWN）
  if (value === 'PENDING_MERCHANT') return 'PENDING_MERCHANT_ACTION';
  if (value === 'PENDING_AMAZON') return 'PENDING_AMAZON_ACTION';
  return 'UNKNOWN';
}

function normalizeContactKind(raw: unknown): ProviderContactKind {
  const value = (asString(raw) ?? '').toUpperCase();
  return (PROVIDER_CONTACT_KINDS as readonly string[]).includes(value)
    ? (value as ProviderContactKind)
    : 'UNKNOWN';
}

function normalizeDirection(raw: unknown): ProviderContactDirection {
  const value = (asString(raw) ?? '').toUpperCase();
  return (PROVIDER_CONTACT_DIRECTIONS as readonly string[]).includes(value)
    ? (value as ProviderContactDirection)
    : 'UNKNOWN';
}

function requireCaseId(value: unknown, operation: string): string {
  const caseId = asString(value);
  if (!caseId) {
    throw new ProviderSupportError(
      'PROVIDER_SUPPORT_MALFORMED_PAYLOAD',
      `${operation}: provider payload 缺少 caseId`,
    );
  }
  return caseId;
}

function sourceFor(scope: ProviderReadScope, fetchedAt: Date) {
  return {
    platform: 'AMAZON' as const,
    adapterId: AMAZON_SUPPORT_ADAPTER_ID,
    adapterVersion: AMAZON_SUPPORT_ADAPTER_VERSION,
    fetchedAt: fetchedAt.toISOString(),
    credentialRef: scope.credentialRef,
    ...(scope.connectionRef ? { connectionRef: scope.connectionRef } : {}),
  };
}

function mapAttachment(
  raw: unknown,
  scope: ProviderReadScope,
  providerCaseId: string,
  contactId?: string,
): ProviderAttachmentRef | null {
  const record = asRecord(raw);
  if (!record) return null;
  const attachmentId = asString(record.attachmentId) ?? asString(record.id);
  if (!attachmentId) return null;
  const filename = asString(record.filename) ?? asString(record.name);
  const contentType = asString(record.contentType) ?? asString(record.mimeType);
  const byteSize = asNumber(record.byteSize) ?? asNumber(record.size);
  const uploadedAt = asString(record.uploadedAt) ?? asString(record.createdAt);
  const digest = asString(record.digest) ?? asString(record.sha256);
  void scope;
  return {
    attachmentId,
    providerCaseId,
    ...(contactId ? { contactId } : {}),
    ...(filename ? { filename } : {}),
    ...(contentType ? { contentType } : {}),
    ...(byteSize !== undefined ? { byteSize } : {}),
    ...(uploadedAt ? { uploadedAt } : {}),
    ...(digest ? { digest } : {}),
    referenceOnly: true,
  };
}

function mapCase(raw: unknown, scope: ProviderReadScope, fetchedAt: Date): ProviderCase {
  const record = asRecord(raw);
  if (!record) {
    throw new ProviderSupportError('PROVIDER_SUPPORT_MALFORMED_PAYLOAD', 'case payload 不是对象');
  }
  const providerCaseId = requireCaseId(record.caseId, 'mapCase');
  const rawAttachments = Array.isArray(record.attachments) ? record.attachments : [];
  const attachments = rawAttachments
    .map((item) => mapAttachment(item, scope, providerCaseId))
    .filter((item): item is ProviderAttachmentRef => item !== null);
  const contactKinds = Array.isArray(record.contactKinds)
    ? record.contactKinds.map((k) => normalizeContactKind(k))
    : [];
  return {
    ref: {
      organizationId: scope.organizationId,
      platformAccountId: scope.platformAccountId,
      platform: 'AMAZON',
      providerCaseId,
    },
    status: normalizeStatus(record.status),
    ...(asString(record.subject) ? { subject: asString(record.subject) as string } : {}),
    ...(asString(record.createdAt) ? { createdAt: asString(record.createdAt) as string } : {}),
    ...(asString(record.updatedAt) ? { updatedAt: asString(record.updatedAt) as string } : {}),
    ...(asString(record.lastContactAt) ? { lastContactAt: asString(record.lastContactAt) as string } : {}),
    contactKinds,
    attachmentCount: attachments.length,
    source: sourceFor(scope, fetchedAt),
  };
}

function mapContact(
  raw: unknown,
  scope: ProviderReadScope,
  providerCaseId: string,
  fetchedAt: Date,
): ProviderContact {
  const record = asRecord(raw);
  if (!record) {
    throw new ProviderSupportError('PROVIDER_SUPPORT_MALFORMED_PAYLOAD', 'contact payload 不是对象');
  }
  const contactId = asString(record.contactId) ?? asString(record.id);
  if (!contactId) {
    throw new ProviderSupportError('PROVIDER_SUPPORT_MALFORMED_PAYLOAD', 'contact payload 缺少 contactId');
  }
  const bodyText = asString(record.body) ?? asString(record.text) ?? asString(record.message);
  const rawAttachments = Array.isArray(record.attachments) ? record.attachments : [];
  const attachments = rawAttachments
    .map((item) => mapAttachment(item, scope, providerCaseId, contactId))
    .filter((item): item is ProviderAttachmentRef => item !== null);
  return {
    contactId,
    providerCaseId,
    kind: normalizeContactKind(record.kind ?? record.type ?? record.channel),
    direction: normalizeDirection(record.direction),
    occurredAt: asString(record.occurredAt) ?? asString(record.createdAt) ?? fetchedAt.toISOString(),
    ...(bodyText ? { bodyText } : {}),
    ...(bodyText ? { bodyDigest: digestOf({ bodyText }) } : {}),
    attachments,
    source: sourceFor(scope, fetchedAt),
  };
}

function mapTransportFailure(status: number, scope: ProviderReadScope): never {
  const label = safeCredentialLabel(scope.credentialRef);
  if (status === 401) {
    throw new ProviderSupportError(
      'PROVIDER_SUPPORT_CREDENTIAL_UNAVAILABLE',
      `Amazon Support 读取未获授权（${label}，401）`,
    );
  }
  if (status === 403) {
    throw new ProviderSupportError(
      'PROVIDER_SUPPORT_CREDENTIAL_REVOKED',
      `Amazon Support 读取被拒绝（${label}，403）：凭据可能已撤销或缺少 scope`,
    );
  }
  if (status === 404) {
    throw new ProviderSupportError('PROVIDER_SUPPORT_NOT_FOUND', 'Amazon Support 目标不存在（404）');
  }
  throw new ProviderSupportError(
    'PROVIDER_SUPPORT_TRANSPORT_FAILED',
    `Amazon Support 读取失败（status=${status}，${label}）`,
  );
}

function readPageSize(pageSize: number | undefined): number | undefined {
  if (pageSize === undefined) return undefined;
  if (!Number.isInteger(pageSize) || pageSize <= 0 || pageSize > MAX_PAGE_SIZE) {
    throw new ProviderSupportError(
      'PROVIDER_SUPPORT_PAGINATION_INVALID',
      `pageSize 必须是 1..${MAX_PAGE_SIZE} 的整数`,
    );
  }
  return pageSize;
}

/**
 * 只读 adapter：返回对象**只**带读取入口（不允许调用方拿到 transport 或写能力）。
 * transport 由调用方注入；真实网络/凭据在本轮仍 HOLD，测试与本地开发使用 fixture transport。
 */
export function createAmazonSupportCaseAdapter(deps: CreateAmazonSupportAdapterDeps): AmazonSupportReadPort {
  const now = deps.now ?? (() => new Date());
  const transport = deps.transport;

  async function call(
    path: string,
    scope: ProviderReadScope,
    params: Record<string, string>,
  ): Promise<{ status: number; body: unknown }> {
    const safeScope = assertProviderReadScope(scope);
    let response: AmazonSupportTransportResponse;
    try {
      response = await transport.get({ path, params, scope: safeScope });
    } catch (error) {
      throw new ProviderSupportError(
        'PROVIDER_SUPPORT_TRANSPORT_FAILED',
        `Amazon Support transport 异常（${safeCredentialLabel(safeScope.credentialRef)}）：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (!response || typeof response.status !== 'number') {
      throw new ProviderSupportError('PROVIDER_SUPPORT_TRANSPORT_FAILED', 'Amazon Support transport 无有效响应');
    }
    if (response.status < 200 || response.status >= 300) {
      mapTransportFailure(response.status, safeScope);
    }
    return response;
  }

  return {
    async listCases(input) {
      const pageSize = readPageSize(input.pageSize);
      const params: Record<string, string> = {};
      if (pageSize !== undefined) params.pageSize = String(pageSize);
      if (input.nextToken) params.nextToken = input.nextToken;
      if (input.createdAfter) params.createdAfter = input.createdAfter;
      const response = await call('/support/cases', input, params);
      const body = asRecord(response.body);
      const rawCases = Array.isArray(body?.cases) ? (body?.cases as unknown[]) : null;
      if (!rawCases) {
        throw new ProviderSupportError(
          'PROVIDER_SUPPORT_MALFORMED_PAYLOAD',
          'listCases: payload 缺少 cases 数组',
        );
      }
      const fetchedAt = now();
      return {
        items: rawCases.map((item) => mapCase(item, input, fetchedAt)),
        ...(asString(body?.nextToken) ? { nextToken: asString(body?.nextToken) as string } : {}),
      };
    },

    async getCase(input) {
      const caseId = asString(input.caseId);
      if (!caseId) {
        throw new ProviderSupportError('PROVIDER_SUPPORT_MALFORMED_PAYLOAD', 'getCase: caseId 必填');
      }
      const response = await call(`/support/cases/${encodeURIComponent(caseId)}`, input, {});
      const body = asRecord(response.body);
      if (!body) {
        throw new ProviderSupportError('PROVIDER_SUPPORT_MALFORMED_PAYLOAD', 'getCase: payload 不是对象');
      }
      const rawCase = asRecord(body.case) ?? body;
      return mapCase(rawCase, input, now());
    },

    async listContacts(input) {
      const caseId = asString(input.caseId);
      if (!caseId) {
        throw new ProviderSupportError('PROVIDER_SUPPORT_MALFORMED_PAYLOAD', 'listContacts: caseId 必填');
      }
      const pageSize = readPageSize(input.pageSize);
      const params: Record<string, string> = {};
      if (pageSize !== undefined) params.pageSize = String(pageSize);
      if (input.nextToken) params.nextToken = input.nextToken;
      const response = await call(`/support/cases/${encodeURIComponent(caseId)}/contacts`, input, params);
      const body = asRecord(response.body);
      const rawContacts = Array.isArray(body?.contacts) ? (body?.contacts as unknown[]) : null;
      if (!rawContacts) {
        throw new ProviderSupportError(
          'PROVIDER_SUPPORT_MALFORMED_PAYLOAD',
          'listContacts: payload 缺少 contacts 数组',
        );
      }
      const fetchedAt = now();
      return {
        items: rawContacts.map((item) => mapContact(item, input, caseId, fetchedAt)),
        ...(asString(body?.nextToken) ? { nextToken: asString(body?.nextToken) as string } : {}),
      };
    },

    async getAttachmentMetadata(input) {
      const caseId = asString(input.caseId);
      const attachmentId = asString(input.attachmentId);
      if (!caseId || !attachmentId) {
        throw new ProviderSupportError(
          'PROVIDER_SUPPORT_MALFORMED_PAYLOAD',
          'getAttachmentMetadata: caseId 与 attachmentId 必填',
        );
      }
      let response: { status: number; body: unknown };
      try {
        response = await call(
          `/support/cases/${encodeURIComponent(caseId)}/attachments/${encodeURIComponent(attachmentId)}`,
          input,
          {},
        );
      } catch (error) {
        // 附件元数据查询：目标不存在时按“无该引用”处理（读取语义，不是错误）
        if (error instanceof ProviderSupportError && error.code === 'PROVIDER_SUPPORT_NOT_FOUND') {
          return null;
        }
        throw error;
      }
      const body = asRecord(response.body);
      if (!body) {
        throw new ProviderSupportError(
          'PROVIDER_SUPPORT_MALFORMED_PAYLOAD',
          'getAttachmentMetadata: payload 不是对象',
        );
      }
      const raw = asRecord(body.attachment) ?? body;
      return mapAttachment(raw, input, caseId);
    },
  };
}

/** 读取全部页（受 maxPages 约束）；返回扁平结果，便于后续 Evidence/Follow-up 使用。 */
export async function readAllAmazonSupportContacts(
  port: AmazonSupportReadPort,
  input: ProviderReadScope & { caseId: string; pageSize?: number; maxPages?: number },
): Promise<ProviderContact[]> {
  const maxPages = input.maxPages ?? 10;
  const items: ProviderContact[] = [];
  let nextToken: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const result: ProviderCasePage<ProviderContact> = await port.listContacts({
      ...input,
      ...(nextToken ? { nextToken } : {}),
    });
    items.push(...result.items);
    if (!result.nextToken) return items;
    nextToken = result.nextToken;
  }
  throw new ProviderSupportError(
    'PROVIDER_SUPPORT_PAGINATION_INVALID',
    `listContacts 超过 maxPages=${maxPages} 仍未结束`,
  );
}

/** 写能力边界断言：任何试图创建/回复/上传的调用都必须 fail-closed。 */
export function assertAmazonSupportWriteForbidden(operation: string): never {
  throw new ProviderSupportError(
    'PROVIDER_SUPPORT_WRITE_FORBIDDEN',
    `${operation} 属于禁止操作：${PROVIDER_SUPPORT_BOUNDARY.forbidden.join(' / ')}（Support 只读 adapter 不提供写入口）`,
  );
}
