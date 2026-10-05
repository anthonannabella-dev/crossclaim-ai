# RSI-P1-03 —— signal → incident → task 自动生成

- 分支：`gate/7-commercial-validation`
- 本轮范围：把「观察到的信号」自动变成 incident + task，补上 `rsi:run` 之前只能靠静态队列文件的缺口。
  零网络、零外写、不读凭据。

## 1. 为什么需要它

运行时（`rsi:run`）此前只消费一个静态任务 artifact：`事件 → 领任务 → runner` 是通的，但「**事件 → 任务**」
仍是人工写入。RSI-P1-03 把这一步补齐：Observer 观测到的信号（CI 失败 / 测试失败 / 类型检查失败 / backlog 停滞）
可以自动生成 incident 与 task，且同因只建一次。

## 2. 生成规则（`generateRsiWork`，纯函数）

| 规则 | 行为 |
| --- | --- |
| 去重 | `dedupeKey` 已在历史（`incident:` / `task:` / 队列键）或本批已出现 → 只记 `duplicates` / `skipped`，**不生成** |
| 稳定 id | `incidentId = inc-<sha256(dedupeKey)[0:16]>`、`taskId = task-<…>`，跨重启不变（配合唯一约束实现 exactly-once） |
| 优先级 | `riskClass HIGH → P0`、`MEDIUM → P1`、`LOW → P2` |
| OWNER 保护 | `riskClass = HIGH` 的信号**不进自动队列**，只生成 `ownerGatedTasks`（`ownerGateRequired = true`）等待宿主 |
| 敏感数据 | 信号摘要仍含邮箱 / 电话 / 长数字 / 密钥样式 → `skipped: SENSITIVE_SIGNAL`，绝不落进任务 |
| 限流 | 单轮上限默认 3、硬上限 10，超出只记 `truncated`，不允许一次刷出大量任务 |
| 解析 | `parseRsiSignals` 畸形行丢弃；解析失败 = 不生成，绝不编造任务 |

## 3. 接线

`apps/api/src/runtime/rsi-run.ts` 组合根新增：

- 入参 `signalsPath?: string`（信号 artifact）
- 启动时 `parseRsiSignals` → `generateRsiWork` → 把**自动任务**按 `dedupeKey` 合并进队列（已存在则不重复入队）
- 暴露 `taskGeneration()` 供审计；直接运行入口打印
  `RSI_TASK_GENERATION=tasks=… ownerGated=… duplicates=… truncated=…`（未配置时 `NOT_CONFIGURED`）
- 边界常量：`signalDrivenTaskGeneration = true`、`ownerGatedTasksAutoExecuted = false`

## 4. 与既有链路的关系

```
Observer（只读、脱敏）
  → signal（含 dedupeKey）
    → generateRsiWork（本模块：去重 / OWNER 门禁 / 限流）
      → rsi:run 队列 → 续跑引擎 claim → runner → 证据校验 → verdict → REVISE/PASS → 下一任务
```

## 5. 验收

- `apps/api/src/__tests__/rsi-task-generator.test.ts` 10 例：生成、跨重启 id 稳定、已知键去重、批内去重、
  HIGH 风险只登记、敏感信号 fail-closed、单轮限流 + 硬上限、artifact 解析、**生成的任务能被续跑引擎立刻领取**、边界常量。
- `rsi-run.test.ts` 增 1 例：`signalsPath` 配置后自动入队；同信号二次启动只记 duplicate；未配置返回 `null`。
- `tsc --noEmit` exit 0；门禁 `api-contract` / `audit-coverage` / `autopilot-rules` 全 OK。

## 6. 诚实边界

- 跨**进程重启**的「同因不重复建」需要把 incident/task 落库后由唯一约束兜底；本模块保证的是
  **稳定 id + 队列内去重**，真正的持久化去重依赖 RSI-RT-06 状态表（staging apply 已获批，本地库尚未建表）。
- `ownerGatedTasks` 只是登记；RSI **不会**自行执行任何 OWNER-gated 动作（External Write / Payment / Transport /
  Production Credentials 仍全部 HOLD）。
