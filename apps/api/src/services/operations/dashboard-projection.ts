/**
 * OPERATIONS DASHBOARD — 只读投影（MSG-20260929-30 = PASS / READY_FOR_IMPLEMENTATION）
 * ---------------------------------------------------------------
 * 依据：OPERATIONS-DASHBOARD-DESIGN.md（R1）
 *   · Dashboard = Projection：业务事实 → AuditLog/Domain Data → 本模块；**永远不是写入口**
 *   · D1：待回执 = status ∈ {SUBMITTED, ACKNOWLEDGED} 且「无 response event」
 *         主判定 = Claim.respondedAt；AuditLog 响应事件作交叉校验（异常标注，不静默修复）
 *         判定只用既有字段/既有事件，不新增任何列
 *   · D2：v1 不做 Case 聚合（只做租户级汇总 + 桶明细）
 *   · D3：window 参数化（默认 7d，允许 1/7/14/30d，其余 INVALID_WINDOW）
 *   · 权限：字段级裁剪先于聚合；无权者响应中**不存在金额键**（不是 0）
 *
 * 本模块不写库、不发起对外请求、不执行任何自动动作；调用方负责传入已解析的租户与角色。
 */

import { Prisma, type PrismaClient } from '@prisma/client';

import { WorkflowError } from '../workflow/opportunity-review';
import { type PermissionMatrix, permissionsFor } from '../workflow/permissions';

// ---------------------------------------------------------------- 窗口（D3）

export const DASHBOARD_WINDOWS = ['1d', '7d', '14d', '30d'] as const;
export type DashboardWindow = (typeof DASHBOARD_WINDOWS)[number];
export const DEFAULT_DASHBOARD_WINDOW: DashboardWindow = '7d';
export const MAX_DASHBOARD_WINDOW_DAYS = 30;

export interface ParsedWindow {
  /** 原样回显给调用方的窗口标签（1d / 7d / 14d / 30d） */
  label: DashboardWindow;
  days: number;
  /** 评估时刻（= now） */
  to: Date;
  /** 到期临近的视野终点（= now + days），用于 `dueAt ∈ [now, now+W)` */
  horizonEnd: Date;
}

const WINDOW_DAYS: Record<DashboardWindow, number> = { '1d': 1, '7d': 7, '14d': 14, '30d': 30 };

/**
 * 解析 window 查询参数。缺省 → 7d；白名单外（含 31d / 3650 / 'abc'）→ INVALID_WINDOW。
 * 白名单 + 上限 30d 是 MSG-20260929-30 §三 的明确要求（禁止大扫描）。
 */
export function parseDashboardWindow(raw: unknown, now: Date): ParsedWindow {
  const label = raw === undefined || raw === null || raw === '' ? DEFAULT_DASHBOARD_WINDOW : String(raw);
  if (!(DASHBOARD_WINDOWS as readonly string[]).includes(label)) {
    throw new WorkflowError('INVALID_WINDOW', 'window 只允许 1d / 7d / 14d / 30d');
  }
  const key = label as DashboardWindow;
  const days = WINDOW_DAYS[key];
  if (days > MAX_DASHBOARD_WINDOW_DAYS) {
    throw new WorkflowError('INVALID_WINDOW', 'window 不得超过 30d');
  }
  return { label: key, days, to: now, horizonEnd: new Date(now.getTime() + days * 86_400_000) };
}

// ---------------------------------------------------------------- 桶定义（§1）

export const CLAIM_BUCKETS = [
  'draft',
  'awaiting_response',
  'deadline_approaching',
  'overdue',
  'approved',
  'partially_approved',
  'terminal',
] as const;
export type ClaimBucket = (typeof CLAIM_BUCKETS)[number];

const TERMINAL_CLAIM_STATUSES = ['REJECTED', 'NO_RESPONSE', 'WITHDRAWN'] as const;
const OPEN_CLAIM_STATUSES = ['SUBMITTED', 'ACKNOWLEDGED'] as const;

