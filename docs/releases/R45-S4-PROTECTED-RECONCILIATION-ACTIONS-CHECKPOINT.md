# R45 — Implementation S4 · Protected Reconciliation Actions · Implementation Checkpoint

> 依据：**MSG-20261002-49 = PASS WITH REVISE**（S3 主体 CLOSED；③ 批准进入 **R45 S4 — Protected Reconciliation Actions**）。
> 范围（冻结）：`recovery.reconciliation_basis_set` · `recovery.reconciliation_basis_supersede` ·
> `recovery.reconciliation_override` · `recovery.reconciliation_provider_outcome_record`，
> 全部 **INTERNAL_WRITE + humanApproval**，并要求**锁后**重验当前 ACTIVE membership / role。
> 边界：**NO Settlement · NO Billing · NO Fee · NO RecoveryLedger mutation · NO platform write · TRANSPORT=false · NO production credentials**；
> 未顺带开放「可收费 recovered amount」。

---

## 1. 交付物

| 类别 | 内容 |
| --- | --- |
| 动作注册 | `action-guard.ts` 四个 catalog 条目（`INTERNAL_WRITE` + `requires: ['humanApproval']`）；`approval-verifier.ts` 四个动作常量 |
| 审批创建绑定 | `workflow/recovery-review.ts`：四个动作的 `boundExtra` 必填项（服务端构造，客户端不得自证） |
| basis 动作 | `services/reconciliation/basis-actions.ts` —— `setReconciliationBasis` / `supersedeReconciliationBasis` |
| 人工动作 | `services/reconciliation/manual-actions.ts` —— `recordReconciliationOverride` / `recordManualProviderOutcomeFact` |
| 测试 | `reconciliation-basis-actions-db.test.ts`（9）+ `reconciliation-manual-actions-db.test.ts`（9），均为真实 PostgreSQL |

---

## 2. 四个动作的落地要点

### 2.1 `recovery.reconciliation_basis_set`（首次建立）

同一事务：case adversary lock → `ClaimItem FOR UPDATE`（租户 + 案件绑定）→ **锁后**重读 ACTIVE membership/role（`claimTrackingApprove`）
→ 确认本 claim **尚无** effective basis（已有 → `ILLEGAL_TRANSITION`，必须走 supersede）→ `verifyApprovalBoundary`（动作 + 载荷 + 服务端 extra 指纹）
→ INSERT basis（append-only）→ 业务审计 → `recovery.approval_consumed` → commit。

### 2.2 `recovery.reconciliation_basis_supersede`（受控取代；顺序沿用 MSG-20261001-46 Q1）

`lock current effective basis FOR UPDATE → 校验 approval/binding/provenance → UPDATE old SET supersededAt/supersededByBasisId（受控 CAS）→ INSERT new effective basis → 业务审计 + approval 消费 → commit`。
**任何后置失败整体回滚**（已用故障注入验收：旧 basis 仍 effective、无新 basis、approval 未消费、`supersededByBasisId` 保持 NULL）。
旧 basis **永久保留**，不得 UPDATE 其它字段。

### 2.3 `recovery.reconciliation_override`（每笔 reimbursement 独立审批）

- 目标 fact 必须存在、同租户、且 `claimItemId` 与请求一致 → 否则 fail-closed；
- 每笔 fact **一票制**（已有决策 → `ILLEGAL_TRANSITION`）；
- **不修改任何原始事实**（测试断言 amount/kind 前后一致）；
- 需要 structured reason + **≥1 条 EvidenceArtifact**；approval 绑定 `claimItemId + reimbursementFactId + decisionKind`；
- 锁后 membership/role 重验；失败 → 决策/审计/消费零推进。

### 2.4 `recovery.reconciliation_provider_outcome_record`（人工录入，S4 特别要求）

- `sourceKind = MANUAL_WITH_EVIDENCE`；`providerEventId = null`，身份来自服务端规范的 `canonicalSourceIdentity`（v1 指纹）；
- **evidence 逐条校验**：存在 / 同租户 / 不重复 / 具备可用来源（`fileAssetId` 或 `externalUrl`）；
- structured `reasonCode` + approval binding（`caseId + provider + kind + occurredAt + canonicalSourceIdentity`）；
- 同一人工事件重复录入 → 幂等 fail-closed（复用既有事实语义，不新建第二条）；
- **失败时事实 / 审计 / approval consumption 全部零推进**；
- 不产生 `providerAccepted = true` 的推导（返回 `providerAcceptedInferred: false`）。

---

## 3. 审批绑定（创建侧，客户端不得自证）

| 动作 | `boundAction` | `boundExtra` 必填（服务端构造） |
| --- | --- | --- |
| basis_set | `recovery.reconciliation_basis_set` | claimItemId · caseId · expectedRecoveryAmount · currency · basisKind · basisVersion |
| basis_supersede | `recovery.reconciliation_basis_supersede` | 同上 + supersedesBasisId |
| override | `recovery.reconciliation_override` | claimItemId · reimbursementFactId · decisionKind |
| provider_outcome_record | `recovery.reconciliation_provider_outcome_record` | caseId · provider · kind · occurredAt · canonicalSourceIdentity |

执行侧用**同一批键**做 `extra` 逐项比对；四个动作**互不通用**，且与 `recovery.manual_submit` / `..._reference_recorded` 完全隔离。

---

## 4. 验收证据

| 项 | 结果 |
| --- | --- |
| `npx prisma validate` | **valid**（本批次零 Schema 变更） |
| `npx tsc --noEmit` | **PASS（0 error）** |
| basis 动作 DB 验收 | **9/9 PASS**（含 supersede 后置失败完整回滚） |
| 人工动作 DB 验收 | **9/9 PASS**（含 evidence 五类拒绝与零推进） |
| R45 家族（S2–S4 全部测试） | **68/68 PASS** |
| 全量 API 套件 | **175 files / 1717 tests PASS**（本地全量；CI 侧 fresh migrate + 两套触发器清单 + 全量测试 + two-stage upgrade 覆盖同一组不变量） |

---

## 5. 明确未做（边界）

- 未开放 Settlement / Billing / Fee / RecoveryLedger 写入；未产生「可收费 recovered amount」；
- 未实现平台外写 / transport / 生产凭据；未实现 Payment / Mandate / autopay（属 R13 的独立 Payment Activation Gate，仍 HOLD）；
- 未实现 S5 的只读 checker 与最终全量回归（下一步）。

---

## 6. 风险分类与下一步

- `FOUNDATION_REUSED` = R43/R44 的受保护动作范式（advisory/行锁 + 锁后角色重验 + `verifyApprovalBoundary` + approval 消费 + `prepareAuditInsert`）+ R45 S1 数据库不变量 + S2 身份指纹口径 + S3 projector。
- `OSS_CANDIDATE` = 无新增依赖（`OSS_DECISION = EXISTING`；LICENSE / COMMERCIAL_USE / LICENSE_RISK = n/a）。
- `NEW_RISK_BOUNDARY` = **YES**（新增四个受保护写动作 = 审批/HITL 边界 + 一致性边界；无新 Schema）。
- `ARCH_REVIEW_REQUIRED` = **YES**。
- 下一步：PASS → **R45 S5（只读 consistency checker + full regression 收口）**；REVISE → 按 CHANGE 修订；BLOCK → 停止。
