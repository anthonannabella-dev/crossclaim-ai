// PROVIDER FOLLOW-UP INTELLIGENCE / P3 —— case/contact 事实归一 + canonical projection（纯决策层）
// ---------------------------------------------------------------------------
// 分层（HOST P3）：
//   ProviderCaseFact / ProviderContactFact  = 原始 provider 事实（append-only，AI 永远不得覆盖）
//   ProviderCaseProjection                  = 仅由事实派生的当前视图（可推进 generation，但不承载证据）

import { digestOf } from '../config-execution-durability/digests';
import {
  PROVIDER_CONTACT_DIRECTIONS,
  PROVIDER_CONTACT_KINDS,
  type ProviderAttachmentRef,
  type ProviderCase,
  type ProviderCaseStatus,
  type ProviderContact,
  type ProviderContactDirection,
  type ProviderContactKind,
} from './provider-case';

export const PROVIDER_CASE_FACTS_VERSION = 'provider-case-facts/v1';

export interface ProviderCaseFactRecord {
  organizationId: string;
  platformAccountId: string;
  platform: string;
  providerCaseId: string;
  factDigest: string;
  status: ProviderCaseStatus;
  subject: string | null;
  providerCreatedAt: string | null;
  providerUpdatedAt: string | null;
  lastContactAt: string | null;
  contactKinds: string;
  attachmentCount: number;
  adapterId: string;
  adapterVersion: string;
  credentialRef: string;
  connectionRef: string | null;
  fetchedAt: string;
  snapshot: string;
}

export interface ProviderContactFactRecord {
  organizationId: string;
  platformAccountId: string;
  platform: string;
  providerCaseId: string;
  contactId: string;
  factDigest: string;
  kind: ProviderContactKind;
  direction: ProviderContactDirection;
  occurredAt: string;
  bodyText: string | null;
  bodyDigest: string | null;
  attachments: string;
  attachmentCount: number;
  adapterId: string;
  adapterVersion: string;
  credentialRef: string;
  connectionRef: string | null;
  fetchedAt: string;
}

/** case 快照摘要：只对**归一化事实内容**求摘要（不含凭据/连接身份）。 */
export function providerCaseFactDigest(item: ProviderCase): string {
  return digestOf({
    version: PROVIDER_CASE_FACTS_VERSION,
    providerCaseId: item.ref.providerCaseId,
    status: item.status,
    subject: item.subject ?? null,
    createdAt: item.createdAt ?? null,
    updatedAt: item.updatedAt ?? null,
    lastContactAt: item.lastContactAt ?? null,
    contactKinds: [...item.contactKinds].sort(),
    attachmentCount: item.attachmentCount,
  });
}

export function providerContactFactDigest(item: ProviderContact): string {
  return digestOf({
    version: PROVIDER_CASE_FACTS_VERSION,
    providerCaseId: item.providerCaseId,
    contactId: item.contactId,
    kind: item.kind,
    direction: item.direction,
    occurredAt: item.occurredAt,
    bodyDigest: item.bodyDigest ?? null,
    attachments: item.attachments.map((a) => a.attachmentId).sort(),
  });
}

export function toProviderCaseFactRecord(item: ProviderCase): ProviderCaseFactRecord {
  return {
    organizationId: item.ref.organizationId,
    platformAccountId: item.ref.platformAccountId,
    platform: item.ref.platform,
    providerCaseId: item.ref.providerCaseId,
    factDigest: providerCaseFactDigest(item),
    status: item.status,
    subject: item.subject ?? null,
    providerCreatedAt: item.createdAt ?? null,
    providerUpdatedAt: item.updatedAt ?? null,
    lastContactAt: item.lastContactAt ?? null,
    contactKinds: [...item.contactKinds].sort().join(','),
    attachmentCount: item.attachmentCount,
    adapterId: item.source.adapterId,
    adapterVersion: item.source.adapterVersion,
    credentialRef: item.source.credentialRef,
    connectionRef: item.source.connectionRef ?? null,
    fetchedAt: item.source.fetchedAt,
    snapshot: JSON.stringify({
      status: item.status,
      subject: item.subject ?? null,
      createdAt: item.createdAt ?? null,
      updatedAt: item.updatedAt ?? null,
      lastContactAt: item.lastContactAt ?? null,
      contactKinds: [...item.contactKinds].sort(),
      attachmentCount: item.attachmentCount,
    }),
  };
}

