/**
 * C17（MSG-20261003-124 ③④⑤⑥⑦）：Customs submission ledger 的 Prisma/PostgreSQL 实现。
 *   · root：P2002 → 回读既有根（并发只允许一根）；
 *   · fact：P2002 → 回读既有事实（幂等）；append-only 由 DB 触发器保证；
 *   · 不写 credential / raw payload；不做任何外写。
 */

import type { PrismaClient } from '@prisma/client';

import {
  type CustomsSubmissionAttempt,
  type CustomsSubmissionAttemptFact,
  type CustomsSubmissionAttemptStatus,
  type CustomsSubmissionLedgerStore,
  type CustomsSubmissionSource,
  type CustomsSubmissionVerificationLevel,
} from './customs-submission-ledger';

const UNIQUE_VIOLATION_CODE = 'P2002';

type RootRow = {
  id: string;
  organizationId: string;
  opportunityId: string;
  caseId: string | null;
  claimItemId: string | null;
  packageId: string;
  packageDigest: string;
  provider: string;
  operation: string;
  jurisdiction: string;
  remedyType: string;
  idempotencyKey: string;
  createdAt: Date;
};

type FactRow = {
  id: string;
  organizationId: string;
  attemptId: string;
  status: string;
  providerSubmissionId: string | null;
  source: string;
  verificationLevel: string;
  observedAt: Date;
  recordedAt: Date;
  providerReference: string | null;
  errorCode: string | null;
  reconciliationAttempt: number | null;
  createdAt: Date;
};

function toRoot(row: RootRow): CustomsSubmissionAttempt {
  return { ...row, createdAt: row.createdAt.toISOString() };
}

