# SI/RSI 客户自治执行与自恢复 V1 —— 单元记录（durable checkpoint）

> HOST 指令：`SI/RSI CUSTOMER AUTONOMOUS EXECUTION & SELF-RECOVERY FINAL DIRECTIVE`（含后续「发布封装」补充指令）。
> 分支：`feat/si-rsi-customer-autonomous-recovery-v1`（从封板基线建立；**不得**直接改封板 RC / main / release/integration）。
> 本文件是**可恢复 checkpoint**：每阶段结束在此登记。**未使用后台心跳**（指令禁止新建第二套心跳/Scheduler/Controller/Runtime）；
> 本环境不保证持续后台调度，因此以 durable 记录 + 可复现命令续跑，**不声称后台持续执行**。

---

## 0. Git 基线（开始前重新确认）

| 项 | 实测值 |
| --- | --- |
| 封板部署来源分支 | `release/rc-20261008-linux-deploy-v1` |
| 锁定部署代码 `releaseCommit` | `04a936666ed8b3badd9ed498eca93b495285bd6e` |
| 封板分支 tip | `ceb65ab73d39eb027df02e4661de82e84c6f4615` |
| 祖先关系 | `04a93666` **是** `ceb65ab7` 的祖先；两者差异仅 `deploy/release-manifest.json` + 1 份文档（均在封装允许范围） |
| 工作树 | clean |
| 发布门禁 | `node deploy/verify-release.mjs --root .` → **RELEASE_GATE=PASS** |
| 本单元开发分支 | `feat/si-rsi-customer-autonomous-recovery-v1`（起点 `ceb65ab7`） |
| 封板分支是否被改动 | **否**（`release/rc-20261008-linux-deploy-v1` / `release/integration-20261008` / `main` 均未触碰） |

---

## 1. PHASE 0 —— 真实代码审计与 P0 复现

审计方式：沿「客户 HTTP Goal → 任务队列 → ONE SI Runtime → runner 分发」追踪真实调用链；
复现使用**真实 runtime 模块 + 真实文件 IO**（仅 runner 用探针观察领取/执行），不使用 Mock 替换被测逻辑。
复现测试：`apps/api/src/__tests__/si-rsi-p0-repro.test.ts`（**5/5 PASS**，api tsc 0）。

### 1.1 P0-A 动态任务队列 = **CONFIRMED**

**真实调用链**

```
POST /agent-goals（apps/api/src/server.ts）
  → goal-admission: createJsonTaskQueuePort({ tasksPath })   ← server.ts:228（仅当 RSI_TASKS_PATH 非空时装配）
      → admit(): readFile(tasksPath) → JSON.parse → push → writeFile(tasksPath)   ← 读-改-写，无锁/无 CAS
  → 运行中的 RSI（dist/src/runtime/rsi-run.js）
      → composeRsiRuntime: tasks = parseTaskQueue(await readFile(tasksPath))     ← **仅启动时读一次**（rsi-run.ts:215）
      → attachContinuationToController({ tasks }) → createRsiContinuationEngine({ tasks })
                                                                                ← 任务被复制进**内存队列**并冻结
      → createLocalEventSources: 只提供 readCi / readVerdict / readTests         ← **没有任何任务文件事件源**
      → rsi-event-loop.pollOnce(): 只有 CI/测试/裁决事件；无事件 → controller.tick()（60s 兜底）
          → tick() 只操作**内存队列**，不会重读 tasksPath
```

**复现证据（A1 / A2 / A3）**

| 用例 | 观察 | 结论 |
| --- | --- | --- |
| A1 | 启动后经真实队列端口写入 `task:recovery:scan:v1:goal-1`（文件确有该任务），再给运行中的实例 8 轮「事件轮询 + 兜底 tick」→ 执行器探针调用数 **0**；`controller.state().queueLength = 0` | **服务不重启则永远不领取** |
| A2（对照） | 同一组合下，**启动前**已在文件中的任务被正常领取（探针被调用） | 差异确实在「启动后入队」，不是领取逻辑坏了 |
| A3 | 两个 `admit()` 并发（`Promise.all`）都自称 admitted，但落盘只剩 1 条 | **JSON 读-改-写无并发保护 ⇒ 丢任务** |

**风险面（与指令一致）**

