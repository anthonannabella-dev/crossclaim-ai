/**
 * C-0011 — ClaimItem 基础服务（归一化损失事件的生命周期）
 * ---------------------------------------------------------------
 * 架构方裁定（MSG-20260928-114 / -116 / -118）：
 *   · 生命周期线性：DISCOVERED → VERIFIED → REVIEW_REQUIRED → READY_TO_APPEAL →
 *     SUBMITTED_MANUAL → RECOVERED → CLOSED；**没有 AUTO_SUBMITTED**（本文件不存在该值）
 *   · 关闭用 `closedReason` 表达（RECOVERED / REJECTED / NOT_WORTH_PURSUING / CUSTOMER_DECLINED），不涨状态
 *   · `caseId` 是**状态机不变量**：REVIEW_REQUIRED 起必须入案（不是数据库 CHECK）
 *   · `platformRef` 可为空；为空时**无自动幂等**，必须写审计告警
 *     `claim.item_created_without_platform_ref`（发现阶段允许存在，但必须可见）
 *   · 状态迁移审计必须带 fromStatus / toStatus / claimItemId / caseId
 *   · FINANCE 只能读 status / recoverableAmount / settlementRef；
 *     `ClaimItemEvidence` 对 FINANCE 与 VIEWER 一律不可读（防止绕过证据边界）
 */

import { resolveClaimItemAccount, resolveFromConnection } from '../account-lineage/policy';
import { Prisma, type PrismaClient } from '@prisma/client';

import { prepareAuditInsert } from '../audit';
import { WorkflowError } from '../workflow/opportunity-review';
import { assertPermission } from '../workflow/permissions';
import { FINGERPRINT_VERSION, sourceFingerprintV1 } from './source-fingerprint';

export const CLAIM_ITEM_STATUSES = [
  'DISCOVERED',
  'VERIFIED',
  'REVIEW_REQUIRED',
  'READY_TO_APPEAL',
  'SUBMITTED_MANUAL',
  'RECOVERED',
  'CLOSED',
] as const;
export type ClaimItemStatus = (typeof CLAIM_ITEM_STATUSES)[number];

export const CLAIM_ITEM_CLOSED_REASONS = [
  'RECOVERED',
  'REJECTED',
  'NOT_WORTH_PURSUING',
  'CUSTOMER_DECLINED',
] as const;
export type ClaimItemClosedReason = (typeof CLAIM_ITEM_CLOSED_REASONS)[number];

export const CLAIM_RESPONSIBLE_PARTIES = [
  'CARRIER',
  'PLATFORM',
  'PLATFORM_WAREHOUSE',
  'SELLER',
  'BUYER',
  'THIRD_PARTY',
  'UNKNOWN',
] as const;
export type ClaimResponsibleParty = (typeof CLAIM_RESPONSIBLE_PARTIES)[number];

export const CLAIM_EVIDENCE_TYPES = [
  'POD',
  'INVOICE',
  'LEDGER_EXPORT',
  'ADJUSTMENT_REPORT',
  'TRACKING',
  'PLATFORM_DECISION',
  'CLAIM_RESPONSE',
  'CONTRACT_TERM',
  'OTHER',
] as const;
export type ClaimEvidenceType = (typeof CLAIM_EVIDENCE_TYPES)[number];

export const CLAIM_PLATFORM_TYPES = ['AMAZON', 'TIKTOK', 'WALMART', 'UNKNOWN'] as const;
export type ClaimPlatformType = (typeof CLAIM_PLATFORM_TYPES)[number];

/** 线性主链 + 任意非终态可 CLOSED（原因由 closedReason 表达）。 */
export const CLAIM_ITEM_TRANSITIONS: Record<ClaimItemStatus, readonly ClaimItemStatus[]> = {
  DISCOVERED: ['VERIFIED', 'CLOSED'],
  VERIFIED: ['REVIEW_REQUIRED', 'CLOSED'],
  REVIEW_REQUIRED: ['READY_TO_APPEAL', 'CLOSED'],
  READY_TO_APPEAL: ['SUBMITTED_MANUAL', 'CLOSED'],
  SUBMITTED_MANUAL: ['RECOVERED', 'CLOSED'],
  RECOVERED: ['CLOSED'],
  CLOSED: [],
};

/** 从这些状态起必须有 caseId（状态机不变量，刻意不用数据库 CHECK）。 */
export const CLAIM_STATES_REQUIRING_CASE: readonly ClaimItemStatus[] = [
  'REVIEW_REQUIRED',
  'READY_TO_APPEAL',
  'SUBMITTED_MANUAL',
  'RECOVERED',
];

