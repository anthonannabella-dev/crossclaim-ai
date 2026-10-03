# CUSTOMS G4 / C6 — Claim-Ready Package CHECKPOINT（Q3 = PASS）

- 时间：2026-10-03T09:55:25.060Z（HEAD c792798）
- 单元：G4 内部链第六环 **C6 = 确定性可提交包装配**（纯契约；不提交、不外写）
- 依据：架构方 MSG-20261003-127 Q3 = PASS（C6 可立即做纯契约/装配层；A/B 未修完前不得把 C5 金额固化——A/B 已于 `c792798` 完成）

## 1. 交付物

| 产物 | 路径 | 证据 |
|---|---|---|
| 装配模块 | `apps/api/src/services/customs/customs-claim-ready-package.ts` | `assembleCustomsClaimReadyPackage` |
| 回归测试 | `apps/api/src/__tests__/customs-claim-ready-package.test.ts` | 8/8 PASS（C1–C6 = 79/79） |

## 2. 语义

- 输入：C1 事实 + C2 真值 + C3 差异 + C4 资格 + C5 估算 + provenance（policyId/policyVersion/algorithmVersion）+ 证据引用 + 调用方注入 `computedAt`。
- 输出：`packageId`（确定性）/ `inputDigest` / `resultDigest`（sha256，规范化 JSON）+ 各段快照 + **确定性 checklist** + 缺口码。
- 缺口码（不抛错，只标注）：`ELIGIBILITY_NOT_ELIGIBLE` / `ELIGIBILITY_INDETERMINATE` / `ESTIMATE_NOT_READY` / `NO_EVIDENCE_REFERENCE` / `NO_DISCREPANCY_EVIDENCE`；无缺口 = `READY`。
- 估算段显式标注 `estimateOnly=true` + `frozenAsTrustedAmount=false`：**不是**可信金额，也不是账单基数。
- fail-closed：非只读事实 / 非法真值·差异·资格·估算 / provenance 缺失 / 证据引用非法（含 PII 或非 hex64 digest）/ 非 ELIGIBLE 却 ESTIMATED（`PACKAGE_INPUT_INCONSISTENT`）。
- 边界：`filingPerformed=false`、`submissionPerformed=false`、`transportEnabled=false`、`billable=false`、`productionCredentials=ABSENT`；包内不含 `recoveredAmount` / `submissionResult`。

## 3. 下一单元

- **C7 handoff-only**（Q3 批准）：handoff package + checklist + supporting documents manifest + acknowledgement 事实边界；禁止自动 filing / broker API write / ABI-EDI write / 自动支付政府费用。
- **Q2 Schema Delta**：Decimal(38,6)、append-only 事实（CHANGE C：`UNIQUE(factId, lineOrdinal)` + `INDEX(factId, rawCode, currency)`）、四个 append-only 计算投影（inputDigest/algorithmVersion/resultDigest + 政策型带 policyId/policyVersion）。
- 下次送审 = CHANGE A/B + Schema Delta migration + C6/C7 合并为 G4 checkpoint。
