# SI-COST-OPTIMIZATION C1 —— 实施证据（零 Schema 契约层）

> 授权：MSG-20261005-30（`C1 IMPLEMENTATION = AUTHORIZED`；3.1=A / 3.2=B / 3.3=A（存储入 C2）/ 3.4=A / 3.5=A）
> 性质：**零 Schema / 零迁移 / 零运行时网络**；只新增契约模块 + Model Gateway 唯一咽喉接线 + 测试
> 边界：`REAL_MODEL_NETWORK / PAID_MODEL_CALLS = HOLD`（仅本地仿真 adapter）；`EXTERNAL_WRITE / PAYMENT /
> TRANSPORT / PRODUCTION_CREDENTIALS / PRODUCTION_ENABLEMENT / P2_F / P2_G = HOLD`；`FINAL_ACCEPTANCE_HEAD = 0f7f7ac`

## 1. 产物

| 文件 | 角色 |
| --- | --- |
| `apps/api/src/services/autonomy/rsi-ai-necessity-gate.ts` | **新增**：AI Necessity Gate（`evaluateAiNecessity` / `validateAiDeterministicEvidence` / `AI_NECESSITY_BOUNDARY`） |
| `apps/api/src/services/autonomy/rsi-model-cache-identity.ts` | **新增**：Cache Identity Contract（`buildAiCacheKey` / `evaluateAiCacheLookup` / `AI_CACHE_IDENTITY_FIELDS` / `AI_CACHE_BOUNDARY`） |
| `apps/api/src/services/autonomy/rsi-model-escalation-policy.ts` | **新增**：Cheap→Strong 有界升级合同（`decideAiEscalation` / `assertJudgeCannotAuthorizeModelCall` / `AI_ESCALATION_DEFAULTS` / `AI_ESCALATION_BOUNDARY`） |
| `apps/api/src/services/autonomy/rsi-cost-policy.ts` | **修改**：`RsiModelCallRequest` 增加**必需** `necessity` 与可选 `escalation`（caller 能力声明不再构成权限） |
| `apps/api/src/services/autonomy/rsi-model-router.ts` | **修改**：Model Gateway 唯一咽喉接线（先过 Necessity Gate；LEVEL_2 被钳制为 LEVEL_1；strong 仅经有界升级合同） |
| `apps/api/src/__tests__/rsi-cost-c1.test.ts` | **新增**：C1 验收（13 例，覆盖 14 条 Acceptance） |
| `apps/api/src/__tests__/rsi-cost-e2e.test.ts`、`rsi-model-router.test.ts`、`rsi-local-sim-adapter.test.ts` | **修改**：请求夹具补齐确定性证据；升级路径改为「先 LOW_COST → quality → 有界升级」两段式 |

## 2. 三份契约（核心语义）

```text
AI Necessity Gate（唯一入口 = rsi-model-router）：
  RULE_SOLVABLE                 → MODEL_CALL_FORBIDDEN（reason = RULE_ENGINE，LEVEL_0_RULE，zero token）
  HIGH_CONFIDENCE               → MODEL_CALL_FORBIDDEN
  AMBIGUOUS / SEMANTIC_REQUIRED → LEVEL_1_ELIGIBLE（只允许 LEVEL_1；strong 由升级合同决定）
  UNKNOWN / 证据缺失或畸形       → FAIL_CLOSED（不自动升级昂贵模型）
  caller 仅声明 requiredCapability → 不构成权限（callerCapabilityIgnored = true，边界冻结 bypassAllowed = false）

Cache Identity（存储层入 C2）：
  key 字段 = taskType / promptDigest / inputDigest / ruleVersion / schemaVersion / capabilityTier / organizationId
  任一不一致 → 对应 MISS；tenant-scoped 不含 organizationId 或与条目不一致 → MISS_ORGANIZATION（禁止跨租户）
  过期 → MISS_STALE；高风险 + 过期 → MISS_HIGH_RISK_STALE_FORBIDDEN（STALE_FALLBACK = FORBIDDEN）
  非 append-only（可丢弃派生数据，C2 受控 TTL/GC）；key/内容不可原地改写

Cheap → Strong（有界）：
  LOW_COST → schema validation → deterministic evaluator → quality threshold
    PASS → STOP_PASS（绝不调用 strong；cheapPassCallsStrong = false）
    FAIL / LOW_CONFIDENCE → 仅当 attempts < maxAttempts 且 escalations < maxEscalations → 一次 ESCALATE_TO_STRONG
    触顶 → STOP_BOUNDED；STRONG 仍未通过 → STOP_FAILED（无递归）
  judgeAuthorizedMoreCalls → 被忽略（JUDGE_AUTHORIZATION_IGNORED；judgeMayAuthorizeModelCall = false）
  默认上限：maxAttempts = 2 / maxEscalations = 1
```