export interface ClaimProjectionRow {
  id: string;
  caseId: string;
  status: string;
  dueAt: Date | null;
  deadlineSource: string | null;
  respondedAt: Date | null;
  platformCaseRef: string | null;
  updatedAt: Date;
  /** AuditLog 交叉校验：该 Claim 是否存在响应类事件 */
  hasResponseEvent: boolean;
  /** 所属案件是否已完成商务确认（无费率不得进入回收链路） */
  caseHasCommercialTerms: boolean;
}

export interface ClaimRowProjection {
  /** 该行命中的所有桶（到期与回执是两个独立维度，可同时命中） */
  buckets: ClaimBucket[];
  /** 数据异常角标：dueAt 有值但无 deadlineSource（I1 违规）；或事件与字段不一致 */
  anomalies: string[];
}

/**
 * 单条 Claim 的桶归属（纯函数）。
 * D1：待回执只看 respondedAt（+ 事件交叉校验），**不看 dueAt**。
 */
export function projectClaimRow(row: ClaimProjectionRow, window: ParsedWindow): ClaimRowProjection {
  const buckets: ClaimBucket[] = [];
  const anomalies: string[] = [];

  const responded = row.respondedAt !== null || row.hasResponseEvent;
  if (row.respondedAt === null && row.hasResponseEvent) anomalies.push('RESPONSE_EVENT_WITHOUT_TIMESTAMP');
  if (row.dueAt !== null && row.deadlineSource === null) anomalies.push('DEADLINE_WITHOUT_SOURCE');

  const isOpen = (OPEN_CLAIM_STATUSES as readonly string[]).includes(row.status);
  const isTerminal = (TERMINAL_CLAIM_STATUSES as readonly string[]).includes(row.status);

  if (row.status === 'DRAFT') {
    // 只在已完成商务确认的案件上计数（无费率不得进入回收链路）
    if (row.caseHasCommercialTerms) buckets.push('draft');
  }
  if (isOpen && !responded) buckets.push('awaiting_response');
  if (isOpen && row.dueAt !== null) {
    const due = row.dueAt.getTime();
    // 到期临近 / 已逾期都只看 dueAt（与「待回执」完全独立的维度）
    if (due >= window.to.getTime() && due < window.horizonEnd.getTime()) buckets.push('deadline_approaching');
    if (due < window.to.getTime()) buckets.push('overdue');
  }
  if (row.status === 'APPROVED') buckets.push('approved');
  if (row.status === 'PARTIALLY_APPROVED') buckets.push('partially_approved');
  if (isTerminal) buckets.push('terminal');

  // 终局不得停留在开放桶（I5）；出现即标注异常，不静默计入
  if (isTerminal && (buckets.includes('awaiting_response') || buckets.includes('overdue'))) {
    anomalies.push('TERMINAL_IN_OPEN_BUCKET');
  }

  return { buckets, anomalies };
}

export interface ClaimBucketSummary {
  bucket: ClaimBucket;
  count: number;
  /** 该桶中带数据异常角标的行数（不阻断展示，但必须可见） */
  anomalyCount: number;
}

export function composeClaimBuckets(
  rows: ClaimProjectionRow[],
  window: ParsedWindow,
): { buckets: ClaimBucketSummary[]; anomalyTotal: number } {
  const counts = new Map<ClaimBucket, number>(CLAIM_BUCKETS.map((bucket) => [bucket, 0]));
  const anomalyCounts = new Map<ClaimBucket, number>(CLAIM_BUCKETS.map((bucket) => [bucket, 0]));
  let anomalyTotal = 0;

  for (const row of rows) {
    const projection = projectClaimRow(row, window);
    if (projection.anomalies.length > 0) anomalyTotal += 1;
    for (const bucket of projection.buckets) {
      counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
      if (projection.anomalies.length > 0) {
        anomalyCounts.set(bucket, (anomalyCounts.get(bucket) ?? 0) + 1);
      }
    }
  }

  return {
    buckets: CLAIM_BUCKETS.map((bucket) => ({
      bucket,
      count: counts.get(bucket) ?? 0,
      anomalyCount: anomalyCounts.get(bucket) ?? 0,
    })),
    anomalyTotal,
  };
}

