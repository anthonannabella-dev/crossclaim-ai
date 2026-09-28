/**
 * C-0008-B2-2 — read-only case / evidence / claim-draft views.
 * ---------------------------------------------------------------
 * Rulings (MSG-20260928-53 / -59):
 *   · Claim text lives behind its own endpoint `GET /cases/:id/claim`; list
 *     endpoints must NEVER return the text.
 *   · Claim text: OWNER / ADMIN / OPS only (viewClaimText) — FINANCE and VIEWER
 *     are refused.
 *   · Response shape: { id, status, generatedAt, sections, version } — no internal
 *     prompt, no model metadata, no generation trace.
 *   · Evidence: tenant isolation + role visibility; only metadata is returned
 *     (bytes stay behind the signed-URL download path).
 */

import { Prisma, type PrismaClient } from '@prisma/client';

import { WorkflowError } from './opportunity-review';
import { assertPermission } from './permissions';

const money = (value: InstanceType<typeof Prisma.Decimal> | null): string | null =>
  value === null ? null : new Prisma.Decimal(value).toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP).toFixed(4);

export interface CaseSummary {
  id: string;
  caseNo: string;
  title: string;
  status: string;
  domain: string;
  currency: string;
  claimedAmount: string | null;
  recoveredAmount: string | null;
  createdAt: Date;
  opportunityIds: string[];
  claimRounds: number;
}

export interface CaseDetail extends CaseSummary {
  opportunities: Array<{ id: string; status: string; title: string }>;
  claims: Array<{ id: string; round: number; status: string; target: string; dueAt: Date | null }>;
}

export interface CaseEvidenceItem {
  evidenceId: string;
  role: string | null;
  kind: string;
  title: string;
  description: string | null;
  reliability: number | null;
  capturedAt: Date | null;
  addedAt: Date;
  /** 文件字节不在此返回：下载必须走既有的签名 URL 通道（租户绑定）。 */
  hasFile: boolean;
}

export interface ClaimDraftView {
  id: string;
  caseId: string;
  round: number;
  version: number;
  status: string;
  generatedAt: Date;
  isFinal: boolean;
  sections: string[];
}

/**
 * 案件/证据的可见性与金额一致：OWNER / ADMIN / OPS。
 * FINANCE 只通过 Billing 视图看财务事实（与 Billing 主体边界一致），VIEWER 无访问。
 */
function assertCaseReadable(role: string): void {
  assertPermission(role, 'viewClaimAmounts');
}

