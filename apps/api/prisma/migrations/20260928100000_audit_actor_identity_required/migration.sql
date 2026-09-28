-- ============================================================
-- CrossClaim · 审计 actor 身份必须存在（C-0003 Checkpoint 1 · CHANGE #27）
-- ------------------------------------------------------------
-- 上一版的 CHECK 只约束了「互斥」：
--   USER        → actorRef IS NULL
--   非 USER     → actorUserId IS NULL
-- 但没有要求「必须存在」，于是绕过应用层后数据库仍允许：
--   USER + actorUserId NULL + actorRef NULL      （无身份，且躲过 membership 触发器）
--   SYSTEM/AI/EXTERNAL + actorRef NULL           （无身份）
--
-- 本迁移把约束收紧为与应用层规则等价：
--   USER            → actorUserId IS NOT NULL 且 actorRef IS NULL
--   SYSTEM/AI/EXTERNAL → actorUserId IS NULL 且 actorRef IS NOT NULL
-- ============================================================

ALTER TABLE "AuditLog" DROP CONSTRAINT IF EXISTS cc_audit_actor_shape_check;

ALTER TABLE "AuditLog"
  ADD CONSTRAINT cc_audit_actor_shape_check CHECK (
    ("actorType" = 'USER' AND "actorUserId" IS NOT NULL AND "actorRef" IS NULL)
    OR
    ("actorType" <> 'USER' AND "actorUserId" IS NULL AND "actorRef" IS NOT NULL)
  );
