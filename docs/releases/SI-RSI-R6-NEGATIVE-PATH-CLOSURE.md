# SI-RSI-R6-NEGATIVE-PATH-CLOSURE

> 授权：`PHASE3_A_U2_PRECONDITION_R6_READ_ONLY_NEGATIVE_PATH_CLOSURE`（仅处理 CHANGE 98–100 + 隔离实验申请提交前检查）。
> 基线：`531b6dfd`；来源裁决 `MSG-20261009-51`（`CHANGE 98 = P0`、`99 = P1`、`100 = P1`）。
> 本轮**只读**：未修改产品代码、未连接数据库、未运行实验、未启动业务 Runtime/调度器/OS timer。
> 纪律：`INTERNAL_READ_ONLY_WORK_COMPLETE ≠ HOST_EVIDENCE_VERIFIED`；未获运行时证据者一律 `NOT_PROVEN`。

---

## 1. CHANGE 98（P0）—— 事务内负结果路径矩阵

**问题（审计方发现，源码已复核）**：`reclaimExpired()` / `settle()` / `fail()` 中，**第一步 CAS 成功后、第二步 CAS 失败时，事务回调「正常返回」**（`return false` / `return { applied:false, reason:... }`）。
**Prisma 交互式事务中「回调正常返回」不会自动回滚** ⇒ 第一步写入**可能已经提交**而第二步未完成。

| 函数 / 位置 | 步骤序列 | 失败方式 | 现状语义（源码） | 是否存在**部分提交**可能 | 必须的验收断言（S13） |
| --- | --- | --- | --- | --- | --- |
| **`reclaimExpired()`** `rsi-durable-task-source.ts:295-321` | ①`AutonomyLease.updateMany`（`ACTIVE + expiresAt<=now → EXPIRED`）②`AutonomyTask.updateMany`（`IN_PROGRESS → READY`） | **非抛出**：`if (leaseCas.count !== 1) return false;` 与 `return taskCas.count === 1;` | 两步在**同一 `$transaction`** 内，但**第二步失败时回调正常返回** ⇒ 第一步**可能已提交** | **是**（源码可构造） | 断言：**任一「租约 + 任务」双状态转换未整体成功时，不得留下部分提交**（第一步写入必须回滚） |
| **`settle()`** `:328-394` | ①`AutonomyLease.updateMany`（`ACTIVE+ownerRef+expiresAt>now → RELEASED`）②`AutonomyTask.updateMany`（`IN_PROGRESS → PROMOTED/BLOCKED`） | **非抛出**：`if (released.count !== 1) return {applied:false,'FENCED_LEASE_RACE'};` 与 `if (taskCas.count !== 1) return {applied:false,'TASK_STATE_CONFLICT'};` | 同上：第二步失败 ⇒ 租约可能已 `RELEASED` 而任务未转终态 | **是** | 断言：租约释放与任务终态**同生共死**；否则整体回滚 |
| **`fail()`** `:397-438` | ①租约 CAS 释放（`→ RELEASED`）②任务 CAS（`→ READY / DEAD_LETTER`，写 `attempts+1`/`nextAttemptAt`） | **非抛出**：`FENCED_LEASE_RACE` / `TASK_STATE_CONFLICT` | 同上 | **是** | 断言：**不得**出现「租约已 RELEASED 但任务仍 IN_PROGRESS 且 attempts 未递增」的中间态 |
| **`renew()`** `:440-459` | 单步 `updateMany` CAS（`expiresAt += leaseMs`） | **非抛出**：`FENCED_LEASE_RACE` | 单步写入；**无显式事务**（读取在事务外） | 否（单步） | 断言：续租是「全成功或零写入」；读取不在事务内的行为须在实验中确认（U-9） |
| **claim** `:234-276` | ①任务 CAS（`READY→IN_PROGRESS`）②`AutonomyLease.upsert` | **非抛出**：`if (cas.count !== 1) return false;` | 两步同事务；**第一步成功后第二步若失败**（如 upsert 抛错）行为未在文档中定义 | **需验证** | 断言：claim 失败不得留下「IN_PROGRESS 无有效租约」的悬挂任务（注释声明如此，须实验证明） |

