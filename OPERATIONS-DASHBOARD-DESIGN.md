# OPERATIONS DASHBOARD — DESIGN

> 类型：**Design Only**（MSG-20260929-28 NEXT 1：Operations Dashboard = DESIGN-FIRST）
> PREVIOUS: MSG-20260929-28（Recovery Confirmation 收口；排出 1 Dashboard → 2 Notification → 3 Admin）
> 分支 `gate/7-commercial-validation` · Codex · 2026-09-29

**本文件不定义任何 UI。** 只定义：**指标 → 数据来源 → 权限 → 查询模型**。
不含新表、不含 migration、不含写路径、不含对外动作。

---

## 0. 目标与边界

现状已具备四类事实：`Claim`（申诉生命周期）、`ClaimItem`（损失事件归一化）、
`Settlement` + `RecoveryPayout`（确认轴 + 到账轴）、`AuditLog`（留痕）。

**缺口**：没有任何「一个运营在同一屏里看到今天该干什么」的读模型。本设计只做**读**。

明确不做（本设计范围外）：

* 不新增表 / 不新增 migration / 不改任何 Schema
* 不做 UI 组件与视觉稿
* 不做导出（CSV/Excel）、不做定时报表、不做邮件/IM 推送（属 Notification，NEXT 2）
* 不触发任何写操作、任何对外请求、任何平台轮询
* 不做跨租户聚合（多租户平台级统计属 Admin，NEXT 3）

---

## 1. 指标（METRICS）

### 1.1 Claim Pipeline（申诉管线）

按 MSG-20260929-28 要求的口径，每个桶由**已存在字段**精确定义（无新字段）：

| 桶 | 判定条件（服务端谓词） | 运营含义 |
|---|---|---|
| 待确认（待批准提交） | `status = DRAFT` | AI 已起草，等待人工批准提交 |
| 已提交 | `status = SUBMITTED` | 已人工提交，等待平台受理 |
| 待回执 | `status = ACKNOWLEDGED AND dueAt IS NULL` | 平台已受理（有 `platformCaseRef`）但无到期日 |
| 到期临近 | `status IN (SUBMITTED, ACKNOWLEDGED) AND dueAt BETWEEN now AND now + W`（W 默认 7 天） | 必须在窗口内推进，否则失权 |
| 已批准（待确认回收） | `status = APPROVED` | 平台已批准，等待录入回收事实 |
| 部分批准 | `status = PARTIALLY_APPROVED` | 有 `responseAmount`，需人工决定是否接受 |
| 终局 | `status IN (REJECTED, NO_RESPONSE, WITHDRAWN)` | 已关闭，只读留档 |

补充约束（与既有不变量一致）：

* `dueAt IS NOT NULL` 的行必须同时有 `deadlineSource`（I1）；看板对违反者单列「数据异常」角标而不是隐藏。
* 「待确认」桶**只在存在 commercial terms 的案件上计数**（无费率不得进入回收链路）。

### 1.2 Recovery（回收与到账）

| 指标 | 定义 | 来源 |
|---|---|---|
| Confirmed | Σ `Settlement.amount`（`confirmationStatus = CONFIRMED`） | `Settlement` |
| Receivable / Outstanding | Σ `max(confirmed - received, 0)` | 投影 |
| Received | Σ `RecoveryPayout.amount` | `RecoveryPayout` |
| Variance | received − confirmed（可正可负） | 投影 |
| 待确认 | 计数：`confirmationStatus = PENDING_CONFIRMATION` | `Settlement` |
| 待对账 | 计数：`reconciliationStatus IN (NOT_STARTED, PARTIAL)` | `Settlement` |
| 争议 | 计数 + 金额：`reconciliationStatus = DISPUTED` | `Settlement` |
| 已冲回 | 计数：`reconciliationStatus = REVERSED` | `Settlement` |

投影口径**唯一**（MSG-20260929-26 C3）：`receivedAmount = Σ RecoveryPayout.amount`，**不落库**；
`confirmedAmount = Settlement.amount`；两者不得在报表层各存一份。

### 1.3 Loss Pool（损失事件池，支撑管线供给）

| 指标 | 定义 |
|---|---|
| 待核验 | `ClaimItem.status IN (DISCOVERED)` |
| 需人工复核 | `status = REVIEW_REQUIRED`（起必须入案） |
| 可申诉 | `status = READY_TO_APPEAL` |
| 已人工提交 | `status = SUBMITTED_MANUAL` |
| 已回收 / 已关闭 | `status IN (RECOVERED, CLOSED)` |

### 1.4 时效与老化（SLA / Aging）

不做实时计时器，只做**离散桶**（避免看板变成第二个事实源）：

* 到期临近：`dueAt ∈ [now, now+7d)`
* 已逾期：`dueAt < now AND status` 非终局
* 停留时长：由 `AuditLog` 的相邻事件时间差计算（`DRAFT→SUBMITTED`、`SUBMITTED→ACKNOWLEDGED`、`ACKNOWLEDGED→终局`），**不新增时间戳字段**

---

## 2. 数据来源（SOURCES）

| 指标族 | 权威来源 | 读法 |
|---|---|---|
| Claim Pipeline | `Claim`（状态 + `dueAt`/`deadlineSource`/`platformCaseRef`） | 单表过滤 + `@@index([organizationId, status, dueAt])` |
| 到期临近 / 逾期 | `Claim`（同上） | 复用 `listExpiringClaims` 投影（只列非终局 + 窗口内，按到期升序） |
| Recovery 计数与金额 | `Settlement` + `RecoveryPayout` | `readProjection` / `projectRecoveryState`（已批准投影） |
| Loss Pool | `ClaimItem` | 单表过滤 + `@@index([organizationId, status, occurredAt])` |
| 时效差 | `AuditLog` | 既有 `listAuditTrail`（读侧只读，不新增历史表） |

