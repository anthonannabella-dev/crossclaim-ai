/**
 * TRACK A / PC-03 — CUSTOMER CLAIM PACKAGE VIEW（tenant/account-safe read projection）.
 * ---------------------------------------------------------------
 * 授权：MSG-20261002-83 ⑤（PC-03 CUSTOMER CLAIM PACKAGE VIEW）。
 *
 * 冻結規則：
 *   1. 只读投影：聚合既有 RecoveryPackage / RecoveryPackageArtifact / ClaimItem /
 *      RecoveryManualSubmission / CaseOpportunity / Case — **不**生成 package、不新增第二套 claim state machine。
 *   2. tenant-scoped：一切查询都带 organizationId = actor.organizationId；跨租户 → 404。
 *   3. account lineage：opportunity account 与 claim item account 必须一致（多值 → fail-closed）；
 *      accountId = NULL 一律标记 LEGACY_UNATTRIBUTED，**不得**按 connection 推断。
 *   4. 安全字段：不返回 storageKey / credentialRef / secret / token / internal audit payload /
 *      internal rule raw JSON / prompt / chain-of-thought。
 *   5. submission boundary 必须显式：PACKAGE READY ≠ CLAIM ACTUALLY SUBMITTED；
 *      真实 provider write 恒为 HOLD_NEEDS_MANUAL（TRANSPORT=false）。
 *
 * 边界：NO platform write · Payment = 0 · TRANSPORT=false · 无生产凭据。
 */

import { Prisma, type PrismaClient } from '@prisma/client';

import { WorkflowError } from './opportunity-review';
import { assertPermission } from './permissions';

export const CLAIM_PACKAGE_ACCOUNT_MISMATCH = 'CLAIM_PACKAGE_ACCOUNT_MISMATCH';
export const PROVIDER_WRITE_STATE = 'HOLD_NEEDS_MANUAL';

export type ClaimPackageReadiness =
  | 'READY_TO_SUBMIT'
  | 'NEEDS_EVIDENCE'
  | 'NEEDS_REVIEW'
  | 'SUBMITTED'
  | 'ACKNOWLEDGED'
  | 'APPROVED'
  | 'REJECTED'
  | 'APPEAL_REQUIRED';

export const READINESS_LABEL: Record<ClaimPackageReadiness, string> = {
  READY_TO_SUBMIT: '可提交（材料已就绪）',
  NEEDS_EVIDENCE: '还需补充材料',
  NEEDS_REVIEW: '需要人工复核',
  SUBMITTED: '已人工提交',
  ACKNOWLEDGED: '平台已受理',
  APPROVED: '已获批',
  REJECTED: '被拒绝',
  APPEAL_REQUIRED: '需要申诉',
};

export interface ClaimPackageActor {
  organizationId: string;
  actorUserId: string;
  role: string;
}

export interface ClaimPackageView {
  case: {
    id: string;
    caseNo: string;
    title: string;
    status: string;
    domain: string;
    currency: string;
    claimedAmount: string | null;
    recoverableAmount: string | null;
    deadline: string | null;
    openedAt: string;
  };
  account: {
    state: 'ATTRIBUTED' | 'LEGACY_UNATTRIBUTED';
    id: string | null;
    platform: string | null;
    externalAccountId: string | null;
    displayName: string | null;
  };
  package: {
    id: string;
    packageVersion: string;
    status: string;
    packageDigest: string;
    generatedAt: string;
    claimItemId: string;
    target: { platformType: string; claimType: string; channel: string; domain: string };
  } | null;
  why: {
    opportunities: Array<{
      id: string;
      title: string;
      opportunityType: string;
      status: string;
      recoverableAmount: string | null;
      currency: string;
      claimDeadline: string | null;
    }>;
    basisSummary: string;
    amountBasis: string | null;
    evidenceCount: number;
    linkedEvidenceCount: number;
  };
  evidence: Array<{
    id: string;
    kind: string;
    title: string;
    sourceType: string;
    capturedAt: string;
    downloadable: true;
    sha256: string;
  }>;
  missingItems: string[];
  readiness: {
    state: ClaimPackageReadiness;
    label: string;
    packageReady: boolean;
    claimSubmitted: boolean;
    providerWrite: typeof PROVIDER_WRITE_STATE;
  };
  actions: {
    canPrepare: boolean;
    canDownloadPackage: boolean;
    canRecordManualSubmission: boolean;
    canAppeal: boolean;
  };
}

const money = (value: InstanceType<typeof Prisma.Decimal> | null): string | null =>
  value === null
    ? null
    : new Prisma.Decimal(value).toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP).toFixed(4);

