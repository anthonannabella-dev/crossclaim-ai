/**
 * NOTIFICATION — 只读投影（MSG-20260929-32 = GO_WITH_MINOR_REVISE / READY_FOR_IMPLEMENTATION）
 * ---------------------------------------------------------------
 * 依据 NOTIFICATION-DESIGN.md（R1）：
 *   · Notification = Projection：事实 → 本模块；**不成为事实源、不写库、不发外部渠道**
 *   · D1：N1–N5 启用；N6（overdue）默认关闭（属 N1 的升级语义）
 *   · D2：状态型「进入即通知」，幂等键含日期；v1 不做周期性提醒
 *   · D3：不落库未读状态、不新增表（无状态投影）
 *   · D4：允许**有限聚合摘要** —— 同租户 + 同事件 + 同权限范围 + 同时间窗口
 *   · 收件人：只可能是本租户成员；VIEWER 永不收件；不受众的事件记为 unroutable（可观测，不静默）
 *   · 裁剪：金额字段仅在收件人具备 viewBilling + recoveryPayoutRecord 时出现（否则键不存在）
 *
 * 本模块不接 Email / SMS / 企业微信，不发起任何对外联系，也不修改 Claim / Settlement / AuditLog。
 */

import type { PrismaClient } from '@prisma/client';

import { type PermissionMatrix, permissionsFor } from '../workflow/permissions';

export const NOTIFICATION_EVENTS = [
  'claim.deadline_approaching',
  'claim.response_received',
  'recovery.confirmation_required',
  'recovery.payout_discrepancy',
  'review.required_high_value',
  'claim.overdue',
] as const;
export type NotificationEventId = (typeof NOTIFICATION_EVENTS)[number];

export type NotificationSeverity = 'INFO' | 'HIGH' | 'CRITICAL';

export interface NotificationEventDefinition {
  id: NotificationEventId;
  severity: NotificationSeverity;
  /** 收件人必须具备的动作权限（复用既有矩阵，不新增权限键） */
  permission: keyof PermissionMatrix;
  /** 事件型 = 由字段跃迁/审计动作驱动；状态型 = 由投影评估（进入即通知） */
  mode: 'event' | 'state';
  /** 是否允许有限聚合摘要（D4） */
  aggregation: boolean;
  /** 是否默认启用（N6 默认关闭） */
  defaultEnabled: boolean;
  /** 事件载荷是否可能包含金额（需要追加 viewBilling + recoveryPayoutRecord） */
  amounts: boolean;
  /** 期望的人工作业（模板字段） */
  requiredAction: string;
}

export const EVENT_CATALOG: Record<NotificationEventId, NotificationEventDefinition> = {
  'claim.deadline_approaching': {
    id: 'claim.deadline_approaching',
    severity: 'HIGH',
    permission: 'claimTrackingApprove',
    mode: 'state',
    aggregation: true,
    defaultEnabled: true,
    amounts: false,
    requiredAction: '在截止前推进或关闭该 Claim',
  },
  'claim.response_received': {
    id: 'claim.response_received',
    severity: 'INFO',
    permission: 'claimTrackingReceive',
    mode: 'event',
    aggregation: false,
    defaultEnabled: true,
    amounts: false,
    requiredAction: '录入/核对平台回执并推进状态',
  },
  'recovery.confirmation_required': {
    id: 'recovery.confirmation_required',
    severity: 'HIGH',
    permission: 'claimTrackingApprove',
    mode: 'state',
    aggregation: false,
    defaultEnabled: true,
    amounts: false,
    requiredAction: '完成回收业务确认（CONFIRMED / REJECTED_BY_REVIEW）',
  },
  'recovery.payout_discrepancy': {
    id: 'recovery.payout_discrepancy',
    severity: 'CRITICAL',
    permission: 'recoveryPayoutRecord',
    mode: 'event',
    aggregation: false,
    defaultEnabled: true,
    amounts: true,
    requiredAction: '核对到账差异并交 FINANCE 处置（不自动改账）',
  },
  'review.required_high_value': {
    id: 'review.required_high_value',
    severity: 'HIGH',
    permission: 'claimTrackingApprove',
    mode: 'event',
    aggregation: false,
    defaultEnabled: true,
    amounts: true,
    requiredAction: '完成高额人工复核',
  },
  'claim.overdue': {
    id: 'claim.overdue',
    severity: 'CRITICAL',
    permission: 'claimTrackingApprove',
    mode: 'state',
    aggregation: false,
    defaultEnabled: false,
    amounts: false,
    requiredAction: '处置已逾期 Claim',
  },
};

