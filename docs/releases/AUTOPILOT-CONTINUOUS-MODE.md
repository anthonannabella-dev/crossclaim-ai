# AUTOPILOT 执行模型改造：CONTINUOUS AUTONOMOUS LOOP

- 时间：2026-10-03T14:17:18.723Z（依据宿主 2026-10-03 指令 AUTOPILOT EXECUTION MODEL CORRECTION）

## 1. 模式定义（已生效）

| 项 | 值 |
|---|---|
| `AUTOPILOT_MODE` | **CONTINUOUS** |
| `HEARTBEAT_ROLE` | **LIVENESS_ONLY**（liveness / watchdog / crash detection / stale detection / recovery；**不做任务调度**） |
| `WATCHDOG_ROLE` | **RECOVERY_ONLY**（检查 runner 存活与心跳；只在死亡且仍有任务时恢复；永不并发启动第二个 runner） |
| `SINGLETON_RUNNER` | **VERIFIED**（`.autopilot/RUNNER.lock`：pid + 心跳新鲜度；已有 active runner 则拒绝启动第二实例；stale 则清理恢复） |

## 2. 实现文件

- `tools/autopilot/continuous-runner.mjs`：持续循环 —— reconcile → pickNextExecutionUnit → execute → test →（如需）commit → updateState → **立即取下一个**，直到命中允许停止条件。
- `tools/autopilot/lib/lock.mjs`：singleton lock（`acquireLock` / `releaseLock` / `isPidAlive` / `readHeartbeatAgeMs`，STALE_MS = 10 分钟）。
- `tools/autopilot/watchdog.mjs`：RECOVERY_ONLY 看门狗。
- `tools/autopilot/units/{index.json,u1-customs-suite.mjs,u2-full-gates.mjs,u3-ci-triage.mjs}`：可执行单元注册表 + 首批 3 个安全单元。
- `tools/autopilot/runner.mjs`：保留原语义（liveness / heartbeat 写入），职责降级为健康证明。

## 3. 验证证据（本轮实测）

### 3.1 连续执行 A→B→C（无需 heartbeat 唤醒）

```text
RUNNER_STARTED pid=45196 mode=CONTINUOUS
PICK_UNIT=u1-customs-suite
UNIT_RESULT={"id":"u1-customs-suite","ok":true,"detail":" Test Files  9 passed (9) |       Tests  79 passed (79)"}
CONTINUE_IMMEDIATELY next_unit_pending=true
PICK_UNIT=u2-full-gates
UNIT_RESULT={"id":"u2-full-gates","ok":true,"detail":"tsc api=OK tsc web=OK api-contract=OK audit-coverage=OK autopilot-rules=OK"}
CONTINUE_IMMEDIATELY next_unit_pending=true
PICK_UNIT=u3-ci-triage
UNIT_RESULT={"id":"u3-ci-triage","ok":true,"detail":"pending=0 red=0"}
CONTINUE_IMMEDIATELY next_unit_pending=true
STOP_CONDITION=SAFE_CONTINUATION_QUEUE_EMPTY
RUNNER_EXIT executed=3 lockReleased=true heartbeatAgeMs=2
```

### 3.2 Singleton（阻止第二实例）

```text
SLEEPER_PID=45612（模拟 active runner 持有的 pid）
RUNNER_NOT_STARTED reason=ACTIVE_RUNNER_PRESENT existingPid=45612
SINGLETON_RUNNER=VERIFIED
```

### 3.3 Watchdog（健康时不重启）

```text
WATCHDOG=RUNNER_HEALTHY pid=45612 heartbeatAgeMs=11823 (no second runner started)
```
（无剩余任务时输出 `WATCHDOG=NO_REMAINING_TASKS (no restart)`；死亡或 stale 且仍有任务时清理 stale lock 并以 detached 方式恢复 runner。）

## 4. 允许的停止条件（唯一）

