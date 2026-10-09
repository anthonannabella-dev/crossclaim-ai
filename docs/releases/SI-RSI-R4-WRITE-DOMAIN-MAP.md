# SI-RSI-R4-WRITE-DOMAIN-MAP（R5 修订版）

> 授权：`PHASE3_A_U2_PRECONDITION_R5_READ_ONLY_CLOSURE`（按 MSG-20261009-50 的 CHANGE 94 修订 R4-03）。
> 基线：`bbc7536e`；本版**取代** R4 初版对以下三点的表述：①写入路径清点 ②原生 SQL 写入的绝对断言 ③覆盖声明。
> 映射：`WRITE_DOMAIN → ENTRY_POINT → SERVICE → TRANSACTION → DATABASE_OBJECT → FENCE_PROTECTION`。

---

## 0. 修订摘要（CHANGE 94）

| 修订项 | R4 初版 | 本版（v2） |
| --- | --- | --- |
| 写入路径完整性 | 仅列 claim / reclaimExpired / settle | **新增 `fail()` / `renew()` / `rsi-restart-reconcile`**（见 §1） |
| 原生 SQL 写入 | 断言「`apps/api/src` 不存在原始 SQL 写入」 | **该绝对断言不成立，予以更正**（见 §2） |
| 覆盖声明 | 隐含"RSI 全入口已列举" | **`RSI_CORE_PATHS_MAPPED_PARTIAL · ALL_REPO_WRITERS_NOT_EXHAUSTIVELY_PROVEN`** |

---

## 1. RSI / Autonomy 域（含 CHANGE 94 补齐项）

| 写入域 | 入口/模块（仓库证据） | 事务 | 数据库对象与操作 | 现有保护 |
| --- | --- | --- | --- | --- |
| **claim** | `runtime/rsi-durable-task-source.ts:234-276` | **显式 `$transaction`** | `AutonomyTask.updateMany`（`READY→IN_PROGRESS`，`cas.count!==1` 即已被领取）+ `AutonomyLease.upsert`（`ownerRef/acquiredAt/renewedAt/expiresAt/status='ACTIVE'`） | CAS + 同事务租约 |
| **授权前置拒绝** | 同上 `:231-239` | **无显式事务** | `AutonomyTask.updateMany`（`READY→BLOCKED` + `lastErrorCode`） | 状态前置条件 CAS（**非事务**） |
| **reclaimExpired** | `:295-321` | **显式 `$transaction`（两步 CAS）** | `AutonomyLease.updateMany`（`ACTIVE AND expiresAt<=now → EXPIRED`）+ `AutonomyTask.updateMany`（`IN_PROGRESS→READY`） | 状态/时间前置条件 CAS；注释声明幂等 |
| **settle** | `:328-392` | **显式 `$transaction`** | `AutonomyLease.updateMany`（`ACTIVE AND ownerRef AND expiresAt>now → RELEASED`）+ `AutonomyTask.updateMany`（`IN_PROGRESS→PROMOTED/BLOCKED`） | **C2 fencing**：`FENCED_OWNER_MISMATCH` / `FENCED_LEASE_EXPIRED` / `FENCED_LEASE_RACE` + 终局事实门禁 |
| **`fail()`（CHANGE 94 新增）** | `:397-438` | **显式 `$transaction`** | ①读 `AutonomyLease`（缺失/非 ACTIVE/owner 不符/过期 ⇒ 拒绝）②读 `AutonomyTask`（非 `IN_PROGRESS` ⇒ `TASK_STATE_CONFLICT`）③`AutonomyLease.updateMany`（CAS 释放 → `RELEASED`，`FENCED_LEASE_RACE`）④`AutonomyTask.updateMany`（CAS：`IN_PROGRESS → READY / DEAD_LETTER`，写 `attempts+1`、`lastErrorCode`、`nextAttemptAt`、`deadLetteredAt`） | **同事务内两次 CAS**（租约 + 任务）；失败路径不产生部分写入 |
| **`renew()`（CHANGE 94 新增）** | `:440-459` | **无显式 `$transaction`**（read-then-CAS） | `AutonomyLease.findUnique` → `AutonomyLease.updateMany`（`ACTIVE AND ownerRef AND expiresAt>now → expiresAt+=leaseMs`，`FENCED_LEASE_RACE`） | CAS（单语句原子），但**读取不在事务内**（须在 R5/P3 中标注为需验证项） |
| **`rsi-restart-reconcile`（CHANGE 94 新增）** | `runtime/rsi-restart-reconcile.ts:1-19`（契约）+ 注入式 `RsiReconcileStore` | **由 store 侧「带状态前置条件的 update」保证幂等**（重复运行 = 0 行更新）；模块自身**不创建/删除任何行** | 规则：`ACTIVE` 未过期 → **不动**；`ACTIVE` 已过期 → 标 `EXPIRED` + 任务 `IN_PROGRESS→READY`；`EXPIRED/RELEASED` + `IN_PROGRESS` → `READY`；`IN_PROGRESS` 无 lease（claim 与 lease 之间崩溃窗口）→ `READY`；终态/未知 → 不动；同 `dedupeKey` 多个未终态 → **只上报** | 状态前置条件 CAS；**无 generation 语义**（租约代际关系未定义 ⇒ 缺口） |
| **U2 候选写入（计划中）** | **尚不存在** | 设计：`$transaction` + `FENCE_CONTRACT` | `AutonomyCandidate`（`INSERT ... ON CONFLICT (dedupeKey) DO NOTHING`） | **`NOT_IMPLEMENTED`** |

