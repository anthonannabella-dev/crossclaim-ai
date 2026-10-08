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
| 1 | 客户任务自动执行闭环（动态消费 + durable 队列 + 租约/幂等/恢复） | **CLOSED**（`MSG-20261008-17`：C1–C4/C6 PASS，C7 PASS_WITH_REVISE，PHASE1_CLOSED = PASS） |
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
| C3 完整生命周期/重试/死信（P0） | **CLOSED** | 见 §2.4（Schema Delta + 退避门禁 + fence 保护的 `fail()` + 死信终态 + DB 层不变量） |
| C4 租户/账户/授权与撤销拦截（P0） | **CLOSED** | 见 §2.5（领取前授权重解析 + 撤销/过期 BLOCK + 持久化原因码） |
| C6 多 worker 故障注入矩阵（P1） | **CLOSED** | 见 §2.6（8 类场景矩阵，含数据库事务失败注入与跨租户边界） |
| C7 发布配置与 CI（P1） | **CLOSED** | 见 §2.7（同一 durable 源契约 + PHASE 1 套件纳入发布门禁并实跑验证） |
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

### 2.4 C3 —— 完整生命周期（重试 / 退避 / 上限 / 死信）已关闭

**Schema Delta（独立迁移，fresh schema 从零验证通过）**

迁移 `apps/api/prisma/migrations/20261008140000_autonomy_task_retry_lifecycle/migration.sql`：

| 变更 | 内容 |
| --- | --- |
| 新增列 | `attempts`(默认 0) / `maxAttempts`(默认 3) / `nextAttemptAt` / `lastErrorCode` / `deadLetteredAt` |
| 新增索引 | `AutonomyTask(status, nextAttemptAt)` —— 退避门禁的领取过滤 |
| 新增约束 | `AutonomyTask_attempts_chk`（`attempts>=0 && maxAttempts>=1 && attempts<=maxAttempts`） |
| 新增约束 | `AutonomyTask_dead_letter_chk`（`(status='DEAD_LETTER') = (deadLetteredAt IS NOT NULL)`） |
| 扩展词表 | `AutonomyTask_status_chk` 增加 `DEAD_LETTER`（原有取值全部保留） |

**实现**

- `claim()` 增加**退避门禁**：`OR [{nextAttemptAt: null}, {nextAttemptAt <= now}]` ⇒ 未到重试时间的任务不可被领取（杜绝无限立即重试）；
- 新增 `fail({taskId, ownerRef, errorCode})`：**fenced**（要求本 owner + 未过期 ACTIVE 租约）⇒ 释放租约、`attempts+1`、写 `lastErrorCode`；未达上限 ⇒ `READY` + `nextAttemptAt = now + backoff(attempts)`；达上限 ⇒ `DEAD_LETTER` + `deadLetteredAt`；
- 默认退避 = 指数（30s × 2^(n-1)，上限 30 分钟）+ 由 `taskId` 决定的**确定性抖动**（0–10%，跨 worker 不产生重试尖峰且可测）；
- 成功仍走 `settle()` ⇒ `PROMOTED` + 租约 `RELEASED`（未改动）。

**验收（`si-rsi-phase1-retry-lifecycle.test.ts`，真实 PostgreSQL 5/5 PASS）**

| 用例 | 断言 |
| --- | --- |
| C3-1 | 失败一次：`attempts=1`、`lastErrorCode` 落库、状态回 `READY`、`nextAttemptAt` 正确；退避期内不可领取、到期后可领取 |
| C3-2 | 连续 3 次失败（每轮须越过退避窗口）⇒ 第 3 次 `DEAD_LETTER` + `deadLetteredAt`，此后任何时刻都不可再领取 |
| C3-3 | 旧 worker 迟到 `fail()` 被 fence 拒绝（`FENCED_OWNER_MISMATCH`），`attempts`/状态均未被改动 |
| C3-4 | 成功终态不受影响：`settle(COMPLETED)` ⇒ `PROMOTED` + 租约 `RELEASED` |
| C3-5 | DB 层不变量生效：`attempts>maxAttempts` 与「死信无时间戳」均被约束拒绝 |

回归：C3 + PHASE1 全部 + 既有持久化契约 = **25/25**；Schema/架构/治理契约 = **256/256**；api tsc **0**；
`prisma validate` valid；迁移已在开发库与**全新 schema（从零应用全部迁移）**成功。

### 2.5 C4 —— 租户 / 账户 / 授权重解析与撤销拦截已关闭

**实现**（`rsi-durable-task-source.ts`，仅在 `claim()` 内、**执行前**进行，fail-closed）

对齐复审意见「不能仅凭 `incident.sourceRefs.organizationId` 就认定边界可信」：

1. `incident` 必须存在且 `kind === 'CUSTOMER_GOAL_QUEUE'`（**只信服务端写入的容器**；伪造/错绑容器一律拒绝）；
2. 从 `sourceRefs[0].organizationId` 解析租户，且该 `Organization` 必须在可信库中**真实存在**；
3. 对 `ownerGateRequired = true`（需要自动执行授权）的任务，必须存在**未撤销且未过期**的
   `StandingAuthorization`（`revocationState='ACTIVE'` ∧ `effectiveAt ≤ now < expiresAt`）—— 撤销/过期即拒绝；
4. 拒绝**不是静默跳过**：任务被 CAS 标记 `BLOCKED` + `lastErrorCode = 原因码`，且不产生任何租约。

原因码（只回码，不回显取值）：`CLAIM_DENY_UNTRUSTED_INCIDENT_KIND` /
`CLAIM_DENY_ORGANIZATION_UNRESOLVABLE` / `CLAIM_DENY_ORGANIZATION_NOT_FOUND` /
`CLAIM_DENY_STANDING_AUTHORIZATION_REVOKED`。

**验收（`si-rsi-phase1-authorization.test.ts`，真实 PostgreSQL 6/6 PASS）**

| 用例 | 断言 |
| --- | --- |
| C4-1 | 受控任务 + 有效 Standing Authorization ⇒ 允许领取（`IN_PROGRESS`） |
| C4-2 | 授权已撤销 ⇒ 拒绝领取；任务持久化 `BLOCKED` + `STANDING_AUTHORIZATION_REVOKED`；**零租约** |
| C4-3 | 授权已过期 ⇒ 拒绝领取并 BLOCK（与撤销同一 fail-closed 路径） |
| C4-4 | 不可信容器（`kind='CI_RED'` 下挂 recovery 任务）⇒ 拒绝并 BLOCK（`UNTRUSTED_INCIDENT_KIND`） |
| C4-5 | 租户不可解析 / 不存在（不信任自报 sourceRefs）⇒ 拒绝并 BLOCK（`ORGANIZATION_NOT_FOUND`） |
| C4-6 | 非受控任务（无需自动执行授权）⇒ 仅要求租户真实存在，无需 Standing Authorization |

回归：C4 + 全部 PHASE 1 = **23/23**；api tsc **0**。

**既有测试夹具同步更新**：PHASE 1 的 C1/C2/C3 用例现在会 seed 真实 `Organization`（含 `slug`）与
合规 `StandingAuthorization`（`allowedActionTypes` 非空、`scopeDigest` 64 位、撤销态带完整凭证）
—— 这正是「执行前必须从可信库重解析」的必然要求，不是为通过测试而放宽逻辑。

### 2.6 C6 —— 多 worker 故障注入矩阵已关闭

`apps/api/src/__tests__/si-rsi-phase1-fault-matrix.test.ts`（真实 PostgreSQL **8/8 PASS**）

| 用例 | 场景 | 断言 |
| --- | --- | --- |
| M1 | 并发领取（3 任务 × 5 worker） | 每个任务**恰好一个赢家**，总数 = 3，租约 = 3 |
| M2 | 租约过期与重新领取 | `reclaimExpired` 接管后新 worker 领取成功（进程未重启） |
| M3 | 旧 worker 迟到提交 | `settle` 与 `fail` **双双被 fence 拒绝**，`status`/`attempts` 不被覆盖；新 owner 提交成功 ⇒ `PROMOTED` |
| **M4** | **数据库事务失败注入**（`leaseMs=-1000` ⇒ 违反 `AutonomyLease_time_order_chk`） | claim **整体回滚**：任务仍 `READY`、**零租约**；健康 worker 随后仍可正常领取 ⇒ 直接证明 C1 原子性 |
| M5 | 重启恢复 | 中断在 `IN_PROGRESS` 的任务经既有 reconcile 回到 `READY` 并可重新领取 |
| M6 | 重复任务提交 | 同 `dedupeKey` 幂等（单行 + `alreadyPresent`）；已被领取后不再重复执行 |
| M7 | 跨租户 / 账户边界 | 撤销 org-A 授权后：仅 org-A 任务被 `BLOCKED`，**org-B 任务照常执行** |
| M8 | 幂等与重复副作用控制 | 重复 `settle` ⇒ `LEASE_NOT_ACTIVE`（不二次生效）；迟到 `fail` 不改动 `attempts`；终态保持 `PROMOTED` |

回归：PHASE 1 全量（5 个 SI-RSI 套件 + P0 复现 + 既有持久化/reconcile 契约）= **54/54**；api tsc **0**。

### 2.7 C7 —— 发布配置与 CI 核验已关闭

`apps/api/src/__tests__/si-rsi-phase1-release-wiring.test.ts`（**7/7 PASS**，确定性静态契约）

| 用例 | 断言 |
| --- | --- |
| 01 | `server.ts` **默认**使用 `createPrismaTaskQueuePort`；`createJsonTaskQueuePort` 只出现在 `DATABASE_URL` 缺失的显式 legacy 分支（源码位置在其之后） |
| 02 | `rsi-run` 启动入口把 `openedReconcile.taskSource` 接入组合根；先 `reclaimExpired(5)` 再 `claim(5)`，并 `adoptTasks` 进同一引擎队列 |
| 03 | `rsi-run-bootstrap` 中 `new PrismaClient()` **只出现一次** ⇒ reconcile store 与任务源共用同一客户端（同一 durable 数据源） |
| 04 | 端口与任务源使用同一 `CUSTOMER_GOAL_QUEUE` incident kind 与 `task:recovery:` 前缀 |
| 05 | 生产 `crossclaim-api.service` **不含** `RSI_TASKS_PATH` ⇒ 不靠 JSON artifact 承载客户任务 |
| 06 | 发布门禁 `gates.requiredTestFiles` 已包含全部 6 个 PHASE 1 套件，且文件真实存在；仍要求 SHA 锁定 + 工作树 clean |
| 07 | 门禁脚本 `deploy/verify-release.mjs` 会**真实执行**必需测试（`gate.tests.pass` + `vitest.mjs`），不是只列清单 |

**实跑验证**（提交 `41df44dc`，工作树 clean 后执行 `node deploy/verify-release.mjs --root .`）：

```
PASS  manifest.readable / manifest.releaseCommit.locked
PASS  git.head.readable / git.branch.readable
PASS  git.worktree.clean
PASS  artifacts.present
PASS  gate.api.build        ← tsc 构建通过
PASS  gate.tests.pass       ← **门禁真实跑完必需的 10 个套件（含 6 个 PHASE 1 套件）**
FAIL  git.branch.allowed    ← feat/* 属 manifest 的 forbiddenDeploymentBranches（**正确拒绝**）
FAIL  release.commit.locked ← 开发分支与封板 releaseCommit(04a93666) 的差异含源码/迁移（**正确拒绝**）
RELEASE_GATE=FAIL（2 项阻断）→ 必须停止部署
```

⇒ 这正是治理想要的行为：**开发分支不可部署**，同时门禁确实把 PHASE 1 行为纳入了发布前必跑集；
正式发布需在新 RC 上重新锁定 `releaseCommit`（AUDIT-RC-3）。

> 备注：`gates.requiredTestFiles` 的变更作用于**开发分支**的 manifest；正式封板时会在新 RC 上重新锁定
> `releaseCommit`（AUDIT-RC-3 发布审计时执行）。GitHub Actions 仍未观测（`NOT_OBSERVED`），
> 因此「CI 命中」只在本机发布门禁范围内验证，不声称云端 CI 已绿。

### 2.8 PHASE 1 独立审计结论（`MSG-20261008-17`）= **PHASE 1 CLOSED**

审查锚点 `cd555f26`；会话 `https://chatgpt.com/c/6ac7a49a-012c-83ec-945b-3aa538c3d2e0`；
逐字归档 `AI-ARCHITECT-INBOX.md`（**FULL_COPY_OK** 20/20，缺失 0 / 多出 0；sha256 `7263e0d4…`）。

```
REVIEWED_HEAD=cd555f26
C1_ATOMIC_CLAIM_LEASE=PASS
C2_LEASE_RECOVERY_FENCING=PASS
C3_RETRY_DEADLETTER=PASS
C4_AUTHORIZATION_REVOCATION=PASS
C6_FAULT_MATRIX=PASS
C7_RELEASE_WIRING_CI=PASS_WITH_REVISE
PHASE1_CLOSED=PASS
VERDICT=PASS_WITH_REVISE
PHASE2_AUTHORIZED=YES_SAFE_SCOPE_ONLY
PHASE2_C5_REQUIRED=YES
P0_B_CLOSED=NO
REAL_EXTERNAL_EXECUTION=NOT_EXECUTED
PRODUCTION_READY=NO
NEXT=Implement C5 Recovery Pack production wiring; close P0-B; test actual ONE SI Runtime E2E with real PostgreSQL …
AUDIT_BASIS=CODEX_REPORTED_EVIDENCE_NOT_INDEPENDENTLY_EXECUTED
```

**要点**

1. **PHASE 1 = CLOSED**（C1–C4/C6 全 PASS；C7 为 PASS_WITH_REVISE —— 见下方待收敛项）；
2. `PHASE2_AUTHORIZED = YES_SAFE_SCOPE_ONLY`、`PHASE2_C5_REQUIRED = YES` ⇒ 授权进入 PHASE 2（仅安全范围）；
3. `P0_B_CLOSED = NO` —— Recovery 生产装配尚未修复，符合预期（C5 未做）；
4. `AUDIT_BASIS = CODEX_REPORTED_EVIDENCE_NOT_INDEPENDENTLY_EXECUTED` ⇒ 审计方明确声明**未独立执行**，
   所有结论基于本方送审证据；因此**不得**表述为「已通过独立实测认证」；
