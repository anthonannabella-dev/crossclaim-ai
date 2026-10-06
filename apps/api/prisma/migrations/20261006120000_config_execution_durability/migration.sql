-- ============================================================
-- CrossClaim — P6-PROD-U1 Controlled Config Execution Durability
-- 依据：HOST AUTHORIZATION 2026-10-06（P6-PROD-U1 / NO PRODUCTION ENABLEMENT）
--   * DB-backed reservation / execution ownership（非进程内 memory / WeakMap / 单进程锁）
--   * Strong dedupe：UNIQUE(authorizationVerdictDigest) / UNIQUE(authorizationTicketDigest)
--     / UNIQUE(idempotencyKey) / UNIQUE(reservationKey)；同幂等键异载荷 → FAIL CLOSED
--   * Durable 状态机：RESERVED → EXECUTING → terminal；非法跳转 fail-closed（触发器）
--   * append-only 事件 / 终态结果 / 交付账本（不得 UPDATE 覆盖成「最后一次状态」）
--   * transactional outbox（终态 + 结果 + outbox 同事务写入）+ 消费者幂等交付账本
--   * lease / stale-lease takeover（ownerRef / leaseId / acquiredAt / renewedAt / expiresAt）
--   * NO PRODUCTION ENABLEMENT：environment 只允许 SANDBOX；production mutation switch 保持 false
-- 结构安全：不删表 / 不建类型 / 不改列 / 不删数据；只允许 DROP 本 migration 自建的 TRIGGER。
-- 命名纪律：cc_append_only__* / cc_no_delete__* / cc_*identity_immutable__* 不进入租户清单
--   （required-triggers.json），由 tools/tenant-triggers/append-only-triggers.json 覆盖。
-- 值域单源：src/services/config-execution-durability/state-machine.ts（合同测试逐条比对）。
-- ============================================================

-- ------------------------------------------------------------
-- 1) durable reservation / execution ownership
-- ------------------------------------------------------------
CREATE TABLE "ControlledConfigExecutionReservation" (
  "id" TEXT NOT NULL,
  "reservationKey" TEXT NOT NULL,
  "immutableBasisDigest" TEXT NOT NULL,
  "authorizationVerdictDigest" TEXT NOT NULL,
  "authorizationTicketDigest" TEXT NOT NULL,
  "planDigest" TEXT NOT NULL,
  "candidateDigest" TEXT NOT NULL,
  "proposalDigest" TEXT NOT NULL,
  "controlledAdoptionDigest" TEXT NOT NULL,
  "rollbackPlanDigest" TEXT NOT NULL,
  "baselineSnapshotDigest" TEXT NOT NULL,
  "baselineConfigFingerprint" TEXT NOT NULL,
  "environment" TEXT NOT NULL DEFAULT 'SANDBOX',
  "executionMode" TEXT NOT NULL DEFAULT 'SANDBOX_WRITE_ONLY',
  "target" TEXT NOT NULL,
  "configPath" TEXT NOT NULL,
  "fromValue" TEXT NOT NULL,
  "toValue" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "idempotencyPayloadDigest" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'RESERVED',
  "executionAttempt" INTEGER NOT NULL DEFAULT 0,
  "ownerRef" TEXT,
  "leaseId" TEXT,
  "leaseAcquiredAt" TIMESTAMP(3),
  "leaseRenewedAt" TIMESTAMP(3),
  "leaseExpiresAt" TIMESTAMP(3),
  "reservationExpiresAt" TIMESTAMP(3) NOT NULL,
  "reservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3),
  "terminalAt" TIMESTAMP(3),
  "terminalCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ControlledConfigExecutionReservation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ControlledConfigExecutionReservation_status_chk" CHECK (
    "status" IN ('RESERVED','EXECUTING','SUCCEEDED','CONFLICT','STALE_BASELINE','NEEDS_RECONCILIATION','FAILED_CONFIRMED','MANUAL_REVIEW','SUPERSEDED','CANCELLED')
  ),
  CONSTRAINT "ControlledConfigExecutionReservation_environment_chk" CHECK ("environment" IN ('SANDBOX')),
  CONSTRAINT "ControlledConfigExecutionReservation_mode_chk" CHECK ("executionMode" IN ('SANDBOX_WRITE_ONLY')),
  CONSTRAINT "ControlledConfigExecutionReservation_executing_chk" CHECK (
    "status" <> 'EXECUTING'
    OR ("ownerRef" IS NOT NULL AND "leaseId" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL)
  ),
  CONSTRAINT "ControlledConfigExecutionReservation_terminal_chk" CHECK (
    ("status" IN ('RESERVED','EXECUTING') AND "terminalAt" IS NULL AND "terminalCode" IS NULL)
    OR ("status" NOT IN ('RESERVED','EXECUTING') AND "terminalAt" IS NOT NULL AND "terminalCode" IS NOT NULL)
  ),
  CONSTRAINT "ControlledConfigExecutionReservation_attempt_chk" CHECK ("executionAttempt" >= 0)
);

