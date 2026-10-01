/**
 * C-0009.2 Step 2 — high-value recovery human gate (audit-derived, no schema).
 * ---------------------------------------------------------------
 * Approved design (MSG-20260928-70):
 *   · gate      : before `confirmRecoveryOutcome` books money; amount above the
 *                 threshold requires an APPROVED review, otherwise the call fails
 *                 with 409 REVIEW_REQUIRED and **zero** money writes.
 *   · threshold : USD 1000.00 default, env-overridable. **Non-USD amounts are
 *                 always gated** (no FX in the money chain — architect ruling Q2).
 *   · roles     : request = OWNER/ADMIN/FINANCE; approve/reject = **OWNER/ADMIN**
 *                 (FINANCE is read-only here — architect ruling Q3).
 *   · state     : derived from AuditLog only — no RecoveryReview table, no new
 *                 fields. `approved` only counts when it is LATER than the most
 *                 recent `required` (explicit ordering invariant, Q6).
 *   · audit     : recovery.review_required / recovery.review_approved /
 *                 recovery.review_rejected (USER actor + actorUserId).
 */

import { Prisma, type PrismaClient } from '@prisma/client';

import { prepareAuditInsert } from '../audit';
import {
  APPEAL_SUBMIT_ACTION,
  CLAIM_SUBMIT_ACTION,
  PLATFORM_WRITE_ACTION,
  RECOVERY_CONFIRMATION_ACTION,
  RECOVERY_MANUAL_SUBMIT_ACTION,
  RECOVERY_MANUAL_REFERENCE_ACTION,
} from '../action-guard/approval-verifier';
import { WorkflowError } from './opportunity-review';
import { assertPermission } from './permissions';

export const DEFAULT_HIGH_VALUE_THRESHOLD = '1000.0000';
export const REVIEW_ACTIONS = {
  required: 'recovery.review_required',
  approved: 'recovery.review_approved',
  rejected: 'recovery.review_rejected',
} as const;

/**
 * ② RUNTIME BUSINESS BLOCKING（R19 CHANGE C）：允许使用「仅绑定 basisReference」载荷规则的
 * 非资金动作**白名单**（当前仅 claim.submit）。默认动作（commission.charge）与资金动作仍要求
 * 完整金额/币种/依据；白名单之外的动作一律拒绝，避免"任何非默认动作都被当作非资金动作"。
 */
export const NON_MONEY_APPROVAL_ACTIONS = [CLAIM_SUBMIT_ACTION, APPEAL_SUBMIT_ACTION, PLATFORM_WRITE_ACTION] as const;

export type HighValueReviewState = 'NOT_REQUIRED' | 'PENDING' | 'APPROVED' | 'REJECTED';

export interface ReviewEvent {
  action: string;
  createdAt: Date;
  actorUserId?: string | null;
  changes?: unknown;
}

const money = (value: string | InstanceType<typeof Prisma.Decimal>): string =>
  new Prisma.Decimal(value).toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP).toFixed(4);

/** 审批有效期默认 24h（CHANGE B）；上限 30 天，非法值回落默认 */
export const DEFAULT_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_APPROVAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export function normalizeApprovalTtl(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return DEFAULT_APPROVAL_TTL_MS;
  return Math.min(Math.floor(raw), MAX_APPROVAL_TTL_MS);
}

/** 绑定载荷规范化（金额 4 位小数 / 币种大写 / 字符串裁剪）；缺项不猜测 */
export function normalizeBoundPayload(raw?: {
  recoveredAmount?: unknown;
  currency?: unknown;
  basisReference?: unknown;
  evidenceArtifactId?: unknown;
}): Record<string, string | null> | null {
  if (!raw) return null;
  const amount =
    typeof raw.recoveredAmount === 'string' && raw.recoveredAmount.trim() !== ''
      ? money(raw.recoveredAmount.trim())
      : null;
  const currency = typeof raw.currency === 'string' && raw.currency.trim() !== '' ? raw.currency.trim().toUpperCase() : null;
  const basisReference = typeof raw.basisReference === 'string' && raw.basisReference.trim() !== '' ? raw.basisReference.trim() : null;
  const evidenceArtifactId = typeof raw.evidenceArtifactId === 'string' && raw.evidenceArtifactId.trim() !== '' ? raw.evidenceArtifactId.trim() : null;
  return { amount, currency, basisReference, evidenceArtifactId, fingerprintVersion: 'v1' };
}

