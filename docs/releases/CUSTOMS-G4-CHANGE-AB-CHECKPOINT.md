# CUSTOMS G4 — CHANGE A / CHANGE B CHECKPOINT（MSG-20261003-127 REVISE 执行）

- 时间：2026-10-03T09:53:20.848Z（HEAD 21f07e9）
- 依据：架构方 MSG-20261003-127（Q1 = REVISE；Q2 = APPROVED WITH CHANGES；Q3 = PASS）
- 归档校验：AI-ARCHITECT-INBOX `### [MSG-20261003-127]`，`tools/verdict-diff/compare.mjs` → **FULL_COPY_OK**（204/204 行）

## 1. CHANGE A（C4 金额方向语义）

- **禁止** `abs(delta)` 进入恢复候选：删除 `absoluteDecimal()`，改为方向语义。
- 新增 `signedDiscrepancyAmountByCurrency`（审计用，保留正负）与 `overpaymentCandidateAmountByCurrency`（**只累计 delta > 0**）。
- 恢复阈值（minDisputedAmount）改为比较 **overpaymentCandidate**；`delta < 0`（少缴方向）绝不进入阈值。
- 新增原因码 `NO_POSITIVE_OVERPAYMENT_DISCREPANCY`（NOT_ELIGIBLE 类）：所有 amount mismatch 均非正向时 fail-closed，不得估算退款。

## 2. CHANGE B（C5 消费 C4 候选）

- C5 不再自行解释 C3 原始 delta（移除 `abs(deltaAmount)` 逻辑与 `discrepancy` 入参）。
- 估算基数 = C4 `overpaymentCandidateAmountByCurrency`，保证 C4/C5 只有一套金额口径。
- 少缴方向（candidate = 0）→ `NOT_ESTIMATED` / `NOT_ELIGIBLE_INPUT`，**绝不**产生估算金额。

## 3. 验收（架构方指定三类测试全部落地）

| 场景 | 期望 | 结果 |
|---|---|---|
| actual 120 / expected 100 | candidate 20 → 估算 20 | PASS |
| actual 80 / expected 100 | candidate 0 → 绝不 estimate 20 | PASS（NOT_ESTIMATED） |
| +20 与 −15 混存 | candidate 20（不是 35，也不是 5） | PASS（signed = 5 仅作审计） |

- 套件：`customs-recovery-eligibility` **16/16**（+2 新用例）、`customs-recovery-estimate` **16/16**（+2 新用例）；C1–C5 合计 **71/71**。
- 闸门：tsc api/web 0 error；API contract 88/75；audit coverage OK；autopilot rules OK。

## 4. 未发生的事项（显式声明）

- 未落 Schema migration（Q2 已批准，待按 CHANGE C 与投影规范实现后送审）。
- 无外部调用、无 filing、无 payment、无生产凭据；C1–C3 未重做（架构方明确不需要）。

## 5. 下一单元（按 Q2/Q3 裁决）

- Q2 落地：`CustomsEntryFactRecord` + `CustomsEntryDutyLineRecord`（**UNIQUE(factId, lineOrdinal) + INDEX(factId, rawCode, currency)**，CHANGE C）+ 四个 append-only 计算投影（Decimal(38,6)、inputDigest/algorithmVersion/resultDigest、政策型投影带 policyId/policyVersion）。
- Q3 落地：C6 claim-ready package / C7 handoff-only（纯契约层，`filingPerformed=false`、`submissionPerformed=false`、`estimateOnly=true`、`billable=false`）。
- 下次送审 = CHANGE A/B + Schema Delta migration + C6/C7 合并为一个 G4 checkpoint。