export const CLAIM_ITEM_AUDIT = {
  created: 'claim.item_created',
  createdWithoutRef: 'claim.item_created_without_platform_ref',
  evidenceLinked: 'claim.evidence_linked',
  transition: (from: ClaimItemStatus, to: ClaimItemStatus): string =>
    `claim.${from.toLowerCase()}_to_${to.toLowerCase()}`,
} as const;

export function canTransitionClaimItem(from: ClaimItemStatus, to: ClaimItemStatus): boolean {
  return CLAIM_ITEM_TRANSITIONS[from].includes(to);
}

export function requiresCase(status: ClaimItemStatus): boolean {
  return CLAIM_STATES_REQUIRING_CASE.includes(status);
}

async function writeClaimAudit(
  prisma: PrismaClient | Prisma.TransactionClient,
  input: {
    organizationId: string;
    actorUserId: string;
    action: string;
    entityId: string;
    changes: Record<string, unknown>;
    at: Date;
  },
): Promise<void> {
  const row = prepareAuditInsert(
    {
      organizationId: input.organizationId,
      actorType: 'USER',
      actorUserId: input.actorUserId,
      action: input.action,
      entityType: 'ClaimItem',
      entityId: input.entityId,
      changes: input.changes,
    },
    { maxStringLength: 512 },
  );
  await prisma.auditLog.create({
    data: {
      organizationId: row.organizationId,
      actorType: row.actorType,
      actorUserId: row.actorUserId,
      actorRef: row.actorRef,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      changes: (row.changes ?? undefined) as Prisma.InputJsonValue | undefined,
      ip: row.ip,
      userAgent: row.userAgent,
      createdAt: input.at,
    },
  });
}

export interface CreateClaimItemInput {
  organizationId: string;
  actorUserId: string;
  role: string;
  platformType: ClaimPlatformType;
  claimType: string;
  platformRef?: string | null;
  /** C-0013-A：来源指纹；缺省且给了 normalizedRef 时由服务计算 */
  sourceFingerprint?: string | null;
  fingerprintVersion?: string | null;
  /** C-0013-A：指纹里参与计算的稳定引用（Normalizer 提供） */
  normalizedRef?: string | null;
  /** C-0013-A：创建来源。CONNECTOR_IMPORT 必须至少带 platformRef 或 sourceFingerprint */
  creationContext?: 'MANUAL_IMPORT' | 'CONNECTOR_IMPORT';
  occurredAt: Date;
  amountExpected?: string | null;
  amountActual?: string | null;
  currency?: string;
  recoverableAmount?: string | null;
  responsibleParty?: ClaimResponsibleParty;
  normalizerVersion: string;
  caseId?: string | null;
  opportunityId?: string | null;
  /**
   * TRACK B BATCH 2 / B2-3：可信连接上下文（server-derived）。
   * 由连接器编排器等内部调用方提供（其 connectionRef 必须指向同租户已绑定 PlatformAccount 的连接）；
   * 客户端不得用它绕过 account 归属判定。
   */
  trustedConnectionId?: string | null;
  ruleVersionId?: string | null;
}

export interface CreateClaimItemResult {
  id: string;
  created: boolean;
  /**
   * PLATFORM_REF = 平台引用幂等；SOURCE_FINGERPRINT = 指纹幂等；
   * UNAVAILABLE = 两者都没有（仅 MANUAL_IMPORT，会写告警审计）
   */
  idempotency: 'PLATFORM_REF' | 'SOURCE_FINGERPRINT' | 'UNAVAILABLE';
}

const money = (value: string | null | undefined): Prisma.Decimal | null =>
  value === null || value === undefined ? null : new Prisma.Decimal(value);

