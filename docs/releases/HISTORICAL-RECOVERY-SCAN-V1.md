# HISTORICAL_RECOVERY_SCAN_V1 —— 单元记录（PHASE 0 + PHASE 1 已交付）

> 诚实状态：本单元**未完成**。PHASE 0（只读审计）与 PHASE 1（确定性 5 年时间范围）已实现并验证；
> PHASE 2–14 未实现。因此 **`HISTORICAL_RECOVERY_SCAN_V1` ≠ PASS / CLOSED**（详见 §4 状态表）。

## 1. 基线

| 项 | 值 |
| --- | --- |
| BASE_BRANCH | `feat/goal-input-ux-guidance`（最新已 push 基线，父为已 CLOSED 的 `release/integration-20261008`） |
| BASE_HEAD | `7a078da6320c9cb6b868ede34d7c191db25723e0` |
| WORKTREE_STATUS | clean（开工时） |
| BRANCH | `feat/historical-recovery-scan-v1` |
| 已封板分支 | 未修改（`release/integration-20261008` = `190d57a6` 不变） |

## 2. PHASE 0 — 只读审计（已交付）

产出：`docs/releases/HISTORICAL_SCAN_AUDIT.md`（每一项均带代码级证据与文件/行号）。

关键结论：

* **GOAL_5Y_PARSE = MISSING**：「过去 5 年」被静默回落为默认 12 个月（实测）。
* **TIME_RANGE_RUNTIME_PROPAGATION = PARTIAL**：`GoalPlan.timeRange` 存在，但 task 草案（`{domain, dedupeKey}`）、
  队列准入、`recovery-si-pack` 组装均**不携带**时间范围 → Runtime 无法知道「过去 5 年」。
* **HISTORICAL_CONNECTOR_SUPPORT = PARTIAL**：有 durable cursor 与一页一推进；**无**历史区间入参、无 coverage 元数据。
* **CUSTOMS_5Y_RULE_SUPPORT = PARTIAL**：已是 per-remedy（无全球 3–5 年规则）、drawback = exportDate + 1825 天、
  `UNVERIFIED / LEGAL_VERIFIED` 词表已存在；但**未拆双 gate**（CLAIM_FILING_DEADLINE /
  EXPORT_OR_DESTRUCTION_QUALIFYING_WINDOW），且 `evaluateRemedyDeadline()` **不消费 verification**。
* **DURABLE_SCAN_STATE / CHECKPOINT_RESUME（scan 级）/ SOURCE_COVERAGE_TRACKING = MISSING**。
* **IDEMPOTENCY = PARTIAL**（goal/task 级有确定性 digest/dedupeKey；scan 级无）。

## 3. PHASE 1 — 确定性 5 年时间范围（已实现并通过验证）

### 3.1 变更

| 文件 | 变化 |
| --- | --- |
| `apps/api/src/services/agent-goal/goal-contract.ts` | `GOAL_MAX_MONTHS` **36 → 60**（bounded max，带说明注释）；新增错误码 `GOAL_TIME_RANGE_EXCEEDS_MAX` |
| `apps/api/src/services/agent-goal/goal-compiler.ts` | 新增 `YEARS_DIGIT_SIGNAL`（`5 years` / `5 年`）与 `YEARS_CJK_SIGNAL`（`五年`，含 一…十 / 十一…十九 / 二十…九十九 解析）；`resolveTimeRange()` 先判年数 → `LAST_N_MONTHS = years*12`；超上限夹紧到 bounded max 并写 **可审计** signal `TIME:CLAMPED_TO_MAX`；CUSTOMS 域词表补 `进口` / `import(s|ed|ing)` |
| `apps/api/src/services/agent-goal/goal-validator.ts` | `normalizeTimeRange()` 不再静默夹紧：`> GOAL_MAX_MONTHS` → 显式抛 `GOAL_TIME_RANGE_EXCEEDS_MAX` |
| `apps/api/src/__tests__/agent-goal.test.ts` | 旧「静默夹紧到 36」断言改为「1..60 原样接受 + 超上限显式拒绝」；新增 PHASE 1 测试块（8 项） |

### 3.2 行为证据（实测）

| 输入 | 修复前 | 修复后 |
| --- | --- | --- |
| 检查我过去 5 年的关税损失 | `12` 个月（DEFAULT_12_MONTHS） | **`60` 个月**（`TIME:LAST_N_YEARS`） |
| 把过去五年的进口记录都检查一下 | `GOAL_UNSUPPORTED_INTENT`（域缺失）→ 时间不可达 | **`60` 个月**（CUSTOMS 域已识别「进口」） |
| scan my last 5 years of customs activity | `12` 个月 | **`60` 个月** |
| review my last 1 year of customs activity | `12` 个月 | `12` 个月（不变） |
| 检查过去 12 / 36 / 60 个月的关税损失 | `12 / 36 / 36`（60 被夹到 36） | **`12 / 36 / 60`** |
| 扫描过去 10 年的进口记录 | 静默 → `12` 个月 | 夹紧到 `60` + signal **`TIME:CLAMPED_TO_MAX`**（可审计，不静默） |
| 校验器收到 `months = 61` | 静默夹到 36 | **显式拒绝**（`GOAL_TIME_RANGE_EXCEEDS_MAX`） |
| 检查全部历史的关税记录 | `ALL_TIME` | `ALL_TIME`（不变） |