// ---------------------------------------------------------------- Loss pool（§1.3）

export const CLAIM_ITEM_GROUPS = ['pending_verification', 'needs_review', 'ready_to_appeal', 'submitted_manual', 'recovered', 'closed'] as const;
export type ClaimItemGroup = (typeof CLAIM_ITEM_GROUPS)[number];

export function claimItemGroupOf(status: string): ClaimItemGroup | null {
  switch (status) {
    case 'DISCOVERED':
      return 'pending_verification';
    case 'REVIEW_REQUIRED':
      return 'needs_review';
    case 'READY_TO_APPEAL':
    case 'VERIFIED':
      return 'ready_to_appeal';
    case 'SUBMITTED_MANUAL':
      return 'submitted_manual';
    case 'RECOVERED':
      return 'recovered';
    case 'CLOSED':
      return 'closed';
    default:
      return null;
  }
}

export function composeLossPool(statuses: string[]): Array<{ group: ClaimItemGroup; count: number }> {
  const counts = new Map<ClaimItemGroup, number>(CLAIM_ITEM_GROUPS.map((group) => [group, 0]));
  for (const status of statuses) {
    const group = claimItemGroupOf(status);
    if (group) counts.set(group, (counts.get(group) ?? 0) + 1);
  }
  return CLAIM_ITEM_GROUPS.map((group) => ({ group, count: counts.get(group) ?? 0 }));
}

// ---------------------------------------------------------------- Recovery（§1.2）

export interface SettlementProjectionRow {
  confirmationStatus: string;
  reconciliationStatus: string;
  amount: string | InstanceType<typeof Prisma.Decimal>;
  /** 该 Settlement 的到账投影（Σ payouts），由调用方用已批准投影计算 */
  receivedAmount: string | InstanceType<typeof Prisma.Decimal>;
}

export interface RecoveryMetrics {
  confirmation: { confirmed: number; pending: number; rejectedByReview: number };
  reconciliation: {
    notStarted: number;
    partial: number;
    reconciled: number;
    disputed: number;
    reversed: number;
  };
  /** 仅在具备金额权限时存在（否则整个键缺失） */
  amounts?: {
    confirmedTotal: string;
    receivedTotal: string;
    outstandingTotal: string;
    varianceTotal: string;
  };
}

const MONEY_SCALE = 4;
const decimal = (value: string | InstanceType<typeof Prisma.Decimal>): InstanceType<typeof Prisma.Decimal> =>
  new Prisma.Decimal(value).toDecimalPlaces(MONEY_SCALE, Prisma.Decimal.ROUND_HALF_UP);

/**
 * 汇总 Recovery。金额部分仅在 `includeAmounts` 为 true 时计算并输出
 * —— 这是「金额裁剪先于聚合」的落点：无权者的响应里根本不存在这些数，
 * 也不可能通过 total / count / average 反推（MSG-20260929-30 §七.2）。
 */
export function composeRecoveryMetrics(
  rows: SettlementProjectionRow[],
  includeAmounts: boolean,
): RecoveryMetrics {
  const confirmation = { confirmed: 0, pending: 0, rejectedByReview: 0 };
  const reconciliation = { notStarted: 0, partial: 0, reconciled: 0, disputed: 0, reversed: 0 };

  for (const row of rows) {
    if (row.confirmationStatus === 'CONFIRMED') confirmation.confirmed += 1;
    else if (row.confirmationStatus === 'PENDING_CONFIRMATION') confirmation.pending += 1;
    else if (row.confirmationStatus === 'REJECTED_BY_REVIEW') confirmation.rejectedByReview += 1;

    if (row.reconciliationStatus === 'NOT_STARTED') reconciliation.notStarted += 1;
    else if (row.reconciliationStatus === 'PARTIAL') reconciliation.partial += 1;
    else if (row.reconciliationStatus === 'RECONCILED') reconciliation.reconciled += 1;
    else if (row.reconciliationStatus === 'DISPUTED') reconciliation.disputed += 1;
    else if (row.reconciliationStatus === 'REVERSED') reconciliation.reversed += 1;
  }

  if (!includeAmounts) return { confirmation, reconciliation };

  let confirmed = new Prisma.Decimal(0);
  let received = new Prisma.Decimal(0);
  let outstanding = new Prisma.Decimal(0);
  for (const row of rows) {
    if (row.confirmationStatus !== 'CONFIRMED') continue;
    const confirmedAmount = decimal(row.amount);
    const receivedAmount = decimal(row.receivedAmount);
    confirmed = confirmed.plus(confirmedAmount);
    received = received.plus(receivedAmount);
    const gap = confirmedAmount.minus(receivedAmount);
    if (gap.gt(0)) outstanding = outstanding.plus(gap);
  }
  return {
    confirmation,
    reconciliation,
    amounts: {
      confirmedTotal: confirmed.toFixed(MONEY_SCALE),
      receivedTotal: received.toFixed(MONEY_SCALE),
      outstandingTotal: outstanding.toFixed(MONEY_SCALE),
      varianceTotal: received.minus(confirmed).toFixed(MONEY_SCALE),
    },
  };
}