CREATE UNIQUE INDEX "ControlledConfigExecutionReservation_reservationKey_key"
  ON "ControlledConfigExecutionReservation"("reservationKey");
CREATE UNIQUE INDEX "ControlledConfigExecutionReservation_authorizationVerdictDigest_key"
  ON "ControlledConfigExecutionReservation"("authorizationVerdictDigest");
CREATE UNIQUE INDEX "ControlledConfigExecutionReservation_authorizationTicketDigest_key"
  ON "ControlledConfigExecutionReservation"("authorizationTicketDigest");
CREATE UNIQUE INDEX "ControlledConfigExecutionReservation_idempotencyKey_key"
  ON "ControlledConfigExecutionReservation"("idempotencyKey");
CREATE INDEX "ControlledConfigExecutionReservation_status_leaseExpiresAt_idx"
  ON "ControlledConfigExecutionReservation"("status", "leaseExpiresAt");
CREATE INDEX "ControlledConfigExecutionReservation_status_reservationExpiresAt_idx"
  ON "ControlledConfigExecutionReservation"("status", "reservationExpiresAt");
CREATE INDEX "ControlledConfigExecutionReservation_environment_status_idx"
  ON "ControlledConfigExecutionReservation"("environment", "status");

-- ------------------------------------------------------------
-- 2) append-only 事件历史
-- ------------------------------------------------------------
CREATE TABLE "ControlledConfigExecutionEvent" (
  "id" TEXT NOT NULL,
  "reservationId" TEXT NOT NULL,
  "seq" INTEGER NOT NULL,
  "kind" TEXT NOT NULL,
  "fromStatus" TEXT,
  "toStatus" TEXT,
  "ownerRef" TEXT,
  "leaseId" TEXT,
  "evidenceDigest" TEXT,
  "detail" TEXT,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ControlledConfigExecutionEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ControlledConfigExecutionEvent_kind_chk" CHECK (
    "kind" IN ('RESERVED','LEASE_ACQUIRED','LEASE_RENEWED','LEASE_TAKEOVER','LEASE_EXPIRED','NOOP_TERMINALIZED','CAS_ATTEMPTED','COMMITTED','CONFLICT','STALE_BASELINE','NEEDS_RECONCILIATION','FAILED_CONFIRMED','MANUAL_REVIEW','SUPERSEDED','CANCELLED','STARTUP_RECONCILED')
  ),
  CONSTRAINT "ControlledConfigExecutionEvent_seq_chk" CHECK ("seq" >= 1),
  CONSTRAINT "ControlledConfigExecutionEvent_status_chk" CHECK (
    ("fromStatus" IS NULL OR "fromStatus" IN ('RESERVED','EXECUTING','SUCCEEDED','CONFLICT','STALE_BASELINE','NEEDS_RECONCILIATION','FAILED_CONFIRMED','MANUAL_REVIEW','SUPERSEDED','CANCELLED'))
    AND ("toStatus" IS NULL OR "toStatus" IN ('RESERVED','EXECUTING','SUCCEEDED','CONFLICT','STALE_BASELINE','NEEDS_RECONCILIATION','FAILED_CONFIRMED','MANUAL_REVIEW','SUPERSEDED','CANCELLED'))
  )
);

