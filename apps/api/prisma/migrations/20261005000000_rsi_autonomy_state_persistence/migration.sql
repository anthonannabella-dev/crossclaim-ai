-- RSI-RT-06 RSI 自治运行时状态持久化（SCHEMA DELTA）；裁定 MSG-20261005-01 = PASS WITH REVISE（RSI_SCHEMA_DELTA = APPROVED_WITH_REVISIONS）
-- 生成方式：prisma migrate diff（一次性库先应用全部既有 migration → 当前 schema.prisma），只含 RSI-RT-06 新表。
-- 本文件为 create-only draft：**未执行 migrate deploy**（migration applied = NO），未接触 dev / shared / production 库。
-- 结构安全：8 张新表 + 索引 + 外键 + CHECK 约束 + 触发器；无 DROP、无列改型、无数据改写、无 PostgreSQL enum 创建。
-- 平台级：无 organizationId / tenantId / customerId，不保存客户数据、客户授权、凭据或 token（MSG-20261005-01 ①）。
-- 生命周期：TEXT + CHECK，值域与 apps/api/src/services/autonomy/rsi-lifecycle.ts 单源一致（MSG-20261005-01 ③）。
-- 证据完整性：MetricResult / PromotionDecision / RollbackRecord append-only；PromotionDecision judgeRef <> candidate.builderRef（MSG-20261005-01 ④）。
-- CreateTable
CREATE TABLE "AutonomyIncident" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "riskClass" TEXT NOT NULL,
    "sourceRefs" JSONB NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutonomyIncident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutonomyTask" (
    "id" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'READY',
    "riskClass" TEXT NOT NULL,
    "ownerGateRequired" BOOLEAN NOT NULL DEFAULT false,
    "dedupeKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutonomyTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutonomyCandidate" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CREATED',
    "builderRef" TEXT NOT NULL,
    "baselineRef" TEXT NOT NULL,
    "codeCommitRef" TEXT,
    "promptVersion" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutonomyCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutonomyEvaluationRun" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutonomyEvaluationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutonomyMetricResult" (
    "id" TEXT NOT NULL,
    "evaluationRunId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "value" DECIMAL(18,6) NOT NULL,
    "unit" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersedesId" TEXT,

    CONSTRAINT "AutonomyMetricResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutonomyPromotionDecision" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "judgeRef" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL,
    "supersedesId" TEXT,

    CONSTRAINT "AutonomyPromotionDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutonomyRollbackRecord" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "targetRef" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "triggeredBy" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersedesId" TEXT,

    CONSTRAINT "AutonomyRollbackRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutonomyLease" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "ownerRef" TEXT NOT NULL,
    "acquiredAt" TIMESTAMP(3) NOT NULL,
    "renewedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutonomyLease_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AutonomyIncident_status_detectedAt_idx" ON "AutonomyIncident"("status", "detectedAt");

-- CreateIndex
CREATE INDEX "AutonomyIncident_kind_detectedAt_idx" ON "AutonomyIncident"("kind", "detectedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AutonomyIncident_dedupeKey_key" ON "AutonomyIncident"("dedupeKey");

-- CreateIndex
CREATE INDEX "AutonomyTask_incidentId_status_idx" ON "AutonomyTask"("incidentId", "status");

-- CreateIndex
CREATE INDEX "AutonomyTask_status_createdAt_idx" ON "AutonomyTask"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AutonomyTask_dedupeKey_key" ON "AutonomyTask"("dedupeKey");

-- CreateIndex
CREATE INDEX "AutonomyCandidate_taskId_status_idx" ON "AutonomyCandidate"("taskId", "status");

-- CreateIndex
CREATE INDEX "AutonomyCandidate_builderRef_createdAt_idx" ON "AutonomyCandidate"("builderRef", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AutonomyCandidate_dedupeKey_key" ON "AutonomyCandidate"("dedupeKey");

-- CreateIndex
CREATE INDEX "AutonomyEvaluationRun_candidateId_kind_startedAt_idx" ON "AutonomyEvaluationRun"("candidateId", "kind", "startedAt");

-- CreateIndex
CREATE INDEX "AutonomyEvaluationRun_status_startedAt_idx" ON "AutonomyEvaluationRun"("status", "startedAt");

-- CreateIndex
CREATE INDEX "AutonomyMetricResult_evaluationRunId_name_recordedAt_idx" ON "AutonomyMetricResult"("evaluationRunId", "name", "recordedAt");

-- CreateIndex
CREATE INDEX "AutonomyPromotionDecision_candidateId_decidedAt_idx" ON "AutonomyPromotionDecision"("candidateId", "decidedAt");

-- CreateIndex
CREATE INDEX "AutonomyPromotionDecision_decision_decidedAt_idx" ON "AutonomyPromotionDecision"("decision", "decidedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AutonomyPromotionDecision_dedupeKey_key" ON "AutonomyPromotionDecision"("dedupeKey");

-- CreateIndex
CREATE INDEX "AutonomyRollbackRecord_candidateId_recordedAt_idx" ON "AutonomyRollbackRecord"("candidateId", "recordedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AutonomyLease_taskId_key" ON "AutonomyLease"("taskId");

-- CreateIndex
CREATE INDEX "AutonomyLease_status_expiresAt_idx" ON "AutonomyLease"("status", "expiresAt");

-- AddForeignKey
ALTER TABLE "AutonomyTask" ADD CONSTRAINT "AutonomyTask_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "AutonomyIncident"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutonomyCandidate" ADD CONSTRAINT "AutonomyCandidate_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "AutonomyTask"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutonomyEvaluationRun" ADD CONSTRAINT "AutonomyEvaluationRun_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "AutonomyCandidate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutonomyMetricResult" ADD CONSTRAINT "AutonomyMetricResult_evaluationRunId_fkey" FOREIGN KEY ("evaluationRunId") REFERENCES "AutonomyEvaluationRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutonomyPromotionDecision" ADD CONSTRAINT "AutonomyPromotionDecision_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "AutonomyCandidate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutonomyRollbackRecord" ADD CONSTRAINT "AutonomyRollbackRecord_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "AutonomyCandidate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutonomyLease" ADD CONSTRAINT "AutonomyLease_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "AutonomyTask"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================
-- RSI-RT-06 SCHEMA DELTA（MSG-20261005-01 = PASS WITH REVISE）
-- 在 Prisma 生成的结构之上，只补 DB 级不变量；全部为 ADD CONSTRAINT / CREATE TRIGGER，
-- 不删除任何表、不改列型、不导出任何数据、不新建 PostgreSQL 类型。
--   1) 生命周期状态 TEXT + CHECK —— 值域与 apps/api/src/services/autonomy/rsi-lifecycle.ts 单源一致
--   2) 关键身份字段非空
--   3) lease 时间单调（expiresAt > acquiredAt，renewedAt >= acquiredAt）
--   4) 证据表 append-only：cc_append_only__Autonomy{MetricResult,PromotionDecision,RollbackRecord}
--   5) PromotionDecision fail-closed：judgeRef <> candidate.builderRef
-- RSI_PLATFORM_SCOPE_EXCEPTION = APPROVED：本组表非业务租户表，无 organizationId，
-- 因此不需要（也不允许）cc_tenant_immutable__* / cc_tenant_* 触发器。
-- ============================================================

