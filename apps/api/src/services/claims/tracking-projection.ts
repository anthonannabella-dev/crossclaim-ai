/**
 * CLAIM TRACKING — 只读投影与不变量（DESIGN 已获准：MSG-20260929-21 / Schema S1-S5：MSG-20260929-23）
 * ---------------------------------------------------------------
 * 本模块**只做纯计算**：时间轴投影、不变量校验、到期清单。
 * 不写库、不判权限、不做任何对外动作（提交仍为 FORBIDDEN）。
 *
 * 设计依据（CLAIM-TRACKING-DESIGN.md）：
 *   · 时间轴不新增核心表，由 AuditLog + Claim 字段 + 交付物状态合成；
 *   · 不变量 I1–I5 由服务层保证；
 *   · 到期看板由 (organizationId, status, dueAt) 索引支撑。
 */

export type ClaimStatus =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'ACKNOWLEDGED'
  | 'APPROVED'
  | 'PARTIALLY_APPROVED'
  | 'REJECTED'
  | 'NO_RESPONSE'
  | 'WITHDRAWN';

export type DeadlineSource = 'PLATFORM_NOTICE' | 'USER_INPUT' | 'CONTRACT' | 'UNKNOWN';

export type TerminalReasonCode =
  | 'PLATFORM_DECISION'
  | 'DEADLINE_MISSED'
  | 'INSUFFICIENT_EVIDENCE'
  | 'WITHDRAWN_BY_SELLER'
  | 'DUPLICATE_CLAIM'
  | 'OTHER';

export const TERMINAL_STATUSES: readonly ClaimStatus[] = [
  'APPROVED',
  'PARTIALLY_APPROVED',
  'REJECTED',
  'NO_RESPONSE',
  'WITHDRAWN',
];

/** 与设计 §3 一致：只有这两个终局态允许进入回收确认 */
export const RECOVERY_ELIGIBLE_STATUSES: readonly ClaimStatus[] = ['APPROVED', 'PARTIALLY_APPROVED'];

export interface ClaimProjectionInput {
  id: string;
  organizationId: string;
  caseId: string;
  round: number;
  status: ClaimStatus;
  target: string;
  dueAt: Date | null;
  deadlineSource: DeadlineSource | null;
  submittedAt: Date | null;
  submittedBy: string | null;
  acknowledgedAt?: Date | null;
  respondedAt: Date | null;
  responseAmount: string | null;
  platformCaseRef: string | null;
  approvedByUserId: string | null;
  approvedAt: Date | null;
  terminalReasonCode: TerminalReasonCode | null;
}

export interface ClaimTimelineEntry {
  at: string;
  kind: string;
  actor: string | null;
  from: string | null;
  to: string | null;
  ref: string | null;
}

export interface InvariantViolation {
  code: string;
  detail: string;
}

function toIso(value: Date | null | undefined): string | null {
  return value ? new Date(value).toISOString() : null;
}

/**
 * 时间轴投影：AuditLog 是权威来源（同一事务写入），Claim 字段用于补齐历史
 * （引入这些字段之前的历史行没有对应审计事件）。
 */
