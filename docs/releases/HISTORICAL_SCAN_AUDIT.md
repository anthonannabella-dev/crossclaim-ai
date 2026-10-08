# HISTORICAL_SCAN_AUDIT —— HISTORICAL_RECOVERY_SCAN_V1 / PHASE 0（只读审计）

审计时间：2026-10-08（本地）
审计方式：只读（read-only），未修改任何已封板分支；基线 `feat/goal-input-ux-guidance` @ `7a078da6`。

| 项 | 值 |
| --- | --- |
| BASE_BRANCH | `feat/goal-input-ux-guidance`（最新已 push 基线；其父为已 CLOSED 的 `release/integration-20261008`） |
| BASE_HEAD | `7a078da6320c9cb6b868ede34d7c191db25723e0` |
| WORKTREE_STATUS | clean（审计开始时） |
| 本单元分支 | `feat/historical-recovery-scan-v1` |

---

## 1. GOAL_5Y_PARSE — **MISSING（本单元 PHASE 1 已修复）**

**修复前实测（`npx tsx` 直接调用 compiler）**

```
输入: 检查我过去 5 年的关税损失
结果: timeRange = { kind: 'LAST_N_MONTHS', months: 12 }, signal = TIME:DEFAULT_12_MONTHS
```

即：**「过去 5 年」被静默回落为默认 12 个月**（HOST 指出的风险确认成立）。

根因（`apps/api/src/services/agent-goal/goal-compiler.ts`）：

* `MONTHS_SIGNAL = /(\d{1,2})\s*(?:个)?\s*(?:月|months?)/i` —— 只识别「月 / months」；
* `LAST_YEAR_SIGNAL = /(过去|最近|last|past)\s*(?:一|1|one)?\s*(?:年|year)/i` —— 只识别「一年 / last year」，
  `5 years` 不匹配（数字 5 不在可选组内）；
* 两者都未命中 → `resolveTimeRange` 末行直接 `return LAST_N_MONTHS 12`（**无信号、无提示**）。

上限与夹紧（`goal-contract.ts` / `goal-validator.ts`）：

* `GOAL_MAX_MONTHS = 36`；
* `normalizeTimeRange` 用 `Math.min(GOAL_MAX_MONTHS, …)` **静默夹紧**，不产生任何 reason code。

→ 结论：`GOAL_5Y_PARSE = MISSING`（PHASE 1 已修复，见单元记录）。

## 2. TIME_RANGE_RUNTIME_PROPAGATION — **PARTIAL（范围在 plan 之后丢失）**

| 环节 | 是否携带 timeRange | 证据 |
| --- | --- | --- |
| Goal 编译 / 校验 | ✅ | `GoalPlan.timeRange`（`goal-task-planner.ts:35`），并进入 `goalDigest`（`goal-validator.ts`） |
| Task 草案 | ❌ | `GoalTaskDraft = { domain, dedupeKey }`（`goal-task-planner.ts:16–19`） |
| 队列准入 | ❌ | `GoalTaskQueuePort` 只传 task id / dedupeKey / priority（`goal-runtime-binding.ts:35+`） |
| Runtime claim → Recovery SI | ❌ | `recovery-si-pack.ts` 从 `task.id / task.dedupeKey / organizationId` 组装，**无 time range** |

→ 即：`Goal → Plan` 有范围；`Plan → queue → claim → Recovery SI` **没有**。Runtime 无法知道「过去 5 年」。

## 3. HISTORICAL_CONNECTOR_SUPPORT — **PARTIAL（有游标分页，无历史区间）**

| 能力 | 状态 | 证据 |
| --- | --- | --- |
| 分页游标（durable） | ✅ | `connectors/cursor-store.ts`（`CursorKey{cursorKey}` + `CursorStore.read/write`） |
| 「一页一推进」原子性 | ✅ | `connectors/runner.ts:237–251`：整页处理完才写新 cursor |
| startDate / endDate（历史区间入参） | ❌ | `Fetcher` 契约无 range 字段（`connectors/types.ts:61`） |
| 历史回溯窗口协商 | ❌ | 无 |
| source coverage metadata（actualCoverageFrom/To、completeness） | ❌ | 无 |

## 4. CUSTOMS_5Y_RULE_SUPPORT — **PARTIAL（无全球 3–5 年规则，但缺双 gate 与 verification 门禁）**

已具备（好的一面）：

* `customs/enterprise-ior/remedy-deadline.ts`：**按 remedy 各自动 anchor + days**，无全球统一 3–5 年规则
  （`REMEDY_DEADLINE_BOUNDARY.globalThreeToFiveYearRule = false`）；
  `MISSING_ANCHOR` → `INDETERMINATE`，`autoFilingAllowed = false`，`callsExpensiveProvider = false`。
* `customs/rule-pack/us-rule-pack-v1.ts`：remedy seed 各自带 `anchorField` / `daysFromAnchor` / `limitations` / `exclusionClauses`；
  `RULE_PACK_VERIFICATION_STATUSES = ['UNVERIFIED', 'LEGAL_VERIFIED']`。
