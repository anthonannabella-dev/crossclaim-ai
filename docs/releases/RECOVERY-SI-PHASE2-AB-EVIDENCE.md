> **[HISTORICAL_SNAPSHOT]** 本文是历史审计 / 证据快照，原文保留不改写（历史裁决不删除）。
> 其中关于 `RUNTIME_WIRING` / `STEP_3_RUNTIME_POLICY_WIRING` / `RSI_OUTCOME_SINK_RUNTIME_WIRING`
> 的**当时状态**已被后续实现取代：SUPERSEDED_BY=c0b61792（STEP_3_RUNTIME_POLICY_WIRING：
> Recovery SI 作为 domain capability pack 接入 ONE CrossClaim SI Runtime；后续 FINAL-2..6 与 PHASE 2
> 见 ca23b1df / adcab905 / ca298187 / 5f9ce46f / 6e98e66e）。
> 唯一**现行**状态请以 `docs/releases/CURRENT-SI-RSI-STATUS.md` 为准
> （SUPERSEDED_BY=cdd95258 为该状态件的基线 HEAD）。

# Recovery SI Phase 2 —— P2-A + P2-B 实施证据

- 分支：`gate/7-commercial-validation`（不在 `main` 上开发）
- 授权：**MSG-20261005-13 = PASS WITH REVISE**（`REVIEWED_HEAD = 25d0b764c921e90d661adf2f9dd48e0f4aabb02b`；原文 5151 字符 / 339 行 / FNV `220ab1c8` / `FULL_COPY_OK`，已逐字归档 `AI-ARCHITECT-INBOX.md`）
- 本轮范围：**仅 P2-A + P2-B**。未做 P2-C（PREPARE Tool）/ P2-D（Action Guard handoff）/ P2-E（持久化 Schema）/ P2-F（模型网络与付费）/ P2-G（真实执行）
- 边界（全部维持）：`EXTERNAL_WRITE / PAYMENT / TRANSPORT / PRODUCTION_CREDENTIALS / REAL_CLAIM_SUBMIT / CUSTOMS_FILING / RSI_MODEL_NETWORK / RSI_PAID_MODEL_CALLS = HOLD`；`SECOND_RUNTIME = FORBIDDEN`；`L5_RELAXATION = FORBIDDEN`；`FINAL_ACCEPTANCE_HEAD = 0f7f7ac` 未改动。

## 1. 交付物

| 文件 | 作用 |
| --- | --- |
| `apps/api/src/services/intelligence/recovery-outcome-signal.ts` | P2-A：SI 决策 → 匿名·聚合·能力级 Outcome Signal（含硬前置常量与泄漏扫描） |
| `apps/api/src/services/intelligence/recovery-read-tools.ts` | P2-B：只读工具注册表工厂 + 静态 domain→READ 绑定 + 只读执行入口 |
| `apps/api/src/services/intelligence/recovery-read-tool-adapters.ts` | P2-B：三个 adapter 接**现有确定性只读服务**（opportunity / evidence / customs readiness） |
| `apps/api/src/__tests__/recovery-si-phase2-ab.test.ts` | P2-A + P2-B 验收（13 例） |
| `docs/releases/RECOVERY-SI-PHASE2-DESIGN-REQUEST.md` | 依据裁决修正 `REVIEWED_HEAD` bookkeeping（`aadb4a0b` → 真实送审 SHA `25d0b764`） |

## 2. P2-A —— 匿名聚合能力信号（硬前置条件）

常量（原样落盘，不重命名）：

```text
RECOVERY_OUTCOME_TO_RSI = AGGREGATED_ANONYMIZED_CAPABILITY_SIGNAL_ONLY
```

允许的指标集合（裁决枚举，新增须先过审计）：

```text
estimate_error_bucket / authorization_block_rate / evidence_missing_rate / median_time_to_ready
```

已实现的禁止项（命中即整条信号 fail-closed，**不做“脱敏后重发”**）：

