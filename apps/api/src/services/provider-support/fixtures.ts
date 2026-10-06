// PROVIDER FOLLOW-UP INTELLIGENCE / P2 —— Amazon Support 只读 fixture transport（无网络、无凭据）
// 用于官方契约测试与本地开发：形状对齐 SP Support 只读响应，但**不**包含任何真实数据或 token。

import {
  ProviderSupportError,
  type ProviderReadScope,
} from './provider-case';
import type {
  AmazonSupportReadTransportPort,
  AmazonSupportTransportRequest,
  AmazonSupportTransportResponse,
} from './amazon-support-read';

export interface AmazonSupportFixtureCase {
  caseId: string;
  status: string;
  subject?: string;
  createdAt?: string;
  updatedAt?: string;
  lastContactAt?: string;
  contactKinds?: string[];
  attachments?: Array<Record<string, unknown>>;
}

export interface AmazonSupportFixtureContact {
  contactId: string;
  kind: string;
  direction: string;
  occurredAt: string;
  body?: string;
  attachments?: Array<Record<string, unknown>>;
}

export interface AmazonSupportFixtureAccount {
  platformAccountId: string;
  cases: AmazonSupportFixtureCase[];
  contacts: Record<string, AmazonSupportFixtureContact[]>;
  pageSize?: number;
}

export interface AmazonSupportFixtureOptions {
  accounts: AmazonSupportFixtureAccount[];
  /** 强制返回的 HTTP 状态（用于 stale credential / revoked connection 场景） */
  forceStatus?: number;
  /** 故意破坏 payload（malformed 场景） */
  malformed?: boolean;
  /** 每次调用记录（断言“未发生真实网络 / 未泄漏 token”） */
  calls?: AmazonSupportTransportRequest[];
}

/**
 * 只读 fixture transport：
 *   · 以 platformAccountId 分片（跨 account 不可见）；
 *   · 只在内存里返回结构化 payload，不发任何网络请求；
 *   · 从不回显 credentialRef（避免测试掩盖凭据泄漏）。
 */
export function createAmazonSupportFixtureTransport(
  options: AmazonSupportFixtureOptions,
): AmazonSupportReadTransportPort {
  return {
    async get(request: AmazonSupportTransportRequest): Promise<AmazonSupportTransportResponse> {
      options.calls?.push(request);
      const scope: ProviderReadScope = request.scope;
      if (options.forceStatus && options.forceStatus !== 200) {
        return { status: options.forceStatus, body: { error: 'fixture-forced-status' } };
      }
      const account = options.accounts.find((a) => a.platformAccountId === scope.platformAccountId);
      if (!account) {
        // 该 account 在 fixture 中不存在：对当前 scope 视为不可见（隔离语义）
        return { status: 404, body: { error: 'not-found-for-this-account' } };
      }
      if (options.malformed) {
        return { status: 200, body: { unexpected: true } };
      }

      const path = request.path;
      // 尊重调用方 pageSize（分页契约测试需要）；缺省回落到 fixture 配置
      const requestedPageSize = Number(request.params.pageSize ?? '');
      const pageSize =
        Number.isFinite(requestedPageSize) && requestedPageSize > 0
          ? requestedPageSize
          : account.pageSize ?? 10;
      const startIndex = Number(request.params.nextToken ?? '0') || 0;

      if (path === '/support/cases') {
        const slice = account.cases.slice(startIndex, startIndex + pageSize);
        const nextToken =
          startIndex + pageSize < account.cases.length ? String(startIndex + pageSize) : undefined;
        return {
          status: 200,
          body: {
            cases: slice.map((c) => ({
              caseId: c.caseId,
              status: c.status,
              ...(c.subject ? { subject: c.subject } : {}),
              ...(c.createdAt ? { createdAt: c.createdAt } : {}),
              ...(c.updatedAt ? { updatedAt: c.updatedAt } : {}),
              ...(c.lastContactAt ? { lastContactAt: c.lastContactAt } : {}),
              ...(c.contactKinds ? { contactKinds: c.contactKinds } : {}),
              ...(c.attachments ? { attachments: c.attachments } : {}),
            })),
            ...(nextToken ? { nextToken } : {}),
          },
        };
      }

      const caseMatch = /^\/support\/cases\/([^/]+)$/.exec(path);
      if (caseMatch) {
        const caseId = decodeURIComponent(caseMatch[1]);
        const found = account.cases.find((c) => c.caseId === caseId);
        if (!found) return { status: 404, body: { error: 'case-not-found' } };
        return { status: 200, body: { case: { ...found } } };
      }

      const contactsMatch = /^\/support\/cases\/([^/]+)\/contacts$/.exec(path);
      if (contactsMatch) {
        const caseId = decodeURIComponent(contactsMatch[1]);
        const contacts = account.contacts[caseId] ?? [];
        const slice = contacts.slice(startIndex, startIndex + pageSize);
        const nextToken =
          startIndex + pageSize < contacts.length ? String(startIndex + pageSize) : undefined;
        return {
          status: 200,
          body: {
            contacts: slice.map((c) => ({
              contactId: c.contactId,
              kind: c.kind,
              direction: c.direction,
              occurredAt: c.occurredAt,
              ...(c.body ? { body: c.body } : {}),
              ...(c.attachments ? { attachments: c.attachments } : {}),
            })),
            ...(nextToken ? { nextToken } : {}),
          },
        };
      }

      const attachmentMatch = /^\/support\/cases\/([^/]+)\/attachments\/([^/]+)$/.exec(path);
      if (attachmentMatch) {
        const caseId = decodeURIComponent(attachmentMatch[1]);
        const attachmentId = decodeURIComponent(attachmentMatch[2]);
        const found = account.cases.find((c) => c.caseId === caseId);
        const attachment = found?.attachments?.find(
          (a) => a.attachmentId === attachmentId || a.id === attachmentId,
        );
        if (!attachment) return { status: 404, body: { error: 'attachment-not-found' } };
        return { status: 200, body: { attachment: { ...attachment } } };
      }

      throw new ProviderSupportError(
        'PROVIDER_SUPPORT_TRANSPORT_FAILED',
        `fixture transport 不支持路径：${path}`,
      );
    },
  };
}

