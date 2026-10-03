/**
 * CARRIER QUEUE #10 FINAL（MSG-20261003-122 ㉓㉕㉖）— CarrierClaimResponseFact 的 Prisma/PostgreSQL 实现。
 * ---------------------------------------------------------------
 *   · append-only：只提供 append / listByPackage（无 update / delete / upsert）。
 *   · DB idempotency：UNIQUE(organizationId, packageId, idempotencyKey)；P2002 → created=false（service 映射 ALREADY_RECORDED）。
 *   · Audit atomicity：同一事务写入 fact + business audit（复用既有 prepareAuditInsert），duplicate 不重复审计。
 *   · 不写任何资金真值 / credential / raw provider payload。
 */

import crypto from 'node:crypto';

import type { Prisma, PrismaClient } from '@prisma/client';

import { prepareAuditInsert } from '../audit/audit-log';
import {
  CARRIER_CLAIM_RESPONSE_AUDIT_EVENT,
  carrierClaimResponseIdempotencyKey,
  type CarrierClaimResponseFact,
  type CarrierClaimResponseSource,
  type CarrierClaimResponseStatus,
  type CarrierClaimResponseStore,
  type CarrierResponseVerificationLevel,
} from './carrier-claim-response';

const UNIQUE_VIOLATION_CODE = 'P2002';

type ResponseRow = Prisma.CarrierClaimResponseFactGetPayload<Record<string, never>>;

function toFact(row: ResponseRow): CarrierClaimResponseFact {
  return {
    factId: row.id,
    organizationId: row.organizationId,
    packageId: row.packageId,
    submissionRecordId: row.submissionRecordId,
    provider: row.provider as CarrierClaimResponseFact['provider'],
    externalAccountId: row.externalAccountId,
    trackingNumber: row.trackingNumber,
    status: row.status as CarrierClaimResponseStatus,
    source: row.source as CarrierClaimResponseSource,
    verificationLevel: row.verificationLevel as CarrierResponseVerificationLevel,
    providerReference: row.providerReference,
    observedAt: row.observedAt.toISOString(),
    recordedAt: row.recordedAt.toISOString(),
    rawArtifactReference: row.rawArtifactReference,
    recordedByUserId: row.recordedByUserId,
    recoveredCashUpdated: false,
    successFeeCalculated: false,
    paymentCollectionPerformed: false,
    externalWritePerformed: false,
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

export interface PrismaCarrierClaimResponseStore extends CarrierClaimResponseStore {
  /** ㉖ fact + business audit 同事务，service 不再单独 emit。 */
  readonly handlesAuditAtomically: true;
}

export function createPrismaCarrierClaimResponseStore(
  prisma: PrismaClient,
  options: { now?: () => Date } = {},
): PrismaCarrierClaimResponseStore {
  const idempotencyKeyFor = (fact: CarrierClaimResponseFact) =>
    carrierClaimResponseIdempotencyKey({
      organizationId: fact.organizationId,
      packageId: fact.packageId,
      status: fact.status,
      source: fact.source,
      providerReference: fact.providerReference,
    });

  const store: PrismaCarrierClaimResponseStore = {
    handlesAuditAtomically: true,

    async append(fact) {
      const idempotencyKey = idempotencyKeyFor(fact);
      try {
        const created = await prisma.$transaction(async (tx) => {
          const row = await tx.carrierClaimResponseFact.create({
            data: {
              id: fact.factId,
              organizationId: fact.organizationId,
              packageId: fact.packageId,
              submissionRecordId: fact.submissionRecordId,
              provider: fact.provider,
              externalAccountId: fact.externalAccountId,
              trackingNumber: fact.trackingNumber,
              status: fact.status,
              source: fact.source,
              verificationLevel: fact.verificationLevel,
              providerReference: fact.providerReference,
              observedAt: new Date(fact.observedAt),
              recordedAt: new Date(fact.recordedAt),
              rawArtifactReference: fact.rawArtifactReference,
              recordedByUserId: fact.recordedByUserId,
              idempotencyKey,
            },
          });
          const auditRow = prepareAuditInsert(
            {
              organizationId: fact.organizationId,
              actorType: 'USER',
              actorUserId: fact.recordedByUserId,
              action: CARRIER_CLAIM_RESPONSE_AUDIT_EVENT,
              entityType: 'CarrierClaimResponseFact',
              entityId: fact.factId,
              changes: {
                packageId: fact.packageId,
                status: fact.status,
                source: fact.source,
                verificationLevel: fact.verificationLevel,
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
        return { created: true, fact: toFact(created) };
      } catch (error) {
        if (isUniqueViolation(error)) {
          const existing = await prisma.carrierClaimResponseFact.findUnique({
            where: {
              organizationId_packageId_idempotencyKey: {
                organizationId: fact.organizationId,
                packageId: fact.packageId,
                idempotencyKey,
              },
            },
          });
          if (existing !== null) return { created: false, fact: toFact(existing) };
        }
        throw error;
      }
    },

    async listByPackage(organizationId, packageId) {
      const rows = await prisma.carrierClaimResponseFact.findMany({
        where: { organizationId, packageId },
      });
      return rows.map(toFact);
    },
  };

  return store;
}
