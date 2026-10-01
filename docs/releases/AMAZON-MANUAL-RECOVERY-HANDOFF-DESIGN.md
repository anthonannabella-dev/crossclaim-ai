# R43 — Amazon Manual Recovery Handoff Design（Design Proposal，不实现）

> 依据：**MSG-20261001-29 = PASS** NEXT「批准进入 R43 — Amazon Manual Recovery Handoff Design；只先提交 Design Proposal，不要直接实现」。
> 分支 `gate/7-commercial-validation` · Codex · 2026-10-01 · **design-only**
> 边界（冻结）：不接真实 Amazon credential、不实现浏览器自动化、不恢复 Amazon write research、不开启 transport（`PLATFORM_WRITE_TRANSPORT_ENABLED=false` 保持）。

## 0. 四事实分离（不可合并）

| 事实 | 含义 | 本轮设计中的载体 |
| --- | --- | --- |
| ① 系统已生成提交材料 | Recovery Package 已生成/可导出 | `recovery.package_generated` / `recovery.package_exported` 审计事件 |
| ② 用户已提交 | 人类**在平台侧**完成提交并确认 | `recovery.submitted_manual` 审计事件（必须由人类显式确认动作触发） |
| ③ Amazon 已受理 | 平台侧出现可引用的 case/受理记录 | 人类登记 `providerCaseRef`，或只读数据中出现对应记录 |
| ④ Amazon 已赔付 | 只读 reimbursement/adjustment 数据出现对应金额 | 只读对账事件 `recovery.reimbursement_observed` / `recovery.reconciled` |

**硬规则**：任何一步都不得由前一步推导。生成材料 ≠ 已提交；已提交 ≠ 已受理；已受理 ≠ 已赔付。

## 1. 目标闭环与阶段

```text
ClaimItem
  → Evidence Completeness（只读投影，required/optional/missing）
  → Recovery Package（证据包 + 提交材料 + 指令；不可伪造平台受理）
  → Human Approval（复用 Action Guard / approval boundary）
  → Submission Instructions / Export（export / copy / instructions）
  → SUBMITTED_MANUAL（仅人类确认进入）
  → Outcome Tracking（pending / rejected / reimbursed 等事实）
  → Reimbursement / Settlement Reconciliation（只读关联，不改账）
```

| # | 阶段 | 输入 → 输出 | 关键不变量 |
| --- | --- | --- | --- |
| 1 | Evidence Completeness | Case/ClaimItem 证据链 → 完整性投影 | 只读；required 未齐 → 不得显示 ready |
| 2 | Recovery Package | 完整性投影 + 规范化事实 → 材料包（含 digest） | 材料包**不是** claim；带「仅用于人工提交」标识；不含凭据 |
| 3 | Human Approval | 材料包 digest → 审批绑定 | 复用既有 Action Guard/humanApproval 边界；审批人角色 OWNER/ADMIN |
| 4 | Submission Handoff | 已批准材料包 → 导出/复制/指令 | 只 export/copy/instructions；**不调用任何平台接口**；不模拟成功 |
| 5 | SUBMITTED_MANUAL | 人类确认动作（含 case reference/时间/操作者/证据） | 只能由显式人工确认进入；幂等；不存敏感 credential |
| 6 | Outcome Tracking | 人工登记或只读数据 → pending/rejected/reimbursed | 事实驱动；不得从 ② 推导 ③/④ |
| 7 | Reconciliation | 只读 reimbursement/adjustment 数据 → 与原 ClaimItem/人工提交记录关联 | 只读；金额与币种逐项比对；账目/Billing 不自动变更 |

## 2. 证据完整性（阶段 1）

- **分类**：`required`（按 claimType/domain 固定声明）/ `optional` / `missing`。
- **判据**：仅当 **required 全齐** 时投影为 `READY_FOR_PACKAGE`；否则 `NOT_READY` + 缺失清单（不隐藏缺口）。
- **禁止**：不得把「有若干证据」当作「证据充分」；不得因时间压力放宽 required。
- **复用**：既有 `CaseEvidence` / `EvidenceArtifact` 元数据与 `listCaseEvidence` 只读投影。

## 3. Recovery Package（阶段 2）

- 内容：规范化事实（caseNo / claimType / 金额 / 币种 / occurredAt）、证据**元数据引用**（不是原始凭据）、人工提交**指令**（平台入口说明、需填写字段）、材料包 **digest**。
- 明确标识：「MANUAL SUBMISSION PACKAGE — NOT SUBMITTED」；不含任何"已提交/已受理"字样。
- 不含：provider 凭据、token、客户敏感原文（与 quarantine 同口径的白名单纪律）。
- 幂等：digest = 规范化内容哈希；相同输入重复生成 → 同一 digest（不产生第二份逻辑包）。

## 4. Human Approval（阶段 3）

- 复用既有边界：`withActionGuard` + HITL 审批校验（审批人 OWNER/ADMIN；执行人 OWNER/ADMIN/FINANCE 口径与既有动作一致）。
- 审批绑定：`basisReference = package digest`（与既有 claim.submit / appeal.submit 同构）。
- **待架构方裁决（R43 送审问题）**：新受保护动作名（建议 `recovery.manual_submit`）及其要求集合（humanApproval + 是否 platformEnablement/productionGate）。本轮**不注册**该动作。

## 5. Submission Instructions / Export（阶段 4）

