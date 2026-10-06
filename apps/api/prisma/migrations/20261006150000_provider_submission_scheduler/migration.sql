-- ============================================================
-- CrossClaim — PROVIDER FOLLOW-UP INTELLIGENCE / P1（HOST 2026-10-06）
-- Provider Submission Scheduler（tenant-owned，durable queue + append-only 证据 + durable 限流窗口）
--   * ProviderSubmissionIntent：durable 队列项（幂等键唯一、lease、exhausted→死信/manual）
--   * ProviderSubmissionEvent ：append-only 调度证据（UPDATE/DELETE 一律拒绝）
--   * ProviderRateWindow      ：provider-aware 限流窗口（account/operation/connection 维度）
-- 边界：transport 恒 FALSE；本 migration 不引入任何外部写能力、不存凭据。
-- 清单同步：required-triggers.json（tenant 基线 + 归属不可变）与 append-only-triggers.json（证据 append-only）。
-- ============================================================

CREATE TABLE "ProviderSubmissionIntent" (
  "id"                TEXT         NOT NULL,
  "organizationId"    TEXT         NOT NULL,
  "platformAccountId" TEXT         NOT NULL,
  "platform"          TEXT         NOT NULL,
  "operation"         TEXT         NOT NULL,
  "connectionRef"     TEXT         NOT NULL,
  "caseRef"           TEXT,
  "claimRef"          TEXT,
  "idempotencyKey"    TEXT         NOT NULL,
  "payloadDigest"     TEXT         NOT NULL,
  "basisDigest"       TEXT         NOT NULL,
  "policyProfileId"   TEXT,
  "priority"          INTEGER      NOT NULL DEFAULT 0,
  "state"             TEXT         NOT NULL DEFAULT 'QUEUED',
  "attemptCount"      INTEGER      NOT NULL DEFAULT 0,
  "availableAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "retryAfterAt"      TIMESTAMP(3),
  "cooldownUntil"     TIMESTAMP(3),
  "lastOutcome"       TEXT,
  "lastReason"        TEXT,
  "ownerRef"          TEXT,
  "leaseId"           TEXT,
  "leaseAcquiredAt"   TIMESTAMP(3),
  "leaseExpiresAt"    TIMESTAMP(3),
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProviderSubmissionIntent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProviderSubmissionIntent_state_chk" CHECK (
    "state" IN ('QUEUED','WAITING','RATE_LIMITED','READY_FOR_PROVIDER','LEASED','NEEDS_MANUAL','DEAD_LETTER','CANCELLED')
  ),
  CONSTRAINT "ProviderSubmissionIntent_operation_chk" CHECK (
    "operation" IN ('CLAIM_SUBMIT','APPEAL_SUBMIT','CASE_REPLY','EVIDENCE_UPLOAD','RFI_RESPOND','STATUS_READ')
  ),
  CONSTRAINT "ProviderSubmissionIntent_attempt_chk" CHECK ("attemptCount" >= 0),
  CONSTRAINT "ProviderSubmissionIntent_lease_chk" CHECK (
    "state" <> 'LEASED' OR ("ownerRef" IS NOT NULL AND "leaseId" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL)
  )
);
CREATE UNIQUE INDEX "ProviderSubmissionIntent_organizationId_idempotencyKey_key"
  ON "ProviderSubmissionIntent"("organizationId", "idempotencyKey");
CREATE UNIQUE INDEX "ProviderSubmissionIntent_organizationId_id_key"
  ON "ProviderSubmissionIntent"("organizationId", "id");
CREATE INDEX "ProviderSubmissionIntent_state_availableAt_idx"
  ON "ProviderSubmissionIntent"("state", "availableAt");
CREATE INDEX "ProviderSubmissionIntent_organizationId_platformAccountId_state_idx"
  ON "ProviderSubmissionIntent"("organizationId", "platformAccountId", "state");
CREATE INDEX "ProviderSubmissionIntent_organizationId_platform_operation_state_idx"
  ON "ProviderSubmissionIntent"("organizationId", "platform", "operation", "state");

CREATE TABLE "ProviderSubmissionEvent" (
  "id"                   TEXT         NOT NULL,
  "organizationId"       TEXT         NOT NULL,
  "intentId"             TEXT         NOT NULL,
  "seq"                  INTEGER      NOT NULL,
  "kind"                 TEXT         NOT NULL,
  "fromState"            TEXT,
  "toState"              TEXT,
  "decision"             TEXT,
  "reason"               TEXT,
  "providerResponseKind" TEXT,
  "policyDigest"         TEXT,
  "ownerRef"             TEXT,
  "leaseId"              TEXT,
  "detail"               TEXT,
  "occurredAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProviderSubmissionEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProviderSubmissionEvent_kind_chk" CHECK (
    "kind" IN ('ENQUEUED','DISPATCH_READY','RATE_LIMITED','WAITING','LEASE_ACQUIRED','LEASE_RECLAIMED','OUTCOME_RECORDED','RECONCILIATION_REQUIRED','DEAD_LETTERED','MANUAL_REVIEW','CANCELLED')
  ),
  CONSTRAINT "ProviderSubmissionEvent_response_chk" CHECK (
    "providerResponseKind" IS NULL OR "providerResponseKind" IN ('SUCCESS','RATE_LIMITED_429','RETRYABLE_5XX','TIMEOUT','CONNECTION_RESET','UNKNOWN')
  ),
  CONSTRAINT "ProviderSubmissionEvent_seq_chk" CHECK ("seq" >= 1)
);
CREATE UNIQUE INDEX "ProviderSubmissionEvent_intentId_seq_key"
  ON "ProviderSubmissionEvent"("intentId", "seq");
CREATE UNIQUE INDEX "ProviderSubmissionEvent_organizationId_id_key"
  ON "ProviderSubmissionEvent"("organizationId", "id");