CREATE UNIQUE INDEX "ControlledConfigExecutionEvent_reservationId_seq_key"
  ON "ControlledConfigExecutionEvent"("reservationId", "seq");
CREATE INDEX "ControlledConfigExecutionEvent_reservationId_occurredAt_idx"
  ON "ControlledConfigExecutionEvent"("reservationId", "occurredAt");

ALTER TABLE "ControlledConfigExecutionEvent"
  ADD CONSTRAINT "ControlledConfigExecutionEvent_reservationId_fkey"
  FOREIGN KEY ("reservationId") REFERENCES "ControlledConfigExecutionReservation"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ------------------------------------------------------------
-- 3) append-only 终态结果证据
-- ------------------------------------------------------------
CREATE TABLE "ControlledConfigExecutionResult" (
  "id" TEXT NOT NULL,
  "reservationId" TEXT NOT NULL,
  "executionId" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "resultCode" TEXT NOT NULL,
  "semantics" TEXT NOT NULL,
  "preConfigFingerprint" TEXT NOT NULL,
  "preConfigVersion" TEXT NOT NULL,
  "postConfigFingerprint" TEXT,
  "postConfigVersion" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "resultDigest" TEXT NOT NULL,
  "provenanceDigest" TEXT NOT NULL,
  "evidenceSource" TEXT NOT NULL,
  "reconciledBy" TEXT,
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ControlledConfigExecutionResult_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ControlledConfigExecutionResult_status_chk" CHECK (
    "status" IN ('SUCCEEDED','CONFLICT','STALE_BASELINE','NEEDS_RECONCILIATION','FAILED_CONFIRMED','MANUAL_REVIEW','SUPERSEDED','CANCELLED')
  ),
  CONSTRAINT "ControlledConfigExecutionResult_code_chk" CHECK (
    "resultCode" IN ('COMMITTED','NOOP_ALREADY_APPLIED','CONFLICT','STALE_BASELINE','NEEDS_RECONCILIATION','FAILED_ZERO_WRITE','RECOVERED_COMMITTED','MANUAL_REVIEW','SUPERSEDED','CANCELLED')
  ),
  CONSTRAINT "ControlledConfigExecutionResult_semantics_chk" CHECK (
    ("resultCode" = 'COMMITTED' AND "semantics" = 'SANDBOX_CONFIG_MUTATION_COMMITTED')
    OR ("resultCode" = 'NOOP_ALREADY_APPLIED' AND "semantics" = 'SANDBOX_CONFIG_ALREADY_APPLIED_NO_WRITE')
    OR ("resultCode" = 'CONFLICT' AND "semantics" = 'SANDBOX_CONFIG_MUTATION_CONFLICT_NO_WRITE')
    OR ("resultCode" = 'STALE_BASELINE' AND "semantics" = 'SANDBOX_CONFIG_STALE_BASELINE_NO_WRITE')
    OR ("resultCode" = 'NEEDS_RECONCILIATION' AND "semantics" = 'SANDBOX_CONFIG_MUTATION_NEEDS_RECONCILIATION')
    OR ("resultCode" = 'FAILED_ZERO_WRITE' AND "semantics" = 'SANDBOX_CONFIG_MUTATION_FAILED_ZERO_WRITE')
    OR ("resultCode" = 'RECOVERED_COMMITTED' AND "semantics" = 'SANDBOX_CONFIG_MUTATION_RECOVERED_COMMITTED')
    OR ("resultCode" = 'MANUAL_REVIEW' AND "semantics" = 'SANDBOX_CONFIG_MUTATION_MANUAL_REVIEW')
    OR ("resultCode" = 'SUPERSEDED' AND "semantics" = 'SANDBOX_CONFIG_MUTATION_SUPERSEDED')
    OR ("resultCode" = 'CANCELLED' AND "semantics" = 'SANDBOX_CONFIG_MUTATION_CANCELLED')
  ),
  -- post identity 只能「完整已知」或「完整 UNKNOWN（= 两列都为 null）」，
  -- 禁止只写一半；CAS 异常等 unknown-outcome 场景必须是 null。
  CONSTRAINT "ControlledConfigExecutionResult_post_identity_chk" CHECK (
    ("postConfigFingerprint" IS NULL AND "postConfigVersion" IS NULL)
    OR ("postConfigFingerprint" IS NOT NULL AND "postConfigVersion" IS NOT NULL)
  ),
  -- 契约明确零写的终态不得携带任何 post identity
  CONSTRAINT "ControlledConfigExecutionResult_zero_write_chk" CHECK (
    "resultCode" NOT IN ('CONFLICT','STALE_BASELINE','FAILED_ZERO_WRITE','CANCELLED','SUPERSEDED')
    OR ("postConfigFingerprint" IS NULL AND "postConfigVersion" IS NULL)
  ),
  CONSTRAINT "ControlledConfigExecutionResult_evidence_source_chk" CHECK (
    "evidenceSource" IN ('EXECUTION','READBACK_RECOVERY','STARTUP_RECONCILIATION','MANUAL_OPERATOR')
  )
);

