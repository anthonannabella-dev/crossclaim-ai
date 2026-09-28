-- 操作日志串联优化: 给 AuditLog 增加 entityType / entityId 关联列,
-- 使"按提单 / 按申报单 / 按批次"精确反查操作流水成为可能(替代旧的 detail 文本模糊匹配)。
-- 向后兼容: 两列均可空, 存量日志 entityId 为 NULL 时由读接口回退到 detail LIKE 匹配。

-- 1. 加列
ALTER TABLE "AuditLog" ADD COLUMN IF NOT EXISTS "entityType" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN IF NOT EXISTS "entityId"   TEXT;

-- 2. 复合索引: 支撑 (tenantId, entityType, entityId) 的按实体检索
CREATE INDEX IF NOT EXISTS "AuditLog_tenantId_entityType_entityId_idx"
  ON "AuditLog" ("tenantId", "entityType", "entityId");

-- 3. (可选) 存量回填: 归档类日志 detail 形如 "自动归档: <提单号> | ...",
--    尝试把提单号回填到 entityId, 便于历史数据也能按票串联。
UPDATE "AuditLog"
SET "entityType" = 'bill_of_lading',
    "entityId"   = trim(split_part(split_part("detail", ':', 2), '|', 1))
WHERE "action" = 'batch_group_archived'
  AND "entityId" IS NULL
  AND "detail" LIKE '%:%';
