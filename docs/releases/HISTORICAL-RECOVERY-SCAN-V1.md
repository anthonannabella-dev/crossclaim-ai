# HISTORICAL_RECOVERY_SCAN_V1 —— 单元记录（PHASE 0/1/2/4/5/6-core/9 已交付）

> 诚实状态：**PHASE 2–14 尚未全部完成**。已交付：PHASE 0（审计）、PHASE 1（5 年时间范围）、
> PHASE 2（durable `RecoveryScanRun` + migration + 幂等/租户/检查点）、PHASE 4（窗口解析器）、
> PHASE 5（Customs remedy 双 gate）、PHASE 6 核心（分片 + 检查点 + crash resume 执行器）、PHASE 9（客户安全 summary）。
> 未完成：PHASE 3（Runtime 侧 scope 装载接线）、PHASE 7（connector 历史区间）、PHASE 8（customs 历史管线接线）、
> PHASE 10（ONE SI Runtime E2E）、PHASE 11/12（边界与并发/崩溃的运行时验证）、PHASE 13/14（完整矩阵与最终验收）。
> 因此 **`HISTORICAL_RECOVERY_SCAN_V1 ≠ PASS / CLOSED`**。

## 1. 基线

| 项 | 值 |
| --- | --- |
| BASE_BRANCH | `feat/goal-input-ux-guidance`（父：已 CLOSED 的 `release/integration-20261008`） |
| BASE_HEAD | `7a078da6320c9cb6b868ede34d7c191db25723e0` |
| BRANCH | `feat/historical-recovery-scan-v1` |
| 已封板分支 | 未修改（`release/integration-20261008` = `190d57a6`、`main` = `5a340bc0` 不变） |

## 2. PHASE 0 —— 只读审计

产出：[`HISTORICAL_SCAN_AUDIT.md`](HISTORICAL_SCAN_AUDIT.md)。结论摘要：`GOAL_5Y_PARSE = MISSING`；
`TIME_RANGE_RUNTIME_PROPAGATION = PARTIAL`；`HISTORICAL_CONNECTOR_SUPPORT = PARTIAL`；
`CUSTOMS_5Y_RULE_SUPPORT = PARTIAL`；`DURABLE_SCAN_STATE / CHECKPOINT_RESUME / SOURCE_COVERAGE_TRACKING = MISSING`；
`IDEMPOTENCY = PARTIAL`。

## 3. PHASE 1 —— 确定性 5 年时间范围（已交付）

* `GOAL_MAX_MONTHS` **36 → 60**；新增错误码 `GOAL_TIME_RANGE_EXCEEDS_MAX`。
* 编译器新增 `YEARS_DIGIT_SIGNAL`（`5 years` / `5 年`）与 `YEARS_CJK_SIGNAL`（`五年`，支持 一…十 / 十一…九十九），
  在默认 12 个月之前判定；超上限夹紧到 bounded max 并写**可审计** `TIME:CLAMPED_TO_MAX`；CUSTOMS 域补 `进口` / `import`。
* 校验器：超过上限的未受信 draft **显式拒绝**（不再静默夹紧）。
* 证据：`agent-goal.test.ts` 38/38（含 1/12/36/60 个月、5 年（中/英）、五年、超限夹紧信号、ALL_TIME、digest 确定性）。

## 4. PHASE 2 —— durable `RecoveryScanRun`（已交付）

| 项 | 实现 |
| --- | --- |
| Schema | `RecoveryScanRun`（organizationId / goalId / goalDigest / domain / provider / platformAccountId / requestedFrom·To / effectiveFrom·To / requestedMonths / scanPolicyVersion / shardGrain / status / coverage* / shardsTotal·Completed·nextShardIndex / shardCursor / 计数 7 项 / reasonCodes / scanDigest / dedupeKey / leaseOwner·leaseExpiresAt / createdAt·updatedAt·completedAt） |
| 迁移 | `20261008120000_recovery_scan_run`（表 + CHECK + UNIQUE(organizationId,dedupeKey) + 身份触发器 + tenant 基线触发器）+ `20261008121000_recovery_scan_identity_effective_range`（**修正**：把 effectiveFrom/effectiveTo/shardGrain 纳入身份不可改写） |
| 清单同步 | `tools/tenant-triggers/required-triggers.json` 新增 `cc_tenant_recoveryscanrun` |
| 身份 | `buildRecoveryScanIdentity()`：`scanDigest = sha256(canonical(goal+domain+provider+account+effective 区间+months+policy))`；`dedupeKey = scan:v1:<goalDigest16>:<domain>:<provider|->:<account|->:<from>:<to>:<months>`；**不含 transient timestamp** |
| 幂等 | `createOrGetRecoveryScan()`（UNIQUE + P2002 → 返回既有行）；重复创建 `created=false`，行 id 相同 |
| 租户/账号隔离 | 创建前校验 goal 属于该组织（否则 `RECOVERY_SCAN_GOAL_NOT_FOUND`）；跨租户按 dedupeKey 读取返回 `null`；DB 触发器 `crossclaim_assert_tenant_integrity('goalId','AgentGoal')` + `cc_tenant_immutable__*` |
| 检查点 | `shardCursor`（当前分片内页游标）+ `nextShardIndex` + `shardsCompleted`；`advanceRecoveryScanShard()` 只在整页处理完后推进 |
| 并发 | `claimRecoveryScanRun()`：`updateMany(status='CREATED')` CAS，只有一个 worker 能抢到 |
| 覆盖 | `coverageStart/End/sourceCoverageStatus`（FULL/PARTIAL/SOURCE_LIMITED/UNKNOWN）由**端口上报**写入，不按请求推断 |

**Fresh DB**：scratch 库 `crossclaim_hscan20261008` → `prisma migrate deploy` **93/93 成功**（原 92 + 本单元 2，其中 1 个为修正）。

## 5. PHASE 4 —— `RecoveryWindowResolver`（已交付）

`resolveRecoveryWindow()`：`effectiveRange = min(requested, 数据源覆盖, 领域规则窗口)`，输出 reason codes
（REQUESTED_RANGE_APPLIED / SOURCE_HISTORY_LIMITED / POLICY_WINDOW_SHORTER / RULE_UNVERIFIED /
MISSING_JURISDICTION / MISSING_ANCHOR / FULL_COVERAGE / PARTIAL_COVERAGE）与 `blocksClaimReady`。
Customs 缺 jurisdiction / 未核验政策 / 缺 anchor → **阻断 CLAIM_READY**；无全球统一年限兜底。

## 6. PHASE 5 —— Customs remedy-specific 双 gate（已交付）

新增 `customs/enterprise-ior/remedy-gates.ts`：把时间规则拆成彼此独立的
**`CLAIM_FILING_DEADLINE`** 与 **`EXPORT_OR_DESTRUCTION_QUALIFYING_WINDOW`**；policy 需 versioned 且带
`verification ∈ {UNVERIFIED, LEGAL_VERIFIED}`。规则：

* 未 `LEGAL_VERIFIED` → `INDETERMINATE`，`claimReadyAllowed = false`；
* 任一 gate 未建模 / 缺 anchor → `INDETERMINATE`（不猜测、不套用统一年限）；
* 任一 gate 过期 → `EXPIRED`；
* 两 gate 均 PASS 且已核验 → `CLAIM_READY`（`autoFilingAllowed` 恒为 false）。

Drawback 的 1825 天（exportDate 锚点）被明确定位为**合格窗口**，而不是「统一的申报期限」。

## 7. PHASE 6（核心）—— 分片 / 检查点 / crash resume（已交付）

* `planScanShards()`：MONTHLY / QUARTERLY 确定性分片（保留 day-of-month；5 年 = 60 个月度分片；bounded ≤ 240）。
* `runHistoricalBackfill()`：逐 shard → 逐 page；每页 `ingest` 完成后才 `advanceRecoveryScanShard()` 写检查点；
  预算耗尽（`maxPages`）→ 返回 `PARTIAL` 并把检查点留在库里；再次调用从 `nextShardIndex` + `shardCursor` 继续；
  已完成 scan 重放**不产生任何 ingest 调用**（幂等）。

## 8. PHASE 9 —— 客户安全 summary（已交付）

`buildScanSummaryView()` + `scanCoverageIsFull()`：只读投影，恒声明 `claimsFiled = 0`、
`externalActionPerformed/externalWritePerformed/filingPerformed/paymentPerformed = false`；
覆盖非 FULL 或 effective 收窄时给出 `COVERAGE_NOT_FULL` / `EFFECTIVE_RANGE_NARROWER_THAN_REQUESTED` disclaimer；
**不允许**把部分覆盖表述为「5 年检查完成」。

## 9. 本轮实测证据