export async function createClaimItem(
  prisma: PrismaClient,
  input: CreateClaimItemInput,
  deps: { now?: () => Date } = {},
): Promise<CreateClaimItemResult> {
  assertPermission(input.role, 'manageClaimItems');
  if (!(CLAIM_PLATFORM_TYPES as readonly string[]).includes(input.platformType)) {
    throw new WorkflowError('INVALID_INPUT', `未知平台类型：${input.platformType}`);
  }
  if (!input.claimType || input.claimType.trim() === '') {
    throw new WorkflowError('INVALID_INPUT', 'claimType 不能为空');
  }
  const at = (deps.now ?? (() => new Date()))();
  const platformRef = input.platformRef?.trim() ? input.platformRef.trim() : null;
  const creationContext = input.creationContext ?? 'MANUAL_IMPORT';

  // C-0013-A：指纹来源（显式传入优先；否则由 normalizedRef 计算）
  const computed =
    input.sourceFingerprint || !input.normalizedRef
      ? null
      : sourceFingerprintV1({
          platformType: input.platformType,
          claimType: input.claimType,
          occurredAt: input.occurredAt,
          normalizedRef: input.normalizedRef,
          currency: input.currency ?? 'USD',
        });
  const sourceFingerprint = input.sourceFingerprint?.trim() ? input.sourceFingerprint.trim() : (computed?.fingerprint ?? null);
  const fingerprintVersion = sourceFingerprint
    ? (input.fingerprintVersion ?? computed?.version ?? FINGERPRINT_VERSION)
    : null;

  // REVISE-2（MSG-134）：sourceFingerprint 非空 ⇒ fingerprintVersion 必须等于当前版本
  if (sourceFingerprint && fingerprintVersion !== FINGERPRINT_VERSION) {
    throw new WorkflowError(
      'INVALID_INPUT',
      `fingerprintVersion 必须是 ${FINGERPRINT_VERSION}（收到 ${fingerprintVersion}）`,
    );
  }

  // NULL 契约（MSG-132 REVISE-2）：Connector 路径必须至少带一个来源标识
  if (!platformRef && !sourceFingerprint && creationContext === 'CONNECTOR_IMPORT') {
    throw new WorkflowError(
      'SOURCE_IDENTITY_REQUIRED',
      'CONNECTOR_IMPORT 必须带 platformRef 或 sourceFingerprint',
    );
  }

  // 幂等优先级（MSG-130 REVISE-1）：platformRef → sourceFingerprint → （人工路径）允许但告警
  if (platformRef) {
    const existing = await prisma.claimItem.findFirst({
      where: {
        organizationId: input.organizationId,
        platformType: input.platformType,
        platformRef,
        claimType: input.claimType,
      },
      select: { id: true },
    });
    if (existing) return { id: existing.id, created: false, idempotency: 'PLATFORM_REF' };
  }
  if (sourceFingerprint) {
    const byFingerprint = await prisma.claimItem.findFirst({
      where: { organizationId: input.organizationId, platformType: input.platformType, sourceFingerprint },
      select: { id: true },
    });
    if (byFingerprint) {
      return { id: byFingerprint.id, created: false, idempotency: 'SOURCE_FINGERPRINT' };
    }
  }

  try {
    const created = await prisma.$transaction(async (tx) => {
      // TRACK B BATCH 2 / B2-3：active new ClaimItem 必须 account-scoped。
      // 归属由共享 Account Lineage Policy 派生：opportunity 上下文优先，其次可信连接上下文；
      // 两者皆无（manual staging / 未绑定连接）→ fail-closed，不写 NULL。
      const opportunityAccountId = input.opportunityId
        ? await resolveClaimItemAccount(tx as never, {
            organizationId: input.organizationId,
            opportunityId: input.opportunityId,
          })
        : await resolveFromConnection(tx as never, {
            organizationId: input.organizationId,
            connectionId: input.trustedConnectionId ?? null,
          });
      const item = await tx.claimItem.create({
      data: {
        organizationId: input.organizationId,
        accountId: opportunityAccountId,
        caseId: input.caseId ?? null,
        opportunityId: input.opportunityId ?? null,
        platformType: input.platformType,
        claimType: input.claimType.trim(),
        platformRef,
        sourceFingerprint,
        fingerprintVersion,
        occurredAt: input.occurredAt,
        amountExpected: money(input.amountExpected),
        amountActual: money(input.amountActual),
        currency: input.currency ?? 'USD',
        recoverableAmount: money(input.recoverableAmount),
        responsibleParty: input.responsibleParty ?? 'UNKNOWN',
        status: 'DISCOVERED',
        normalizerVersion: input.normalizerVersion,
        ruleVersionId: input.ruleVersionId ?? null,
      },
      select: { id: true },
    });
    await writeClaimAudit(tx, {
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: CLAIM_ITEM_AUDIT.created,
      entityId: item.id,
      changes: {
        platformType: input.platformType,
        claimType: input.claimType,
        platformRef,
        normalizerVersion: input.normalizerVersion,
        // MSG-134 REVISE：审计**不写指纹值**，只写"有没有"与版本
        fingerprintVersion,
        fingerprintPresent: sourceFingerprint !== null,
        idempotency: platformRef ? 'PLATFORM_REF' : sourceFingerprint ? 'SOURCE_FINGERPRINT' : 'UNAVAILABLE',
      },
      at,
    });
    if (!platformRef && !sourceFingerprint) {
      // REVISE-1：无平台引用 → 允许创建，但必须可见（告警审计，不是失败）
      await writeClaimAudit(tx, {
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        action: CLAIM_ITEM_AUDIT.createdWithoutRef,
        entityId: item.id,
        changes: {
          reason: 'PLATFORM_REF_MISSING',
          idempotency: 'UNAVAILABLE',
          fingerprintPresent: false,
          platformType: input.platformType,
          claimType: input.claimType,
        },
        at,
      });
    }
    return item;
    });

    return {
      id: created.id,
      created: true,
      idempotency: platformRef ? 'PLATFORM_REF' : sourceFingerprint ? 'SOURCE_FINGERPRINT' : 'UNAVAILABLE',
    };
  } catch (error) {
    // MSG-134 REVISE-1：唯一冲突必须分类，不能一律吞掉
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      // A) 并发/重放：按同一优先级再查一次，命中就返回既有行
      if (platformRef) {
        const existing = await prisma.claimItem.findFirst({
          where: {
            organizationId: input.organizationId,
            platformType: input.platformType,
            platformRef,
            claimType: input.claimType,
          },
          select: { id: true },
        });
        if (existing) return { id: existing.id, created: false, idempotency: 'PLATFORM_REF' };
      }
      if (sourceFingerprint) {
        const existing = await prisma.claimItem.findFirst({
          where: { organizationId: input.organizationId, platformType: input.platformType, sourceFingerprint },
          select: { id: true },
        });
        if (existing) return { id: existing.id, created: false, idempotency: 'SOURCE_FINGERPRINT' };
      }
      // C) 与本次创建无关的唯一约束 → 原样抛出，绝不静默吞掉
      throw error;
    }
    throw error;
  }
}

