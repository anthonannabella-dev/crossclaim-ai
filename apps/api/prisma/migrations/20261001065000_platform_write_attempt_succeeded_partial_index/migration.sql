-- ============================================================
-- CrossClaim — PlatformWriteAttempt SUCCEEDED 唯一性兜底（C3 / M3）
-- ------------------------------------------------------------
-- 依据：MSG-20261001-18 裁决②「批准对 SUCCEEDED 唯一性增加 partial unique index；
--       同时保留应用层状态机/CAS；索引冲突必须转换成稳定业务错误或幂等结果」。
-- 说明：partial unique index 无法用 Prisma schema 表达，因此以原生 SQL 写在迁移里
--       （与 20260930090000_kill_switch_request 的 kill_switch_request_pending_unique 同一惯例）。
-- 性质：纯新增索引；零数据改动、零既有对象改动。
-- ============================================================

CREATE UNIQUE INDEX "platform_write_attempt_succeeded_unique"
  ON "PlatformWriteAttempt" ("organizationId", "idempotencyKey")
  WHERE "status" = 'SUCCEEDED';

-- 回滚（人工）：DROP INDEX IF EXISTS "platform_write_attempt_succeeded_unique";
