# RSI-RT-06 重启 / 接管 reconcile（lease 恢复 + 去重 + exactly-once）

- 前置裁定：`AI-ARCHITECT-INBOX.md` **MSG-20261005-02**（`RSI_MIGRATION_SQL = PASS`，`STAGING_MIGRATE_DEPLOY = AUTHORIZED`，`PRODUCTION_MIGRATE_DEPLOY = HOLD`）
- 分支：`gate/7-commercial-validation`
- 本轮范围：**进程重启 / 接管后的状态收敛逻辑**（不涉及 External Write / Payment / Transport / 凭据）

## 1. 为什么要 reconcile

RSI 的运行时是「事件驱动 + 60s watchdogs」。进程在 `claim → lease 写入 → 执行 → 收尾` 的任意一点被杀掉，
重启后必须能回答三个问题：

1. 上次的 lease 还算不算数？—— 不能出现两个 runtime 同时执行同一个 task。
2. 卡在 `IN_PROGRESS` 的任务怎么办？—— 必须能续跑，而不是永久卡死。
3. 会不会因为重启/重放而**重复创建任务**？—— 必须 exactly-once。

## 2. 收敛规则（`planRsiReconcile`，纯函数）

| 落库状态 | 处理 |
| --- | --- |
| lease `ACTIVE` 且 `expiresAt > now` | **不动**（可能是另一个仍在运行的 runtime；也不做自我抢占） |
| lease `ACTIVE` 且 `expiresAt <= now` | 标 `EXPIRED`；任务若仍 `IN_PROGRESS` → 回 `READY` |
| lease `EXPIRED` / `RELEASED` + 任务 `IN_PROGRESS` | 任务回 `READY`（续跑） |
| 任务 `IN_PROGRESS` 但没有 lease 行（claim 与 lease 之间的崩溃窗口） | 任务回 `READY` |
| 任务终态 `PROMOTED` / `REJECTED` | **不动**（即使 lease 过期） |
| 任务状态不在 `RSI_TASK_STATES` 内 | **不动**，只进 `unknownTaskIds` 如实上报 |
| 同一 `dedupeKey` 出现多个未终态任务 | 只进 `duplicateDedupeKeys` 上报，不创建、不删除 |

`reconcile` **从不创建任务、也从不删除任务**：任务数量恒定，去重靠 `AutonomyTask.dedupeKey` 唯一约束 +
本模块的「只收敛、不生产」原则。

## 3. exactly-once 的实现方式

- 两条写路径都带**状态前置条件**（内存实现与 Prisma 实现语义一致）：
  - `markLeaseStatus`：`where status = 'ACTIVE'` 才能改成 `EXPIRED`
  - `requeueTask`：`where status = 'IN_PROGRESS'` 才能改成 `READY`
- 因此重复运行 = 0 行更新：第二次规划的 `expiredLeaseIds` 与 `recoveredTaskIds` 都是空集，
  `idempotentNoop = true`，store 的操作日志不再增长。
- reconcile 本身不产生新的 dedupeKey；任务创建仍由既有事件链按唯一约束收敛。

## 4. 代码与接线

- `apps/api/src/runtime/rsi-restart-reconcile.ts`
  - `planRsiReconcile()`（纯函数规划）、`runRsiRestartReconcile()`（先释放过期 lease，再回收任务）
  - `createRsiInMemoryReconcileStore()`（无 DB 环境下的契约验收）
  - `RSI_RESTART_RECONCILE_BOUNDARY`（`createsTasks=false` / `deletesTasks=false` / 无网络 / 无凭据）
- `apps/api/src/runtime/rsi-reconcile-prisma-store.ts`
  - `createPrismaRsiReconcileStore(prisma)`：`updateMany` + 状态前置条件；只读写状态与时间戳
- `apps/api/src/runtime/rsi-run.ts`
  - 组合根新增可选 `reconcile: { store, ownerRef, trigger? }` 与 `reconcileNow()`
  - **默认 `NOT_CONFIGURED`**：没有 store 时返回 `null`，不写任何状态、不改变现有默认行为
  - 直接运行入口在 `start()` 之前调用一次并打印 `RSI_RECONCILE=...`

## 5. 验收与证据边界

- 本地（无 DB）已验证：`apps/api/src/__tests__/rsi-restart-reconcile.test.ts`，10 例
  - 过期 ACTIVE lease 回收、未过期 lease 保持、RELEASED 续跑、孤儿任务、终态不动、未知状态只上报、
    重复 dedupeKey 只上报、二次运行空操作、任务数量恒定（exactly-once）、纯函数规划零写入
- `tsc --noEmit` exit 0；门禁 `api-contract` / `audit-coverage` / `autopilot-rules` 全 OK
- **诚实边界**：Prisma store 的类型与调用形态已通过类型检查，但**本地数据库缺少 RSI 状态表**，
  因此「真实 DB 上的 reconcile / lease 恢复 / exactly-once」仍需宿主提供非生产 `DATABASE_URL`
  才能实测（迁移已获批 staging apply）。这一项如实标记为 `HOST_ACTION_REQUIRED`，不伪造通过。

## 6. 边界不变

```
EXTERNAL_WRITE = HOLD
PAYMENT = HOLD
TRANSPORT = HOLD
PRODUCTION_CREDENTIALS = HOLD
RSI_MODEL_NETWORK = HOLD
RSI_PAID_MODEL_CALLS = HOLD
```
