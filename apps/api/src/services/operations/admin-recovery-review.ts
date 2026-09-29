/**
 * ADMIN — Recovery Review Queue（Admin Phase 3 / A5）
 * ---------------------------------------------------------------
 * 依据：ADMIN-RECOVERY-REVIEW-DESIGN.md + MSG-20260929-37（GO_WITH_MINOR_REVISE）。
 *
 * 铁律：**Admin 看见流程，但不拥有流程。**
 *   · 三状态桶必须来自**既有 recovery-review 状态**（本模块只读既有审计动作，绝不自行推导）
 *   · 角标一律为 **projection flag**（不是状态）；AGED 阈值是**代码常量**，不可由 Admin 配置
 *   · 证据只给 evidenceId / kind / role / capturedAt（无文件名、无 storageKey、无 URL、无原文）
 *   · **不展示任何金额**（含阈值金额）；只允许事实标签 HIGH_VALUE_REVIEW_REQUIRED
 *   · 不提供 approve / reject / 状态修改端点 —— 审批仍由既有 recovery-review 流程承担
 */

import type { PrismaClient } from '@prisma/client';

import { WorkflowError } from '../workflow/opportunity-review';
import {
  ADMIN_DEFAULT_PAGE_SIZE,
  ADMIN_MAX_PAGE_SIZE,
  assertAdminAccess,
  decodeAdminCursor,
  encodeAdminCursor,
} from './admin-console';

/** D5：默认阈值是**代码常量**（非数据库配置、Admin 不可改；未来如需可配置须另行设计） */
export const AGED_THRESHOLD_DAYS = 7;

export const RECOVERY_REVIEW_BUCKETS = ['pending_review', 'approved', 'rejected'] as const;
export type RecoveryReviewBucket = (typeof RECOVERY_REVIEW_BUCKETS)[number];

export const RECOVERY_REVIEW_FLAGS = ['HIGH_VALUE_REVIEW_REQUIRED', 'AGED', 'MISSING_EVIDENCE_REF'] as const;
export type RecoveryReviewFlag = (typeof RECOVERY_REVIEW_FLAGS)[number];

/** 既有审核流程的审计动作（只读；Admin 不新增动作） */
export const REVIEW_AUDIT_ACTIONS = {
  required: 'recovery.review_required',
  approved: 'recovery.review_approved',
  rejected: 'recovery.review_rejected',
} as const;

/**
 * 固定映射：由**既有审计动作的先后**决定状态（approved/rejected 覆盖 required）。
 * 明确的 fail-closed：无 required 且无 decided → 不属于本队列（null）。
 */
export function bucketForReviewAudit(input: {
  requiredAt: Date | null;
  approvedAt: Date | null;
  rejectedAt: Date | null;
}): RecoveryReviewBucket | null {
  if (input.rejectedAt && (!input.approvedAt || input.rejectedAt.getTime() >= input.approvedAt.getTime())) {
    return 'rejected';
  }
  if (input.approvedAt) return 'approved';
  if (input.requiredAt) return 'pending_review';
  return null;
}

export function flagsForReview(input: {
  bucket: RecoveryReviewBucket;
  requiredAt: Date | null;
  evidenceRefCount: number;
  now: Date;
}): RecoveryReviewFlag[] {
  const flags: RecoveryReviewFlag[] = [];
  if (input.bucket === 'pending_review') {
    flags.push('HIGH_VALUE_REVIEW_REQUIRED'); // 事实标签，不含任何金额或阈值数字
    if (input.requiredAt) {
      const ageDays = (input.now.getTime() - input.requiredAt.getTime()) / 86_400_000;
      if (ageDays >= AGED_THRESHOLD_DAYS) flags.push('AGED');
    }
  }
  if (input.evidenceRefCount === 0) flags.push('MISSING_EVIDENCE_REF');
  return flags;
}