- 并发写入丢任务：**已复现**（A3）；
- 多 worker 重复领取：当前**不可能**（因为根本领取不到新任务），但一旦改成重读会出现无租约竞争；
- 进程崩溃后任务丢失：任务在文件里（未丢），但**运行时无法消费**；
- 已消费任务重放 / 客户取消与授权撤销后的阻断 / 顺序与公平性：现有实现**均无**（无状态、无取消通道、无优先级队列）；
- 客户任务与 organization/account/goal 的可信绑定：JSON 队列仅存 `{id, dedupeKey, priority}`，**不携带租户**（仅入队瞬间由端口入参携带）。

### 1.2 P0-B Recovery SI 正式装配 = **CONFIRMED**

**真实调用链**

```
systemd crossclaim-rsi.service
  → ExecStart=/usr/bin/node /opt/crossclaim/apps/api/dist/src/runtime/rsi-run.js
      → 直跑块 composeRsiRuntime({ readFile, tasksPath, signalsPath, ciResultsPath, verdictPath,
                                   testResultsPath, runner: await resolveRunnerFromEnv(), intervalMs,
                                   ...(openedReconcile ? { reconcile: spec } : {}) })
                                                                    ← **未传 productRecoveryPack / domainPacks**
      → domainPackList = [productPack?, ...domainPacks?] = []        ← productPack === null（未注入）
      → domainRunner = null
      → effectiveRunner.run(task):
           if (isRecoveryTask(task))   // task:recovery:*
                return domainRunner !== null ? domainRunner.run(task) : { status: 'BLOCK' }
           else if (input.runner) return input.runner.run(task)
                                                                    ← recovery **不会**回退给 caller runner
```

**复现证据（B1 / B2）**

| 用例 | 观察 | 结论 |
| --- | --- | --- |
| B1 | 与生产直跑等价组合（不传 pack）：`task:recovery:scan:v1:rec-1` 被 claim，但执行器探针调用数 **0**，`domainDispatchLog()` 为空；再次 tick 不重复领取 | recovery 任务在生产启动链下**恒为 BLOCK** |
| B2（对照） | 同一组合下 `task:demo:demo-1` 正常交给注入 runner | 差异仅限 recovery 命名空间，证明是「pack 未装配」而非 runner 坏了 |

**同时确认**：`RSI_RUNNER=UNCONFIGURED`（`resolveRunnerFromEnv()` 未配置执行器），即生产直跑连通用 runner 都是 no-op；
recovery 任务既不进 domain dispatch，也不回退 caller runner，最终停在 BLOCK（无伪造 PASS，符合既有 fail-closed 设计）。

### 1.3 PHASE 0 裁决（指令要求的两项结论）

```
P0_A_DYNAMIC_TASK_QUEUE        = CONFIRMED
P0_B_PRODUCTION_COMPOSITION    = CONFIRMED
REPRODUCTION_MODE              = 真实 runtime 模块 + 真实文件 IO + 真实分发链（仅 runner 用探针观察）
PHASE0_TEST_FILE               = apps/api/src/__tests__/si-rsi-p0-repro.test.ts（5/5 PASS）
PHASE0_API_TSC                 = 0
```

> 两项都是**真实缺陷**，不是设计文档层面的猜测；也与指令中「已观察到」的描述一致。
> 但结论仅覆盖「当前封板代码」：尚未做任何修复。

### 1.4 追加发现（PHASE 0 附带，影响 PHASE 1 设计）

`apps/api/src/server.ts:227-228`：API 侧任务队列端口**仅在 `RSI_TASKS_PATH` 非空时**装配，
否则 `queue = null` 且目标准入 fail-closed（返回 409/403，不假装已入队）。

而当前部署模板（`deploy/systemd/crossclaim-api.service` 与 `install-services.sh` 的 `api.env`）
**没有为 API 设置 `RSI_TASKS_PATH`**；该变量只出现在 RSI 侧 env 模板（且默认注释掉）。

⇒ 在生产同构配置下，客户 Goal 的「入队」这一步**根本不会发生**（不是被丢弃，而是准入直接拒绝）。
它与 P0-A 叠加后形成双重阻断：**准入可能不可用 → 即便入队也不会被消费**。

> 这解释了为什么「客户提交 Goal 后只显示『已开始检查』」：执行侧没有任何真实领取与执行。
> PHASE 1 必须同时解决「队列可用性」与「动态消费」两件事，且不得新增第二套 runtime/scheduler。

---

## 2. 后续阶段（进行中，尚未完成）

