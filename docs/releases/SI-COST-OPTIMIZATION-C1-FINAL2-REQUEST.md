# SI-COST-OPTIMIZATION C1 —— FINAL-2 送审请求（CHANGE A / B 窄修）

- 分支：`gate/7-commercial-validation`；仓库 `anthonannabella-dev/crossclaim-ai`
- **REVIEWED_HEAD = `e6311195`**（C1 FINAL-2 实现提交）
- 前置：**MSG-20261005-31 = PASS WITH REVISE**（Necessity Gate / Cache Identity / Gateway 咽喉控制 = PASS；
  Cheap→Strong bounded escalation = REVISE；`C1_FINAL2_REQUIRED = YES`）
- 本轮范围仅两项：**A. strong escalation provenance** + **B. escalation hard-cap 2/1**；零 Schema / 零 PG 变更
- 耐久证据：`docs/releases/SI-COST-OPTIMIZATION-C1-EVIDENCE.md` §6

## 1. CHANGE A —— strong 授权来源不可由 caller 自报（已落地）

```text
删除：request.escalation 作为授权（字段仅为兼容保留；Router 忽略其 quality/state，caller 自报不构成凭证）
新增授权链（Gateway 内部、不可注入）：
  LOW_COST attempt（Gateway 自己产生）
    → schema validation
    → server-side deterministic quality evaluator（createRsiModelRouter({ qualityEvaluator })）
    → decideAiEscalation()（使用 Gateway 内部 per-task state）
    → strong（最多一次）
未配置 qualityEvaluator → 质量不可证 → 不升级（strong = 0）
provider 失败（无可用输出）→ 确定性 FAIL → 允许一次有界升级
触顶或 strong 已失败 → 同一 task 再调用直接返回 { called:false }，不再触达 provider（无递归 / 无 retry storm）
attempts 计入真实 provider attempt 数（cheap + strong 都计数）
```

## 2. CHANGE B —— 固定 2/1 上限不得被放大（已落地）

```text
AI_ESCALATION_HARD_CAPS = { maxAttempts: 2, maxEscalations: 1 }
clampAiEscalationLimits(requested) = min(requested, hardCap)（clamped=true 时如实报告）
AI_ESCALATION_BOUNDARY.hostMayRaiseHardCaps = false
```

## 3. FINAL-2 回归（裁决要求逐条）

| 要求 | 证据 |
| --- | --- |
| CALLER_FORGED_ESCALATION_CANNOT_CALL_STRONG | `C1_FINAL2_CALLER_FORGED_ESCALATION_CANNOT_CALL_STRONG`（caller 自报 FAIL 被忽略；evaluator PASS → strong = 0） |
| 没有 preceding LOW_COST attempt → strong = 0 | 同上（Router 不接受 caller escalation 作为授权，且 strong 只在 cheap attempt 之后才可能发生） |
| LOW_COST 输出未通过 server-side deterministic evaluation → strong = 0 | 同上（未配置 evaluator → 质量不可证 → 不升级） |
| LOW_COST + deterministic FAIL → strong = exactly 1 | `C1_ROUTER_STRONG_ONLY_VIA_BOUNDED_ESCALATION` ②（cheap 失败 → FAIL → strong = 1） |
| caller 自报 quality=FAIL 不构成授权 | `C1_FINAL2_CALLER_FORGED_ESCALATION_CANNOT_CALL_STRONG` |
| escalationLimits={999,999} → 仍 ≤ 2/1 | `C1_FINAL2_ESCALATION_LIMITS_CANNOT_BE_RAISED_BY_HOST`（clamp → {2,1}，clamped=true） |
| STRONG FAIL / 触顶 → 不再调用任何 provider | `C1_ROUTER_STRONG_ONLY_VIA_BOUNDED_ESCALATION` ③（`called=false`，strength 计数不变） |
| 原 C1 13 例继续全绿 / 全量 rsi-* 全绿 / tsc = 0 | 见 §4 |

## 4. 验证

```text
apps/api npx tsc --noEmit                                            → exit 0
C1 定向（6 文件：rsi-cost-c1 / rsi-cost-e2e / rsi-cost-ledger / rsi-cost-policy / rsi-model-router / rsi-local-sim-adapter）
                                                                     → 6 files / 48 tests PASS
rsi-* 全量回归（46 文件）                                             → 46 files / 250 tests PASS
prisma validate / migrate status                                     → valid / 79 migrations up to date（未改 Schema）
```

## 5. 请求裁决

1. CHANGE A（strong 授权 provenance 内部化 + caller 自报无效）与 CHANGE B（2/1 硬上限钳制）是否可记 **PASS**？
2. `C1 IMPLEMENTATION` 是否可记 **PASS / CLOSED**（`C1_FINAL3_REQUIRED = ?`）？
3. 若 PASS/CLOSED：是否确认进入 **C2 IMPLEMENTATION**（`AiCostLedgerEntry` append-only durable + `AiBudgetPolicy` durable +
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