5. C7 的 REVISE 项（云端 CI 未观测、manifest 仅在开发分支增补）需在 PHASE 2 收口时一并处理。

> PHASE 1 收口后 checkpoint：`phases['1'] = CLOSED`、`phases['2'] = IN_PROGRESS`、下一单元 `NEXT=C5`。

---

## 3. PHASE 2 / C5 —— Recovery pack 生产装配（**已 CLOSED**：`MSG-20261009-01` PHASE2_CLOSED = YES）

### 3.1 侦察结论（本 tick 实测，只读）

| 事实 | 证据 |
| --- | --- |
| 生产启动入口**未传** `productRecoveryPack` | `rsi-run.ts` 直跑块（P0-B 复现，`MSG-20261008-16`） |
| `productRecoveryPack` 目前**只出现在测试中** | 全仓 grep：`__tests__/*` 5 个文件；`runtime/rsi-run.ts` 仅声明入参 |
| **生产不存在 `RecoveryReadPorts` 实现** | 全仓非测试代码 grep `opportunityRead:\|evidenceRead:\|customsAuthorizationReadinessRead:` = **0 命中** |
| 组合点唯一且强制共享 guard | `createProductRecoverySiPack()` 只接受 `AppActionGuardDeps`（内部唯一 `createAppActionGuard`），禁止自定义 guard port |
| guard 依赖可由 Prisma 直接构造 | `AppActionGuardDeps = { prisma, config?, killSwitchResolver?, audit? }`；缺省 `audit` 走 `createPrismaActionGuardAuditPort(prisma)` |
| `bind` 配方（测试蓝本） | 解析 `^task:recovery:([A-Z_]+):(.+)$` ⇒ `{ organizationId, domain, actionKind, opportunityRef }` |
| `scanScope` 配方 | `loadScanScopeForClaimedTask(prisma, { organizationId, dedupeKey })` ⇒ `{ ok, reasonCodes }` |

### 3.2 实现计划（下一单元执行）

1. 新增 `apps/api/src/runtime/recovery-si-production-composition.ts`：
   - `readPorts`：**新建 Prisma 支撑的只读端口实现**（`opportunityRead` / `evidenceRead` / `customsAuthorizationReadinessRead`），
     只读、按租户过滤、输出经 `scanRecoveryReadOutput` 二次扫描；
   - `bind`：从 `task.dedupeKey` 解析 domain/ref，`organizationId` **从可信持久化事实**（task→incident.sourceRefs）解析，
     不硬编码、不信任客户端自报；
   - `scanScope`：复用 `loadScanScopeForClaimedTask`；
   - `appActionGuardDeps`：`{ prisma }`（共享 guard，不注入自定义实现）。
2. `rsi-run.ts` 直跑入口装配该 pack（**唯一**组装点，不新增 runtime/scheduler/controller）。
3. 真实 PG 验收：`task:recovery:*` 被认领后进入 **recovery-si** domain dispatch（`domainDispatchLog()` 非空）、
   no-op runner 调用数为 0、跨租户与撤销授权仍 fail-closed、重启/接管后仍可续跑。
4. 送独立审计（AUDIT-P2）→ 关闭 C5 / P0-B → 进入 PHASE 3。

### 3.3 本 tick 的诚实说明

本 tick **只完成侦察与设计定稿**，**未提交任何 C5 代码**：因为生产读端口实现不存在，
一次性把「读端口 + 组合 + 接线 + 真实 PG 验收」做完并验证超出本 tick 预算；
按「不得提交未验证代码」的边界，本轮以 durable 设计记录收口，工作树保持 clean。

---

## 4. 连续执行机制（真实建立并已实测，非设计方案）

### 4.1 架构（两段式，成本有界）

| 段 | 载体 | 职责 |
| --- | --- | --- |
| 检测（不调用模型） | **Windows 计划任务** `CrossClaim-SI-RSI-ContinuousCheck`（每 180 秒）→ `node tools/dev/si-rsi-continuous-check.mjs` | 读 HEAD/工作树、读 checkpoint、发现下一个待执行 CHANGE、写日志与 `WAKE_REQUIRED.flag`、单实例锁 |
| 执行（模型侧） | Codex 心跳 `crossclaim-si-rsi-dev-executor-180s`（每 180 秒唤醒本线程） | 按 checkpoint 推进实现 → 测试 → commit → push → 送审 → 归档 |

> 二者都不是产品 Runtime：不创建第二套 SI Runtime / Scheduler / Controller，只做开发侧编排。

### 4.2 实测证据（2026-10-08）

| 验证项 | 结果 | 证据 |
| --- | --- | --- |
| 调度器已安装并启用 | **VERIFIED** | `schtasks /create` 成功；`/query` 显示 Status=Ready、Next Run Time 递增（22:51 → 22:54） |
| 无人输入触发真实检查 | **VERIFIED** | 计划任务于 **22:51:01 自行运行**（Last Run Time 22:51:01 / Last Result 0），日志新增 `run=2` |
| 可恢复 durable checkpoint | **VERIFIED** | `tools/dev/continuous-execution-state.json`（runCount 1→2、headAtLastCheck、lastResult） |
| 自动发现下一个待执行 CHANGE | **VERIFIED** | 日志 `result=NEXT=C3` |
| 执行实例已存在时避免重复启动 | **VERIFIED** | 持锁运行 → `result=SKIPPED reason=LOCKED_FRESH exitCode=0`（不重复执行） |
| 日志含真实时间 / 结果 / 退出码 | **VERIFIED** | `tools/dev/logs/continuous-check.log`：`2026-10-08T13:51:02.167Z result=NEXT=C3 head=9eebd51e … run=2 exitCode=0` |
| 可随时停止 / 禁用 | **VERIFIED** | `/change /disable` → Status=Disabled；`/change /enable` → Status=Ready |
| 崩溃后安全恢复 | **VERIFIED（机制层面）** | 锁带过期时间（>5 分钟可接管）+ checkpoint 每轮重写；**未实测**真实崩溃中断场景 → 记为机制已具备、故障注入待 C6 |

### 4.3 运行时产物不入库

`tools/dev/logs/`、`tools/dev/*.flag`、`tools/dev/.continuous-check.lock`、
`tools/dev/continuous-execution-state.json` 已加入 `.gitignore`（每 3 分钟重写，避免污染工作树与发布门禁）。
权威进度仍以本文件 + `AI-ARCHITECT-INBOX.md` 为准。

### 3.4 实现进展（接线侧已完成，提交 4f0ae85a）

- RsiSafeTask 增加可选 organizationId（仅 durable 任务源在 claim 时填充；JSON legacy 队列不含 ⇒
  Recovery pack fail-closed 拒绝绑定）；
- 新增 untime/recovery-si-production-composition.ts：createProductionRecoveryPackDeps({ prisma })
  —— 共享 guard 只给构造依赖 { prisma }；读端口复用既有 createPrismaRecoveryReadPorts（按调用绑定 actor）；
  ind 的 organizationId 必须来自可信 claim，domain 经**显式映射** LOGISTICS → CARRIER，未知域 unbound；
  scanScope 复用 loadScanScopeForClaimedTask；
- si-run 直跑入口在拿到 Prisma 时装配 productRecoveryPack 并打印 RSI_RECOVERY_PACK=PRODUCT_RECOVERY_SI；
- 验收：si-rsi-phase2-recovery-wiring.test.ts（真实 PG 1/1）—— recovery 任务进入**既有 recovery-si dispatch**
  （domainDispatchLog 非空、packId=recovery-si），caller runner 调用数 0；对照 PHASE 0-B1（0 条 dispatch、恒 BLOCK）。

**仍未完成（下一单元）**：完整 PHASE 2 端到端（真实 PG 全链路 + 故障注入 + 授权复核 + durable 恢复 + 跨租户）
与 **AUDIT-P2**；P0_B_CLOSED 需该端到端验收通过后才可声明。

### 3.5 PHASE 2 审计结论（`MSG-20261008-18`）= PASS_WITH_REVISE（**未 CLOSED**）

审查锚点 `56074920`；会话 `https://chatgpt.com/c/6ac7a850-bf48-83ec-bf2f-3ccc7b1569a1`；
逐字归档 `AI-ARCHITECT-INBOX.md`（FULL_COPY_OK 12/12；sha256 `3ba75b5b…`）。

```
REVIEWED_HEAD = 56074920
C5_IMPLEMENTATION = PASS
C5_REAL_PG_E2E = PASS
C5_SECURITY_BOUNDARY = PASS
PHASE2_VERDICT = PASS_WITH_REVISE
PHASE2_CLOSED = NO
P0_B_CLOSED = NO
CHANGES_REQUIRED = 4
PHASE2_SAFE_REVISIONS_AUTHORIZED = YES
PHASE3_AUTHORIZED = NO
REAL_EXTERNAL_EXECUTION = NOT_EXECUTED
PRODUCTION_READY = NO
```

**如实登记的口径缺口**：该裁决**只给出数量 `CHANGES_REQUIRED = 4`，未列出四项明细**。
按「禁止虚构裁决」的边界，本轮**不推断、不臆造**这四项内容；下一单元的显式动作是
**向审计方索取 4 项 CHANGE 的逐条明细**，再据此实施并按需复审，直至 PHASE 2 = CLOSED。

**注意**：`C5_SECURITY_BOUNDARY = PASS` 但 `P0_B_CLOSED = NO` —— 说明接线本身被认可，
关闭 P0-B 还依赖那 4 项修订；**不得**在实施与复审前声明 P0-B 关闭或进入 PHASE 3
（`PHASE3_AUTHORIZED = NO`）。

### 3.6 PHASE 2 裁决完整正文与 4 项 CHANGE（更正归档 MSG-20261008-19）
【归档缺陷更正】MSG-20261008-18 是按「最小 div 含 VERDICT」抽取的，只拿到机器可读页脚（317 字），**漏了正文**。
已重新完整抽取同一回复（3231 字，连续子串校验通过，sha256 `e9927f83…`）并归档为** `MSG-20261008-19`（FULL_COPY_OK）**。
教训：抽取时必须用「回复末尾唯一句 + 关键小节」双条件定位，不能只按 VERDICT 取最小节点。

**4 项 CHANGE（复审逐字要点）**
1. **CHANGE 1 — P0 生产启动入口一致性**：证明 `systemd → rsi-run → Prisma → Recovery pack → ONE SI Runtime`；
   实际部署入口须包含 `PRODUCT_RECOVERY_SI`；不得存在另一条遗漏 pack 的正式启动路径；使用与生产一致的构建产物验证。
   （Linux 实机不可用时可用同构容器验收，但**不得**宣称 Linux 实机 PASS。）
2. **CHANGE 2 — P0 可信租户来源与授权时效**：核查 `organizationId` 只能由通过服务端授权门禁的 durable claim 写入；
   外部 JSON/API 输入不得伪造；**任务领取后、执行外部动作前撤销授权必须再次被 Guard 拒绝**；重新领取须重新验证授权；所有读端口保持组织隔离。
   要点：**claim 时通过 ≠ 未来动作永久获得授权**。
3. **CHANGE 3 — P1 任务完成状态真实性**：`PROMOTED` 终态映射需语义复审，区分「进入业务链 / 形成有效机会 / 已准备索赔 /
   已提交索赔 / Provider 已确认 / 已收到回款」；**不得因 pack 成功 dispatch 就标记客户任务「追回成功」**；
   `BLOCK` / `WAITING_ON_PROVIDER` / `WAITING_ON_CUSTOMER` 不得误映射为业务完成。
4. **CHANGE 4 — P1 运行时稳定性与可观察性**：补充持续运行验收（多 worker 并发 / 租约到期与续租竞争 / 执行中进程退出 /
   重启幂等恢复 / DB 短暂中断与恢复 / dispatch 日志与 durable 状态一致性）；6/6 不能替代长时间运行验收。

**风险表要点**：第二 Runtime/Scheduler = 未发现；跨租户 = 已有防护与测试；**授权撤销竞态 = 仍需执行时二次复核**；
固定 P2 priority = 非阻断；缺独立 `leaseEpoch` = 需复核 fencing 充分性；Provider 写入 / 关税申报 / 自动 15% 扣佣 = HOLD；生产部署与真实回款 = 未验证。

**终裁**：`PHASE 2 / C5 = PASS WITH REVISE`；允许继续 CHANGE 1–4 的安全范围修订与回归验收；
**暂不授权** PHASE 3–6 自动实施、真实 Provider 写入、正式关税申报、自动支付与生产开闸；
`NEXT` = 完成 CHANGE 1–4 → 提交新 REVIEWED_HEAD + 部署入口验证 + 授权竞态测试 + 业务终态映射证据 → PHASE 2 FINAL 复审。
**不要求重写已通过的 Recovery SI pack，不允许为装配问题建第二个 Runtime，也不允许擅自修改封板 RC。**

### 3.7 P2-CHANGE1（P0）生产启动入口一致性 —— 已实现并取证

**复审要求**：证明 `systemd → rsi-run → Prisma → Recovery pack → ONE SI Runtime`，且部署入口包含 `PRODUCT_RECOVERY_SI`。

**真实运行取证（与 systemd ExecStart 同一构建产物）**
```
node --env-file=.env dist/src/runtime/rsi-run.js      # 即 crossclaim-rsi.service 的 ExecStart 目标
→ RSI_RECONCILE_SOURCE=PRISMA reason=DATABASE_URL_PRESENT
→ RSI_RECOVERY_PACK=PRODUCT_RECOVERY_SI
→ RSI_RUN_STARTED eventDriven=true watchdogIntervalMs=60000
```
（构建产物 `dist/src/runtime/rsi-run.js` 内已含 `createProductionRecoveryPackDeps` 与 `PRODUCT_RECOVERY_SI` 标记。）

