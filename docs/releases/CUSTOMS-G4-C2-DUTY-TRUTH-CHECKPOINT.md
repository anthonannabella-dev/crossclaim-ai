# CUSTOMS G4 / C2 — Duty Calculation Truth CHECKPOINT

- 时间：2026-10-03T09:36:48.317Z（HEAD d8fd6c3）
- 单元：G4 内部链第二环 **C2 = 报关单 duty/tax 计算真值**（纯确定性计算；无 Schema、无路由、无外写）
- 消费方：C1 `CustomsEntryFact`；产出：`CustomsDutyTruth`

## 1. 交付物

| 产物 | 路径 | 证据 |
|---|---|---|
| 计算模块 | `apps/api/src/services/customs/customs-duty-truth.ts` | `computeCustomsDutyTruth` / `assertReadOnlyEntryFact` |
| 回归测试 | `apps/api/src/__tests__/customs-duty-truth.test.ts` | 11/11 PASS |

## 2. 计算语义

- 每币种 / 每 `kind`（DUTY / TAX / FEE / INTEREST / OTHER）确定性合计 + 币种总额；**绝不跨币种相加**（多币种事实逐币种独立输出并标记 `MULTI_CURRENCY_FACT`）。
- 金额只用 BigInt 十进制（scale 6），不接受 float；合计与 C1 声明值比对：不一致 → `DUTY_TOTAL_MISMATCH`（**用计算值，不覆盖**）。
- 观察项（≠ 裁决）：`EMPTY_ENTRY` / `NO_DUTY_LINE` / `NEGATIVE_AMOUNT_LINE` / `ZERO_AMOUNT_LINE` / `DUPLICATE_RAW_CODE` / `OTHER_KIND_PRESENT` / `MULTI_CURRENCY_FACT` / `DUTY_TOTAL_MISMATCH`。

## 3. fail-closed 守卫

- `NOT_A_READ_ONLY_FACT`：readOnly≠true / filingPerformed≠false / paymentPerformed≠false / productionCredentials≠ABSENT。
- `INVALID_AMOUNT_IN_FACT` / `INVALID_DUTY_LINE_IN_FACT`：事实被篡改或非 C1 产出时的收敛错误。

## 4. 未发生的事项（显式声明）

- `adjudicationPerformed=false`（不判定分类/税率谁对谁错）、`recoverableAmountDerived=false`、`appliesFxConversion=false`。
- 无 eligibility、无 claim package、无 success fee、无 filing、无 payment、无生产凭据。
