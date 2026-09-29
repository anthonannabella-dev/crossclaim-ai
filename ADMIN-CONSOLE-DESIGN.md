# ADMIN CONSOLE — DESIGN（R0）

> 类型：**Design Only**（MSG-20260929-33 NEXT：Admin Console = DESIGN-FIRST）
> PREVIOUS: MSG-20260929-33（Notification 收口 PASS_CLOSE / NOTIFICATION_LAYER_READY；Admin 范围受限）
> 分支 `gate/7-commercial-validation` · Codex · 2026-09-29 · ROUND: **R0**

**定位（架构方原话）**：Admin 是**运营可观测层**，不是超级管理员危险入口。
本文件只定义：**模块范围 → 数据来源 → 权限 → 查询模型 → 明确不做**。

---

## 0. v1 明确不做（MSG-20260929-33 已划定）

| 禁止项 | 原因 |
|---|---|
| ❌ 权限编辑中心 | RBAC 变更属安全域，需单独设计 + 审计 + 双人复核 |
| ❌ 平台配置 | 影响连接器语义，属对外接入边界 |
| ❌ API Key / 凭据管理 | 凭据生命周期属 HOST APPROVAL REQUIRED 级别 |
| ❌ 自动化开关管理 | 直接触及「自动提交/自动扣佣」红线 |
| ❌ 资金操作后台 | 资金链路（Settlement / Billing / Fee）必须留在既有受控流程 |

同时沿用既有红线：自动提交 FORBIDDEN、自动扣佣 HOLD、平台轮询 HOLD、
本模块**不产生任何写路径**、不新增表、不新增 migration。

---

## 1. 模块范围（v1：六个只读模块）

| # | 模块 | 回答的问题 | 数据来源（既有） |
|---|---|---|---|
| A1 | **Tenant Overview** | 这个租户现在是什么状态？ | `Organization` / `Membership` / `Session` / `SourceConnection` / `AuditLog`（最近活动时间） |
| A2 | **User / Membership View** | 谁在这里、什么角色、是否启用？ | `User` / `Membership`（**只读**；角色变更不在 v1） |
| A3 | **Audit Explorer** | 最近发生了什么？谁做的？ | `AuditLog`（只增不改；只读检索） |
| A4 | **Import / Validation Operations** | 数据进得来吗？哪里卡住？ | `ImportBatch` / `SourceTransaction` / 既有导入审计动作 |
| A5 | **Recovery Review Queue** | 哪些高额回收在等人工复核？ | 既有 `recovery-review` 只读状态 + `recovery.review_*` 审计 |
| A6 | **System Health** | 系统与队列是否健康？ | 既有 `/health` 探针 + 既有计数（不做新埋点） |

### 1.1 关键设计约束：**观测与操作分离**

* Admin Console **只呈现**；任何真正的状态变更仍走既有受控端点（例如 A5 的复核批准仍调用既有 `recovery-review` 流程，不在 Admin 内新增按钮语义）。
* 每个模块只允许 **GET**；页面上的「操作」一律是**深链到既有流程**，不新增写入口。
* 读取不写 `AuditLog`（与看板/通知一致：审计只记录状态变更）。

---

## 2. 权限（复用既有矩阵，不新增权限键）

建议与理由（**待裁决 D1**）：

| 模块 | 建议可见角色 | 理由 |
|---|---|---|
| A1 Tenant Overview | OWNER / ADMIN | 含跨域计数（成员、连接、数据量） |
| A2 User/Membership View | OWNER / ADMIN | 成员与角色属治理信息 |
| A3 Audit Explorer | OWNER / ADMIN | 跨域审计检索；按 actor 过滤需 D2 裁决 |
| A4 Import/Validation Operations | OWNER / ADMIN / OPS | 导入是 OPS 的日常工作面 |
| A5 Recovery Review Queue | OWNER / ADMIN | 与 `claimTrackingApprove` 同口径 |
| A6 System Health | OWNER / ADMIN / OPS | 运维可观测，不含金额与客户数据 |