// ---------------------------------------------------------------- 角色可见性（§3）

export interface DashboardVisibility {
  /** 能否看到 Claim 管线（状态计数） */
  claimPipeline: boolean;
  /** 能否看到 Claim 文本 */
  claimText: boolean;
  /** 能否看到 Claim 金额 */
  claimAmounts: boolean;
  /** 能否看到 Recovery 计数/状态 */
  recoveryCounts: boolean;
  /** 能否看到 Recovery 金额（Confirmed / Received / Outstanding / Variance） */
  recoveryAmounts: boolean;
  /** 能否看到 Loss Pool 汇总 */
  lossPool: boolean;
}

export function dashboardVisibilityFor(role: string | null | undefined): DashboardVisibility {
  const p: PermissionMatrix = permissionsFor(role);
  return {
    claimPipeline: p.claimTrackingApprove || p.claimTrackingReceive,
    claimText: p.viewClaimText,
    claimAmounts: p.viewClaimAmounts,
    recoveryCounts: p.claimTrackingApprove,
    recoveryAmounts: p.viewBilling && p.recoveryPayoutRecord,
    lossPool: p.viewClaimItemSummary,
  };
}

// ---------------------------------------------------------------- 汇总装配

export interface DashboardPayload {
  generatedAt: string;
  window: { label: DashboardWindow; days: number; to: string; horizonEnd: string };
  claimPipeline: { buckets: ClaimBucketSummary[]; anomalyTotal: number } | null;
  recovery: RecoveryMetrics | null;
  lossPool: Array<{ group: ClaimItemGroup; count: number }> | null;
  /** 该角色无权访问的区块名（显式列出，便于前端隐藏而不是显示 0） */
  denied: string[];
}

export function composeDashboard(input: {
  now: Date;
  window: ParsedWindow;
  visibility: DashboardVisibility;
  claims: ClaimProjectionRow[];
  claimItemStatuses: string[];
  settlements: SettlementProjectionRow[];
}): DashboardPayload {
  const denied: string[] = [];

  let claimPipeline: DashboardPayload['claimPipeline'] = null;
  if (input.visibility.claimPipeline) {
    claimPipeline = composeClaimBuckets(input.claims, input.window);
  } else {
    denied.push('claimPipeline');
  }

  let recovery: DashboardPayload['recovery'] = null;
  if (input.visibility.recoveryCounts) {
    recovery = composeRecoveryMetrics(input.settlements, input.visibility.recoveryAmounts);
  } else {
    denied.push('recovery');
  }

  let lossPool: DashboardPayload['lossPool'] = null;
  if (input.visibility.lossPool) {
    lossPool = composeLossPool(input.claimItemStatuses);
  } else {
    denied.push('lossPool');
  }

  return {
    generatedAt: input.now.toISOString(),
    window: {
      label: input.window.label,
      days: input.window.days,
      to: input.window.to.toISOString(),
      horizonEnd: input.window.horizonEnd.toISOString(),
    },
    claimPipeline,
    recovery,
    lossPool,
    denied,
  };
}