**契约测试** `si-rsi-phase2-startup-parity.test.ts`（5/5 PASS）覆盖验收五条：
① RSI unit ExecStart == `apps/api/dist/src/runtime/rsi-run.js`，且该产物含装配与标记；
② 只有 RSI unit 引用 `rsi-run.js`，安装脚本不另起一套（无第二条遗漏 pack 的启动路径）；
③ API/Web/RSI 三者 ExecStart 各不相同（`server.js` / `next` / `rsi-run.js`）；
④ 无 `@` 模板实例、无 unit 互相 `systemctl start`，源码边界 `secondRuntime: 0`；
⑤ 使用生产同构构建产物核对，unit 不含明文凭据且由 `EnvironmentFile` 注入。

**仍未验证（如实标注）**：Linux/systemd 实机与同构容器验收 **NOT VERIFIED**（本机无 systemd、Docker 无响应）
⇒ 只声明「构建产物 + unit 一致性」通过，**不声称** Linux 实机 PASS。

### 3.8 P2-CHANGE2（P0）可信租户来源与授权时效 —— 已实现并取证

**新增能力**：**执行前二次授权复核**（productRecoveryPack.executionPreflight），每次派发 recovery 任务前重查
「该任务的可信租户是否仍存在未撤销且未过期的 Standing Authorization」；不通过 ⇒ BLOCK 并记
RSI_RECOVERY_PREFLIGHT_DENY=<原因码>（不新增任何 runner / controller / scheduler）。

**真实 PostgreSQL 验收**（si-rsi-phase2-execution-preflight.test.ts，4/4 PASS）
| 用例 | 断言 |
| --- | --- |
| C2-1 | 领取时授权有效 ⇒ 照常派发进 recovery-si |
| **C2-2** | **领取后、执行前撤销授权** ⇒ 执行前复核拒绝（实测日志 RSI_RECOVERY_PREFLIGHT_DENY=EXEC_PREFLIGHT_AUTHORIZATION_REVOKED）、不进入业务链、不落 caller runner |
| C2-3 | 原因码区分：无可信租户 EXEC_PREFLIGHT_NO_TRUSTED_TENANT / 授权撤销 EXEC_PREFLIGHT_AUTHORIZATION_REVOKED |
| C2-4 | 读端口组织隔离：跨租户输入被既有 adapter 以 TENANT_MISMATCH 拒绝 |

**行为变化（如实登记）**：执行前复核使「无可信租户」的拒绝**提前到派发之前**，因此原 R6 的
(recovery-namespace-unclaimed) dispatch 记录不再产生（改为 RSI_RECOVERY_PREFLIGHT_DENY 日志）。
R6 断言已按实测更新为「无 recovery-si 记录 + caller runner 0」——这是**更早更严**的 fail-closed，不是放宽。

**口径**：organizationId 仍只由 durable claim（C4 门禁通过后）写入；JSON legacy 来源无该字段 ⇒ 两条防线
（bind 未绑定 + 执行前复核）都会拒绝。回归：SI-RSI 全套件 **10 文件 / 58 tests 全绿**，api tsc 0。

### 3.9 P2-CHANGE3（P1）业务完成状态真实性 —— 已实现并取证

**新增业务结果词表**（`recovery-business-outcome.ts`，纯函数）：
`NOT_DISPATCHED → DISPATCHED → WAITING_ON_PROVIDER / WAITING_ON_CUSTOMER / BLOCKED`（均**非完成**）
`→ OPPORTUNITY_IDENTIFIED → CLAIM_PREPARED`（本地可达上限）`→ CLAIM_SUBMITTED → PROVIDER_CONFIRMED → SETTLEMENT_RECEIVED`（HOLD）。

关键规则：
- **dispatch 本身只得到 `DISPATCHED`**，绝不产出完成级结果（`dispatchImpliesBusinessSuccess = false`）；
- `isTerminalBusinessCompletion` 仅对 `PROVIDER_CONFIRMED` / `SETTLEMENT_RECEIVED` 为真
  ⇒ 「已准备索赔 / 已提交索赔」**都不算**追回成功；
- `internalTaskStatusForBusinessOutcome`：`CLAIM_PREPARED` ⇒ **BLOCKED**（不是 PROMOTED），只有真实终局档才 ⇒ `PROMOTED`；
- `settle({outcome:'COMPLETED'})` 现在**必须携带真实终局业务结果**，否则拒绝（`EXEC_SETTLE_BUSINESS_OUTCOME_NOT_TERMINAL`）。

**验收**（`si-rsi-phase2-business-outcome.test.ts`，4/4 PASS；真实 PG 覆盖守卫）
| 用例 | 断言 |
| --- | --- |
| B1 | dispatch / BLOCKED / WAITING_* 均非完成；仅 PROVIDER_CONFIRMED / SETTLEMENT_RECEIVED 为真实完成 |
| B2 | 推导单调：仅 dispatch ⇒ DISPATCHED；逐级需各自证据；本地**不得**臆造 HOLD 档（无外写/回款证据） |
| B3 | 内部映射：CLAIM_PREPARED ⇒ BLOCKED（关键：不得 PROMOTED） |
| B4 | 真实 PG：无业务结果 与 **仅「已准备索赔」** 均被拒；任务保持 IN_PROGRESS（未被标成拉回成功）；只有 SETTLEMENT_RECEIVED 才放行 ⇒ PROMOTED |

**连带更新**：PHASE 1 的 4 处 `settle(COMPLETED)` lifecycle 测试补上 `businessOutcome: 'SETTLEMENT_RECEIVED'`
（它们验证的是状态机本身，需显式提供真实终局证据）。回归：SI-RSI 全套件 **11 文件 / 62 tests 全绿**，api tsc 0。

### 3.11 P2-CHANGE4（P1）运行时稳定性与可观察性 —— 已实现并取证

**代码新增**：durable 任务源新增 **租约续租** `renew({taskId, ownerRef, leaseMs})` —— CAS
`(status=ACTIVE ∧ ownerRef ∧ expiresAt>now)` 延长 `expiresAt`；被接管后旧 owner 续租一律 **FENCED** 拒绝。

**验收**（`si-rsi-phase2-stability.test.ts`，6/6 PASS，真实 PostgreSQL）
| 用例 | 覆盖复审要求 |
| --- | --- |
| S1 | 多 worker 并发（2 轮 × 4 任务 × 5 worker）⇒ 无重复领取、无遗漏 |
| S2 | **租约到期与续租竞争**：本 owner 续租成功；被 B 接管后旧 owner 续租被 `FENCED_OWNER_MISMATCH` 拒绝且不改变 B 的租约 |
| S3 | 任务执行中进程退出 ⇒ 租约到期后新 owner 接管（无重复副作用） |
| S4 | 重启后幂等恢复 ⇒ 既有 reconcile 第二次 `idempotentNoop=true` |
| S5 | **DB 不可用（注入）** ⇒ 操作 fail-closed、真实库零部分写入，随后仍可正常领取 |
| S6 | **dispatch 日志与 durable 状态一致** ⇒ taskId 与 durable 行一致，状态 `IN_PROGRESS`（派发 ≠ 完成，未误标 `PROMOTED`） |

**⚠️ 如实登记的测试抖动（未掩盖）**：本单元三次连续运行全套件的结果为
**绿 → 1 项失败（未记录到用例名）→ 绿（68/68）**。失败项**未能复现**，因此**无法认定**它与本单元改动无关；
已知诱因是 S1/S3/S5 会创建额外客户端并操作共享表（与仓库既有 P2E-DB5 隔离债同类）。**登记为独立测试隔离债**，
不并入六项生产启用债，也不因此宣称「稳定绿」。

**诚实边界**：S5 是**故障注入**（错误连接串），非真实断电/断连；小时级长跑 soak 与 Linux 实机 **仍未验证**。

### 3.12 PHASE 2 FINAL 复审 —— 送审未完成（AUDIT_PENDING，未伪造裁决）

**发生了什么**：本 tick 已在右侧新会话把 PHASE 2 FINAL 复审请求写入 composer（实测 3906 字符、标记 `CODEX-SI-RSI-P2-FINAL` 在场、
无 `Unknown error`），但**发送动作失败**：
- `pressKey(null,'Return')` 未触发发送（URL 仍为 `https://chatgpt.com/`，composer 仍有内容）；
- `[data-testid="send-button"]` 选择器在 5s 内未命中（selector 超时）。

**处置（按审计桥规则）**：不重试到失控、不伪造裁决 —— 本轮标记 `AUDIT_PENDING`，
不更新 `PHASE2_CLOSED` / `P0_B_CLOSED`（保持 NO）。

**下一 tick 动作**：重新打开新会话 → 先 `getAXState` 取得 composer 与发送按钮的**当前元素索引**（不再依赖 testid / 空索引），
再 `paste` + `click` 发送，并做三项投递校验（composer 清空 / 标记出现在新用户轮 / 进入生成态）后等待与逐字归档。

**送审内容来源（已在库内，可重放）**：本文件 §3.7（CHANGE 1 实跑取证）、§3.8（CHANGE 2 执行前复核）、
§3.9（CHANGE 3 业务结果词表）、§3.11（CHANGE 4 租约续租 + 稳定性 6/6），以及 §3.6 的 4 项 CHANGE 原文。
送审锚点 `REVIEWED_HEAD = 461c54e1`。

### 3.13 PHASE 2 FINAL 独立审计结论（`MSG-20261008-20`）= **REVISE**（PHASE 2 仍未 CLOSED）

- 会话：`https://chatgpt.com/c/6ac7af0b-07c0-83ec-a2d8-c558610bab71`（本轮**新开**会话，未复用旧会话）
- 审查锚点：`461c54e1`；送审标记 `CODEX-SI-RSI-P2-FINAL`
- **投递三项校验**：① composer 清空（粘贴前仅余 1 字符空段落 → 粘贴后 **4496 字符，与请求文本长度完全相等，无重复**）；
  ② 标记作为**新用户轮**出现；③ 进入生成态（`停止` 按钮在场）。
- **逐字归档**：`AI-ARCHITECT-INBOX.md` → `MSG-20261008-20`
  （`FNV1A_MATCH 12cfa524`（原文文件 = 浏览器抽取）；`FULL_COPY_OK` 原文 126 行 / 归档 126 行 / 缺失 0 / 多出 0）
- **抽取纪律（本轮的教训修正）**：不再使用「最小 div 含 VERDICT」的启发式（上轮因此只拿到 317 字页脚）。
  本轮用「以 `CrossClaim · SI-RSI PHASE 2 FINAL` 开头 **且** 含 `PHASE2_FINAL_VERDICT` **且** 不含 `Text length check` 的**最短** `div`」双条件定位，
  抽取后由执行器 REPL **直接落盘**为源文件再交给 `tools/verification/archive-verdict.mjs`，**不经人工转写**。

**逐项裁决（审计方口径）**

| 项 | 裁决 | 依据摘要 |
| --- | --- | --- |
| CHANGE1_PRODUCTION_ENTRY | **PASS** | `dist/src/runtime/rsi-run.js` 实际启动并输出 `PRODUCT_RECOVERY_SI`；启动入口一致性 5/5 PASS；未发现第二套 runtime 的结构性证据。限定：入口一致性成立，**不代** 表 Linux/systemd 实机通过 |
| CHANGE2_TRUSTED_TENANT_AND_AUTH_TIMING | **PASS** | `executionPreflight` 构成必要安全线程；C2-2 证明「执行前授权被撤销 ⇒ 系统拒绝执行」；C2-3/C2-4 覆盖撤销原因码与跨租户读端口 |
| CHANGE3_BUSINESS_OUTCOME_TRUTH | **REVISE** | 词表方向正确，但**缺少可信终局事实的来源证据**：终局结果必须绑定已验证的 provider/settlement evidence、可信来源与 case/organization lineage |
| CHANGE4_RUNTIME_STABILITY | **REVISE** | 6/6 场景通过，但全套件三次运行为 绿 → FAIL 1 → 绿（未记录失败用例）⇒ 不能宣告稳定 |
| P0_B_CLOSED | **NO** | 原始 P0-B 是「生产任务进入 Recovery SI 同步链 BLOCK、无法进入实际业务链」；本轮只证明入口能装配 pack 且能派发 `recovery-si`，**缺少真实业务步骤执行的端到端证据** |
| PHASE2_CLOSED | **NO** | 3 项 CHANGE 未关闭 |

**本轮新增 3 个 CHANGE（审计方指定，最小范围；不重写已通过的 Recovery SI pack）**

1. **CHANGE 3A（P0）可信终局事实**：终局结果（`PROVIDER_CONFIRMED` / `SETTLEMENT_RECEIVED`）必须在 `businessOutcome` 生成、
   持久化与 `settle()` 的**完整调用链**上绑定「已验证的 provider/settlement evidence + 可信来源 + case/organization lineage」；
   runner、任务输入与非可信调用者**不得自行声明**终局；增加「伪造终局结果」的真实 PostgreSQL 拒绝测试；
   外部 Provider HOLD 期间**不得**用模拟终局事实把客户任务写成业务完成。
2. **CHANGE 4A（P1）失败定位与隔离**：保存完整测试日志（含失败用例名、堆栈与测试数据库标记）；收拢 S1/S3/S5 的客户端释放、
   数据清理与共享表竞争；对偶发失败用例实现隔离；在固定环境下连续运行 **≥5 轮**相关完整套件且全部通过后再提交记录；
   小时级 soak、真实断电与 Linux 实机验收仍属**独立生产验收事项**。
3. **CHANGE P0-B1（P0）生产同构业务链 E2E**（真实 PostgreSQL + 真实 Recovery Pack + 真实 controller/event loop + 现有业务 read ports）至少证明：
   ① 有效授权任务从 `rsi-run` 同构组装入口进入业务步骤；② 真实 Recovery domain step 确实执行（而非只写 dispatch 日志）；
   ③ 本地机会识别或索赔准备产生**可审计的 durable 记录**；④ 未授权 / 跨租户 / 授权中途撤销时业务步骤**不执行**；
   ⑤ 全程无外部写入、不依赖真实 Provider 凭据、不新增第二 runtime。