export interface EvidenceRef {
  evidenceId: string;
  kind: string | null;
  role: string | null;
  capturedAt: string | null;
}

export interface RecoveryReviewItem {
  caseId: string;
  caseNo: string;
  bucket: RecoveryReviewBucket;
  flags: RecoveryReviewFlag[];
  requiredAt: string | null;
  decidedAt: string | null;
  evidenceRefs: EvidenceRef[];
  /** 深链到既有审核流程（Admin 不代授权：目标服务会重新校验权限） */
  reviewPath: string;
}

/** 金额与阈值字段一律禁止出现在 Admin 响应中（D4 + 实现期验收 3） */
export const FORBIDDEN_AMOUNT_KEYS = [
  'amount',
  'currency',
  'recoveredAmount',
  'settlementAmount',
  'payoutAmount',
  'threshold',
  'feeAmount',
] as const;

/** 审批捷径检测：本模块不得导出任何审批/状态变更函数（实现期验收 1） */
export const APPROVAL_FORBIDDEN_PATTERNS = ['approve', 'reject', 'submit', 'mutate', 'updateStatus'] as const;

export interface AdminRecoveryReviewDeps {
  prisma: PrismaClient;
  now?: () => Date;
}

function normalizeLimit(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return ADMIN_DEFAULT_PAGE_SIZE;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new WorkflowError('INVALID_INPUT', 'limit 必须是正整数');
  }
  return Math.min(value, ADMIN_MAX_PAGE_SIZE);
}

async function loadReviewAudits(
  deps: AdminRecoveryReviewDeps,
  organizationId: string,
  caseIds?: string[],
): Promise<Map<string, { requiredAt: Date | null; approvedAt: Date | null; rejectedAt: Date | null }>> {
  const rows = await deps.prisma.auditLog.findMany({
    where: {
      organizationId,
      entityType: 'Case',
      action: { in: Object.values(REVIEW_AUDIT_ACTIONS) as unknown as string[] },
      ...(caseIds ? { entityId: { in: caseIds } } : {}),
    },
    orderBy: { createdAt: 'asc' },
    select: { entityId: true, action: true, createdAt: true },
  });
  const map = new Map<string, { requiredAt: Date | null; approvedAt: Date | null; rejectedAt: Date | null }>();
  for (const row of rows) {
    const caseId = row.entityId ?? '';
    if (caseId === '') continue;
    const current = map.get(caseId) ?? { requiredAt: null, approvedAt: null, rejectedAt: null };
    if (row.action === REVIEW_AUDIT_ACTIONS.required) current.requiredAt = row.createdAt;
    if (row.action === REVIEW_AUDIT_ACTIONS.approved) current.approvedAt = row.createdAt;
    if (row.action === REVIEW_AUDIT_ACTIONS.rejected) current.rejectedAt = row.createdAt;
    map.set(caseId, current);
  }
  return map;
}

async function evidenceRefsFor(
  deps: AdminRecoveryReviewDeps,
  organizationId: string,
  caseId: string,
): Promise<EvidenceRef[]> {
  const links = await deps.prisma.caseEvidence.findMany({
    where: { organizationId, caseId },
    take: 20,
    select: { evidenceId: true, role: true, evidence: { select: { kind: true, capturedAt: true } } },
  });
  return links.map((link) => ({
    evidenceId: link.evidenceId,
    kind: link.evidence?.kind ?? null,
    role: link.role ?? null,
    capturedAt: link.evidence?.capturedAt ? link.evidence.capturedAt.toISOString() : null,
  }));
}