| PHASE | 目标 | 状态 |
| --- | --- | --- |
| 1 | 客户任务自动执行闭环（动态消费 + durable 队列 + 租约/幂等/恢复） | **代码已实现 + 真实 PG 测试通过（见 §2.1）** |
| 2 | API 故障自动诊断与恢复（11 类错误 + 有界重试/退避/升级） | NOT STARTED |
| 3 | 业务错误自动重新规划（真实替代计划 + 独立验证 + 上限与留痕） | NOT STARTED |
| 4 | 持续学习与策略优化（复用 Experience/Meta/Outcome/Canary） | NOT STARTED |
| 5 | 程序 Bug 自动发现与研发修复流程（研发自治，不碰生产） | NOT STARTED |
| 6 | 真实端到端故障注入（A–P，真实 PG + ONE SI Runtime） | NOT STARTED |

**边界（全程）**：不新增第二套 runtime/scheduler/controller/guard/policy engine；
`REAL_PROVIDER_WRITE / CUSTOMS_FILING / PAYMENT / AUTO_COMMISSION_CHARGE / PRODUCTION_CREDENTIALS /
PRODUCTION_ENABLEMENT / EXTERNAL_WRITE / TRANSPORT = HOLD`；不执行生产部署 / 生产迁移。

---

## 2.1 PHASE 1 —— 客户任务自动执行闭环（已实现，真实 PG 验收通过）

### 变更（全部复用既有结构，未新增第二套 runtime / scheduler / 队列 / guard）

| 文件 | 变更 |
| --- | --- |
| `apps/api/src/services/autonomy/rsi-continuation-engine.ts` | 新增 `adoptTasks()`：运行时把 durable 新任务并入**同一**队列（去重口径与 claim 一致）；`state()` 新增 `adoptedCount` |
| `apps/api/src/runtime/rsi-controller-continuation.ts` | controller 暴露 `adoptTasks` |
| `apps/api/src/runtime/rsi-run.ts` | 组合根新增 `taskSource`；**复用既有 60s 兜底 tick** 与 boot 时 `reconcileNow()` 采纳（无新调度器） |
| `apps/api/src/runtime/rsi-durable-task-source.ts`（新增） | durable 任务源：CAS 领取（`updateMany where status=READY`）+ 写 `AutonomyLease`（ownerRef/expiresAt） |
| `apps/api/src/services/agent-goal/prisma-task-queue-port.ts`（新增） | durable 队列端口：`AutonomyIncident(kind=CUSTOMER_GOAL_QUEUE)` + `AutonomyTask`（dedupeKey 全局唯一、`skipDuplicates`） |
| `apps/api/src/runtime/rsi-run-bootstrap.ts` | Prisma 打开时**同时**提供 reconcile store 与 durable 任务源（共用同一 client） |
| `apps/api/src/server.ts` | API 默认改用 **durable** 端口（有 DATABASE_URL 时）；JSON 端口降级为显式 legacy 回退 |

### 验收证据（`apps/api/src/__tests__/si-rsi-phase1-durable-queue.test.ts`，**7/7 PASS**，真实 PostgreSQL）

| 用例 | 断言 | 对应 PHASE 1 要求 |
| --- | --- | --- |
| 01 | 同 dedupeKey 重复入队只落 1 行，第二次报 `alreadyPresent` | 幂等 |
| 02 | 并发两次入队**都**落库（对比 PHASE 0-A3 的丢任务） | durable、无丢任务 |
| 03 | `organizationId` 固化在 incident `sourceRefs`；org-A/org-B 各挂自己的 incident 与任务 | 租户可信绑定 |
| 04 | 两 worker 并发 claim 只有**一个赢家**；任务 `IN_PROGRESS` + `AutonomyLease(status=ACTIVE, ownerRef)` | claim / lease / 多 worker 不重复 |
| 05 | crashed worker 领取后另一 worker 领不到；经**既有 reconcile** 把 `IN_PROGRESS` 放回 `READY` 后可被重新领取 | 崩溃恢复 / restart |
| 06 | runtime **已运行**后再入队，下一次既有 tick 即发现并**真实执行**（`adoptedCount=1`，探针收到该任务）—— 对照 PHASE 0-A1 | 动态消费、无需重启 |
| 07 | 生产前缀 `task:recovery:*` 同样被动态采纳并 claim；在 PHASE 2 装配前仍**不回退 caller runner**（fail-closed） | 未绕过安全闸门 |

定向回归：`545/545 PASS`（RSI 全量 + P0 复现 + PHASE 1 + 架构/部署/治理契约）；api tsc **0**。

### 已知限制（如实登记，需后续 Schema Delta；不得当作已解决）