CREATE UNIQUE INDEX "ControlledConfigExecutionResult_reservationId_key"
  ON "ControlledConfigExecutionResult"("reservationId");
CREATE INDEX "ControlledConfigExecutionResult_status_recordedAt_idx"
  ON "ControlledConfigExecutionResult"("status", "recordedAt");
CREATE INDEX "ControlledConfigExecutionResult_resultCode_recordedAt_idx"
  ON "ControlledConfigExecutionResult"("resultCode", "recordedAt");

ALTER TABLE "ControlledConfigExecutionResult"
  ADD CONSTRAINT "ControlledConfigExecutionResult_reservationId_fkey"
  FOREIGN KEY ("reservationId") REFERENCES "ControlledConfigExecutionReservation"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ------------------------------------------------------------
-- 4) transactional outbox
-- ------------------------------------------------------------
CREATE TABLE "ControlledConfigExecutionOutbox" (
  "id" TEXT NOT NULL,
  "reservationId" TEXT NOT NULL,
  "topic" TEXT NOT NULL,
  "eventKey" TEXT NOT NULL,
  "payloadDigest" TEXT NOT NULL,
  "payload" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "dispatchedAt" TIMESTAMP(3),
  "dispatchAttempts" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "ControlledConfigExecutionOutbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ControlledConfigExecutionOutbox_topic_chk" CHECK (
    "topic" IN ('CONTROLLED_CONFIG_EXECUTION_TERMINAL')
  ),
  CONSTRAINT "ControlledConfigExecutionOutbox_attempts_chk" CHECK ("dispatchAttempts" >= 0)
);

CREATE UNIQUE INDEX "ControlledConfigExecutionOutbox_eventKey_key"
  ON "ControlledConfigExecutionOutbox"("eventKey");
CREATE INDEX "ControlledConfigExecutionOutbox_dispatchedAt_createdAt_idx"
  ON "ControlledConfigExecutionOutbox"("dispatchedAt", "createdAt");
CREATE INDEX "ControlledConfigExecutionOutbox_reservationId_createdAt_idx"
  ON "ControlledConfigExecutionOutbox"("reservationId", "createdAt");

ALTER TABLE "ControlledConfigExecutionOutbox"
  ADD CONSTRAINT "ControlledConfigExecutionOutbox_reservationId_fkey"
  FOREIGN KEY ("reservationId") REFERENCES "ControlledConfigExecutionReservation"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ------------------------------------------------------------