export function resolveHighValueThreshold(env: Record<string, string | undefined> = process.env): string {
  const raw = env.HITL_RECOVERY_THRESHOLD;
  if (typeof raw !== 'string' || raw.trim() === '') return DEFAULT_HIGH_VALUE_THRESHOLD;
  try {
    const value = new Prisma.Decimal(raw.trim());
    if (!value.gte(0)) return DEFAULT_HIGH_VALUE_THRESHOLD;
    return money(value);
  } catch {
    return DEFAULT_HIGH_VALUE_THRESHOLD;
  }
}

/** USD 超过阈值才需要卡口；非 USD 一律人工处理（不做汇率换算）。 */
export function requiresHighValueReview(input: {
  recoveredAmount: string | InstanceType<typeof Prisma.Decimal>;
  currency: string;
  threshold: string;
}): boolean {
  if (input.currency !== 'USD') return true;
  return new Prisma.Decimal(input.recoveredAmount).gt(new Prisma.Decimal(input.threshold));
}

/**
 * 状态完全由审计事件推导，并带有顺序不变量：
 * 「已通过」只在 approved 的时间**晚于**最近一次 required 时成立。
 */
export function resolveHighValueReviewState(events: ReviewEvent[]): HighValueReviewState {
  const relevant = events
    .filter(
      (event) =>
        event.action === REVIEW_ACTIONS.required ||
        event.action === REVIEW_ACTIONS.approved ||
        event.action === REVIEW_ACTIONS.rejected,
    )
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  if (relevant.length === 0) return 'NOT_REQUIRED';

  const last = relevant[relevant.length - 1];
  if (last.action === REVIEW_ACTIONS.approved) return 'APPROVED';
  if (last.action === REVIEW_ACTIONS.rejected) return 'REJECTED';
  return 'PENDING';
}

export interface RecoveryReviewStatus {
  caseId: string;
  state: HighValueReviewState;
  threshold: string;
  lastEventAt: Date | null;
  lastActorUserId: string | null;
}

/**
 * R4 CHANGE B（MSG-20260930-20）：案件生命周期事件的**锁内单调时间**。
 * 事件时间在案件锁内生成；若同一毫秒已有更晚/相同的事件，则顺延 1ms，
 * 从而保证同案件内 required/approved/rejected 的 createdAt **严格递增**，
 * 事务内外的 < / > 顺序判断都有确定语义（不假设毫秒时间必然唯一）。
 */
export function nextLifecycleAt(events: Array<{ createdAt: Date }>, now: () => Date = () => new Date()): Date {
  const candidate = now();
  let latest = 0;
  for (const event of events) {
    const time = event.createdAt instanceof Date ? event.createdAt.getTime() : new Date(event.createdAt).getTime();
    if (Number.isFinite(time) && time > latest) latest = time;
  }
  return latest >= candidate.getTime() ? new Date(latest + 1) : candidate;
}
/** 审计读取器：既接受 PrismaClient，也接受事务客户端（R3：锁内重读状态） */
type ReviewAuditReader = { auditLog: Prisma.TransactionClient['auditLog'] };

async function loadEvents(
  client: ReviewAuditReader,
  organizationId: string,
  caseId: string,
): Promise<ReviewEvent[]> {
  const rows = await client.auditLog.findMany({
    where: {
      organizationId,
      entityType: 'Case',
      entityId: caseId,
      action: { in: [REVIEW_ACTIONS.required, REVIEW_ACTIONS.approved, REVIEW_ACTIONS.rejected] },
    },
    orderBy: { createdAt: 'asc' },
    select: { action: true, createdAt: true, actorUserId: true, changes: true },
  });
  return rows;
}

export async function getRecoveryReviewStatus(
  prisma: PrismaClient,
  actor: { organizationId: string; role: string },
  caseId: string,
): Promise<RecoveryReviewStatus> {
  assertPermission(actor.role, 'viewClaimAmounts');

  const kase = await prisma.case.findFirst({
    where: { id: caseId, organizationId: actor.organizationId },
    select: { id: true },
  });
  if (!kase) {
    throw new WorkflowError('NOT_FOUND', `案件 ${caseId} 不存在或不属于该租户`);
  }

  const events = await loadEvents(prisma, actor.organizationId, caseId);
  const last = events.length > 0 ? events[events.length - 1] : null;
  return {
    caseId: kase.id,
    state: resolveHighValueReviewState(events),
    threshold: resolveHighValueThreshold(),
    lastEventAt: last?.createdAt ?? null,
    lastActorUserId: last?.actorUserId ?? null,
  };
}