**必须区分的两类拒绝（写死）**：

```text
KIND-1 事务尚未发生任何写入的正常拒绝：前置条件不满足 ⇒ 返回 false/{applied:false} —— 允许，无副作用
KIND-2 已经发生写入后的业务失败：第一步已写、第二步失败 ⇒ 【必须整体回滚】，
       不能仅依赖 return false / {applied:false}（Prisma 交互式事务语义：正常返回 ≠ 回滚）
```

**R6 边界（严格遵守）**：本轮**只**完成源码路径与反例矩阵（本表），**不得**实施修复；
修复方案（如改为抛出以触发回滚、或在同一语句内完成两对象转换、或使用可重试的补偿路径）留待**单独授权**。

---

## 2. S13 验收条件（隔离 PostgreSQL 16 实验，**未执行**）

| 编号 | 场景 | 验收断言 |
| --- | --- | --- |
| **S13a** | **部分提交**：人为让第二步 CAS 失败（如并发改动任务状态），第一步 CAS 成功 | **不得**留下部分提交：`lease=EXPIRED/RELEASED` 而 `task` 仍为原状态；或 `task` 已变而 `lease` 未变。任一残留 ⇒ **FAIL** |
| **S13b** | **Reconcile 跨对象竞争**（见 §3） | 旧 reconcile **不得**把已被新执行接管的任务改回 `READY`；出现即 **FAIL** |
| **S13c** | **ABA**：同一 `ownerRef` 在不同实例/重启后重现 | 旧尝试**不得**凭重现的 `ownerRef` 通过身份校验并提交（U-11） |
| **S13d** | **结果未知**（提交结果不可知） | **不得**自动重放任何不可证明幂等的外部副作用；状态必须为 `UNKNOWN`（U-12） |
| **S13e** | **单步不变量**（`renew`） | 续租「全成功或零写入」；读取在事务外的行为须留档 |

**共同判定口径**：所有断言以**数据库最终状态**为准（不得以应用返回值/日志推断）；实验环境为**隔离、非生产、可丢弃**。

---

## 3. CHANGE 99（P1）—— Reconcile 并发反例（源码已核实）

**源码事实**：`rsi-restart-reconcile.ts:163-176` 先读快照，再**顺序调用**两个 store 方法：

```text
await input.store.markLeaseStatus({ leaseId, status: 'EXPIRED', at });   // ← 独立调用 1
await input.store.requeueTask({ taskId, at });                            // ← 独立调用 2
```

而 Prisma 实现（`rsi-reconcile-prisma-store.ts:49-61`）是**两次独立 `updateMany`**，各自带状态前置条件
（lease：`status='ACTIVE'`；task：`status='IN_PROGRESS'`），**既无事务包裹，也不与租约的 generation/owner/到期时间绑定**。

**并发反例（时序）**：

```text
T0  旧 reconcile 读取快照：租约 L(owner=O_old) 已过期；任务 T = IN_PROGRESS
T1  旧 reconcile 调 markLeaseStatus(L → EXPIRED)          —— 成功（L 当时为 ACTIVE）
T2  另一实例执行 reclaimExpired / claim：
       · L 已 EXPIRED ⇒ 其任务 T 被放回 READY
       · 该实例随即 claim：T(READY → IN_PROGRESS) 且 upsert 租约 owner=O_new、status=ACTIVE
T3  旧 reconcile 调 requeueTask(T)：updateMany({ id:T, status:'IN_PROGRESS' }) **命中 O_new 的任务** ⇒ T 被改回 READY
结果：O_new 仍持有 **ACTIVE 租约**，但任务已变 READY ⇒ 可被再次领取 ⇒ 并发重复处理风险
```

**验收条件（S13b）**：旧 reconcile 的 requeue **必须**以满足下列任一为前置（实现方式留待单独授权）：
① requeue 与 lease 快照**原子绑定**（同一事务 + 同一前置条件，含 lease 身份/到期时间）；
② requeue 前置增加「**该任务不存在 ACTIVE 租约**」条件；
③ 以 lease **generation/owner** 作为 requeue 的附加前置。
**断言**：任何「旧快照过期 → 新执行已接管」的时序下，旧 reconcile 均**不得**改写新持有者的任务状态。

