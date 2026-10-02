/**
 * TRACK A / PC-09（MSG-20261003-96 ⑬）— 版本化文档的**显式接受事实**（服务端派生身份）。
 * ---------------------------------------------------------------
 * 约束：
 *   1) 禁止隐式接受 —— 请求必须显式 `accept: true`，仅访问页面不产生事实；
 *   2) 未知 documentKey / version → fail-closed（POLICY_NOT_FOUND）；
 *   3) 只允许接受 CURRENT 版本（superseded → POLICY_VERSION_NOT_ACCEPTABLE，除非 registry 显式放行）；
 *   4) user / organization 一律来自服务端会话，客户端不得指定；
 *   5) 同一 (org, user, key, version) 幂等：重复接受返回既有事实，不产生第二条。
 * 边界：不涉及 payment / transport / provider OAuth；Payment = 0；collection = OFF。
 */

import type { PrismaClient } from '@prisma/client';

import { REQUIRED_ACCEPTANCE_KEYS, listCurrentPolicies, findPolicy, type PolicyDocument } from './policy-registry';

export type PolicyAcceptanceErrorCode =
  | 'POLICY_NOT_FOUND'
  | 'POLICY_VERSION_NOT_ACCEPTABLE'
  | 'EXPLICIT_ACCEPTANCE_REQUIRED';

export class PolicyAcceptanceError extends Error {
  constructor(readonly code: PolicyAcceptanceErrorCode) {
    super(code);
    this.name = 'PolicyAcceptanceError';
  }
}

export interface CommercialActor {
  organizationId: string;
  actorUserId: string;
  role: string;
}

export interface PolicyAcceptanceView {
  id: string;
  documentKey: string;
  documentVersion: string;
  acceptedAt: string;
  source: string;
  evidenceRef: string | null;
}

/** 服务端默认来源标识（客户端未提供 source 时使用；不采用客户端自证身份）。 */
export const DEFAULT_ACCEPTANCE_SOURCE = 'API:/commercial/policies/:key/accept';

interface PolicyAcceptanceRow {
  id: string;
  documentKey: string;
  documentVersion: string;
  acceptedAt: Date;
  source: string;
  evidenceRef: string | null;
}

function toView(row: PolicyAcceptanceRow): PolicyAcceptanceView {
  return {
    id: row.id,
    documentKey: row.documentKey,
    documentVersion: row.documentVersion,
    acceptedAt: row.acceptedAt.toISOString(),
    source: row.source,
    evidenceRef: row.evidenceRef,
  };
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function documentView(document: PolicyDocument) {
  return {
    key: document.key,
    version: document.version,
    effectiveAt: document.effectiveAt,
    status: document.status,
    title: document.title,
    summary: document.summary,
    documentRef: document.documentRef,
    requiresExplicitAcceptance: document.requiresExplicitAcceptance,
  };
}

function uniqueWhere(actor: CommercialActor, documentKey: string, documentVersion: string) {
  return {
    organizationId_userId_documentKey_documentVersion: {
      organizationId: actor.organizationId,
      userId: actor.actorUserId,
      documentKey,
      documentVersion,
    },
  } as const;
}

export interface RecordAcceptanceInput {
  documentKey: string;
  documentVersion?: unknown;
  accept?: unknown;
  source?: unknown;
  evidenceRef?: unknown;
}

export async function recordPolicyAcceptance(
  prisma: PrismaClient,
  actor: CommercialActor,
  input: RecordAcceptanceInput,
  deps: { now?: () => Date } = {},
): Promise<{ created: boolean; document: ReturnType<typeof documentView>; acceptance: PolicyAcceptanceView }> {
  if (input.accept !== true) throw new PolicyAcceptanceError('EXPLICIT_ACCEPTANCE_REQUIRED');

  const requestedVersion = asNonEmptyString(input.documentVersion);
  const document = findPolicy(input.documentKey, requestedVersion);
  if (!document) throw new PolicyAcceptanceError('POLICY_NOT_FOUND');
  if (document.status !== 'CURRENT' && document.acceptanceAllowedWhenSuperseded !== true) {
    throw new PolicyAcceptanceError('POLICY_VERSION_NOT_ACCEPTABLE');
  }

  const source = asNonEmptyString(input.source) ?? DEFAULT_ACCEPTANCE_SOURCE;
  const evidenceRef = asNonEmptyString(input.evidenceRef) ?? null;
  const at = (deps.now ?? (() => new Date()))();

  const existing = await prisma.policyAcceptance.findUnique({
    where: uniqueWhere(actor, document.key, document.version),
  });
  if (existing) return { created: false, document: documentView(document), acceptance: toView(existing) };

  try {
    const created = await prisma.policyAcceptance.create({
      data: {
        organizationId: actor.organizationId,
        userId: actor.actorUserId,
        documentKey: document.key,
        documentVersion: document.version,
        acceptedAt: at,
        source,
        evidenceRef,
      },
    });
    return { created: true, document: documentView(document), acceptance: toView(created) };
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') {
      const raced = await prisma.policyAcceptance.findUnique({
        where: uniqueWhere(actor, document.key, document.version),
      });
      if (raced) return { created: false, document: documentView(document), acceptance: toView(raced) };
    }
    throw error;
  }
}

/** 当前 actor 的接受事实（只读；跨租户不可见）。 */
export async function listMyPolicyAcceptances(
  prisma: PrismaClient,
  actor: CommercialActor,
): Promise<PolicyAcceptanceView[]> {
  const rows = await prisma.policyAcceptance.findMany({
    where: { organizationId: actor.organizationId, userId: actor.actorUserId },
    orderBy: { acceptedAt: 'desc' },
  });
  return rows.map(toView);
}

export interface AcceptanceStatus {
  key: string;
  title: string;
  currentVersion: string;
  accepted: boolean;
  acceptedVersion: string | null;
  acceptedAt: string | null;
}

/** 当前 actor 对 **CURRENT** 版本的接受状态 + 未完成清单（机器可判定）。 */
export async function getAcceptanceStatus(
  prisma: PrismaClient,
  actor: CommercialActor,
): Promise<{ complete: boolean; outstanding: string[]; items: AcceptanceStatus[] }> {
  const acceptances = await listMyPolicyAcceptances(prisma, actor);
  const byKeyVersion = new Map(acceptances.map((row) => [row.documentKey + '@' + row.documentVersion, row]));
  const items: AcceptanceStatus[] = listCurrentPolicies()
    .filter((document) => REQUIRED_ACCEPTANCE_KEYS.includes(document.key))
    .map((document) => {
      const row = byKeyVersion.get(document.key + '@' + document.version);
      return {
        key: document.key,
        title: document.title,
        currentVersion: document.version,
        accepted: Boolean(row),
        acceptedVersion: row ? row.documentVersion : null,
        acceptedAt: row ? row.acceptedAt : null,
      };
    });
  const outstanding = items.filter((item) => !item.accepted).map((item) => item.key);
  return { complete: outstanding.length === 0, outstanding, items };
}