/**
 * 服务端额外绑定键规范化（R44-A）：仅保留字符串与 null，裁剪空白；
 * 用于把五元 basis 片段与 boundPayload 一起落库（客户端无法自证，恒由入口计算）。
 */
export function normalizeBoundExtra(raw?: Record<string, unknown>): Record<string, string | null> | null {
  if (!raw || typeof raw !== 'object') return null;
  const out: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string' && value.trim() !== '') out[key] = value.trim();
    else if (value === null) out[key] = null;
  }
  return Object.keys(out).length > 0 ? out : null;
}

export interface SubmitRecoveryReviewInput {
  organizationId: string;
  actorUserId: string;
  role: string;
  caseId: string;
  decision: unknown;
  reason?: unknown;
  recoveredAmount?: unknown;
  currency?: unknown;
  /** CHANGE A（MSG-20260930-17）：本次审批所授权的操作载荷，用于执行时逐项比对 */
  boundPayload?: {
    recoveredAmount?: unknown;
    currency?: unknown;
    basisReference?: unknown;
    evidenceArtifactId?: unknown;
  };
  /**
   * 服务端计算的操作额外绑定键（R44-A）：与 boundPayload 一起落库，执行时逐项比对。
   * 仅由服务端入口提供（客户端不得自证）；缺省不写。
   */
  boundExtra?: Record<string, unknown>;
  /** 审批有效期（毫秒）；缺省 24h */
  approvalTtlMs?: number;
  /** CHANGE A：本次审批授权的动作（由入口显式声明；缺省 commission.charge = 回收资金确认） */
  boundAction?: string;
}

export interface SubmitRecoveryReviewResult extends RecoveryReviewStatus {
  decision: 'REQUEST' | 'APPROVE' | 'REJECT';
  /** CHANGE A：APPROVE 时返回审批事件 id（即 approvalId）；其余为 null */
  approvalId?: string | null;
}

async function writeReviewAudit(
  tx: Prisma.TransactionClient,
  input: {
    organizationId: string;
    actorUserId: string;
    caseId: string;
    action: string;
      changes: Record<string, unknown>;
    at: Date;
  },
): Promise<string> {
  const row = prepareAuditInsert(
    {
      organizationId: input.organizationId,
      actorType: 'USER',
      actorUserId: input.actorUserId,
      action: input.action,
      entityType: 'Case',
      entityId: input.caseId,
      changes: input.changes,
    },
    { maxStringLength: 512 },
  );
  const created = await tx.auditLog.create({
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
    select: { id: true },
  });
  return created.id;
}

