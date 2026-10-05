# Recovery SI Phase 1 —— 实现与验收证据

- 时间：2026-10-05T04:15:36.902Z；分支 `gate/7-commercial-validation`；授权：HOST《CrossClaim Recovery SI Control Layer》
- 复用审计：`docs/releases/RECOVERY-SI-REUSE-MATRIX.md`；架构：`docs/releases/RECOVERY-SI-ARCHITECTURE.md`

## 1. 实现文件（RECOVERY_SI_IMPLEMENTED_FILES）

| 文件 | 职责 |
| --- | --- |
| `apps/api/src/services/intelligence/customer-recovery-state.ts` | 统一只读客户恢复状态（tenant-scoped、金额必须来自持久化事实、带 observedAt） |
| `apps/api/src/services/intelligence/recovery-tool-registry.ts` | 受控工具注册表（未登记 fail-closed、执行类名字禁止登记、输出禁 secret 字段） |
| `apps/api/src/services/intelligence/recovery-prioritizer.ts` | 确定性优先级（EV = 金额 − 供应商成本 − 运营成本 − 风险罚金；多币种不硬加） |
| `apps/api/src/services/intelligence/recovery-planner.ts` | 结构化 Recovery Plan（Phase 1 动作集合不含 REAL_SUBMIT；executionMode=SIMULATED） |
| `apps/api/src/services/intelligence/recovery-verifier.ts` | Plan 校验（陈旧/引用/租户/金额来源/工具登记/证据授权一致性，全部 fail-closed） |
| `apps/api/src/services/intelligence/recovery-policy.ts` | 策略薄适配 → `rsi-policy-engine`（**不放宽 L5**，不复制策略表） |
| `apps/api/src/services/intelligence/recovery-supervisor.ts` | 编排出口（state → registry → prioritizer → planner → verifier → policy） |

## 2. 测试（RECOVERY_SI_TEST_RESULTS）

- `apps/api/src/__tests__/recovery-si.test.ts` —— **11/11 PASS**：
  tenant isolation、金额来源不可信则丢弃、未登记工具拒绝、执行类工具名禁止登记、缺 tenant 上下文拒绝、
  工具输出含 secret 拒绝、优先级确定性、多币种不硬加、缺证据/缺授权分流、陈旧 snapshot 拒绝、
  不存在引用被拒、L5 动作拒绝、plan 动作策略。
- `apps/api/src/__tests__/recovery-si-e2e.test.ts` —— **5/5 PASS**（跨域 E2E 见 §3）。
- `npx tsc --noEmit` exit 0。

## 3. 跨域 E2E（RECOVERY_SI_E2E_RESULT = PASS）

模拟客户（同 org）：Carrier 680 USD（证据完整）· Amazon 3200 USD（证据完整）· Customs 18500 USD（缺授权）·
Independent Site 1300 USD（证据不完整）。输出：

| 域 | 计划动作 |
| --- | --- |
| Carrier | `PREPARE_PACKAGE` → `READY_FOR_EXECUTION` |
| Amazon (PLATFORM) | `PREPARE_PACKAGE` → `READY_FOR_EXECUTION` |
| Customs | `REQUEST_AUTHORIZATION` |
| Independent Site | `REQUEST_EVIDENCE` |

并验证：
- **零外写不变量**：registry 调用计数 = 0（Phase 1 不执行任何工具）；所有 action `executionMode = SIMULATED`；
  `boundaries` 全 false（externalWrite / payment / productionCredentials / realClaimSubmit / customsFiled / canonicalFactMutated / executionAuthorized）。
- **确定性**：同一 snapshot 重跑 → 计划与决策**完全相等**。
- **陈旧 snapshot**：超窗口 → `halted = STALE_SNAPSHOT` 且零决策。
- **Action Guard 契约**：`READY_FOR_EXECUTION` 显式带 `action.guard` + `hitl.or.owner.gate` 前置与 `SIMULATED_ONLY` 标记。

## 4. 最终状态（逐项）

```
RECOVERY_SI_REUSE_AUDIT        = DONE（RECOVERY-SI-REUSE-MATRIX.md）
RECOVERY_SI_ARCHITECTURE       = DONE（RECOVERY-SI-ARCHITECTURE.md）
RECOVERY_SI_IMPLEMENTED_FILES  = 7 个模块（见 §1）
RECOVERY_SI_TEST_RESULTS       = 16/16 PASS（11 unit + 5 E2E）+ tsc exit 0
RECOVERY_SI_E2E_RESULT         = PASS（四域统一状态 → 确定性计划）
RECOVERY_SI_EXTERNAL_WRITE     = FALSE
RECOVERY_SI_PAYMENT            = FALSE
RECOVERY_SI_PRODUCTION_CREDENTIALS = FALSE
RECOVERY_SI_REAL_CLAIM_SUBMIT  = FALSE
RECOVERY_SI_CUSTOMS_FILING     = FALSE
SCHEMA_DELTA_REQUIRED          = NO（RecoveryPlan 为纯结构；如需持久化再单独送 Schema Delta 审计）
```

## 5. 未做的事（诚实边界）

- 未接任何真实 provider；未开启 External Write / Payment / Transport / 生产凭据；
- 未把 SI 接进 `rsi:run` 运行时循环（Phase 1 只交付**纯函数 + 只读聚合**，避免第二套 Runtime）；
- 未新增数据库表；
- 未使用 LLM 参与金额或最终账务计算（优先级为确定性公式）。