function missingFromSnapshot(snapshot: Prisma.JsonValue | null): string[] {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return [];
  const value = (snapshot as Record<string, unknown>).missing;
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
}

function deriveReadiness(input: {
  claimItemStatuses: string[];
  claimItemClosedReasons: Array<string | null>;
  hasSubmission: boolean;
  hasActivePackage: boolean;
  missingItems: string[];
}): ClaimPackageReadiness {
  const { claimItemStatuses, claimItemClosedReasons, hasSubmission, hasActivePackage, missingItems } = input;

  if (claimItemStatuses.includes('READY_TO_APPEAL') || claimItemClosedReasons.includes('REJECTED')) {
    return 'APPEAL_REQUIRED';
  }
  if (claimItemStatuses.includes('RECOVERED')) return 'APPROVED';
  if (hasSubmission || claimItemStatuses.includes('SUBMITTED_MANUAL')) return 'SUBMITTED';
  if (!hasActivePackage) return 'NEEDS_REVIEW';
  if (missingItems.length > 0) return 'NEEDS_EVIDENCE';
  return 'READY_TO_SUBMIT';
}

export async function getCaseClaimPackage(
  prisma: PrismaClient,
  actor: ClaimPackageActor,
  caseId: string,
): Promise<ClaimPackageView> {
  // 证据/材料包读取沿用既有 claim evidence 权限边界（FINANCE / VIEWER 不可见）。
  assertPermission(actor.role, 'viewClaimEvidence');

  const kase = await prisma.case.findFirst({
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
      dueAt: true,
      openedAt: true,
      opportunities: {
        select: {
          opportunity: {
            select: {
              id: true,
              title: true,
              opportunityType: true,
              status: true,
              recoverableAmount: true,
              currency: true,
              claimDeadline: true,
              accountId: true,
              channel: true,
              domain: true,
              platformAccount: {
                select: { id: true, platform: true, externalAccountId: true, displayName: true },
              },
            },
          },
        },
      },
      claimItems: {
        select: {
          id: true,
          status: true,
          closedReason: true,
          accountId: true,
          claimType: true,
          platformType: true,
          recoverableAmount: true,
          currency: true,
        },
      },
    },
  });
  if (!kase) throw new WorkflowError('NOT_FOUND', '案件不存在或不属于该租户');

  const opportunities = kase.opportunities.map((link) => link.opportunity);
  const claimItems = kase.claimItems;

  // 3：account lineage 一致性（opportunity account 与 claim item account 必须唯一一致）。
  const accountCandidates = [
    ...opportunities.map((item) => item.accountId),
    ...claimItems.map((item) => item.accountId),
  ].filter((value): value is string => typeof value === 'string' && value !== '');
  const distinctAccounts = [...new Set(accountCandidates)];
  if (distinctAccounts.length > 1) {
    throw new WorkflowError(
      CLAIM_PACKAGE_ACCOUNT_MISMATCH,
      '材料包 account context 不一致（opportunity 与 claim item 指向不同 PlatformAccount）',
    );
  }
  const accountId = distinctAccounts[0] ?? null;
  const accountRow = accountId
    ? await prisma.platformAccount.findFirst({
        where: { id: accountId, organizationId: actor.organizationId },
        select: { id: true, platform: true, externalAccountId: true, displayName: true },
      })
    : null;

  const claimItemIds = claimItems.map((item) => item.id);
  const packages = claimItemIds.length
    ? await prisma.recoveryPackage.findMany({
        where: { organizationId: actor.organizationId, caseId: kase.id, claimItemId: { in: claimItemIds } },
        orderBy: [{ generatedAt: 'desc' }, { id: 'desc' }],
        select: {
          id: true,
          claimItemId: true,
          packageVersion: true,
          status: true,
          packageDigest: true,
          generatedAt: true,
          completenessSnapshot: true,
          artifacts: {
            orderBy: [{ exportedAt: 'desc' }, { id: 'desc' }],
            select: {
              id: true,
              artifactKind: true,
              sha256: true,
              exportedAt: true,
              fileAsset: { select: { originalName: true, kind: true, mimeType: true, sizeBytes: true } },
            },
          },
        },
      })
    : [];

  const activePackage =
    packages.find((row) => row.status === 'GENERATED' || row.status === 'EXPORTED') ?? null;

  const submissions = claimItemIds.length
    ? await prisma.recoveryManualSubmission.findMany({
        where: { organizationId: actor.organizationId, caseId: kase.id, claimItemId: { in: claimItemIds } },
        orderBy: { submittedAt: 'desc' },
        select: { id: true, claimItemId: true, packageId: true, submittedAt: true, packageDigest: true },
      })
    : [];
  const hasSubmission = submissions.length > 0;

  const linkedEvidenceCount = await prisma.caseEvidence.count({
    where: { organizationId: actor.organizationId, caseId: kase.id },
  });

  const missingItems = new Set<string>();
  if (claimItems.length === 0) missingItems.add('NO_CLAIM_ITEM');
  if (!activePackage) missingItems.add('PACKAGE_NOT_GENERATED');
  for (const item of missingFromSnapshot(activePackage?.completenessSnapshot ?? null)) {
    missingItems.add(item);
  }
  if (activePackage && activePackage.artifacts.length === 0) missingItems.add('PACKAGE_NOT_EXPORTED');
  if (accountId === null) missingItems.add('ACCOUNT_NOT_ATTRIBUTED');

  const evidence = (activePackage?.artifacts ?? []).map((artifact) => ({
    id: artifact.id,
    kind: artifact.artifactKind,
    title: artifact.fileAsset.originalName,
    sourceType: artifact.fileAsset.kind,
    capturedAt: artifact.exportedAt.toISOString(),
    downloadable: true as const,
    sha256: artifact.sha256,
  }));

  const state = deriveReadiness({
    claimItemStatuses: claimItems.map((item) => item.status),
    claimItemClosedReasons: claimItems.map((item) => item.closedReason),
    hasSubmission,
    hasActivePackage: activePackage !== null,
    missingItems: [...missingItems],
  });

  const firstOpportunity = opportunities[0] ?? null;
  const recoverable = claimItems.reduce<InstanceType<typeof Prisma.Decimal> | null>((acc, item) => {
    if (item.recoverableAmount === null) return acc;
    return acc === null ? item.recoverableAmount : acc.plus(item.recoverableAmount);
  }, null);

  return {
    case: {
      id: kase.id,
      caseNo: kase.caseNo,
      title: kase.title,
      status: kase.status,
      domain: kase.domain,
      currency: kase.currency,
      claimedAmount: money(kase.claimedAmount),
      recoverableAmount: money(recoverable),
      deadline: kase.dueAt ? kase.dueAt.toISOString() : firstOpportunity?.claimDeadline?.toISOString() ?? null,
      openedAt: kase.openedAt.toISOString(),
    },
    account: accountRow
      ? {
          state: 'ATTRIBUTED',
          id: accountRow.id,
          platform: accountRow.platform,
          externalAccountId: accountRow.externalAccountId,
          displayName: accountRow.displayName,
        }
      : {
          state: 'LEGACY_UNATTRIBUTED',
          id: null,
          platform: null,
          externalAccountId: null,
          displayName: null,
        },
    package: activePackage
      ? {
          id: activePackage.id,
          packageVersion: activePackage.packageVersion,
          status: activePackage.status,
          packageDigest: activePackage.packageDigest,
          generatedAt: activePackage.generatedAt.toISOString(),
          claimItemId: activePackage.claimItemId,
          target: (() => {
            const item = claimItems.find((candidate) => candidate.id === activePackage.claimItemId);
            return {
              platformType: item?.platformType ?? firstOpportunity?.channel ?? 'UNKNOWN',
              claimType: item?.claimType ?? firstOpportunity?.opportunityType ?? 'UNKNOWN',
              channel: firstOpportunity?.channel ?? 'OTHER',
              domain: firstOpportunity?.domain ?? kase.domain,
            };
          })(),
        }
      : null,
    why: {
      opportunities: opportunities.map((item) => ({
        id: item.id,
        title: item.title,
        opportunityType: item.opportunityType,
        status: item.status,
        recoverableAmount: money(item.recoverableAmount),
        currency: item.currency,
        claimDeadline: item.claimDeadline ? item.claimDeadline.toISOString() : null,
      })),
      basisSummary: firstOpportunity
        ? firstOpportunity.title + '（' + firstOpportunity.opportunityType + '）'
        : '该案件暂无关联追回机会',
      amountBasis: money(recoverable) === null ? null : money(recoverable) + ' ' + kase.currency,
      evidenceCount: evidence.length,
      linkedEvidenceCount,
    },
    evidence,
    missingItems: [...missingItems],
    readiness: {
      state,
      label: READINESS_LABEL[state],
      packageReady: activePackage !== null,
      claimSubmitted: hasSubmission || claimItems.some((item) => item.status === 'SUBMITTED_MANUAL'),
      providerWrite: PROVIDER_WRITE_STATE,
    },
    actions: {
      canPrepare: activePackage === null,
      canDownloadPackage: evidence.length > 0,
      canRecordManualSubmission: state === 'READY_TO_SUBMIT',
      canAppeal: state === 'APPEAL_REQUIRED',
    },
  };
}