| 门禁 | 结果 |
| --- | --- |
| `prisma validate` | **valid** |
| Fresh DB migration | **93/93 applied**（scratch `crossclaim_hscan20261008`） |
| api tsc | **0** |
| `historical-scan-db.test.ts` | **11/11**（身份确定性 / 幂等 / 租户隔离 / 身份不可改写（DB 触发器）/ 并发 claim / 终态约束 / digest 篡改 / 分片检查点 / crash resume / 幂等重放 / 覆盖） |
| `historical-scan-window.test.ts` | **8/8**（分片计划 + 窗口解析 8 个 reason code 场景） |
| `customs-remedy-gates.test.ts` | **8/8**（未核验阻断 / 缺 gate / 缺 anchor / 过期 / 不同 remedy 独立窗口 / 无政策） |
| `agent-goal.test.ts` | **38/38** |
| `architecture-contract.test.ts` | **173/173**（模型总数 113 → 114，新增 tenant-owned `RecoveryScanRun`） |
| API 全量回归（fresh DB `crossclaim_hscan20261008`） | **4607 passed / 1 failed / 4608**（454 文件：453 通过），唯一失败 = 既有 `recovery-si-phase2-e-db` P2E-DB5 并行隔离 flake；单跑 **20/20 PASS** |

## 10. 未完成（如实登记）

### 10.0 本提交新增（PHASE 3 + PHASE 7）

**PHASE 3 — durable scan scope → ONE SI Runtime（Recovery binding）**

* 新增 `services/historical-scan/scan-scope-loader.ts`：
  `loadScanScopeForClaimedTask()` 只接受 `organizationId + dedupeKey`（task identity 最小字段），
  从 durable `RecoveryScanRun` **重新加载**范围与检查点；返回 `callerRangeTrusted: false`。
  缺失 / 跨租户 / 账户不符 / digest 不符 → 一律 `BLOCK`（不回落到 caller 范围）；caller 若自报
  from/to/months → 只记录 `CALLER_RANGE_IGNORED_NOT_TRUSTED`，**不采用**。
  `assertScopeNotCallerOwned()` 拒绝把范围字段塞进 task payload（第二事实源）。
* `runtime/recovery-si-pack.ts`：在 `run()` 的 `bind` 之后、任何策略/守卫/工具之前，扫描任务必须先装载
  durable scope；未注入 `scanScope` 端口 → `BLOCK RECOVERY_SCAN_SCOPE_LOADER_NOT_WIRED`；
  装载失败 → `BLOCK RECOVERY_SCAN_SCOPE_BLOCKED + <reason>`。普通任务不受影响；
  **未放宽**任何既有 policy / guard / claim 语义（测试里 guard DENY 仍然 BLOCK）。

**PHASE 7 — Connector 历史区间 + 覆盖诚实**

* `connectors/types.ts`：`Fetcher.pull()` 新增可选 `range: ConnectorHistoricalRange`
  （`{from, to, scanRunId}`，`scanRunId` 必填 = 服务端溯源锚点）；`FetcherPage` 新增
  `actualCoverageFrom/actualCoverageTo/sourceCoverageStatus`；新增
  `assertServerOwnedConnectorRange()`（缺 `scanRunId` → `CONNECTOR_RANGE_NOT_SERVER_OWNED`）。
* `connectors/runner.ts`：调用 fetcher 前先做 server-owned 校验，并把区间透传；
  `RunConnectorPullResult.coverage` 如实回传 provider 覆盖（缺省 `null`；未上报 → `UNKNOWN`，**不得默认 FULL**）。
* 证据：`historical-scan-runtime-scope.test.ts` **8/8**、`historical-scan-connector-range.test.ts` **4/4**。

### 10.1 仍未完成

### 10.0b 本提交新增（PHASE 8）

**PHASE 8 — Customs 历史管线（复用既有链，不建第二套）**

新增 `services/historical-scan/customs-historical-pipeline.ts`：

* `evaluateCustomsHistoricalCandidate()` 把历史 entry 交给**既有** `evaluateDrawbackCandidateRoute()`
  （其内部已复用 rule pack / evidence chain / counterpart match / deadline engine），把 disposition
  映射为四种历史结果：`CLAIM_READY` / `NEEDS_EVIDENCE` / `NEEDS_MANUAL_REVIEW` / `NOT_CANDIDATE`；
* 每条记录复核边界：`filingPerformed` / `billable` / `autoFilingAllowed` 必须为 false，否则抛
  `CUSTOMS_HISTORICAL_BOUNDARY_VIOLATION`；`requestFiling=true` 直接拒绝（历史扫描永不申报）；
* `evaluateCustomsHistoricalBatch()` 产出扫描级计数（scanned / claimReady / needsEvidence /
  needsManualReview / notCandidate / expired / opportunitiesSurfaced）供 durable scan 与 summary 使用；
* `CUSTOMS_HISTORICAL_PIPELINE_BOUNDARY` 明确：`reusesExistingChain=true`、`secondCustomsTruth=false`、
  `secondEligibilityEngine=false`、`secondEvidenceEngine=false`、`secondDeadlineEngine=false`、
  `llmDecidesDeadlines=false`、`maxDisposition=CLAIM_READY`。

证据：`customs-historical-pipeline.test.ts` **8/8**（含 HTS 9801/9802 非 drawback、缺证据、非 EXACT 匹配、
未核验政策、申报请求被拒、批量计数与边界恒 false）。

### 10.0c 本提交新增（UI_RESULT_VIEW 组件层）

新增 `apps/web/app/recoveries/scans/[id]/historical-scan-view.tsx`（只读展示，不重构已封板 UI V2）：

* 展示：请求回溯范围 / 实际数据覆盖 / 覆盖完整度（FULL·PARTIAL·SOURCE_LIMITED·UNKNOWN）/ 当前状态 /
  扫描进度（已完成分片/总分片）/ 已扫描记录 / 发现潜在机会 / 仍在有效窗口 / 需要补充证据 / 已过期；
* 覆盖诚实：**只有** `coverage = FULL` 且 `coverageFrom ≤ requestedFrom` 且 `coverageTo ≥ requestedTo`
  才算完整覆盖，否则显示「数据源未覆盖完整请求区间，本次不是『全部历史检查完成』」；
* 边界文案：明确「只做检查与准备：尚未向任何平台、报关行或支付渠道提交，也不会自动扣款」；
* 5 语言（zh-CN / en-US / ja / es / de）新增 `historicalScan.*` 19 键（i18n 键数 885 → **904**，硬编码 0）；
* 渲染断言 12 项（含「不得出现 已申报/已提交/filed/已到账」「不得出现内部枚举」「覆盖不足必须提示」
  「完整覆盖不提示」）；UI render check **219/219 OK**，web tsc **0**。

客户路由已接线：`GET /recovery-scans/:id`（只读、org-scoped、`reviewOpportunities` 权限、404 = 不存在或跨租户、
复用 `buildScanSummaryView`，不触发扫描 / 不写库 / 无外部动作），并同步 `API.md`
（api-contract：implemented=100 / documented=87 → **API_CONTRACT_OK**）；页面
`apps/web/app/recoveries/scans/[id]/page.tsx` 以 server component 渲染该只读投影。
证据：api tsc 0、web tsc 0、UI render 219/219、i18n 5 语言 904 键 / 0 硬编码。

| PHASE | 内容 | 状态 |
| --- | --- | --- |
| 3 | Runtime claim → durable scan scope 装载（fail-closed BLOCK） | **已接线（本提交）**：`scan-scope-loader.ts` + `recovery-si-pack` 扫描任务守卫 |
| 7 | Connector 历史区间 + coverage 元数据 | **已实现（本提交）**：`ConnectorHistoricalRange` + server-owned 校验 + coverage 回传 |
| 8 | Customs 历史管线接线（entry → duty → discrepancy → eligibility → matching → evidence → drawback） | **已实现（复用既有链）**：`customs-historical-pipeline.ts` + 8/8 测试 |
| UI_RESULT_VIEW | 客户可见结果页（范围/覆盖/状态/计数/完整度） | **DONE**：视图组件 + 5 语言 + 只读端点 `GET /recovery-scans/:id` + 页面 `/recoveries/scans/:id`（api-contract OK） |
| 10 | ONE SI Runtime E2E（Goal → scan → shards → customs → summary） | **CLOSED（AUDIT-2 = PASS，MSG-20261008-09，REVIEWED_HEAD e76e92a2）**；见 §13、§13.16 |
| 11 | 生产边界验证（自动化断言 externalWrite/filing/payment = false 的端到端） | **DONE**：`historical-scan-boundary` 7/7；见 §14（AUDIT-3 待送审） |
| 12 | durability / 并发 / crash recovery 的运行时验证 | **DONE**：`historical-scan-concurrency` 4/4（+ runtime reconcile 20/20）；见 §15（AUDIT-3 待送审） |
| 13 | 完整测试矩阵 B–G（range propagation / resume E2E / coverage limitation / customs 全矩阵 / tenant isolation E2E） | **DONE**：`historical-scan-matrix` 6/6；见 §16（AUDIT-4 待送审） |
| 14 | 验收 + synthetic E2E | **进行中**：prisma validate / fresh DB / api+web tsc / web build / UI render 219 / i18n / api-contract 全 PASS；全量回归与浏览器旅程收尾中；见 §17 |

