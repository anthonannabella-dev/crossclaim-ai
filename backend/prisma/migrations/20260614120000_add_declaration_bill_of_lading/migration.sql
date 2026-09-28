-- 提单管理优化:给 Declaration 增加 billOfLading 列(从 declarationJson 落列),
-- 并建立 (tenantId, billOfLading) 复合索引,使"按提单归集/按提单查询"走索引,
-- 不再扫全表 + 逐行 JSON.parse。

-- 1. 加列
ALTER TABLE "Declaration" ADD COLUMN IF NOT EXISTS "billOfLading" TEXT;

-- 2. 回填存量数据:从 declarationJson 中提取 billOfLading(兼容 transport.billOfLading)
--    仅对"看起来是 JSON 对象"的行尝试解析,空串归一为 NULL,避免脏数据导致整批失败。
UPDATE "Declaration"
SET "billOfLading" = NULLIF(
  COALESCE(
    (("declarationJson")::jsonb ->> 'billOfLading'),
    (("declarationJson")::jsonb -> 'transport' ->> 'billOfLading')
  ), '')
WHERE "billOfLading" IS NULL
  AND "declarationJson" IS NOT NULL
  AND left(btrim("declarationJson"), 1) = '{';

-- 3. 建索引
CREATE INDEX IF NOT EXISTS "Declaration_tenantId_billOfLading_idx"
  ON "Declaration"("tenantId", "billOfLading");