export interface TransitionClaimItemInput {
  organizationId: string;
  actorUserId: string;
  role: string;
  claimItemId: string;
  to: ClaimItemStatus;
  closedReason?: unknown;
  caseId?: string | null;
}

export interface TransitionClaimItemResult {
  claimItemId: string;
  from: ClaimItemStatus;
  to: ClaimItemStatus;
  closedReason: ClaimItemClosedReason | null;
}

export async function transitionClaimItem(
  prisma: PrismaClient,
  input: TransitionClaimItemInput,
  deps: { now?: () => Date } = {},
): Promise<TransitionClaimItemResult> {
  assertPermission(input.role, 'manageClaimItems');
  if (!(CLAIM_ITEM_STATUSES as readonly string[]).includes(input.to)) {
    throw new WorkflowError('INVALID_INPUT', `未知状态：${input.to}`);
  }
  const at = (deps.now ?? (() => new Date()))();

  const current = await prisma.claimItem.findFirst({
    where: { id: input.claimItemId, organizationId: input.organizationId },
    select: { id: true, status: true, caseId: true },
  });
  if (!current) throw new WorkflowError('NOT_FOUND', `ClaimItem ${input.claimItemId} 不存在或不属于该租户`);

  const from = current.status as ClaimItemStatus;
  if (!canTransitionClaimItem(from, input.to)) {
    throw new WorkflowError('ILLEGAL_TRANSITION', `不允许 ${from} → ${input.to}`);
  }
  if (from === 'CLOSED') {
    throw new WorkflowError('ILLEGAL_TRANSITION', 'CLOSED 是终态');
  }

  // 关闭：必须有白名单原因
  let closedReason: ClaimItemClosedReason | null = null;
  if (input.to === 'CLOSED') {
    const raw = typeof input.closedReason === 'string' ? input.closedReason.trim().toUpperCase() : '';
    if (!(CLAIM_ITEM_CLOSED_REASONS as readonly string[]).includes(raw)) {
      throw new WorkflowError('REASON_REQUIRED', 'CLOSED 必须给出白名单 closedReason');
    }
    closedReason = raw as ClaimItemClosedReason;
  } else if (input.closedReason !== undefined && input.closedReason !== null) {
    throw new WorkflowError('INVALID_FIELD', 'closedReason 只在 CLOSED 时可给出');
  }

  // caseId 不变量：REVIEW_REQUIRED 起必须入案
  const effectiveCaseId = input.caseId ?? current.caseId ?? null;
  if (requiresCase(input.to) && !effectiveCaseId) {
    throw new WorkflowError('CLAIM_ITEM_CASE_REQUIRED', `${input.to} 起必须关联 Case（caseId 必填）`);
  }

  const updated = await prisma.$transaction(async (tx) => {
    const cas = await tx.claimItem.updateMany({
      where: { id: input.claimItemId, organizationId: input.organizationId, status: from },
      data: {
        status: input.to,
        ...(effectiveCaseId ? { caseId: effectiveCaseId } : {}),
        ...(closedReason ? { closedReason, closedAt: at } : {}),
      },
    });
    if (cas.count !== 1) {
      throw new WorkflowError('ILLEGAL_TRANSITION', 'CAS 未命中：状态已被其他请求改变');
    }
    await writeClaimAudit(tx, {
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: CLAIM_ITEM_AUDIT.transition(from, input.to),
      entityId: input.claimItemId,
      changes: {
        fromStatus: from,
        toStatus: input.to,
        claimItemId: input.claimItemId,
        caseId: effectiveCaseId,
        ...(closedReason ? { closedReason } : {}),
      },
      at,
    });
    return true;
  });
  if (!updated) throw new WorkflowError('ILLEGAL_TRANSITION', '迁移未生效');

  return { claimItemId: input.claimItemId, from, to: input.to, closedReason };
}

