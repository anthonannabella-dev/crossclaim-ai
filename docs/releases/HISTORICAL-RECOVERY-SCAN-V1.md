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
| 10 | ONE SI Runtime E2E（Goal → scan → shards → customs → summary） | 未实现 |
| 11 | 生产边界验证（自动化断言 externalWrite/filing/payment = false 的端到端） | 部分（summary 层已固化，运行时尚无 E2E） |
| 12 | durability / 并发 / crash recovery 的运行时验证 | 部分（store + executor 级已测；运行时级未测） |
| 13 | 完整测试矩阵 B–G（range propagation / resume E2E / coverage limitation / customs 全矩阵 / tenant isolation E2E） | 部分（A/C/D/E 及 customs 纯函数已覆盖） |
| 14 | 验收 + synthetic E2E | 未完成 |

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

