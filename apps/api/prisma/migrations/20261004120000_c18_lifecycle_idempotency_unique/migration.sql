-- C18 PRODUCTION PERSISTENCE CHECKPOINT FINAL-2（MSG-20261004-30 CHANGE C）
-- 目的：把 provider 生命周期事实的幂等键 (bindingId, event, sourceRef) 下沉为 DB 级不变量，
--       而不是只靠某一个 service 记得先 findFirst()。
-- 形态说明：architect 建议 partial unique index（WHERE "sourceRef" IS NOT NULL）。这里用**等价的普通唯一索引**：
--   · PostgreSQL 对 NULL 视为彼此不同，因此 sourceRef 为空的历史行（例如 binding store 的 BOUND）不会互相冲突，
--     行为与 partial predicate 在本键上一致；
--   · Prisma datamodel 无法表达 partial index，而仓库的 WHOLE_SCHEMA_DIFF_ZERO / EXACT_ORDER_REPLAY 证据要求
--     all migrations + schema.prisma 必须严格对齐。若只在 SQL 里建 partial index，migrate diff 会把它当成
--     「数据库多出来的对象」，直接破坏那两条硬门槛。因此选择 schema.prisma 可表达的等价形式。
--   · 索引名显式给出（48 字符），避免 PostgreSQL 63 字符标识符上限截断（历史上已因此产生 42 条 index rename drift）。
-- 风险面：只新增一个唯一索引，无新表、无列变更、无数据变更、无 DROP。
-- 声明：本 migration **未**在 shared / production 执行；只在一次性 ephemeral 库中用于验证。

CREATE UNIQUE INDEX "CustomsProviderTenantBindingLineage_lifecycle_key"
  ON "CustomsProviderTenantBindingLineage" ("bindingId", "event", "sourceRef");