// ---------------------------------------------------------------- 收件人（§3）

export interface MembershipRef {
  userId: string;
  role: string;
}

/** 收件人只可能是本租户成员；VIEWER / 未知角色 fail-closed 永不被选中 */
export function resolveRecipients(memberships: MembershipRef[], permission: keyof PermissionMatrix): MembershipRef[] {
  return memberships.filter((member) => permissionsFor(member.role)[permission]);
}

/** 是否可见金额（与看板/确认层同口径） */
export function canSeeAmounts(role: string | null | undefined): boolean {
  const permissions = permissionsFor(role);
  return permissions.viewBilling && permissions.recoveryPayoutRecord;
}

// ---------------------------------------------------------------- 幂等键（§2）

/**
 * 事件型：`<eventId>|<entityId>|<transition>`；状态型：`<eventId>|<entityId>|<bucketKey(UTC 日期)>`。
 * 同一键在 v1 只产生一条通知（进入即通知，不做周期提醒）。
 */
export function idempotencyKey(
  eventId: NotificationEventId,
  entityId: string,
  scope: string,
): string {
  return `${eventId}|${entityId}|${scope}`;
}

export function utcDayKey(at: Date): string {
  return at.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- 派生（纯函数）

export interface NotificationClaimFact {
  id: string;
  status: string;
  dueAt: Date | null;
  deadlineSource: string | null;
  respondedAt: Date | null;
}

export interface NotificationSettlementFact {
  id: string;
  confirmationStatus: string;
  reconciliationStatus: string;
  confirmedAmount?: string;
  receivedAmount?: string;
}

export interface NotificationAuditFact {
  action: string;
  entityType: string;
  entityId: string;
  createdAt: Date;
}

export interface DeriveNotificationsInput {
  now: Date;
  windowDays: number;
  memberships: MembershipRef[];
  claims: NotificationClaimFact[];
  settlements: NotificationSettlementFact[];
  auditEvents: NotificationAuditFact[];
  enabledEvents?: readonly NotificationEventId[];
}

export type NotificationVisibility = 'STANDARD' | 'WITH_AMOUNTS';

export interface DerivedNotification {
  eventId: NotificationEventId;
  severity: NotificationSeverity;
  title: string;
  body: string;
  entity: { type: string; id: string };
  deepLink: string;
  requiredAction: string;
  dueAt: string | null;
  generatedAt: string;
  idempotencyKey: string;
  visibility: NotificationVisibility;
  audienceUserIds: string[];
  /** 聚合摘要（D4）：仅同租户 + 同事件 + 同权限范围 + 同时间窗口 */
  aggregation?: { count: number; entityIds: string[] };
  /** 金额字段：仅 WITH_AMOUNTS 可见性存在 */
  amounts?: { confirmed: string; received: string; variance: string };
}

const OPEN_STATUSES = ['SUBMITTED', 'ACKNOWLEDGED'];
const REVIEW_ACTIONS = ['recovery.review_required', 'payment.review_required'];
const AGGREGATION_SAMPLE_LIMIT = 5;

function audienceSplit(
  memberships: MembershipRef[],
  definition: NotificationEventDefinition,
): Array<{ visibility: NotificationVisibility; userIds: string[] }> {
  const eligible = resolveRecipients(memberships, definition.permission);
  if (eligible.length === 0) return [];
  if (!definition.amounts) {
    return [{ visibility: 'STANDARD', userIds: eligible.map((member) => member.userId) }];
  }
  const withAmounts = eligible.filter((member) => canSeeAmounts(member.role));
  const standard = eligible.filter((member) => !canSeeAmounts(member.role));
  const split: Array<{ visibility: NotificationVisibility; userIds: string[] }> = [];
  if (withAmounts.length > 0) split.push({ visibility: 'WITH_AMOUNTS', userIds: withAmounts.map((m) => m.userId) });
  if (standard.length > 0) split.push({ visibility: 'STANDARD', userIds: standard.map((m) => m.userId) });
  return split;
}

function variance(confirmed: string | undefined, received: string | undefined): string {
  const toNumber = (value: string | undefined) => (value === undefined ? 0 : Number(value));
  return (toNumber(received) - toNumber(confirmed)).toFixed(4);
}

/**
 * 派生通知（纯函数）：不写库、不发起投递。
 * 返回数组中同一幂等键最多出现一次；无收件人的事件通过 `unroutable` 上报。
 */
export function deriveNotifications(input: DeriveNotificationsInput): {
  notifications: DerivedNotification[];
  unroutable: Array<{ eventId: NotificationEventId; entityId: string }>;
} {
  const enabled = new Set<NotificationEventId>(
    input.enabledEvents ?? NOTIFICATION_EVENTS.filter((id) => EVENT_CATALOG[id].defaultEnabled),
  );
  const notifications: DerivedNotification[] = [];
  const unroutable: Array<{ eventId: NotificationEventId; entityId: string }> = [];
  const seen = new Set<string>();
  const generatedAt = input.now.toISOString();
  const horizon = new Date(input.now.getTime() + input.windowDays * 86_400_000);
  const windowStart = new Date(input.now.getTime() - input.windowDays * 86_400_000);

  const push = (notification: DerivedNotification, _eventId: NotificationEventId, _entityId: string): void => {
    if (seen.has(notification.idempotencyKey)) return;
    seen.add(notification.idempotencyKey);
    notifications.push(notification);
  };

  // N1 deadline_approaching（状态型 + 允许聚合）
  const deadlineDefinition = EVENT_CATALOG['claim.deadline_approaching'];
  const deadlines: NotificationClaimFact[] = [];
  if (enabled.has('claim.deadline_approaching')) {
    for (const claim of input.claims) {
      const open = OPEN_STATUSES.includes(claim.status);
      const pending = claim.respondedAt === null;
      const due = claim.dueAt;
      if (!open || !pending || !due) continue;
      if (due.getTime() < input.now.getTime() || due.getTime() >= horizon.getTime()) continue;
      deadlines.push(claim);
    }
    const audiences = audienceSplit(input.memberships, deadlineDefinition);
    if (deadlines.length > 0 && audiences.length === 0) {
      for (const claim of deadlines) unroutable.push({ eventId: deadlineDefinition.id, entityId: claim.id });
    }
    for (const audience of audiences) {
      for (const claim of deadlines) {
        push(
          {
            eventId: deadlineDefinition.id,
            severity: deadlineDefinition.severity,
            title: 'Claim 截止临近',
            body: `Claim ${claim.id} 将于 ${claim.dueAt?.toISOString() ?? ''} 到期（来源 ${claim.deadlineSource ?? 'UNKNOWN'}）`,
            entity: { type: 'Claim', id: claim.id },
            deepLink: `/operations/claims?bucket=deadline_approaching`,
            requiredAction: deadlineDefinition.requiredAction,
            dueAt: claim.dueAt ? claim.dueAt.toISOString() : null,
            generatedAt,
            idempotencyKey: idempotencyKey(deadlineDefinition.id, claim.id, utcDayKey(input.now)),
            visibility: audience.visibility,
            audienceUserIds: audience.userIds,
          },
          deadlineDefinition.id,
          claim.id,
        );
      }
      if (deadlineDefinition.aggregation && deadlines.length > 1) {
        push(
          {
            eventId: deadlineDefinition.id,
            severity: deadlineDefinition.severity,
            title: `今日有 ${deadlines.length} 个 Claim 接近截止`,
            body: `聚合摘要（同租户 / 同事件 / 同权限范围 / 同时间窗口）：共 ${deadlines.length} 个`,
            entity: { type: 'Aggregate', id: `deadline_approaching:${utcDayKey(input.now)}` },
            deepLink: '/operations/claims?bucket=deadline_approaching',
            requiredAction: deadlineDefinition.requiredAction,
            dueAt: null,
            generatedAt,
            idempotencyKey: idempotencyKey(
              deadlineDefinition.id,
              `aggregate:${utcDayKey(input.now)}`,
              utcDayKey(input.now),
            ),
            visibility: audience.visibility,
            audienceUserIds: audience.userIds,
            aggregation: {
              count: deadlines.length,
              entityIds: deadlines.slice(0, AGGREGATION_SAMPLE_LIMIT).map((claim) => claim.id),
            },
          },
          deadlineDefinition.id,
          `aggregate:${utcDayKey(input.now)}`,
        );
      }
    }
  }

  // N2 response_received（事件型）
  const responseDefinition = EVENT_CATALOG['claim.response_received'];
  if (enabled.has('claim.response_received')) {
    const audiences = audienceSplit(input.memberships, responseDefinition);
    for (const claim of input.claims) {
      if (!claim.respondedAt) continue;
      if (claim.respondedAt.getTime() < windowStart.getTime() || claim.respondedAt.getTime() > input.now.getTime()) continue;
      if (audiences.length === 0) {
        unroutable.push({ eventId: responseDefinition.id, entityId: claim.id });
        continue;
      }
      for (const audience of audiences) {
        push(
          {
            eventId: responseDefinition.id,
            severity: responseDefinition.severity,
            title: '平台已回应 Claim',
            body: `Claim ${claim.id} 于 ${claim.respondedAt.toISOString()} 收到回应`,
            entity: { type: 'Claim', id: claim.id },
            deepLink: `/operations/claims?bucket=awaiting_response`,
            requiredAction: responseDefinition.requiredAction,
            dueAt: null,
            generatedAt,
            idempotencyKey: idempotencyKey(responseDefinition.id, claim.id, claim.respondedAt.toISOString()),
            visibility: audience.visibility,
            audienceUserIds: audience.userIds,
          },
          responseDefinition.id,
          claim.id,
        );
      }
    }
  }

  // N3 confirmation_required（状态型）
  const confirmationDefinition = EVENT_CATALOG['recovery.confirmation_required'];
  if (enabled.has('recovery.confirmation_required')) {
    const audiences = audienceSplit(input.memberships, confirmationDefinition);
    for (const settlement of input.settlements) {
      if (settlement.confirmationStatus !== 'PENDING_CONFIRMATION') continue;
      if (audiences.length === 0) {
        unroutable.push({ eventId: confirmationDefinition.id, entityId: settlement.id });
        continue;
      }
      for (const audience of audiences) {
        push(
          {
            eventId: confirmationDefinition.id,
            severity: confirmationDefinition.severity,
            title: '回收待业务确认',
            body: `Settlement ${settlement.id} 处于 PENDING_CONFIRMATION`,
            entity: { type: 'Settlement', id: settlement.id },
            deepLink: '/operations/recovery',
            requiredAction: confirmationDefinition.requiredAction,
            dueAt: null,
            generatedAt,
            idempotencyKey: idempotencyKey(confirmationDefinition.id, settlement.id, utcDayKey(input.now)),
            visibility: audience.visibility,
            audienceUserIds: audience.userIds,
          },
          confirmationDefinition.id,
          settlement.id,
        );
      }
    }
  }

  // N4 payout_discrepancy（事件型；金额仅 WITH_AMOUNTS 可见）
  const discrepancyDefinition = EVENT_CATALOG['recovery.payout_discrepancy'];
  if (enabled.has('recovery.payout_discrepancy')) {
    const audiences = audienceSplit(input.memberships, discrepancyDefinition);
    for (const settlement of input.settlements) {
      if (settlement.reconciliationStatus !== 'DISPUTED') continue;
      if (audiences.length === 0) {
        unroutable.push({ eventId: discrepancyDefinition.id, entityId: settlement.id });
        continue;
      }
      for (const audience of audiences) {
        push(
          {
            eventId: discrepancyDefinition.id,
            severity: discrepancyDefinition.severity,
            title: '到账与确认金额不符',
            body: `Settlement ${settlement.id} 处于 DISPUTED（不自动改账，请 FINANCE 处置）`,
            entity: { type: 'Settlement', id: settlement.id },
            deepLink: '/operations/recovery',
            requiredAction: discrepancyDefinition.requiredAction,
            dueAt: null,
            generatedAt,
            idempotencyKey: idempotencyKey(
              discrepancyDefinition.id,
              settlement.id,
              `DISPUTED:${utcDayKey(input.now)}`,
            ),
            visibility: audience.visibility,
            audienceUserIds: audience.userIds,
            ...(audience.visibility === 'WITH_AMOUNTS'
              ? {
                  amounts: {
                    confirmed: settlement.confirmedAmount ?? '0.0000',
                    received: settlement.receivedAmount ?? '0.0000',
                    variance: variance(settlement.confirmedAmount, settlement.receivedAmount),
                  },
                }
              : {}),
          },
          discrepancyDefinition.id,
          settlement.id,
        );
      }
    }
  }

  // N5 review.required_high_value（事件型，来源 = 既有复核审计动作）
  const reviewDefinition = EVENT_CATALOG['review.required_high_value'];
  if (enabled.has('review.required_high_value')) {
    const audiences = audienceSplit(input.memberships, reviewDefinition);
    for (const event of input.auditEvents) {
      if (!REVIEW_ACTIONS.includes(event.action)) continue;
      if (event.createdAt.getTime() < windowStart.getTime() || event.createdAt.getTime() > input.now.getTime()) continue;
      if (audiences.length === 0) {
        unroutable.push({ eventId: reviewDefinition.id, entityId: event.entityId });
        continue;
      }
      for (const audience of audiences) {
        push(
          {
            eventId: reviewDefinition.id,
            severity: reviewDefinition.severity,
            title: '高额需人工复核',
            body: `${event.entityType} ${event.entityId} 触发人工复核要求`,
            entity: { type: event.entityType, id: event.entityId },
            deepLink: '/operations/dashboard',
            requiredAction: reviewDefinition.requiredAction,
            dueAt: null,
            generatedAt,
            idempotencyKey: idempotencyKey(reviewDefinition.id, event.entityId, event.createdAt.toISOString()),
            visibility: audience.visibility,
            audienceUserIds: audience.userIds,
          },
          reviewDefinition.id,
          event.entityId,
        );
      }
    }
  }

  // N6 默认关闭：显式启用才评估（当前未实现派生，保持关闭语义）
  return { notifications, unroutable };
}

// ---------------------------------------------------------------- 读侧（真实库）

export interface NotificationProjectionDeps {
  prisma: PrismaClient;
  now?: () => Date;
  /** 租户级 Kill Switch（设计层要求；实现由调用方注入，关闭时不产生任何通知） */
  killSwitchEnabled?: boolean;
}

export interface NotificationBatch {
  generatedAt: string;
  windowDays: number;
  notifications: DerivedNotification[];
  unroutable: Array<{ eventId: NotificationEventId; entityId: string }>;
}

/**
 * 读取租户事实并派生通知（**只读**：不写 AuditLog、不改任何业务字段）。
 * 全部查询强制 organizationId 注入；无对外投递。
 */
export async function buildNotifications(
  deps: NotificationProjectionDeps,
  input: { organizationId: string; windowDays?: number; enabledEvents?: readonly NotificationEventId[] },
): Promise<NotificationBatch> {
  const at = (deps.now ?? (() => new Date()))();
  const windowDays = input.windowDays ?? 7;
  if (deps.killSwitchEnabled === false) {
    return { generatedAt: at.toISOString(), windowDays, notifications: [], unroutable: [] };
  }

  const [memberships, claims, settlements, payoutSums, auditEvents] = await Promise.all([
    deps.prisma.membership.findMany({
      where: { organizationId: input.organizationId, isActive: true },
      select: { userId: true, role: true },
    }),
    deps.prisma.claim.findMany({
      where: { organizationId: input.organizationId },
      select: { id: true, status: true, dueAt: true, deadlineSource: true, respondedAt: true },
    }),
    deps.prisma.settlement.findMany({
      where: { organizationId: input.organizationId },
      select: { id: true, amount: true, confirmationStatus: true, reconciliationStatus: true },
    }),
    deps.prisma.recoveryPayout.groupBy({
      by: ['settlementId'],
      where: { organizationId: input.organizationId },
      _sum: { amount: true },
    }),
    deps.prisma.auditLog.findMany({
      where: { organizationId: input.organizationId, action: { in: REVIEW_ACTIONS } },
      select: { action: true, entityType: true, entityId: true, createdAt: true },
    }),
  ]);

  const receivedBySettlement = new Map(payoutSums.map((row) => [row.settlementId, row._sum.amount ?? null]));
  const derived = deriveNotifications({
    now: at,
    windowDays,
    memberships,
    claims,
    settlements: settlements.map((row) => ({
      id: row.id,
      confirmationStatus: row.confirmationStatus,
      reconciliationStatus: row.reconciliationStatus,
      confirmedAmount: row.amount.toFixed(4),
      receivedAmount: (receivedBySettlement.get(row.id) ?? row.amount.minus(row.amount)).toFixed(4),
    })),
    auditEvents: auditEvents.map((row) => ({
      action: row.action,
      entityType: row.entityType ?? 'Unknown',
      entityId: row.entityId ?? '',
      createdAt: row.createdAt,
    })),
    ...(input.enabledEvents ? { enabledEvents: input.enabledEvents } : {}),
  });

  return {
    generatedAt: at.toISOString(),
    windowDays,
    notifications: derived.notifications,
    unroutable: derived.unroutable,
  };
}