- 顶层/嵌套键命中禁止清单 → `FORBIDDEN_FIELD`：`organizationId / userId / caseId / opportunityRef / claimId / paymentAccountRef / entryNumber / invoice·order·shipment identifiers / evidenceRef(s) / raw evidence refs / amount·recoverableAmount·expectedRecovery·customerAmount / currency` 等；
- 非白名单键 → `UNEXPECTED_FIELD`；非白名单指标 → `METRIC_NOT_ALLOWED`；指标取值越界 → `METRIC_VALUE_OUT_OF_RANGE`（比率必须 ∈ [0,1]，`estimate_error_bucket` 只能是 `0-5% / 5-10% / 10-20% / >20%`，`median_time_to_ready` 必须是正整数毫秒）；
- `refs` 只允许 `rule-version:... / algorithm-version:... / capability:... / tool-registry:...`（例如 `rule-version:v3`、`algorithm-version:v2`），其它引用 → `REF_NOT_ALLOWED`；
- `summary` 命中邮箱 / 绝对路径 / 货币符号 / 千分位金额 / 5 位以上数字串 / `org-·opp-·case-·claim-` 前缀 → `SUMMARY_LEAKS_IDENTIFIER`；
- `cohortSize < RECOVERY_OUTCOME_MIN_COHORT(=5)` → `COHORT_TOO_SMALL`（不产生信号，防反匿名化）。

投递语义：`publishRecoveryOutcomeSignals()` **先全量校验再投递**；本阶段没有 RSI sink → `RSI_SINK_NOT_WIRED_IN_P2_A`（零写入）。把 outcome signal 真正推进 RSI incident/task 属内部写入，本轮**不接线**（同一裁决把 P2-B = READ_ONLY 与 P2-C = INTERNAL_WRITE 明确分开）。

## 3. P2-B —— 只读 Tool 实接（调用路径与安全证明）

固定调用路径（不可绕过）：

```text
verified RecoveryPlan action
  → 静态 domain→READ 绑定（RECOVERY_DOMAIN_READ_TOOL；plan/LLM 不得构造 service 名）
  → 注册表 READ 工具（access 必须是 READ）
  → input schema（只有 organizationId + opportunityRef）
  → tenant context（registry 强制非空 organizationId；input.organizationId 必须等于 ctx.organizationId）
  → 现有确定性只读服务
  → output schema（字段/类型白名单）
  → sensitive-field scan（secret / token / 文件路径 / 存储引用 / 邮箱）
  → return to SI
```

静态绑定表（模型与 planner 都不能改写）：

| domain | 允许调用的 READ 工具 |
| --- | --- |
| `PLATFORM` / `CARRIER` / `INDEPENDENT_SITE` | `recovery.opportunity.read` + `recovery.evidence.read` |
| `CUSTOMS` | 上述两个 + `recovery.customs.authorization_readiness.read` |

每个 adapter 的安全证明（注册时强校验，证明与声明不符 → **拒绝注册并记 `SAFETY_PROOF_MISMATCH`**）：

```text
READ_ONLY = true
DB_WRITE = false
NETWORK = false
CREDENTIAL_READ = false
TENANT_SCOPED = true
```

复用的现有只读服务（不新建第二套读取实现）：

- opportunity → `services/workflow/opportunity-insight.ts#getOpportunityInsight`
- evidence → `services/workflow/case-read.ts#listCaseEvidence`
- customs authorization readiness → `services/customs/customs-authorization-center-loader.ts#createPrismaCustomsAuthorizationContextLoader`（投影 `center.stages.READY_TO_FILE` + `center.advancedBlockerCodes`）

## 4. 最小验收证据对照（P2-B 10 条）

