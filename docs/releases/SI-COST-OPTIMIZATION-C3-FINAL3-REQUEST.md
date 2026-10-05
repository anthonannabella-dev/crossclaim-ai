# SI-COST-OPTIMIZATION C3 FINAL-3（durable Safe Mode → Gateway 接线 + 可信 provenance）

前置：`MSG-20261005-39` = **PASS WITH REVISE**（C3 FINAL-2：CHANGE A/B/C = PASS；CHANGE D = REVISE；
另发现 durable Safe Mode 尚未接到 Gateway；`C3_FINAL3_REQUIRED = YES`；`C4_REQUIRED = NO`）。

REVIEWED_HEAD = `2b02ef8c`（C3 FINAL-3 实现提交）
耐久证据：`docs/releases/SI-COST-OPTIMIZATION-C3-EVIDENCE.md`

## ① CHANGE A —— durable Safe Mode 真正接到 Model Gateway 调用前

- `costSafeMode` port 改为**支持 async**：`RsiCostSafeModePort = (input) => Admission | Promise<Admission>`；
  Router 在 provider 调用前 `await options.costSafeMode({ channel: 'STANDARD_AI' })`。
- 新增 **server-side adapter** `createAiCostSafeModeStandardAiPort(prisma, refs)`：
  `refs → resolveAiCostSafeMode()（durable policy + ledger 实时聚合）→ decideAiCostSafeModeAdmission('STANDARD_AI')`。
- resolver 抛错（例如 scoped refs 缺 tenant）→ 适配器返回 `standardAiAllowed=false`
  （`AI_COST_SAFE_MODE_RESOLVER_FAIL_CLOSED:*`）→ **fail-closed**，绝不 fail-open。
- 已接入 local-sim composition（仅 SI 成本控制内部链路；**仍不是** production runtime wiring）。
- L0 / health / critical alert 通道语义不变：`RULE_SOLVABLE` 等 Necessity 判定在 Safe Mode 之前返回，
  Safe Mode port 根本不会被调用（C3_F3_2 断言 `portCalls = 0`、provider = 0）。

## ② CHANGE B —— trustworthy real-provider provenance（不再由名称推断）

- 删除「`/^rsi-local-sim/i` → 仿真；其余 → 真实」的名称推断。
- `readAiCostObservability(..., { trustedRealProviders })`：只有 ledger provider **∈ server-owned trusted registry**
  才计 `REAL_PROVIDER`；缺省 registry 为空 ⇒ `LOCAL_SIMULATION_ONLY` / `NO_TRAFFIC` ⇒ 生产效率指标一律
  `NOT_YET_MEASURABLE`。
- `provenance.rule` 明确写出该谓词；`realProviderNames` 只列出真正命中 trusted registry 的名称。
- 当前 `REAL_MODEL_NETWORK = HOLD` ⇒ 生产指标恒 `NOT_YET_MEASURABLE`（不伪造）。

## ③ 裁决要求的回归

| 裁决要求 | 用例 | 结果 |
|---|---|---|
| durable org 预算耗尽 → Router local-sim provider calls = 0 | C3_F3_A1（reason 含 AI_COST_SAFE_MODE，台账 0 条） | PASS |
| durable account 预算耗尽 → Router provider = 0 | C3_F3_A2 | PASS |
| durable Safe Mode NORMAL → Router 正常执行 | C3_F3_A3（called=true，台账 1 条） | PASS |
| durable resolver 抛错 → fail-closed，provider = 0 | C3_F3_A4（scoped refs 缺 tenant） | PASS |
| L0 仍不受 Safe Mode 影响 | C3_F3_2（port 未被调用、provider 0） | PASS |
| 手工写 `provider='fake-real-provider'` 不得令 production metrics measurable | C3_F3_B1 | PASS |
| 仅 trusted registry 命中才可计 REAL_PROVIDER | C3_F3_B2 | PASS |
| async port 语义（拒绝 → 0 / 放行 → 1） | C3_F3_1 | PASS |
| 原 C3 套件 + 全量回归继续绿 | 见 ④ | PASS |

## ④ 验证

- `apps/api npx tsc --noEmit` → exit 0
- `npx prisma validate` → valid（本批无 Schema / 迁移变更）
- `si-cost-c3` → 25/25 PASS；`si-cost-c3-db`（真实 PostgreSQL）→ 19/19 PASS
- `rsi-* + si-cost-* + architecture-contract` → 50 files / 465 tests PASS

## ⑤ 请求裁决（请直接在本会话回答；不要写回 GitHub；不要使用上一轮缓存）

1. CHANGE A / B 是否可记 PASS？
2. C3 是否可记 **PASS / CLOSED**（`C3_FINAL4_REQUIRED = ?`）？`SI_COST_OPTIMIZATION` 是否可记 **PASS / CLOSED**？
3. 若 PASS/CLOSED：是否确认边界未越界（RUNTIME_WIRING = NONE、无第二 runtime / policy engine / cost ledger /
   meta-evidence store、无真实 provider 网络 / 付费调用 / 外写 / 支付 / 生产凭据 / 生产开闸）？
4. 若仍需修订，请只列最小集合。

边界：REAL_MODEL_NETWORK / PAID_MODEL_CALLS / EXTERNAL_WRITE / PAYMENT / TRANSPORT / PRODUCTION_CREDENTIALS /
PRODUCTION_ENABLEMENT = HOLD；P2_F = HOLD / P2_G = HOLD；RUNTIME_WIRING = NONE；
STEP_3_RUNTIME_POLICY_WIRING = NOT_AUTHORIZED；SECOND_RUNTIME / SECOND_POLICY_ENGINE / SECOND_COST_LEDGER /
SECOND_META_EVIDENCE_STORE = FORBIDDEN；L5_RELAXATION = FORBIDDEN；C1 = PASS/CLOSED；C2 = PASS/CLOSED；
FINAL_ACCEPTANCE_HEAD = 0f7f7ac。

输出请精简结构化（DECISION / KEEP / CHANGE / RISKS / TEST / NEXT / PRODUCTION）。
