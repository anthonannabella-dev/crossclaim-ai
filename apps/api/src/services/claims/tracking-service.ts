/**
 * CLAIM TRACKING — 写路径（DESIGN GO：MSG-20260929-21；权限位 GO：MSG-20260929-25 A1）
 * ---------------------------------------------------------------
 * 四个动作，全部：CAS 状态迁移 + 不变量校验 + 审计留痕 + 权限 fail-closed。
 *
 *   recordSubmission       DRAFT → SUBMITTED（人工批准证据：approvedByUserId/approvedAt）
 *   recordAcknowledgement  SUBMITTED → ACKNOWLEDGED（平台案件号，按 (org, ref) 幂等）
 *   setDeadline            dueAt + deadlineSource（I1：无来源不得有日期）
 *   recordTerminal         终局态 + 终局原因（I2/I3/I5）
 *
 * 明确不做：不轮询平台、不自动判胜负、不生成文本、不对外提交（FORBIDDEN）、不碰资金。
 */

import type { PrismaClient } from '@prisma/client';

import type { AuditWriter } from '../audit';
import { WorkflowError } from '../workflow/opportunity-review';
import { assertPermission } from '../workflow/permissions';

export type ClaimTrackingAction = 'record_submission' | 'record_acknowledgement' | 'set_deadline' | 'record_terminal';

export const CLAIM_TRACKING_ACTION = {
  submission: 'claim.submitted_by_human',
  acknowledgement: 'claim.platform_case_ref_recorded',
  deadline: 'claim.deadline_recorded',
  terminal: 'claim.terminal_recorded',
} as const;

export interface ClaimTrackingDeps {
  prisma: PrismaClient;
  audit: AuditWriter;
  now?: () => Date;
}

export interface ActorInput {
  organizationId: string;
  claimId: string;
  actorUserId: string;
  role: string;
}

const PERMISSION_FOR_ACTION: Record<ClaimTrackingAction, 'claimTrackingApprove' | 'claimTrackingReceive'> = {
  record_submission: 'claimTrackingApprove',
  record_acknowledgement: 'claimTrackingReceive',
  set_deadline: 'claimTrackingApprove',
  record_terminal: 'claimTrackingApprove',
};

function authorize(role: string, action: ClaimTrackingAction): void {
  assertPermission(role, PERMISSION_FOR_ACTION[action]);
}

async function loadClaim(deps: ClaimTrackingDeps, organizationId: string, claimId: string) {
  const claim = await deps.prisma.claim.findFirst({
    where: { id: claimId, organizationId },
    select: {
      id: true,
      organizationId: true,
      caseId: true,
      status: true,
      dueAt: true,
      deadlineSource: true,
      platformCaseRef: true,
      responseAmount: true,
    },
  });
  if (!claim) throw new WorkflowError('NOT_FOUND', 'Claim 不存在或不属于该租户');
  return claim;
}

/** CAS：只有仍在 expectedFrom 时才能迁移；否则返回稳定错误码（不覆盖并发结果） */
async function casTransition(
  deps: ClaimTrackingDeps,
  organizationId: string,
  claimId: string,
  expectedFrom: string[],
  data: Record<string, unknown>,
): Promise<void> {
  const result = await deps.prisma.claim.updateMany({
    where: { id: claimId, organizationId, status: { in: expectedFrom as never } },
    data: data as never,
  });
  if (result.count === 0) {
    throw new WorkflowError('ILLEGAL_TRANSITION', 'Claim 状态已变化，请刷新后重试');
  }
}

/** DRAFT → SUBMITTED：人工批准（AI Prepare → Human Approve → Submit 的第二段） */
export async function recordSubmission(
  input: ActorInput & { note?: string },
  deps: ClaimTrackingDeps,
): Promise<{ claimId: string; status: 'SUBMITTED'; approvedAt: string }> {
  authorize(input.role, 'record_submission');
  const claim = await loadClaim(deps, input.organizationId, input.claimId);
  const at = (deps.now ?? (() => new Date()))();

  await casTransition(deps, input.organizationId, input.claimId, ['DRAFT'], {
    status: 'SUBMITTED',
    submittedAt: at,
    submittedBy: input.actorUserId,
    approvedByUserId: input.actorUserId,
    approvedAt: at,
  });

  await deps.audit.record({
    organizationId: input.organizationId,
    actorType: 'USER',
    actorUserId: input.actorUserId,
    action: CLAIM_TRACKING_ACTION.submission,
    entityType: 'Claim',
    entityId: claim.id,
    changes: {
      from: 'DRAFT',
      to: 'SUBMITTED',
      humanApproved: true,
      ...(input.note ? { note: input.note } : {}),
    },
  });

  return { claimId: claim.id, status: 'SUBMITTED', approvedAt: at.toISOString() };
}

/**
 * SUBMITTED → ACKNOWLEDGED：录入平台案件号。
 * 幂等：同一 (organizationId, platformCaseRef) 重复录入视为已记录（返回 reused=true）。
 */