| # | 裁决要求 | 证据（`recovery-si-phase2-ab.test.ts`） |
| --- | --- | --- |
| 1 | 一个真实 Opportunity READ tool | `P2B-01/02/03`：`recovery.opportunity.read` 返回真实投影（status/currency/hasRecoverableAmount/hasRuleEvaluation） |
| 2 | 一个真实 Evidence READ tool | `P2B-01/02/03`：`recovery.evidence.read` 走 `listCaseEvidence`（caseRef/evidenceCount/kinds） |
| 3 | 一个 Customs authorization-readiness READ tool | `P2B-01/02/03` + `P2B-09`：`recovery.customs.authorization_readiness.read` 投影 route/readyToFile/blockerCodes |
| 4 | cross-tenant → reject | `P2B-04`：伪造跨租户 state → `ok=false / TENANT_MISMATCH`，调用与 port 调用均为 0 |
| 5 | stale decision → tool 不调用 | `P2B-05`：`state` 新鲜但机会 `observedAt` 陈旧 → verifier 拒绝该 action，工具零调用（`PLAN_NOT_VERIFIED`） |
| 6 | unregistered tool → tool 不调用 | `P2B-06`：注册表缺 `recovery.evidence.read` → `TOOL_NOT_REGISTERED`，port 零调用 |
| 7 | tool throws / malformed output → fail-closed | `P2B-07`：抛错 → `TOOL_THREW`；字段缺失 → `OUTPUT_SCHEMA_REJECTED`；敏感输出 → `SENSITIVE_OUTPUT_REJECTED`；三者均 `output = null` |
| 8 | invoke counter 证明只调用被验证的 READ action | `P2B-08`：篡改 `expectedRecovery` → `MONEY_DERIVATION_MISMATCH` → 该机会零调用；其余调用的计数与记录一一相等；注册表内全部 `access = READ` |
| 9 | DB before/after 无业务写入 | `P2B-09`：走真实服务函数（fake Prisma 计数写动词）→ `create/createMany/update/updateMany/upsert/delete/deleteMany/$executeRaw/$transaction` 全部 0 次 |
| 10 | network / provider call count = 0 | `P2B-10`：两个模块源码静态扫描无 `fetch(` / `node:http` / `axios` / provider transport 调用；三个工具安全证明 `NETWORK=false / CREDENTIAL_READ=false`；`RECOVERY_READ_TOOLS_BOUNDARY.networkCalls = 0` |

## 5. 本轮验证结果

```text
api tsc --noEmit → exit 0
vitest: recovery-si-phase2-ab 13/13 PASS
回归：recovery-si 11 + recovery-si-e2e 5 + recovery-si-revise 6 = 22/22 PASS
总计：35/35 PASS
```

## 6. 明确未做（等待各自授权）

- `P2-C PREPARE Tool`：未实现、未注册（`prepareToolsAuthorized = false`）——需 P2-B 验收后单独授权；
- `P2-D Action Guard handoff / dry-run`：未实现（D1–D8 证据集合已按裁决登记为后续门槛）；
- `P2-E RecoveryPlan / DecisionEvidence 持久化`：未建表、无 Schema 变更（`SCHEMA_DELTA_REQUIRED = NO` 仅覆盖本轮）；
- `P2-F 模型网络 / 付费调用`、`P2-G 真实执行`：继续 HOLD；
- **运行时接线 = NONE**：本轮未接入任何 route / event loop / `rsi:run` 路径，`READY_FOR_EXECUTION` 依旧不是执行许可。

## 7. FINAL-2 修订（消费 MSG-20261005-14 = REVISE）

授权：**MSG-20261005-14**（`REVIEWED_HEAD = f1f6607d`；原文 4299 字符 / 272 行 / FNV `6729fcd3` / `FULL_COPY_OK`，已逐字归档）。
已确认 PASS（本轮不重做）：`THREE_REAL_READ_ADAPTERS`、`STATIC_DOMAIN_TO_TOOL_BINDING`、`READ_ONLY_ACCESS`、
`UNKNOWN_TOOL_FAIL_CLOSED`、`STALE_ACTION_NO_INVOKE`、`CURRENT_CROSS_TENANT_STATE_GUARD`、
`MALFORMED_OUTPUT_FAIL_CLOSED`、`SENSITIVE_OUTPUT_FAIL_CLOSED`、`DATABASE_WRITE = 0`、`NETWORK_CALL = 0`、
`CREDENTIAL_READ = 0`、`RUNTIME_WIRING = NONE`、`SCHEMA_DELTA_REQUIRED = NO`。

### 7.1 四项必修（A1 / A2 / B1 / B2）

- **CHANGE A1 —— unique cohort**：`cohortSize` 改为 **unique `opportunityRef` 计数**（比率分母同样按 opportunity 计），
  绝不再用 action 数量；`RECOVERY_OUTCOME_SIGNAL_BOUNDARY.cohortUnit = 'UNIQUE_OPPORTUNITY_REF'`。
  一个机会同时产生 `PREPARE_PACKAGE` + `READY_FOR_EXECUTION` 时不再虚高 cohort。
- **CHANGE A2 —— domain-bound outcome samples**：输入改为
  `estimateErrorSamplesByDomain` / `timeToReadySamplesMsByDomain`，每个域独立满足最小 cohort；
  同一批样本不再被多个 domain 复用（不会把一个域的 outcome 错归到另一个域）。