**RSI 域保护语义总结（不变）**：现有保护基于 **`ownerRef + status + expiresAt` + 受影响行数**；**没有 `fenceGeneration` 单调版本**。

---

## 2. 原生 SQL 写入：更正（CHANGE 94）

**R4 初版的绝对断言（`apps/api/src` 不存在原始 SQL 写入）不成立**，原因有二：

1. 审计方指出仓库实施记录明确记载 **`fault-incident-intake.ts` 使用 `INSERT ... ON CONFLICT` 原子 upsert**；
2. 只读检索确认 `apps/api/src` 中存在多处原始 SQL（示例，非穷举）：
   - `server.ts:516,519`（`$queryRaw`，readiness）；
   - `services/appeals/appeal-submission.ts:125,132`、`services/claims/claim-submission.ts:130,135`、`services/claims/claim-preparation.ts:152,165`（`$executeRawUnsafe` + `$queryRawUnsafe`，行锁/状态）；
   - `services/config-execution-durability/prisma-durable-store.ts:121,152`；
   - `services/billing/invoice-issue.ts:129`（**`pg_advisory_xact_lock`**）、`billing-draft.ts:142,155,162`；
   - `services/consistency/financial-chain-checker.ts`（多处只读）。

**结论**：只能用**范围限定**的表述，不得用关键词检索的"未命中"去证明整个目录不存在某种写入。

```text
COVERAGE_STATEMENT（v2，取代 R4 初版）:
  RSI_CORE_PATHS_MAPPED_PARTIAL
  ALL_REPO_WRITERS_NOT_EXHAUSTIVELY_PROVEN
```

**附带发现（对载体评估有直接价值）**：`services/billing/invoice-issue.ts:129` 在 `$transaction` 内使用
`pg_advisory_xact_lock(hashtext(organizationId + ':' + feeCalculationId)::bigint)` 作为**纵深防御锁键**——
即仓库内**已存在**「以稳定业务身份为键的数据库端事务级互斥」先例（详见 R5 载体比较文档）。

---

## 3. 其他业务写入域（不完整清点；用于 E-02）

Claims / Claim items / Billing / Appeals / Commercial / Acquisition / Audit 横切（代表文件同 R4 初版），
以及新增确认的 `config-execution-durability`（`prisma-durable-store`）与 `consistency`（只读校核）。

**仓库外写入者**（DBA 手工、外部脚本、复制、运维作业、外部 worker）一律 **`WAITING_ON_HOST_EVIDENCE`**（E-02/E-12）。

---

## 4. 边界

本版为**只读勘验 + 文档修订**：未连接任何数据库、未执行任何查询、未运行实验、未修改产品代码、未启动业务调度器/Runtime/OS 定时任务。