1. `AutonomyTask` **无 priority / attempts / nextAttemptAt / lastError 列** ⇒ 本轮优先级固定 `P2`，重试与**死信状态**尚未实现（PHASE 1 要求 7 的「可观测」只部分满足）；
2. 租约到期后的**重新领取**目前依赖既有 reconcile（重启/接管时）而非运行中主动 reclaim；
3. 客户**授权撤销后的阻断**尚未接线（要求 6 未完成）：需要把 Standing Authorization 撤销状态带入 claim 判定；
4. `PENDING_TENANT_ACCOUNT_LINEAGE`：任务行本身不含 accountId / 授权范围（仅 incident `sourceRefs` 有 organizationId）；
5. 仍属 `REAL_EXTERNAL_EXECUTION = NOT_EXECUTED`：执行器为本地探针/既有模块链，未接真实 Provider。

> 结论口径：PHASE 1 = **CODE_IMPLEMENTED + TEST_VERIFIED（本地真实 PG）**；
> **不是** PRODUCTION_WIRED / REAL_PROVIDER_VERIFIED / PRODUCTION_ENABLED。要求 6/7 的缺口已列在上方，不得声称为已完成。

### 2.2 PHASE 0+1 独立审计（`MSG-20261008-16`）= **PASS WITH REVISE · PHASE 1 NOT CLOSED**

审查锚点 `51c1f18e`；会话 `https://chatgpt.com/c/6ac79a99-c758-83ec-b01b-cc5ef3d96a65`；
逐字归档 `AI-ARCHITECT-INBOX.md`（**FULL_COPY_OK** 103/103，缺失 0 / 多出 0）。

| 审计项 | 裁决 |
| --- | --- |
| P0_A_REPRODUCTION | PASS |
| P0_B_REPRODUCTION | PASS |
| PHASE1_DURABLE_QUEUE | PASS |
| PHASE1_DYNAMIC_CONSUMPTION | PASS |
| PHASE1_MULTI_WORKER_ISOLATION | **REVISE** |
| PHASE1_CRASH_RECOVERY | **REVISE** |
| LIMITATIONS_HONESTY | PASS |

**复审给出的强制 CHANGE（PHASE 1 收口前必须关闭）**

| 优先级 | 要求 | 验收标准 |
| --- | --- | --- |
| P0 · CHANGE 1 | **原子化** claim 与 lease 创建（同一事务） | 事务失败完全回滚；并发仅一个赢家；不得出现「IN_PROGRESS 但无有效租约」的悬挂任务 |
| P0 · CHANGE 2 | 运行中租约到期恢复（进程未重启也能安全接管） | worker 崩溃且不重启时，其他 worker 可安全接管 |
| P0 · CHANGE 3 | 完整生命周期与重试控制 | 成功持久化、失败重试、退避、最大次数、**死信**、审计记录 |
| P0 · CHANGE 4 | 租户 / 账户 / 授权绑定与**撤销拦截** | 执行前重新核验可信授权；撤销后不得继续新动作 |
| P0 · CHANGE 5 | **PHASE 2**：Recovery pack 生产装配 | systemd 实际入口加载既有 Recovery pack，真实业务模块执行，不再因未装配而 BLOCK |
| P1 · CHANGE 6 | 多 worker 竞争与故障注入矩阵 | 覆盖超时、重启、**旧 worker 迟到提交**、CAS 竞争、重复 tick；须验证 owner/fencing，而非只验证「重新领取成功」 |
| P1 · CHANGE 7 | 发布配置与 CI 核验 | API/RSI 使用同一 durable 数据源；CI 与启动入口验收可复现 |

**复审额外技术意见（本轮未解决）**

1. 需检查 `READY → IN_PROGRESS → COMPLETED/BLOCKED` **完整状态转移**：执行成功后是否可靠持久化、失败后能否恢复、DB 任务与内存任务是否可能双重领取；
2. CAS 领取与 `AutonomyLease` upsert **是否同一事务**（否则可能悬挂任务）；
3. **不能仅凭 `incident.sourceRefs.organizationId`** 就认定执行时租户/账户/授权范围可信 —— 执行前必须从可信持久化事实重新解析边界。

**机器可读结论**

```
OVERALL_VERDICT              = PASS WITH REVISE
PHASE1_CLOSED                = NO
PHASE2_REQUIRED              = YES
P0_A_RUNTIME_FIX             = PARTIALLY_VALIDATED
P0_B_RUNTIME_FIX             = NOT_IMPLEMENTED
REAL_EXTERNAL_EXECUTION      = NOT_EXECUTED
PRODUCTION_READY             = NO
SECOND_RUNTIME_ALLOWED       = NO
FAIL_CLOSED_BYPASS_ALLOWED   = NO
RELEASE_BRANCH_MUTATION      = FORBIDDEN
NEXT                         = PHASE1_FINALIZATION → PHASE 2 → PHASE 3–6
```