1. `HOST_ACTION_REQUIRED`；
2. `BLOCK` 裁决且无替代安全任务；
3. `SAFE_CONTINUATION_QUEUE = EMPTY`（本轮即此条件）；
4. 全部既定 CrossClaim 产品目标 CLOSED。

除此之外保持 `CONTINUOUS_AUTOPILOT = RUNNING`。

## 5. 非阻塞语义

- **CI 非阻塞**：commit 后记录 `ci_pending`（run id/状态），不等待；存在不冲突安全单元则立即执行；后续循环复查；**红灯才进入 SELF_RESOLVE**。
- **审计非阻塞**：`READY_FOR_REVIEW` 时记录 `awaiting_verdict`；不依赖该 verdict 的安全单元继续执行；新 verdict 到达时优先 reconcile。
- 单元 u3（`ci-triage`）即该语义的可执行实现：巡检最近提交的 CI 状态并写入 `ci_pending` / `ci_red`。

## 6. GLOBAL BACKLOG DISPATCHER（FINAL GAP 2026-10-03）

| 项 | 值 |
|---|---|
| `GLOBAL_BACKLOG_DISPATCHER` | **VERIFIED** |
| `STATIC_UNIT_DEPENDENCY` | **REMOVED**（静态 registry 清空不再导致停止） |
| `SAFE_CONTINUATION_QUEUE` | **ACTIVE**（backlog.json 的未完成安全项被真实消费） |
| `FULL_AUTONOMOUS_INTERNAL_EXECUTION` | **VERIFIED** |

实现：`tools/autopilot/dispatcher.mjs` + `tools/autopilot/backlog.json` + `tools/autopilot/unit-templates/{suite-evidence,doc-sync,host-required-register}.mjs`。
选择顺序：P0/P1 未关闭 → 当前 Gate 未关闭 → 已批准 GLOBAL GAP → 平台/Carrier/Customs/Independent-site/Settlement-Billing 内部链 → 回归/文档/发布证据；
HOST_ACTION_REQUIRED / ARCH_REVIEW 项**登记并跳过**，继续寻找其它安全任务。materialize 的单元记录 source_backlog_id / title / scope / acceptance_criteria / dependencies / risk_class / ARCH_REVIEW_REQUIRED / HOST_ACTION_REQUIRED / HOLD_EXTERNAL / allowed_files / boundary / required_tests。

### 6.1 真实验收（预置：static units 全部 completed；一次启动）

```text
PRESET_STATIC_COMPLETED=8
RUNNER_STARTED pid=45020 mode=CONTINUOUS
DISPATCHER_PICK=BG-001-platform-adapter-readonly-closure
UNIT_RESULT={"id":"BG-001-platform-adapter-readonly-closure","ok":true,"detail":" Test Files  8 passed (8) |       Tests  72 passed (72)"}
CONTINUE_IMMEDIATELY next_unit_pending=true
DISPATCHER_PICK=BG-002-settlement-billing-linkage-evidence
UNIT_RESULT={"id":"BG-002-settlement-billing-linkage-evidence","ok":true,"detail":" Test Files  15 passed (15) |       Tests  132 passed (132)"}
CONTINUE_IMMEDIATELY next_unit_pending=true
DISPATCHER_PICK=BG-005-customs-g4-evidence-chain-verification
UNIT_RESULT={"id":"BG-005-customs-g4-evidence-chain-verification","ok":true,"detail":" Test Files  4 passed (4) |       Tests  19 passed (19)"}
CONTINUE_IMMEDIATELY next_unit_pending=true
DISPATCHER_PICK=BG-003-dashboard-ops-readonly-evidence（继续执行中；本次仅为验收设 --max-units 3）
```

结论：static queue 空 → dispatcher 自动发现 A → materialize A → execute A → 自动发现 B → execute B → 自动发现 C → execute C，全过程无 heartbeat / scheduler / 人工唤醒。