// ---------------------------------------------------------------- 读侧（真实库）

export interface OperationsDashboardDeps {
  prisma: PrismaClient;
  now?: () => Date;
}

const RESPONSE_EVENT_ACTIONS = ['claim.response_recorded', 'claim.terminal_recorded'] as const;

/**
 * 读取租户级汇总（只读）。所有查询强制 organizationId 注入。
 * 不写 AuditLog（读取不是状态变更）。
 */
export async function buildOperationsDashboard(
  deps: OperationsDashboardDeps,
  input: { organizationId: string; role: string | null | undefined; window?: unknown },
): Promise<DashboardPayload> {
  const at = (deps.now ?? (() => new Date()))();
  const window = parseDashboardWindow(input.window, at);
  const visibility = dashboardVisibilityFor(input.role);

  if (!visibility.claimPipeline && !visibility.recoveryCounts && !visibility.lossPool) {
    // 三块都不可见：直接 403（fail-closed，且不触库）
    throw new WorkflowError('FORBIDDEN', '当前角色无权访问运营看板');
  }

  const claims = visibility.claimPipeline
    ? await deps.prisma.claim.findMany({
        where: { organizationId: input.organizationId, round: 1 },
        select: {
          id: true,
          caseId: true,
          status: true,
          dueAt: true,
          deadlineSource: true,
          respondedAt: true,
          platformCaseRef: true,
          updatedAt: true,
        },
      })
    : [];

  const [commercialTermCases, responseEvents] = visibility.claimPipeline
    ? await Promise.all([
        deps.prisma.auditLog.findMany({
          where: {
            organizationId: input.organizationId,
            entityType: 'Case',
            action: 'commercial_terms.created',
          },
          select: { entityId: true },
        }),
        deps.prisma.auditLog.findMany({
          where: {
            organizationId: input.organizationId,
            entityType: 'Claim',
            action: { in: RESPONSE_EVENT_ACTIONS as unknown as string[] },
          },
          select: { entityId: true },
        }),
      ])
    : [[], []];

  const termsSet = new Set(commercialTermCases.map((row) => row.entityId ?? ''));
  const responseSet = new Set(responseEvents.map((row) => row.entityId ?? ''));

  const claimRows: ClaimProjectionRow[] = claims.map((row) => ({
    id: row.id,
    caseId: row.caseId,
    status: row.status,
    dueAt: row.dueAt,
    deadlineSource: row.deadlineSource,
    respondedAt: row.respondedAt,
    platformCaseRef: row.platformCaseRef,
    updatedAt: row.updatedAt,
    hasResponseEvent: responseSet.has(row.id),
    caseHasCommercialTerms: termsSet.has(row.caseId),
  }));

  const claimItemStatuses = visibility.lossPool
    ? (
        await deps.prisma.claimItem.findMany({
          where: { organizationId: input.organizationId },
          select: { status: true },
        })
      ).map((row) => row.status)
    : [];

  let settlements: SettlementProjectionRow[] = [];
  if (visibility.recoveryCounts) {
    const [settlementRows, payoutRows] = await Promise.all([
      deps.prisma.settlement.findMany({
        where: { organizationId: input.organizationId },
        select: { id: true, amount: true, confirmationStatus: true, reconciliationStatus: true },
      }),
      deps.prisma.recoveryPayout.groupBy({
        by: ['settlementId'],
        where: { organizationId: input.organizationId },
        _sum: { amount: true },
      }),
    ]);
    const receivedBySettlement = new Map(
      payoutRows.map((row) => [row.settlementId, row._sum.amount ?? new Prisma.Decimal(0)]),
    );
    settlements = settlementRows.map((row) => ({
      confirmationStatus: row.confirmationStatus,
      reconciliationStatus: row.reconciliationStatus,
      amount: row.amount,
      receivedAmount: receivedBySettlement.get(row.id) ?? new Prisma.Decimal(0),
    }));
  }

  return composeDashboard({
    now: at,
    window,
    visibility,
    claims: claimRows,
    claimItemStatuses,
    settlements,
  });
}
