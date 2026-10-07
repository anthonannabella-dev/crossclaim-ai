-- ============================================================
-- CrossClaim — AGENT EXPERIENCE LAYER / P3（HOST 2026-10-07 授权）
-- 最小 Goal 持久化：AgentGoal（客户意图）+ AgentGoalRun（执行投影）
--   * **不是** Opportunity / Case / Claim / Evidence / Money / Settlement 的 SSOT
--   * 身份不可改写（org / createdBy / rawUserIntent / normalizedGoal / goalId / startedAt）
--   * 租户保护：cc_tenant_* 基线（Run 带 goalId → AgentGoal 同租户校验）+ cc_tenant_immutable__*
-- tenant / append-only 清单同步：tools/tenant-triggers/*.json
-- 审计件：docs/releases/AGENT-GOAL-PERSISTENCE-DELTA-AUDIT.md
-- ============================================================

CREATE TABLE "AgentGoal" (
  "id"             TEXT         NOT NULL,
  "organizationId" TEXT         NOT NULL,
  "createdBy"      TEXT         NOT NULL,
  "rawUserIntent"  TEXT         NOT NULL,
  "normalizedGoal" JSONB        NOT NULL,
  "status"         TEXT         NOT NULL DEFAULT 'PROPOSED',
  "createdAt"      TIMESTAMP(3) NOT NULL,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AgentGoal_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AgentGoal_status_chk" CHECK (
    "status" IN ('PROPOSED','ADMITTED','RUNNING','COMPLETED','FAILED','CANCELLED')
  ),
  CONSTRAINT "AgentGoal_intent_chk" CHECK (length("rawUserIntent") > 0 AND length("rawUserIntent") <= 600),
  CONSTRAINT "AgentGoal_createdBy_chk" CHECK (length("createdBy") > 0),
  CONSTRAINT "AgentGoal_normalized_chk" CHECK (jsonb_typeof("normalizedGoal") = 'object')
);
CREATE UNIQUE INDEX "AgentGoal_organizationId_id_key" ON "AgentGoal"("organizationId", "id");
CREATE INDEX "AgentGoal_scope_status_idx" ON "AgentGoal"("organizationId", "status", "createdAt");

CREATE TABLE "AgentGoalRun" (
  "id"             TEXT         NOT NULL,
  "organizationId" TEXT         NOT NULL,
  "goalId"         TEXT         NOT NULL,
  "status"         TEXT         NOT NULL DEFAULT 'QUEUED',
  "startedAt"      TIMESTAMP(3) NOT NULL,
  "completedAt"    TIMESTAMP(3),
  "summary"        JSONB,
  "createdAt"      TIMESTAMP(3) NOT NULL,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AgentGoalRun_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AgentGoalRun_status_chk" CHECK (
    "status" IN ('QUEUED','RUNNING','COMPLETED','BLOCKED','FAILED','CANCELLED')
  ),
  CONSTRAINT "AgentGoalRun_terminal_chk" CHECK (
    ("status" IN ('COMPLETED','BLOCKED','FAILED','CANCELLED') AND "completedAt" IS NOT NULL)
    OR ("status" IN ('QUEUED','RUNNING') AND "completedAt" IS NULL)
  )
);
CREATE UNIQUE INDEX "AgentGoalRun_organizationId_id_key" ON "AgentGoalRun"("organizationId", "id");
CREATE INDEX "AgentGoalRun_goal_started_idx" ON "AgentGoalRun"("organizationId", "goalId", "startedAt");

-- ---------- 身份不可改写（修正以新行 / 新 Run 表达） ----------
CREATE OR REPLACE FUNCTION "cc_agent_goal_identity_immutable"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."organizationId" IS DISTINCT FROM OLD."organizationId"
     OR NEW."createdBy"      IS DISTINCT FROM OLD."createdBy"
     OR NEW."rawUserIntent"  IS DISTINCT FROM OLD."rawUserIntent"
     OR NEW."normalizedGoal" IS DISTINCT FROM OLD."normalizedGoal"
     OR NEW."createdAt"      IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'AGENT_GOAL_IDENTITY_IMMUTABLE: goal identity must not be rewritten';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "cc_agent_goal_identity__AgentGoal" ON "AgentGoal";
CREATE TRIGGER "cc_agent_goal_identity__AgentGoal"
  BEFORE UPDATE ON "AgentGoal"
  FOR EACH ROW EXECUTE FUNCTION "cc_agent_goal_identity_immutable"();

CREATE OR REPLACE FUNCTION "cc_agent_goal_run_identity_immutable"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."organizationId" IS DISTINCT FROM OLD."organizationId"
     OR NEW."goalId"        IS DISTINCT FROM OLD."goalId"
     OR NEW."startedAt"     IS DISTINCT FROM OLD."startedAt"
     OR NEW."createdAt"     IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'AGENT_GOAL_RUN_IDENTITY_IMMUTABLE: run identity must not be rewritten';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "cc_agent_goal_run_identity__AgentGoalRun" ON "AgentGoalRun";
CREATE TRIGGER "cc_agent_goal_run_identity__AgentGoalRun"
  BEFORE UPDATE ON "AgentGoalRun"
  FOR EACH ROW EXECUTE FUNCTION "cc_agent_goal_run_identity_immutable"();

-- ---------- tenant 保护（基线 + 归属不可变） ----------
DROP TRIGGER IF EXISTS "cc_tenant_agentgoal" ON "AgentGoal";
CREATE TRIGGER "cc_tenant_agentgoal"
  BEFORE INSERT OR UPDATE ON "AgentGoal"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity();

DROP TRIGGER IF EXISTS "cc_tenant_agentgoalrun" ON "AgentGoalRun";
CREATE TRIGGER "cc_tenant_agentgoalrun"
  BEFORE INSERT OR UPDATE ON "AgentGoalRun"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity('goalId', 'AgentGoal');

DROP TRIGGER IF EXISTS "cc_tenant_immutable__AgentGoal" ON "AgentGoal";
CREATE TRIGGER "cc_tenant_immutable__AgentGoal"
  BEFORE UPDATE ON "AgentGoal"
  FOR EACH ROW EXECUTE FUNCTION cc_forbid_tenant_reassignment();

DROP TRIGGER IF EXISTS "cc_tenant_immutable__AgentGoalRun" ON "AgentGoalRun";
CREATE TRIGGER "cc_tenant_immutable__AgentGoalRun"
  BEFORE UPDATE ON "AgentGoalRun"
  FOR EACH ROW EXECUTE FUNCTION cc_forbid_tenant_reassignment();

-- 回滚（人工）：DROP TRIGGER / DROP TABLE（见上）