**未完成的原因**：PHASE 3/7/8/10 需要改动 ONE SI Runtime 的 claim → Recovery SI 装配路径与 connector 契约，
必须与 runtime 级 E2E、并发/崩溃验证一起完成并跑全量回归（单次约 27 分钟）；在未完成该闭环前不把它们部分合入，
避免产生「范围可被 caller 自报」或「connector 区间未经 server 校验」的中间态。

## 11. 边界（不变）

## 12. AUDIT-1 送审记录（PHASE 8 + UI_RESULT_VIEW）

* AUDIT_ID：`AUDIT-1`
* REVIEWED_HEAD：`cbf5c7e1bde00b3653fc2ca9ac29b311db712320`（分支 `feat/historical-recovery-scan-v1`，已 push）
* 送审范围：PHASE 8（Customs 历史管线复用既有链）＋ UI_RESULT_VIEW（客户只读结果投影 + 路由接线）
* 关键变更：`services/historical-scan/customs-historical-pipeline.ts`、
  `services/workflow/http-routes.ts`（`GET /recovery-scans/:id`）、`apps/api/src/server.ts` 路由白名单、
  `API.md`、`apps/web/app/recoveries/scans/[id]/{historical-scan-view.tsx,page.tsx}`、
  5 语言 `historicalScan.*`、`ui-check-entry.tsx` 断言。
* 测试证据：`customs-historical-pipeline` 8/8；UI render 219/219；i18n 5 语言 904 键 / 0 硬编码；
  api tsc 0；web tsc 0；api-contract `API_CONTRACT_OK`（implemented=100 / documented=87）。
* 待判问题：① 是否确认**复用既有** Customs 链（无第二 truth / eligibility / evidence / deadline engine）；
  ② `CLAIM_READY` 是否严格 fail-closed（未核验政策 / 缺 anchor / 缺证据 / 非 EXACT 匹配 / 特殊条款一律不得进入）；
  ③ UI 覆盖诚实规则是否成立（非 FULL 覆盖不得表述为「全部历史检查完成」）；
  ④ 是否存在未授权的外部动作（filing / payment / external write）。
* 裁决（已归档）：**VERDICT = PASS WITH REVISE**，逐字归档 `AI-ARCHITECT-INBOX.md`
  `MSG-20261008-01`（FNV-1a `2b4491f6` / `FULL_COPY_OK` 223/223）。
  `SCAN_VIEW_*` / `SCAN_ROUTE_TENANT_SCOPED` / `NO_SECOND_ENGINE` / `CUSTOMS_PIPELINE_REUSES_EXISTING_CHAIN` = PASS；
  唯一 CHANGE：`CUSTOMS_CLAIM_READY_FAIL_CLOSED = REVISE` —— PHASE 8 必须消费 PHASE 4 的 `blocksClaimReady`，
  否则 `jurisdiction ?? 'US'` 的默认值会让「缺 jurisdiction」仍可能 CLAIM_READY。

### 12.1 AUDIT-1 / CHANGE 1 修订（已实现）

* `customs-historical-pipeline.ts`：`CustomsHistoricalCandidateInput` 新增可选
  `historicalWindow: { blocksClaimReady, reasonCodes }`；`evaluateCustomsHistoricalCandidate()` 现在
  **消费**该 gate 并在「缺 jurisdiction」或 `blocksClaimReady === true` 时把 `CLAIM_READY` 降级为
  `NEEDS_MANUAL_REVIEW`，同时保留 `MISSING_JURISDICTION` / `HISTORICAL_WINDOW_BLOCKS_CLAIM_READY` /
  gate 自身 reason codes。未新建第二套 eligibility/rule/deadline 引擎（仍复用既有 drawback route）。
* 回归（评审点名的 3 条，全部落地）：① 缺 jurisdiction + 其余完美 → 永不 CLAIM_READY 且保留 `MISSING_JURISDICTION`；
  ② `blocksClaimReady=true` 且底层 route 本会 CLAIM_READY → 降级阻断；③ `blocksClaimReady=false` + 完整已核验 US → CLAIM_READY 正常。
* 非阻断硬化（本轮一并做）：`buildScanSummaryView()` 的 `COVERAGE_NOT_FULL` 改用与 UI **同一**完整覆盖判据
  （`coverage=FULL` 且覆盖区间包住请求区间），避免 server/UI 两套判断漂移。
* 证据：`customs-historical-pipeline` **11/11**；定向批次 6 文件 **215/215**；api tsc **0**；web tsc **0**。

### 12.2 AUDIT-1 窄复审送审记录（CHANGE 1 修订）

* AUDIT_ID：`AUDIT-1R`（AUDIT-1 的唯一 CHANGE 复审）
* REVIEWED_HEAD：`1a0cb42b4a226a660fec2409302934e9d3779ff3`（分支已 push、工作树 clean）
* 送审范围：仅 CHANGE 1（PHASE 8 消费 Historical Window `blocksClaimReady`）；UI_RESULT_VIEW 已在本轮判 PASS，不重复审。
* 变更文件：`services/historical-scan/customs-historical-pipeline.ts`（gate 消费 + 降级 + reason 保留）、
  `services/historical-scan/summary.ts`（server/UI 同一覆盖判据）、
  `__tests__/customs-historical-pipeline.test.ts`（+3 条评审点名回归）。
* 证据：11/11（该套件）；定向批次 215/215；api tsc 0；web tsc 0。
* 裁决（已归档）：**VERDICT = PASS WITH REVISE**（`MSG-20261008-02`，FNV-1a `4e0b9084` / `FULL_COPY_OK` 87/87）：
  上一轮「缺 jurisdiction → 默认 US → CLAIM_READY」旁路已 **CLOSED**，3 条回归与代码一致，`COVERAGE_NOT_FULL` 硬化正确；
  最后一条极窄 CHANGE = `historicalWindow` gate 必须**必填**（缺失即阻断），不得作为可选 advisory metadata。

### 12.3 AUDIT-1R / CHANGE（已实现）

* `CustomsHistoricalCandidateInput.historicalWindow` 由可选改为**必填**；
* 运行时兜底：即使调用方（JS / 反序列化）省略该字段，也一律
  `NEEDS_MANUAL_REVIEW` + `HISTORICAL_WINDOW_GATE_MISSING`（`gateMissing` 与 `gate.blocksClaimReady` 同为阻断条件），
  绝不回落到「只看 drawback route」；
* 新增回归：等价的完美 US candidate 但省略 `historicalWindow` → **永不 CLAIM_READY**（保留 blocking reason）；
* 证据：`customs-historical-pipeline` **12/12**；api tsc **0**。

* `SECOND_RUNTIME = 0`、`SECOND_POLICY_ENGINE = 0`、`SECOND_GUARD = 0`、`SECOND_FACT_SOURCE = 0`
  （本单元新增的只是 durable scan scope + 纯函数解析器 + 领域步骤执行器；未新增调度器/运行时/政策引擎/守卫）。
* `REAL_PROVIDER_WRITE / CUSTOMS_FILING / PAYMENT / AUTO_COMMISSION_CHARGE / PRODUCTION_CREDENTIALS /
  PRODUCTION_ENABLEMENT / EXTERNAL_WRITE / TRANSPORT = HOLD`；`AUTO_FILING` 在代码层恒为 false。
* `createJsonTaskQueuePort()` 仍为 JSON read-modify-write：**已登记 `PRODUCTION_DURABLE_QUEUE_REQUIRED`**，
  本单元的 scan durability 走数据库（PostgreSQL 原子状态 + 唯一约束 + 触发器），未使用该 JSON 端口承载扫描检查点。
* `REAL_EXTERNAL_EXECUTION = NOT_EXECUTED`；`REAL_VALIDATION_COMPLETE = NO`；`PRODUCTION_READY = NO`。

### 12.4 AUDIT-1R2 裁决（已归档，AUDIT-1 CLOSED）

* MSG-20261008-03：CUSTOMS_CLAIM_READY_FAIL_CLOSED = PASS、VERDICT = PASS、REVIEWED_HEAD = 658f8ea7；FNV-1a 6ad3eed / FULL_COPY_OK 88/88。
* 评审确认三层负向保护成立（缺 jurisdiction → NEEDS_MANUAL_REVIEW + MISSING_JURISDICTION；blocksClaimReady=true → 降级且 gate reasons 保留；gate 整体缺失 → HISTORICAL_WINDOW_GATE_MISSING），正向路径未被误伤；**AUDIT-1 CHANGE 1 / AUDIT-1R / AUDIT-1R2 全部 CLOSED，无需 AUDIT-1R3**。
* 下一个审计节点 = AUDIT-2（PHASE 10 合成 5 年 E2E 完成后）。

