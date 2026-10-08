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

## 3. PHASE 2 / C5 —— Recovery pack 生产装配（设计已定稿，实现待执行）

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