硬规则（沿用既有原则）：

1. **VIEWER 一律 403**（fail-closed）。
2. 金额与客户文本**不进入** Admin Console（Admin 只做计数、状态、引用；金额仍在看板/账单域并受 `viewBilling` 约束）。
3. 越权统一 403，不泄露资源存在性。
4. 若某角色只能看部分模块，响应结构必须**显式列出 `denied`**（与看板一致）。

---

## 3. 查询模型

```
GET /admin/tenant-overview
GET /admin/members?cursor=&limit=
GET /admin/audit?action=&actorUserId=&entityType=&entityId=&from=&to=&cursor=&limit=
GET /admin/imports?cursor=&limit=
GET /admin/recovery-review?cursor=&limit=
GET /admin/system-health
```

* 全部 **GET + 只读**；强制 `organizationId` 注入（Admin v1 是**单租户内**的运维视图，不做跨租户平台后台）。
* 游标分页（沿用看板口径：`base64url(sortMillis|id)`，单页上限 100，默认 25）。
* A3 审计检索额外约束：`from`/`to` 窗口上限 30 天（与看板 window 同思路，避免大扫描）；默认按 `createdAt` 倒序。
* A6 直接复用既有健康探针结果，不新增埋点、不新增外部依赖。

---

## 4. 安全与合规要点

1. **凭据零暴露**：任何模块不得返回 `storageKey`、token、密钥、连接凭据；连接只露状态与类型。
2. **审计不可篡改**：A3 只读检索；不提供编辑/删除（与 `AuditLog` 只增不改一致）。
3. **最小必要**：A3 默认不返回 `changes` 全文，只返回动作与实体引用；需要详情时逐条 GET（D3 待裁决）。
4. **治理动作不在 v1**：成员角色变更、凭据轮换、平台配置一律不在此模块实现。
5. **可观测依赖**：`GET /admin/system-health` 必须能在数据库只读或降级状态下仍然返回（健康探针不因单点故障整体失败）。

---

## 5. 实现阶段验收（等 GO 后提交）

1. 六个模块端点均为 **GET**；代码层无创建/更新/删除调用（静态断言 + 请求前后快照）。
2. 角色矩阵用例：OWNER/ADMIN 全量；OPS 仅 A4/A6；FINANCE 与 VIEWER → 403（或按 D1 裁决调整）。
3. 金额与客户文本零出现（响应 JSON 断言不含金额字段与 Claim 正文）。
4. 凭据零出现（断言响应中不存在 `storageKey` / token / credential 字段）。
5. 租户隔离：A 租户响应不含 B 任何行（真实库断言）。
6. A3 窗口约束：`from/to` 超过 30 天 → 400；非法 `cursor` → 400。
7. 性能：A3/A4 命中既有索引，附 `EXPLAIN` 证据。

---

## 6. 请裁决

NEED: **GO / REVISE / HOLD**（ADMIN-CONSOLE-DESIGN）

* **D1 Admin Console 的可见角色**：建议 **OWNER / ADMIN 专属**（OPS 例外见 A4/A6），还是允许 OPS 更广、FINANCE 单独可见？
* **D2 Audit Explorer 是否允许按 `actorUserId` 反查**（「某人做过什么」）？还是只允许按时间/动作/实体查询（避免员工监控感）？
* **D3 审计详情粒度**：列表只返回动作与实体引用、详情逐条 GET（建议）；还是一次性返回 `changes` 摘要？
* **D4 六个模块是否全部进 v1**：建议 **A1 + A3 + A6 先做**（概览 / 审计 / 健康），A2/A4/A5 随后（避免一次交付过宽）。

> 边界未变：只读、无新表、无写路径、无外部渠道、无资金操作；自动提交 FORBIDDEN、自动扣佣 HOLD。