export async function recordAcknowledgement(
  input: ActorInput & { platformCaseRef: string; note?: string },
  deps: ClaimTrackingDeps,
): Promise<{ claimId: string; status: string; platformCaseRef: string; reused: boolean }> {
  authorize(input.role, 'record_acknowledgement');
  const ref = input.platformCaseRef.trim();
  if (ref === '' || ref.length > 200) {
    throw new WorkflowError('INVALID_INPUT', 'platformCaseRef 必填且不超过 200 字符');
  }
  const claim = await loadClaim(deps, input.organizationId, input.claimId);

  const existing = await deps.prisma.claim.findFirst({
    where: { organizationId: input.organizationId, platformCaseRef: ref },
    select: { id: true, status: true },
  });
  if (existing) {
    if (existing.id !== claim.id) {
      throw new WorkflowError('ILLEGAL_TRANSITION', '该平台案件号已绑定到另一条 Claim');
    }
    return { claimId: claim.id, status: existing.status, platformCaseRef: ref, reused: true };
  }

  await casTransition(deps, input.organizationId, input.claimId, ['SUBMITTED'], {
    status: 'ACKNOWLEDGED',
    platformCaseRef: ref,
  });

  await deps.audit.record({
    organizationId: input.organizationId,
    actorType: 'USER',
    actorUserId: input.actorUserId,
    action: CLAIM_TRACKING_ACTION.acknowledgement,
    entityType: 'Claim',
    entityId: claim.id,
    changes: { from: 'SUBMITTED', to: 'ACKNOWLEDGED', platformCaseRef: ref },
  });

  return { claimId: claim.id, status: 'ACKNOWLEDGED', platformCaseRef: ref, reused: false };
}

/** 记录/清空截止时间（I1：有 dueAt 必须有来源；来源 UNKNOWN 时不得有 dueAt） */
export async function setDeadline(
  input: ActorInput & { dueAt: Date | null; deadlineSource: 'PLATFORM_NOTICE' | 'USER_INPUT' | 'CONTRACT' | 'UNKNOWN' },
  deps: ClaimTrackingDeps,
): Promise<{ claimId: string; dueAt: string | null; deadlineSource: string }> {
  authorize(input.role, 'set_deadline');
  const claim = await loadClaim(deps, input.organizationId, input.claimId);

  if (input.dueAt === null && input.deadlineSource !== 'UNKNOWN') {
    throw new WorkflowError('INVALID_INPUT', '清空 dueAt 时 deadlineSource 必须为 UNKNOWN');
  }
  if (input.dueAt !== null && input.deadlineSource === 'UNKNOWN') {
    throw new WorkflowError('INVALID_INPUT', '有具体时限时必须给出有效来源');
  }

  await deps.prisma.claim.updateMany({
    where: { id: claim.id, organizationId: input.organizationId },
    data: { dueAt: input.dueAt, deadlineSource: input.deadlineSource },
  });

  await deps.audit.record({
    organizationId: input.organizationId,
    actorType: 'USER',
    actorUserId: input.actorUserId,
    action: CLAIM_TRACKING_ACTION.deadline,
    entityType: 'Claim',
    entityId: claim.id,
    changes: {
      dueAt: input.dueAt ? input.dueAt.toISOString() : null,
      deadlineSource: input.deadlineSource,
    },
  });

  return {
    claimId: claim.id,
    dueAt: input.dueAt ? input.dueAt.toISOString() : null,
    deadlineSource: input.deadlineSource,
  };
}

const TERMINAL_STATUSES = ['APPROVED', 'PARTIALLY_APPROVED', 'REJECTED', 'NO_RESPONSE', 'WITHDRAWN'] as const;
type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

/** 记录终局（I2/I3/I5）：终局态不可回退，更正走新 round */
export async function recordTerminal(
  input: ActorInput & {
    status: TerminalStatus;
    terminalReasonCode:
      | 'PLATFORM_DECISION'
      | 'DEADLINE_MISSED'
      | 'INSUFFICIENT_EVIDENCE'
      | 'WITHDRAWN_BY_SELLER'
      | 'DUPLICATE_CLAIM'
      | 'OTHER';
    responseAmount?: string | null;
  },
  deps: ClaimTrackingDeps,
): Promise<{ claimId: string; status: TerminalStatus }> {
  authorize(input.role, 'record_terminal');
  const claim = await loadClaim(deps, input.organizationId, input.claimId);
  const at = (deps.now ?? (() => new Date()))();

  if (input.status === 'PARTIALLY_APPROVED' && !input.responseAmount) {
    throw new WorkflowError('INVALID_INPUT', 'PARTIALLY_APPROVED 必须提供 responseAmount');
  }
  if (!TERMINAL_STATUSES.includes(input.status)) {
    throw new WorkflowError('INVALID_INPUT', '非法终局状态');
  }

  // I2：进入终局需人工批准留痕 → 由本调用者写入（recordSubmission 已写，但终局可能直接由人工判定）
  await casTransition(deps, input.organizationId, input.claimId, ['SUBMITTED', 'ACKNOWLEDGED'], {
    status: input.status,
    respondedAt: at,
    responseAmount: input.responseAmount ?? null,
    terminalReasonCode: input.terminalReasonCode,
    approvedByUserId: input.actorUserId,
    approvedAt: at,
    // I5：终局不留 open deadline
    dueAt: null,
    deadlineSource: 'UNKNOWN',
  });

  await deps.audit.record({
    organizationId: input.organizationId,
    actorType: 'USER',
    actorUserId: input.actorUserId,
    action: CLAIM_TRACKING_ACTION.terminal,
    entityType: 'Claim',
    entityId: claim.id,
    changes: {
      from: claim.status,
      to: input.status,
      terminalReasonCode: input.terminalReasonCode,
      responseAmount: input.responseAmount ?? null,
    },
  });

  return { claimId: claim.id, status: input.status };
}
