# B2 修复蓝本 — 被引用对象归属变更保护（新增迁移）

> 依据：架构方 **MSG-20260930-04**（C-0002 RE-REVIEW = REVISE）第三.B2 项。
> 结论口径：**不作 BLOCK、不回滚已合并 PR**；B2 补修复审前不给完整多租户地基 PASS。
> 纪律：**新增迁移，不改历史迁移**；不再称现有子表触发器为「等价复合外键约束」。

## 1. 现状缺口（待修）

| 缺口 | 说明 |
|---|---|
| 父对象事后改租户 | 触发器只校验**引用行** INSERT/UPDATE 时的租户一致性；父对象（如 `Case`）改 `organizationId` 后，普通外键仍成立（外键只引用 `id`，`@@unique([organizationId,id])` 不会使其变复合外键） |
| RuleSet 所有权漂移 | 同时改 `ownerType`/`ownerKey`/`organizationId` 使新组合满足既有 CHECK，已存在的 `RuleVersion` 不会被重新校验 |

## 2. 迁移设计（新迁移：`20260930xxxxxx_tenant_ownership_immutability`）

### 2.1 通用：tenant-owned 对象禁止改 `organizationId`

```sql
-- 1) 枚举所有含 organizationId 列且非空的表（含未来新增表：函数内动态取）
-- 2) 为每张表挂 BEFORE UPDATE 触发器：OLD.organizationId IS DISTINCT FROM NEW.organizationId → RAISE
CREATE OR REPLACE FUNCTION cc_forbid_tenant_reassignment() RETURNS trigger AS $$
BEGIN
  IF OLD."organizationId" IS DISTINCT FROM NEW."organizationId" THEN
    RAISE EXCEPTION 'TENANT_REASSIGNMENT_FORBIDDEN: % cannot change organizationId', TG_TABLE_NAME
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
```

- 通过 `DO $$ ... FOR r IN SELECT ... FROM information_schema.columns WHERE column_name='organizationId' ...` 生成 `CREATE TRIGGER`（命名 `cc_tenant_immutable__<table>`），**幂等**：先 `DROP TRIGGER IF EXISTS` 再建。
- 例外白名单：无（如业务确需转移，另提架构方案）。
- 迁移必须能在**全新库**与**已有库**两条路径执行（`IF NOT EXISTS` / `DROP ... IF EXISTS`）。

### 2.2 RuleSet 所有权身份不可变更

```sql
CREATE OR REPLACE FUNCTION cc_forbid_ruleset_ownership_change() RETURNS trigger AS $$
BEGIN
  IF OLD."ownerType" IS DISTINCT FROM NEW."ownerType"
     OR OLD."ownerKey" IS DISTINCT FROM NEW."ownerKey"
     OR OLD."organizationId" IS DISTINCT FROM NEW."organizationId" THEN
    RAISE EXCEPTION 'RULESET_OWNERSHIP_IMMUTABLE';  -- 禁止 SYSTEM↔TENANT 静默转换
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
```

## 3. 验收测试矩阵（真实 PostgreSQL，落 `apps/api/src/__tests__/`）

| # | 断言 | 方法 |
|---|---|---|
| T1 | 有引用对象后，父对象改租户被数据库拒绝 | 建 A 租户 `Case` + 引用它的 A 租户 `Claim` → `UPDATE "Case" SET "organizationId"=B` → 期望 `TENANT_REASSIGNMENT_FORBIDDEN` 且 Case 未变更 |
| T2 | RuleSet 所有权变更不使已有版本/引用串租户 | 建 A 租户 RuleSet + RuleVersion → 尝试改 `ownerType/ownerKey/organizationId` → 期望 `RULESET_OWNERSHIP_IMMUTABLE` |
| T3 | 跨租户 INSERT/UPDATE 被拒、同租户更新正常 | 跨租户引用建行 → 拒绝；同租户改非租户字段 → 成功 |
| T4 | 租户合法引用 SYSTEM 规则仍正常 | SYSTEM RuleSet 被 A 租户引用 → 建/读成功 |
| T5 | 并发下不能绕过归属约束 | 两个并发事务（一个改父租户、一个插入引用）→ 至少一个失败且无跨租户残留 |
| T6 | 全新库迁移 / 现有库升级均通过 | `migrate deploy` 于空库 + 于已有库各跑一次，验证 `cc_tenant_immutable__*` 触发器数量与既有 28 个 `cc_tenant` 触发器共存 |

## 4. 同步的文档纠偏（本 PR 一并提交）

- `AI-ARCHITECT-INBOX.md` 已归档裁决原文（MSG-20260930-04，FULL_COPY_OK）。
- `FINAL-PRODUCTION-GATE-REVIEW.md` / `ARCHITECTURE_CONTRACT.md`：把「现有触发器 = 等价复合外键约束」的表述改为「引用行写入时校验 + 本次新增归属不可变约束」，并记录 B1「当时 REVISE、后来修复」、B3「许可证闸门曾扫描空转（当前已修）」。

## 5. 风险与回滚

- 风险：既有数据若已存在跨租户引用，迁移本身不改数据（只加约束）；发现历史脏数据时单独出清理方案，不在本迁移内自动修改。
- 回滚：删除新增触发器与函数即可（不涉及列/数据变更）。