## 13. PHASE 10 —— 合成 5 年 E2E（已实现，AUDIT-2 待送）

新增 __tests__/historical-scan-5y-e2e.test.ts（真实 PostgreSQL + 真实模块链，1 用例）：
Goal 文本 检查我过去 5 年的关税损失，能追回的全部处理 → 确定性编译 **60 个月**（modelCallCount = 0）→ server 校验 →
esolveRecoveryWindow（数据源只覆盖最近 1 年 → effective 收窄 + SOURCE_LIMITED）→ durable RecoveryScanRun（requested 5 年 / effective 收窄）→
claimRecoveryScanRun + loadScanScopeForClaimedTask（caller 自报范围被忽略；跨租户 BLOCK）→
分片回填（maxPages=3 → PARTIAL 且检查点落库；续跑 → COMPLETED，分片无重复）→ 每片 3 条 synthetic 记录经 **既有** customs 链 →
uildScanSummaryView（coverage=SOURCE_LIMITED、scanCoverageIsFull=false、disclaimerCodes 含 COVERAGE_NOT_FULL、claimsFiled=0、filing/externalWrite/payment=false）。

证据：该用例 1/1；历史扫描 + 架构定向批次 **7 文件 / 217 tests PASS**；api tsc **0**。
分片数据源为 **synthetic 端口**（test/acceptance only），不是 production adapter；所有判定仍走 server-owned 链。

### 13.1 AUDIT-2 送审记录（PHASE 10 合成 5 年 E2E）

* AUDIT_ID：AUDIT-2；REVIEWED_HEAD：e3b0995816b13a3285bcc9d9a4d87a5d009d08d（分支已 push、工作树 clean）
* 送审范围：PHASE 10 合成链路（Goal 60 个月 → 窗口解析 → durable scan → claim/scope 装载 → 分片回填+检查点续跑 → customs 四态 → 覆盖诚实 summary）
* 证据：historical-scan-5y-e2e 1/1；历史扫描 + 架构定向批次 7 文件 / 217 tests；api tsc 0
* 待判：⑤SYNTHETIC_5Y_E2E 是否成立 ⑥分片/检查点与 crash-resume 语义 ⑦覆盖诚实（源仅 1 年不得 FULL）⑧零外部动作（filing/payment/externalWrite=false）
* 裁决（等待中）：VERDICT = PENDING

### 13.2 AUDIT-2 裁决（已归档）与待办 CHANGE

* MSG-20261008-04：VERDICT = PASS WITH REVISE（REVIEWED_HEAD fe3b0995），FNV-1a 4368c0d / FULL_COPY_OK 227/227。
* 逐项：CHECKPOINT_RESUME / SOURCE_COVERAGE_HONESTY / NO_EXTERNAL_ACTION / NO_SECOND_RUNTIME = PASS；
  唯一 SYNTHETIC_5Y_E2E = REVISE —— 结论是「有效的跨模块 5 年 synthetic integration E2E，但**尚未真正进入 ONE SI Runtime composition**」，
  即 PHASE 10 还需把 claim/runtime 那一段换成**真实 runtime 组合**（既有 composeRsiRuntime / domain pack 认领路径），而不是只串模块。
* CHANGE（下一步实现）：PHASE 10 E2E 改为经**既有 ONE SI Runtime composition** 认领并投影（保持 SECOND_RUNTIME = 0、不新增执行路径），
  再送 AUDIT-2 窄复审。

### 13.3 AUDIT-2 CHANGE 进展（runtime composition leg）

* 已完成：scan-scope-loader.ts 新增确定性 scanDedupeKeyFromTaskKey()——从既有 planner 生成的
  	ask:recovery:<DOMAIN>:<suffix> 中**原样**取出 scan:v1:... token 作为 durable scan 查询键（不猜测）；
  runtime 侧装载因此可以直接吃 **claimed task 的 dedupeKey**。
* 已定位（尚未接线）：唯一 runtime 拒绝经 domainPacks 注入 recovery pack ——
  RECOVERY_SI_RESERVED_PACK_ID_REJECTED:recovery-si（Recovery 只能经 productRecoveryPack 组装）。
  因此 E2E 的 runtime leg 必须用 composeRsiRuntime({ productRecoveryPack: { appActionGuardDeps, readPorts, bind, <scanScope?> } })；
  而 productRecoveryPack 目前**没有** scanScope 透传（rsi-run.ts:181–187 组装处只传 appActionGuardDeps/readPorts/bind）。
* 下一步（本 tick 后立即做）：① 在 productRecoveryPack 类型与 createRecoverySiPack() 调用处补 scanScope 透传（不改任何 guard/claim 语义）；
  ② E2E runtime leg 用 productRecoveryPack + 真实 DB loader（loadScanScopeForClaimedTask）断言 runtime 自己装载 durable scope；③ 再送 AUDIT-2 窄复审。
* 本 tick 未提交失败的测试（已回退未提交改动，分支保持全绿：historical-scan-5y-e2e 1/1、runtime-scope 8/8）。

### 13.4 AUDIT-2 CHANGE 接线（productRecoveryPack.scanScope 已透传）

* ecovery-si-product-composition.ts 的 createProductRecoverySiPack() 新增可选 scanScope 并**透传**给既有 createRecoverySiPack()；
  si-run.ts 的 productRecoveryPack 类型与组装处同步透传 —— 未改任何 guard / policy / claim 语义，未新增执行路径。
* E2E runtime leg 仍需构造 ppActionGuardDeps：既有范例见 __tests__/rsi-si-runtime-real-guard-e2e.test.ts（ppGuardDeps() 辅助）与 gent-goal-runtime-wiring.test.ts；
  下一 tick 依此把 runtime leg 加回 historical-scan-5y-e2e.test.ts（productRecoveryPack: { appActionGuardDeps, readPorts, bind, scanScope }，scanScope = 真实 DB loader）。
* 证据：api tsc 0；historical-scan-runtime-scope 8/8、historical-scan-5y-e2e 1/1、rsi-si-runtime-e2e 5/5、agent-goal-runtime-wiring 7/7。

### 13.5 AUDIT-2 CHANGE 完成 —— PHASE 10 现在真实经过 ONE SI Runtime composition

* `historical-scan-5y-e2e.test.ts` 新增 runtime leg：
  `composeRsiRuntime({ tasksPath, productRecoveryPack: { appActionGuardDeps, readPorts, bind, scanScope } })`
  → `controller.tick()` 认领 `task:recovery:CUSTOMS:scan:v1:...`；**由 runtime 自己**经 `scanScope` 端口装载
  durable `RecoveryScanRun`（测试只断言端口被调用与结果 ok，不直接查库）。
* 断言：① `claimed.dedupeKey === 该 scan task`（唯一 runtime 认领）；② `loadedRefs === [taskKey]`
  （runtime 侧装载 durable scope，查询键由 `scanDedupeKeyFromTaskKey()` 确定性派生）；
  ③ domain dispatch log 非空（走既有 pack 派发，未走 direct-runner）。
* 证据：`historical-scan-5y-e2e` **2/2**（runtime leg + 完整 5 年链路）；api tsc **0**；
  `productRecoveryPack.scanScope` 透传在 `1aede231`。
* 送审：`AUDIT-2R`，REVIEWED_HEAD = `6dada7cf`。

### 13.6 AUDIT-2R 裁决（已归档）与下一步 CHANGE

* `MSG-20261008-05`：`VERDICT = PASS WITH REVISE`（`REVIEWED_HEAD 6dada7cf`），FNV-1a `1d2a8e50` / `FULL_COPY_OK` 163/163。
* 唯一 `SYNTHETIC_5Y_E2E = REVISE`：目前是**两条平行链** ——（A）Runtime → scanScope 装载 与
  （B）scan → backfill → customs → summary。评审要求的是**同一条连续链**：

```text
5年 Goal → queue task → composeRsiRuntime → controller.tick actual claim
  → product Recovery dispatch → durable scanScope
  → historical scan executor → runHistoricalBackfill()
  → checkpoint/backfill → existing Customs pipeline → durable summary
```

* 评审明确：**不要**把 `runHistoricalBackfill()` 硬塞进已封板的 read-only recovery pack
  （会破坏 `writesDatabase=false` / `executesActions=false`）；而是在**既有 ONE SI Runtime 下**新增
  historical scan execution port / domain step，由 server-owned composition 显式连接
  （仍不创建新 scheduler / runtime）。
* 待验证项：same taskKey / same scanId / same durable scope / backfill actually invoked /
  `SOURCE_LIMITED` preserved / CLAIM_READY·NEEDS_EVIDENCE·NOT_CANDIDATE counts persisted /
  `claimsFiled = 0` / `externalWrite = false` / `payment = false`。