export async function submitRecoveryReview(
  prisma: PrismaClient,
  input: SubmitRecoveryReviewInput,
  now: () => Date = () => new Date(),
): Promise<SubmitRecoveryReviewResult> {
  const decision =
    typeof input.decision === 'string' ? input.decision.trim().toUpperCase() : '';
  if (decision !== 'REQUEST' && decision !== 'APPROVE' && decision !== 'REJECT') {
    throw new WorkflowError('INVALID_INPUT', 'decision 必须是 REQUEST / APPROVE / REJECT');
  }

  // Q3：发起可由 OWNER/ADMIN/FINANCE；审批只允许 OWNER/ADMIN（FINANCE 只读）
  if (decision === 'REQUEST') {
    assertPermission(input.role, 'advanceBilling');
  } else {
    assertPermission(input.role, 'setCommercialTerms');
    assertPermission(input.role, 'advanceBilling');
  }

  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (decision === 'REJECT' && reason === '') {
    throw new WorkflowError('REASON_REQUIRED', 'REJECT 必须给出 reason');
  }

  const kase = await prisma.case.findFirst({
    where: { id: input.caseId, organizationId: input.organizationId },
    select: { id: true, caseNo: true },
  });
  if (!kase) {
    throw new WorkflowError('NOT_FOUND', `案件 ${input.caseId} 不存在或不属于该租户`);
  }

  const threshold = resolveHighValueThreshold();

  return prisma.$transaction(async (tx) => {
    // R2 CHANGE B1：审批/重请求/拒绝与资金执行共用同一案件锁（串行化顺序一致）；
    // 单测的 fake tx 不实现 $executeRawUnsafe，仅在真实客户端上执行。
    if (typeof tx.$executeRawUnsafe === 'function') {
      await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', `cc-recovery-case:${kase.id}`);
    }
    const events = await tx.auditLog.findMany({
      where: {
        organizationId: input.organizationId,
        entityType: 'Case',
        entityId: kase.id,
        action: { in: [REVIEW_ACTIONS.required, REVIEW_ACTIONS.approved, REVIEW_ACTIONS.rejected] },
      },
      orderBy: { createdAt: 'asc' },
      select: { action: true, createdAt: true, actorUserId: true, changes: true },
    });
    const state = resolveHighValueReviewState(events);
    // R4 CHANGE B：事件时间在案件锁内生成；同案件内严格递增（不沿用锁前 at）
    const at = nextLifecycleAt(events, now);

    if (decision === 'REQUEST') {
      if (state === 'PENDING') {
        throw new WorkflowError('ILLEGAL_TRANSITION', '该案件已处于待审批状态');
      }
      await writeReviewAudit(tx, {
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        caseId: kase.id,
        action: REVIEW_ACTIONS.required,
        changes: {
          caseNo: kase.caseNo,
          threshold,
          ...(typeof input.recoveredAmount === 'string'
            ? { recoveredAmount: money(input.recoveredAmount) }
            : {}),
          ...(typeof input.currency === 'string' ? { currency: input.currency } : {}),
        },
        at,
      });
      return {
        caseId: kase.id,
        state: 'PENDING' as HighValueReviewState,
        threshold,
        lastEventAt: at,
        lastActorUserId: input.actorUserId,
        decision: 'REQUEST' as const,
      };
    }

    // APPROVE / REJECT 必须建立在"当前有待审批请求"之上（顺序不变量）
    if (state !== 'PENDING') {
      throw new WorkflowError(
        'ILLEGAL_TRANSITION',
        `当前状态 ${state} 不允许审批（必须先有待审批请求）`,
      );
    }

    const action = decision === 'APPROVE' ? REVIEW_ACTIONS.approved : REVIEW_ACTIONS.rejected;
    // CHANGE A（MSG-20260930-17）：审批必须绑定"本次操作"，而不是只表达案件状态。
    const bound = decision === 'APPROVE' ? normalizeBoundPayload(input.boundPayload) : null;
    if (decision === 'APPROVE') {
      // CHANGE A（R2）：缺金额/币种/依据的审批不得创建"看似可用"的 approvalId
      // ② R19 CHANGE C：载荷放宽**只限定本批次动作**（白名单），未知动作一律拒绝，
      // 不得把"非默认动作"整体当作非资金动作放行。
      const requestedAction =
        typeof input.boundAction === 'string' && input.boundAction.trim() !== ''
          ? input.boundAction.trim()
          : RECOVERY_CONFIRMATION_ACTION;
      if (!bound) throw new WorkflowError('INVALID_INPUT', '审批必须绑定操作载荷');
      if (requestedAction === RECOVERY_CONFIRMATION_ACTION) {
        if (bound.amount === null || bound.currency === null || bound.basisReference === null) {
          throw new WorkflowError('INVALID_INPUT', '审批必须绑定完整操作载荷（金额/币种/依据）');
        }
      } else if (
        (NON_MONEY_APPROVAL_ACTIONS as readonly string[]).includes(requestedAction) ||
        requestedAction === RECOVERY_MANUAL_SUBMIT_ACTION ||
        requestedAction === RECOVERY_MANUAL_REFERENCE_ACTION
      ) {
        // 非资金动作（claim.submit / appeal.submit）：无金额语义，但必须绑定操作依据；
        if (bound.basisReference === null) {
          throw new WorkflowError('INVALID_INPUT', '审批必须绑定操作依据（basisReference）');
        }
        if (requestedAction === RECOVERY_MANUAL_REFERENCE_ACTION) {
          // R44-B：reference 补录审批必须绑定 submissionId + claimItemId + providerCaseRefCanonical（canonical 恒服务端构造）
          const refExtra = normalizeBoundExtra(input.boundExtra);
          for (const key of ['submissionId', 'claimItemId', 'providerCaseRefCanonical']) {
            if (!refExtra || refExtra[key] === undefined || refExtra[key] === null || refExtra[key] === '') {
              throw new WorkflowError('INVALID_INPUT', 'reference 补录审批必须绑定：' + key);
            }
          }
        }
        if (requestedAction === RECOVERY_MANUAL_SUBMIT_ACTION) {
          // R44-A：人工提交审批必须绑定五元 versioned basis（与执行时核验逐项一致）
          const extra = normalizeBoundExtra(input.boundExtra);
          for (const key of ['claimItemId', 'caseId', 'packageVersion', 'digestVersion', 'packageDigest']) {
            if (!extra || extra[key] === undefined || extra[key] === null || extra[key] === '') {
              throw new WorkflowError('INVALID_INPUT', '人工提交审批必须绑定完整五元 basis：' + key);
            }
          }
        }
      } else {
        throw new WorkflowError('INVALID_INPUT', `审批动作不受支持：${requestedAction}`);
      }
      if (bound.fingerprintVersion !== 'v1') {
        throw new WorkflowError('INVALID_INPUT', '未知的审批载荷指纹版本');
      }
    }
    const boundExtra = decision === 'APPROVE' ? normalizeBoundExtra(input.boundExtra) : null;
    const ttlMs = normalizeApprovalTtl(input.approvalTtlMs);
    const expiresAt = decision === 'APPROVE' ? new Date(at.getTime() + ttlMs) : null;
    const approvalEventId = await writeReviewAudit(tx, {
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      caseId: kase.id,
      action,
      changes: {
        caseNo: kase.caseNo,
        threshold,
        ...(reason ? { reason } : {}),
        ...(bound
          ? {
              boundPayload: boundExtra ? { ...bound, ...boundExtra } : bound,
              expiresAt: expiresAt?.toISOString() ?? null,
              boundAction:
                typeof input.boundAction === 'string' && input.boundAction.trim() !== ''
                  ? input.boundAction.trim()
                  : RECOVERY_CONFIRMATION_ACTION,
            }
          : {}),
      },
      at,
    });

    return {
      caseId: kase.id,
      state: decision === 'APPROVE' ? ('APPROVED' as HighValueReviewState) : ('REJECTED' as HighValueReviewState),
      threshold,
      lastEventAt: at,
      lastActorUserId: input.actorUserId,
      decision: decision as 'APPROVE' | 'REJECT',
      approvalId: decision === 'APPROVE' ? approvalEventId : null,
    };
  });
}