- 允许：导出材料包（文件/文本）、复制到剪贴板、展示平台人工入口与填写指引。
- 禁止：任何形式的平台写调用、任何"提交成功"的模拟或占位状态、任何浏览器自动化。
- 审计：`recovery.package_exported`（记录 exporter、时间、digest；不记录导出内容正文）。

## 6. SUBMITTED_MANUAL（阶段 5）

- 唯一入口：人类显式确认动作（附带 `providerCaseRef`（若有）、提交时间、操作者、证据引用）。
- 记录：`recovery.submitted_manual` 审计事件 —— `claimItemId` / `packageDigest` / `providerCaseRef` / `submittedAt` / `actorUserId` / `evidenceRefs`；**不含凭据**。
- 幂等：同一 `claimItemId + providerCaseRef` 重复确认 → 视为同一事实（不新增第二条逻辑 recovery chain）。
- 状态来源：与既有项目一致 —— **由审计事件推导**（不新增 Schema 字段；如需落库字段则走单独 Schema Delta 裁决）。

## 7. Outcome Tracking（阶段 6）

- 允许事实：`PENDING`（已提交待结果）/ `REJECTED`（平台拒绝）/ `REIMBURSED`（平台已赔付，需只读证据）/ `PARTIAL`（部分赔付）/ `UNKNOWN`。
- 禁止：由「已提交」自动进入「已受理」或「已赔付」；无只读证据不得标记 REIMBURSED。
- 审计：`recovery.outcome_recorded`（source = HUMAN_ENTRY | PROVIDER_READ_ONLY）。

## 8. Reconciliation（阶段 7）

- 数据来源：Amazon **只读** reimbursement / adjustment 数据（R42 已证明只存在只读路径）。
- 关联：以 `normalizedRef`（`amazon-sp::orders::<id>`）或人工登记的 `providerCaseRef` 关联原 ClaimItem / 人工提交记录。
- 校验：金额（4 位小数）与币种逐项比对；不符 → 记录差异事实，**不自动改账**。
- 账目/Billing 联动：属资金链路，**必须另行裁决**；本轮设计不改 Settlement/Billing/RecoveryLedger。

## 9. 幂等与审计（覆盖 12 项之 9/10）

| 操作 | 幂等键 | 重复调用的结果 |
| --- | --- | --- |
| 生成材料包 | `packageDigest` | 返回同一包（不新增） |
| 导出 | `packageDigest + exporter + 时间桶` | 记录导出事件，不产生第二份逻辑包 |
| 人工确认提交 | `claimItemId + providerCaseRef`（无 ref 时 `claimItemId + submittedAt 桶`） | 视为同一事实 |
| 结果登记 | `claimItemId + outcome + 证据引用` | 同一事实不重复记账 |

审计事件清单（均可追溯）：`recovery.package_generated` / `recovery.package_approved`（可复用既有审批事件）/ `recovery.package_exported` / `recovery.submitted_manual` / `recovery.outcome_recorded` / `recovery.reimbursement_observed` / `recovery.reconciled` / `recovery.handoff_rejected`。

## 10. Fail-closed 矩阵（12 项之 11）

| 条件 | 行为 |
| --- | --- |
| 缺审批 / 审批未通过 / 审批过期或撤销 | 拒绝进入导出与确认（`APPROVAL_*`） |
| 证据不完整（required 未齐） | 拒绝生成「可提交材料包」，只给缺失清单 |
| 跨租户（Case/ClaimItem/证据任一不属于会话租户） | 404 / 403，零副作用 |
| 错误绑定（Claim/Case 不匹配、package digest 不符） | 409 拒绝，零副作用 |
| 状态错误（未提交却登记 outcome、已 REIMBURSED 再次赔付） | 409 拒绝，零副作用 |
| 客户端自证（digest / basisReference / organizationId） | 400 拒绝（服务端重算） |

## 11. 边界冻结与待裁决问题

**边界冻结**：R43 Design 不接真实 Amazon credential、不实现浏览器自动化、不恢复 Amazon write research、不开启 transport；`AMAZON WRITE HOLD · REAL WRITE ADAPTER HOLD · TRANSPORT=false · PRODUCTION CREDENTIALS HOLD · REAL EXTERNAL WRITE HOLD` 全部保持。

**待架构方裁决**：

1. 新受保护动作名与要求集合（建议 `recovery.manual_submit`；是否含 platformEnablement/productionGate）。
2. `SUBMITTED_MANUAL` 是否维持「审计事件推导」（建议是，避免 Schema 变更）或需要落库字段（Schema Delta 另议）。
3. 材料包导出形态（文件下载 / 剪贴板 / 仅指令展示）与保留期；是否需要「导出即视作敏感操作」的额外审计等级。
4. Reconciliation 与 Settlement/Billing 的联动是否留待后续独立批次（本轮设计默认**不联动**）。

## 12. 设计级验收（实现批次将转化为测试）

1. required 未齐 → 不得 READY；2. 生成材料包幂等（同 digest 不新增）；3. 缺审批不得导出/确认；4. 未确认不得出现 SUBMITTED_MANUAL；5. 已提交不得自动变已受理/已赔付；6. 无只读证据不得标记 REIMBURSED；7. 跨租户/错误绑定/状态错误一律 fail-closed；8. 重复确认不建第二条链；9. 审计事件可完整追溯（generated→approved→exported→submitted_manual→outcome→reconciled）；10. 全程零平台外写、零凭据、零账目变更。
