-- ============================================================
-- CrossClaim · 审计 actor 身份拆分（C-0003 Checkpoint 1 · CHANGE #16）
-- ------------------------------------------------------------
-- 问题：原 AuditLog.actorId 同时承担两种语义 ——
--   (a) USER 时是 User.id（带 FK）
--   (b) SYSTEM / AI / EXTERNAL 时是服务名 / 模型名等自由字符串
-- 结果：actorType = SYSTEM/AI/EXTERNAL 的合法审计写入会因 FK 失败。
--
-- 处理：拆成
--   actorUserId  仅 USER 使用，FK → User.id（保留引用完整性）
--   actorRef     仅 SYSTEM / AI / EXTERNAL 使用，自由字符串
-- 并在数据库层加 CHECK，禁止一个字段同时承担两种语义。
-- ============================================================

ALTER TABLE "AuditLog" ADD COLUMN IF NOT EXISTS "actorUserId" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN IF NOT EXISTS "actorRef" TEXT;

-- 历史数据迁移：原 actorId 只可能是 User.id（受 FK 约束），故并入 actorUserId
UPDATE "AuditLog"
   SET "actorUserId" = "actorId"
 WHERE "actorId" IS NOT NULL
   AND "actorUserId" IS NULL;

-- 非 USER 行不得再挂 User 引用
UPDATE "AuditLog"
   SET "actorUserId" = NULL
 WHERE "actorType" <> 'USER';

ALTER TABLE "AuditLog" DROP CONSTRAINT IF EXISTS "AuditLog_actorId_fkey";
ALTER TABLE "AuditLog" DROP COLUMN IF EXISTS "actorId";

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AuditLog_actorUserId_fkey') THEN
    ALTER TABLE "AuditLog"
      ADD CONSTRAINT "AuditLog_actorUserId_fkey"
      FOREIGN KEY ("actorUserId") REFERENCES "User"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS "AuditLog_actorUserId_idx" ON "AuditLog"("actorUserId");

-- actor 身份形状：USER 只能用 actorUserId；非 USER 只能用 actorRef
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cc_audit_actor_shape_check') THEN
    ALTER TABLE "AuditLog"
      ADD CONSTRAINT cc_audit_actor_shape_check CHECK (
        ("actorType" = 'USER' AND "actorRef" IS NULL)
        OR
        ("actorType" <> 'USER' AND "actorUserId" IS NULL)
      );
  END IF;
END
$$;