* 另需补强 runtime leg 证据（评审指出 `domainDispatchLog().length` 断言偏弱）。
* 下一步：实现该 execution port + composition 连线 + 单条连续 E2E，再送 AUDIT-2 窄复审。

### 13.7 AUDIT-2R CHANGE 完成 —— PHASE 10 成为单条连续链

**① execution port（`9dd5c954`）**

* 新增 `services/historical-scan/scan-execution-port.ts`：
  `createHistoricalScanExecutionPort(prisma).run({ organizationId, taskKey, pagePort, ingestPort })`
  先经 `loadScanScopeForClaimedTask()` 装载 durable scope（非扫描任务 / 缺失 / 跨租户 / digest 异常 →
  `BLOCKED` 且 `scanId = null`），再驱动既有 `runHistoricalBackfill()`；
  `HISTORICAL_SCAN_EXECUTION_PORT_BOUNDARY`：`secondRuntime/secondScheduler=false`、
  `insideExistingOneSiRuntime=true`、`readOnlyPackUntouched=true`、`scopeFromDurableScanOnly=true`、
  `externalWritePerformed=false`（**没有**把 backfill 塞进 read-only pack）。

**② runtime 连线（`06d596c8`）**

* `composeRsiRuntime` 新增可选 `historicalScanDomainStep`；仅当 claimed task 的 `dedupeKey` 含 `scan:v1:` 时，
  由 **server-owned composition** 在既有 `controller.tick()` **之后**调用该步骤。
  它不是第二 runtime / 第二 scheduler；claim / lease / park-for-judge / reserved namespace 语义未改。

**③ E2E 单条连续链**

同一次 `tick()` 内：认领 `task:recovery:CUSTOMS:scan:v1:...` → runtime 装载 durable scope
（`loadedRefs === [taskKey]`）→ domain step 驱动 execution port → 断言 `scanId === 该 scan`、
`status = COMPLETED`、`ok = true`；负向断言：非扫描任务 key → BLOCK、跨租户 → BLOCK 且 `scanId = null`。
（评审指出的「仅断言 dispatch log 非空」偏弱问题已替换为上述强断言。）

**证据**：`historical-scan-5y-e2e` 2/2、`historical-scan-runtime-scope` 8/8、`rsi-si-runtime-e2e` 5/5、
`agent-goal-runtime-wiring` 7/7（合计 22/22）；api tsc 0。
**送审**：`AUDIT-2R2`，REVIEWED_HEAD = `06d596c8`。

### 13.8 AUDIT-2R2 裁决（已归档）与两条待办 CHANGE

* `MSG-20261008-06`：`VERDICT = PASS WITH REVISE`（`REVIEWED_HEAD 06d596c8`），
  FNV-1a `8838d7a8` / `FULL_COPY_OK` 184/184。评审确认 `scan-execution-port.ts` 确实复用 durable scope +
  既有 `runHistoricalBackfill()`，没有第二 runtime / scheduler。
* **CHANGE 1（关键）**：`controllerWithDomainSteps` 是在 `createRsiEventLoop({ controller })` **之后**才包的，
  因此 `composition.start()` → `loop.start()` → 内部持有的是**原始 controller**（`controller.emit()` 同理），
  domain step 不会运行；目前只证明了「手动 `composition.controller.tick()` 能跑完整链」，
  而不是「真实 ONE SI Runtime event/watchdog loop 能跑完整链」。
  **最小修复**：**先**组装 domain-step-aware controller，**再**把它传给 `createRsiEventLoop()`；
  并补一条由 `composition.start()` / loop 驱动的用例（断言 domain step 恰好执行一次、durable scan completed）。
* **CHANGE 2（更重要）**：domain step 当前绕过 park-for-judge / runner proposal 语义；需按既有
  `awaitVerdict = true` 路径处理（task claimed → Recovery pack 产出 proposal → `waitingForVerdict`），
  domain step 不得抢在 proposal 裁决之前直接完成 scan。
* 下一步：按上述两条实现（不改 guard / policy / claim / reserved namespace 语义），再送 AUDIT-2R3。

### 13.9 CHANGE 2 分析（park-for-judge）与实现决策

**实测事实**：`composeRsiRuntime` 在存在 domain pack（含 `productRecoveryPack`）时**强制**
`awaitVerdict = true`（`rsi-run.ts` 组装处），既有 `rsi-si-runtime-e2e` 也断言
`composition.controller.state().waitingForVerdict === true`（claim → proposal → park）。

**由此推论**：在同一个 `tick()` 里、claim 之后立刻执行 `historicalScanDomainStep`，
语义上就是**绕过 park-for-judge**（评审 CHANGE 2 指出的问题）。因此正确实现不是加一个 gate 条件，
而是把 domain step 放到**裁决/续跑之后**的既有路径上：

```text
claim → Recovery pack proposal → park-for-judge → verdict 收口（既有续跑路径）
      → historical scan domain step（execution port → runHistoricalBackfill）
      → durable scan COMPLETED → customs/summary
```

**决策**：不采用「同 tick 直接跑 backfill」的让步实现（那正是被指出的旁路）。
下一步需要先读既有续跑接口（`rsi-controller-continuation` / `attachContinuationToController` +
verdict watcher 的收口回调）确定最小接线点，再实现；同时补齐 CHANGE 1 的 loop 驱动用例。
在接线点确定前不改 runtime 语义，避免引入「裁决前即完成 scan」的新旁路。

### 13.11 CHANGE 2 已落地一半：park 期间不得执行 domain step（续跑接线待补）

* **生产代码（`a4d4653f`）**：`composeRsiRuntime` 的 domain-step 包装先读
  `controller.state().waitingForVerdict`；为 `true`（存在 domain pack 时强制 park-for-judge）→ **直接 return**，
  不在裁决收口前完成 scan。该门只会**阻止**过早执行，不会引入旁路。
* **E2E 断言**：claim 后 `waitingForVerdict === true` 且 `domainStepOutcomes.length === 0`（parked 期间零执行）。
* **仍待完成**：裁决收口**之后**的续跑接线。实测 `markWaitingForVerdict('PASS') + tick()` 不会重新产生 claim，
  因此「post-verdict → domain step → backfill → COMPLETED」还需读 `attachContinuationToController` 暴露的方法集
  与 verdict watcher 的收口回调，确认既有续跑/重认领入口后再接。
* 门禁：22/22、api tsc 0（`historical-scan-5y-e2e` 2/2、`historical-scan-runtime-scope` 8/8、
  `rsi-si-runtime-e2e` 5/5、`agent-goal-runtime-wiring` 7/7）。

### 13.12 AUDIT-2R2 两条 CHANGE 全部完成（CHANGE 1 覆盖 emit，CHANGE 2 收口后触发）

**CHANGE 1（`f59a4a02` + `747ccd09`）**

* domain-step-aware controller 在 `createRsiEventLoop()` **之前**组装（此前 loop 持有原始 controller）；
* 包装同时覆盖 **`emit()`**（`rsi-event-loop.ts:69` 的真实续跑路径）与 `tick()`（`:83` 兜底），
  函数签名与 `RsiControllerContinuation` 严格一致。

**CHANGE 2（`a4d4653f` + `bd3ab708`）**

* 组合层状态机：① 认领时记住 scan task；② **仅**在裁决收口后（`emit('JUDGE_VERDICT_RECEIVED')`
  且 `controller.state().waitingForVerdict` 已不为 true）驱动 `historicalScanDomainStep`；
  park 期间（含裁决 `BLOCK`）**直接 return**，绝不在裁决前完成 scan；
* 依据：`rsi-controller-continuation.ts` 的 `awaitVerdict` 语义 —— runner 结果只作提案，
  任务停在等待裁决，由 `JUDGE_VERDICT_RECEIVED` 收口（PASS 完成 / REVISE 插 P0 修订）。
  read-only pack（`writesDatabase=false` / `executesActions=false`）未改动，未新增 runtime / scheduler。

**E2E（单条连续链，`historical-scan-5y-e2e` 2/2）**

claim `task:recovery:CUSTOMS:scan:v1:...` → runtime 装载 durable scope（`loadedRefs=[taskKey]`）→
**parked：domain step 零执行** → `markWaitingForVerdict('PASS')` + `emit('JUDGE_VERDICT_RECEIVED')` →
domain step **恰好一次** → `scanId === 该 scan`、`status=COMPLETED`、`ok=true`；
另含非扫描任务 key → BLOCK、跨租户 → BLOCK（`scanId=null`）负向断言。

