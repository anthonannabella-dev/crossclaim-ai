// PROVIDER FOLLOW-UP INTELLIGENCE / P2 —— 统一 provider case 读取模型（平台无关）
// ---------------------------------------------------------------------------
// 边界（HOST 2026-10-06 P2）：
//   · 只读：本模块不提供 create case / reply / upload follow-up evidence 等写能力；
//   · 所有读取必须 organization + platformAccount 双维度定位，凭据只以 credentialRef 形式出现；
//   · 不记录 token / secret；不把 provider 返回的“自称组织”当作归属依据。

export const PROVIDER_PLATFORMS = ['AMAZON', 'TIKTOK', 'WALMART', 'CUSTOMS_BROKER'] as const;
export type ProviderPlatform = (typeof PROVIDER_PLATFORMS)[number];

export const PROVIDER_CONTACT_KINDS = ['EMAIL', 'CHAT', 'PHONE', 'UNKNOWN'] as const;
export type ProviderContactKind = (typeof PROVIDER_CONTACT_KINDS)[number];

export const PROVIDER_CONTACT_DIRECTIONS = ['INBOUND', 'OUTBOUND', 'UNKNOWN'] as const;
export type ProviderContactDirection = (typeof PROVIDER_CONTACT_DIRECTIONS)[number];

export const PROVIDER_CASE_STATUSES = [
  'OPEN',
  'PENDING_MERCHANT_ACTION',
  'PENDING_AMAZON_ACTION',
  'RESOLVED',
  'CLOSED',
  'UNKNOWN',
] as const;
export type ProviderCaseStatus = (typeof PROVIDER_CASE_STATUSES)[number];

/** 读取范围：归属来自调用方（服务端会话），绝不来自 provider payload。 */
export interface ProviderReadScope {
  organizationId: string;
  platformAccountId: string;
  /** 连接/凭据引用（不是凭据本身；不得记录其解析值） */
  credentialRef: string;
  /** connection lineage（用于审计与限流维度） */
  connectionRef?: string;
}

export interface ProviderCaseRef {
  organizationId: string;
  platformAccountId: string;
  platform: ProviderPlatform;
  providerCaseId: string;
}

export interface ProviderAttachmentRef {
  attachmentId: string;
  providerCaseId: string;
  contactId?: string;
  filename?: string;
  contentType?: string;
  byteSize?: number;
  uploadedAt?: string;
  /** 内容摘要（若 provider 提供）；本模块不下载内容 */
  digest?: string;
  /** 只读引用（下载/预览必须由后续独立单元与授权决定） */
  referenceOnly: true;
}

export interface ProviderContact {
  contactId: string;
  providerCaseId: string;
  kind: ProviderContactKind;
  direction: ProviderContactDirection;
  occurredAt: string;
  /** 原始文本（provider 事实；AI 解读必须分层存放，不得覆盖） */
  bodyText?: string;
  bodyDigest?: string;
  attachments: ProviderAttachmentRef[];
  source: ProviderCaseSource;
}

export interface ProviderCaseSource {
  platform: ProviderPlatform;
  adapterId: string;
  adapterVersion: string;
  fetchedAt: string;
  credentialRef: string;
  connectionRef?: string;
}

export interface ProviderCase {
  ref: ProviderCaseRef;
  status: ProviderCaseStatus;
  subject?: string;
  createdAt?: string;
  updatedAt?: string;
  lastContactAt?: string;
  contactKinds: ProviderContactKind[];
  attachmentCount: number;
  source: ProviderCaseSource;
}

export interface ProviderCasePage<T> {
  items: T[];
  nextToken?: string;
}

export type ProviderSupportErrorCode =
  | 'PROVIDER_SUPPORT_SCOPE_REQUIRED'
  | 'PROVIDER_SUPPORT_CREDENTIAL_UNAVAILABLE'
  | 'PROVIDER_SUPPORT_CREDENTIAL_REVOKED'
  | 'PROVIDER_SUPPORT_TRANSPORT_FAILED'
  | 'PROVIDER_SUPPORT_MALFORMED_PAYLOAD'
  | 'PROVIDER_SUPPORT_NOT_FOUND'
  | 'PROVIDER_SUPPORT_WRITE_FORBIDDEN'
  | 'PROVIDER_SUPPORT_PAGINATION_INVALID';

export class ProviderSupportError extends Error {
  readonly code: ProviderSupportErrorCode;

  constructor(code: ProviderSupportErrorCode, message: string) {
    super(message);
    this.name = 'ProviderSupportError';
    this.code = code;
  }
}

/** 只读边界：任何写能力都必须来自独立单元与独立授权。 */
export const PROVIDER_SUPPORT_BOUNDARY = {
  readOnly: true,
  allowed: ['listCases', 'getCase', 'listContacts', 'getAttachmentMetadata'],
  forbidden: [
    'createSellerSupportCase',
    'submitFbaReimbursementClaim',
    'replyCase',
    'uploadFollowUpEvidence',
    'any platform write',
  ],
  requiresScope: ['organizationId', 'platformAccountId', 'credentialRef'],
  noCredentialLogging: true,
  providerAssertedOrganizationIsNotAuthoritative: true,
} as const;

export function assertProviderReadScope(scope: ProviderReadScope): ProviderReadScope {
  const missing = PROVIDER_SUPPORT_BOUNDARY.requiresScope.filter(
    (key) => (scope?.[key] ?? '').toString().trim().length === 0,
  );
  if (missing.length > 0) {
    throw new ProviderSupportError(
      'PROVIDER_SUPPORT_SCOPE_REQUIRED',
      `读取必须携带完整归属范围（缺少：${missing.join(', ')}）`,
    );
  }
  return scope;
}

/** 错误信息中永远不出现凭据值本身（避免日志泄漏）。 */
export function safeCredentialLabel(credentialRef: string): string {
  const trimmed = (credentialRef ?? '').trim();
  if (trimmed.length === 0) return '<missing>';
  return `credentialRef#${trimmed.slice(0, 4)}***`;
}