* Drawback：`candidate: DRAWBACK_CANDIDATE`, `route: DRAWBACK`, `anchorField: 'exportDate'`, `daysFromAnchor: 1_825`
  （≈5 年），并要求出口/销毁/退货证据与 entry 可匹配；HTS 9801/9802 明确不得作为 drawback 依据。

仍缺（HOST PHASE 5 的要求）：

1. **未拆成两个 gate**：现在只有一个 `deadline = anchor + days`。缺少独立的
   `CLAIM_FILING_DEADLINE` 与 `EXPORT_OR_DESTRUCTION_QUALIFYING_WINDOW`；
2. **`verification` 未参与判定**：`evaluateRemedyDeadline()` 只吃 policy 的 anchor/days，
   不检查该 policy 是否 `LEGAL_VERIFIED`；即 `UNVERIFIED` 政策仍可能返回 `ELIGIBLE_WINDOW`
   （是否阻断取决于调用方；需在 PHASE 5 收口为「未核验 → INDETERMINATE，不得 CLAIM_READY」）；
3. remedy 细节词表（DRAWBACK / PROTEST / POST_SUMMARY_CORRECTION / EXCLUSION_REFUND /
   CLASSIFICATION_CORRECTION / DUPLICATE_DUTY）在 rule pack 中**不齐**（实测 seed 覆盖 DUPLICATE_DUTY、
   RATE_OVERPAYMENT→PSC、MISSED_EXCLUSION、DRAWBACK_CANDIDATE、PSC…，缺 PROTEST / CLASSIFICATION_CORRECTION 等）。

## 5. DURABLE_SCAN_STATE — **MISSING**

`prisma/schema.prisma` 现有 durable 仅：`AgentGoal`、`AgentGoalRun`（execution projection）、
`OAuthAuthorizationSession`、`ConnectionSyncState`（连接检查点）。**没有** scan run / backfill job /
shard checkpoint / scan coverage 的 durable 实体。

→ 若要用「临时 JSON 文件」承载 5 年扫描进度，即违反 HOST PHASE 12（禁止把 JSON read-modify-write 当 production durability）。

## 6. CHECKPOINT_RESUME — **MISSING（scan 级）**

* 连接级：有 cursor（`ConnectionSyncState.cursor` / `CursorStore`），可续传**单资源**分页；
* Scan 级：没有 shard（季度/月度）checkpoint，也没有「已完成 shard 列表 / 下一 shard」的持久状态；
* 因此「5 年扫描 → 完成 7 个 shard → 崩溃 → 从 shard 8 继续」当前**无法表达**。

## 7. IDEMPOTENCY — **PARTIAL**

已具备：Goal digest 确定性（同文本 → 同 `goalId`/`goalDigest`）；task `dedupeKey` 由 planner 确定性生成
（`task:recovery:<DOMAIN>:<suffix>`）→ 队列可去重；`AgentGoalRun` 以 `(organizationId, id)` 唯一；
connector 侧 source fingerprint 去重（`inputFingerprintOf`）。

缺口：**没有 scan 级幂等**（同一 goal/account/domain/range 重复执行 → 不重复创建 fact / opportunity / case 的保证），
因为不存在 scan 实体与之绑定。

## 8. SOURCE_COVERAGE_TRACKING — **MISSING**

无任何「请求区间 vs 实际覆盖区间 vs 完整度（FULL/PARTIAL/SOURCE_LIMITED/UNKNOWN）」的持久字段或响应字段；
因此无法阻止前端把「provider 只给 90 天」显示成「过去 5 年扫描完成」。

---

## 9. 其它审计结论（本单元设计约束）

* **不得建第二 runtime**：现有链路已是 Goal → admission → 既有队列 → ONE SI Runtime → Recovery SI；
  `rsi-task-runner.ts` 在未配置真实执行器时**返回 BLOCK**（不伪造 PASS），这是必须保留的语义。
* **Action Guard / Standing Authorization 不得绕过**：goal admission 已把范围与 provider 断言交给
  server-owned 校验（GA-7/GA-9/GA-10/GA-11 等既有测试覆盖）。
* **Production 边界**：`REAL_PROVIDER_WRITE / CUSTOMS_FILING / PAYMENT / AUTO_COMMISSION_CHARGE /
  PRODUCTION_CREDENTIALS / EXTERNAL_WRITE / TRANSPORT = HOLD` 未变。

---

## 10. 审计结论汇总

| 审计项 | 状态 |
| --- | --- |
| GOAL_5Y_PARSE | **MISSING → 本单元 PHASE 1 已修复** |
| TIME_RANGE_RUNTIME_PROPAGATION | PARTIAL（plan 之后丢失） |
| HISTORICAL_CONNECTOR_SUPPORT | PARTIAL（游标有、历史区间与 coverage 无） |
| CUSTOMS_5Y_RULE_SUPPORT | PARTIAL（按 remedy 建模；缺双 gate + verification 门禁 + 词表补齐） |
| DURABLE_SCAN_STATE | MISSING |
| CHECKPOINT_RESUME | MISSING（scan 级） |
| IDEMPOTENCY | PARTIAL（goal/task 级有；scan 级无） |
| SOURCE_COVERAGE_TRACKING | MISSING |
