-- P0 NON_C18_SCHEMA_HISTORY_DRIFT — 向前修复（MSG-20261004-26 指令）
-- 只做两件事：补齐 schema.prisma 已声明但历史未产生的 enum 值；补建缺失索引。
-- 不重写任何历史 migration，不从 PostgreSQL enum 删除任何已进入历史的值（删除 enum 值属破坏性操作）。

-- Channel.PAYMENT_PROCESSOR：当前 schema.prisma 的业务契约，历史 migration 未添加 → 现在向前补上。
ALTER TYPE "Channel" ADD VALUE IF NOT EXISTS 'PAYMENT_PROCESSOR';

-- FeeCalculationSettlement(organizationId, feeChainId)：schema.prisma 声明但历史缺失。
CREATE INDEX IF NOT EXISTS "FeeCalculationSettlement_organizationId_feeChainId_idx"
  ON "FeeCalculationSettlement"("organizationId", "feeChainId");
