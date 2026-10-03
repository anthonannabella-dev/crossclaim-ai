# PC-05 FINAL-2 Checkpoint（FINANCIAL TRUTH NARROW FIX）

状态：**READY_FOR_REVIEW / FINAL-2 CHECKPOINT**（待架构方复审）
FINAL_IMPLEMENTATION_HEAD = 88f788b
FINAL_IMPLEMENTATION_HEAD_FULL = 88f788b4c28613cc1a27b43cad3f173639ab5f1c
CI = SUCCESS · RUN_ID = 37034238807 · CI_HEAD = 88f788b
前序：CHANGE A（currency integrity）已 PASS/CLOSED（HEAD 46e1105 / CI 37032654286；但架构方在 MSG-20261003-88 纠正记录：该轮实际要求 A~E 五项，A 已通过，B/C/D/E 未修）。
本次授权：MSG-20261003-88 REQUIRED FIX B / C / D / E（仅修财务真实语义，不重做 A）。
边界：MONEY VISIBILITY（非 MONEY MOVEMENT）· Payment = 0 · collection = OFF · TRANSPORT=false · 无生产凭据。

## 1. CHANGE B / C / D / E 的收口方式

| CHANGE | 要求 | 实现 |
|---|---|---|
| B submitted ≠ approved | approved 只来自真实 approved·recovered outcome；不得把 SUBMITTED_MANUAL 或 CLOSED(REJECTED / NOT_WORTH_PURSUING / CUSTOMER_DECLINED) 计为 approved；不新建第二套 approval state | `isRecoveredOutcome = status === 'RECOVERED' OR (status === 'CLOSED' AND closedReason === 'RECOVERED')` 才计入 `approved = recoverableAmount`；其余一律 0 |
| C approvedAt 只用真实时间事实 | 只有真实 persisted approval·outcome timestamp 才填；否则 null；不得用 `ClaimItem.occurredAt` 顶替 | `approvedAt` 只取 `ClaimItem.closedAt`（真实 outcome 时间），否则保持 null |
| D recovered 必须来自 RecoveryPayout | recovered / received 只能按 `RecoveryPayout.amount`（并按 `payout.currency` 分桶）；Settlement 只提供 expected / disputed / reconciliation context / lineage | select 增加 `settlements.payouts`；`recovered` 仅累加 payout 金额；Settlement 仅用于 expected / disputed 与上下文，不再以 `Settlement.amount` 代表到账 |
| E reversal 单一来源 / 禁止 double subtract | `grossRecovered` = Σ payout（历史不得被抹掉）；`adjustments` = Σ `SettlementAdjustment where kind = REVERSAL`；`netRecovered = gross − adjustments`；不得同时排除 reversed settlement 又再减 reversal | 结算循环不再因 `reconciliationStatus = REVERSED` 跳过 payout；`adjustments` 仅来自 REVERSAL；`netRecovered` 由两者相减得出；`receivedAt` 取最早 payout 时间 |

## 2. 永久验收（MSG-20261003-88 Required permanent tests）

| 验收项 | 结果 |
|---|---|
| SUBMITTED_MANUAL → approved = 0 | PASS |
| CLOSED + REJECTED → approved = 0 | PASS |
| CLOSED + RECOVERED → approved 正确 | PASS |
| 无真实 approval fact → approvedAt = null | PASS |
| Settlement = 100 + RecoveryPayout = 40 → recovered = 40 | PASS |
| Settlement RECEIVED 但无 payout → recovered = 0 | PASS |
| payout = 100 + REVERSAL = 100 → gross = 100 / adjustment = 100 / net = 0 | PASS |
| `reconciliationStatus = REVERSED` + REVERSAL adjustment → 不 double subtract | PASS（同上用例，gross 保持 100） |
| payout 币种落入各自的 currency bucket | PASS（USD 50 / EUR 70 不相加） |
| 既有 multi-currency regression 保持 green | PASS（CHANGE A 回归用例） |
| EXPECTED 只进 expected；DISPUTED 单独计数 | PASS |
| Payment=0 / collection=NOT_ENABLED 仍准确；无 secret 字段 | PASS |

套件：`recovery-money-view-http-db` **8/8 PASS**（上面全部断言在同一套件内，真实 HTTP + PostgreSQL）。

## 3. 其他验证

- `tsc --noEmit`（apps/api / apps/web）0 error。
- 本地 API contract `API_CONTRACT_OK`（本次未新增路由）。
- CI 全量回归（migration / typecheck / unit + DB / two-stage upgrade / web build）RUN_ID = 37034238807 全绿；R45·R46 settlement / reconciliation 套件包含在 API job 内。

## 4. 未做 / 边界

未重做 CHANGE A（currency buckets / UI multi-currency / tenant isolation / permissions / payment=ZERO / collection=NOT_ENABLED 均已通过）；未 activate payment、未 collect、未 create payout、未 connect PSP、未 add FX engine、未 redesign R46、未 modify account lineage；未改 Schema、未加 migration、未新增写端点（payout 仅作为**读取**事实来源）。

## 5. 下一执行单元（待裁决）

若 PASS：PC-05 = PASS / CLOSED → 解除 PC-06 = PENDING PC-05 FINAL，进入 PC-06 Account management。
边界保持：NO platform write · Payment = 0 · autopay = OFF · collection = OFF · external payment write = OFF · R13 HOLD · TRANSPORT=false · 无生产凭据。
