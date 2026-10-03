# CUSTOMS G4 / C3 — Classification / Rate Discrepancy CHECKPOINT

- 时间：2026-10-03T09:38:46.383Z（HEAD d8fd6c3；C1 impl `f7b85ee` / C2 impl `d8fd6c3`）
- 单元：G4 内部链第三环 **C3 = 分类 / 税率差异检测**（只暴露差异；无 Schema、无路由、无外写）
- 输入：C1 只读事实 + 外部预期（RATE_TABLE / BROKER_QUOTE / VENDOR_ESTIMATE / MANUAL）

## 1. 交付物

| 产物 | 路径 | 证据 |
|---|---|---|
| 比对模块 | `apps/api/src/services/customs/customs-classification-discrepancy.ts` | `compareCustomsClassification` / `subtractDecimalStrings` |
| 回归测试 | `apps/api/src/__tests__/customs-classification-discrepancy.test.ts` | 12/12 PASS（C1+C2+C3 = 39/39） |

## 2. 差异码（只暴露，不裁决）

- `NO_EXPECTATION_DATA`（无任何外部预期，单条提示，不伪造逐行差异）
- `MISSING_EXPECTATION`（事实行无对应预期）/ `UNMATCHED_EXPECTATION`（预期无对应事实行）
- `KIND_MISMATCH` / `AMOUNT_MISMATCH`（附十进制精确 `deltaAmount = actual − expected`）
- `CURRENCY_MISMATCH`（同 rawCode 不同币种：**不跨币种比较金额**，delta 恒为 null）

## 3. fail-closed

- `NOT_A_READ_ONLY_FACT`：非 C1 只读事实（含 filing / payment / 生产凭据）一律拒绝（duty-truth 守卫错误被归一化为本模块错误类型）。
- `INVALID_EXPECTATION` / `INVALID_AMOUNT_IN_EXPECTATION` / `DUPLICATE_EXPECTATION_KEY`：预期输入不合规不静默跳过。
- `INVALID_DUTY_LINE_IN_FACT`：事实被篡改时的收敛错误。

## 4. 未发生的事项（显式声明）

- `adjudicationPerformed=false`（不判定分类/税率谁正确）、`recoverableAmountDerived=false`、`appliesFxConversion=false`。
- 无 eligibility、无 claim package、无 success fee、无 filing、无 payment、无生产凭据、无外部调用。

## 5. 下一单元

- **C4 Eligibility**（基于 C1/C2/C3 的确定性资格判定输入平面：只产出资格输入，不产生 recoverable amount）。
- 之后：C5 estimate → C6 claim-ready package → C7 交接边界；C1–C3 持久化需先送 **Schema Delta** 审计。