export async function listRecoveryReviewQueue(
  deps: AdminRecoveryReviewDeps,
  input: {
    organizationId: string;
    role: string | null | undefined;
    filter?: { bucket?: unknown; cursor?: unknown; limit?: unknown };
  },
): Promise<{ items: RecoveryReviewItem[]; nextCursor: string | null }> {
  assertAdminAccess(input.role, 'recoveryReview');
  const at = (deps.now ?? (() => new Date()))();
  const filter = input.filter ?? {};
  const limit = normalizeLimit(filter.limit);
  const cursor = decodeAdminCursor(filter.cursor);

  const where: Record<string, unknown> = { organizationId: input.organizationId };
  if (cursor) {
    where.OR = [
      { updatedAt: { lt: new Date(cursor.sortValue) } },
      { updatedAt: new Date(cursor.sortValue), id: { lt: cursor.id } },
    ];
  }
  const cases = await deps.prisma.case.findMany({
    where: where as never,
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: { id: true, caseNo: true, updatedAt: true },
  });
  const page = cases.slice(0, limit);
  const audits = await loadReviewAudits(deps, input.organizationId, page.map((row) => row.id));

  const items: RecoveryReviewItem[] = [];
  for (const row of page) {
    const audit = audits.get(row.id);
    const bucket = audit
      ? bucketForReviewAudit(audit)
      : null;
    // 队列只包含「存在既有审核记录」的案件 —— Admin 不推断任何新状态
    if (!bucket) continue;
    const evidenceRefs = await evidenceRefsFor(deps, input.organizationId, row.id);
    items.push({
      caseId: row.id,
      caseNo: row.caseNo,
      bucket,
      flags: flagsForReview({
        bucket,
        requiredAt: audit?.requiredAt ?? null,
        evidenceRefCount: evidenceRefs.length,
        now: at,
      }),
      requiredAt: audit?.requiredAt ? audit.requiredAt.toISOString() : null,
      decidedAt:
        bucket === 'approved'
          ? audit?.approvedAt?.toISOString() ?? null
          : bucket === 'rejected'
            ? audit?.rejectedAt?.toISOString() ?? null
            : null,
      evidenceRefs,
      reviewPath: `/cases/${row.id}/recovery-review`,
    });
  }

  const wanted = typeof filter.bucket === 'string' ? filter.bucket : '';
  const filtered = wanted === '' ? items : items.filter((item) => item.bucket === wanted);
  const last = page[page.length - 1];

  return {
    items: filtered,
    nextCursor: cases.length > limit && last ? encodeAdminCursor(last.updatedAt.getTime(), last.id) : null,
  };
}

export async function getRecoveryReviewItem(
  deps: AdminRecoveryReviewDeps,
  input: { organizationId: string; role: string | null | undefined; caseId: string },
): Promise<RecoveryReviewItem> {
  assertAdminAccess(input.role, 'recoveryReview');
  const at = (deps.now ?? (() => new Date()))();
  const row = await deps.prisma.case.findFirst({
    where: { id: input.caseId, organizationId: input.organizationId },
    select: { id: true, caseNo: true },
  });
  if (!row) throw new WorkflowError('NOT_FOUND', '案件不存在或不属于该租户');

  const audits = await loadReviewAudits(deps, input.organizationId, [row.id]);
  const audit = audits.get(row.id);
  const bucket = audit ? bucketForReviewAudit(audit) : null;
  if (!bucket) throw new WorkflowError('NOT_FOUND', '该案件没有既有审核记录（不在 Recovery Review 队列中）');

  const evidenceRefs = await evidenceRefsFor(deps, input.organizationId, row.id);
  return {
    caseId: row.id,
    caseNo: row.caseNo,
    bucket,
    flags: flagsForReview({
      bucket,
      requiredAt: audit?.requiredAt ?? null,
      evidenceRefCount: evidenceRefs.length,
      now: at,
    }),
    requiredAt: audit?.requiredAt ? audit.requiredAt.toISOString() : null,
    decidedAt:
      bucket === 'approved'
        ? audit?.approvedAt?.toISOString() ?? null
        : bucket === 'rejected'
          ? audit?.rejectedAt?.toISOString() ?? null
          : null,
    evidenceRefs,
    reviewPath: `/cases/${row.id}/recovery-review`,
  };
}
