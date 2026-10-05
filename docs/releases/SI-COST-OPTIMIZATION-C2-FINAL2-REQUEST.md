# SI-COST-OPTIMIZATION C2 —— FINAL-2 送审请求（A/B/C 三项窄修）

- 分支：`gate/7-commercial-validation`；仓库 `anthonannabella-dev/crossclaim-ai`
- **REVIEWED_HEAD = 1448f9db**（C2 FINAL-2 实现提交）
- 前置：**MSG-20261005-34 = PASS WITH REVISE**（主体设计 PASS；预算 Guard 三项窄修；`C2_FINAL2_REQUIRED = YES`；C3 暂不授权）
- 范围严格 = A 作用域正确用量 + B canonical 层级锁 + C guarded 不变量/幂等；零模型网络、零运行时接线

## 1. CHANGE A —— 用量按**每个 policy 自己的作用域**聚合

```text
逐 policy 校验（不再用最窄 scopeWhere）：
  PLATFORM     → 全平台 usage
  ORGANIZATION → organization usage
  ACCOUNT      → account usage
  INCIDENT     → incident usage
  TASK         → task usage
每层分别校验 daily / monthly / perIncident / strongCall / token；
任一 policy 超限即拒绝（reason：AI_BUDGET_DAILY_EXCEEDED / MONTHLY / INCIDENT / STRONG_CALL / TOKEN）。
```

## 2. CHANGE B —— canonical 层级 advisory locks（删除 caller scopeKey）

```text
runGuardedAiCostWrite() 不再接受 scopeKey；锁身份由 store 内部按 refs 派生并在**固定顺序**获取：
  platform:* → org:<id> → account:<id> → incident:<id> → task:<id>
（固定顺序防死锁；不同 incident 在共享 org 锁上串行；不同 org 在有 platform 预算时于 platform 锁上串行）
```

## 3. CHANGE C —— guarded write 不变量 + 幂等

```text
service 层：estimatedCostMicros / inputTokens / outputTokens 必须 integer ≥ 0；attemptNo 正整数；budget limits integer ≥ 0
DB 层（迁移 20261005080000_si_cost_c2_final2_checks）：
  AiCostLedgerEntry：costMicros/inputTokens/outputTokens/latencyMs ≥ 0、attemptNo > 0
  AiBudgetPolicy：六个 limit 均 NULL 或 ≥ 0
幂等优先：事务内先查 callId → 存在则校验不可变身份（org/incident/task/account/taskType/executionLevel）一致 →
  duplicate=true、零新增成本；身份不一致 → AI_COST_LEDGER_CALL_ID_IDENTITY_CONFLICT（fail-closed）
```

## 4. 边界标注（裁决要求显式化）

```text
CONCURRENCY_LIMIT_ENFORCEMENT = NOT_YET_WIRED（配置可存；并发上限执行留 C3）
TOKEN_LIMIT = ENFORCED（按 policy scope 聚合 input+output tokens）
escalatedToStrong 不得作为真实 strong 调用次数/成本事实源；真实 usage 只来自 durable ledger
```

## 5. 裁决要求 10 条 PG 回归（C2 套件 10 → 18 例，全 PASS）

| 要求 | 证据 |
| --- | --- |
| org limit 5000：inc-a 3000 后 inc-b 3000 → 拒绝 | `C2F2_A1` |
| platform limit：org-A + org-B 并发合计不突破 | `C2F2_A2` |
| account limit：不同 incident 共享 account usage | `C2F2_A3` |
| 删除 caller scopeKey 后不可绕开锁 | `C2F2_B1`（API 无 scopeKey 参数；跨 incident 并发恰好 2 条） |
| 跨 incident 并发共享 org budget → 恰好允许数量 | `C2F2_B1`（4 并发 / 限额 2000 → 恰好 2 条） |
| `estimatedCostMicros=-1` → fail-closed / DB reject | `C2F2_C1`（service 抛错 + DB CHECK 拒绝裸 INSERT） |
| 预算已满后 duplicate callId 重放 → duplicate=true | `C2F2_C2` |
| strong-call limit 按其 policy scope 统计 | `C2F2_C3`（TASK scope strongCallLimit=1） |
| token limit 已 enforce（真实 PG 回归） | `C2F2_C4`（org tokenLimit=150） |
| 原 10 个 PG 用例 + 全量回归继续绿 | 原 `C2_DB1..DB10` 全绿；`rsi-* + architecture-contract + C2 = 48 文件 / 412 例 PASS` |

## 6. 验证

```text
prisma migrate deploy → 81 migrations（20261005080000_si_cost_c2_final2_checks 已应用）
apps/api npx tsc --noEmit → exit 0
si-cost-c2-db.test.ts → 18/18 PASS
rsi-* + architecture-contract + C2 → 48 files / 412 tests PASS
```

## 7. 请求裁决

1. CHANGE A / B / C 是否可记 **PASS**？
2. `C2 IMPLEMENTATION` 是否可记 **PASS / CLOSED**（`C2_FINAL3_REQUIRED = ?`）？
3. 若 PASS/CLOSED：是否授权进入 **C3 IMPLEMENTATION**（缓存运行时接线 + business-value cost policy + Cost Safe Mode +
   admin 只读可观测 + `NOT_YET_MEASURABLE` 指标）？
4. 若仍需修订，请只列最小集合。

请在本次会话中直接回答；不要尝试写回 GitHub。不要使用上一轮缓存。

## 8. 边界声明（本批未改动）

```text
REAL_MODEL_NETWORK / PAID_MODEL_CALLS = HOLD；EXTERNAL_WRITE / PAYMENT / TRANSPORT /
PRODUCTION_CREDENTIALS / PRODUCTION_ENABLEMENT = HOLD；P2_F = HOLD；P2_G = HOLD
RUNTIME_WIRING = NONE；STEP_3_RUNTIME_POLICY_WIRING = NOT_AUTHORIZED
SECOND_RUNTIME / SECOND_POLICY_ENGINE / SECOND_COST_LEDGER / SECOND_META_EVIDENCE_STORE = FORBIDDEN
L5_RELAXATION = FORBIDDEN；P2_E_V1_OPTION_A = PASS/CLOSED；SI_RSI_UNIFICATION_V1 = PASS/CLOSED；C1 = PASS/CLOSED
FINAL_ACCEPTANCE_HEAD = 0f7f7ac
```
