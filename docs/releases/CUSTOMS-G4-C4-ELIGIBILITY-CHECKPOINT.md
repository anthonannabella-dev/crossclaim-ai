# CUSTOMS G4 / C4 — Customs Recovery Eligibility CHECKPOINT

- 时间：2026-10-03T09:41:24.607Z（HEAD c4370ea；C1 `f7b85ee` / C2 `d8fd6c3` / C3 `6768952`）
- 单元：G4 内部链第四环 **C4 = 确定性资格判定**（政策驱动；无 Schema、无路由、无外写）
- 输入：C1 事实 + C2 真值 + C3 差异报告 + 版本化政策（policyId / policyVersion / jurisdiction / allowlist / 时效 / 必需差异码 / 最小争议金额 / OTHER 行策略）

## 1. 交付物

| 产物 | 路径 | 证据 |
|---|---|---|
| 判定模块 | `apps/api/src/services/customs/customs-recovery-eligibility.ts` | `evaluateCustomsEligibility` |
| 回归测试 | `apps/api/src/__tests__/customs-recovery-eligibility.test.ts` | 14/14 PASS（C1+C2+C3+C4 = 53/53） |

## 2. 判定语义（三态，fail-closed）

- `ELIGIBLE`（全部政策条件满足，reason `OK`）
- `NOT_ELIGIBLE`：`JURISDICTION_NOT_SUPPORTED` / `SOURCE_NOT_ALLOWED` / `ENTRY_TOO_OLD` / `NO_DUTY_LINES` / `REQUIRED_DISCREPANCY_MISSING` / `BELOW_MIN_DISPUTED_AMOUNT`
- `INDETERMINATE`：`MIN_THRESHOLD_NOT_DEFINED_FOR_CURRENCY` / `OTHER_KIND_LINES_PRESENT`（政策未覆盖 → 不猜测）

## 3. 观察值与边界

- `observedDiscrepancyAmountByCurrency`：只汇总 C3 `AMOUNT_MISMATCH` 的 |delta|，**逐币种独立、绝不合并**；这是观测值，不是 recoverable amount。
- `entryAgeDays` 可审计（entryDate → observedAt）；超过政策时效即 NOT_ELIGIBLE。
- `eligibilityDetermined=true`，但 `adjudicationPerformed=false` / `recoverableAmountDerived=false` / `feeDerived=false` / `appliesFxConversion=false` / 无 filing / 无 payment / 无生产凭据。
- 政策输入 fail-closed：形状非法 → `INVALID_POLICY`；阈值非十进制 → `INVALID_THRESHOLD_AMOUNT`；事实非只读 → `NOT_A_READ_ONLY_FACT`；真值/差异报告非法 → `INVALID_TRUTH` / `INVALID_DISCREPANCY_REPORT`。

## 4. 未发生的事项（显式声明）

- 无 AI/模型推断、无外部调用、无 DB 写入、无 Schema 变更、无路由变更。
- 无 success fee、无账单、无代收、无申报。

## 5. 下一单元

- **C5 Estimated Recoverable Amount**：只在 `ELIGIBLE` 前提下给出估算区间（保守、可审计、明确标注为估算），仍不产生账单/费用。
- 之后 C6 claim-ready package → C7 handoff 边界；C1–C5 持久化需先送 **Schema Delta** 审计。