**审计方明确保留与限制**：已通过的生产启动装配、可信租户控制、执行前授权复核**予以保留**，不要求重写；
下一轮只补足三处证据与实现缺口；**不允许为通过审计放宽安全门禁**，不允许修改已封板 RC。
三项通过后可申请 **PHASE 2 FINAL-R2** 独立复审。

**状态登记**
```
REVIEWED_HEAD = 461c54e1
PHASE2_FINAL_VERDICT = REVISE
CHANGE1 = PASS
CHANGE2 = PASS
CHANGE3 = REVISE
CHANGE4 = REVISE
P0_B_CLOSED = NO
PHASE2_CLOSED = NO
NEXT = CHANGE_3A_TRUSTED_TERMINAL_EVIDENCE + CHANGE_4A_TEST_ISOLATION + P0_B1_REAL_DOMAIN_E2E + REQUEST_PHASE2_FINAL_R2_AUDIT
REAL_EXTERNAL_EXECUTION = NOT_EXECUTED
PRODUCTION_READY = NO
```

**送审瑕疵（如实登记；不影响裁决判据）**：本轮请求正文末尾多出一行无意义的 `Text length check:`（送审脚本模板残留）。
该行位于全部送审判据**之后**，未影响任何 CHANGE 判据，故**未重发**请求（避免重复送审产生第二份裁决）；其余正文与 §3.6–§3.11 一致。

**本 tick 的下一单元（从 `461c54e1` 之后的当前 HEAD 继续，不询问用户）**：CHANGE 3A → CHANGE 4A → P0-B1 → PHASE 2 FINAL-R2 复审。

### 3.14 CHANGE 3A（P0）可信终局事实 —— 已实现并取证

**审计指出的缺口（`MSG-20261008-20` 的 CHANGE 3 = REVISE）**：终局档缺少**可信来源证据**。
实现前的真实行为是：`deriveRecoveryBusinessOutcome` 接受 `providerConfirmed` / `settlementReceived` 这类**调用者自报布尔**，
且 `settle({ outcome: 'COMPLETED', businessOutcome: 'SETTLEMENT_RECEIVED' })` 在**没有任何证据**时即可把任务落成 `PROMOTED`
—— 等于「把档案名报对就算追回成功」。

**新增模块** `apps/api/src/runtime/recovery-terminal-evidence.ts`（**纯判定**：不读凭据、不写库、无外部写）

- 终局来源是一份 **allow-list 注册表**；生产 `PRODUCTION_TERMINAL_EVIDENCE_SOURCES` **全部 `enabled: false`**
  （真实 Provider 确认与结算入账都需要外部能力，当前全部 HOLD ⇒ 生产上没有任何可被信任的终局来源）。
- 类别 ↔ 档位**唯一映射**：`PROVIDER_CONFIRMATION → PROVIDER_CONFIRMED`、`SETTLEMENT_LEDGER_ENTRY → SETTLEMENT_RECEIVED`。
- 判定（任一不满足即拒绝，返回原因码）：
  `TERMINAL_EVIDENCE_MISSING` → `_KIND_MISMATCH` → `_SOURCE_UNKNOWN` → `_SOURCE_KIND_MISMATCH` → **`_SOURCE_DISABLED`**
  → `_NOT_VERIFIED` → **`_SELF_DECLARED`**（`verifiedBy ∈ {RUNNER, TASK_INPUT, LOCAL_SIMULATION, LOCAL_SIM, CLIENT, UNKNOWN}`）
  → `_VERIFIER_NOT_AUTHORIZED`（必须等于该来源登记的校验者） → `_NO_VERIFICATION_REF`（空或占位 token `timeout`/`unconfigured`…）
  → `_MISSING_EVENT_ID` → `_OBSERVED_AT_INVALID` → **`_TENANT_MISMATCH`** → **`_TASK_LINEAGE_MISMATCH`** → `_ACCOUNT_MISMATCH`。

**生成侧收紧**：`deriveRecoveryBusinessOutcome` **删除** `providerConfirmed` / `settlementReceived` 入参；
终局档只能来自 `createAuthorizedTerminalOutcome()` / `deriveTrustedOutcomeOf()` 产出的**授权对象**（证据不通过 ⇒ `null`）。
边界常量新增 `terminalOutcomeRequiresTrustedEvidence: true`、`selfDeclaredTerminalAccepted: false`。

**持久化侧门禁（真正的 gate）**：`settle()` 在**同一事务内**、**在释放租约 / 改写任务状态之前**重新判定：
权威租户 = `task → incident(CUSTOMER_GOAL_QUEUE) → sourceRefs[0].organizationId → Organization 必须存在`（**绝不用请求里的租户**）；
权威 lineage = 本任务的 `dedupeKey`。生成侧的授权只是**建议**，能否落 `PROMOTED` 由这里决定；拒绝时保持 `IN_PROGRESS`，零部分写入。
拒绝同时输出 `RSI_TERMINAL_EVIDENCE_DENY=<原因码>`（可观察性）。

**验收**（`apps/api/src/__tests__/si-rsi-phase2-trusted-terminal.test.ts`，**9/9 PASS**，真实 PostgreSQL）
| 用例 | 覆盖的审计要求 |
| --- | --- |
| T1 | **生产默认（HOLD）终局档不可达**：即使证据字段齐全，也被 `TERMINAL_EVIDENCE_SOURCE_DISABLED` 拒绝，任务保持 `IN_PROGRESS`、租约保持 `ACTIVE` —— 直接证明「不得用模拟终局事实把任务写成业务完成」 |
| T2 | **自报终局被拒**：`RUNNER` / `TASK_INPUT` / `LOCAL_SIMULATION` 的 `verified=true` 一律 `_SELF_DECLARED` |
| T3 | 跨租户终局事实被拒（`_TENANT_MISMATCH`） |
| T4 | 错配归属被拒（证据 `taskDedupeKey` ≠ 本任务 ⇒ `_TASK_LINEAGE_MISMATCH`） |
| T5 | 类别/档位唯一对应（`PROVIDER_CONFIRMATION` 不得充当回款 ⇒ `_KIND_MISMATCH`） |
| T6 | 非终局档（`DISPATCHED` / `CLAIM_PREPARED` / `CLAIM_SUBMITTED`）不得落业务完成 |
| T7 | 机制可达性：**显式启用来源**（测试注入）+ 证据齐备时才允许 `PROMOTED`（证明门禁不是「一律拒绝」的死码） |
| T8 | 纯函数判定表：缺失 / 未校验 / 占位引用 / 无事件号 / 时间非法 / 未知来源 / 未授权校验者 / 租户空 全覆盖 |
| T9 | 生成侧：自报布尔不再能推导终局档；授权对象 + 来源启用才可；来源未启用 ⇒ `null` |

**既有测试的口径修订（如实登记：属收紧，不是放宽）**
- `si-rsi-phase2-business-outcome.test.ts` B4：原「只给出终局档即放行」的断言**已作废**，改为
  「无证据 ⇒ `TERMINAL_EVIDENCE_MISSING`，且任务仍 `IN_PROGRESS`、租约仍 `ACTIVE`（零部分写入）」。
- `si-rsi-phase1-finalization`（C2-2）/ `si-rsi-phase1-fault-matrix`（M3/M8）/ `si-rsi-phase1-retry-lifecycle`（C3-4）：
  这三者验证的是 **fencing / 生命周期**，不是终局证据；为保持其原判据，显式注入了**测试专用**启用来源
  （`createTestTerminalEvidenceSource`，仅测试/同构验收可调用，生产代码不得调用）+ 已验证证据。

**回归**：SI-RSI 全套件 **13 文件 / 77 tests**，连续 **2 次**全绿（本轮 +1 文件 / +9 tests）；`api tsc --noEmit` = **0**。
未改动 Prisma schema（无新迁移）。

**诚实边界（不得默认为已解决）**：CHANGE 4A 要求的「≥5 轮连跑 + 失败用例日志留存」**本轮未执行**（属 4A）；
本机 Linux/systemd 实机、真实浏览器验收仍 **NOT VERIFIED**；真实 Provider 写入 / 支付 / 报关 = HOLD；
`REAL_EXTERNAL_EXECUTION = NOT_EXECUTED`；`PRODUCTION_READY = NO`。

**剩余未关闭**：CHANGE 4A（P1 失败定位与隔离）、P0-B1（P0 生产同构业务链 E2E），随后申请 PHASE 2 FINAL-R2 复审。

### 3.15 CHANGE 4A（P1）失败定位与测试隔离 —— 已实现并取证

**审计要求（`MSG-20261008-20`）**：保存完整测试日志（含失败用例名、堆栈与**测试数据库标记**）；收拢 S1/S3/S5 的
客户端释放、数据清理与共享表竞争；对偶发失败用例实现隔离；在固定环境下**连续 ≥5 轮**相关完整套件全部通过后再提交记录；
小时级 soak / 真实断电 / Linux 实机验收仍属**独立生产验收事项**。

**① 测试卫生助手** `apps/api/src/__tests__/si-rsi-test-db.helper.ts`（非 `.test.ts`，不被 vitest 收集）
- `testDatabaseMarker()`：只回「主机:端口/库名」，**绝不回显用户名或口令** → 日志/汇总里可安全携带「跑的是哪个库」；
- `unreachableDatabaseUrl()`：由**真实测试库 URL** 派生不可达 URL（只换端口 + 库名）—— 上一版 S5 里硬编码的
  `postgresql://user:pass@127.0.0.1:55999/nope` **已移除**，仓库内不再出现任何凭据字面量；
- `uniqueTaskKeys()`：每轮独立任务键，避免共享表上的跨轮键竞争。

**② S1/S3/S5 收拢（`si-rsi-phase2-stability.test.ts`）**
- S1：改用 `uniqueTaskKeys(...)` 逐轮独立键；清理移入 `try/finally`（断言失败也不把脏数据留给下一个用例）；
  新增「赢家数 = 任务数 = 4 条 ACTIVE 租约」断言；
- S3：新增「接管后仅 1 条租约行、仅 1 条任务行」断言（无重复副作用 / 无键漂移）；
- S5：故障注入改用派生 URL；`$disconnect()` 仍在 `finally`；新增「真实库零残留（AutonomyTask / AutonomyLease 均为 0）」
  与「数据库标记不含 `@`」断言。

**③ 一次性取证器** `tools/dev/run-si-rsi-suite.mjs`（**不是**第二套运行时/调度器）
- 一次性 CLI：跑完 N 轮即退出并返回退出码；**无定时器、无守护进程、无服务端**；
- 每轮**完整原始日志**落 `tools/dev/logs/si-rsi-suite/<label>-round<N>.log`（该目录已 gitignore），
  汇总里记录**失败用例名 / 堆栈片段 / `Failed Tests` 原文段落 / 每轮退出码 / 耗时 / HEAD / 是否 dirty / 数据库标记**；
- `--per-file` 隔离模式：**每个测试文件单独进程**运行并记录每文件 `exitCode / tests / 失败用例名`
  —— 用于把偶发失败定位到具体文件（这是本轮对「偶发失败用例隔离」的可执行答案：先按文件隔离复现，再按用例隔离）；
- 失败**不做自动重试**（不掩盖 flaky）；有任何一轮非 0 退出即以非 0 退出码结束。

**④ 取证结果（固定环境：本机 PostgreSQL；数据库标记 `127.0.0.1:55432/crossclaim`）**
| 模式 | 标签 | HEAD | 工作树 | 轮数 | 结果 |
| --- | --- | --- | --- | --- | --- |
| 全套件连续 | `change4a-5x-clean` | `e5c73755` | clean | **5** | **ALL_GREEN**（每轮 13 文件 / **77 tests**，耗时 17.2–17.6s） |
| 逐文件隔离 | `change4a-perfile-1x` | `e5c73755` | clean | 1（13 个独立进程） | **ALL_GREEN**（聚合 exit=0；每文件结果逐个记录） |

冻存证据（可提交、含全部字段）：
- `tools/verification/si-rsi-suite-runs/change4a-5x.json`
- `tools/verification/si-rsi-suite-runs/change4a-perfile-1x.json`

重放命令（同一台机器、真实 PostgreSQL）：
```
node tools/dev/run-si-rsi-suite.mjs --rounds 5 --label change4a-5x-clean
node tools/dev/run-si-rsi-suite.mjs --rounds 1 --per-file --label change4a-perfile-1x
```

**⑤ 关于「先失败后修复」的诚实登记**：本轮实现过程中确实出现 1 次真实失败 ——
`si-rsi-phase2-business-outcome.test.ts` B4 断言 `TERMINAL_EVIDENCE_SOURCE_DISABLED` 实测为 `TERMINAL_EVIDENCE_MISSING`
（判定顺序：证据缺失先于来源启用判定）。**定位方式**：运行器输出的失败用例名 + `→ expected … to be …` 堆栈片段；
**修复**：按实际判定顺序修正断言并补充顺序说明（属断言口径修正，非放宽安全语义）；修复后 5 轮全绿。
该失败发生在 CHANGE 3A 单元（`a296879d` 之前），此处一并登记以便审计追溯。

**仍为独立生产验收事项（本轮未做，不得默认为已解决）**：小时级长跑 soak、真实断电/断连、Linux 实机 systemd 与真实浏览器验收
= **NOT VERIFIED**；`REAL_EXTERNAL_EXECUTION = NOT_EXECUTED`；`PRODUCTION_READY = NO`。

**剩余未关闭**：仅 **P0-B1（P0 生产同构业务链 E2E）**，完成后申请 PHASE 2 FINAL-R2 复审。

### 3.16 P0-B1（P0）生产同构业务链 E2E —— 已实现并取证

