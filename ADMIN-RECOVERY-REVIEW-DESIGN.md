# ADMIN — RECOVERY REVIEW QUEUE — DESIGN（P3 / A5, R0）

> 类型：**Design Only**（MSG-20260929-36-A：P3 = A5 Recovery Review Queue，先提交本设计稿）
> PREVIOUS: MSG-20260929-36-A（Admin Phase 2 = PASS_CLOSE / IMPORT_VALIDATION_OBSERVABILITY_READY）
> 分支 `gate/7-commercial-validation` · Codex · 2026-09-29 · ROUND: **R0**

**最大风险不是 UI，而是人工流程与状态推进的边界。** 本设计只做「看」与「跳」。

---

## 0. 允许 / 禁止（MSG-20260929-36-A 已划定）

| 可以（只读） | 不可以（一律禁止） |
|---|---|
| 查看待审核项 | ❌ Admin 页面直接 Approve |
| 查看审核状态 | ❌ Admin 页面直接 Reject |
| 查看证据引用 | ❌ 修改 Recovery 状态 |
| 查看审核要求（阈值/原因） | ❌ 修改金额 |
| **跳转**到既有审核流程 | ❌ 创建 Settlement |
| — | ❌ 触发扣佣 |
| — | ❌ 提交 Claim |

**任何操作路径**必须是：

```
Admin Console（只读视图）
        ↓（深链，不是按钮动作）
既有 Recovery Review Service
        ↓
既有 Permission Check
        ↓
AuditLog
```

即：Admin 不新增审批端点、不复制审批逻辑；审批仍由既有 `recovery-review` 端点承担（其权限、审计、状态机不变）。

---

## 1. 数据来源（全部既有）

| 视图内容 | 权威来源 |
|---|---|
| 待审核项清单 | 既有 `recovery-review` 只读状态 + `recovery.review_required` 审计（高额阈值触发） |
| 当前审核状态 | 既有 review 状态读取（`APPROVED` / `REJECTED` / `REQUIRED`），**不在 Admin 内推导新状态** |
| 证据引用 | 案件 ↔ 证据联结（只返回**引用与元数据**，不返回文件内容、不返回 storageKey） |
| 审核要求 | 既有阈值与原因码（`recovery.review_required` 审计中的 changes 白名单字段） |

---

## 2. 视图与状态桶（固定映射，不新建状态机）

| 桶 | 判定（复用既有事实） | 运营含义 |
|---|---|---|
| 待人工复核 | 存在 `recovery.review_required` 且尚无对应 `review_approved`/`review_rejected` | 需要 OWNER/ADMIN 处置 |
| 已通过 | 存在 `recovery.review_approved` | 可继续既有回收确认流程 |
| 已驳回 | 存在 `recovery.review_rejected` | 需在既有流程内重新提交 |

补充信息一律用**角标**（与 A4 同口径）：`HIGH_VALUE`（触发阈值）、`AGED`（超 N 天未处置）、`MISSING_EVIDENCE_REF`（无证据引用，需人工补）。

---

## 3. 查询模型（草案）

```
GET /admin/recovery-review?bucket=&cursor=&limit=
GET /admin/recovery-review/:caseId
```

* 全部 GET + 只读；强制 `organizationId`；游标分页沿用既有口径（默认 25、上限 100）。
* 不提供任何写端点、不提供导出、不提供下载（沿用 A4 的 D5 结论）。
* 金额：**不在 Admin 展示**（沿用 D4；如需金额请在既有 Recovery/Billing 域查看）。

---

## 4. 权限（沿用 D1 角色表；本设计不新增权限键）

| 视图 | 角色 |
|---|---|
| A5 只读清单与详情 | OWNER / ADMIN + **既有 review 权限**（`claimTrackingApprove` 语义，与既有审核一致） |
| 跳转目标（审批动作） | 由**既有** recovery-review 端点自行校验（Admin 不参与授权判断） |
| FINANCE / VIEWER | 403（FINANCE v1 不进入 Admin；VIEWER fail-closed） |

> 与 A4 的区别：A5 只读视图**可以**由 OWNER/ADMIN 查看；任何审批动作都发生在既有端点内，Admin 不代为授权。

---

## 5. 实现阶段验收（等 GO 后提交）

1. 端点全为 GET；代码层无 create/update/delete（静态断言 + 前后快照）。
2. 桶映射为固定映射单测（待复核 / 已通过 / 已驳回 + 三个角标）。
3. 租户隔离：A 看不到 B 的待审核项与证据引用（真实库断言）。
4. 证据引用只含 `evidenceId` / `kind` / `role` 等元数据；**不含** `storageKey`、文件内容、金额（禁键扫描）。
5. 无审批捷径：断言不存在 Admin 审批端点；审批仍由既有端点承担（同一权限与审计）。
6. 只读证明：读取前后 `Case` / `Claim` / `Settlement` / `AuditLog` 快照一致。

---

## 6. 请裁决

NEED: **GO / REVISE / HOLD**（ADMIN-RECOVERY-REVIEW-DESIGN）

* **D1 状态桶**：三桶（待人工复核 / 已通过 / 已驳回）+ 角标（HIGH_VALUE / AGED / MISSING_EVIDENCE_REF）是否接受？
* **D2 证据呈现粒度**：仅 `evidenceId` + `kind` + `role` + `capturedAt`（建议），还是需要标题/描述等元数据？
* **D3 跳转语义**：确认 Admin 只提供**深链**到既有 `recovery-review` 流程（不新增审批端点、不复用其权限判断）？
* **D4 金额**：确认 Admin 内**不展示任何金额**（含阈值金额），仅展示「已触发高额复核」这一事实？
* **D5 时效**：`AGED` 角标的阈值（建议 7 天）与是否需要在清单顶部单独列出「超期未处置」分组？

> 边界未变：只读、单租户、无新表、无写路径、无审批捷径、无下载、无金额；自动提交 FORBIDDEN、自动扣佣 HOLD。