/** FINANCE 可见字段白名单（决议 MSG-20260928-118 REVISE-2）。 */
export const FINANCE_CLAIM_ITEM_FIELDS = ['status', 'recoverableAmount', 'settlementRef'] as const;

export interface ClaimItemFinanceView {
  id: string;
  status: string;
  recoverableAmount: string | null;
  settlementRef: string | null;
}

export interface ClaimItemFullView {
  id: string;
  caseId: string | null;
  opportunityId: string | null;
  platformType: string;
  claimType: string;
  platformRef: string | null;
  occurredAt: Date;
  amountExpected: string | null;
  amountActual: string | null;
  currency: string;
  recoverableAmount: string | null;
  responsibleParty: string;
  status: string;
  closedReason: string | null;
  normalizerVersion: string;
  ruleVersionId: string | null;
  evidenceLinkCount: number;
}

const decimal = (value: Prisma.Decimal | null): string | null => (value ? value.toFixed(4) : null);

type ClaimItemRow = {
  id: string;
  caseId: string | null;
  opportunityId: string | null;
  platformType: string;
  claimType: string;
  platformRef: string | null;
  occurredAt: Date;
  amountExpected: Prisma.Decimal | null;
  amountActual: Prisma.Decimal | null;
  currency: string;
  recoverableAmount: Prisma.Decimal | null;
  responsibleParty: string;
  status: string;
  closedReason: string | null;
  normalizerVersion: string;
  ruleVersionId: string | null;
  evidenceLinks: Array<{ id: string }>;
  case: { settlements: Array<{ id: string }> } | null;
};

const CLAIM_ITEM_SELECT = {
  id: true,
  caseId: true,
  opportunityId: true,
  platformType: true,
  claimType: true,
  platformRef: true,
  occurredAt: true,
  amountExpected: true,
  amountActual: true,
  currency: true,
  recoverableAmount: true,
  responsibleParty: true,
  status: true,
  closedReason: true,
  normalizerVersion: true,
  ruleVersionId: true,
  evidenceLinks: { select: { id: true } },
  case: { select: { settlements: { select: { id: true }, take: 1, orderBy: { createdAt: 'desc' as const } } } },
} as const;

function toFinanceView(row: ClaimItemRow): ClaimItemFinanceView {
  return {
    id: row.id,
    status: row.status,
    recoverableAmount: decimal(row.recoverableAmount),
    settlementRef: row.case?.settlements[0]?.id ?? null,
  };
}

function toFullView(row: ClaimItemRow): ClaimItemFullView {
  return {
    id: row.id,
    caseId: row.caseId,
    opportunityId: row.opportunityId,
    platformType: row.platformType,
    claimType: row.claimType,
    platformRef: row.platformRef,
    occurredAt: row.occurredAt,
    amountExpected: decimal(row.amountExpected),
    amountActual: decimal(row.amountActual),
    currency: row.currency,
    recoverableAmount: decimal(row.recoverableAmount),
    responsibleParty: row.responsibleParty,
    status: row.status,
    closedReason: row.closedReason,
    normalizerVersion: row.normalizerVersion,
    ruleVersionId: row.ruleVersionId,
    evidenceLinkCount: row.evidenceLinks.length,
  };
}