**证据**：`historical-scan-5y-e2e` 2/2、`historical-scan-runtime-scope` 8/8、`rsi-si-runtime-e2e` 5/5、
`agent-goal-runtime-wiring` 7/7、`rsi-controller-continuation` 3/3（合计 **25/25**）；api tsc 0。
**送审**：`AUDIT-2R3`，REVIEWED_HEAD = `bd3ab708`。

### 13.10 CHANGE 1 实测发现：loop 走的是 emit() 而不是 tick()

* 实测（临时用例，未提交）：composition.loop.pollOnce() 驱动时，historicalScanDomainStep **未被调用**
  （loopStepCalls === []），即：仅把 	ick() 包一层还不够 —— 既有 event loop 的续跑路径调用的是
  controller 的 mit()/续跑入口（评审原文亦指出「事件路径 controller.emit() 也一样绕过 wrapper」）。
* 结论：CHANGE 1 的修复面应覆盖 **loop 实际使用的 controller 方法**（emit/续跑入口），而不是只覆盖 tick()；
  这与 CHANGE 2 的结论一致 —— domain step 应挂在**裁决/续跑收口**处。
* 实验用例已回退（分支保持全绿），未提交失败测试。下一步：读 ttachContinuationToController 暴露的方法集，
  确定 loop 调用的确切入口，再一次性实现 CHANGE 1+2。

### 13.13 AUDIT-2R3 裁决（PASS WITH REVISE）+ 两条 CHANGE 完成（PASS-only 执行 / verdictWatcher 走 wrapped controller）

**裁决（已逐字归档 `AI-ARCHITECT-INBOX.md` → `MSG-20261008-07`，FNV1A `1f2d1933`，compare = FULL_COPY_OK）**

* REVIEWED_HEAD `bd3ab708`；`SYNTHETIC_5Y_E2E = REVISE`，`VERDICT = PASS WITH REVISE`。
* CHANGE 1（wrapped controller 在 `createRsiEventLoop()` 之前组装、覆盖 `emit`/`tick`）= **CLOSED**；
  scan execution port / durable scope reload / read-only pack 未改 `/ NO_SECOND_RUNTIME` 维持 PASS。
* 仍差两条极窄修复（AUDIT-2R4）：
  1. **域步骤只能由真实 PASS 裁决收口触发** —— REVISE / BLOCK 均不得执行（`BLOCK` 也不得推进 durable scan）；
  2. **verdictWatcher 必须走 domain-step-aware controller** —— 生产 watcher 当时仍调用原始 `controller`。
* 非阻断设计债（记入 RISKS，后续 production enablement 前处理）：
  `pendingScanTaskKey` 目前是**进程内变量**，非 durable state；`claim → park → 进程重启 → verdict 到达`
  会丢失 pending 归链，应由既有 restart/reconcile 机制从 durable task/scan 状态重建。

**CHANGE A（domain step 只在真实 PASS 收口后执行）**

* 旧的放行条件是 `event === 'JUDGE_VERDICT_RECEIVED' && !waitingForVerdict`；但 continuation engine 的真实语义是
  `PASS → action=CONSUME_VERDICT`、`REVISE → action=REVISION`、`BLOCK → action=OWNER_ACTION_REQUIRED`，
  **三者都会把 `waitingForVerdict` 置为 false** —— 因此旧条件会误放 REVISE / BLOCK（BLOCK 也推进 scan）。
* 新判据（`rsi-run.ts`）：收口前 `controller.state().verdict === 'PASS'` **且** 收口 `outcome.action === 'CONSUME_VERDICT'`。
* 同时移除已不再需要的 `parked` 放行兜底：裁决收口后引擎可能立刻为**下一个**任务重新 park（`awaitVerdict=true`），
  用 parked 兜底会误伤本轮已获 PASS 授权的 scan；未裁决 / BLOCK / REVISE = 零执行已由精确 PASS 门覆盖。
* 归一化断言：`PASS → 恰好一次`；`REVISE → 0`；`BLOCK → 0`；重复 verdict / 额外 tick → 不重复回填。

**CHANGE B（verdictWatcher 走 wrapped controller）**

* `isWaiting()` / `markWaitingForVerdict()` / `emit('JUDGE_VERDICT_RECEIVED')` 全部改走 `controllerWithDomainSteps`；
  **生产 watcher 与测试现在使用同一条 runtime path**（此前 `composition.controller` 返回 wrapped、watcher 仍持有原始 controller）。

**证据（`af328938` 之上；本单元提交后为送审 HEAD）**

* `historical-scan-5y-e2e` 7/7（新增 5 条：watcher-PASS / BLOCK / REVISE / watchdog-PASS / 幂等去重）；
  定向批次合计 **43/43**（+ `historical-scan-runtime-scope` 8、`rsi-si-runtime-e2e` 5、`agent-goal-runtime-wiring` 7、
  `rsi-controller-continuation` 3、`rsi-run` 7、`rsi-park-for-judge` 3、`rsi-verdict-wiring` 3）；api tsc 0。
* BLOCK / REVISE 负向断言 durable scan 仍为 `CREATED`（执行端口从未被调用 → 未认领、检查点未推进）。
* 边界声明：`historicalScanDomainStepRequiresPassVerdict = true`、`verdictWatcherUsesDomainStepController = true`。
* GitHub Actions = NOT_OBSERVED（仅 local/Codex evidence）。

**下一步**：`AUDIT-2R4` 窄复审（CHANGE A + CHANGE B）；PASS 后 PHASE 10 方可 CLOSED，再进入 PHASE 11。

### 13.14 AUDIT-2R4 裁决（PASS WITH REVISE）+ 最后一条 CHANGE：pending scan 的 task binding

**裁决（已逐字归档 `AI-ARCHITECT-INBOX.md` → `MSG-20261008-08`，FNV1A `08aa9c6e`，compare = FULL_COPY_OK）**

* REVIEWED_HEAD `93912225`；`SYNTHETIC_5Y_E2E = REVISE`、`VERDICT = PASS WITH REVISE`。
* 已确认 PASS：PASS-only 判据主体、REVISE/BLOCK **即时**零执行、watchdog PASS 路径、
  verdictWatcher 走 wrapped controller、重复 PASS/poll 幂等、event loop 走 wrapped controller、`NO_SECOND_RUNTIME`。
* 唯一 CHANGE：**REVISE / BLOCK 收口后 stale `pendingScanTaskKey` 未清除** ——
  REVISE 会插入 P0 revision task；若旧 pending 不清，revision task 之后的 PASS 会**错误执行原 scan**
  （即 PASS 门还需要再绑定「这个 PASS 属于哪一个 task」）。
* 审计预计：修完这一条即 `SYNTHETIC_5Y_E2E = PASS`。

**本轮修复（`armedScanTaskKey` 重设计）**

* `pendingScanTaskKey` → `armedScanTaskKey`，语义改为「**已认领、正在等待裁决**的那一个任务」：
  - 仅当本轮出现新认领（`outcome.claimed !== null`）才（重新）武装；新认领非扫描任务则置 `null`；
  - 结算顺序固定为 **先结算本轮裁决、再武装本轮新认领** —— 修掉此前「PASS 收口同一次调用里 engine 立刻认领下一个 scan，
    导致 pending 被覆盖成下一个任务」的顺序缺陷。
* 任何**终局裁决收口**（`CONSUME_VERDICT` / `REVISION` / `OWNER_ACTION_REQUIRED`）一律先解除武装；
  仅当 `verdictBeforeConsume === 'PASS'` 且收口动作确为 `CONSUME_VERDICT` 时，才对**解除武装前的那个** scan 执行 domain step。
  因此 REVISE / BLOCK 之后，后续任务的 PASS 不可能消费原 scan；无法识别 verdict 的收口也一律 fail-closed（不执行）。
* 边界声明新增：`historicalScanPendingBinding = 'ARMED_CLAIMED_TASK_ONLY；NON_PASS_TERMINAL_VERDICT_CLEARS_PENDING'`。

**新增回归（`historical-scan-5y-e2e` 9/9）**

* AUDIT-2R4-①：REVISE 后 stale pending 必须清除 —— revision task 拿到 PASS 时原 scan 仍 0 执行、durable 仍 `CREATED`；
* AUDIT-2R4-②：多个 scan 任务排队 —— 只执行当前 armed scan（A→COMPLETED，B 仍 `CREATED`），B 需自己的 PASS 才执行。

**证据**：定向批次 **48/48**（9 文件：historical-scan-5y-e2e 9、historical-scan-runtime-scope 8、rsi-si-runtime-e2e 5、
agent-goal-runtime-wiring 7、rsi-controller-continuation 3、rsi-run 7、rsi-park-for-judge 3、rsi-verdict-wiring 3、
rsi-event-loop 3）；api tsc 0。GitHub Actions = NOT_OBSERVED（仅 local/Codex evidence）。

**设计债（继续跟踪，不阻断本次 synthetic 收口）**：`armedScanTaskKey` 仍是**进程内变量**；
`claim → park → 进程重启 → verdict 到达` 会丢失 pending 归链；production enablement 前需从 durable task/scan 状态重建。