**权威性原则**（沿用 MSG-20260929-25）：业务事实 → AuditLog → Projection。
看板是投影，任何时候都必须能从权威表重算；看板**不得**成为写入目标。

---

## 3. 权限（PERMISSIONS）

复用既有权限矩阵，**本设计不新增权限键**：

| 指标族 | 所需权限 | OWNER | ADMIN | OPS | FINANCE | VIEWER |
|---|---|---|---|---|---|---|
| Claim Pipeline（状态计数） | `claimTrackingApprove` **或** `claimTrackingReceive`（任一即可读状态） | ✅ | ✅ | ✅ | ❌ | ❌ |
| Claim 文本 | `viewClaimText` | ✅ | ✅ | ✅ | ❌ | ❌ |
| Claim 金额 | `viewClaimAmounts` | ✅ | ✅ | ✅ | ❌ | ❌ |
| Recovery 计数/状态 | `claimTrackingApprove`（确认轴语义） | ✅ | ✅ | ❌ | ❌ | ❌ |
| Recovery 金额（Confirmed/Received/Outstanding/Variance） | `viewBilling` **且** `recoveryPayoutRecord` | ✅ | ✅ | ❌ | ✅ | ❌ |
| Loss Pool 汇总 | `viewClaimItemSummary` | ✅ | ✅ | ✅ | ✅（受限字段） | ❌ |

规则：

1. **字段级裁剪先于聚合**：无权查看金额的角色，其响应中不得出现任何金额（不是「显示为 0」）。
2. **FINANCE 的既有限制不变**：可看 Recovery 金额与 Loss Pool 受限字段，不可看 Claim 文本/金额/证据。
3. **VIEWER 一律 fail-closed**（`permissionsFor` 返回 `DENY_ALL`）。
4. 越权请求返回**统一 403**，不得通过错误差异泄露资源存在性。

---

## 4. 查询模型（QUERY MODEL）

### 4.1 形状

```
GET /operations/dashboard?window=7d          → 一次性汇总（默认窗口 7 天）
GET /operations/claims?bucket=<bucket>&cursor → 单桶明细（游标分页）
GET /operations/recovery?cursor              → 回收与到账明细
```

* 全部为 **GET + 只读**；无 POST/PATCH。
* 所有查询强制 `organizationId` 注入（禁止「先查再判」）。
* 响应结构：`{ generatedAt, window, metrics: {...}, buckets: {...} }`（汇总与明细分离，避免一次拉全量）。

### 4.2 分页与排序

* 明细一律**游标分页**（`(dueAt, id)` 或 `(occurredAt, id)`），不使用 offset（防止深翻页漂移）。
* 到期桶按 `dueAt` **升序**（最紧急在前）；其余桶按更新时间倒序。
* 单页上限 100；默认 25。

### 4.3 计算与一致性

* 汇总为**即时计算**（no cache table）；同一次请求内用**同一 `generatedAt`**，避免跨桶时间漂移。
* 金额一律 `Decimal(18,4)`、HALF_UP、字符串输出（禁 `float`）。
* 不做跨租户聚合；不做全表扫描：每个桶必须命中既有索引（`Claim(organizationId,status,dueAt)`、`ClaimItem(organizationId,status,occurredAt)`、`Settlement(organizationId,confirmationStatus)`、`Settlement(organizationId,reconciliationStatus)`、`RecoveryPayout(organizationId,receivedAt)`）。
* 若某桶需要新索引 → 单独提 **Index Delta** 审核（本设计不请求）。

### 4.4 审计与可观测性

* 看板**本身是读操作，不写 AuditLog**（审计只记录状态变更，不记录「谁看了一眼」）。
* 若未来需要导出，导出行为**必须**单独设计并审计（当前明确不做）。
* 每个查询端点输出结构化计数日志（桶名、行数、耗时），不含金额与文本。

---

## 5. 验收（实现阶段，等 GO 后提交）

1. 每个桶的谓词与 §1 表格**逐字一致**，并有单测（含边界：`dueAt = now`、无 `deadlineSource`、终局不进入到期桶）。
2. 投影复用既有 `projectRecoveryState` / `listExpiringClaims`，不复制一份新实现。
3. 字段级裁剪用例：FINANCE 响应中**不存在**任何 Claim 文本/金额键；VIEWER 全部 403。
4. 租户隔离用例：A 租户的汇总不得包含 B 租户任何行（真实库断言）。
5. 性能：每个桶在合成数据集上命中索引（输出 `EXPLAIN` 供审计）。
6. 无写入：端点级断言（只允许 GET）+ 代码层不出现任何 `create/update/delete` 调用。

---

## 6. 请裁决

NEED: **GO / REVISE / HOLD**（OPERATIONS-DASHBOARD-DESIGN）

待确认的三个设计取舍：

* D1 桶口径是否接受「待回执 = ACKNOWLEDGED 且无 dueAt」这一定义？（备选：把 SUBMITTED 也算作待回执）
* D2 看板是否需要**按案件（Case）聚合**的第二层视图，还是先只做租户级汇总 + 明细？
* D3 过期与到期临近的窗口 `W` 是否固定 7 天，还是做成 `window` 查询参数（默认 7d，上限 30d）？

**提醒**：本设计不含 UI、不含新表、不含金额口径改动；`auto commission` 与 `auto submission` 状态不变。