export async function listClaimItems(
  prisma: PrismaClient,
  actor: { organizationId: string; role: string },
  limit = 50,
): Promise<Array<ClaimItemFullView | ClaimItemFinanceView>> {
  assertPermission(actor.role, 'viewClaimItemSummary');
  const rows = (await prisma.claimItem.findMany({
    where: { organizationId: actor.organizationId },
    orderBy: { occurredAt: 'desc' },
    take: Math.min(Math.max(limit, 1), 200),
    select: CLAIM_ITEM_SELECT,
  })) as unknown as ClaimItemRow[];
  return rows.map((row) => (actor.role === 'FINANCE' ? toFinanceView(row) : toFullView(row)));
}

export async function getClaimItem(
  prisma: PrismaClient,
  actor: { organizationId: string; role: string },
  claimItemId: string,
): Promise<ClaimItemFullView | ClaimItemFinanceView> {
  assertPermission(actor.role, 'viewClaimItemSummary');
  const row = (await prisma.claimItem.findFirst({
    where: { id: claimItemId, organizationId: actor.organizationId },
    select: CLAIM_ITEM_SELECT,
  })) as unknown as ClaimItemRow | null;
  if (!row) throw new WorkflowError('NOT_FOUND', `ClaimItem ${claimItemId} 不存在或不属于该租户`);
  return actor.role === 'FINANCE' ? toFinanceView(row) : toFullView(row);
}

export interface LinkEvidenceInput {
  organizationId: string;
  actorUserId: string;
  role: string;
  claimItemId: string;
  evidenceId: string;
  evidenceType?: ClaimEvidenceType;
  note?: string;
}

/** 证据联结：只建引用，不复制文件；FINANCE / VIEWER 一律不可读（更不可写）。 */
export async function linkEvidence(
  prisma: PrismaClient,
  input: LinkEvidenceInput,
  deps: { now?: () => Date } = {},
): Promise<{ id: string; created: boolean }> {
  assertPermission(input.role, 'manageClaimItems');
  const at = (deps.now ?? (() => new Date()))();
  const claimItem = await prisma.claimItem.findFirst({
    where: { id: input.claimItemId, organizationId: input.organizationId },
    select: { id: true },
  });
  if (!claimItem) throw new WorkflowError('NOT_FOUND', `ClaimItem ${input.claimItemId} 不存在或不属于该租户`);

  const existing = await prisma.claimItemEvidence.findFirst({
    where: {
      organizationId: input.organizationId,
      claimItemId: input.claimItemId,
      evidenceId: input.evidenceId,
    },
    select: { id: true },
  });
  if (existing) return { id: existing.id, created: false };

  const created = await prisma.$transaction(async (tx) => {
    const link = await tx.claimItemEvidence.create({
      data: {
        organizationId: input.organizationId,
        claimItemId: input.claimItemId,
        evidenceId: input.evidenceId,
        evidenceType: input.evidenceType ?? 'OTHER',
        note: input.note ?? null,
      },
      select: { id: true },
    });
    await writeClaimAudit(tx, {
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: CLAIM_ITEM_AUDIT.evidenceLinked,
      entityId: input.claimItemId,
      changes: {
        claimItemId: input.claimItemId,
        evidenceId: input.evidenceId,
        evidenceType: input.evidenceType ?? 'OTHER',
      },
      at,
    });
    return link;
  });
  return { id: created.id, created: true };
}

export interface ClaimItemEvidenceView {
  id: string;
  evidenceId: string;
  evidenceType: string;
  note: string | null;
  createdAt: Date;
}

/** 证据元数据只对 OWNER / ADMIN / OPS 开放；FINANCE 与 VIEWER 直接 403。 */
export async function listClaimItemEvidence(
  prisma: PrismaClient,
  actor: { organizationId: string; role: string },
  claimItemId: string,
): Promise<ClaimItemEvidenceView[]> {
  assertPermission(actor.role, 'viewClaimEvidence');
  const claimItem = await prisma.claimItem.findFirst({
    where: { id: claimItemId, organizationId: actor.organizationId },
    select: { id: true },
  });
  if (!claimItem) throw new WorkflowError('NOT_FOUND', `ClaimItem ${claimItemId} 不存在或不属于该租户`);
  return prisma.claimItemEvidence.findMany({
    where: { organizationId: actor.organizationId, claimItemId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, evidenceId: true, evidenceType: true, note: true, createdAt: true },
  });
}