**下一步**：`AUDIT-2R5` 窄复审（task-binding 收口）。

### 13.15 AUDIT-2R5 送审与「审计通道阻塞」记录（裁决未读）

* 送审：`AUDIT-2R5`，REVIEWED_HEAD = `e76e92a2`（记录提交 `566a1218`，已 push、工作树 clean）。
* **投递已校验通过**：composer 清空（0 字符）＋ marker `[CODEX-HIST-AUDIT-2R5]` 作为新的用户轮出现＋生成中指示出现。
* **随后通道阻塞**：该会话进入错误态 `无法加载此 ChatGPT 对话` / `无法加载历史记录`（仅剩侧边栏）。
  已尝试：点击「重试」×2、`reload()`、离开再返回同一 URL、**新开标签页打开同一会话** —— 均同样失败；
  对照同一浏览器的其它会话可正常加载 ⇒ 会话级（服务端）载入失败，不是账户 / 扩展 / 标签页问题。
* 依审计协议：**停止浏览器操作**，保存审计包，报告阻塞；**不虚构裁决、不自行宣告 PASS**。
  审计包留存：`work/hist-scan/audit-2r5-package.md`（含请求原文与投递校验记录；该目录为本地工作产物，未随仓库提交）。
* 状态：**PHASE 10 仍未 CLOSED**（既未收到 2R5 裁决，也无 PASS 依据）。
* 下一步：下一 tick 重试读取该会话；若持续不可用，请宿主恢复该会话或指定替代审计会话。

### 14. PHASE 11 完成 —— Runtime / Guard / Policy / 租户 / 外写 边界验证（内部单元，DONE）

新增 `apps/api/src/__tests__/historical-scan-boundary.test.ts`（7/7）。**只做边界与负向验证，不新增执行路径、不引入第二 runtime。**

**① 静态边界（SECOND_* = 0）**

* `RSI_RUNTIME_COMPOSITION_BOUNDARY`：`secondRuntime = 0`、`performsExternalWrite/writesDatabase/readsCredentials = false`；
  PHASE 10 收口语义仍在（`historicalScanDomainStepRequiresPassVerdict = true`、`verdictWatcherUsesDomainStepController = true`、
  `historicalScanPendingBinding` 含 `ARMED`）。
* `RSI_CONTROLLER_CONTINUATION_BOUNDARY`：`holdsProviderCredentials/writesDatabase = false`、`proposalIsNotVerdict/runnerCannotWriteVerdict/parkForJudgeSupported = true`。
* `RECOVERY_SI_PACK_BOUNDARY`：`isSecondRuntime = false`、`executesActions/writesDatabase = false`、`networkCalls = 0`、`realModelCalls = 0`。
* `RECOVERY_SI_PRODUCT_COMPOSITION_BOUNDARY.secondGuardImplementation = FORBIDDEN`；
  `RECOVERY_GUARD_ADAPTER_BOUNDARY`：`secondGuardImplementation = FORBIDDEN`、复用 `createAppActionGuard`、不可用时 `DENY`（fail-closed）。
* `HISTORICAL_SCAN_EXECUTION_PORT_BOUNDARY`：`secondRuntime/secondScheduler = false`、`insideExistingOneSiRuntime = true`、`scopeFromDurableScanOnly = true`、`externalWritePerformed = false`。
* `CUSTOMS_HISTORICAL_PIPELINE_BOUNDARY`：`reusesExistingChain = true`、`secondCustomsTruth = false`、`autoFilingAllowed/filingPerformed/paymentPerformed = false`、`maxDisposition = 'CLAIM_READY'`。
* 源码扫描 `src/services/historical-scan/**`（>5 文件）：禁止 `setInterval/setTimeout`（第二调度器）、`new Worker/child_process`（第二 runtime）、
  `bullmq/agenda/pg-boss/node-cron`（第二队列）、`fetch/axios/http.request/undici`（外部网络）、`writeFile/createWriteStream`（外部写）—— 命中数 = 0。

**② Guard / Policy 边界（fail-closed，不可绕过）**

* 扫描任务缺 durable `scanScope` → pack 侧 `BLOCK` + `RECOVERY_SCAN_SCOPE_LOADER_NOT_WIRED`（不执行任何工具）。
* `domainPacks` 注入 `packId='recovery-si'` → 抛 `RECOVERY_SI_RESERVED_PACK_ID_REJECTED`（不能冒充 Recovery pack 绕过共享 Action Guard）。
* 生产组装点缺共享 guard 依赖 → 抛 `RECOVERY_SI_PRODUCT_GUARD_REQUIRED`（不静默降级、不接受手写 guard 实例）。

**③ 租户 / 外写边界（真实 PostgreSQL）**

* 跨租户装载 durable scan scope → `ok = false`，且目标租户扫描行的 `status / recordsScanned / nextShardIndex` **完全未被修改**。
* 执行端口跑完整回填后：`RecoveryScanRun` **行数不变**（只改既有行，无第二事实源、无外部写副作用），`status = COMPLETED`；
  summary 的 `filingPerformed / paymentPerformed / externalWritePerformed = false`、`claimsFiled = 0`、`coverage = SOURCE_LIMITED`（覆盖诚实）。

**证据**：`historical-scan-boundary` 7/7；与 5 年 E2E 合并定向批次 16/16；api tsc 0。GitHub Actions = NOT_OBSERVED（仅 local/Codex evidence）。

**审计**：`AUDIT-3` 覆盖 PHASE 11/12 —— 受审计通道阻塞影响，待通道恢复后送审。

### 15. PHASE 12 完成 —— 多 worker 并发 / 崩溃恢复 / 陈旧租约 / 检查点续跑 / 幂等（内部单元，DONE）

新增 `apps/api/src/__tests__/historical-scan-concurrency.test.ts`（4/4，真实 PostgreSQL）。**不新增 runtime / scheduler / queue。**

**① 多 worker 并发认领（CAS，唯一赢家）**

* 两个 worker 同时对同一 `RecoveryScanRun` 调用 `claimRecoveryScanRun`（`Promise.all`）→ **恰好一个**拿到行；
  因 `updateMany where status='CREATED'` 的 CAS，败者不产生任何写。
* 断言 durable 行：`status=RUNNING`、`leaseOwner ∈ {winner}`、`recordsScanned=0`、`nextShardIndex=0`（败者零推进检查点）。
* 第三个 worker 再次认领同样返回 `null`（RUNNING 不可被再次认领，杜绝第二执行者）。

**② 崩溃恢复（跨 worker，durable checkpoint）**

* worker A 认领后以 `maxPages=2` 中断（进程内状态全部丢弃，模拟崩溃）→ 返回 `PARTIAL`；
  durable 行仍为 `RUNNING` 且 `nextShardIndex=2`（**落库的是 checkpoint，而不是 PARTIAL 终态**）。
* worker B（不同 `leaseOwner`，等价新进程）不重新认领，直接续跑 → `COMPLETED`；
  `Set(seen).size === seen.length`（**分片零重复**），`recordsScanned === 已处理分片数`。

**③ 幂等（重放零副作用）**

* `COMPLETED` 后再次执行同一 scan → 返回 `COMPLETED`，**pagePort 未被再次调用**（`seen.length` 不变），
  `RecoveryScanRun` **行数不变**，`recordsScanned / nextShardIndex` 与首次完成后完全一致。

**④ 陈旧租约（诚实边界，记录而不美化）**

* scan 级**没有** lease reclaim / fencing：租约早已过期的 `RUNNING` scan 不会被自动回收，`claimRecoveryScanRun` 对非 `CREATED` 一律返回 `null`
  —— 本 PHASE 不新增第二套 lease 引擎。
* 恢复语义由**既有** ONE SI Runtime 的 task-lease reconcile 承担（`rsi-restart-reconcile.test.ts` 10/10、
  `rsi-reboot-reconcile-db.test.ts` 10/10，本批一并复跑）。
* 仍记为 `PRODUCTION_DURABLE_QUEUE_REQUIRED`（生产级 durable/atomic 队列 + 租约围栏），未在本 PHASE 解决。

**证据**：`historical-scan-concurrency` 4/4；PHASE 12 批次 **40/40**（含 5 年 E2E 9、边界 7、runtime reconcile 20）；api tsc 0。
GitHub Actions = NOT_OBSERVED（仅 local/Codex evidence）。

**审计**：`AUDIT-3`（PHASE 11/12）待审计通道恢复后送审。

### 16. PHASE 13 完成 —— 完整测试矩阵 B–G（内部单元，DONE）

新增 `apps/api/src/__tests__/historical-scan-matrix.test.ts`（6/6，真实 PostgreSQL + 真实模块链）。

