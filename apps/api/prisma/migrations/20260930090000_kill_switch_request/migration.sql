-- ============================================================
-- CrossClaim — KillSwitchRequest（MSG-20260929-59 A1 = APPROVED）
-- ------------------------------------------------------------
-- 性质：纯扩展。新增 2 个枚举、1 张表、5 个索引（含 1 个部分唯一索引）、
--       1 个租户触发器（27 -> 28）。零数据回填、零既有表/字段改动。
-- 依据：KILL-SWITCH-MIGRATION-REQUEST.md §2（DDL）+ MSG-20260929-58/59 裁决。
-- 说明：部分唯一索引无法用 Prisma schema 表达，因此以原生 SQL 写在迁移里
--       （与 20260929060000_claim_source_fingerprint 同一惯例）。
-- ============================================================

-- 1) 枚举（MSG-20260929-57 D1：target 枚举化；D4：拉闸同样走请求生命周期）
CREATE TYPE "KillSwitchTarget" AS ENUM ('ENABLED', 'DISABLED');
CREATE TYPE "KillSwitchRequestState" AS ENUM ('PENDING_ENABLE', 'APPLIED', 'EXPIRED', 'CANCELLED');

-- 2) 表（控制面请求事实；不承载资金语义）
CREATE TABLE "KillSwitchRequest" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "target" "KillSwitchTarget" NOT NULL,
    "state" "KillSwitchRequestState" NOT NULL DEFAULT 'PENDING_ENABLE',
    "reasonCode" TEXT NOT NULL,
    "note" TEXT,
    "requestedBy" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "confirmedBy" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "appliedAt" TIMESTAMP(3),
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KillSwitchRequest_pkey" PRIMARY KEY ("id")
);

-- 3) 幂等与租户复合键（C-0002 CHANGE #2 契约：(organizationId, id) 复合唯一）
CREATE UNIQUE INDEX "KillSwitchRequest_organizationId_idempotencyKey_key"
  ON "KillSwitchRequest"("organizationId", "idempotencyKey");
CREATE UNIQUE INDEX "KillSwitchRequest_organizationId_id_key"
  ON "KillSwitchRequest"("organizationId", "id");

-- 4) 查询索引
CREATE INDEX "KillSwitchRequest_organizationId_scope_state_idx"
  ON "KillSwitchRequest"("organizationId", "scope", "state");
CREATE INDEX "KillSwitchRequest_expiresAt_idx"
  ON "KillSwitchRequest"("expiresAt");

-- 4-b) 同租户同 scope 仅允许一条 PENDING_ENABLE（部分唯一索引）
CREATE UNIQUE INDEX "kill_switch_request_pending_unique"
  ON "KillSwitchRequest"("organizationId", "scope")
  WHERE "state" = 'PENDING_ENABLE';

-- 5) 外键（租户根）
ALTER TABLE "KillSwitchRequest" ADD CONSTRAINT "KillSwitchRequest_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 6) 租户完整性触发器（27 -> 28）
--    KillSwitchRequest 的唯一外键指向租户根 "Organization"，表内没有跨表 tenant 引用，
--    因此调用既有校验函数时**没有 (fk_column, ref_table) 参数对**（不新建函数，
--    沿用 crossclaim_assert_tenant_integrity；MSG-20260929-59 A1「新租户触发器」）。
CREATE TRIGGER cc_tenant_kill_switch_request
  BEFORE INSERT OR UPDATE ON "KillSwitchRequest"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity();

-- ------------------------------------------------------------------
-- 迁移后校验（MSG-20260929-59 执行阶段验收）：
--   1) 触发器数量 = 28：
      -- select count(*) from pg_trigger where tgname like 'cc_tenant%';
--   2) 部分唯一索引存在：
      -- select indexname from pg_indexes where tablename = 'KillSwitchRequest';
--      -- 应含 kill_switch_request_pending_unique
--   3) 零既有行改动（纯新增表，无需回填）
--
-- 回滚（人工执行；MSG-20260929-59 A3 = APPROVED_WITH_NOTE）：
--   当前迁移**尚未被运行时调用**，rollback 不影响业务事实，纯 DROP 即可：
--   1) DROP TRIGGER IF EXISTS cc_tenant_kill_switch_request ON "KillSwitchRequest";
--   2) DROP TABLE IF EXISTS "KillSwitchRequest";
--   3) DROP TYPE IF EXISTS "KillSwitchRequestState";
--   4) DROP TYPE IF EXISTS "KillSwitchTarget";
--   NOTE: 一旦 POST /admin/kill-switch（幂等请求 / 审批流程）进入生产使用，
--     回滚策略必须升级为：disable code path -> export pending requests -> migration rollback，
--     不允许直接 DROP。
-- ============================================================
