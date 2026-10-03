/**
 * CARRIER QUEUE #9B FINAL（MSG-20261003-119 ⑳㉚㉛㉜）— Prisma/PostgreSQL 实现。
 * ---------------------------------------------------------------
 *   · create 依赖 DB 层 UNIQUE(organizationId, packageId) 收敛并发；P2002 → created=false（service 映射 ALREADY_RECORDED）。
 *   · 同一事务内写入 business audit（复用既有 audit primitive：prepareAuditInsert + tx.auditLog.create），
 *     因此不存在「row 已建但 audit 永久缺失」的窗口（handlesAuditAtomically = true）。
 *   · 只读 / 写租户归属字段；append-only 由 DB 触发器保证（创建后不可 UPDATE/DELETE）。
 *   · 不写任何 credential / token / raw claim payload。
 */

import crypto from 'node:crypto';

import type { Prisma, PrismaClient } from '@prisma/client';

import { prepareAuditInsert } from '../audit/audit-log';
import {
  CARRIER_MANUAL_SUBMISSION_AUDIT_EVENT,
  type CarrierManualSubmissionRecord,
  type CarrierManualSubmissionStore,
} from './carrier-manual-submission';

const UNIQUE_VIOLATION_CODE = 'P2002';

type SubmissionRow = Prisma.CarrierManualSubmissionGetPayload<Record<string, never>>;

function toRecord(row: SubmissionRow): CarrierManualSubmissionRecord {
  return {
    submissionRecordId: row.id,
    packageId: row.packageId,
    bundleId: row.bundleId,
    organizationId: row.organizationId,
    provider: row.provider as CarrierManualSubmissionRecord['provider'],
    externalAccountId: row.externalAccountId,
    trackingNumber: row.trackingNumber,
    submittedByUserId: row.submittedByUserId,
    submittedAt: row.submittedAt.toISOString(),
    recordedAt: row.recordedAt.toISOString(),
    submissionMode: 'MANUAL',
    channel: row.channel,
    humanAttestation: {
      submitted: true,
      carrierReference: row.carrierReference,
      carrierReferenceProvenance: row.carrierReference === null ? null : 'USER_PROVIDED_UNVERIFIED',
      reportedCarrierSubmissionAt: row.reportedCarrierSubmissionAt ? row.reportedCarrierSubmissionAt.toISOString() : null,
      note: row.note,
    },
    carrierConfirmationStatus: 'NOT_VERIFIED',
    packageSnapshotReference: row.packageSnapshotReference,
    eligibilityRuleSetId: row.eligibilityRuleSetId,
    eligibilityRuleSetVersion: row.eligibilityRuleSetVersion,
    estimateRuleSetId: row.estimateRuleSetId,
    estimateRuleSetVersion: row.estimateRuleSetVersion,
    humanRecorded: true,
    carrierWritePerformed: false,
    transportEnabled: false,
    platformWriteEnabled: false,
    productionCredentials: 'ABSENT',
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: string }).code === UNIQUE_VIOLATION_CODE
  );
}

export function createPrismaCarrierManualSubmissionStore(
  prisma: PrismaClient,
  options: { now?: () => Date } = {},
): CarrierManualSubmissionStore {
  const store: CarrierManualSubmissionStore = {
    handlesAuditAtomically: true,

    async find(organizationId, packageId): Promise<CarrierManualSubmissionRecord | null> {
      const row = await prisma.carrierManualSubmission.findUnique({
        where: { organizationId_packageId: { organizationId, packageId } },
      });
      return row === null ? null : toRecord(row);
    },

    async create(record) {
      try {
        const created = await prisma.$transaction(async (tx) => {
          const row = await tx.carrierManualSubmission.create({
            data: {
              id: record.submissionRecordId,
              organizationId: record.organizationId,
              packageId: record.packageId,
              bundleId: record.bundleId,
              provider: record.provider,
              externalAccountId: record.externalAccountId,
              trackingNumber: record.trackingNumber,
              submittedByUserId: record.submittedByUserId,
              submittedAt: new Date(record.submittedAt),
              recordedAt: new Date(record.recordedAt),
              reportedCarrierSubmissionAt: record.humanAttestation.reportedCarrierSubmissionAt
                ? new Date(record.humanAttestation.reportedCarrierSubmissionAt)
                : null,
              carrierReference: record.humanAttestation.carrierReference,
              carrierReferenceProvenance: record.humanAttestation.carrierReferenceProvenance,
              note: record.humanAttestation.note,
              carrierConfirmationStatus: record.carrierConfirmationStatus,
              submissionMode: record.submissionMode,
              channel: record.channel,
              eligibilityRuleSetId: record.eligibilityRuleSetId,
              eligibilityRuleSetVersion: record.eligibilityRuleSetVersion,
              estimateRuleSetId: record.estimateRuleSetId,
              estimateRuleSetVersion: record.estimateRuleSetVersion,
              packageSnapshotReference: record.packageSnapshotReference,
            },
          });
          // ㉛ 同事务写 business audit（复用既有 primitive），保证 row 与 audit 原子一致。
          const auditRow = prepareAuditInsert(
            {
              organizationId: record.organizationId,
              actorType: 'USER',
              actorUserId: record.submittedByUserId,
              action: CARRIER_MANUAL_SUBMISSION_AUDIT_EVENT,
              entityType: 'CarrierManualSubmission',
              entityId: record.submissionRecordId,
              changes: {
                packageId: record.packageId,
                trackingNumber: record.trackingNumber,
                carrierConfirmationStatus: record.carrierConfirmationStatus,
                result: 'RECORDED',
              },
            },
            options.now ? { now: options.now } : {},
          );
          await tx.auditLog.create({
            data: {
              id: crypto.randomUUID(),
              organizationId: auditRow.organizationId,
              actorType: auditRow.actorType,
              actorUserId: auditRow.actorUserId,
              actorRef: auditRow.actorRef,
              action: auditRow.action,
              entityType: auditRow.entityType,
              entityId: auditRow.entityId,
              changes: (auditRow.changes ?? undefined) as Prisma.InputJsonValue | undefined,
              ip: auditRow.ip,
              userAgent: auditRow.userAgent,
              createdAt: auditRow.createdAt,
            },
          });
          return row;
        });
        return { created: true, record: toRecord(created) };
      } catch (error) {
        if (isUniqueViolation(error)) {
          const existing = await store.find(record.organizationId, record.packageId);
          if (existing !== null) return { created: false, record: existing };
        }
        throw error;
      }
    },
  };

  return store;
}