> 下一轮起点：**PHASE 1 FINALIZATION**（关闭 CHANGE 1–4）→ **PHASE 2**（CHANGE 5）。
> 不得在 PHASE 2 完成前宣布客户 Recovery 自动执行闭环 CLOSED。

### 2.3 PHASE 1 FINALIZATION（进行中）—— C1 + C2 已关闭

| CHANGE | 状态 | 实现与证据 |
| --- | --- | --- |
| **C1** claim 与 lease **原子化**（P0） | **CLOSED** | `rsi-durable-task-source.claim()` 改为 `prisma.$transaction`：CAS(`READY→IN_PROGRESS`) 与 lease upsert 同事务，任一失败整体回滚 ⇒ 不会出现「IN_PROGRESS 但无有效租约」 |
| **C2** 运行中租约恢复 + fencing（P0） | **CLOSED** | 新增 `reclaimExpired()`：对**已到期** ACTIVE 租约做 CAS(`ACTIVE+expiresAt<=now ⇒ EXPIRED`) 并把任务 CAS(`IN_PROGRESS ⇒ READY`)，**无需进程重启**；接入既有 tick（`adoptFromTaskSource` 先 reclaim 再 claim）。新增 `settle()`：只有「本 owner 且未过期 ACTIVE 租约」才允许落终态 ⇒ 旧 worker 迟到提交被 fence 拒绝 |
| C3 完整生命周期/重试/死信（P0） | NOT CLOSED | 终态落库已实现（成功→`PROMOTED`、阻断→`BLOCKED`）；**重试、指数退避、最大次数、死信、审计记录尚未实现** |
| C4 租户/账户/授权与撤销拦截（P0） | NOT CLOSED | 尚未实现（执行前从可信事实重解析 + 撤销拦截） |
| C6 多 worker 故障注入矩阵（P1） | PARTIAL | 已覆盖：并发领取、租约过期接管、旧 worker 迟到提交（fencing）、重复提交、事务失败（约束违反即整体失败）；未覆盖：跨租户/账户边界矩阵 |
| C7 发布配置与 CI（P1） | PARTIAL | API 与 RSI 已共用同一 durable 源；JSON 仅显式 legacy 回退；CI 命中未验证（GitHub Actions = NOT_OBSERVED） |
| C5 → PHASE 2 Recovery 装配（P0） | NOT STARTED | 见 PHASE 2 |

**C1/C2 验收测试**：`apps/api/src/__tests__/si-rsi-phase1-finalization.test.ts`（**5/5 PASS**，真实 PostgreSQL）

| 用例 | 断言 |
| --- | --- |
| C1-1 | 三 worker 并发领取后，**所有** IN_PROGRESS 任务都持有 ACTIVE 租约（无悬挂） |
| C1-2 | 未赢得 CAS 的 worker 不留下自己的租约（无部分写入） |
| C2-1 | 租约到期后 `reclaimExpired()` 把租约置 EXPIRED、任务回 READY，新 worker 无需重启即可领取 |
| C2-2 | 接管后旧 worker 迟到 `settle()` 被拒（`FENCED_OWNER_MISMATCH`），**不覆盖**新 owner；新 owner 正常提交 |
| C2-3 | 即使 owner 相同，租约已过期也拒绝提交（`FENCED_LEASE_EXPIRED`） |

**新增已知限制（如实登记）**

6. `AutonomyTask` 的 DB 检查约束 `AutonomyTask_status_chk` **没有 `COMPLETED`**（合法值：READY/IN_PROGRESS/CANDIDATE_READY/VALIDATED/JUDGED/PROMOTED/REJECTED/BLOCKED）⇒ 客户任务成功终态暂映射为 `PROMOTED`；建议后续 Schema Delta 增加语义化终态；
7. `AutonomyLease` 有 `AutonomyLease_time_order_chk`（acquiredAt ≤ renewedAt ≤ expiresAt）⇒ 时间推进必须保持一致（测试夹具已遵循）。

> 当前口径：**C1 / C2 = CLOSED（CODE_IMPLEMENTED + TEST_VERIFIED）**；
> **PHASE 1 整体仍 NOT CLOSED**（C3/C4/C6/C7 未关闭，C5 属 PHASE 2）。
