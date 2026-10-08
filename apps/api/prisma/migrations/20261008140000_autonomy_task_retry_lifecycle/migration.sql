-- PHASE 1 / C3（MSG-20261008-16 CHANGE 3）—— 客户任务完整生命周期：重试 / 退避 / 上限 / 死信
-- 复用既有 AutonomyTask 作为 durable 任务行（不新增第二套队列表），只补齐生命周期所需字段：
--   attempts / maxAttempts / nextAttemptAt / lastErrorCode / deadLetteredAt
-- 并把 status 检查约束扩展一个死信终态 'DEAD_LETTER'（原有取值全部保留）。

ALTER TABLE "AutonomyTask"
  ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "maxAttempts" INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN "nextAttemptAt" TIMESTAMP(3),
  ADD COLUMN "lastErrorCode" TEXT,
  ADD COLUMN "deadLetteredAt" TIMESTAMP(3);

-- 退避门禁需要按 nextAttemptAt 过滤可领取任务
CREATE INDEX "AutonomyTask_status_nextAttemptAt_idx" ON "AutonomyTask"("status", "nextAttemptAt");

-- 生命周期不变量（DB 层强制，应用层无法绕过）：
--   attempts >= 0；maxAttempts >= 1；attempts <= maxAttempts
ALTER TABLE "AutonomyTask"
  ADD CONSTRAINT "AutonomyTask_attempts_chk" CHECK ("attempts" >= 0 AND "maxAttempts" >= 1 AND "attempts" <= "maxAttempts");

-- 死信终态必须带时间戳（避免出现「已死信但无凭证」）
ALTER TABLE "AutonomyTask"
  ADD CONSTRAINT "AutonomyTask_dead_letter_chk"
  CHECK (("status" = 'DEAD_LETTER') = ("deadLetteredAt" IS NOT NULL));

-- 扩展 status 词表：原取值 + DEAD_LETTER
ALTER TABLE "AutonomyTask"
  DROP CONSTRAINT "AutonomyTask_status_chk";

ALTER TABLE "AutonomyTask"
  ADD CONSTRAINT "AutonomyTask_status_chk"
  CHECK ("status" IN (
    'READY', 'IN_PROGRESS', 'CANDIDATE_READY', 'VALIDATED', 'JUDGED',
    'PROMOTED', 'REJECTED', 'BLOCKED', 'DEAD_LETTER'
  ));
