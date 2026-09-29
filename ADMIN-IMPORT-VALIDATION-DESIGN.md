# ADMIN — IMPORT / VALIDATION OPERATIONS — DESIGN（P2, R0）

> 类型：**Design Only**（MSG-20260929-35：Phase 2 = A4 Import/Validation Operations，先提交本设计稿）
> PREVIOUS: MSG-20260929-35（Admin Phase 1 = PASS_CLOSE / ADMIN_OBSERVABILITY_LAYER_READY）
> 分支 `gate/7-commercial-validation` · Codex · 2026-09-29 · ROUND: **R0**

**定位**：Admin Phase 1 已建立「运营可观测层」。本阶段把**数据进入系统**这一段也变成可观测的，
依然只读。Admin 仍然不是超级管理员后台。

---

## 0. 允许 / 禁止（MSG-20260929-35 已划定）

| 允许（只读运营能力） | 禁止 |
|---|---|
| ImportBatch 列表 | ❌ 修改 Import |
| Import 状态视图 | ❌ 重跑导入 |
| Validation Run 状态 | ❌ 删除文件 |
| Error Report 展示（只读） | ❌ 修复数据 |
| Quarantine 视图 | ❌ 手工改变状态 |
| 数据质量摘要 | ❌ 下载原始文件（见 D5） |

沿用既有红线：自动提交 FORBIDDEN、自动扣佣 HOLD、平台轮询 HOLD、金额口径零改动。
本阶段**不新增表、不改 Schema、不写 AuditLog**（读取不产生审计）。

---

## 1. 数据来源（全部既有）

| 视图 | 权威来源 |
|---|---|
| 批次列表 / 状态 | `ImportBatch`（含字段映射快照、计数、状态） |
| 原始行计数 | `SourceTransaction`（按 `importBatchId` 聚合） |
| 校验与错误 | 既有导入审计动作（`import.completed` / `import.failed` / `import.retry_completed`）+ 既有错误报告产物 |
| 隔离区（Quarantine） | 既有导入管线中被隔离的行/批次（按既有判定字段与错误码聚合，不新增字段） |
| 数据质量摘要 | 上述来源的派生计数（缺字段/重复/超大文件/冲突），**全部为投影** |

> 原则沿用：业务事实 → 既有审计与领域数据 → 本模块（投影）。看板/Admin 都不得成为事实源。

---

## 2. 状态桶（State Buckets）

`ImportBatch` 的状态桶按**既有状态字段**直接映射，不引入新状态：

| 桶 | 含义 | 运营动作（在既有流程内，不在 Admin 内） |
|---|---|---|
| 处理中 | 批次尚未结束 | 等待；若超时按既有重试策略 |
| 成功 | 完整导入完成 | 无需动作 |
| 部分成功 | 有隔离/跳过行 | 查看错误报告，按需在既有流程重传 |
| 失败 | 未产生有效行 | 查看错误报告与原因码，按既有流程重试 |
| 已重试成功 | 重试后成功 | 无需动作 |

**注意**：Admin **不提供**「重试」按钮；只提供「问题定位 → 深链到既有导入流程」。

---

## 3. 错误展示层级（Error Display Levels）

三级，逐级收敛，避免一次性暴露海量明细：

| 级别 | 内容 | 备注 |
|---|---|---|
| L1 摘要 | 批次数、失败原因码分布、隔离行数、受影响平台 | 默认视图，用于判断「哪里出问题」 |
| L2 批次 | 单个批次的状态、行数、时间线（起止/重试）、原因码计数 | 点击 L1 进入 |
| L3 行级 | 被隔离/失败行的**原因码 + 行号 + 字段名** | **不返回原始行内容**（见 D3） |

约束：L3 默认分页（游标、单页上限 100）；不提供「导出全量错误行」的能力（D5）。

---

## 4. 权限（沿用例分层，不新增权限键）

| 视图 | 角色 | 依据 |
|---|---|---|
| A4 全部只读视图 | OWNER / ADMIN / OPS | MSG-20260929-34 D1（A4 = OWNER/ADMIN/OPS） |
| 涉及平台连接信息的部分 | 仅 OWNER / ADMIN | 连接属治理信息 |
| FINANCE / VIEWER | 403 | FINANCE v1 不进入 Admin；VIEWER fail-closed |

字段裁剪（与看板/通知同口径）：

* 不返回 `storageKey`、凭据、token、原始文件内容；
* 不返回**客户业务原文**（原始行内容），只返回**原因码与字段名**；
* 金额字段（若某平台导出含金额）默认不出现在 L1/L2 摘要中，仅在 OWNER/ADMIN 的 L3 明细中按需出现（D4 待裁决）。

---

## 5. 查询模型（草案）

```
GET /admin/imports?status=&platform=&from=&to=&cursor=&limit=
GET /admin/imports/:batchId
GET /admin/imports/:batchId/errors?cursor=&limit=        # L3（原因码/行号/字段名）
GET /admin/imports/quality-summary?window=7d|30d          # 数据质量摘要
```

* 全部 GET + 只读；强制 `organizationId`；窗口上限 30 天（沿用看板/审计窗口口径）。
* 游标分页沿用既有口径（`base64url(sortMillis|id)`，默认 25、上限 100）。

---

## 6. 请裁决

NEED: **GO / REVISE / HOLD**（ADMIN-IMPORT-VALIDATION-DESIGN）

* **D1 状态桶**：上表五桶划分是否接受？（是否要区分「部分成功」与「失败」以外的中间态，如「等待人工确认」？）
* **D2 错误层级**：L1/L2/L3 三级是否合适？L3 是否需要给出**字段名 + 原因码**以外的最小上下文？
* **D3 原始行内容**：确认 **L3 不返回原始行内容**（只给原因码/行号/字段名）？若运营确需看样本，是否允许「脱敏后的前 N 个字段」？
* **D4 金额字段**：导入数据可能含金额。是否允许在 OWNER/ADMIN 的 L3 明细中出现金额，还是在 Admin 内**一律不展示金额**（推荐后者，保持 Admin 与金额域隔离）？
* **D5 报告下载**：确认 v1 **不提供任何下载**（错误报告/原始文件均不可下载），仅页内只读展示？

> 边界未变：只读、单租户、无新表、无写路径、无外部渠道；不修改 Import、不重跑导入、不删除文件、不修复数据、不手工改状态。
