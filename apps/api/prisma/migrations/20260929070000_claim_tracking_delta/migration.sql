-- MSG-20260929-23 批准的 Claim Tracking Schema Delta（S1–S5）
-- 性质：纯扩展；全部可空；无回填；不新增/修改触发器（迁移后仍应为 27 个 cc_tenant% 触发器）

-- S2 / S4：按架构方要求枚举化（禁自由文本）
CREATE TYPE "ClaimDeadlineSource" AS ENUM ('PLATFORM_NOTICE', 'USER_INPUT', 'CONTRACT', 'UNKNOWN');
CREATE TYPE "ClaimTerminalReasonCode" AS ENUM ('PLATFORM_DECISION', 'DEADLINE_MISSED', 'INSUFFICIENT_EVIDENCE', 'WITHDRAWN_BY_SELLER', 'DUPLICATE_CLAIM', 'OTHER');

-- S1 平台案件号
ALTER TABLE "Claim" ADD COLUMN "platformCaseRef" TEXT;
-- S2 deadline 来源
ALTER TABLE "Claim" ADD COLUMN "deadlineSource" "ClaimDeadlineSource";
-- S3 人工批准留痕
ALTER TABLE "Claim" ADD COLUMN "approvedByUserId" TEXT;
ALTER TABLE "Claim" ADD COLUMN "approvedAt" TIMESTAMP(3);
-- S4 终局原因
ALTER TABLE "Claim" ADD COLUMN "terminalReasonCode" "ClaimTerminalReasonCode";

-- S5 到期看板查询索引
CREATE INDEX "Claim_organizationId_status_dueAt_idx" ON "Claim"("organizationId", "status", "dueAt");

-- 回滚（人工执行）：
--   DROP INDEX "Claim_organizationId_status_dueAt_idx";
--   ALTER TABLE "Claim" DROP COLUMN "terminalReasonCode";
--   ALTER TABLE "Claim" DROP COLUMN "approvedAt";
--   ALTER TABLE "Claim" DROP COLUMN "approvedByUserId";
--   ALTER TABLE "Claim" DROP COLUMN "deadlineSource";
--   ALTER TABLE "Claim" DROP COLUMN "platformCaseRef";
--   DROP TYPE "ClaimTerminalReasonCode";
--   DROP TYPE "ClaimDeadlineSource";