**审计指出的缺口（`MSG-20261008-20`：`P0_B_CLOSED = NO`）**：此前只有**内存 dispatch log**；
pack 跑完（只读步骤确实执行）之后**没有任何 durable 痕迹**，因此无法证明「真实业务步骤执行」，
而不是「只写了一条 dispatch 日志」。审计明确要求：本地机会识别必须产生**可审计的 durable 记录**。

**① 新增 `apps/api/src/runtime/recovery-domain-outcome-recorder.ts`**（host 层，**不是**第二套 runtime）
- 把 domain step 的**最终结论**写成一条**追加式审计事实**（既有 `AuditLog` 表，租户归属）：
  `action = RECOVERY_DOMAIN_STEP_EXECUTED`、`entityType = 'AutonomyTask'`、`entityId = taskId`；
- `changes` 只放**非敏感投影**：`packId / dedupeKey / status / evidenceRef / reasonCodes / domain /
  opportunityRef / guardActions / businessOutcome / externalWritePerformed=false`；
- `businessOutcome` 用 §3.9 词表：**PASS ⇒ `OPPORTUNITY_IDENTIFIED`**，其它 ⇒ `BLOCKED`
  —— **绝不**产生终局完成档（终局另有 CHANGE 3A 的可信证据门禁）；`updatesTaskState = false`；
- **幂等**：PASS 以 `evidenceRef`、BLOCK 以**原因码集合**作稳定键，同因不重复追加、异因各留一条；
- **fail-closed**：无可信租户 ⇒ 不写任何行（也不猜租户）。

**② domain 派发层接入**（`rsi-domain-pack.ts`）：新增 host 钩子 `onEvidence`（含 `reasonCodes`）；
PASS 与 BLOCK **都要留痕**；钩子抛错 ⇒ **降级为 BLOCK**（`domain-pack:outcome-record-failed`）
—— 绝不允许「审计写失败但仍报 PASS」。
`rsi-run.ts` 的 `composeRsiRuntime` 新增 `onDomainPackEvidence` 透传（缺省不记录 ⇒ 对既有调用方向后兼容）。

**③ 验收 `si-rsi-phase2-production-e2e.test.ts`（6/6 PASS，真实 PostgreSQL）**
组装方式与生产一致：`composeRsiRuntime` + `createAutonomyTaskSource`（durable 领取）+ `createProductionRecoveryPackDeps`
（真实 Recovery pack + 既有 Prisma 只读 read ports）+ 结果记录器。

| 用例 | 对应审计判据 | 断言要点 |
| --- | --- | --- |
| E1 | ① 入口 + ③ durable 记录 | 有效授权任务经 durable claim 进入 `recovery-si` 业务步骤；**读回数据库**得到 1 条 `AuditLog`：租户=org-A、`actorType=SYSTEM`、`entityType=AutonomyTask`、`entityId=任务行 id`、`status=PASS`、`domain=CARRIER`、`opportunityRef=<任务引用>`、`businessOutcome=OPPORTUNITY_IDENTIFIED`、`evidenceRef` 形如 `recovery-si:CARRIER:<12 hex>`、`externalWritePerformed=false` |
| E2 | ② 真读业务事实（反证） | **不播种**机会行 ⇒ domain step 必须 BLOCK，且留痕 `reasonCodes=['RECOVERY_READ_TOOL_FAILED','recovery.opportunity.read','TOOL_THREW']` ⇒ 证明只读端口真在查库，而不是空跑成功 |
| E3 | ④ 未授权 | 授权已撤销 ⇒ 任务未被领取、dispatch 为空、**审计表为空**（业务步骤未执行） |
| E4 | ④ 授权中途撤销 | 领取后撤销 ⇒ `executionPreflight` 返回 `EXEC_PREFLIGHT_AUTHORIZATION_REVOKED`，业务步骤不执行、无留痕 |
| E5 | ④ 跨租户 | org-B 的机会不会被 org-A 的任务读到（BLOCK），留痕归属**执行租户 org-A** |
| E6 | ⑤ 边界 | 无外部写 / 不读凭据 / 不改任务状态 / 不产生终局完成；`runtimeMembers().secondRuntime = 0` 且 `domainPacks=['recovery-si']`（**无第二 runtime**）；重复记录幂等（`ALREADY_RECORDED`）；无可信租户拒绝写入 |

**④ 回归**
- SI-RSI 全套件 **14 文件 / 83 tests**（新增 1 文件 / 6 tests），`node tools/dev/run-si-rsi-suite.mjs --rounds 2` **连续 2 轮 ALL_GREEN**；
- 受影响的**核心运行时定向回归**（`rsi-*`、`historical-scan-*`、`agent-goal*`、部署契约）**20 文件 / 199 tests 全绿**；
- `api tsc --noEmit` = **0**；未改 Prisma schema（复用既有 `AuditLog`，无新迁移）。

**⑤ 诚实登记（不得默认为已解决）**
1. **全量套件未完成**：`apps/api` 共 **480 个测试文件**，且因共享数据库 `fileParallelism:false` 串行执行；
   本轮一次全量尝试运行约 **18 分钟仍未结束**，已主动终止（未取得全量结果）。**不声称全量通过**；
   继续沿用项目既有做法（定向回归 + SI-RSI 全套件多轮），并保留「全量耗时」为待办。日志/退出码：手动终止 ⇒ 无完整结论。
2. **后台运行时进程（潜在隔离干扰源）**：本机存在 **3 个后台 `rsi-run` 进程**共享同一 dev 数据库
   （2 个 `tsx src/runtime/rsi-run.ts` 起于 2026-10-05，1 个 `dist/src/runtime/rsi-run.js` 起于 2026-10-08 18:24）。
   它们会周期性轮询同一 durable 队列，**可能是此前「未复现 1 项失败」与既有 P2E-DB5 隔离债的同源诱因**。
   **未擅自终止**（非本任务创建），登记为待 HOST 决定的开发环境事项。
3. 小时级 soak / 真实断电 / Linux 实机 systemd / 真实浏览器验收 = **NOT VERIFIED**；
   `REAL_EXTERNAL_EXECUTION = NOT_EXECUTED`；`PRODUCTION_READY = NO`。

**PHASE 2 状态**：审计指定的三项（CHANGE 3A / CHANGE 4A / P0-B1）**均已实现并取证** ⇒
`PHASE2_CLOSED` 仍为 **NO**，等待 **PHASE 2 FINAL-R2** 独立复审；复审前不自行宣告 CLOSED。

### 3.17 PHASE 2 FINAL-R2 独立审计结论（`MSG-20261009-01`）= **PASS** ⇒ PHASE 2 = CLOSED

- 会话：`https://chatgpt.com/c/6ac7ba95-9654-83ec-bd86-557f4ec1d78a`（本轮**新开**会话）
- 审查锚点：**`5732b190`**；审计方自定编号 **`MSG-20261009-01`**；`AUDIT_BASIS = SUBMITTED_EVIDENCE_ONLY`
- **投递校验**：composer 粘贴前为空 → 粘贴后 **6258 字符（= 请求文本长度，无重复）**；标记 `CODEX-SI-RSI-P2-FINAL-R2` 作为**新用户轮**出现；进入生成态（`停止` 按钮在场）；等待至 `回答已完成`
- **逐字归档**：`AI-ARCHITECT-INBOX.md` → `MSG-20261009-01`
  （`FNV1A_MATCH ea6e1d04`（原文文件 = 浏览器抽取）；`FULL_COPY_OK` 原文 99 行 / 归档 99 行 / 缺失 0 / 多出 0）；
  会话原始抽取 sha256 = `bbe649ac…`

**逐项裁决（审计方原文）**

| 项 | 裁决 | 审计方关键依据 |
| --- | --- | --- |
| CHANGE3A_TRUSTED_TERMINAL_EVIDENCE | **PASS** | 终局证据来源白名单、生产默认关闭、事务内权威事实复核、9/9 PostgreSQL 测试 |
| CHANGE4A_TEST_ISOLATION | **PASS** | 全套件连续 5 轮 77/77、13 个独立进程全部通过、失败日志完整保留 |
| P0_B1_REAL_DOMAIN_E2E | **PASS** | 真实 PostgreSQL、durable claim、实际 read ports、AuditLog 持久化、6/6 E2E |
| P0_B_CLOSED | **YES** | 已提供真实业务步骤执行与数据库事实证据，而非仅内存 dispatch |
| PHASE2_CLOSED | **YES** | CHANGE1/2 沿用前次 PASS，CHANGE3A/4A/P0-B1 本轮通过 |

**审计方明确写下的限制（逐字要点）**

1. 「本次是基于 Codex 提交材料的**证据审计**，并非独立拉取 `5732b190` 后重新执行的源码审计」⇒ `AUDIT_BASIS = SUBMITTED_EVIDENCE_ONLY`；
2. 「裁决结论：PHASE 2 可以关闭，P0-B 可以关闭，但**不代表生产就绪**」；
3. CHANGE 3A：`PASS`，但**「本项通过，不授权开启生产终局证据来源」**；T7 的测试来源启用 ≠ 生产来源开通；
4. CHANGE 4A：`PASS（限已执行测试范围）`，并列出三项验证限制 —— **全量 API 测试未完成（480 文件不得宣称全通过）**、
   **三个长期运行的 `rsi-run` 进程共享开发数据库仍有环境干扰风险**、**小时级 soak / Linux systemd 实机 / 断连与重启恢复未完成**；
5. P0-B1：`PASS`，但保留语义区分 —— `RECOVERY_DOMAIN_STEP_EXECUTED` **只证明执行结论被持久化**，
   不等于真实索赔已提交 / Provider 已确认 / 款项已到账；「当前尚无证据证明外部追回完整闭环」。

**机器可读终局块（审计方原文）**
```
AUDIT_ID = MSG-20261009-01
REVIEWED_HEAD = 5732b190
AUDIT_BASIS = SUBMITTED_EVIDENCE_ONLY
PHASE2_FINAL_R2_VERDICT = PASS
CHANGE3A = PASS
CHANGE4A = PASS
P0_B1 = PASS
P0_B_CLOSED = YES
PHASE2_CLOSED = YES
NEXT = PHASE3_PRODUCTION_VALIDATION_AND_PROVIDER_READINESS
FULL_API_REGRESSION = NOT_VERIFIED
LINUX_SYSTEMD_E2E = NOT_VERIFIED
HOUR_LEVEL_SOAK = NOT_VERIFIED
REAL_EXTERNAL_EXECUTION = NOT_EXECUTED
REAL_VALIDATION_COMPLETE = NO
PRODUCTION_READY = NO
EXTERNAL_WRITE = HOLD
CUSTOMS_FILING = HOLD
PAYMENT = HOLD
AUTO_COMMISSION_CHARGE = HOLD
PRODUCTION_ENABLEMENT = HOLD
```
审计方并明确要求：**不得因本轮 `PHASE2_CLOSED = YES` 自动把 `PRODUCTION_READY` 改为 YES**。

#### 3.17.1 阶段编号歧义（登记，待 HOST 确认一次即可）

本文件 §2 的**原始** PHASE 2–6 是「自恢复能力」计划（PHASE 2 = API 故障自动诊断与恢复、PHASE 3 = 业务错误自动重新规划…）；
而本轮 HOST 指令把 **PHASE 2** 定义为「Recovery pack 生产装配（C5）」，审计方随该口径给出
`NEXT = PHASE 3 — Production Validation & Provider Readiness`（生产验证与 Provider 就绪）。
两者**编号相同、内容不同**。处理口径（本轮采用）：
- **PHASE 2 以本轮 HOST 指令的口径为准并已 CLOSED**（`MSG-20261009-01`）；
- **下一单元按审计方 `NEXT` 推进 PHASE 3 = Production Validation & Provider Readiness**；
- 原始自恢复计划的 PHASE 3–6（业务重新规划 / 持续学习 / Bug 自发现 / 故障注入矩阵）**不删除、不顺延改号**，
  仍以 §2 表格为准，待 PHASE 3 推进到位后由 HOST 决定二者先后。

#### 3.17.2 下一单元（PHASE 3）的可自行执行子集 vs HOST 阻断

审计方给出的 PHASE 3 五步中，**只有前两类可在本机自行推进**：

| PHASE 3 步骤 | 本机可执行性 | 处置 |
| --- | --- | --- |
| ① 环境隔离：确认 3 个既有 `rsi-run` 进程的用途/所有者；创建独立 staging 数据库 | 核查可自行做；**停止他人进程 / 建 staging 库需 HOST 决定** | 本 tick 只登记，不擅自动手 |
| ② 生产同构验收：Linux systemd 启动/停止/重启/租约接管/授权撤销/幂等/审计一致性 | **不可**（本机无 systemd、无 Linux 实机） | **HOST_ACTION_REQUIRED**：提供 Linux 实机或确认同构容器方案 |
| ③ 稳定性与回归：小时级 soak、故障恢复、**尚未取得结果的全量 API 回归** | soak 可自行做但耗时；全量 API 回归（480 文件）本机可得但需长时间串行 | 下一单元优先「取得全量 API 回归结果」 |
| ④ 真实 Provider 集成（读取/提交/终局确认/结算） | **不可**（需授权、合规审查与有效凭据） | **HOLD**，HOST 单独授权 |
| ⑤ 发布门禁：关键生产验证关闭前继续 HOLD 外写/申报/支付/扣佣 | 口径已固化 | 继续执行 |

**本 tick 结论**：PHASE 2 = **CLOSED**（范围内验收通过）；`PRODUCTION_READY = NO` 不变；
下一步 = PHASE 3 的**本机可执行子集**（先取得全量 API 回归结果），Linux 实机 / staging / 真实 Provider 属 HOST_ACTION_REQUIRED。

### 3.18 PHASE 3 子集 ③ —— 全量 API 回归**已取得结果**（FULL_API_REGRESSION：完成，4 项失败已定位分类）

审计方在 `MSG-20261009-01` 把 `FULL_API_REGRESSION` 标为 **NOT_VERIFIED**。本轮把它跑完并做了失败定位。

