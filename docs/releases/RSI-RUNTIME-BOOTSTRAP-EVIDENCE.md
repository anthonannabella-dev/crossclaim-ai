# RSI 运行时自举证据（RSI_RUNTIME_READY）

## 1. 结论

RSI 运行入口 `rsi:run` 在本地**真实执行**过一次完整闭环：事件/看门狗驱动领取任务 →
**真实命令执行器**跑目标测试 → 按退出码判定 → `PASS` 并携带**摘要证据**。
全程**未伪造**任何成功：第一次尝试真的失败了（见 §3），运行器如实判 BLOCK。

## 2. 通过的运行（HEAD 10fef7e 之前的工作树）

环境（命令与参数只来自配置，未使用任何凭据）：

```
RSI_TASKS_PATH=<沙箱>work/stage/rsi-boot-tasks.json
RSI_RUNNER_COMMAND=node
RSI_RUNNER_ARGS=node_modules/vitest/vitest.mjs run src/__tests__/rsi-task-runner.test.ts
RSI_RUNNER_CWD=D:\crossclaim-ai\apps\api
RSI_WATCHDOG_INTERVAL_MS=2000
```

任务 artifact：

```json
[ { "id": "boot-1", "priority": "P0", "dedupeKey": "boot:rsi-runtime-selfcheck" } ]
```

实际输出（逐字，stdout）：

```
RSI_RUN_STARTED eventDriven=true watchdogIntervalMs=2000
RSI_RUNNER_RESULT claimed=boot-1 status=PASS exit=0 stdout=3fdec35b658c stderr=6a013b71d94e
```

解读：

- `claimed=boot-1`：看门狗兜底路径（2s）领取了 P0 任务，说明「无事件也能推进」；
- `exit=0` → `status=PASS`：判定依据是**真实退出码**，不是「已领取」；
- `stdout/stderr` 只落 **sha256 前 12 位摘要**（`3fdec35b658c` / `6a013b71d94e`），未落原文。

## 3. 同一次自举中的诚实失败（值得记录）

第一次尝试用 `RSI_RUNNER_COMMAND=npx`，输出为：

```
RSI_RUNNER_RESULT claimed=boot-1 status=BLOCK exit=null stdout=e3b0c44298fc stderr=e3b0c44298fc
```

- `exit=null` + 空摘要（`e3b0c442…` = 空串的 sha256）说明 **spawn 失败**；
- 原因：Windows 上 `npx`/`npm` 是 `.cmd` shim，而执行器刻意使用 `shell:false`，无法直接 spawn；
- 正确行为：执行器**判 BLOCK**，而不是判 PASS —— 这正是「伪成功已消除」的现场证明；
- 处理：Linux/生产目标不受影响（`npx` 是真实可执行文件）；Windows 本地自举改用 `node` + vitest 的 JS 入口。

## 4. 边界（未触碰）

- 仅本地进程内执行；**不读凭据、不写数据库、不做任何外部写**（`RSI_TASK_RUNNER_BOUNDARY` 已声明并在测试中断言）；
- `EXTERNAL_WRITE / PAYMENT / TRANSPORT / PRODUCTION_CREDENTIALS` 仍为 HOLD；`TRANSPORT=false`；
- 命令白名单：`node / npx / npm / git / bash / sh / psql`（basename 归一化，含 Windows `.exe`）。

## 5. 状态

```
RSI_RUNTIME_READY = PASS（本地自举：事件/看门狗 → 真实执行 → 退出码判定 → 摘要证据）
MODEL_PROVIDER_READY  = NOT_STARTED（先送审计）
PERSISTENCE_READY     = MIGRATION_VERIFIED_ON_EPHEMERAL（durable apply = HOST_ACTION_REQUIRED）
REBOOT_RECONCILE_READY= NOT_IMPLEMENTED
SYSTEMD_VALIDATED     = NOT_VALIDATED（HOST_ACTION_REQUIRED）
```