ALTER TABLE "AutonomyIncident"
  ADD CONSTRAINT "AutonomyIncident_status_chk"
  CHECK ("status" IN ('OPEN', 'DIAGNOSED', 'TASKED', 'CLOSED', 'REJECTED'));

ALTER TABLE "AutonomyIncident"
  ADD CONSTRAINT "AutonomyIncident_risk_class_chk"
  CHECK ("riskClass" IN ('LOW', 'MEDIUM', 'HIGH'));

ALTER TABLE "AutonomyIncident"
  ADD CONSTRAINT "AutonomyIncident_dedupe_key_shape_chk"
  CHECK (length("dedupeKey") > 0);

ALTER TABLE "AutonomyTask"
  ADD CONSTRAINT "AutonomyTask_status_chk"
  CHECK ("status" IN ('READY', 'IN_PROGRESS', 'CANDIDATE_READY', 'VALIDATED', 'JUDGED', 'PROMOTED', 'REJECTED', 'BLOCKED'));

ALTER TABLE "AutonomyTask"
  ADD CONSTRAINT "AutonomyTask_risk_class_chk"
  CHECK ("riskClass" IN ('LOW', 'MEDIUM', 'HIGH'));

ALTER TABLE "AutonomyTask"
  ADD CONSTRAINT "AutonomyTask_dedupe_key_shape_chk"
  CHECK (length("dedupeKey") > 0);

ALTER TABLE "AutonomyCandidate"
  ADD CONSTRAINT "AutonomyCandidate_status_chk"
  CHECK ("status" IN ('CREATED', 'PATCHED', 'SANDBOXED', 'REPLAYED', 'TESTED', 'BENCHMARKED', 'POLICY_CHECKED', 'JUDGED', 'PROMOTED', 'REJECTED'));

ALTER TABLE "AutonomyCandidate"
  ADD CONSTRAINT "AutonomyCandidate_builder_ref_shape_chk"
  CHECK (length("builderRef") > 0);

ALTER TABLE "AutonomyCandidate"
  ADD CONSTRAINT "AutonomyCandidate_dedupe_key_shape_chk"
  CHECK (length("dedupeKey") > 0);

ALTER TABLE "AutonomyEvaluationRun"
  ADD CONSTRAINT "AutonomyEvaluationRun_kind_chk"
  CHECK ("kind" IN ('TEST', 'REPLAY', 'BENCHMARK', 'SECURITY', 'POLICY'));

