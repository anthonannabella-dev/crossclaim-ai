# SI-COST-OPTIMIZATION —— 设计/实施边界送审请求（READY_FOR_DESIGN）

- 分支：`gate/7-commercial-validation`；仓库 `anthonannabella-dev/crossclaim-ai`
- 前置：`P2-E = PASS / CLOSED`（MSG-20261005-27）；`SI-RSI Unification = PASS / CLOSED`（MSG-20261005-29，U1–U8 全 PASS）
- 任务来源：HOST ADDENDUM（登记见 `docs/releases/SI-COST-OPTIMIZATION-REGISTRATION.md`，Priority = P1）
- 状态：`QUEUED → READY_FOR_DESIGN`（**不等于** `AUTO_IMPLEMENTATION_AUTHORIZED`）
- 本轮：**零代码、零 Schema、零迁移、零运行时接线**；只请求裁定边界与最小证据

## 1. 总原则（不可放宽）

```text
DETERMINISTIC FIRST → AI ONLY WHEN NEEDED
LEVEL_0_RULE（no model / zero token）为默认
只有确定性程序无法可靠解决 → LEVEL_1_LOW_COST
只有质量 Gate 未通过或任务确实复杂 → LEVEL_2_STRONG
禁止把 SQL / rule / state-machine / validation / reconciliation 工作迁移给 LLM
```

## 2. 分期（建议按可行性分批送审，避免一次性开大边界）

```text
C1（零 Schema 契约层）：OPT-4 AI Necessity Gate + OPT-3 cache identity 契约 + OPT-5 cheap→strong quality gate 契约
C2（Schema Delta 层）：OPT-1 durable cost ledger + OPT-2 hierarchical budget（含 restart 持久性）
C3（策略与可观测层）：OPT-6 business-value cost policy + OPT-7 admin observability（只读投影）
```

## 3. 待裁定分岔（请逐项选择）

### 3.1 C2 的成本账本存储（OPT-1）

- **Option A（建议）**：新增 append-only 表 `AiCostLedgerEntry`（+ tenant 触发器 + append-only 触发器 + 幂等调用身份唯一约束）。
  字段：`callId`（幂等身份）/ `incidentId` / `taskId` / `organizationId?` / `accountId?` / `provider` / `model` /
  `executionLevel` / `taskType` / `inputTokens` / `outputTokens` / `costMicros`（整数微单位，避免浮点）/ `latencyMs` /
  `result` / `attempt` / `createdAt`。**绝不落** raw prompt / raw response / credential / 客户敏感 payload。
- **Option B**：复用既有 `AuditLog`（零新表），以 action 白名单 + `changes` 承载同字段。
  代价：聚合查询弱、预算口径难强约束（需靠应用层）。

### 3.2 C2 的分级预算存储（OPT-2）

- **Option A**：专用表（`AiBudget` 限额 + `AiBudgetUsage` 周期用量）。
- **Option B（建议）**：**不建第二事实源**——预算用量从 `AiCostLedgerEntry` 聚合（日/月/incident 维度），
  仅用进程内短期缓存加速；到阈值即 fail-safe 降级。理由：与「单一成本核心」一致，避免账本/用量双写不一致。

### 3.3 C1 的模型缓存存储（OPT-3）

- **Option A（建议）**：新增 `AiModelCacheEntry`，cache key = `taskType + promptDigest + inputDigest + ruleVersion +
  modelIdentity/capabilityTier + schemaVersion`；租户相关任务额外含 `organizationId`（禁止跨租户复用）；
  强制 `ruleVersion` 一致 + TTL + 高风险决策禁止依赖过期缓存（stale → 视为 miss）。
- **Option B**：v1 仅交付 cache identity 契约（零存储，命中率必然为 0，指标标 `NOT_YET_MEASURABLE`）。

### 3.4 AI Necessity Gate 的强制点（OPT-4）

- **Option A（建议）**：放在统一 **Model Gateway** 入口（= `rsi-model-router` 的唯一调用咽喉），
  任何调用者（含未来 Recovery SI）都绕不过；`RULE_SOLVABLE` / `HIGH_CONFIDENCE` → `MODEL_CALL_FORBIDDEN`；
  未知状态 → fail-closed（不得自动升级昂贵模型）。