/** 默认 fixture：一个 AMAZON Support case 要求补 POD，另一条要求补发票（供 A-S4/A-S5 复用）。 */
export function defaultAmazonSupportFixture(): AmazonSupportFixtureOptions {
  return {
    accounts: [
      {
        platformAccountId: 'acct-A',
        pageSize: 2,
        cases: [
          {
            caseId: 'case-1001',
            status: 'PENDING_MERCHANT_ACTION',
            subject: 'FBA reimbursement — missing proof of delivery',
            createdAt: '2026-09-20T01:00:00.000Z',
            updatedAt: '2026-10-05T09:00:00.000Z',
            lastContactAt: '2026-10-05T09:00:00.000Z',
            contactKinds: ['EMAIL'],
            attachments: [
              { attachmentId: 'att-1', filename: 'case-summary.pdf', contentType: 'application/pdf', byteSize: 20480 },
            ],
          },
          {
            caseId: 'case-1002',
            status: 'PENDING_MERCHANT_ACTION',
            subject: 'Missing commercial invoice',
            createdAt: '2026-09-25T02:00:00.000Z',
            updatedAt: '2026-10-04T03:00:00.000Z',
            contactKinds: ['EMAIL', 'CHAT'],
          },
          {
            caseId: 'case-1003',
            status: 'RESOLVED',
            subject: 'Reimbursement approved',
            createdAt: '2026-09-01T00:00:00.000Z',
            updatedAt: '2026-09-30T00:00:00.000Z',
            contactKinds: ['EMAIL'],
          },
        ],
        contacts: {
          'case-1001': [
            {
              contactId: 'ct-1',
              kind: 'EMAIL',
              direction: 'INBOUND',
              occurredAt: '2026-10-05T09:00:00.000Z',
              body: 'Please provide proof of delivery for the shipment.',
            },
          ],
          'case-1002': [
            {
              contactId: 'ct-2',
              kind: 'EMAIL',
              direction: 'INBOUND',
              occurredAt: '2026-10-04T03:00:00.000Z',
              body: 'Please upload the commercial invoice for this order.',
            },
            {
              contactId: 'ct-3',
              kind: 'CHAT',
              direction: 'OUTBOUND',
              occurredAt: '2026-10-04T05:00:00.000Z',
              body: 'We will provide the invoice shortly.',
            },
          ],
        },
      },
      {
        platformAccountId: 'acct-B',
        cases: [
          {
            caseId: 'case-2001',
            status: 'PENDING_AMAZON_ACTION',
            subject: 'Other account case',
            createdAt: '2026-09-28T00:00:00.000Z',
            contactKinds: ['EMAIL'],
          },
        ],
        contacts: {},
      },
    ],
  };
}