**B · range propagation**：请求 5 年 → `resolveRecoveryWindow` 按数据源收窄为 `effectiveFrom = 2025-10-08`（`SOURCE_LIMITED`）；
durable scope 装载时 `assertedRange`（1990–2030 / 999 月）被忽略（`callerRangeTrusted = false`、`requestedMonths = 60`）；
分片计划按 **effective** 窗口展开（`shards[0].from === effectiveFrom`，不含被收窄掉的区间）。

**C · resume E2E（runtime 域步骤维度）**：第一次 `historicalScanExecutionPort.run(maxPages=2)` → `PARTIAL` 且 `blocked=false`，
durable 行 `RUNNING / nextShardIndex=2`；第二次同一域步骤调用（新调用、同一条链）→ `COMPLETED`，`scanId` 为同一 durable scan，分片零重复。

**D · coverage limitation（负向 + 正向对照）**：数据源只覆盖最近 1 年 → `coverage=SOURCE_LIMITED`、`scanCoverageIsFull=false`、
`disclaimerCodes` 含 `COVERAGE_NOT_FULL`，且 `requestedMonths=60 / requestedFrom=2021-10-08` 原样保留（不按请求反推 FULL）；
数据源覆盖全窗口的正向对照 → `coverage=FULL`、`scanCoverageIsFull=true`、不含 `COVERAGE_NOT_FULL`。

**E · customs 全矩阵**（表驱动，6 格全中）：
`PERFECT → CLAIM_READY`；`NO_EVIDENCE → NEEDS_EVIDENCE`；`SPECIAL_PROVISION(9801) → NOT_CANDIDATE`；
缺 `historicalWindow` → `NEEDS_MANUAL_REVIEW + HISTORICAL_WINDOW_GATE_MISSING`；
`blocksClaimReady=true` → `NEEDS_MANUAL_REVIEW + HISTORICAL_WINDOW_BLOCKS_CLAIM_READY`；
缺 `jurisdiction` → `NEEDS_MANUAL_REVIEW + MISSING_JURISDICTION`。
每格恒定边界：`filingPerformed / paymentPerformed / externalWritePerformed / autoFilingAllowed = false`。
批次汇总与单条一致（claimReady 1 / needsEvidence 1 / notCandidate 1 / needsManualReview 3）。

**F · tenant isolation E2E**：用 ORG 的 runtime 上下文执行 **ORG_B** 的扫描任务 → `BLOCKED` 且 `scanId=null`；非扫描任务同样 fail-closed；
两个租户的 durable 行均保持 `CREATED / recordsScanned=0`（跨租户尝试不产生任何写）；跨租户 scope 装载 `ok=false`。

**G · 外部动作 / 第二事实源不变式**：矩阵跑完后 summary 的 `filingPerformed / paymentPerformed / externalWritePerformed = false`、
`claimsFiled = 0`，且 `RecoveryScanRun` **行数不变**（只改既有行，无第二事实源）。

**证据**：`historical-scan-matrix` 6/6；历史扫描全量批次 **57/57**（8 文件）；api tsc 0。GitHub Actions = NOT_OBSERVED（仅 local/Codex evidence）。

**审计**：`AUDIT-4`（PHASE 13/14）待审计通道恢复后送审。

### 17. PHASE 14 验收（进行中 —— 已完成子项已列明）

| 子项 | 结果 | 证据 |
| --- | --- | --- |
| prisma validate | **PASS** | `The schema at prisma\schema.prisma is valid` |
| fresh DB（全量迁移） | **PASS** | 新建 scratch DB → `prisma migrate deploy` → `All migrations have been successfully applied.`（94 migrations，含 `20261008120000_recovery_scan_run`、`20261008121000_recovery_scan_identity_effective_range`）；验证后已删除 scratch DB |
| migrate status（dev） | **PASS** | `94 migrations found` / `Database schema is up to date!` |
| api tsc | **PASS** | exit 0 |
| web tsc | **PASS** | exit 0 |
| web build | **PASS** | `next build` exit 0；构建产物含 `/recoveries/scans/[id]`（ƒ Dynamic） |
| UI render | **PASS** | `UI_RENDER_CHECK=OK checks=219`（含 `scan.view.*` 6 项 + i18n parity） |
| i18n | **PASS** | `I18N_CHECK=OK locales=5 keys=904 statusCodes=13 customerHardcodes=0`（`HARDCODED_CUSTOMER_STRINGS=0`、`RAW_ENUM_FALLBACK_HITS=0`） |
| api-contract | **PASS** | `implemented=100 documented=87` → `API_CONTRACT_OK` |
| recover-projection gate | **PASS（fail-closed 保持）** | `/recover` 不产出静态页、sitemap 为空、全部 404（未生成投影时不套模板） |
| 全量回归 | **4657/4658（唯一失败 = 既有 P2E-DB5 flake，隔离重跑 20/20 PASS）** | `apps/api` 全量 vitest（461 文件 / 4658 tests，1435s）；失败项 `recovery-si-phase2-e-db.test.ts > P2E-DB5`（`prisma.payment.count()` 期望 0 得 1，全量并发下的既有顺序型 flake，与本单元改动无关；单跑 `20 passed`） |
| 浏览器 desktop+mobile 旅程 | 待做 | 结果页 `/recoveries/scans/[id]`（未重构已封板 UI V2） |

**审计通道恢复 + 送审进度**：该会话曾服务端不可加载（§13.15），恢复后已重发 AUDIT-2R5 并收到 **PASS**（§13.16，PHASE 10 CLOSED）；
随后已送 **AUDIT-3（PHASE 11/12，REVIEWED_HEAD `5062812a`）**，投递三项校验通过（composer 清空 / 标记新用户轮 / 生成中），裁决待读。

> 边界不变：`REAL_EXTERNAL_EXECUTION = NOT_EXECUTED`、`REAL_VALIDATION_COMPLETE = NO`、`PRODUCTION_READY = NO`；
> `SECOND_* = 0`；全部外部写 / 凭据 / 运输 = HOLD。GitHub Actions = NOT_OBSERVED（仅 local/Codex evidence）。

### 13.16 AUDIT-2R5 = PASS —— **PHASE 10 / AUDIT-2 CLOSED**（裁决逐字归档 MSG-20261008-09）

**裁决（`MSG-20261008-09`，FNV1A `9612f81b`，compare = FULL_COPY_OK）**

* `SYNTHETIC_5Y_E2E = PASS`、`VERDICT = PASS`、REVIEWED_HEAD = `e76e92a2`。
* 逐项：`SYNTHETIC_5Y_E2E / CHECKPOINT_RESUME / SOURCE_COVERAGE_HONESTY / NO_EXTERNAL_ACTION / NO_SECOND_RUNTIME = PASS`；
  **`AUDIT-2 / PHASE 10 = PASS / CLOSED`**；**无新增 CHANGE，不需要 AUDIT-2R6**。
* 审计明确认可本轮两项闭合：① **REVISE stale pending 已 CLOSED**（`REVISION → isVerdictClosure → armed=null → 不执行`，
  且回归覆盖「scan A → REVISE → revision task → 后续 PASS → 原 scan 仍 `CREATED / recordsScanned=0 / 0 calls`」的完整序列，
  而非只验证 REVISE 当下）；② **多 scan 同轮 claim 顺序已 CLOSED**
  （`await settleArmedScanTask(...)` 先于 `armClaimedScanTask(...)`，A PASS 只执行 A、B 仍需自己的 PASS）。
* 审计确认 production runtime 路径未回退：event loop / watchdog tick / verdictWatcher 均走 wrapped controller；
  `productRecoveryPack → 既有 Recovery SI pack → durable scanScope → Judge PASS → historical domain step →
  既有 scan execution port → 既有 runHistoricalBackfill()`，**未新增第二 runtime / scheduler / policy engine**。
* 保留的唯一生产设计债（不阻断 synthetic 收口）：`armedScanTaskKey` 仍是进程内变量；production enablement 前需从
  durable task/scan/lease 状态恢复该归链或建立持久化 execution-intent linkage。
* 口径修正接受：`566a1218`（与 `352a0e33`）同时改了 `AI-ARCHITECT-INBOX.md` 与 `docs/...`，均为归档/文档性质，不影响 reviewed runtime code；
  且 `e76e92a2 → 2de7b691` 之间无 `apps/api/src/runtime/**` 或 `apps/api/src/services/historical-scan/**` 变化。

**对 §13.15 的更正**：该节记录的「AUDIT-2R5 已投递」在本会话侧当时确实通过了三项投递校验，但**服务端未持久化**该消息
（会话恢复后可见最后一条用户轮为单个「在」，无 2R5 标记）——已按协议重发并在本会话重新校验（composer 清空 + 标记出现在新用户轮 + 生成中），
随后收到上表裁决。审计通道在该时段对**该会话**不可用（重试 / 重载 / 新标签均失败），现已恢复。
