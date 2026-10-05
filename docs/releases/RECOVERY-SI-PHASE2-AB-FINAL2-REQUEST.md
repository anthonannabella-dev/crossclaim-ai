# Recovery SI Phase 2 A/B FINAL-2 —— 送审请求

- 分支：`gate/7-commercial-validation`
- **REVIEWED_HEAD = `c04c3c43`**（A1 / A2 / B1 / B2 修订后的实现提交；本轮代码与测试都在该 SHA 上）
- 前置：**MSG-20261005-14 = REVISE**（`REVIEWED_HEAD = f1f6607d`；原文 4299 字符 / 272 行 / FNV `6729fcd3` / `FULL_COPY_OK`，已逐字归档 `AI-ARCHITECT-INBOX.md`）。
- 耐久记录：`docs/releases/RECOVERY-SI-PHASE2-AB-EVIDENCE.md` §7（四项必修 + F2-01..06 对照表）。
- 本轮范围：**只修 A1 / A2 / B1 / B2**，未进入 P2-C / P2-D。

## 1. 四项必修的落地方式

| 裁决要求 | 落地 |
| --- | --- |
| `CHANGE_A1_UNIQUE_COHORT = REQUIRED` | `cohortSize` = **unique `opportunityRef` 计数**（由 plan actions 去重得到）；两个比率的分母同样按 opportunity 计；边界常量新增 `cohortUnit = 'UNIQUE_OPPORTUNITY_REF'` |
| `CHANGE_A2_DOMAIN_BOUND_OUTCOME_SAMPLES = REQUIRED` | 输入改为 `estimateErrorSamplesByDomain` / `timeToReadySamplesMsByDomain`；每个 domain 独立判断是否达到 `RECOVERY_OUTCOME_MIN_COHORT`；边界常量新增 `outcomeSamplesPerDomain = true` |
| 输出封套收紧（与 A2 同批） | `refs` 仅允许 `rule-version:*` / `algorithm-version:*`；`signal` 走白名单枚举 `RSI_OUTCOME_SIGNALS`；`dedupeKey` 走固定形状正则；`summary` 走服务器句式正则；`reasonCodes` 走白名单 `RSI_OUTCOME_REASON_CODES`；违规则整条 signal 被 publish gate 拒绝 |
| `CHANGE_B1_VERIFY_AT_INVOCATION_BOUNDARY = REQUIRED` | `runRecoveryReadTools()` 签名去掉 `verification`；入口内部重新 `prioritizeOpportunities()` + `verifyRecoveryPlan()`；边界常量 `acceptsExternalVerification = false`、`verifyAtInvocationBoundary = true` |
| `CHANGE_B2_ACTOR_AND_OUTPUT_IDENTITY_BINDING = REQUIRED` | adapter 侧 `input.organizationId === actor.organizationId` 否则抛错（fail-closed、零查询）；registry 输出侧 `output.opportunityRef === input.opportunityRef` 否则 `OUTPUT_IDENTITY_REJECTED`；边界常量 `adapterActorTenantBound = true`、`outputIdentityBound = true` |

## 2. 最小 FINAL-2 证据（6 条，全部为负例）