ALTER TABLE "AutonomyEvaluationRun"
  ADD CONSTRAINT "AutonomyEvaluationRun_status_chk"
  CHECK ("status" IN ('PENDING', 'RUNNING', 'PASSED', 'FAILED', 'INCONCLUSIVE'));

ALTER TABLE "AutonomyMetricResult"
  ADD CONSTRAINT "AutonomyMetricResult_name_shape_chk"
  CHECK (length("name") > 0);

ALTER TABLE "AutonomyMetricResult"
  ADD CONSTRAINT "AutonomyMetricResult_unit_shape_chk"
  CHECK (length("unit") > 0);

ALTER TABLE "AutonomyPromotionDecision"
  ADD CONSTRAINT "AutonomyPromotionDecision_decision_chk"
  CHECK ("decision" IN ('PROMOTED', 'REJECTED', 'ROLLED_BACK'));

ALTER TABLE "AutonomyPromotionDecision"
  ADD CONSTRAINT "AutonomyPromotionDecision_judge_ref_shape_chk"
  CHECK (length("judgeRef") > 0);

ALTER TABLE "AutonomyRollbackRecord"
  ADD CONSTRAINT "AutonomyRollbackRecord_target_ref_shape_chk"
  CHECK (length("targetRef") > 0);

ALTER TABLE "AutonomyRollbackRecord"
  ADD CONSTRAINT "AutonomyRollbackRecord_triggered_by_shape_chk"
  CHECK (length("triggeredBy") > 0);

ALTER TABLE "AutonomyLease"
  ADD CONSTRAINT "AutonomyLease_status_chk"
  CHECK ("status" IN ('ACTIVE', 'EXPIRED', 'RELEASED'));

ALTER TABLE "AutonomyLease"
  ADD CONSTRAINT "AutonomyLease_owner_ref_shape_chk"
  CHECK (length("ownerRef") > 0);

ALTER TABLE "AutonomyLease"
  ADD CONSTRAINT "AutonomyLease_time_order_chk"
  CHECK ("expiresAt" > "acquiredAt" AND "renewedAt" >= "acquiredAt");

-- 证据表 append-only：UPDATE / DELETE 一律拒绝（新事实 = 新记录 + supersedesId）
CREATE OR REPLACE FUNCTION "cc_rsi_evidence_append_only"()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'RSI_EVIDENCE_APPEND_ONLY: RSI evidence facts are append-only; insert a new record with supersedesId';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "cc_append_only__AutonomyMetricResult" ON "AutonomyMetricResult";
CREATE TRIGGER "cc_append_only__AutonomyMetricResult"
  BEFORE UPDATE OR DELETE ON "AutonomyMetricResult"
  FOR EACH ROW EXECUTE FUNCTION "cc_rsi_evidence_append_only"();

DROP TRIGGER IF EXISTS "cc_append_only__AutonomyPromotionDecision" ON "AutonomyPromotionDecision";
CREATE TRIGGER "cc_append_only__AutonomyPromotionDecision"
  BEFORE UPDATE OR DELETE ON "AutonomyPromotionDecision"
  FOR EACH ROW EXECUTE FUNCTION "cc_rsi_evidence_append_only"();

DROP TRIGGER IF EXISTS "cc_append_only__AutonomyRollbackRecord" ON "AutonomyRollbackRecord";
CREATE TRIGGER "cc_append_only__AutonomyRollbackRecord"
  BEFORE UPDATE OR DELETE ON "AutonomyRollbackRecord"
  FOR EACH ROW EXECUTE FUNCTION "cc_rsi_evidence_append_only"();

-- Builder / Judge 分离：PromotionDecision 的判定者不得是该候选的生成者（fail-closed）
CREATE OR REPLACE FUNCTION "cc_rsi_promotion_judge_separation"()
RETURNS TRIGGER AS $$
DECLARE
  builder text;
BEGIN
  SELECT "builderRef" INTO builder FROM "AutonomyCandidate" WHERE "id" = NEW."candidateId";
  IF builder IS NULL THEN
    RAISE EXCEPTION 'RSI_PROMOTION_CANDIDATE_MISSING: candidate % not found', NEW."candidateId";
  END IF;
  IF NEW."judgeRef" = builder THEN
    RAISE EXCEPTION 'RSI_BUILDER_JUDGE_SAME_ACTOR: judgeRef must differ from candidate.builderRef';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "cc_rsi_promotion_judge_separation" ON "AutonomyPromotionDecision";
CREATE TRIGGER "cc_rsi_promotion_judge_separation"
  BEFORE INSERT ON "AutonomyPromotionDecision"
  FOR EACH ROW EXECUTE FUNCTION "cc_rsi_promotion_judge_separation"();

