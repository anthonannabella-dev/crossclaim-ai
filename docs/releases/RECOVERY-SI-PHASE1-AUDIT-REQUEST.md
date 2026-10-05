# Recovery SI Phase 1 —— 架构审计请求（Audit Pack）

- 请求时间：2026-10-05T04:16:05.007Z；**REVIEWED_HEAD = `97dfb387`**（branch `gate/7-commercial-validation`）
- 耐久记录：本文件（本机 gh token 失效，audit 通道 = 仓库文件 + 右侧 ChatGPT 会话）
- 授权来源：HOST《CrossClaim Recovery SI Control Layer》；复用审计 `docs/releases/RECOVERY-SI-REUSE-MATRIX.md`；
  架构 `docs/releases/RECOVERY-SI-ARCHITECTURE.md`；证据 `docs/releases/RECOVERY-SI-PHASE1-EVIDENCE.md`

## 1. scope（Phase 1 交付物）

`apps/api/src/services/intelligence/` 七个模块（纯函数 + 只读聚合，**未接运行时**）：

| 模块 | 职责 |
| --- | --- |
| `customer-recovery-state.ts` | 统一只读客户状态（tenant-scoped、金额必须来自持久化事实、带 observedAt） |
| `recovery-tool-registry.ts` | 显式工具注册表（READ/PLAN/PREPARE 三级；未登记 fail-closed；执行类名字禁止登记） |
| `recovery-prioritizer.ts` | 确定性 EV 排序（金额 − 供应商成本 − 运营成本 − 风险罚金；多币种不硬加） |
| `recovery-planner.ts` | 结构化 Recovery Plan（Phase 1 动作集合不含 REAL_SUBMIT；executionMode=SIMULATED） |
| `recovery-verifier.ts` | Plan 校验（陈旧引用/租户/金额来源/工具登记/证据授权一致性，全 fail-closed） |
| `recovery-policy.ts` | 薄适配既有 `rsi-policy-engine`（**不复制策略表、不放宽 L5**） |
| `recovery-supervisor.ts` | 编排出口（state → registry → prioritizer → planner → verifier → policy） |

## 2. invariant（需要确认的不变量）

1. **不建第二套 Runtime**：Controller / Event Loop / Model Router / Judge / Cost Ledger / Evidence Ledger /
   Reconcile·Lease / Kill Switch / Policy Engine 全部复用现有实现（对照 `RECOVERY-SI-REUSE-MATRIX.md` 的 Forbidden Duplicate 清单）；
2. **零外写**：Phase 1 不调用任何工具执行路径（E2E 中断言 registry 调用计数 = 0）；所有 action `executionMode = SIMULATED`；
3. **L5 不放宽**：`EXTERNAL_WRITE / PAYMENT / TRANSPORT / PRODUCTION_CREDENTIALS / REAL_CLAIM_SUBMIT / CUSTOMS_FILING` 等请求
   一律由既有 `rsi-policy-engine` 判为 permanently forbidden（测试断言）；
4. **金额只来自持久化事实**：来源不明金额被丢弃并记录 `droppedMoneyRefs`，不用 LLM/估算补位；多币种不跨币种相加；
5. **确定性**：同一 snapshot + 同一 registry + 同一 nowMs → 计划与决策完全相等（测试断言）；
6. **fail-closed**：陈旧 snapshot → `halted = STALE_SNAPSHOT` 且零决策；引用不存在 → 该项被拒；跨租户 → `TENANT_MISMATCH`；
7. **READY_FOR_EXECUTION 只是决策标记**：显式带 `action.guard` + `hitl.or.owner.gate` 前置与 `SIMULATED_ONLY` 标记，
   真正执行仍必须经 Action Guard → Authorization/HITL/OWNER Gate → Deterministic Executor；
8. **无 Schema 变更**：RecoveryPlan 为纯结构（可序列化），Phase 1 未新增任何表。

## 3. tests

- `apps/api/src/__tests__/recovery-si.test.ts` 11/11 PASS（tenant isolation / 金额来源 / 工具注册表 / 优先级确定性 / 多币种 /
  缺证据缺授权分流 / 陈旧拒绝 / 不存在引用拒绝 / L5 拒绝 / plan 策略）；
- `apps/api/src/__tests__/recovery-si-e2e.test.ts` 5/5 PASS（四域跨域计划、零外写不变量、确定性重跑、陈旧 fail-closed、Action Guard 契约）；
- `npx tsc --noEmit` exit 0；门禁 `api-contract` / `audit-coverage` / `autopilot-rules` 全 OK。

## 4. schema delta

**NONE**（`SCHEMA_DELTA_REQUIRED = NO`）。若未来确认需要持久化 `RecoveryPlan / RecoveryDecision / DecisionEvidence`，
将单独提交 Schema Delta 审计，不夹带。

## 5. requested verdict

1. Recovery SI Phase 1 是否可记 **CLOSED**（`RECOVERY_SI_PHASE1 = CLOSED`）？
2. 是否同意「Phase 1 不接运行时、不做真实 Tool 执行」的边界，且 Phase 2（只读 Tool 实接 / Outcome Signal → RSI）需另行批准？
3. 是否同意 `SCHEMA_DELTA_REQUIRED = NO`？
4. 若仍需补证据，请只列**最小集合**。

## 6. 边界声明（不变）

```
EXTERNAL_WRITE = HOLD      PAYMENT = HOLD
TRANSPORT = HOLD           PRODUCTION_CREDENTIALS = HOLD
REAL_CLAIM_SUBMIT = HOLD   CUSTOMS_FILING = HOLD
FINAL_ACCEPTANCE_HEAD = 0f7f7ac
```