**取证器增强（本 tick 提交）**：`tools/dev/run-si-rsi-suite.mjs`
- 新增 `--all`：递归发现 `src/**/*.test.ts`（本次 480 个文件）；
- 日志改为**直接写文件描述符**（而不是进程结束后一次性落盘）⇒ 长跑期间可 `tail` 观察进度，
  不再出现「跑了几十分钟不知卡在哪」；`--per-file` 模式逐文件打印结果行。
- 性质不变：**一次性**工具，无定时器 / 无守护进程 / 无服务端；失败不自动重试（不掩盖 flaky）。

**命令与结果**
```
node tools/dev/run-si-rsi-suite.mjs --rounds 1 --all --label full-api-1x
```
| 指标 | 结果 |
| --- | --- |
| 测试文件 | **480**：**477 passed / 3 failed** |
| 测试用例 | **4800**：**4796 passed / 4 failed** |
| 耗时 | **1462.67 s（≈24.4 分钟）**（transform 6.38s / collect 70.89s / tests 1272.11s） |
| 被测产品代码 | `056e5327`（工作树 dirty=true —— **唯一**未提交改动是取证器本身，非产品代码） |
| 数据库标记 | `127.0.0.1:55432/crossclaim` |
| 原始日志 | `tools/dev/logs/si-rsi-suite/full-api-1x-round1.log`（运行时产物，已 gitignore） |
| 冻存证据 | `tools/verification/si-rsi-suite-runs/full-api-1x.json` |

**4 项失败用例（逐字）**
1. `recovery-si-phase2-e-db.test.ts` → `P2E-DB5 真实 gate=ALLOW → 六单元在同一事务落库（JSON+PDF）…`
2. `reconciliation-schema-s1-db.test.ts` → `R45 S1 · 结构（七表 / 七枚举 / 触发器覆盖）> 七个枚举全部存在`
3. `claim-items-db.test.ts` → `C-0011 … platformRef 为空：允许创建两条…告警`
4. `claim-items-db.test.ts` → `C-0011 … 状态机 + caseId 不变量 + 关闭原因，并且审计带 from/to/…`

**失败定位（单文件隔离复跑，CHANGE 4A 的纪律）**
```
node apps/api/node_modules/vitest/vitest.mjs run \
  src/__tests__/recovery-si-phase2-e-db.test.ts \
  src/__tests__/reconciliation-schema-s1-db.test.ts \
  src/__tests__/claim-items-db.test.ts        # cwd = apps/api
→ Test Files 1 failed | 2 passed (3)；Tests 1 failed | 53 passed (54)
```
| 文件 | 隔离复跑 | 结论 |
| --- | --- | --- |
| `recovery-si-phase2-e-db.test.ts`（P2E-DB5） | **PASS** | **已知测试隔离债**（`MSG-20261008-14` 早已登记），全量并发/共享库下暴露 |
| `claim-items-db.test.ts` | **PASS** | 同类隔离/时序债（10.0s + 3.3s 长耗时用例） |
| `reconciliation-schema-s1-db.test.ts` | **FAIL（确定性）** | **真实环境漂移**，见下 |

**确定性失败的根因（可复现证据，只读查询）**
```
SELECT n.nspname AS schema, t.typname AS name
FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE t.typtype = 'e' AND t.typname IN
  ('ReconciliationProjectionStatus','ReimbursementFactKind','ReimbursementSourceKind');
→ public ×3 + rc_c3_fresh_check ×3（同一名字各出现两次）
ENUMS_BY_SCHEMA = public: 73 个枚举；rc_c3_fresh_check: 73 个枚举
```
开发库中残留了历史 schema **`rc_c3_fresh_check`**（与 `public` 各持同一整套枚举）；该用例按 `typname` 查询 `pg_type`
**未按 schema 过滤** ⇒ 每个枚举命中两行 ⇒ 集合相等断言失败。
**与本轮 PHASE 2 改动无关**：本工作流**未改 Prisma schema、未加迁移**，且该用例不在受影响路径上。

**处置（不擅自做破坏性操作）**：`DROP SCHEMA rc_c3_fresh_check CASCADE` 属破坏性且可能是他人验证资产 ⇒ **未执行**；
建议二选一（待 HOST 决定）：① 在 dev 库删除该残留 schema；② 让该用例按 `current_schema()` / `pg_namespace` 过滤后再比较。
两项均**未**在本 tick 执行，登记为 PHASE 3「环境隔离」步骤的输入。

**口径更新**：`FULL_API_REGRESSION = COMPLETED_WITH_4_FAILURES（3 文件；2 文件隔离复跑通过 = 隔离债，1 文件确定性失败 = 开发库 schema 漂移）`；
**仍不得**据此宣称「全量绿」；`PRODUCTION_READY = NO` 不变。

### 3.19 P2E-DB5 隔离债 —— 根因定位并已修复（登记自 `MSG-20261008-14`）

**症状**：全量回归（480 文件）中 `recovery-si-phase2-e-db.test.ts` 的 **P2E-DB5** 失败，断言输出 `expected 1 to be +0`；
**单文件隔离运行却通过** ⇒ 判定为跨文件/环境隔离债（非确定性回归）。

**根因（只读探针证明，非推测）**
1. P2E-DB5 的「零外写」八条断言当时使用**全表计数**（`prisma.settlement.count()` 等，无 where）；
2. 同库其它测试文件跑完**会残留业务行**：

| 污染源文件 | 残留 | 原因 |
| --- | --- | --- |
| `src/__tests__/claim-items-db.test.ts` | `Settlement` **1 行** | 只在 `beforeEach` TRUNCATE，文件结束时最后一个用例的行保留 |
| `src/__tests__/action-guard-payment-capture-http-db.test.ts` | `BillingInvoice` **1 行** | 同上 |

   探针实测（`node work/probe-business-rows.mjs`，8 张业务表全表计数）：
   单独跑 `claim-items-db` 后 `Settlement=1`；单独跑 `payment-capture` 后 `BillingInvoice=1`；
   跑 `billing-draft` / `claim-prepare` 后全 0（这两个文件会顺带清库）。
   ⇒ 这条链正好解释了全量回归里那条 `expected 1 to be +0`。

**修复（两层，均不改变安全判据）**
- **P2E-DB5 断言收窄作用域**：`recovery-si-phase2-e-db.test.ts` 的八条零外写断言改为按**本用例租户**过滤
  （`organizationId: orgA.organizationId`）。语义仍是「本次持久化不得产生外部业务事实」——**本租户内**出现任一外部业务事实仍然失败；
  只是不再因**别的租户/别的文件**留下的行而误判。
- **上游清理**：两个污染源文件的 `afterAll` 各补一次与 `beforeEach` **完全相同**的 TRUNCATE，使文件结束时不再把行留给同库其它测试。

**验证**
| 项 | 结果 |
| --- | --- |
| `api tsc --noEmit` | **0** |
| 定向组合（claim-items + payment-capture + billing-draft + phase2-e） | **Test Files 4 passed / Tests 64 passed** |
| 修复后探针 | `GLOBAL_BUSINESS_ROWS` **全 0**（不再残留） |
| 冻存证据 | `tools/verification/si-rsi-suite-runs/p2e-db5-isolation.json` |

**仍未验证（不得默认为已解决）**：本轮**未**重跑全量 480 文件回归 ⇒ `FULL_API_REGRESSION` 口径仍为
`COMPLETED_WITH_4_FAILURES`；P2E-DB5 与 `claim-items-db` 双债的「全量下关闭」需由下一次全量跑确认。
`reconciliation-schema-s1-db` 的 schema 漂移（残留 `rc_c3_fresh_check`）与三个后台 `rsi-run` 进程仍待 HOST 决定。

### 3.20 第二次全量 API 回归 —— 双债关闭已确认（`FULL_API_REGRESSION` 收敛到 2 项）

```
node tools/dev/run-si-rsi-suite.mjs --rounds 1 --all --label full-api-2x     # head 8fc058db，工作树 clean
```

| 指标 | 第一次（`69af211f` 之前） | 第二次（`8fc058db`） |
| --- | --- | --- |
| 测试文件 | 480：477 passed / **3 failed** | 480：478 passed / **2 failed** |
| 测试用例 | 4800：4796 passed / **4 failed** | 4800：4798 passed / **2 failed** |
| 耗时 | 1462.67 s | 1514.34 s |
| 失败清单 | P2E-DB5、reconciliation-schema-s1、claim-items-db（×2） | reconciliation-schema-s1、email-verification-db |

**双债关闭已在全量下确认（本轮的主要目的）**
- `src/__tests__/recovery-si-phase2-e-db.test.ts` → **✓ 20 tests（含 P2E-DB5）**
- `src/__tests__/claim-items-db.test.ts` → **✓ 7 tests**

**剩余 2 项失败（均已定位分类，均未在本轮擅自处置）**
1. `src/__tests__/reconciliation-schema-s1-db.test.ts` → `R45 S1 · 结构 > 七个枚举全部存在`
   —— **确定性环境漂移**：开发库残留 schema `rc_c3_fresh_check` 与 `public` 各持同一套 73 个枚举，而该用例按 `typname` 查 `pg_type` 未按 schema 过滤。
   **两次全量均失败、单跑亦失败**。处置需 HOST 决定（删除残留 schema，或让用例按 `current_schema()` 过滤）。
2. `src/__tests__/email-verification-db.test.ts` → `PC-01B F：forgot-password 不暴露存在性…`
   —— **间歇性**：第一次全量**通过**、第二次全量失败（用例耗时 10.0s，疑似时序/限流敏感）；**单文件隔离复跑 8/8 通过**。
   登记为**新增间歇性测试债**；本轮**未**修改该用例（不靠盲改掩盖 flaky）。

**证据冻存**
- `tools/verification/si-rsi-suite-runs/full-api-2x.json`（含失败分类、与第一次的对比、重放命令）
- 原始日志：`tools/dev/logs/si-rsi-suite/full-api-2x-round1.log`（运行时产物，已 gitignore）

**口径**：`FULL_API_REGRESSION = COMPLETED（480/480 文件已执行；478 通过）`；
阻塞项收敛为 **1 个环境漂移（待 HOST）+ 1 个间歇性用例债**；`PRODUCTION_READY = NO` 不变，
外写 / 申报 / 支付 / 扣佣继续 HOLD。

### 3.21 `email-verification-db` 间歇失败 —— 根因定位并已修复（锁竞争型 Hook 超时）

**症状**：第二次全量回归中 `src/__tests__/email-verification-db.test.ts` 的 `PC-01B F` 用例失败，报
**`Hook timed out in 10000ms`** —— 失败点在**钩子**（`beforeEach`），不是用例断言；该文件单文件隔离运行 **8/8 通过**，
且第一次全量回归该文件是通过的 ⇒ 间歇性。

**根因（本机可复现，非推测）**
该文件 `beforeEach` 执行 `TRUNCATE TABLE "AuditLog", "Session", "EmailVerificationToken", "PasswordResetToken", "Membership", "User", "Organization" CASCADE`，
TRUNCATE 需要 **ACCESS EXCLUSIVE** 锁；共享开发库上若有其它连接持有相关表锁（**本机 3 个后台 `rsi-run` 进程**、
或上一个测试文件尚未释放的连接），TRUNCATE 会一直等待，直到 Vitest 默认 `hookTimeout = 10s` 触发。

复现实验（只读 LOCK，不改数据）：
| 步骤 | 观测 |
| --- | --- |
| 另一连接 `LOCK TABLE "User" IN ACCESS SHARE MODE` 持有 15 秒 | 锁正常持有 |
| 在该条件下执行**修复前**的裸 TRUNCATE（与 `beforeEach` 同语句） | **阻塞 13,056 ms** ⇒ >10 s ⇒ 必然触发 `Hook timed out`，与全量回归报错一致 |

**修复**（`apps/api/src/__tests__/email-verification-db.test.ts`，**不改任何断言**）
- `beforeEach` 改为 `truncateAll()`：事务内 `SET LOCAL lock_timeout = '3s'`（把**无限等待**变成**有界等待**）
  + 退避重试最多 6 次 + 该 `beforeEach` 显式 `hookTimeout = 30s`。
- **判据零变化**：仍清同一批表、仍跑同一批断言；只是钩子不再因共享库上的锁竞争而假失败。

**验证**
| 项 | 结果 |
| --- | --- |
| `api tsc --noEmit` | **0** |
| 人为持锁 15s 条件下运行该文件 | **Test Files 1 passed / Tests 8 passed**（21.28s，可见有界等待与重试生效） |
| 无锁竞争条件下 | **Test Files 1 passed / Tests 8 passed**（9.19s） |
| 冻存证据 | `tools/verification/si-rsi-suite-runs/email-verification-hook-timeout.json` |

**仍未验证**：未重跑全量 480 文件 ⇒ 该文件与 `reconciliation-schema-s1-db` 的全量稳定性需下一次全量回归确认。
**该修复同时说明**：三个后台 `rsi-run` 进程共享开发库会**实质影响测试稳定性**（不只是"潜在"），
故「停止/迁移这 3 个进程」与「删除残留 schema `rc_c3_fresh_check`」两项仍请 HOST 决定。

### 3.22 第三次全量 API 回归 —— 失败项收敛到 **1**（仅剩环境漂移，待 HOST）

```
node tools/dev/run-si-rsi-suite.mjs --rounds 1 --all --label full-api-3x     # head c41c78b4，工作树 clean
```

| 轮次 | 文件 | 用例 | 耗时 | 失败 |
| --- | --- | --- | --- | --- |
| 第一次（`69af211f` 前） | 480：477 通过 | 4800：4796 通过 | 1462.67 s | P2E-DB5、reconciliation-schema-s1、claim-items-db×2 |
| 第二次（`8fc058db`） | 480：478 通过 | 4800：4798 通过 | 1514.34 s | reconciliation-schema-s1、email-verification-db |
| **第三次（`c41c78b4`）** | **480：479 通过** | **4800：4799 通过** | 1475.59 s | **仅 reconciliation-schema-s1** |

