/**
 * C-0009.3 P0 — appeal package delivery state ("Locked").
 * ---------------------------------------------------------------
 * Architect ruling (MSG-20260928-71/72):
 *   · only the **generated commercial deliverable** may be locked;
 *   · the customer's own data — raw files, evidence chain, audit trail — stays
 *     fully accessible and must NOT be gated by any payment binding.
 *
 * This endpoint is read-only and returns the delivery state plus an explicit
 * statement about customer-data access, so the UI can render a "LOCKED" badge
 * without ever hiding the underlying evidence.
 *
 * Unlocking is **not implemented** in this phase (commercial unlock is a later
 * design gate) — `unlockAvailable` is therefore false and the reason is stated.
 */

import type { PrismaClient } from '@prisma/client';

import { WorkflowError } from './opportunity-review';
import { assertPermission } from './permissions';

export type DeliverableState = 'LOCKED' | 'UNLOCKED';
export type CustomerDataAccess = 'AVAILABLE';

export interface AppealPackageState {
  caseId: string;
  caseNo: string;
  deliverable: {
    kind: 'APPEAL_PACKAGE';
    state: DeliverableState;
    reason: string;
    unlockAvailable: boolean;
    note: string;
  };
  customerDataAccess: {
    rawFiles: CustomerDataAccess;
    evidenceChain: CustomerDataAccess;
    auditTrail: CustomerDataAccess;
    note: string;
  };
}

export async function getAppealPackageState(
  prisma: PrismaClient,
  actor: { organizationId: string; role: string },
  caseId: string,
): Promise<AppealPackageState> {
  assertPermission(actor.role, 'viewClaimAmounts');

  const kase = await prisma.case.findFirst({
    where: { id: caseId, organizationId: actor.organizationId },
    select: { id: true, caseNo: true },
  });
  if (!kase) {
    throw new WorkflowError('NOT_FOUND', `案件 ${caseId} 不存在或不属于该租户`);
  }

  return {
    caseId: kase.id,
    caseNo: kase.caseNo,
    deliverable: {
      kind: 'APPEAL_PACKAGE',
      state: 'LOCKED',
      reason: 'COMMERCIAL_UNLOCK_PENDING',
      unlockAvailable: false,
      note: '对外交付物（申诉包）当前处于未解锁状态；解锁能力将在商业化 Gate 中单独设计。',
    },
    customerDataAccess: {
      rawFiles: 'AVAILABLE',
      evidenceChain: 'AVAILABLE',
      auditTrail: 'AVAILABLE',
      note: '客户自有数据与基础证据链始终可访问，与交付物状态无关；不得以支付绑定作为数据访问条件。',
    },
  };
}
