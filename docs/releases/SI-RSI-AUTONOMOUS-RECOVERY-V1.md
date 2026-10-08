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
| 1 | 客户任务自动执行闭环（动态消费 + durable 队列 + 租约/幂等/恢复） | NOT STARTED |
| 2 | API 故障自动诊断与恢复（11 类错误 + 有界重试/退避/升级） | NOT STARTED |
| 3 | 业务错误自动重新规划（真实替代计划 + 独立验证 + 上限与留痕） | NOT STARTED |
| 4 | 持续学习与策略优化（复用 Experience/Meta/Outcome/Canary） | NOT STARTED |
| 5 | 程序 Bug 自动发现与研发修复流程（研发自治，不碰生产） | NOT STARTED |
| 6 | 真实端到端故障注入（A–P，真实 PG + ONE SI Runtime） | NOT STARTED |

**边界（全程）**：不新增第二套 runtime/scheduler/controller/guard/policy engine；
`REAL_PROVIDER_WRITE / CUSTOMS_FILING / PAYMENT / AUTO_COMMISSION_CHARGE / PRODUCTION_CREDENTIALS /
PRODUCTION_ENABLEMENT / EXTERNAL_WRITE / TRANSPORT = HOLD`；不执行生产部署 / 生产迁移。