## 3. 验收映射（HOST C1 ACCEPTANCE 14 条）

| 要求 | 证据（`rsi-cost-c1.test.ts`） |
| --- | --- |
| RULE_SOLVABLE 无 provider call | `C1_NECESSITY_RULE_SOLVABLE_FORBIDS_MODEL_CALL` + `C1_ROUTER_RULE_SOLVABLE_AND_UNKNOWN_NEVER_CALL_PROVIDER`（low/strong 计数均为 0） |
| HIGH_CONFIDENCE 无 provider call | `C1_NECESSITY_HIGH_CONFIDENCE_FORBIDS_MODEL_CALL` + router 级同例 |
| UNKNOWN fail-closed | `C1_NECESSITY_UNKNOWN_AND_MISSING_EVIDENCE_FAIL_CLOSED` + router 级（`called = false`） |
| caller bypass blocked | `C1_NECESSITY_CALLER_DECLARED_CAPABILITY_GRANTS_NOTHING`（声明 COMPLEX_CODE_FIX + 无证据 → FAIL_CLOSED） |
| organization mismatch cache MISS | `C1_CACHE_NEVER_CROSSES_TENANTS_AND_STALE_IS_MISS`（org-A 请求 vs org-B 条目 → MISS_ORGANIZATION） |
| stale cache MISS | 同上（→ MISS_STALE） |
| ruleVersion mismatch MISS | `C1_CACHE_HIT_ONLY_WHEN_IDENTICAL_AND_MISS_ON_EACH_MISMATCH`（+ schema/input/prompt/task/capability） |
| high-risk stale fallback forbidden | 同上（highRisk → MISS_HIGH_RISK_STALE_FORBIDDEN；`staleHighRiskFallback = FORBIDDEN`） |
| cheap PASS 不调用 strong | `C1_ESCALATION_PASS_NEVER_CALLS_STRONG` + `C1_ROUTER_STRONG_ONLY_VIA_BOUNDED_ESCALATION`（PASS 分支 strong.n = 0） |
| cheap quality FAIL 最多一次受控 escalation | `C1_ESCALATION_FAIL_ALLOWS_EXACTLY_ONE_BOUNDED_STRONG_CALL` + router 级（escalations=1 时不再调用 strong） |
| maxAttempt / maxEscalation 生效 | 同上（STOP_BOUNDED：AI_ESCALATION_MAX_ATTEMPTS / AI_ESCALATION_MAX_ESCALATIONS） |
| no recursive model loop | `C1_ESCALATION_NO_RECURSION_AND_JUDGE_CANNOT_AUTHORIZE`（STRONG FAIL → STOP_FAILED）+ router 级触顶分支 |
| existing RSI cost tests regression green | 全量 `rsi-*` 回归：**46 文件 / 248 例 PASS**（含 cost-policy / cost-ledger / cost-e2e / model-router / local-sim / judge / no-autopass） |
| tsc = 0 | `apps/api npx tsc --noEmit` → exit 0 |

## 4. 命令与结果（本机实测）

```text
apps/api npx tsc --noEmit                                   → exit 0
rsi-cost-c1 + rsi-cost-e2e + rsi-model-router + rsi-local-sim-adapter → 4 files / 38 tests PASS
rsi-* 全量回归（46 文件，含上述）                              → 46 files / 248 tests PASS
prisma validate / migrate status                             → valid / 79 migrations up to date（本批**未改 Schema**）
```

## 5. 边界（本批未动）

```text
REAL_MODEL_NETWORK / PAID_MODEL_CALLS = HOLD（仅本地仿真 adapter；零外部模型支出）
EXTERNAL_WRITE / PAYMENT / TRANSPORT / PRODUCTION_CREDENTIALS / PRODUCTION_ENABLEMENT = HOLD
P2_F = HOLD；P2_G = HOLD；RUNTIME_WIRING = NONE；STEP_3_RUNTIME_POLICY_WIRING = NOT_AUTHORIZED
无 credential / raw prompt / raw provider response / 客户敏感 payload 持久化（本批零持久化）
C2（AiCostLedgerEntry + AiBudgetPolicy + AiModelCacheEntry + PG enforcement）与 C3（policy + observability）尚未开始
```