export async function listCases(
  prisma: PrismaClient,
  actor: { organizationId: string; role: string },
  limit = 50,
): Promise<CaseSummary[]> {
  assertCaseReadable(actor.role);
  const take = Math.min(Math.max(limit, 1), 200);

  const rows = await prisma.case.findMany({
    where: { organizationId: actor.organizationId },
    orderBy: { createdAt: 'desc' },
    take,
    select: {
      id: true,
      caseNo: true,
      title: true,
      status: true,
      domain: true,
      currency: true,
      claimedAmount: true,
      recoveredAmount: true,
      createdAt: true,
      opportunities: { select: { opportunityId: true } },
      claims: { select: { round: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    caseNo: row.caseNo,
    title: row.title,
    status: row.status,
    domain: row.domain,
    currency: row.currency,
    claimedAmount: money(row.claimedAmount),
    recoveredAmount: money(row.recoveredAmount),
    createdAt: row.createdAt,
    opportunityIds: row.opportunities.map((link) => link.opportunityId),
    claimRounds: row.claims.length,
  }));
}

export async function getCase(
  prisma: PrismaClient,
  actor: { organizationId: string; role: string },
  caseId: string,
): Promise<CaseDetail> {
  assertCaseReadable(actor.role);

  const row = await prisma.case.findFirst({
    where: { id: caseId, organizationId: actor.organizationId },
    select: {
      id: true,
      caseNo: true,
      title: true,
      status: true,
      domain: true,
      currency: true,
      claimedAmount: true,
      recoveredAmount: true,
      createdAt: true,
      opportunities: {
        select: { opportunityId: true, opportunity: { select: { status: true, title: true } } },
      },
      claims: { select: { id: true, round: true, status: true, target: true, dueAt: true } },
    },
  });
  if (!row) {
    throw new WorkflowError('NOT_FOUND', `案件 ${caseId} 不存在或不属于该租户`);
  }

  return {
    id: row.id,
    caseNo: row.caseNo,
    title: row.title,
    status: row.status,
    domain: row.domain,
    currency: row.currency,
    claimedAmount: money(row.claimedAmount),
    recoveredAmount: money(row.recoveredAmount),
    createdAt: row.createdAt,
    opportunityIds: row.opportunities.map((link) => link.opportunityId),
    claimRounds: row.claims.length,
    opportunities: row.opportunities.map((link) => ({
      id: link.opportunityId,
      status: link.opportunity.status,
      title: link.opportunity.title,
    })),
    // 只返回状态元数据：正文必须走 /cases/:id/claim
    claims: row.claims.map((claim) => ({
      id: claim.id,
      round: claim.round,
      status: claim.status,
      target: claim.target,
      dueAt: claim.dueAt,
    })),
  };
}

export async function listCaseEvidence(
  prisma: PrismaClient,
  actor: { organizationId: string; role: string },
  caseId: string,
): Promise<CaseEvidenceItem[]> {
  assertCaseReadable(actor.role);

  const kase = await prisma.case.findFirst({
    where: { id: caseId, organizationId: actor.organizationId },
    select: { id: true },
  });
  if (!kase) {
    throw new WorkflowError('NOT_FOUND', `案件 ${caseId} 不存在或不属于该租户`);
  }

  const rows = await prisma.caseEvidence.findMany({
    where: { organizationId: actor.organizationId, caseId: kase.id },
    orderBy: { addedAt: 'asc' },
    select: {
      role: true,
      addedAt: true,
      evidence: {
        select: {
          id: true,
          kind: true,
          title: true,
          description: true,
          reliability: true,
          capturedAt: true,
          fileAssetId: true,
        },
      },
    },
  });

  return rows.map((row) => ({
    evidenceId: row.evidence.id,
    role: row.role,
    kind: row.evidence.kind,
    title: row.evidence.title,
    description: row.evidence.description,
    reliability: row.evidence.reliability,
    capturedAt: row.evidence.capturedAt,
    addedAt: row.addedAt,
    hasFile: row.evidence.fileAssetId !== null,
  }));
}

/**
 * Claim 正文（单独端点）。允许 OWNER / ADMIN / OPS；FINANCE / VIEWER 一律 403。
 * 返回 {id, status, generatedAt, sections, version}；不返回任何 prompt / 模型信息。
 */
export async function getClaimDraft(
  prisma: PrismaClient,
  actor: { organizationId: string; role: string },
  caseId: string,
  round = 1,
): Promise<ClaimDraftView> {
  assertPermission(actor.role, 'viewClaimText');

  const kase = await prisma.case.findFirst({
    where: { id: caseId, organizationId: actor.organizationId },
    select: { id: true },
  });
  if (!kase) {
    throw new WorkflowError('NOT_FOUND', `案件 ${caseId} 不存在或不属于该租户`);
  }

  const claim = await prisma.claim.findFirst({
    where: { organizationId: actor.organizationId, caseId: kase.id, round },
    select: {
      id: true,
      round: true,
      status: true,
      createdAt: true,
      aiDraftText: true,
      finalText: true,
    },
  });
  if (!claim) {
    throw new WorkflowError('NOT_FOUND', `案件 ${caseId} 没有第 ${round} 轮 Claim`);
  }

  const isFinal = typeof claim.finalText === 'string' && claim.finalText.trim() !== '';
  const text = (isFinal ? claim.finalText : claim.aiDraftText) ?? '';
  const sections = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

  return {
    id: claim.id,
    caseId: kase.id,
    round: claim.round,
    version: claim.round,
    status: claim.status,
    generatedAt: claim.createdAt,
    isFinal,
    sections,
  };
}
