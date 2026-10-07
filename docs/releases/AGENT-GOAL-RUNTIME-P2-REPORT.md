# GOAL → 现有 ONE SI RUNTIME 接线（P2）—— 交付与证据

授权：HOST 2026-10-07「AGENT EXPERIENCE LAYER + DURABLE AUTHORIZATION + GOAL ORCHESTRATION」P2。
`EXACT_HEAD = AGENT-GOAL-P2-HEAD`（基线 `19521738`）

结论：**P2 = CLOSED**。Goal 计划经**既有任务队列**进入既有 ONE SI Runtime；
未新增任何 runtime / scheduler / event loop / workflow engine / guard / policy engine。

---

## 1. 先扫描再决定（关键判断）

读 `apps/api/src/runtime/rsi-run.ts` 后确认既有事实：

* `composeRsiRuntime` 从 `tasksPath` 读取任务队列 → controller / event-loop **认领（claim/lease）** → runner mux 派发；
* mux 对 `task:recovery:*` **永远**走 Recovery domain dispatch（保留 pack `recovery-si`），caller runner 只服务非 Recovery 任务；
* 经 `domainPacks` 注入 `packId = 'recovery-si'` 一律抛 `RECOVERY_SI_RESERVED_PACK_ID_REJECTED`（防止自定义 guard 绕过 Shared Action Guard）；
* Recovery pack 只能由 `productRecoveryPack` 装配（绑定真实 `AppActionGuardDeps`）。

由此得出结论：**Goal 计划不得直接调用 runner** —— 直接 `runner.run` 会绕过 claim/lease/park-for-judge 与 Recovery routing。
因此 P2 的接线点是「既有任务队列入口」，而不是新的执行循环。

## 2. 交付文件

| 文件 | 说明 |
|---|---|
| `apps/api/src/services/agent-goal/goal-runtime-binding.ts` | `createGoalRuntimeBinding({ queue })`：只做「把计划并入既有队列」+ 命名空间/草案校验 + `describe()`；`entryPoint = existing-task-queue`、`callsRunnerDirectly = false` |
| `apps/api/src/services/agent-goal/index.ts` | 导出新增模块 |
| `apps/api/src/__tests__/agent-goal-runtime-wiring.test.ts` | 7 例集成回归（真实 `composeRsiRuntime`） |

队列端口 `GoalTaskQueuePort` 由 host 注入（队列 artifact 归 host 所有）；本模块**不提供生产队列实现**，
也不持有任何状态，因此不构成第二事实源。

## 3. 不变量（实现即强制）

| 要求 | 实现 / 证据 |
|---|---|
| 不新增 runtime | binding 与 adapter 均声明 `createsRuntime/createsScheduler/createsEventLoop/createsWorkflowEngine = false`；`runtimeMembers().secondRuntime === 0` |
| 不抢占 `task:recovery:*` | 计划任务的 dedupeKey 必须是保留命名空间；非保留命名空间 `admit` 直接抛 `GOAL_TASK_NAMESPACE_NOT_ALLOWED` |
| 不绕过 Recovery routing | 集成测试用**真实 `composeRsiRuntime`** 证明：goal 任务被认领后派发到 `packId = recovery-si`，且 caller runner 调用次数为 **0** |
| 不绕过 Action Guard / SA / HITL | 执行仍由原有链决定：plan 只给候选动作；capability 解析的 `decisionOwner = services/action-guard`；绑定层不判定权限、不调 runner |
| 入队 ≠ 执行 | 返回体恒 `admissionOnly = true`、`externalActionPerformed = false`、`executedBy = 'ONE_SI_RUNTIME'`；`assertAdmissionIsNotExecution` 拒绝把入队当执行 |
| 幂等 | 同 goal 重复并入 → 第二次 `admitted = []`、`alreadyPresent` 等于首次（dedupeKey 由规划器确定性生成） |

## 4. 测试证据

* `agent-goal-runtime-wiring` **7/7 PASS**（真实 `composeRsiRuntime`）：
  P2-A1 计划并入既有队列 → runtime 认领并派发 `recovery-si`，caller runner 未被调用 ·
  P2-A2 非 recovery 任务才走 caller runner（mux 分离） ·
  P2-A3 经 `domainPacks` 注入 `recovery-si` → `RECOVERY_SI_RESERVED_PACK_ID_REJECTED` ·
  P2-A4 非保留命名空间拒绝 + describe 边界声明 ·
  P2-A5 重复并入幂等 + 入队不得当执行 ·
  P2-A6 未注入队列端口 / runner → 拒绝自建执行设施 ·
  P2-A7 `SECOND_RUNTIME = 0` 且唯一 runtime owner 为 `rsi-run.ts`
* 定向回归 **69/69 PASS**：`agent-goal`（29）+ `agent-goal-runtime-wiring`（7）+
  `rsi-domain-pack-wiring`（22，既有）+ `rsi-si-runtime-real-guard-e2e`（11，既有，真实 shared guard 装配）
* `api tsc --noEmit` = **exit 0**；本单元无 schema / 无 migration

## 5. 边界（未解锁）

`REAL_PROVIDER_WRITE` / `CUSTOMS_FILING` / `PAYMENT` / `AUTO_COMMISSION_CHARGE` / `PRODUCTION_CREDENTIALS` /
`PRODUCTION_ENABLEMENT` / `REAL_MODEL_NETWORK` / `PAID_MODEL_CALLS` / `EXTERNAL_WRITE` / `TRANSPORT` = **HOLD**；
`SECOND_RUNTIME` / `SECOND_POLICY_ENGINE` / `SECOND_GUARD_IMPLEMENTATION` / `SECOND_CONTROL_PLANE` /
`SECOND_MODEL_GATEWAY` / `SECOND_COST_LEDGER` / `SECOND_META_EVIDENCE_STORE` = **FORBIDDEN**（本单元未新增任何其一）；
高金额 HITL **KEEP**；Standing Authorization ≠ Broker POA。

## 6. 下一步

P3 —— 最小 Goal 持久化（`AgentGoal` / `AgentGoalRun`），明确声明其为 Customer Intent + Execution Projection，
**不是** Opportunity / Case / Claim / Evidence / Money / Settlement 的 SSOT。