export function toProviderContactFactRecord(
  item: ProviderContact,
  scope: { organizationId: string; platformAccountId: string },
): ProviderContactFactRecord {
  return {
    organizationId: scope.organizationId,
    platformAccountId: scope.platformAccountId,
    platform: item.source.platform,
    providerCaseId: item.providerCaseId,
    contactId: item.contactId,
    factDigest: providerContactFactDigest(item),
    kind: item.kind,
    direction: item.direction,
    occurredAt: item.occurredAt,
    bodyText: item.bodyText ?? null,
    bodyDigest: item.bodyDigest ?? null,
    attachments: JSON.stringify(item.attachments),
    attachmentCount: item.attachments.length,
    adapterId: item.source.adapterId,
    adapterVersion: item.source.adapterVersion,
    credentialRef: item.source.credentialRef,
    connectionRef: item.source.connectionRef ?? null,
    fetchedAt: item.source.fetchedAt,
  };
}

export type ProviderFactAppendDecision =
  | { kind: 'APPEND' }
  | { kind: 'REUSE'; reason: 'IDENTICAL_FACT_DIGEST' };

/** 幂等：同一条事实摘要重复写入 → 复用（不产生第二条事实）。 */
export function decideProviderFactAppend(
  existingDigests: readonly string[],
  incomingDigest: string,
): ProviderFactAppendDecision {
  return existingDigests.includes(incomingDigest)
    ? { kind: 'REUSE', reason: 'IDENTICAL_FACT_DIGEST' }
    : { kind: 'APPEND' };
}

export interface ProviderCaseProjectionView {
  organizationId: string;
  platformAccountId: string;
  platform: string;
  providerCaseId: string;
  status: ProviderCaseStatus;
  subject: string | null;
  lastContactAt: string | null;
  contactCount: number;
  attachmentCount: number;
  contactKinds: string;
  generation: number;
  lastFactDigest: string;
  firstFactAt: string;
  lastFactAt: string;
}

export interface ProviderCaseFactInput {
  organizationId: string;
  platformAccountId: string;
  providerCaseId: string;
  factDigest: string;
  status: ProviderCaseStatus;
  subject?: string | null;
  lastContactAt?: string | null;
  attachmentCount: number;
  contactKinds: readonly string[];
  fetchedAt: string;
}

export interface ProviderContactFactInput {
  organizationId: string;
  platformAccountId: string;
  providerCaseId: string;
  contactId: string;
  factDigest: string;
  kind: ProviderContactKind;
  direction: ProviderContactDirection;
  occurredAt: string;
  attachmentCount: number;
}

/** 投影：只由事实派生（确定性；同输入 → 同输出）。 */
export function projectProviderCase(input: {
  previous: ProviderCaseProjectionView | null;
  caseFact: ProviderCaseFactInput;
  contactFacts: readonly ProviderContactFactInput[];
  /** 预留：投影时间（当前全部取自事实，避免以“当前时间”污染派生结果） */
  now: Date;
}): ProviderCaseProjectionView {
  const { previous, caseFact, contactFacts } = input;
  const contactsForCase = contactFacts
    .filter(
      (c) =>
        c.organizationId === caseFact.organizationId &&
        c.platformAccountId === caseFact.platformAccountId &&
        c.providerCaseId === caseFact.providerCaseId,
    )
    .slice()
    .sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : a.contactId < b.contactId ? -1 : 1));

  const distinctContacts = new Set(contactsForCase.map((c) => c.contactId));
  const lastContactAt = contactsForCase.length
    ? contactsForCase[contactsForCase.length - 1].occurredAt
    : (caseFact.lastContactAt ?? null);
  const contactKinds = [...new Set(contactsForCase.map((c) => c.kind))].sort();
  const kinds = (contactKinds.length ? contactKinds : [...caseFact.contactKinds]).sort();
  const attachmentCount =
    caseFact.attachmentCount + contactsForCase.reduce((sum, c) => sum + c.attachmentCount, 0);

  return {
    organizationId: caseFact.organizationId,
    platformAccountId: caseFact.platformAccountId,
    platform: previous?.platform ?? 'AMAZON',
    providerCaseId: caseFact.providerCaseId,
    status: caseFact.status,
    subject: caseFact.subject ?? null,
    lastContactAt,
    contactCount: distinctContacts.size,
    attachmentCount,
    contactKinds: kinds.join(','),
    generation: (previous?.generation ?? 0) + 1,
    lastFactDigest: caseFact.factDigest,
    firstFactAt: previous?.firstFactAt ?? caseFact.fetchedAt,
    lastFactAt: caseFact.fetchedAt,
  };
}

export function isValidContactKind(value: string): value is ProviderContactKind {
  return (PROVIDER_CONTACT_KINDS as readonly string[]).includes(value);
}

export function isValidContactDirection(value: string): value is ProviderContactDirection {
  return (PROVIDER_CONTACT_DIRECTIONS as readonly string[]).includes(value);
}

export function attachmentsFromJson(value: string): ProviderAttachmentRef[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as ProviderAttachmentRef[]) : [];
  } catch {
    return [];
  }
}