export function buildClaimTimeline(
  claim: ClaimProjectionInput,
  audits: Array<{ at: Date; action: string; actorUserId: string | null; from?: string | null; to?: string | null; ref?: string | null }>,
): ClaimTimelineEntry[] {
  const entries: ClaimTimelineEntry[] = audits.map((entry) => ({
    at: new Date(entry.at).toISOString(),
    kind: entry.action,
    actor: entry.actorUserId,
    from: entry.from ?? null,
    to: entry.to ?? null,
    ref: entry.ref ?? null,
  }));

  const derived: Array<ClaimTimelineEntry | null> = [
    claim.submittedAt
      ? {
          at: toIso(claim.submittedAt) as string,
          kind: 'claim.submitted',
          actor: claim.submittedBy,
          from: 'DRAFT',
          to: 'SUBMITTED',
          ref: null,
        }
      : null,
    claim.approvedAt
      ? {
          at: toIso(claim.approvedAt) as string,
          kind: 'claim.approved_by_human',
          actor: claim.approvedByUserId,
          from: null,
          to: null,
          ref: null,
        }
      : null,
    claim.platformCaseRef
      ? {
          at: toIso(claim.respondedAt ?? claim.acknowledgedAt ?? claim.submittedAt) as string,
          kind: 'claim.platform_case_ref_recorded',
          actor: null,
          from: null,
          to: null,
          ref: claim.platformCaseRef,
        }
      : null,
    claim.respondedAt
      ? {
          at: toIso(claim.respondedAt) as string,
          kind: 'claim.response_recorded',
          actor: null,
          from: null,
          to: claim.status,
          ref: claim.responseAmount,
        }
      : null,
  ];

  const known = new Set(entries.map((entry) => entry.kind + '|' + entry.at));
  for (const entry of derived) {
    if (!entry) continue;
    if (known.has(entry.kind + '|' + entry.at)) continue;
    entries.push(entry);
  }

  return entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

/** 不变量 I1–I5（设计 §3 与 Delta §2） */
export function checkClaimInvariants(claim: ClaimProjectionInput): InvariantViolation[] {
  const violations: InvariantViolation[] = [];

  // I1：有 dueAt 必须有来源
  if (claim.dueAt && !claim.deadlineSource) {
    violations.push({ code: 'I1_DEADLINE_SOURCE_MISSING', detail: 'dueAt 存在但 deadlineSource 为空' });
  }
  if (!claim.dueAt && claim.deadlineSource && claim.deadlineSource !== 'UNKNOWN') {
    violations.push({
      code: 'I1_DEADLINE_WITHOUT_DATE',
      detail: 'deadlineSource 已给出但 dueAt 为空（除 UNKNOWN 外表示信息丢失）',
    });
  }

  // I2：终局为 APPROVED/PARTIALLY_APPROVED 必须有批准留痕
  if (RECOVERY_ELIGIBLE_STATUSES.includes(claim.status) && (!claim.approvedByUserId || !claim.approvedAt)) {
    violations.push({
      code: 'I2_TERMINAL_WITHOUT_APPROVAL',
      detail: claim.status + ' 缺少人工批准留痕（approvedByUserId/approvedAt）',
    });
  }

  // I3：PARTIALLY_APPROVED 必须有 responseAmount
  if (claim.status === 'PARTIALLY_APPROVED' && !claim.responseAmount) {
    violations.push({
      code: 'I3_PARTIAL_WITHOUT_AMOUNT',
      detail: 'PARTIALLY_APPROVED 缺少 responseAmount',
    });
  }

  // I4：终局原因只能出现在终局态
  if (claim.terminalReasonCode && !TERMINAL_STATUSES.includes(claim.status)) {
    violations.push({
      code: 'I4_REASON_ON_NON_TERMINAL',
      detail: 'terminalReasonCode 只允许出现在终局态',
    });
  }

  // I5：终局态不得再有未消费的截止时间
  if (TERMINAL_STATUSES.includes(claim.status) && claim.dueAt) {
    violations.push({
      code: 'I5_TERMINAL_WITH_OPEN_DEADLINE',
      detail: '终局态仍保留 dueAt（可能导致错误的到期提醒）',
    });
  }

  return violations;
}

/** 是否允许进入回收确认（设计 §3 规则 6） */
export function canEnterRecoveryOutcome(claim: ClaimProjectionInput): boolean {
  if (!RECOVERY_ELIGIBLE_STATUSES.includes(claim.status)) return false;
  if (claim.status === 'PARTIALLY_APPROVED') return claim.responseAmount !== null && claim.responseAmount !== '';
  return true;
}

/** 到期清单（供 Dashboard / Notifications 复用；不判定胜败，只做时间投影） */
export function listExpiringClaims(
  claims: ClaimProjectionInput[],
  options: { now: Date; withinDays: number },
): Array<{ claimId: string; caseId: string; status: ClaimStatus; dueAt: string; daysLeft: number }> {
  const nowMs = options.now.getTime();
  const horizonMs = options.withinDays * 24 * 60 * 60 * 1000;

  return claims
    .filter((claim) => claim.dueAt !== null && !TERMINAL_STATUSES.includes(claim.status))
    .map((claim) => {
      const dueMs = new Date(claim.dueAt as Date).getTime();
      return {
        claimId: claim.id,
        caseId: claim.caseId,
        status: claim.status,
        dueAt: new Date(dueMs).toISOString(),
        daysLeft: Math.ceil((dueMs - nowMs) / (24 * 60 * 60 * 1000)),
      };
    })
    .filter((item) => new Date(item.dueAt).getTime() - nowMs <= horizonMs)
    .sort((a, b) => (a.dueAt < b.dueAt ? -1 : a.dueAt > b.dueAt ? 1 : 0));
}
