# SI-COST-OPTIMIZATION —— HOST 指令登记（QUEUED，依赖 SI_RSI_UNIFICATION_PASS_CLOSED）

> 状态：**REGISTERED / QUEUED**（仅登记，不实现；不得打断正在进行的 `si-rsi-unification-design`）
> Priority = **P1**；Dependency = **SI_RSI_UNIFICATION_PASS_CLOSED**
> 登记时间：2026-10-05（HOST ADDENDUM — CROSSCLAIM SI COST / TOKEN OPTIMIZATION）
> 边界：本任务不授权 `REAL_MODEL_NETWORK` / `PAID_MODEL_CALLS` / `EXTERNAL_WRITE` / `PAYMENT` /
> `PRODUCTION_CREDENTIALS` / `P2-G Real Execution`；这些继续保持原有 Gate / HOLD。

## 0. 执行顺序（HOST 明确）

```text
1. 先完成 RSI + Recovery SI → ONE "CrossClaim SI Runtime"
2. 完成 Architecture Audit / REVISE 闭环
3. 统一 Runtime 稳定后，再执行本任务（SI-COST-OPTIMIZATION）
```

## 1. 总原则

CrossClaim SI 必须继续坚持：**DETERMINISTIC FIRST → AI ONLY WHEN NEEDED**

```text
默认 LEVEL_0_RULE = no model / zero token
只有确定性程序无法可靠解决时 → LEVEL_1_LOW_COST
再只有质量 Gate 未通过或任务复杂度确实需要 → LEVEL_2_STRONG

禁止为了“更智能”而把普通 SQL / rule / state-machine / validation / reconciliation 工作迁移给 LLM。
```

## 2. OPT-1 —— Durable Cost Ledger

当前 RSI Cost Ledger 不得长期只依赖 process memory。统一 SI Runtime 后增加 durable cost accounting。

至少记录：`callId` / `incidentId` / `taskId` / `organizationId`（如调用属于客户业务）/ `accountId`（如适用）/
`provider` / `model` / `executionLevel` / `taskType` / `inputTokens` / `outputTokens` / `estimated`·`actual cost` /
`latency` / `result` / `retry`·`attempt identity` / `createdAt`。

要求：append-only；**no raw prompt**；**no raw model response**；**no credential**；**no customer sensitive payload**；
tenant isolation；idempotent call identity；**服务重启后预算统计不得归零**。

## 3. OPT-2 —— Hierarchical Budget

不要只保留平台全局预算。至少四级：`PLATFORM → ORGANIZATION → ACCOUNT（适用时）→ INCIDENT / TASK`。
防止一个大客户或异常任务吃掉整个平台 AI 预算。需支持：`daily limit` / `monthly limit` / `per-incident limit` /
`strong-model-call limit` / `token limit` / `concurrency limit`。

任一级达到阈值 → **fail-safe / cost-safe degradation**；不得影响 `LEVEL_0_RULE`、健康检查与 critical alert。

## 4. OPT-3 —— Deterministic Model Cache

基于不可变输入身份增加模型结果缓存。cache key 至少绑定：`taskType` / `promptDigest` / `inputDigest` /
`ruleVersion` / `model|provider identity or capability tier` / `schemaVersion`；只有完全一致时允许复用。

禁止：跨 tenant 泄漏；不同 `ruleVersion` 复用；stale result 无期限复用；高风险决策直接依赖过期缓存。
缓存命中登记为 **`MODEL_CALL = SKIPPED`**，并记录 `savedTokens` / `savedCost`。

## 5. OPT-4 —— AI Necessity / Confidence Gate

不得仅由 caller 声明 `requiredCapabilities = ROOT_CAUSE_ANALYSIS` 就直接获得 LLM 调用权。
在 Model Router 前增加统一 **AI Necessity Gate**：

```text
deterministic result → confidence / ambiguity / missing-information evaluation → decide AI needed

RULE_SOLVABLE                → MODEL_CALL_FORBIDDEN
HIGH_CONFIDENCE              → MODEL_CALL_FORBIDDEN
AMBIGUOUS / SEMANTIC_REQUIRED→ LEVEL_1 eligible
COMPLEX / unresolved         → LEVEL_2 eligible
未知状态                      → fail-closed（不自动升级昂贵模型）
```

## 6. OPT-5 —— Cheap → Strong Quality Gate

“低价模型调用成功”不等于“结果质量合格”。升级路径统一为：

```text
LOW_COST MODEL → schema validation → deterministic evaluator → Judge / quality threshold
PASS  → 结束（不调用 strong model）
FAIL / LOW_CONFIDENCE → 预算允许时才升级：STRONG MODEL → evaluator → Judge
```

禁止因为 provider HTTP 200 就认为答案有效。

## 7. OPT-6 —— Business-value-aware Cost Policy

增加业务价值维度，不只看 token 单价。至少统计：`AI_COST_PER_OPPORTUNITY` / `AI_COST_PER_CASE` /
`AI_COST_PER_SUCCESSFUL_RECOVERY` / `AI_COST_PER_$1000_RECOVERED` / `MODEL_COST / RECOVERY_VALUE ratio`。

允许根据 estimated recovery value 调整 AI budget ceiling（低价值 Opportunity → 更严格禁止强模型；
高价值高置信案件 → 安全预算内可允许更强分析）。但 **estimated recovery value 不得由客户端自报**，
必须来自可信 canonical / recovery basis。

## 8. OPT-7 —— Admin Observability

统一 SI Admin 面板增加：`today cost` / `month cost` / `rule-resolved %` / `AI-called %` / `cache-hit %` /
low-cost·strong-model call count / tokens / cost by organization / cost by capability / cost by provider·model /
budget remaining / top cost incidents / cost-safe-mode status。**不得暴露客户敏感内容**。

## 9. Acceptance（完成时必须逐条证明）

```text
1  LEVEL_0 仍为默认
2  普通 rule-solvable 信号无法调用模型
3  durable ledger survives restart
4  tenant budget isolation
5  model cache identity 安全
6  stale cache fail-closed
7  cheap→strong 必须经过 quality gate
8  budget exhaustion 不形成无限 retry
9  strong model 不会被普通任务滥用
10 no credential / raw prompt / raw provider response persistence
11 Cost Safe Mode 正常
12 existing RSI / Recovery SI regression 全绿
```

最终输出真实指标：`RULE_RESOLVED_RATE` / `MODEL_INVOCATION_RATE` / `LOW_COST_MODEL_RATE` / `STRONG_MODEL_RATE` /
`CACHE_HIT_RATE` / `AVG_AI_COST_PER_CASE` / `AVG_AI_COST_PER_SUCCESSFUL_RECOVERY`。
**没有真实生产数据时标记 `NOT_YET_MEASURABLE`；禁止伪造“90% zero-token”之类指标。**

## 10. 边界（保持 HOLD）

```text
REAL_MODEL_NETWORK = HOLD
PAID_MODEL_CALLS = HOLD
EXTERNAL_WRITE = HOLD
PAYMENT = HOLD
PRODUCTION_CREDENTIALS = HOLD
P2_G_REAL_EXECUTION = HOLD
P2_F = HOLD
FINAL_ACCEPTANCE_HEAD = 0f7f7ac
```

登记后不启动实现；待 `SI_RSI_UNIFICATION_PASS_CLOSED` 后自动进入执行队列（P1）。