function toFact(row: FactRow): CustomsSubmissionAttemptFact {
  return {
    id: row.id,
    organizationId: row.organizationId,
    attemptId: row.attemptId,
    status: row.status as CustomsSubmissionAttemptStatus,
    providerSubmissionId: row.providerSubmissionId,
    source: row.source as CustomsSubmissionSource,
    verificationLevel: row.verificationLevel as CustomsSubmissionVerificationLevel,
    observedAt: row.observedAt.toISOString(),
    recordedAt: row.recordedAt.toISOString(),
    providerReference: row.providerReference,
    errorCode: row.errorCode,
    reconciliationAttempt: row.reconciliationAttempt,
    createdAt: row.createdAt.toISOString(),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === UNIQUE_VIOLATION_CODE;
}

export function createPrismaCustomsSubmissionLedgerStore(prisma: PrismaClient): CustomsSubmissionLedgerStore {
  const storeImpl: CustomsSubmissionLedgerStore = {
    async createRoot(root) {
      try {
        const created = await prisma.customsSubmissionAttempt.create({
          data: {
            id: root.id,
            organizationId: root.organizationId,
            opportunityId: root.opportunityId,
            caseId: root.caseId,
            claimItemId: root.claimItemId,
            packageId: root.packageId,
            packageDigest: root.packageDigest,
            provider: root.provider,
            operation: root.operation,
            jurisdiction: root.jurisdiction,
            remedyType: root.remedyType,
            idempotencyKey: root.idempotencyKey,
            createdAt: new Date(root.createdAt),
          },
        });
        return { created: true, root: toRoot(created as RootRow) };
      } catch (error) {
        if (isUniqueViolation(error)) {
          const existing = await prisma.customsSubmissionAttempt.findUnique({
            where: {
              organizationId_provider_operation_idempotencyKey: {
                organizationId: root.organizationId,
                provider: root.provider,
                operation: root.operation,
                idempotencyKey: root.idempotencyKey,
              },
            },
          });
          if (existing !== null) return { created: false, root: toRoot(existing as RootRow) };
        }
        throw error;
      }
    },

    async findRoot(organizationId, provider, operation, idempotencyKey) {
      const row = await prisma.customsSubmissionAttempt.findUnique({
        where: {
          organizationId_provider_operation_idempotencyKey: { organizationId, provider, operation, idempotencyKey },
        },
      });
      return row === null ? null : toRoot(row as RootRow);
    },

    async findRootById(organizationId, attemptId) {
      const row = await prisma.customsSubmissionAttempt.findFirst({ where: { id: attemptId, organizationId } });
      return row === null ? null : toRoot(row as RootRow);
    },

    async appendFact(fact) {
      try {
        const created = await prisma.customsSubmissionAttemptFact.create({
          data: {
            id: fact.id,
            organizationId: fact.organizationId,
            attemptId: fact.attemptId,
            status: fact.status,
            providerSubmissionId: fact.providerSubmissionId,
            source: fact.source,
            verificationLevel: fact.verificationLevel,
            observedAt: new Date(fact.observedAt),
            recordedAt: new Date(fact.recordedAt),
            providerReference: fact.providerReference,
            errorCode: fact.errorCode,
            reconciliationAttempt: fact.reconciliationAttempt,
            createdAt: new Date(fact.createdAt),
          },
        });
        return { created: true, fact: toFact(created as FactRow) };
      } catch (error) {
        if (isUniqueViolation(error)) {
          const existing = await prisma.customsSubmissionAttemptFact.findUnique({ where: { id: fact.id } });
          if (existing !== null) return { created: false, fact: toFact(existing as FactRow) };
        }
        throw error;
      }
    },

    async appendFactGuarded(fact, constraints) {
      // CHANGE A：以 root 行锁串行化同一 attempt 的并发写入（PostgreSQL SELECT ... FOR UPDATE）。
      return prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          'SELECT "id" FROM "CustomsSubmissionAttempt" WHERE "id" = $1 AND "organizationId" = $2 FOR UPDATE',
          fact.attemptId,
          fact.organizationId,
        );
        const existingRows = await tx.customsSubmissionAttemptFact.findMany({
          where: { organizationId: fact.organizationId, attemptId: fact.attemptId },
        });
        const existing = existingRows.map((row) => toFact(row as FactRow));

        // CHANGE A：providerSubmissionId 冲突（并发安全，锁内判定）。
        if (constraints.forbidProviderSubmissionIdConflict && fact.providerSubmissionId !== null) {
          const conflict = existing.some(
            (f) => f.verificationLevel === 'PROVIDER_VERIFIED' && f.providerSubmissionId !== null && f.providerSubmissionId !== fact.providerSubmissionId,
          );
          if (conflict) return { created: false, fact: null, conflict: 'PROVIDER_SUBMISSION_ID_CONFLICT' as const };
        }

        // CHANGE C：同 id 事实必须完整等价，否则 fail-closed（不得静默 ALREADY_RECORDED）。
        const sameId = existing.find((f) => f.id === fact.id);
        if (sameId !== undefined) {
          const equal =
            sameId.organizationId === fact.organizationId &&
            sameId.attemptId === fact.attemptId &&
            sameId.status === fact.status &&
            sameId.providerSubmissionId === fact.providerSubmissionId &&
            sameId.source === fact.source &&
            sameId.verificationLevel === fact.verificationLevel &&
            sameId.observedAt === fact.observedAt &&
            sameId.providerReference === fact.providerReference &&
            sameId.errorCode === fact.errorCode &&
            sameId.reconciliationAttempt === fact.reconciliationAttempt;
          if (!equal) return { created: false, fact: null, conflict: 'FACT_IMMUTABLE_MISMATCH' as const };
          return { created: false, fact: sameId, conflict: null };
        }

        const createdRow = await tx.customsSubmissionAttemptFact.create({
          data: {
            id: fact.id,
            organizationId: fact.organizationId,
            attemptId: fact.attemptId,
            status: fact.status,
            providerSubmissionId: fact.providerSubmissionId,
            source: fact.source,
            verificationLevel: fact.verificationLevel,
            observedAt: new Date(fact.observedAt),
            recordedAt: new Date(fact.recordedAt),
            providerReference: fact.providerReference,
            errorCode: fact.errorCode,
            reconciliationAttempt: fact.reconciliationAttempt,
            createdAt: new Date(fact.createdAt),
          },
        });
        return { created: true, fact: toFact(createdRow as FactRow), conflict: null };
      });
    },

    async listFacts(organizationId, attemptId) {
      const rows = await prisma.customsSubmissionAttemptFact.findMany({
        where: { organizationId, attemptId },
        orderBy: [{ observedAt: 'asc' }, { createdAt: 'asc' }],
      });
      return rows.map((row) => toFact(row as FactRow));
    },
  };

  return storeImpl;
}
