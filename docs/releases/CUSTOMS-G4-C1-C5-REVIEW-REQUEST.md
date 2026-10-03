# CUSTOMS G4（C1–C5）READY_FOR_REVIEW — 内部链契约层送审

- 送审时间：2026-10-03T09:48:44.432Z
- REVIEWED_HEAD：`7b55a0a`
- 实现提交：C1 `f7b85ee` / C2 `d8fd6c3` / C3 `6768952` / C4 `c4370ea` / C5 `18cd3a6` / CI 修复 `7b55a0a`
- 边界：**无 Schema 变更、无路由变更、无外部调用、无资金动作、无生产凭据**（filingSubmitted=false / TRANSPORT=false / HOLD_EXTERNAL）

## 1. 交付物（全部为只读/纯计算模块）

| 单元 | 模块 | 测试 | 语义要点 |
|---|---|---|---|
| C1 Customs Entry 事实契约 | `apps/api/src/services/customs/customs-entry-contract.ts` | 16/16 | 归一化只读事实；9 个 fail-closed 原因码；PII/凭据字段递归拒绝；BigInt scale-6 求和 |
| C2 Duty Calculation Truth | `apps/api/src/services/customs/customs-duty-truth.ts` | 11/11 | 逐币种逐 kind 确定性合计；8 类观察项；不跨币种相加；不裁决 |
| C3 Classification / Rate Discrepancy | `apps/api/src/services/customs/customs-classification-discrepancy.ts` | 12/12 | 事实 × 外部预期逐行差异（kind/amount+delta/currency/missing/unmatched）；只暴露不裁决 |
| C4 Recovery Eligibility | `apps/api/src/services/customs/customs-recovery-eligibility.ts` | 14/14 | 政策驱动三态（ELIGIBLE/NOT_ELIGIBLE/INDETERMINATE）+ 9 原因码 + 逐币种观察差异金额 |
| C5 Estimated Recoverable Amount | `apps/api/src/services/customs/customs-recovery-estimate.ts` | 14/14 | 仅 ELIGIBLE 估算；ratio/cap/min；cents **向下**取整；estimateOnly / **不可计费** |

合计 **67/67**；全部 customs 套件 **129/129**（含 C17 FINAL-2 并发/幂等 DB、C21 HTTP E2E）。

## 2. 闸门证据

- `tsc --noEmit`（api / web）：0 error
- API route contract：implemented=88 documented=75（无新增路由，计数不变）
- audit coverage / autopilot rules：OK
- 本地 `deploy smoke`（fresh DB → migrate deploy → API /health + /readyz）：**DEPLOY_SMOKE_OK**，51 migrations / 142 tenant triggers
- 本地 `migration-checksums` 因 CRLF 检出必红（基线已知，CI 为准）

## 3. 设计声明（请逐项确认或 REVISE）

1. **C1 事实只读性**：`readOnly=true`、`filingPerformed=false`、`paymentPerformed=false`、`productionCredentials='ABSENT'` 作为事实字段写入；混币直接 fail-closed（`MIXED_CURRENCY_DUTY_LINES`），不静默换算。
2. **C2 计算口径**：BigInt scale-6、cents 语义、合计与 C1 声明值不一致 → `DUTY_TOTAL_MISMATCH` 且以计算值为准（不覆盖输入）；只暴露观察项，不做裁决。
3. **C3 差异语义**：`deltaAmount = actual − expected`（十进制精确）；同 rawCode 不同币种 → `CURRENCY_MISMATCH` 且**不比较金额**；缺失/多余双向都暴露。
4. **C4 三态语义**：政策未覆盖的维度（缺币种阈值、OTHER 行策略不允许）→ `INDETERMINATE`（fail-closed，不猜测）；`NOT_ELIGIBLE` 覆盖辖区/来源/时效/无 duty 行/必需差异缺失/低于最小争议金额。
5. **C5 计费红线**：估算**仅**在 ELIGIBLE 时产出；`estimateOnly=true`、`finalAmountDerived=false`、`billable=false`、`feeDerived=false`；cents 向下取整（保守）；估算**不得**作为 `FeeCalculation` / `BillingInvoice` 基数（strict SUCCESS-FEE-BILLING-REDLINE）。
6. **无外部动作**：无 provider 调用、无 broker/EDIFACT 传输、无 filing、无 payment、无客户提交。

## 4. 需要架构方裁决的开放项

**Q1（语义批准）**：C1–C5 的上述语义是否批准？如有 REVISE 请给 CHANGE A/B/C… 编号。

**Q2（Schema Delta 请求，需批准后才落 migration）**：C1–C5 目前是纯契约层（未持久化）。拟议持久化模型如下，请批准/修改：

- `CustomsEntryFactRecord`（tenantId、source、entryNumber、entryDate、jurisdiction、portOfEntry、importerOfRecordRef、rawReference、observedAt、totalDutyAmountByCurrency、内容摘要 `contentDigest`、append-only，无 PII、无凭据列）
- `CustomsEntryDutyLineRecord`（factId、kind、rawCode、amount、currency；唯一键 (factId, rawCode, currency)）
- `CustomsDutyTruthRecord` / `CustomsDiscrepancyRecord` / `CustomsEligibilityRecord` / `CustomsRecoveryEstimateRecord`：均为**计算投影**（inputFactId + policyId/policyVersion + payload + `computedAt`），append-only、可回溯，不做 UPDATE。
- 统一约束：tenant 触发器（与 cc_tenant 系列一致）、金额列以 `Decimal(38,6)` 或 text+CHECK 存储（请裁决二选一）、所有投影带 `policyVersion`、不含任何 credential/PII 列。
- 请裁决：投影是否全部落库（可审计回溯）还是只落事实 + 最新投影（节省存储）。

**Q3（C6/C7 排期）**：C6 `Claim-Ready Package`（确定性装配，不提交）是否可在 Q2 裁决前继续（纯契约层）？C7 handoff 边界是否按「只产出手交包 + 客户自主提交 / broker 交接语义，真实提交保持 HOLD_EXTERNAL」实现？

## 5. 未发生的事项（显式声明）

- 无真实 broker / ABI / EDI / carrier 调用；无真实 filing；无真实付款；无生产凭据；无客户数据。
- 无 Schema/migration 变更；无 HTTP 路由变更；无前端变更；无资金链路变更。
