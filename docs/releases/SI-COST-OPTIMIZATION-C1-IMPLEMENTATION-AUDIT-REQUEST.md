> **[HISTORICAL_SNAPSHOT]** 本文是历史审计 / 证据快照，原文保留不改写（历史裁决不删除）。
> 其中关于 `RUNTIME_WIRING` / `STEP_3_RUNTIME_POLICY_WIRING` / `RSI_OUTCOME_SINK_RUNTIME_WIRING`
> 的**当时状态**已被后续实现取代：SUPERSEDED_BY=c0b61792（STEP_3_RUNTIME_POLICY_WIRING：
> Recovery SI 作为 domain capability pack 接入 ONE CrossClaim SI Runtime；后续 FINAL-2..6 与 PHASE 2
> 见 ca23b1df / adcab905 / ca298187 / 5f9ce46f / 6e98e66e）。
> 唯一**现行**状态请以 `docs/releases/CURRENT-SI-RSI-STATUS.md` 为准
> （SUPERSEDED_BY=cdd95258 为该状态件的基线 HEAD）。

# SI-COST-OPTIMIZATION C1 —— Implementation Audit 送审请求

- 分支：`gate/7-commercial-validation`；仓库 `anthonannabella-dev/crossclaim-ai`
- **REVIEWED_HEAD = `a1ba1dee`**（C1 实现提交）
- 前置：**MSG-20261005-30 = PASS WITH REVISE / APPROVED FOR STAGED IMPLEMENTATION**
  （3.1=A / 3.2=B / 3.3=A（存储入 C2）/ 3.4=A / 3.5=A；`C1 IMPLEMENTATION = AUTHORIZED`）
- 耐久证据：`docs/releases/SI-COST-OPTIMIZATION-C1-EVIDENCE.md`
- 本轮范围：**C1 三项契约 + Model Gateway 唯一咽喉接线**；**零 Schema / 零迁移 / 零外部网络**

## 1. 落地内容（对应 MSG-20261005-30 的 C1）

| 项 | 落地 |
| --- | --- |
| AI Necessity Gate | `rsi-ai-necessity-gate.ts`：`RULE_SOLVABLE` / `HIGH_CONFIDENCE` → `MODEL_CALL_FORBIDDEN`；`AMBIGUOUS` / `SEMANTIC_REQUIRED` → 仅 `LEVEL_1_ELIGIBLE`；`UNKNOWN` / 证据缺失或畸形 → `FAIL_CLOSED`；caller 能力声明被忽略 |
| 单咽喉接线 | `rsi-model-router.ts`：`outcomeOf()` **先**过 Necessity Gate（无旁路）；cost policy 声明的 `LEVEL_2` 被钳制为 `LEVEL_1`；gate 拒绝/失败路径零 provider 调用、零台账记录 |
| Cache Identity Contract | `rsi-model-cache-identity.ts`：7 个安全字段构成 canonical key；任一不一致 → 对应 `MISS_*`；跨租户 → `MISS_ORGANIZATION`；过期 → `MISS_STALE`；高风险过期 → `MISS_HIGH_RISK_STALE_FORBIDDEN`；存储层按裁决入 C2 |
| Cheap→Strong 合同 | `rsi-model-escalation-policy.ts`：`PASS → STOP_PASS`（绝不 strong）；`FAIL / LOW_CONFIDENCE → 一次有界 ESCALATE_TO_STRONG`；`maxAttempts=2 / maxEscalations=1` 固定；`STRONG FAIL → STOP_FAILED`；`judgeAuthorizedMoreCalls` 被忽略 |
| 请求契约收紧 | `RsiModelCallRequest` 增加**必需** `necessity` 与可选 `escalation`：caller 不能再以 `requiredCapability` 直接换取模型调用权 |

## 2. C1 ACCEPTANCE 证据（HOST 14 条逐条）