| # | 裁决要求 | 测试与断言 |
| --- | --- | --- |
| 1 | 3 opportunities × 2 actions → unique cohort = 3 → `COHORT_TOO_SMALL` → 无信号 | `F2-01`：先断言 plan 确有 **6 个 action**，再断言 `signals = []` 且 `skipped = [{ CUSTOMS, COHORT_TOO_SMALL }]` |
| 2 | CUSTOMS + CARRIER 同时存在 → 各自只用自己 domain 的 samples | `F2-02`：只给 CUSTOMS 样本 → CUSTOMS = `CUSTOMS_ESTIMATE_CALIBRATION_DRIFT` + `10-20%`；CARRIER = `CARRIER_RECOVERY_CAPABILITY_SIGNAL`、`estimate_error_bucket` 为 `undefined`、reasonCodes 含 `ESTIMATE_ERROR_NOT_MEASURABLE` |
| 3 | ref / dedupeKey / reasonCode 尝试编码 `org-` / `case-` / `opp-` → signal rejected | `F2-03`：`refs=['org-1']` → `REF_NOT_ALLOWED`；`refs=['capability:tool-registry']` 亦被拒；`dedupeKey` 含 `opp-1` → `DEDUPE_KEY_NOT_ALLOWED`；`signal='CUSTOMS_OPP_1_SIGNAL'` → `SIGNAL_NOT_ALLOWED`；`reasonCodes=['OPP_1']` → `REASON_CODE_NOT_ALLOWED`；`publishRecoveryOutcomeSignals` 返回 `SIGNAL_REJECTED` 且 sink 零调用 |
| 4 | 先 verify Plan A 再修改当前 plan → 入口不得调用受影响 tool | `F2-04`：Plan A `verification.ok = true`；把 `opp-customs` 的 `expectedRecovery.amount` 改掉后直接调用入口 → 入口内重新 verify → `opp-customs` 零调用（且 port 未被调用，与旧的 `verification` 快照无关） |
| 5 | `actor.organizationId != input.organizationId` → fail-closed / DB read count = 0 | `F2-05`：actor = `org-other`、state = `org-p2` → 所有调用以 `TENANT_MISMATCH` fail-closed；fake Prisma `readCalls = []`、`writeCalls = []` |
| 6 | adapter 返回 `output.opportunityRef != requested ref` → `OUTPUT_SCHEMA/IDENTITY_REJECTED` | `F2-06`：port 返回 `opp-someone-else` → detail 含 `OUTPUT_IDENTITY_REJECTED` 且 `output = null` |

## 3. tests（本地实测）

```text
api tsc --noEmit → exit 0
recovery-si-phase2-ab：19/19 PASS（P2A-01..05 + P2B-01..10 + F2-01..06）
Phase 1 回归：recovery-si 11 + recovery-si-e2e 5 + recovery-si-revise 6 = 22/22 PASS
合计 41/41 PASS
```

## 4. invariant 与未改动项

- `READ_ONLY`（DB 写入 0 / 网络调用 0 / 凭据读取 0）、`TENANT_SCOPED`、`UNKNOWN_TOOL / STALE_STATE / TENANT_MISMATCH = FAIL_CLOSED` 全部保持；
- 静态 domain→READ 绑定不变；planner / LLM 仍不能构造 service 名；
- 不建第二套 Runtime；`L5` 不放宽；`READY_FOR_EXECUTION` 仍只是决策标记；
- **未改动**：P2-C（PREPARE Tool）、P2-D（Action Guard handoff）、P2-E（持久化）、P2-F（模型）、P2-G（真实执行）。

## 5. schema delta

```text
SCHEMA_DELTA_REQUIRED = NO（本轮无 Prisma schema / migration 变更）
```

## 6. requested verdict

1. `CHANGE_A1_UNIQUE_COHORT` / `CHANGE_A2_DOMAIN_BOUND_OUTCOME_SAMPLES`（含输出封套收紧）是否可记 **PASS**？
2. `CHANGE_B1_VERIFY_AT_INVOCATION_BOUNDARY` / `CHANGE_B2_ACTOR_AND_OUTPUT_IDENTITY_BINDING` 是否可记 **PASS**？
3. 6 条最小 FINAL-2 证据是否足够？`P2_A / P2_B` 是否可记 **PASS**、`RECOVERY_SI_PHASE2_AB` 是否可 CLOSED？
4. 是否继续维持 `P2_C / P2_D = NOT_AUTHORIZED`、`P2_E = HOLD_SCHEMA_DELTA`、`P2_F / P2_G = HOLD`？
5. 若仍需修订，请只列最小集合。

请在本次会话中直接回答；不要尝试写回 GitHub。不要使用上一轮缓存。

## 7. 边界声明（本轮未改动）

```text
P2_C = NOT_AUTHORIZED
P2_D = NOT_AUTHORIZED
P2_E = HOLD_SCHEMA_DELTA
P2_F = HOLD
P2_G = HOLD
EXTERNAL_WRITE = HOLD
PAYMENT = HOLD
TRANSPORT = HOLD
PRODUCTION_CREDENTIALS = HOLD
REAL_CLAIM_SUBMIT = HOLD
CUSTOMS_FILING = HOLD
RSI_MODEL_NETWORK = HOLD
RSI_PAID_MODEL_CALLS = HOLD
SECOND_RUNTIME = FORBIDDEN
L5_RELAXATION = FORBIDDEN
FINAL_ACCEPTANCE_HEAD = 0f7f7ac
```