---

## 4. CHANGE 100（P1）—— advisory lock 边界说明

| 限制 | 说明 | 影响 |
| --- | --- | --- |
| **键的构造** | `hashtext(organizationId + ':' + feeCalculationId)::bigint` | **无严格一一对应**：不同业务键可能映射到同一 64 位整数（哈希碰撞）⇒ 可能造成**无关写入互相阻塞**（安全但低效），或掩盖真正的键区分 |
| **协议范围** | advisory lock 只约束**遵循同一协议**的参与者 | **未接入协议的写入入口不会自动受保护**（DBA/外部脚本/其他服务） |

**结论**：`invoice-issue.ts` 的存在证明的是「**仓库已有数据库事务锁先例**」，**不能**据此认定 U2 fencing 已获充分实现；
路线 A 可优先评估，但仍须满足 A-1~A-8（含 generation、全入口覆盖、提交时刻覆盖、权限闭环、切换语义）。

---

## 5. 隔离实验申请：提交前检查（pre-submission checklist）

| 检查项 | 状态 |
| --- | --- |
| 申请范围（隔离 PG16 + 一次性目录 + 专用非特权账号 + 仅合成数据） | ✅ 已在 R5 草案定义 |
| 场景覆盖（S1–S11 + S12 ABA + S13a–e） | ✅ 已在 R5/R6 文档定义 |
| 判定口径（以**数据库最终状态**为准；违例判定可复现） | ✅ 已在 §2 写死 |
| 安全退出与回滚（观察到未受控双写或生产连通即中止；结束销毁环境） | ✅ 已在 R5 草案定义 |
| 时长与超时处置（≤60 分钟；超时记 `INCONCLUSIVE`） | ✅ 已定义 |
| **宿主侧前置** | ❌ **未满足**：需宿主提供隔离环境与最小权限账号 + **单独的实验执行授权** |
| 权限/凭据纪律（不得回传连接串/密码/密钥/令牌） | ✅ 已定义 |

**结论**：实验申请**材料已就绪**，但**前置条件（宿主授权 + 隔离环境）未满足** ⇒ **不得提交执行**，仅可提交**申请**。

---

## 6. 本轮状态

```text
R6_INTERNAL_WORK_COMPLETE = YES（CHANGE 98 矩阵 / S13a–e / CHANGE 99 反例 / CHANGE 100 边界 / 实验提交前检查）
HOST_EVIDENCE_VERIFIED = NO
CHANGE_98 = 已收口（源码负结果矩阵 + KIND-1/KIND-2 区分 + S13a；修复留待单独授权）
CHANGE_99 = 已收口（并发反例时序 + S13b 验收前置三选一）
CHANGE_100 = 已收口（advisory lock 两项限制）
EXPERIMENT_APPLICATION = READY_FOR_SUBMISSION_BUT_BLOCKED_ON_HOST_PREREQUISITES
F01_STATUS = OPEN_P0 · CARRIER_DECISION = HOLD
P3_EXPERIMENT_AUTHORIZED = NO · U2_IMPLEMENTATION_AUTHORIZED = NO · PRODUCTION_WRITE_AUTHORIZED = NO
MULTI_INSTANCE_AUTOMATED_WRITE = NOT_AUTHORIZED · SCHEMA_MIGRATION = HOLD
RUNTIME_WIRING / MODEL_CALL / PROVIDER_CALL = FORBIDDEN · EXTERNAL_WRITE = HOLD
AUTO_MERGE / AUTO_DEPLOY = FORBIDDEN · U1_REOPEN = NO · U2_DESIGN_R21 = NOT_REOPENED
BUSINESS_HEARTBEAT_RESTORED = NO · OS_TIMER_RESTORED = NO · PRODUCTION_READY = NO
POSTGRESQL_INTEGRATION_TEST / VITEST / TSC / LINUX_SYSTEMD / CI / PRODUCTION = NOT_VERIFIED
TASK_STATE = AWAITING_INDEPENDENT_AUDIT
```

**边界**：本轮仅只读源码检查与文档修订；未修改产品代码、未连接数据库、未运行实验、未恢复任何定时任务。