/**
 * confirmRecoveryOutcome 使用的闸门：超阈值且未通过审批时，
 * 写一条 review_required 审计并抛 409 REVIEW_REQUIRED（不写任何资金记录）。
 */
export async function assertHighValueReviewCleared(
  prisma: PrismaClient,
  input: {
    organizationId: string;
    actorUserId: string;
    caseId: string;
    caseNo: string;
    recoveredAmount: InstanceType<typeof Prisma.Decimal>;
    currency: string;
  },
  now: () => Date = () => new Date(),
): Promise<void> {
  const threshold = resolveHighValueThreshold();
  const needsReview = requiresHighValueReview({
    recoveredAmount: input.recoveredAmount,
    currency: input.currency,
    threshold,
  });
  if (!needsReview) return;

  // 记录一次"需要复核"，供审批者处理（同一状态重复触发也各留一条，便于审计）。
  // R3 CHANGE B：**状态判定与写入都在案件锁内** —— 若在锁外判定，
  // 「刚通过审批」与「随后自动写入 review_required」可能交错，后者会取代前者（轮次不变量被破坏）。
  const cleared = await prisma.$transaction(async (tx) => {
    if (typeof tx.$executeRawUnsafe === 'function') {
      await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', `cc-recovery-case:${input.caseId}`);
    }
    const events = await loadEvents(tx, input.organizationId, input.caseId);
    const state = resolveHighValueReviewState(events);
    if (state === 'APPROVED') return true;
    // R4 CHANGE B：与显式审批同一规则：锁内生成、同案件严格递增
    const at = nextLifecycleAt(events, now);
      await writeReviewAudit(tx, {
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        caseId: input.caseId,
        action: REVIEW_ACTIONS.required,
        changes: {
          caseNo: input.caseNo,
          recoveredAmount: money(input.recoveredAmount),
          currency: input.currency,
          threshold,
          previousState: state,
        },
        at,
      });
    return false;
  });
  if (cleared) return;

  throw new WorkflowError(
    'REVIEW_REQUIRED',
    `金额 ${money(input.recoveredAmount)} ${input.currency} 超过高额阈值 ${threshold}，需要 OWNER/ADMIN 复核通过后才能确认回收`,
  );
}