- **输出封套收紧（与 A2 同批）**：`refs` 只允许 `rule-version:*` / `algorithm-version:*`（移出 `capability:` / `tool-registry:`）；
  `signal` 走严格白名单枚举 `RSI_OUTCOME_SIGNALS`、`dedupeKey` 走固定形状正则、`summary` 走服务器句式正则、
  `reasonCodes` 走白名单 `RSI_OUTCOME_REASON_CODES`。任一不符 → **整条 signal rejected**（不做就地脱敏重发）。
- **CHANGE B1 —— verify at invocation boundary**：`runRecoveryReadTools()` **不再接受外部 `verification`**；
  执行入口内部重新 `prioritizeOpportunities()` + `verifyRecoveryPlan()`，因此「先 verify Plan A → 再改 plan →
  带旧 verification 调用」的 TOCTOU 在入口处 fail-closed。边界常量：`acceptsExternalVerification = false`、
  `verifyAtInvocationBoundary = true`。
- **CHANGE B2 —— actor / output identity binding**：adapter 侧新增
  `input.organizationId === actor.organizationId` 断言（否则 fail-closed，零查询）；
  registry 输出侧新增 `output.opportunityRef === input.opportunityRef`（否则 `OUTPUT_IDENTITY_REJECTED`），
  防 miswired port 返回同租户另一条 opportunity。

### 7.2 最小 FINAL-2 证据 6 条（`recovery-si-phase2-ab.test.ts`：F2-01..06）

| # | 裁决要求 | 证据 |
| --- | --- | --- |
| 1 | 3 opportunities × 2 actions → unique cohort = 3 → `COHORT_TOO_SMALL` → 无 RSI signal | `F2-01`（先断言 plan 确有 6 个 action，再断言 unique cohort = 3、`signals = []`、`skipped = [{CUSTOMS, COHORT_TOO_SMALL}]`） |
| 2 | CUSTOMS + CARRIER 同时存在 → 各自只用自己 domain 的 outcome samples | `F2-02`（只给 CUSTOMS 样本：CUSTOMS 得 `10-20%` 分档；CARRIER 无 bucket 且记 `ESTIMATE_ERROR_NOT_MEASURABLE` / `TIME_TO_READY_NOT_MEASURABLE`） |
| 3 | ref / dedupeKey / reasonCode 尝试编码 `org-` / `case-` / `opp-` → signal rejected | `F2-03`（`refs=['org-1']` → `REF_NOT_ALLOWED`；`refs=['capability:tool-registry']` 亦拒；`dedupeKey` 含 `opp-1` → `DEDUPE_KEY_NOT_ALLOWED`；`signal='CUSTOMS_OPP_1_SIGNAL'` → `SIGNAL_NOT_ALLOWED`；`reasonCodes=['OPP_1']` → `REASON_CODE_NOT_ALLOWED`；publish 拒绝且 sink 零调用） |
| 4 | 先 verify Plan A 再修改当前 plan → 执行入口不得调用任何受影响 tool | `F2-04`（Plan A `verification.ok = true`；篡改 `expectedRecovery` 后入口内重新 verify → `opp-customs` 零调用） |
| 5 | `actor.organizationId != input.organizationId` → fail-closed / DB read count = 0 | `F2-05`（fake Prisma `readCalls = []`、`writeCalls = []`，调用全部以 `TENANT_MISMATCH` fail-closed） |
| 6 | adapter 返回 `output.opportunityRef != requested ref` → `OUTPUT_SCHEMA/IDENTITY_REJECTED` | `F2-06`（detail 含 `OUTPUT_IDENTITY_REJECTED`，`output = null`） |

### 7.3 FINAL-2 验证结果

```text
api tsc --noEmit → exit 0
recovery-si-phase2-ab 19/19 PASS（P2A-01..05 + P2B-01..10 + F2-01..06）
Phase 1 回归：recovery-si 11 + recovery-si-e2e 5 + recovery-si-revise 6 = 22/22 PASS
合计 41/41 PASS
```

边界不变：`P2_C / P2_D = NOT_AUTHORIZED`、`P2_E = HOLD_SCHEMA_DELTA`、`P2_F / P2_G = HOLD`、
`RUNTIME_WIRING = NONE`、`SCHEMA_DELTA_REQUIRED = NO`、`FINAL_ACCEPTANCE_HEAD = 0f7f7ac`。