-- 5) append-only 消费者交付账本
-- ------------------------------------------------------------
CREATE TABLE "ControlledConfigExecutionDelivery" (
  "id" TEXT NOT NULL,
  "outboxId" TEXT NOT NULL,
  "consumerRef" TEXT NOT NULL,
  "deliveryKey" TEXT NOT NULL,
  "payloadDigest" TEXT NOT NULL,
  "consumedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ControlledConfigExecutionDelivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ControlledConfigExecutionDelivery_deliveryKey_key"
  ON "ControlledConfigExecutionDelivery"("deliveryKey");
CREATE UNIQUE INDEX "ControlledConfigExecutionDelivery_outboxId_consumerRef_key"
  ON "ControlledConfigExecutionDelivery"("outboxId", "consumerRef");
CREATE INDEX "ControlledConfigExecutionDelivery_consumerRef_consumedAt_idx"
  ON "ControlledConfigExecutionDelivery"("consumerRef", "consumedAt");

ALTER TABLE "ControlledConfigExecutionDelivery"
  ADD CONSTRAINT "ControlledConfigExecutionDelivery_outboxId_fkey"
  FOREIGN KEY ("outboxId") REFERENCES "ControlledConfigExecutionOutbox"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ------------------------------------------------------------
-- 6) 状态机守卫：非法跳转 fail-closed；terminal 不得回到非终态；identity 不可原地改写
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION cc_config_execution_transition_guard() RETURNS trigger AS $$
DECLARE
  terminal_old boolean;
  allowed boolean;
BEGIN
  IF NEW."reservationKey" <> OLD."reservationKey"
     OR NEW."immutableBasisDigest" <> OLD."immutableBasisDigest"
     OR NEW."authorizationVerdictDigest" <> OLD."authorizationVerdictDigest"
     OR NEW."authorizationTicketDigest" <> OLD."authorizationTicketDigest"
     OR NEW."planDigest" <> OLD."planDigest"
     OR NEW."candidateDigest" <> OLD."candidateDigest"
     OR NEW."proposalDigest" <> OLD."proposalDigest"
     OR NEW."controlledAdoptionDigest" <> OLD."controlledAdoptionDigest"
     OR NEW."rollbackPlanDigest" <> OLD."rollbackPlanDigest"
     OR NEW."baselineSnapshotDigest" <> OLD."baselineSnapshotDigest"
     OR NEW."baselineConfigFingerprint" <> OLD."baselineConfigFingerprint"
     OR NEW."environment" <> OLD."environment"
     OR NEW."executionMode" <> OLD."executionMode"
     OR NEW."target" <> OLD."target"
     OR NEW."configPath" <> OLD."configPath"
     OR NEW."fromValue" <> OLD."fromValue"
     OR NEW."toValue" <> OLD."toValue"
     OR NEW."idempotencyKey" <> OLD."idempotencyKey"
     OR NEW."idempotencyPayloadDigest" <> OLD."idempotencyPayloadDigest"
     OR NEW."reservationExpiresAt" <> OLD."reservationExpiresAt"
     OR NEW."reservedAt" <> OLD."reservedAt"
  THEN
    RAISE EXCEPTION 'CONFIG_EXECUTION_IDENTITY_IMMUTABLE: reservation identity / immutable basis 不可原地改写'
      USING ERRCODE = '23514';
  END IF;

  terminal_old := OLD."status" NOT IN ('RESERVED','EXECUTING');
  IF terminal_old THEN
    RAISE EXCEPTION 'CONFIG_EXECUTION_TERMINAL_IMMUTABLE: terminal(%) 不得再变更', OLD."status"
      USING ERRCODE = '23514';
  END IF;

  IF NEW."status" <> OLD."status" THEN
    allowed := (OLD."status" = 'RESERVED' AND NEW."status" IN ('EXECUTING','CANCELLED','SUPERSEDED'))
      OR (OLD."status" = 'EXECUTING' AND NEW."status" IN (
            'SUCCEEDED','CONFLICT','STALE_BASELINE','NEEDS_RECONCILIATION',
            'FAILED_CONFIRMED','MANUAL_REVIEW','SUPERSEDED','CANCELLED'));
    IF NOT allowed THEN
      RAISE EXCEPTION 'CONFIG_EXECUTION_ILLEGAL_TRANSITION: % -> %', OLD."status", NEW."status"
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW."executionAttempt" < OLD."executionAttempt" THEN
    RAISE EXCEPTION 'CONFIG_EXECUTION_ATTEMPT_REGRESSION: executionAttempt 不得回退'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "cc_config_execution_status_transition" ON "ControlledConfigExecutionReservation";
