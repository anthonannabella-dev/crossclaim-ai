# CUSTOMS G4 — CHANGE A/B + Schema Delta + C6/C7 CHECKPOINT（第三次送审）

- 时间：2026-10-03T11:44:01.425Z；REVIEWED_HEAD：`a247495`
- 前序：MSG-20261003-127（Q1 REVISE / Q2 APPROVED WITH CHANGES / Q3 PASS）已逐字归档并 FULL_COPY_OK。

## 1. CHANGE A/B（MSG-20261003-127 REVISE 执行，impl `c792798`）

- CHANGE A（C4）：删除 `abs(delta)`；新增 `signedDiscrepancyAmountByCurrency`（审计用）+ `overpaymentCandidateAmountByCurrency`（**只累计 delta > 0**）；恢复阈值改用候选金额；新增原因码 `NO_POSITIVE_OVERPAYMENT_DISCREPANCY`（NOT_ELIGIBLE）→ 少缴方向 fail-closed。
- CHANGE B（C5）：不再解释 C3 原始 delta，改为消费 C4 `overpaymentCandidateAmountByCurrency`（单一金额口径）。
- 架构方指定三类回归全部落地：`120/100 → 20`；`80/100 → 0 且绝不估算`；`+20 与 −15 → 20`（signed 仅 5 作审计）。
- `customs-recovery-eligibility` 16/16、`customs-recovery-estimate` 16/16。

## 2. Q2 Schema Delta（首批 `20261003100000` / 二批 `20261003110000`）

- 事实层：`CustomsEntryFactRecord` + `CustomsEntryDutyLineRecord`（append-only；金额 `Decimal(38,6)` + 独立 currency；**CHANGE C**：`UNIQUE(factId, lineOrdinal)` + `INDEX(factId, rawCode, currency)`；无 credential/PII 列）。
- 计算投影（全部 append-only，不 UPDATE）：`CustomsDutyTruthRecord` / `CustomsDiscrepancyRecord` / `CustomsEligibilityRecord` / `CustomsRecoveryEstimateRecord`；统一 `organizationId + inputFactId + inputDigest + algorithmVersion + resultDigest + computedAt + payload`，政策型另带 `policyId + policyVersion`；latest 由 `ORDER BY computedAt DESC` / view 推导。
- 触发器：tenant 归属完整性（投影 → fact 跨租户拒绝）+ 归属不可变 + append-only；清单 `89 baseline / 30 append-only`，psql 校验通过。
- 计数：模型 **67（61 core + 6 join）**、迁移 **50**；architecture-contract **142/142**。
- 闸门：`prisma validate` valid、`migrate deploy` 从空库可执行、`generate` OK、tsc api/web 0 error、API contract 88/75、audit coverage / autopilot rules OK、本地 deploy smoke OK。

## 3. C6 claim-ready package（impl `6599a10`）

- 确定性装配（`packageId` / `inputDigest` / `resultDigest` 由规范化 JSON sha256 派生；`computedAt` 由调用方注入）：C1 事实 + C2 真值 + C3 差异 + C4 资格 + C5 估算 + provenance + 证据引用。
- 缺口码：`ELIGIBILITY_NOT_ELIGIBLE` / `ELIGIBILITY_INDETERMINATE` / `ESTIMATE_NOT_READY` / `NO_EVIDENCE_REFERENCE` / `NO_DISCREPANCY_EVIDENCE`；无缺口 = `READY`。
- 估算段显式 `estimateOnly=true` + `frozenAsTrustedAmount=false`（**不是**可信金额、不是账单基数）；`filingPerformed=false` / `submissionPerformed=false` / `billable=false`。
- fail-closed：非只读事实、非法子报告、provenance 缺失、证据引用含 PII/非 hex64 digest、非 ELIGIBLE 却 ESTIMATED（`PACKAGE_INPUT_INCONSISTENT`）。测试 8/8。

## 4. C7 handoff-only（impl `b468372`）

- 允许：handoff artifact（`CUSTOMER_SELF` / `BROKER` / `PORTAL_DEEPLINK`）+ 支持文件 manifest + checklist + 说明 + 人工 acknowledgement 归一化。
- 禁止清单（随 artifact 输出，可审计）：`AUTO_FILING` / `AUTO_PORTAL_SUBMIT` / `BROKER_API_WRITE` / `ABI_EDI_WRITE` / `GOVERNMENT_FEE_PAYMENT` / `TREAT_PACKAGE_AS_FILING` / `TREAT_HANDOFF_AS_RECOVERED_TRUTH`。
- 未就绪 package 拒绝交接；BROKER 必须带 safe reference；acknowledgement 显式 `filingPerformed=false` / `recoveredTruthDerived=false` / `externalWritePerformed=false`。测试 6/6。

## 5. 全链与套件证据

- C1→C7 端到端回归 `customs-g4-chain` 7/7（含少缴方向拒绝估算、INDETERMINATE 传播、混币/PII/篡改事实/证据引用 fail-closed、packageId/handoffId 确定性）。
- customs 全套 **14 文件 / 154 用例全绿**；G4 契约链 C1–C7 合计 **85/85**。

## 6. 边界声明

- `HOLD_EXTERNAL` · `TRANSPORT=false` · `filingSubmitted=false` · 无 provider/broker/EDI 调用 · 无 payment · 无生产凭据 · 无真实客户数据。
- C7 只做交接；真实 filing 与 handoff 执行仍为宿主/外部依赖。

## 7. 请裁决

1. CHANGE A/B 是否符合上一轮 REVISE 要求（含架构方指定的三类回归）？
2. Q2 Schema Delta 两批是否满足「Decimal(38,6) + append-only + CHANGE C lineOrdinal + 投影全量留档 + inputDigest/algorithmVersion/resultDigest + policyId/policyVersion」？
3. C6 claim-ready package 与 C7 handoff-only 是否符合 Q3 边界（不提交、不外写、估算不可计费、禁止动作清单）？
4. 是否批准 G4 内部链 C1–C7 = PASS/CLOSED（可进入下一内部缺口）？