**本轮确认的三处修复（全量下实测）**
- `recovery-si-phase2-e-db.test.ts`（**P2E-DB5**）→ ✓ 20 tests（连续两次全量通过）
- `claim-items-db.test.ts` → ✓ 7 tests（连续两次全量通过）
- `email-verification-db.test.ts` → ✓ 8 tests（第二次全量报 `Hook timed out in 10000ms`，本轮全量通过）

**唯一剩余失败（阻塞在 HOST 决定，未擅自处置）**
- `reconciliation-schema-s1-db.test.ts` → `R45 S1 · 结构 > 七个枚举全部存在`
  **确定性环境漂移**：开发库残留 schema `rc_c3_fresh_check` 与 `public` 各含同一套 73 个枚举，
  而该用例按 `typname` 查 `pg_type` 未按 schema 过滤；三次全量与单跑均失败。
  处置二选一（**均未执行**）：① 删除 dev 库残留 schema（破坏性）；② 让该用例按 `current_schema()` / `pg_namespace` 过滤。

**证据冻存**：`tools/verification/si-rsi-suite-runs/full-api-3x.json`（含三轮对比与失败分类）；
原始日志 `tools/dev/logs/si-rsi-suite/full-api-3x-round1.log`（运行时产物，已 gitignore）。

**口径**：`FULL_API_REGRESSION = COMPLETED（480/480 文件已执行；479 通过；4799/4800 用例通过）`；
**唯一**剩余失败为**环境漂移**（非代码缺陷），等待 HOST 处置决定；`PRODUCTION_READY = NO` 不变，
外写 / 申报 / 支付 / 扣佣继续 HOLD。

### 3.23 小时级 soak 取证器 —— 本轮实现后**未提交**（发现必须先用既有裁决通道收口）

**目标**：实现审计列出的「小时级 soak」（本地可执行的那一项）。

**做了什么**：实现了一版 `tools/dev/si-rsi-soak.ts`（一次性脚本：无定时器 / 无守护进程 / 非第二运行时，
只驱动既有 `composeRsiRuntime()` + durable 任务源 + 生产 Recovery pack + 审计记录器；只操作独立 `soak-org-*` 租户），
并以 `--minutes 1 --round-seconds 2 --batch 2` 冒烟运行（29 轮）。

**冒烟暴露的关键事实（本轮真正的产出）**
1. **ONE SI Runtime 对 recovery-domain 任务强制 park-for-judge**（`awaitVerdict` 恒为 `true`，FINAL-2/3/5 的既有设计）：
   引擎每处理**一个** recovery 任务后进入「等待裁决」，此后 `tick()` 不再推进；
2. 实测表现：29 轮里只产生 **3 条** domain 审计行，而数据库里累积了 **55 条**「已被 claim、持 ACTIVE 租约、但未被处理」的任务；
3. 结论：**「durable 队列持续压力」型 soak 必须先接上裁决收口**，否则 soak 只是在堆积 parked 任务 —— 既不构成有效 soak 证据，
   还会掩盖真实行为（看起来"跑了 29 轮"，实际只执行了 3 次 domain step）。

**处置（诚实）**
- 该脚本**未提交**（已删除）：在缺少裁决收口的形态下，它无法完成它声称的 soak；
- **未留下任何残留数据**：本次冒烟创建的 `soak-org-e0306a07` 数据已按前缀清理
  （55 tasks / 55 leases / 1 incident / 63 opportunities / 1 standingAuthorization / 1 organization；**其它租户一律未动**）；
- 该脚本的 `afterAll` 式清理曾因「先删 incident、后删其 task」触发 FK 约束（`AutonomyTask_incidentId_fkey`），
  正确顺序应为 **lease → task → incident**；这条经验已记录，供下一版实现直接采用。

**下一单元设计（可执行，先只读既有实现再动手）**：soak 必须走**既有裁决通道**闭环 ——
每轮为已 park 的任务写入一个**文件型 PASS 裁决工件**，由既有 `createRsiVerdictWatcher` 收口
（历史扫描 PHASE 10 测试已有该模式先例），从而在 ONE SI Runtime 内形成「认领 → 执行 → 裁决 → 继续」的持续压力。
实现前先确认该工件的格式与判据（只读既有测试与实现），不猜格式。

**状态**：小时级 soak = **NOT VERIFIED（未完成）**；真实断电 / 断连与 Linux 实机 systemd 验收仍为 **HOST_ACTION_REQUIRED**。

### 3.24 【真实发现】Recovery 任务缺少「裁决 → durable 收口」：裁决通过后仍会被租约过期重领并**重复执行**

承接 §3.23（soak 冒烟看到「29 轮只执行 3 次、却堆积 55 条 parked 任务」）。本轮按纪律先**只读**既有裁决通道
（`rsi-verdict-watcher.ts` / `rsi-local-sources.ts` / PHASE 10 测试的 `{ messageId, verdict }` 内存裁决工件），
再把实测行为**特征化**为一个可复现测试：`apps/api/src/__tests__/si-rsi-phase3-recovery-closure-gap.test.ts`（**4/4 PASS**，真实 PostgreSQL）。

| 用例 | 实测结论 |
| --- | --- |
| G1 | 认领即执行：`tick()` 内 pack 被调用 ⇒ domain step 结论**当场**落 1 条 durable 审计；随后引擎**强制 park-for-judge**（`waitingForVerdict = true`） |
| G2 | **真实 verdictWatcher** 收口 PASS（内存裁决工件）⇒ `waitingForVerdict = false`；但 durable `AutonomyTask` **仍 `IN_PROGRESS`**、租约**仍 `ACTIVE`** ⇒ **引擎不认识 durable 终态** |
| G3 | **缺口后果（本轮新增证据）**：租约到期后同一任务被**重新领取**，只读端口被**第 2 次**调用（domain step 真的又跑了一次）；但审计行**仍是 1 条** —— 因为 `evidenceRef` 是对 (taskId, dedupeKey, org, opportunityRef, guardAction, tools) 的**确定性摘要**，记录器按 (taskId, evidenceRef) 幂等去重。⇒ **执行会重复、审计不会重复** |
| G4 | **收口路径**：补一次 fenced `settle(BLOCKED)` ⇒ 任务终态 + 租约 `RELEASED`；此后即使租约过期/再次 tick，也**不再**重复领取与执行（只读端口不再被调用） |

**为什么这是重要发现（而不是测试噪音）**
- 生产上每个 recovery 任务在裁决通过后**不会**被收口：租约到期（默认 5 分钟）即被 `reclaimExpired()` 放回 READY，
  下一轮被任意 worker 重新领取并**再次执行** domain step —— 对一个只会做只读检查的 domain step 尚可容忍（且审计幂等），
  但这是**语义错误**：已经裁决通过的任务不应再被执行；
- 这也解释了 §3.23 冒烟里「大量 parked 任务」的成因机制（引擎 park 后无人收口 ⇒ 任务永不终态）；
- 因此 **hour-level soak 的循环单元必须是**「认领 → 执行 → 裁决 → **durable 收口**」四步，
  否则 soak 只是在重复制造重复执行与 parked 堆积，不能作为稳定性证据。

**登记（不擅自扩大改动面）**：本 tick **只**交付特征化测试（固定行为 + 给出收口路径），**未**修改运行时语义。
「在 runtime 内把裁决结果自动落 durable 终态」属于**运行时行为变更**，应作为独立 CHANGE 提交独立审计后再实现
（候选口径：裁决 PASS 且 domain step 为只读 ⇒ `settle(BLOCKED)` 或新增明确的非完成终态；**不得**据此产生完成级业务结果）。

**回归**：SI-RSI 全套件 **15 文件 / 87 tests 全绿**（含新增 1 文件 / 4 tests）；`api tsc --noEmit` = **0**。

**状态**：小时级 soak 仍为 **NOT VERIFIED**（现在有了正确的循环单元定义）；运行时收口 = **待独立审计的 CHANGE 候选**；
`PRODUCTION_READY = NO`、外写/申报/支付/扣佣继续 HOLD。

### 3.25 收口缺口独立审计结论（`MSG-20261009-02`）= **CONFIRMED · 必须修复** ⇒ PHASE 3 进入 `RECOVERY_DURABLE_CLOSURE_FIX_R1`

- 会话：`https://chatgpt.com/c/6ac7d3a1-b600-83ec-98f7-a60130c841c1`（本轮**新开**）
- 审查锚点：**`00461194`**；审计方编号 **`MSG-20261009-02`**；裁决性质：**基于提交的复现证据与测试结果**的独立技术裁决（未直接检出仓库代码）
- 投递校验：composer 粘贴后 3219 字符（= 文本长度，无重复）；标记作为新用户轮出现；进入生成态；等待至 `回答已完成`
- **逐字归档**：`AI-ARCHITECT-INBOX.md` → `MSG-20261009-02`
  （`FNV1A_MATCH 350c7820`；`FULL_COPY_OK` 156/156，缺失 0 / 多出 0；抽取 sha256 `f4c6fe23…`）

**裁决要点（审计方原文口径）**
| 项 | 裁决 |
| --- | --- |
| `CLOSURE_GAP` / `EXECUTION_DUPLICATION` | **CONFIRMED**（G1–G4 的真实 PG 测试足以确认缺口） |
| `AUDIT_IDEMPOTENCY` = PASS / **`EXECUTION_AT_MOST_ONCE` = FAIL** | 确定性 evidenceRef 只保证**审计幂等**，**不保证业务执行幂等** |
| `FIX_APPROACH` | **OTHER**：`FIX_SPEC = RUNTIME_VERDICT_AWARE_FENCED_SETTLEMENT` |
| 「一律 BLOCKED」与「host-only settle」 | **均被 REJECTED**（前者混淆四种语义；后者留下运行时与 durable 生命周期责任断层） |
| `PHASE2_CLOSED_AFFECTED` | **NO**（PHASE2 = YES、P0_B = YES 继续有效；本轮属 PHASE 3 新缺口） |
| `PHASE3_RECOVERY_CLOSURE` / `PHASE3_CLOSED` | **FAIL / NO**（不得宣布 PHASE 3 完成） |

**必须实现的状态映射（审计方指定）**
| 裁决结果 | Durable 行为 | 业务完成 |
| --- | --- | --- |
| PASS + 可信业务完成证据充分 | 满足 CHANGE 3A 白名单及全部 guard 后才可 `COMPLETED` | 允许 |
| PASS，仅 domain step 成功、**无完成证据** | `BLOCKED` 或新增明确的**非完成**状态 | **禁止** |
| REJECT / DENY | `BLOCKED` + 原因 | 禁止 |
| 裁决缺失 / 超时 / 来源不可信 | 保持安全等待或按明确故障策略阻断，**不得视为 PASS** | 禁止 |
| 租约过期、owner 已失效 | 拒绝旧 owner settle，交由既有恢复路径处理 | 禁止 |
第二种情形优先复用 `BLOCKED` 并给出明确 reason code（审计方示例：`VERDICT_PASS_AWAITING_BUSINESS_PROOF`）；
只有既有 `BLOCKED` 无法表达时才考虑新增枚举与迁移，**不得**据此建立第二套任务状态机。
**特别强调：judge PASS ≠ Recovery 业务完成。**

**CHANGE 约束**：我方预设四项 **全部 ACCEPTED**（① 可信完成证据白名单；② 不绕过 fail-closed / Action Guard / 租户与授权；③ ONE Runtime + fenced settle；④ 可追溯审计），并**追加两个 P0**：
- **P0-5 裁决与 settle 的崩溃恢复**：verdict 已持久化但运行时在 settle 前崩溃 ⇒ 重启后必须能恢复**待收口决策**；**不得**用「再执行一次 domain step」来弥补收口缺失；恢复时仍须重新核验租约所有权与授权边界；
- **P0-6 执行副作用防重**：**不得**把审计幂等当 domain step 幂等；必须区分纯只读步骤与可能写库/外呼的步骤，非只读步骤需持久化执行标识与状态及恢复/对账机制；不得仅靠内存标志阻止重复执行。

**下一轮最低验收标准（审计方 R1–R10，须在真实 PostgreSQL + ONE SI Runtime 生产同构路径下证明）**
`R1` domain step 执行一次、PASS 后由**运行时自动** fenced settle；`R2` 无完成证据不得落 `COMPLETED`；
`R3` settle 后租约 `RELEASED`、重复 tick 不再执行；`R4` 旧 owner / 过期 lease / 并发 settle 不得覆盖新 owner；
`R5` verdict 持久化后、settle 前崩溃 ⇒ 重启后**安全恢复收口**；`R6` REJECT / DENY / UNKNOWN / 超时全部 fail-closed；
`R7` 租户、授权与 Action Guard 复核有效；`R8` 收口审计可追踪且与 durable 状态一致；`R9` 多 worker 并发无重复业务副作用；
`R10` 回归原 G1–G4 并新增**正向自动收口**测试。
审计方特别注明：**R5 不得用人为直接调用 `settle()` 冒充运行时自动恢复**；**R1 也不得仅凭 verdictWatcher 内存标志变为 false 就判 PASS**。

**其余阻断项裁决**：全量 4799/4800 是较强回归证据但**尚不能定完全通过**（建议清理/隔离残留 schema、在干净测试库重跑该用例、
并修正 `pg_type` 查询未限定 namespace 的问题）；3 个后台 `rsi-run` 进程**不应继续干扰隔离测试**（先确认归属、停止测试不需要的实例，
再在专用库中验证真正的多 worker 并发 —— 既不把进程争用当产品缺陷，也不忽略潜在并发风险）；小时级 soak / 断连恢复 / Linux systemd / 真实 Provider 均保留为后续发布门禁。
**本轮禁止**开启真实 Provider 写入、关税正式申报、自动收费、自动扣佣与生产凭据。

