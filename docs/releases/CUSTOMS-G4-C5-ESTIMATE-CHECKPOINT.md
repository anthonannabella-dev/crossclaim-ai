# CUSTOMS G4 / C5 — Estimated Recoverable Amount CHECKPOINT

- 时间：2026-10-03T09:42:42.589Z（HEAD c4370ea；C1 `f7b85ee` / C2 `d8fd6c3` / C3 `6768952` / C4 `c4370ea`）
- 单元：G4 内部链第五环 **C5 = 估算可追回金额**（仅 ELIGIBLE；估算不可计费）
- 输入：C1 事实 + C4 资格判定 + C3 差异报告 + 估算政策（ratio / cap / min，逐币种）

## 1. 交付物

| 产物 | 路径 | 证据 |
|---|---|---|
| 估算模块 | `apps/api/src/services/customs/customs-recovery-estimate.ts` | `estimateCustomsRecovery` / `multiplyDecimalStrings` / `floorToCent` |
| 回归测试 | `apps/api/src/__tests__/customs-recovery-estimate.test.ts` | 14/14 PASS（C1–C5 = 67/67） |

## 2. 估算语义

- 仅 `ELIGIBLE` 产出金额；`NOT_ELIGIBLE` → `NOT_ESTIMATED`，`INDETERMINATE` → `INDETERMINATE`（不猜测）。
- 逐币种：`estimatedAmount = floor_cent(disputed × ratio)`，再取 `min(result, cap)`；低于 policy minimum → 归零并记 `BELOW_MIN_ESTIMATE`。
- **取整只向下**（cent 截断）：估算永远偏保守，不得向上放大。
- 缺 ratio / cap → `INDETERMINATE`（`RATIO_NOT_DEFINED_FOR_CURRENCY` / `CAP_NOT_DEFINED_FOR_CURRENCY`）；无 AMOUNT_MISMATCH → `NO_DISPUTED_AMOUNT`。

## 3. 计费红线一致性（SUCCESS-FEE-BILLING-REDLINE）

- `estimateOnly=true` / `finalAmountDerived=false` / `billable=false` / `feeDerived=false`：估算**不是** recovered truth，**不得**作为账单基数。
- 估算不产生 `FeeCalculation` / `BillingInvoice` / payment intent；不扣款；无客户提交。
- 无 FX 换算、无跨币种合并、无 filing、无 payment、无生产凭据。

## 4. 下一单元

- **C6 Claim-Ready Package**：把事实 / 真值 / 差异 / 资格 / 估算装配为**确定性可提交包**（不提交、不对外动作）。
- 之后 C7 handoff 边界（broker / customer-self 交接语义，真实提交 HOLD_EXTERNAL）；C1–C6 持久化需先送 **Schema Delta** 审计。
