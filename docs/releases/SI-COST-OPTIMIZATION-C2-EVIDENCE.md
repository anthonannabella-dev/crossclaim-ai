# SI-COST-OPTIMIZATION C2 —— 实施证据（durable ledger / 分级预算 / 缓存 / race 防线）

> 授权：MSG-20261005-30（3.1=A / 3.2=B / 3.3=A / 3.4=A / 3.5=A）+ MSG-20261005-33（C1 CLOSED，C2 IMPLEMENTATION 授权）
> 范围：`AiCostLedgerEntry` + `AiBudgetPolicy` + `AiModelCacheEntry` + tenant/append-only 触发器 + 清单同步 +
>      ledger-derived usage + Budget race 防线 + 真实 PostgreSQL 回归
> 边界：`REAL_MODEL_NETWORK / PAID_MODEL_CALLS / EXTERNAL_WRITE / PAYMENT / TRANSPORT /
>      PRODUCTION_CREDENTIALS / PRODUCTION_ENABLEMENT = HOLD`；`P2_F / P2_G = HOLD`；`FINAL_ACCEPTANCE_HEAD = 0f7f7ac`

## 1. 交付物

| 文件 | 角色 |
| --- | --- |
| `apps/api/prisma/schema.prisma` | +3 模型（93 → 96）：`AiCostLedgerEntry` / `AiBudgetPolicy` / `AiModelCacheEntry` + `AiBudgetScope` |
| `apps/api/prisma/migrations/20261005070000_si_cost_optimization_c2/migration.sql` | 建表 + 唯一/索引 + 触发器（tenant 基线 / 归属不可变 / 账本 append-only / 缓存 identity 不可改写） |
| `tools/tenant-triggers/required-triggers.json` | +3 条 tenant 基线触发器（organizationId 不可变由规则 3 自动覆盖） |
| `tools/tenant-triggers/append-only-triggers.json` | +`cc_append_only__AiCostLedgerEntry`、+`cc_cache_identity_immutable__AiModelCacheEntry`、+前缀 `cc_cache_identity_immutable__%` |
| `apps/api/src/services/autonomy/si-cost-ledger-store.ts` | append-only 写入（callId 幂等）+ 账本聚合（usage 唯一来源） |
| `apps/api/src/services/autonomy/si-budget-policy-store.ts` | durable 预算配置 + 层级有效预算（只收紧）+ `runGuardedAiCostWrite`（advisory 锁内 check-then-write） |
| `apps/api/src/services/autonomy/si-model-cache-store.ts` | put/get（C1 identity 判定）+ 受控 TTL/GC |
| `apps/api/src/__tests__/si-cost-c2-db.test.ts` | 真实 PostgreSQL 取证（10 例） |
| `apps/api/src/__tests__/architecture-contract.test.ts` | 模型计数同步（76 core / 96 总数） |

## 2. 裁决要点对应

```text
3.1=A  AiCostLedgerEntry = 独立 append-only 成本事实源（callId 幂等唯一；costMicros INTEGER 微单位）
3.2=B  AiBudgetUsage = FORBIDDEN（无 usage 表）；AiBudgetPolicy = durable 配置；usage 只由账本聚合；
       层级 PLATFORM → ORGANIZATION → ACCOUNT → INCIDENT/TASK，子级只能收紧（各字段 min）
3.3=A  AiModelCacheEntry（C2 落地存储层）：identity 唯一键含 organizationId（'' = platform）；
       非 append-only（受控 TTL/GC）；identity/resultDigest 不可原地改写（DB 触发器）
3.4/3.5=A  Necessity Gate 与预算强制同一咽喉（C1 已交付；C2 提供 durable 用量与限额来源）
敏感数据：账本/缓存写入类型中不存在 raw prompt / 模型输出 / 凭据 / 客户敏感 payload 字段
```

## 3. 证据（真实 PostgreSQL，`si-cost-c2-db.test.ts` 10 例）

| 证据 | 断言 | 结果 |
| --- | --- | --- |
| C2_DB1 | 幂等 `callId`：第二次写入 duplicate=true，账本仅 1 条，用量仍为首次值 | PASS |
| C2_DB2 | append-only：`UPDATE` / `DELETE` 均被触发器拒绝（`AI_COST_LEDGER_APPEND_ONLY`），行保留 | PASS |
| C2_DB3 | 重启不归零：新建 PrismaClient 读回同一事实（2_500 micros / 1 条） | PASS |
| C2_DB4 | tenant 隔离：按 `organizationId` 聚合互不串扰（700 vs 300） | PASS |
| C2_DB5 | 层级只收紧：org 5000 不放大 platform 1000（有效 1000）；incident 100 生效 | PASS |
| C2_DB6 | **无 usage 表**（AiBudgetUsage/BudgetUsage/… 查询 = 0）→ usage 只能由账本聚合 | PASS |
| C2_DB7 | 超预算 → 拒绝写入（`AI_BUDGET_DAILY_EXCEEDED`），账本不新增事实 | PASS |
| C2_DB8 | **Budget race 防线**：并发 5 次、限额只允许 2 次 → 恰好写 2 条（advisory 锁串行化），其余全部被拒且理由一致 | PASS |
| C2_DB9 | 缓存 HIT；跨租户/ruleVersion/stale 一律 MISS | PASS |
| C2_DB10 | identity 不可原地改写（触发器拒绝 UPDATE `resultDigest`）；GC 删除过期条目（缓存非 append-only） | PASS |

## 4. 命令与结果

```text
prisma validate                     → valid
prisma migrate deploy               → 80 migrations（20261005070000_si_cost_optimization_c2 已应用）
prisma generate                     → OK
tenant / append-only 触发器官网清单    → 在真实库上执行通过（TENANT_CHECKLIST=OK / APPEND_ONLY_CHECKLIST=OK）
apps/api npx tsc --noEmit           → exit 0
si-cost-c2-db.test.ts               → 10/10 PASS
rsi-* + architecture-contract + C2  → 48 files / 404 tests PASS
```

## 5. 未做（按裁决留待 C3 / 后续）

```text
C3：business-value cost policy（AI_COST_PER_OPPORTUNITY/CASE/SUCCESSFUL_RECOVERY/$1000）+ admin observability 只读投影
     + Cost Safe Mode 语义完整化 + 指标（无真实流量时 NOT_YET_MEASURABLE）
未接运行时：RUNTIME_WIRING = NONE；真实模型网络/付费调用 = HOLD（v1 仅本地仿真 adapter）
```
