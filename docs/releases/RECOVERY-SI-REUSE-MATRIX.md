# RECOVERY-SI-REUSE-MATRIX（Recovery SI Control Layer · Phase 1）

- 生成：2026-10-05T04:11:45.358Z；分支 `gate/7-commercial-validation`；授权来源：HOST《CrossClaim Recovery SI Control Layer》
- 结论先行：Recovery SI **不新建第二套 Intelligence Runtime**；它复用现有 RSI 基础设施 + 既有确定性业务服务，
  只在 `apps/api/src/services/intelligence/` 新增「客户资金追回决策」所需的**只读聚合 + 规划 + 校验**层。

## 1. 复用清单（Existing / Reuse）

| 能力 | 现有实现（复用，不重写） | 用法 |
| --- | --- | --- |
| 权限分级 / L5 永久禁区 | `services/autonomy/rsi-policy-engine.ts` | Recovery SI 的每个动作先过 `decideRsiPolicyAction`（**不放宽 L5**） |
| 模型路由 / 预算熔断 / 台账 | `rsi-model-router.ts` · `rsi-model-provider-composition.ts` · `rsi-cost-policy.ts` · `rsi-cost-ledger.ts` | 如 SI 需要 LLM，只通过既有 Router（当前真实模型网络仍 HOLD） |
| 证据账本 / 证据校验 | `rsi-evidence-ledger.ts` · `runtime/rsi-evidence-verifier.ts` | SI 的决策证据沿用 append-only 语义 |
| Builder/Judge 隔离 | `rsi-judge-orchestration.ts` | 决策质量提升（非本阶段必需） |
| 事件循环 / 续跑 / 任务生成 | `runtime/rsi-event-loop.ts` · `rsi-continuation-engine.ts` · `rsi-task-generator.ts` | SI 不建第二套调度 |
| 重启 reconcile / lease | `runtime/rsi-restart-reconcile.ts` | SI 不建第二套 |
| Kill Switch | `rsi-runtime-config.ts`（`RSI_PAUSED`）· `action-guard/kill-switch-adapter.ts` | SI 复用同一开关 |
| Action Guard / HITL / OWNER 审批 | `services/action-guard/*`（`action-guard.ts` · `approval-verifier.ts` · `hitl-submission.ts` · `runtime-guard.ts`） | SI 只产出 `READY_FOR_EXECUTION`，执行仍走 Guard |
| Canonical Fact 真值 | `services/canonical/*`（`derive.ts` · `parity.ts` · `shadow.ts`） | 只读引用，**不得改写** |
| Money 真值视图 | `workflow/recovery-money-view.ts` | 只读引用，**不重算金额** |
| Opportunity 读取 | `workflow/opportunity-list.ts` · `opportunity-review.ts` · `opportunity-insight.ts` | `opportunity.list` / `opportunity.inspect` |
| Recovery 复核状态 | `workflow/recovery-review.ts` · `workflow/recovery-states.ts` · `workflow/recovery-outcome.ts` | `recovery.review.status` |
| Claim 准备 | `claims/claim-preparation.ts` · `claims/claim-submission.ts` · `workflow/claim-package-view.ts` | `claim.prepare`（PREPARE 类，不外写） |
| Evidence 读取 | `services/evidence/evidence-read.ts` · `account-scope.ts` · `promotion.ts` | `evidence.inspect` |
| Carrier 资格/估算/证据包 | `carriers/carrier-sla-eligibility.ts` · `carrier-recovery-estimate.ts` · `carrier-evidence-bundle.ts` · `carrier-claim-package.ts` | `carrier.eligibility` / `carrier.estimate` |
| Customs 资格/估算/授权/证据包 | `customs/customs-recovery-eligibility.ts` · `customs-recovery-estimate.ts` · `customs-authorization-readiness.ts` · `customs-claim-ready-package.ts` · `customs-recovery-chain-service.ts` | `customs.*` |
| Independent-site / 拒付 | `independent-site/chargeback-recovery-flow.ts` · `ps04-state-read.ts` | `independent_site.inspect` |
| Settlement 只读对账 | `settlement/carrier-settlement-reconciliation-readonly.ts` | `settlement.inspect` |
| Payment 只读 | `workflow/payment*.ts` · `payments/*` · `payment-activation-readiness` | `payment.inspect` |
| 平台写账本（只读） | `platform-write/ledger.ts` · `response-contract.ts` | 仅供 `payment.inspect` 之类只读引用 |

## 2. 需要适配（Adapter Needed）

| 适配 | 说明 |
| --- | --- |
| **Tool 包装层** | 把上述确定性服务包装为 `RecoveryTool`：显式名字、输入/输出 schema、tenant 校验、只读断言。现有服务**不改**。 |
| **跨域状态切片** | `customer-recovery-state.ts` 组合各域只读视图，输出统一的 tenant-scoped snapshot（含 `observedAt`）。 |
| **策略适配** | `recovery-policy.ts` 只做「动作 → 先问 `rsi-policy-engine`」的薄适配；**不复制** L0–L5 表。 |
| **证据适配** | `recovery-verifier.ts` 把「plan 引用是否真实」映射到既有 Evidence/Canonical/Action Guard 读取端口。 |

## 3. 新增（New，确有独立职责）

| 模块 | 职责 | 为什么不能塞进 rsi-* |
| --- | --- | --- |
| `intelligence/customer-recovery-state.ts` | 统一只读客户恢复状态聚合（tenant-scoped、带 `observedAt`） | RSI 面向系统自身，不持有客户域状态 |
| `intelligence/recovery-tool-registry.ts` | 显式工具注册表（未登记 fail-closed、禁任意函数名） | 现有仓库无工具注册表 |
| `intelligence/recovery-prioritizer.ts` | 确定性优先级（金额/证据/期限/成本/风险加权，多币种不硬加） | 现无 |
| `intelligence/recovery-planner.ts` | 结构化 Recovery Plan（domain/objective/action/reasonCodes/prereq/toolRef/执行模式） | 现无 |
| `intelligence/recovery-verifier.ts` | 对 plan 的每一项做存在性/租户/事实/证据/授权/能力/Guard/陈旧性校验 | RSI 的 verifier 面向 CI/测试证据，不是客户业务事实 |
| `intelligence/recovery-policy.ts` | SI 动作策略（在 `rsi-policy-engine` 之上，**只加不松**） | 保持 SI 与 RSI 的策略入口单一 |
| `intelligence/recovery-supervisor.ts` | 编排：state → registry → prioritizer → planner → verifier → policy，输出 plan + 决策原因 | RSI 的 continuation engine 面向系统任务，不面向客户追回 |

## 4. 明确禁止重复建设（Forbidden Duplicate）

```
第二套 Controller / Event Loop / Model Router / Judge / Cost Ledger / Evidence Ledger /
第二套 Reconcile·Lease / Kill Switch / Policy Engine
```

以上任何一项若在 Phase 1 被新建，即视为违反授权；本矩阵是 review 的对照表。

## 5. Phase 1 边界（不变）

```
EXTERNAL_WRITE = HOLD       PAYMENT = HOLD
TRANSPORT = HOLD            PRODUCTION_CREDENTIALS = HOLD
REAL_CLAIM_SUBMIT = HOLD    CUSTOMS_FILING = HOLD
COMMISSION_CAPTURE = HOLD   PRODUCTION_ENABLEMENT = HOLD
SCHEMA：Phase 1 不加新表（RecoveryPlan = 纯结构/瞬态/fixture）
```