**机器可读终局块（审计方原文）**
```
AUDIT_ID = MSG-20261009-02
SCOPE = SI_RSI_PHASE3_RECOVERY_DURABLE_CLOSURE
REVIEWED_HEAD = 00461194
CLOSURE_GAP_VERDICT = CONFIRMED
EXECUTION_DUPLICATION = CONFIRMED
AUDIT_IDEMPOTENCY = PASS
EXECUTION_AT_MOST_ONCE = FAIL
FIX_APPROACH = OTHER
FIX_SPEC = RUNTIME_VERDICT_AWARE_FENCED_SETTLEMENT
RUNTIME_AUTO_SETTLE_REQUIRED = YES
HOST_SETTLE_ONLY = REJECTED
UNCONDITIONAL_BLOCKED_SETTLE = REJECTED
VERDICT_PASS_IMPLIES_BUSINESS_COMPLETION = NO
TRUSTED_COMPLETION_EVIDENCE_REQUIRED = YES
NON_COMPLETION_SETTLEMENT_REQUIRED = YES
FENCED_SETTLE_REQUIRED = YES
CRASH_RECOVERY_REQUIRED = YES
DURABLE_EXECUTION_DEDUPLICATION_REQUIRED = YES
SETTLEMENT_AUDIT_REQUIRED = YES
ONE_SI_RUNTIME = REQUIRED / SECOND_RUNTIME = FORBIDDEN / SECOND_SCHEDULER = FORBIDDEN / SECOND_CONTROLLER = FORBIDDEN
FAIL_CLOSED = REQUIRED / ACTION_GUARD = REQUIRED / TENANT_AUTH_RECHECK = REQUIRED
PHASE2_CLOSED_AFFECTED = NO / PHASE2_CLOSED = YES / P0_B_CLOSED = YES
PHASE3_RECOVERY_CLOSURE = FAIL / PHASE3_CLOSED = NO
API_REGRESSION = 4799/4800_PASS / API_REGRESSION_FULL_PASS = NO
SOAK_VERIFIED = NO / LINUX_SYSTEMD_VERIFIED = NO
REAL_EXTERNAL_EXECUTION = NOT_EXECUTED / PRODUCTION_READY = NO
REAL_PROVIDER_WRITE = HOLD / CUSTOMS_FILING = HOLD / PAYMENT = HOLD / AUTO_COMMISSION_CHARGE = HOLD / PRODUCTION_ENABLEMENT = HOLD
NEXT = IMPLEMENT_PHASE3_RECOVERY_DURABLE_CLOSURE_FIX_R1
NEXT_AUDIT = PHASE3_RECOVERY_DURABLE_CLOSURE_R1
```

**下一单元（已获准的本机安全修复范围）**：实现 `PHASE3_RECOVERY_DURABLE_CLOSURE_FIX_R1`
（`RUNTIME_VERDICT_AWARE_FENCED_SETTLEMENT`：verdict → fenced settle → durable 终态 → crash recovery），
按 R1–R10 逐条验收后再送 `NEXT_AUDIT`；**不**批准 PHASE 3 收官或生产使能。

### 3.26 `PHASE3_RECOVERY_DURABLE_CLOSURE_FIX_R1` —— 第一增量已实现并取证（R1/R3/R4/R5/R6/R7/R8 + 决策表）

**新增模块** `apps/api/src/runtime/recovery-verdict-settlement.ts`
- `decideRecoverySettlement()`（**纯函数**，逐条实现审计方指定的状态映射）：
  PASS + 可信完成证据 ⇒ `SETTLE_COMPLETED`；PASS 无完成证据 ⇒ `SETTLE_BLOCKED` + `VERDICT_PASS_AWAITING_BUSINESS_PROOF`；
  REJECT/DENY ⇒ `SETTLE_BLOCKED` + `VERDICT_REJECTED`；REVISE ⇒ `SETTLE_BLOCKED` + `VERDICT_REVISED_NOT_APPROVED`；
  裁决缺失/超时/不可信 ⇒ **`SAFE_WAIT`**（不落终态、不视为 PASS）。
- `createRecoveryVerdictSettlement()`：**先写 durable INTENT 再 settle，最后写 APPLIED**（INTENT/APPLIED 复用既有 `AuditLog`，
  租户归属、追加式；**不新增表、不新增状态机、不新增 runtime**）。APPLIED 记录含
  `verdictRef / decisionAction / reasonCode / beforeStatus / afterStatus / ownerRef / settleApplied / trustedCompletionEvidenceRef / recordedAt`。
- **R7 跨租户 fail-closed**：收口前先解析**权威租户**（task → incident.sourceRefs[0].organizationId），与请求租户不一致 ⇒
  直接拒绝且**不写任何行**（`SETTLEMENT_TENANT_MISMATCH`）。
- **P0-5 崩溃恢复**：`listPendingSettlements()` / `resumePendingSettlements()` —— 找出「有 INTENT 无 APPLIED」的待收口决策并补齐；
  恢复时**不重跑 domain step**，并由**当前 owner** 收口（旧 owner 会被既有 fenced settle 拒绝，属 fail-closed）。

**运行时接线（含生产入口）**
- `composeRsiRuntime({ recoveryVerdictSettlement })`：认领 recovery 任务时记录「待收口任务」；裁决收口后（`verdictWatcher` 真实路径）
  调用 `settleAfterVerdict(...)`；**缺省不接线 ⇒ 行为与既有版本完全一致**（不擅自改语义）。
- 生产启动入口同样接线：`rsi-run` 打印 `RSI_VERDICT_SETTLEMENT=RUNTIME_VERDICT_AWARE_FENCED_SETTLEMENT`（未拿到 Prisma 时为 `NOT_CONFIGURED`）。
- **没有**新增 runtime / scheduler / controller / 第二状态机。

**验收（`apps/api/src/__tests__/si-rsi-phase3-closure-fix-r1.test.ts`，6/6 PASS，真实 PostgreSQL）**
| 项 | 结果 |
| --- | --- |
| 决策表（纯函数） | PASS 无证据 ⇒ BLOCKED；PASS + 可信证据 ⇒ COMPLETED；BLOCK ⇒ REJECTED；REVISE ⇒ REVISED；`null/undefined` ⇒ SAFE_WAIT |
| **R1** | PASS 裁决经真实 verdictWatcher 收口后，**运行时自动** fenced settle（**无任何人为 settle 调用**） |
| **R2（负向）** | 无完成证据 ⇒ 落 `BLOCKED`（**绝不** `COMPLETED` / `PROMOTED`） |
| **R3** | settle 后租约 `RELEASED`；再次 tick 不重新领取、只读端口调用数仍为 1（domain step 不再重复执行） |
| **R4** | 旧 owner / 过期租约收口被既有 fencing 拒绝（`FENCED_*`），新 owner 可正常收口 |
| **R5（P0-5）** | 构造「有 INTENT 无 APPLIED」⇒ 重启（新 owner + reclaim/claim 接管）后 `resumePendingSettlements()` 补齐收口；**只读端口调用数不变**（未重跑 domain step） |
| **R6** | BLOCK 与 REVISE 各自 reason code 收口为 `BLOCKED`，均不产生完成级状态 |
| **R7** | 请求租户 ≠ 权威租户 ⇒ 拒绝（`SETTLEMENT_TENANT_MISMATCH`），**双方租户名下都没有 settlement 记录**，任务状态不变；权威租户可正常收口 |
| **R8** | INTENT → APPLIED 两条记录齐备，含 `verdictRef / reasonCode / beforeStatus / afterStatus / ownerRef` |
| **R10（部分）** | 缺口特征化测试 G1–G4 **4/4 仍绿**（未接线路径行为不变 = 向后兼容） |

**回归**：SI-RSI 全套件 **16 文件 / 93 tests 全绿**（新增 1 文件 / 6 tests）；`api tsc --noEmit` = **0**；
启动入口相关契约（`rsi-run` / `rsi-runtime-e2e` / `startup-parity`）**20 tests 全绿**。

**本增量**尚未**覆盖（下一增量继续，不得据此判定 R1 全部完成）**：
- **R2 正向路径**：把可信完成证据（CHANGE 3A 白名单，生产默认关闭）经运行时送到 `COMPLETED` —— 需在测试中显式启用可信来源；
- **R9**：多 worker 并发下无重复业务副作用（需要专用库 + 多 runtime 实例的真实并发）；
- **R10（全量）**：全量套件回归 sweep；
- 小时级 soak（现在已具备正确循环单元）、断连恢复、Linux systemd、真实 Provider 仍为 **NOT VERIFIED / HOLD**。

### 3.27 `FIX_R1` 第二增量 —— R2 正向路径 + 「声称证据被拒」的 fail-closed 回落

**实现（`recovery-verdict-settlement.ts`）**
- 新增 host 注入点 `trustedEvidenceProvider`：只有**已校验**的终局证据才会被送去尝试 `COMPLETED`；
  端口"声称有证据"**不算数** —— 是否放行仍由既有 `settle()` 在**事务内**按 CHANGE 3A 白名单重新判定。
- 新增回落语义：若 `settle(COMPLETED)` 被事务内门禁拒绝（例如白名单来源未启用），**必须回落为非完成收口**
  （`SETTLE_BLOCKED`，reason `VERDICT_TRUSTED_EVIDENCE_REFUSED_FALLBACK_BLOCKED`），
  **绝不留 `IN_PROGRESS` 悬挂**、绝不伪造完成。
- APPLIED 审计同时记录 `decidedAction`（决策动作）与 `decisionAction`（最终生效动作）、
  `reasonCode`、`trustedCompletionEvidenceRef` / `Source` / `Kind`，可完整回溯"为什么变成非完成"。

**验收（`si-rsi-phase3-closure-fix-r1.test.ts` 扩到 8/8 PASS，真实 PostgreSQL）**
| 用例 | 结果 |
| --- | --- |
| **R2 正向** | PASS + host 已校验证据 + **显式启用**可信来源 ⇒ 任务收口到完成级状态 **`PROMOTED`**、租约 `RELEASED`；APPLIED 记录 `decidedAction=SETTLE_COMPLETED`、`afterStatus=PROMOTED`、证据引用可回溯 |
| **R2 fail-closed** | 端口声称有终局证据、但**生产注册表全部 disabled** ⇒ `settle(COMPLETED)` 被拒后**自动回落** `BLOCKED`（`decisionAction=SETTLE_BLOCKED`、`reasonCode=…REFUSED_FALLBACK_BLOCKED`、`settleApplied=true`）；任务**不悬挂、不 PROMOTED** |

**回归**：SI-RSI 全套件 **16 文件 / 95 tests 全绿**；`api tsc --noEmit` = **0**。

**仍未覆盖（下一增量）**：**R9** 多 worker 并发（需专用库 + 多 runtime 实例）、**R10** 全量回归 sweep；
之后方可送 `PHASE3_RECOVERY_DURABLE_CLOSURE_R1` 复审。小时级 soak / 断连恢复 / Linux systemd / 真实 Provider 仍为 NOT VERIFIED / HOLD。

### 3.28 R9 多 worker 并发 —— **未达成**；实测暴露引擎「裁决后预租下一条但不执行」的既有时序

**我尝试的做法**：写一个 R9 测试，用 **3 个独立 runtime 实例**（各自 ownerRef + 各自裁决流，共享同一 durable 队列）
并发推进 6 个任务，循环「所有 worker 同时 tick + 同时投递裁决」，然后断言：每任务只执行一次、只收口一次、无残留 ACTIVE 租约、零外写。

**实测结果**：**失败**，并且失败原因不是我的收口修复，而是引擎既有行为：
- 每轮只有**一个 worker 的第一次**（tick+verdict）生效；此后各 worker 的 `tick()` 持续返回 `claimed=none`；
- 6 个任务里只有 1–2 个被真正执行并收口，其余停在 `IN_PROGRESS`；
- `INTENT/APPLIED` 各只有 1 条。

**根因（读引擎源码 + 诊断脚本对照）**：`rsi-continuation-engine.handleEvent('JUDGE_VERDICT_RECEIVED')` 在消费裁决后
**立即** `claimNextSafeTask()` —— 也就是**预租下下一条任务**并把 `leased` 指向它；而本组合中，
该预租任务**不会在同一次 emit 里被执行**，于是引擎进入 `ACTIVE_LEASE`（内部租约默认 5 分钟），
后续 `tick()` 一直返回 `SILENT/ACTIVE_LEASE`，直到内部租约到期。⇒ **短窗口内一个 worker 无法连续排空多条任务**。

**处置（诚实，不掩盖）**
- R9 草稿测试**未提交并已删除**（它在当前引擎时序下无法成立，不能作为 R9 证据）；
- 运行时的收口接线**保留**（R1/R2 已用真实 PG 验证：`si-rsi-phase3-closure-fix-r1.test.ts` 8/8），
  但**不宣称** R9 达成；
- 回归确认：SI-RSI 全套件 **16 文件 / 95 tests 全绿**；`api tsc --noEmit` = 0。

**R9 仍为 NOT VERIFIED**，并新增一个**待审计确认的问题**（我会在下一轮的复审包中一并提出）：
1. `handleEvent('JUDGE_VERDICT_RECEIVED')` 里 `claimNextSafeTask()` 的**预租**是否为有意设计？若是，应由谁在何时执行该预租任务？
2. 若预租任务要等内部租约（5 分钟）到期才执行，那么「多 worker 持续吞吐」的量级就是**每 worker 每 5 分钟一条** ——
   这与 soak / 生产吞吐预期是否一致？（这直接决定 hour-level soak 的正确参数与预期。）
3. 该预租是否存在**未执行却占用 durable 租约**的窗口（即"预租但未执行"的任务在 DB 里表现为 `IN_PROGRESS` + ACTIVE 租约）——
   若是，是否需要在 R1 的实现里补一条「预租任务的执行/收口」路径？

**下一步**：先就上述三点送独立审计确认口径，再据此实现 R9 与 soak；
`PHASE3_RECOVERY_DURABLE_CLOSURE_R1` 复审**暂不提交**（R9 未达成、R10 未做）。
