> **[HISTORICAL_SNAPSHOT]** 本文是历史审计 / 证据快照，原文保留不改写（历史裁决不删除）。
> 其中关于 `RUNTIME_WIRING` / `STEP_3_RUNTIME_POLICY_WIRING` / `RSI_OUTCOME_SINK_RUNTIME_WIRING`
> 的**当时状态**已被后续实现取代：SUPERSEDED_BY=c0b61792（STEP_3_RUNTIME_POLICY_WIRING：
> Recovery SI 作为 domain capability pack 接入 ONE CrossClaim SI Runtime；后续 FINAL-2..6 与 PHASE 2
> 见 ca23b1df / adcab905 / ca298187 / 5f9ce46f / 6e98e66e）。
> 唯一**现行**状态请以 `docs/releases/CURRENT-SI-RSI-STATUS.md` 为准
> （SUPERSEDED_BY=cdd95258 为该状态件的基线 HEAD）。

# SI-COST-OPTIMIZATION C1 —— FINAL-3 送审请求（状态正确性两项窄修）

- 分支：`gate/7-commercial-validation`；仓库 `anthonannabella-dev/crossclaim-ai`
- **REVIEWED_HEAD = `79536ca5`**（C1 FINAL-3 实现提交）
- 前置：**MSG-20261005-32 = PASS WITH REVISE**（CHANGE A provenance = PASS；CHANGE B hard cap 2/1 = PASS；
  剩 per-task identity 碰撞与 attempt 计数口径两个状态正确性缺口；`C1_FINAL3_REQUIRED = YES`）
- 本轮严格只做两项；零 Schema / 零 PG / 零真实网络；耐久证据：`docs/releases/SI-COST-OPTIMIZATION-C1-EVIDENCE.md` §7

## 1. CHANGE A —— taskState key 真正 per-task（已落地）

```text
AI-eligible 调用必须提供非空 taskId；缺失/空 → fail-closed（AI_ESCALATION_TASK_IDENTITY_REQUIRED）
内部 key = incidentId::taskId::taskType::promptDigest（不再存在 '-::-" 之类的共享 fallback bucket）
→ 不同任务不再共享 attempts / escalations / strongFailed
```

## 2. CHANGE B —— attempts 只统计真实 provider attempt（已落地）

```text
cheap：!guardRejected && attempt !== null && called === true 才 attempts += 1
strong：只有真实 provider invocation 才 attempts += 1 且 escalations += 1（失败才置 strongFailed）
budget guard 拒绝不计 attempt / escalation（拒绝单独记录，不伪装成 provider attempt）
```

## 3. FINAL-3 回归（裁决要求逐条）

| 要求 | 证据 |
| --- | --- |
| NULL_OR_MISSING_TASK_ID_CANNOT_SHARE_ESCALATION_STATE | `C1_FINAL3_TASK_IDENTITY_REQUIRED_AND_NOT_SHARED` ①（taskId=null → 两次均 fail-closed，provider = 0） |
| 两个不同任务不得共享 strongFailed | 同上 ②（task-A 被阻断、task-B 仍升级一次） |
| LOW_COST budget guard reject → provider calls = 0 且 attempts 不增加 | `C1_FINAL3_ATTEMPTS_COUNT_ONLY_REAL_PROVIDER_ATTEMPTS` ①（未消耗 attempts：随后同 task 仍 cheap→strong 各 1 次） |
| STRONG budget guard reject → strong provider calls = 0 且 strong attempt 不增加 | 同上 ②（strong provider 0 次；后续调用不被 MAX_ESCALATIONS / STOP_FAILED 误阻断） |
| strong 未实际调用 → escalation count 不增加 | 同上 ② |
| 999/999 仍 clamp 2/1 | `C1_FINAL2_ESCALATION_LIMITS_CANNOT_BE_RAISED_BY_HOST` |
| forged caller escalation 仍 strong=0 | `C1_FINAL2_CALLER_FORGED_ESCALATION_CANNOT_CALL_STRONG` |
| C1 全量 + rsi-* + tsc 全绿 | §4 |

## 4. 验证

```text
apps/api npx tsc --noEmit        → exit 0
C1 定向（6 文件）                 → 6 files / 50 tests PASS
rsi-* 全量回归（46 文件）         → 46 files / 252 tests PASS
prisma validate / migrate status → valid / 79 migrations up to date（未改 Schema）
```

## 5. 请求裁决

1. CHANGE A（per-task identity 不可碰撞）与 CHANGE B（真实 attempt 计数）是否可记 **PASS**？
2. `C1 IMPLEMENTATION` 是否可记 **PASS / CLOSED**（`C1_FINAL4_REQUIRED = ?`）？
3. 若 PASS/CLOSED：是否立即授权 **C2 IMPLEMENTATION**（`AiCostLedgerEntry` append-only durable + `AiBudgetPolicy` durable +
   usage 仅由 ledger 聚合 + `AiModelCacheEntry` + tenant/append-only 清单同步 + 真实 PostgreSQL 回归 + Budget race 防线）？
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
