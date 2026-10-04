# C18 发现报告 — `schema.prisma` 与 migration history 不一致（非 C18 引入）

> 状态：**OPEN / 等待架构方指令**。本文件只记录事实与证据，**没有**修改任何既有业务真值、没有新增非 C18 migration。
> 发现时间：2026-10-04（C18 MIGRATION SQL AUDIT 的 clean-replay 证据过程中）。
> 关联：`MSG-20261004-25`、GitHub issue #2 comment `5977650278`（C18 MIGRATION SQL FINAL-2）。

## 1. 结论

**仓库当前的 `schema.prisma` 无法由已提交的 migration 历史重现。**

```
all committed migrations + candidate C18 migration
        ≠
current schema.prisma
```

C18 的 migration 在干净基线上**完全一致**（见 §3），差异全部来自 C18 之外的既有变更。

## 2. 证据

在一次性数据库（`crossclaim_c18_proof`，脚本 `work/scripts/c18-clean-replay-proof.mjs`）上按权威顺序重放：

```
CREATE DATABASE <proof>
→ 暂时移出 candidate migration
→ prisma migrate deploy           # 只应用既有 72 个 migrations
→ 放回 candidate
→ psql -f <candidate>/migration.sql
→ prisma migrate diff --from-schema-datasource <proof> --to-schema-datamodel prisma/schema.prisma --script
```

输出：

| 指标 | 结果 |
| --- | --- |
| `C18_SCOPED_DIFF_LINES` | **0**（所有 `CustomsProvider*` 对象与 schema.prisma 完全一致） |
| `PREEXISTING_UNRELATED_DIFF_LINES` | **63**（与 C18 无关） |

一次典型的「干净重放后仍存在」的差异片段（节选自 diff 输出）：

```sql
BEGIN;
CREATE TYPE "Channel_new" AS ENUM ('AMAZON_FBA', 'AMAZON_OTHER', 'UPS', 'FEDEX', 'DHL', 'FREIGHT_FORWARDER', 'INSURANCE', ...);
ALTER TABLE "SourceConnection" ALTER COLUMN "channel" TYPE "Channel_new" USING ("channel"::text::"Channel_new");
ALTER TABLE "ImportBatch"      ALTER COLUMN "channel" TYPE "Channel_new" USING ("channel"::text::"Channel_new");
ALTER TABLE "SourceTransaction" ALTER COLUMN "channel" TYPE "Channel_new" USING ("channel"::text::"Channel_new");
ALTER TABLE "CanonicalFact"    ALTER COLUMN "channel" TYPE "Channel_new" USING ("channel"::text::"Channel_new");
ALTER TABLE "RecoveryOpportunity" ALTER COLUMN "channel" TYPE "Channel_new" USING ("channel"::text::"Channel_new");
ALTER TABLE "RuleSet"          ALTER COLUMN "channel" TYPE "Channel_new" USING ("channel"::text::"Channel_new");
ALTER TYPE "Channel" RENAME TO "Channel_old";
ALTER TYPE "Channel_new" RENAME TO "Channel";
DROP TYPE "Channel_old";
COMMIT;

BEGIN;
CREATE TYPE "RouteTarget_new" AS ENUM (...);
ALTER TABLE "RecoveryRoute" ALTER COLUMN "target" TYPE "RouteTarget_new" USING ("target"::text::"RouteTarget_new");
ALTER TABLE "Claim"         ALTER COLUMN "target" TYPE "RouteTarget_new" USING ("target"::text::"RouteTarget_new");
ALTER TYPE "RouteTarget" RENAME TO "RouteTarget_old";
ALTER TYPE "RouteTarget_new" RENAME TO "RouteTarget";
DROP TYPE "RouteTarget_old";
COMMIT;
```

另有 1 条 `FeeCalculationSettlement` 相关索引差异（`..._organizationId_feeChainId_idx`）。

## 3. 影响

1. **C18 不受影响**：C18 migration 的完整性已用 C18-scoped diff = 0 证明；本 drift 不改变 C18 的 3 enum / 3 表 / 8 索引 / 3 外键 / 5 CHECK / 3 trigger 的正确性。
2. **但 `CLEAN_SHADOW_DIFF = ZERO`（全库）目前不可满足**：clean-replay 的严格全库归零会被这 63 行阻塞，因此架构方要求的硬门槛只能以「C18-scoped = ZERO」形式提供（已提供），全库归零待本 drift 处置后再补。
3. **风险提示**：任何未来用「live DB → datamodel」做的 diff 都会把这 63 行当成"待执行变更"混进结果（本次即因此发生过一次，被过滤后未进入 C18 migration）。若某次 migration 生成未做过滤，可能把 enum 重排这类**改变既有业务真值**的操作写进历史。

## 4. 待架构方裁定（二选一，我方不擅自执行）

- **选项 A（补齐）**：单独开一个 **non-C18** migration，把 `schema.prisma` 中未被 migration 覆盖的改动（Channel / RouteTarget enum 取值集合、FeeCalculationSettlement 索引）正式落为 DDL；此后全库 clean-replay 才能归零。
  - 代价：该 migration 会 **ALTER 既有业务表/枚举**，属于设计变更，需要独立审计与数据兼容性评估（enum 重排是否只是新增取值？是否有存量行落在被删除的取值上？）。
- **选项 B（回滚）**：把 `schema.prisma` 中未被 migration 覆盖的改动回退到与 migration 历史一致（需确认这些改动是否已被其它已合并代码依赖）。
  - 代价：如果已有代码依赖新取值，回退会引入编译/运行期缺口。

## 5. 边界声明

- 本报告与 C18 migration **未在 shared / production 执行任何操作**；唯一一次 apply 发生在一次性 ephemeral 库，脚本结束即 `DROP DATABASE`。
- C18 publication 边界不变：`REAL_TRANSPORT = HOLD`、`EXTERNAL_WRITE = HOLD`、`PAYMENT = HOLD`、`PRODUCTION_ENABLEMENT = HOLD`、`C18 = HOLD_EXTERNAL`、`MIGRATE_DEPLOY = HOLD`。
