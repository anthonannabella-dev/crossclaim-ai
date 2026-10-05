# RECOVERY SI — 最小架构设计（Phase 1）

- 生成：2026-10-05T04:11:58.523Z；配套复用审计：`docs/releases/RECOVERY-SI-REUSE-MATRIX.md`
- 位置：`apps/api/src/services/intelligence/`（独立职责，不塞进 `rsi-*` 巨型模块）

## 1. 目标链路（Phase 1 = 只读/规划，不外写）

```
OBSERVE CUSTOMER STATE            customer-recovery-state.ts   （只读聚合，tenant-scoped，带 observedAt）
  → DISCOVER / SELECT TOOL        recovery-tool-registry.ts    （显式注册表；未登记 fail-closed）
  → ESTIMATE（复用现有）           carrier.estimate / customs.estimate（现有确定性服务）
  → PRIORITIZE                    recovery-prioritizer.ts      （确定性排序；多币种不硬加）
  → PLAN                          recovery-planner.ts          （结构化 Recovery Plan）
  → VERIFY READINESS              recovery-verifier.ts         （存在性/租户/事实/证据/授权/能力/陈旧性）
  → POLICY                        recovery-policy.ts           （薄适配 → rsi-policy-engine，不放宽 L5）
  → SUPERVISE                     recovery-supervisor.ts       （编排 + 决策原因 + 稳定输出）
  → HAND OFF（Phase 1 到这里停）   READY_FOR_EXECUTION（真正执行仍走 Action Guard → HITL/OWNER → Deterministic Executor）
```

## 2. 关键类型（Phase 1）

```ts
// 统一只读客户状态（tenant-scoped + observedAt 供陈旧性判定）
interface CustomerRecoveryState {
  organizationId: string;
  observedAt: string;                    // ISO；plan 引用它做 stale 判定
  accounts: AccountSlice[];              // platform / carrier / customs / independent-site
  opportunities: OpportunitySlice[];     // domain, recoverableAmount{amount,currency}, eligibility, evidenceCompleteness, deadline, authorizationReady
  capability: CapabilitySlice;           // 各 domain / provider 的能力与 HOLD 状态（只读）
}

// 受控工具（registry 内显式登记；schema 明确）
interface RecoveryTool<In, Out> {
  name: string;                          // 例：'opportunity.list' / 'customs.estimate'
  access: 'READ' | 'PLAN' | 'PREPARE';   // Phase 1 只允许这三类
  domain: 'PLATFORM' | 'CARRIER' | 'CUSTOMS' | 'INDEPENDENT_SITE' | 'SETTLEMENT' | 'PAYMENT' | 'CLAIM';
  invoke(input: In, ctx: { organizationId: string }): Promise<Out>;  // 必须自证 tenant scope
}

// 计划动作（Phase 1 允许的动作集合，REAL_SUBMIT 不在其中）
type RecoveryActionKind =
  | 'EXECUTE_READ_ONLY_CHECK' | 'PREPARE_PACKAGE' | 'REQUEST_EVIDENCE'
  | 'REQUEST_AUTHORIZATION' | 'REQUEST_OWNER_APPROVAL' | 'WAIT_PROVIDER'
  | 'FILE_MODE_FALLBACK' | 'HOLD' | 'READY_FOR_EXECUTION';

interface RecoveryPlanAction {
  domain: string; opportunityRef: string; objective: string; proposedAction: RecoveryActionKind;
  reasonCodes: readonly string[]; prerequisites: readonly string[]; missingEvidence: readonly string[];
  authorizationRequired: boolean; ownerApprovalRequired: boolean;
  expectedRecovery: { amount: number; currency: string } | null; confidence: 'LOW'|'MEDIUM'|'HIGH';
  executionMode: 'SIMULATED' | 'EXTERNAL_GATED'; toolRef: string | null; blockedReason: string | null;
}
```

## 3. 失败语义（全部 fail-closed）

| 情形 | 结果 |
| --- | --- |
| 工具未登记 / 未声明 | 拒绝执行该动作（`TOOL_NOT_REGISTERED`） |
| plan 引用的 opportunity/case 在 state 中不存在 | 该 action 置 `HOLD` + `REFERENCE_NOT_FOUND` |
| tenant 不匹配 | 整个 plan 拒绝（`TENANT_MISMATCH`） |
| 金额/币种不是来自持久化事实 | 丢弃该金额（`MONEY_NOT_FROM_FACT`），不得用 LLM 估算替代 |
| 多币种且无 FX source | **不相加**，按币种分组输出（`MULTI_CURRENCY_NO_FX`） |
| 证据缺失 / 授权缺失 | `REQUEST_EVIDENCE` / `REQUEST_AUTHORIZATION`（不猜、不代签） |
| snapshot 陈旧（`observedAt` 超出窗口） | 整个 plan 拒绝（`STALE_SNAPSHOT`） |
| L5 动作（外写/支付/报关/凭据…） | 由 `rsi-policy-engine` 直接拒绝（`PERMANENTLY_FORBIDDEN_FOR_RSI`），**不因 SI 放宽** |

## 4. 与 RSI 的关系

- 共享：Policy Engine、Model Router、Cost Ledger、Evidence Ledger、Action Guard、Kill Switch、Reconcile/Lease。
- 分工：RSI = 改进 CrossClaim 自身；Recovery SI = 决定客户资金追回动作。
- 未来：Recovery SI 的 Outcome（预计 vs 实际、失败原因、time-to-recovery…）可作为 RSI 的 Outcome Signal，
  但 RSI 只能「观察 → 分析 → 提议 → 沙箱验证 → Judge」，**不能因业务结果直接改生产权限**。

## 5. Schema 原则

Phase 1 **不加新表**：RecoveryPlan / DecisionEvidence 均为纯结构（可序列化 JSON），用于测试与瞬态执行；
若后续需要持久化，单独提交 Schema Delta 审计（`SCHEMA_DELTA_REQUIRED` 由那时判定）。