```text
RULE_SOLVABLE 无 provider call            → C1_NECESSITY_RULE_SOLVABLE_FORBIDS_MODEL_CALL + router 级（计数 0）
HIGH_CONFIDENCE 无 provider call          → C1_NECESSITY_HIGH_CONFIDENCE_FORBIDS_MODEL_CALL
UNKNOWN fail-closed                       → C1_NECESSITY_UNKNOWN_AND_MISSING_EVIDENCE_FAIL_CLOSED
caller bypass blocked                     → C1_NECESSITY_CALLER_DECLARED_CAPABILITY_GRANTS_NOTHING（无证据 → FAIL_CLOSED）
organization mismatch cache MISS          → C1_CACHE_NEVER_CROSSES_TENANTS_AND_STALE_IS_MISS
stale cache MISS                          → 同上（MISS_STALE）
ruleVersion mismatch MISS                 → C1_CACHE_HIT_ONLY_WHEN_IDENTICAL_AND_MISS_ON_EACH_MISMATCH
high-risk stale fallback forbidden        → 同上（MISS_HIGH_RISK_STALE_FORBIDDEN）
cheap PASS 不调用 strong                  → C1_ESCALATION_PASS_NEVER_CALLS_STRONG + router 级 PASS 分支
cheap FAIL 最多一次受控 escalation        → C1_ESCALATION_FAIL_ALLOWS_EXACTLY_ONE_BOUNDED_STRONG_CALL + router 级
maxAttempt / maxEscalation 生效           → 同上（STOP_BOUNDED 两个 reason）
no recursive model loop                   → C1_ESCALATION_NO_RECURSION_AND_JUDGE_CANNOT_AUTHORIZE + router 触顶分支
existing RSI cost regression green        → 全量 rsi-* 回归 46 文件 / 248 例 PASS
tsc = 0                                   → exit 0
```

## 3. 验证命令与结果

```text
apps/api npx tsc --noEmit                                            → exit 0
rsi-cost-c1 + rsi-cost-e2e + rsi-model-router + rsi-local-sim-adapter → 4 files / 38 tests PASS
rsi-* 全量回归（46 文件）                                             → 46 files / 248 tests PASS
prisma validate / migrate status                                     → valid / 79 migrations up to date（未改 Schema）
```

## 4. 与裁决条文的对应（防遗漏）

- 「3.2=B 需明确」：本批未引入任何 usage 第二事实源；`RsiModelCallRequest` 不含预算用量字段（用量仍由 `options.usage()` 提供、由 ledger 聚合），C2 将落地 `AiBudgetPolicy` durable + usage 聚合。
- 「cache 不套用永久禁删 append-only」：本批仅交付 identity/判定契约（零存储）；`AI_CACHE_BOUNDARY.appendOnlyRequired = false`、`controlledTtlGc = true`。
- 「strong escalation 必须防循环升级」：`maxAttempts=2 / maxEscalations=1` 固定常量 + `decideAiEscalation` 的 `STOP_BOUNDED / STOP_FAILED`。
- 「LLM Judge 不得自我授权」：`decideAiEscalation` 忽略 `judgeAuthorizedMoreCalls` 并记录 `JUDGE_AUTHORIZATION_IGNORED`；`assertJudgeCannotAuthorizeModelCall` 对越权路径 fail-closed。

## 5. 请求裁决

1. C1（Necessity Gate / Cache Identity Contract / Cheap→Strong 有界升级合同 + Model Gateway 单咽喉）是否可记 **PASS**？
2. `C1 IMPLEMENTATION` 是否可记 **PASS / CLOSED**（`C1_FINAL2_REQUIRED = ?`）？
3. 是否确认可进入 **C2 IMPLEMENTATION**（`AiCostLedgerEntry` append-only durable + `AiBudgetPolicy` durable + usage 聚合 + tenant/append-only 清单同步 + 真实 PG 回归 + Budget race 防线）？
4. 若仍需修订，请只列最小集合。

请在本次会话中直接回答；不要尝试写回 GitHub。不要使用上一轮缓存。

## 6. 边界声明（本批未改动）

```text
REAL_MODEL_NETWORK / PAID_MODEL_CALLS = HOLD（仅本地仿真 adapter；零外部模型支出）
EXTERNAL_WRITE / PAYMENT / TRANSPORT / PRODUCTION_CREDENTIALS / PRODUCTION_ENABLEMENT = HOLD
P2_F = HOLD；P2_G = HOLD；RUNTIME_WIRING = NONE；STEP_3_RUNTIME_POLICY_WIRING = NOT_AUTHORIZED
SECOND_RUNTIME / SECOND_POLICY_ENGINE / SECOND_COST_LEDGER / SECOND_META_EVIDENCE_STORE = FORBIDDEN
L5_RELAXATION = FORBIDDEN（CUSTOMS_FILING 继续永久拒绝）
P2_E_V1_OPTION_A = PASS / CLOSED；SI_RSI_UNIFICATION_V1 = PASS / CLOSED；FINAL_ACCEPTANCE_HEAD = 0f7f7ac
```