- **Option B**：放在各调用方（会形成多处判定，存在旁路风险）。**不建议**。

### 3.5 预算强制点（OPT-2 执行位置）

- **建议**：同样在 Model Gateway 咽喉处强制执行（单一 enforcement）；RSI runtime 只做只读投影展示，不另设判定。

## 4. 必须可证明的不变量（Acceptance 对应）

```text
1  LEVEL_0 仍为默认（rule-solvable 信号 → MODEL_CALL_FORBIDDEN）
2  level 升级必须经质量 Gate（schema validation → deterministic evaluator → Judge/quality threshold）
3  durable ledger survives restart（预算统计不归零）
4  tenant budget isolation（四级：PLATFORM → ORGANIZATION → ACCOUNT → INCIDENT/TASK）
5  cache identity 安全（跨租户不复用；ruleVersion 不一致不复用）
6  stale cache fail-closed（不得用于高风险决策）
7  budget exhaustion 不产生无限 retry（明确终止语义）
8  strong model 不被普通任务滥用（升级需 Gate + 预算双条件）
9  no credential / raw prompt / raw provider response / 客户敏感 payload 持久化
10 Cost Safe Mode 正常（降级不得影响 LEVEL_0_RULE / 健康检查 / critical alert）
11 指标无真实数据时标 NOT_YET_MEASURABLE（禁止伪造「90% zero-token」类指标）
12 existing RSI / Recovery SI regression 全绿
```

## 5. 请求裁决

1. 3.1 / 3.2 / 3.3 / 3.4 / 3.5 五项分岔分别选 A 还是 B？（Codex 建议：3.1=A、3.2=B、3.3=A、3.4=A、3.5=Model Gateway 咽喉）
2. 是否同意按 **C1 → C2 → C3** 分批实现与送审（每批独立 Implementation Audit），而不是一次性大边界？
3. C2 若涉及 Schema Delta：是否要求 `AiCostLedgerEntry` / `AiModelCacheEntry` 同批加入 tenant 触发器 +
   append-only 触发器 + `tools/tenant-triggers/*.json` 清单同步 + 真实 PG 回归（与既有惯例一致）？
4. `costMicros` 采用整数微单位（避免浮点误差）是否认可？
5. 是否确认：本任务**不授权** `REAL_MODEL_NETWORK` / `PAID_MODEL_CALLS`（v1 只允许本地仿真 adapter 与零外写），
   且 `P2_F = HOLD` / `P2_G = HOLD` 不因本任务改变？

请在本次会话中直接回答；不要尝试写回 GitHub。不要使用上一轮缓存。

## 6. 边界声明（本轮未改动）

```text
REAL_MODEL_NETWORK / PAID_MODEL_CALLS = HOLD（v1 仅本地仿真 adapter）
EXTERNAL_WRITE / PAYMENT / TRANSPORT / PRODUCTION_CREDENTIALS / PRODUCTION_ENABLEMENT = HOLD
P2_F = HOLD；P2_G = HOLD
RUNTIME_WIRING = NONE；STEP_3_RUNTIME_POLICY_WIRING = NOT_AUTHORIZED
SECOND_RUNTIME / SECOND_POLICY_ENGINE / SECOND_COST_LEDGER / SECOND_META_EVIDENCE_STORE = FORBIDDEN
L5_RELAXATION = FORBIDDEN（CUSTOMS_FILING 继续永久拒绝）
P2_E_V1_OPTION_A = PASS / CLOSED（边界 KEEP / DO NOT MODIFY）
SI_RSI_UNIFICATION_V1 = PASS / CLOSED（本任务不得引入第二运行时）
FINAL_ACCEPTANCE_HEAD = 0f7f7ac
```

## 7. 风险分级

```text
FOUNDATION_REUSED：既有 rsi-cost-ledger / rsi-cost-policy（单一成本核心）、rsi-model-router（单一模型网关）、
  rsi-policy-engine（L0–L5）、action-guard / control-plane / kill-switch、既有 tenant/append-only 触发器体系
NEW_RISK_BOUNDARY：首次引入「AI 调用前的必要性判定与预算强制」以及可能的 durable cost/model-cache Schema Delta
ARCH_REVIEW_REQUIRED：YES —— 幂等/事务边界、Schema Delta、以及「AI 调用权限」的安全边界变化
```