CREATE TRIGGER "cc_config_execution_status_transition"
  BEFORE UPDATE ON "ControlledConfigExecutionReservation"
  FOR EACH ROW EXECUTE FUNCTION cc_config_execution_transition_guard();

-- reservation 不可删除（授权身份与执行证据随记录永久保留）
CREATE OR REPLACE FUNCTION cc_no_delete_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'NO_DELETE_TABLE: % rejects %', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "cc_no_delete__ControlledConfigExecutionReservation" ON "ControlledConfigExecutionReservation";
CREATE TRIGGER "cc_no_delete__ControlledConfigExecutionReservation"
  BEFORE DELETE ON "ControlledConfigExecutionReservation"
  FOR EACH ROW EXECUTE FUNCTION cc_no_delete_guard();

-- append-only：事件历史 / 终态结果 / 交付账本
CREATE OR REPLACE FUNCTION cc_append_only_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'APPEND_ONLY_TABLE: % rejects %', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "cc_append_only__ControlledConfigExecutionEvent" ON "ControlledConfigExecutionEvent";
CREATE TRIGGER "cc_append_only__ControlledConfigExecutionEvent"
  BEFORE UPDATE OR DELETE ON "ControlledConfigExecutionEvent"
  FOR EACH ROW EXECUTE FUNCTION cc_append_only_guard();

DROP TRIGGER IF EXISTS "cc_append_only__ControlledConfigExecutionResult" ON "ControlledConfigExecutionResult";
CREATE TRIGGER "cc_append_only__ControlledConfigExecutionResult"
  BEFORE UPDATE OR DELETE ON "ControlledConfigExecutionResult"
  FOR EACH ROW EXECUTE FUNCTION cc_append_only_guard();

DROP TRIGGER IF EXISTS "cc_append_only__ControlledConfigExecutionDelivery" ON "ControlledConfigExecutionDelivery";
CREATE TRIGGER "cc_append_only__ControlledConfigExecutionDelivery"
  BEFORE UPDATE OR DELETE ON "ControlledConfigExecutionDelivery"
  FOR EACH ROW EXECUTE FUNCTION cc_append_only_guard();

-- outbox identity 不可改写（仅允许 dispatchedAt / dispatchAttempts 的投递记账）
CREATE OR REPLACE FUNCTION cc_outbox_identity_immutable_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."reservationId" <> OLD."reservationId"
     OR NEW."topic" <> OLD."topic"
     OR NEW."eventKey" <> OLD."eventKey"
     OR NEW."payloadDigest" <> OLD."payloadDigest"
     OR NEW."payload" <> OLD."payload"
     OR NEW."createdAt" <> OLD."createdAt"
  THEN
    RAISE EXCEPTION 'CONFIG_EXECUTION_OUTBOX_IDENTITY_IMMUTABLE: 只允许 dispatchedAt / dispatchAttempts'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "cc_outbox_identity_immutable__ControlledConfigExecutionOutbox" ON "ControlledConfigExecutionOutbox";
CREATE TRIGGER "cc_outbox_identity_immutable__ControlledConfigExecutionOutbox"
  BEFORE UPDATE ON "ControlledConfigExecutionOutbox"
  FOR EACH ROW EXECUTE FUNCTION cc_outbox_identity_immutable_guard();

-- 回滚（人工）：
--   DROP TRIGGER IF EXISTS ... （本 migration 自建的 5 个触发器）