确定性：同文本两次编译 → 同 `goalDigest` / `goalId`（测试覆盖），无模型调用（`modelCallCount = 0`）。

### 3.3 回归证据

| 门禁 | 结果 |
| --- | --- |
| api tsc | **0** |
| `agent-goal.test.ts` | **38/38**（原 30 + 本单元 8） |
| `agent-goal-http-db.test.ts` / `goal-admission-db.test.ts` / `architecture-contract.test.ts` | **6 / 18 / 170 全绿** |
| 定向合计 | **4 文件 / 232 tests PASS** |

`prisma`、`apps/web`、`apps/api/src/runtime/**` **未改动**（本阶段只动 goal 编译/校验链与其测试）。

## 4. 状态表（截至本记录）

| PHASE | 内容 | 状态 |
| --- | --- | --- |
| 0 | 只读架构审计 | **DONE**（`HISTORICAL_SCAN_AUDIT.md`） |
| 1 | Goal 5 年支持（60 个月、无静默回落/夹紧） | **DONE**（232 tests） |
| 2 | Durable `RecoveryScanRun`（schema + migration + 确定性 identity/dedupe） | **NOT STARTED** |
| 3 | 时间范围经 durable scan 进入 ONE SI Runtime（claim 时按 dedupeKey 解析 scope，fail-closed） | **NOT STARTED** |
| 4 | `RecoveryWindowResolver`（requested vs effective + reason codes） | **NOT STARTED** |
| 5 | Customs 双 gate（filing deadline / qualifying window）+ verification 门禁 + remedy 词表补齐 | **NOT STARTED** |
| 6 | Historical Backfill Executor（季度/月度 shard + checkpoint + crash resume） | **NOT STARTED** |
| 7 | Connector 历史区间 + coverage 元数据（FULL/PARTIAL/SOURCE_LIMITED/UNKNOWN） | **NOT STARTED** |
| 8 | Customs 历史管线复用（entry → duty → discrepancy → eligibility → matching → evidence → drawback → CLAIM_READY） | **NOT STARTED**（既有链已存在，未接历史输入） |
| 9 | 客户安全 scan summary（UI 轻量进度/结果，不重构 UI V2） | **NOT STARTED** |
| 10 | 自动化 / SI 执行接线 | **NOT STARTED**（既有链路未改；SECOND_* 仍为 0） |
| 11 | 生产边界 | **保持 HOLD（未解锁任何能力）** |
| 12 | Durability debt | 已登记（`PRODUCTION_DURABLE_QUEUE_REQUIRED`），未解决 |
| 13 | 测试矩阵 A–G | 仅 A（Goal parsing）完成；B–G 未实现 |
| 14 | 验收（含 synthetic E2E） | **NOT DONE** |

## 5. 停止原因（非 STOP CONDITIONS 触发）

未触发任何 HOST 列出的 STOP CONDITION：没有新建第二 Runtime / Policy Engine / Guard / Fact Source，
没有绕过 Authorization 或 Action Guard，没有真实 provider 外写 / filing / payment，
没有用未核验的法律期限自动放行。

停在 PHASE 1 之后的原因是**范围与验证强度**：PHASE 2 起需要 schema migration（新增 durable scan 实体）、
Runtime claim 侧的 scope 解析、connector 契约扩展与 customs 法律期限双 gate 建模——这些都属于
「持久化真相 + 运行时语义 + 法律期限」的高风险面，必须在同一轮内完成
schema → migration → fresh DB → tests → runtime wiring → E2E 的完整闭环并全量回归（当前全量回归单次约 27 分钟），
不能以未验证的中间态合并。本记录如实登记进度，不宣称 CLOSED。

## 6. 下一步（PHASE 2 起的实现清单，按依赖顺序）

1. **PHASE 2**：`RecoveryScanRun`（organizationId + goalId + goalDigest + platformAccountId + domain + provider +
   requested/effective 区间 + requestedMonths + scanPolicyVersion + status + coverage* + shard/cursor checkpoint +
   计数 + scanDigest + dedupeKey（`scan:<goalDigest>:<domain>:<account>:<from>:<to>`））；
   `@@unique([organizationId, dedupeKey])`；不得含 transient timestamp；迁移 + fresh DB + tenant 触发器清单同步。
2. **PHASE 3**：claim 时以 task `dedupeKey` 解析 durable scan；tenant 不符 / 缺 scope / digest 被改 → BLOCK。
3. **PHASE 4/7**：`RecoveryWindowResolver` + connector range/coverage（先纯函数与契约，再接 adapter）。
4. **PHASE 5/8**：customs 双 gate + verification 门禁 + 历史输入复用既有 customs 链。
5. **PHASE 6/9/13/14**：backfill shard 执行器、scan summary UI、测试矩阵 B–G、synthetic E2E。

边界不变：`REAL_EXTERNAL_EXECUTION = NOT_EXECUTED`、`REAL_VALIDATION_COMPLETE = NO`、`PRODUCTION_READY = NO`；
`SECOND_RUNTIME = 0`、`SECOND_POLICY_ENGINE = 0`、`SECOND_GUARD = 0`、`SECOND_FACT_SOURCE = 0`；
全部 HOLD 不变。
