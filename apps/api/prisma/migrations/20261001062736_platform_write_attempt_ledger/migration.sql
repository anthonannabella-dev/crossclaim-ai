-- CreateEnum
CREATE TYPE "PlatformWriteAttemptStatus" AS ENUM ('PENDING', 'IN_FLIGHT', 'SUCCEEDED', 'RETRYABLE', 'FAILED', 'DEAD_LETTER', 'BLOCKED', 'UNKNOWN_PROVIDER_RESPONSE', 'RECONCILING', 'FAILED_CONFIRMED', 'MANUAL_REVIEW');

-- CreateTable
CREATE TABLE "PlatformWriteAttempt" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "snapshotVersion" TEXT NOT NULL,
    "snapshotDigest" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "attemptNo" INTEGER NOT NULL DEFAULT 1,
    "status" "PlatformWriteAttemptStatus" NOT NULL DEFAULT 'PENDING',
    "targetKind" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "simulated" BOOLEAN NOT NULL DEFAULT true,
    "approvalId" TEXT,
    "basisReference" TEXT,
    "errorClass" TEXT,
    "errorCode" TEXT,
    "errorSummary" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "nextRetryAt" TIMESTAMP(3),
    "providerRef" TEXT,
    "reconcileAttempts" INTEGER NOT NULL DEFAULT 0,
    "reconcileNextAt" TIMESTAMP(3),
    "reconcileLastActor" TEXT,
    "reconciledStatus" TEXT,
    "reconciledAt" TIMESTAMP(3),
    "convergedBy" TEXT,
    "convergedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformWriteAttempt_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "PlatformWriteAttempt" ADD CONSTRAINT "PlatformWriteAttempt_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "PaymentProcessingAttempt_organizationId_paymentEventId_attemptN" RENAME TO "PaymentProcessingAttempt_organizationId_paymentEventId_atte_key";

-- RenameIndex
ALTER INDEX "RuleEvaluationShadow_organizationId_ruleVersionId_evaluatedAt_i" RENAME TO "RuleEvaluationShadow_organizationId_ruleVersionId_evaluated_idx";