CREATE INDEX "ProviderSubmissionEvent_organizationId_occurredAt_idx"
  ON "ProviderSubmissionEvent"("organizationId", "occurredAt");
ALTER TABLE "ProviderSubmissionEvent"
  ADD CONSTRAINT "ProviderSubmissionEvent_intentId_fkey"
  FOREIGN KEY ("intentId") REFERENCES "ProviderSubmissionIntent"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "ProviderRateWindow" (
  "id"             TEXT         NOT NULL,
  "organizationId" TEXT         NOT NULL,
  "scopeKey"       TEXT         NOT NULL,
  "windowStart"    TIMESTAMP(3) NOT NULL,
  "windowMs"       INTEGER      NOT NULL,
  "count"          INTEGER      NOT NULL DEFAULT 0,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProviderRateWindow_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProviderRateWindow_count_chk" CHECK ("count" >= 0),
  CONSTRAINT "ProviderRateWindow_window_chk" CHECK ("windowMs" > 0)
);
CREATE UNIQUE INDEX "ProviderRateWindow_organizationId_scopeKey_windowStart_key"
  ON "ProviderRateWindow"("organizationId", "scopeKey", "windowStart");
CREATE UNIQUE INDEX "ProviderRateWindow_organizationId_id_key"
  ON "ProviderRateWindow"("organizationId", "id");
CREATE INDEX "ProviderRateWindow_organizationId_scopeKey_windowStart_idx"
  ON "ProviderRateWindow"("organizationId", "scopeKey", "windowStart");

-- ---------- append-only：调度证据不可改写 ----------
CREATE OR REPLACE FUNCTION "cc_provider_submission_event_append_only"()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'PROVIDER_SUBMISSION_EVENT_APPEND_ONLY: rescheduling evidence must not be updated or deleted';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "cc_append_only__ProviderSubmissionEvent" ON "ProviderSubmissionEvent";
CREATE TRIGGER "cc_append_only__ProviderSubmissionEvent"
  BEFORE UPDATE OR DELETE ON "ProviderSubmissionEvent"
  FOR EACH ROW EXECUTE FUNCTION "cc_provider_submission_event_append_only"();

-- ---------- 队列项身份不可原地改写 ----------
CREATE OR REPLACE FUNCTION "cc_provider_submission_identity_immutable"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."organizationId"    IS DISTINCT FROM OLD."organizationId"
     OR NEW."platformAccountId" IS DISTINCT FROM OLD."platformAccountId"
     OR NEW."platform"          IS DISTINCT FROM OLD."platform"
     OR NEW."operation"         IS DISTINCT FROM OLD."operation"
     OR NEW."connectionRef"     IS DISTINCT FROM OLD."connectionRef"
     OR NEW."idempotencyKey"    IS DISTINCT FROM OLD."idempotencyKey"
     OR NEW."payloadDigest"     IS DISTINCT FROM OLD."payloadDigest"
     OR NEW."basisDigest"       IS DISTINCT FROM OLD."basisDigest"
     OR NEW."createdAt"         IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'PROVIDER_SUBMISSION_IDENTITY_IMMUTABLE: queue identity must not be rewritten in place';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "cc_provider_submission_identity__ProviderSubmissionIntent" ON "ProviderSubmissionIntent";
CREATE TRIGGER "cc_provider_submission_identity__ProviderSubmissionIntent"
  BEFORE UPDATE ON "ProviderSubmissionIntent"
  FOR EACH ROW EXECUTE FUNCTION "cc_provider_submission_identity_immutable"();

-- ---------- tenant 保护（基线 + 归属不可变） ----------
DROP TRIGGER IF EXISTS "cc_tenant_providersubmissionintent" ON "ProviderSubmissionIntent";
CREATE TRIGGER "cc_tenant_providersubmissionintent"
  BEFORE INSERT OR UPDATE ON "ProviderSubmissionIntent"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity();

DROP TRIGGER IF EXISTS "cc_tenant_providersubmissionevent" ON "ProviderSubmissionEvent";
CREATE TRIGGER "cc_tenant_providersubmissionevent"
  BEFORE INSERT OR UPDATE ON "ProviderSubmissionEvent"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity();

DROP TRIGGER IF EXISTS "cc_tenant_providerratewindow" ON "ProviderRateWindow";
CREATE TRIGGER "cc_tenant_providerratewindow"
  BEFORE INSERT OR UPDATE ON "ProviderRateWindow"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity();

DROP TRIGGER IF EXISTS "cc_tenant_immutable__ProviderSubmissionIntent" ON "ProviderSubmissionIntent";
CREATE TRIGGER "cc_tenant_immutable__ProviderSubmissionIntent"
  BEFORE UPDATE ON "ProviderSubmissionIntent"
  FOR EACH ROW EXECUTE FUNCTION cc_forbid_tenant_reassignment();

DROP TRIGGER IF EXISTS "cc_tenant_immutable__ProviderSubmissionEvent" ON "ProviderSubmissionEvent";
CREATE TRIGGER "cc_tenant_immutable__ProviderSubmissionEvent"
  BEFORE UPDATE ON "ProviderSubmissionEvent"
  FOR EACH ROW EXECUTE FUNCTION cc_forbid_tenant_reassignment();

DROP TRIGGER IF EXISTS "cc_tenant_immutable__ProviderRateWindow" ON "ProviderRateWindow";
CREATE TRIGGER "cc_tenant_immutable__ProviderRateWindow"
  BEFORE UPDATE ON "ProviderRateWindow"
  FOR EACH ROW EXECUTE FUNCTION cc_forbid_tenant_reassignment();

-- 回滚（人工）：DROP TRIGGER / DROP TABLE（见上）
