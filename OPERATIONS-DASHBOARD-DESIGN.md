# OPERATIONS DASHBOARD — DESIGN（R1：按 MSG-20260929-29 修订）

> 类型：**Design Only**（MSG-20260929-28 NEXT 1：Operations Dashboard = DESIGN-FIRST）
> PREVIOUS: MSG-20260929-29（**GO_WITH_MINOR_REVISE**：D1 REVISE / D2 HOLD / D3 GO + 两项新增验收）
> 分支 `gate/7-commercial-validation` · Codex · 2026-09-29 · ROUND: **R1**

**本文件不定义任何 UI。** 只定义：**指标 → 数据来源 → 权限 → 查询模型**。
不含新表、不含 migration、不含写路径、不含对外动作。

---

## 0. 目标与边界

现状已具备四类事实：`Claim`（申诉生命周期）、`ClaimItem`（损失事件归一化）、
`Settlement` + `RecoveryPayout`（确认轴 + 到账轴）、`AuditLog`（留痕）。

**缺口**：没有任何「一个运营在同一屏里看到今天该干什么」的读模型。本设计只做**读**。

### 0.1 已被架构方确认的核心原则（MSG-20260929-29 §二）

```
Business Fact → AuditLog / Domain Data → Dashboard Projection     ✅
Dashboard Action → 直接修改 Claim / Settlement                    ❌ 禁止
```

因此：看板**永远不是写入口**，也不承载任何自动动作。实现阶段必须有一条测试断言
「GET dashboard 不产生任何 mutation」。

明确不做（本设计范围外）：

* 不新增表 / 不新增 migration / 不改任何 Schema
* 不做 UI 组件与视觉稿
* 不做导出（CSV/Excel）、不做定时报表、不做邮件/IM 推送（属 Notification，NEXT 2）
* 不触发任何写操作、任何对外请求、任何平台轮询
* **v1 不做 Case 聚合层**（D2 = HOLD；未来单独 `CASE-VIEW-DESIGN`）
* 不做跨租户聚合（多租户平台级统计属 Admin，NEXT 3）

---

## 1. 指标（METRICS）

### 1.1 Claim Pipeline（申诉管线）

每个桶由**已存在字段**精确定义（无新字段）：

| 桶 | 判定条件（服务端谓词） | 运营含义 |
|---|---|---|
| 草稿 / 待提交确认 | `status = DRAFT` | AI 已起草，等待人工批准提交（**不再叫「待确认」**，D-DRAFT） |
| **待回执** | `status IN (SUBMITTED, ACKNOWLEDGED)` **且无 response event** | 已提交/已受理，但平台尚未给出任何回应 |
| 到期临近 | `status IN (SUBMITTED, ACKNOWLEDGED) AND dueAt BETWEEN now AND now + W` | 必须在窗口内推进，否则失权 |
| 已批准（待确认回收） | `status = APPROVED` | 平台已批准，等待录入回收事实 |
| 部分批准 | `status = PARTIALLY_APPROVED` | 有 `responseAmount`，需人工决定是否接受 |
| 终局 | `status IN (REJECTED, NO_RESPONSE, WITHDRAWN)` | 已关闭，只读留档 |

#### D1 修订：待回执的判定（**不得用 `dueAt`**）

MSG-20260929-29 D1 = REVISE：`dueAt` 表示**截止时间**，不表示**是否收到回执**；
`SUBMITTED + dueAt=2026-10-10` 但平台毫无回应，仍属「待回执」。

修订后的「response event」判定（**读既有数据，不新增字段**）：

```
response event 存在 ⇔  Claim.respondedAt IS NOT NULL
                    OR AuditLog 存在该 Claim 的响应类事件
                       （claim.response_recorded / claim.terminal_recorded）

待回执 ⇔ status IN (SUBMITTED, ACKNOWLEDGED) AND 无 response event
```

* 主判定用既有列 `Claim.respondedAt`（语义精确、零新增字段）；
* 事件投影（`AuditLog`）作为**交叉校验**：若某 Claim 已有响应类事件但 `respondedAt` 为空，按「有回执」处理并计入数据异常角标（不静默）。
* 到期临近与待回执是**两个独立维度**：同一条 Claim 可以同时出现在两个桶中（一个看「是否该催」，一个看「是否快到期」）。

补充约束（与既有不变量一致）：

* `dueAt IS NOT NULL` 的行必须同时有 `deadlineSource`（I1）；看板对违反者单列「数据异常」角标而不是隐藏。
* 「草稿 / 待提交确认」桶**只在存在 commercial terms 的案件上计数**（无费率不得进入回收链路）。

### 1.2 Recovery（回收与到账）

| 指标 | 定义 | 来源 |
|---|---|---|
| Confirmed | Σ `Settlement.amount`（`confirmationStatus = CONFIRMED`） | `Settlement` |
| Receivable / Outstanding | Σ `max(confirmed - received, 0)` | **投影** |
| Received | Σ `RecoveryPayout.amount` | `RecoveryPayout` |
| Variance | received − confirmed（可正可负） | **投影** |
| 待确认 | 计数：`confirmationStatus = PENDING_CONFIRMATION` | `Settlement` |
| 待对账 | 计数：`reconciliationStatus IN (NOT_STARTED, PARTIAL)` | `Settlement` |
| 争议 | 计数 + 金额：`reconciliationStatus = DISPUTED` | `Settlement` |
| 已冲回 | 计数：`reconciliationStatus = REVERSED` | `Settlement` |

投影口径**唯一**（MSG-20260929-26 C3）：`receivedAmount = Σ RecoveryPayout.amount`，**不落库**；
`confirmedAmount = Settlement.amount`。Outstanding / Variance **都是投影**，
**绝不写回 Settlement**（MSG-20260929-29 §六明确要求）。

### 1.3 Loss Pool（损失事件池，支撑管线供给）

| 指标 | 定义 |
|---|---|
| 待核验 | `ClaimItem.status IN (DISCOVERED)` |
| 需人工复核 | `status = REVIEW_REQUIRED`（起必须入案） |
| 可申诉 | `status = READY_TO_APPEAL` |
| 已人工提交 | `status = SUBMITTED_MANUAL` |
| 已回收 / 已关闭 | `status IN (RECOVERED, CLOSED)` |

### 1.4 时效与老化（SLA / Aging）

只做**离散桶**（避免看板变成第二个事实源）：

* 到期临近：`dueAt ∈ [now, now+W)`；已逾期：`dueAt < now AND status` 非终局
* 停留时长：由 `AuditLog` 的相邻事件时间差计算（`DRAFT→SUBMITTED`、`SUBMITTED→ACKNOWLEDGED`、`ACKNOWLEDGED→终局`），**不新增时间戳字段**

---

## 2. 数据来源（SOURCES）

| 指标族 | 权威来源 | 读法 |
|---|---|---|
| Claim Pipeline | `Claim`（状态 + `respondedAt` + `dueAt`/`deadlineSource`/`platformCaseRef`） | 单表过滤 + `@@index([organizationId, status, dueAt])` |
| Response event 交叉校验 | `AuditLog` | 既有 `listAuditTrail` 投影 |
| 到期临近 / 逾期 | `Claim` | 复用 `listExpiringClaims`（只列非终局 + 窗口内，按到期升序） |
| Recovery 计数与金额 | `Settlement` + `RecoveryPayout` | `readProjection` / `projectRecoveryState`（已批准投影） |
| Loss Pool | `ClaimItem` | 单表过滤 + `@@index([organizationId, status, occurredAt])` |
| 时效差 | `AuditLog` | 既有 `listAuditTrail`（只读，不新增历史表） |

**权威性原则**（沿用 MSG-20260929-25）：业务事实 → AuditLog → Projection。
看板是投影，任何时候都必须能从权威表重算；看板**不得**成为写入目标。

---

## 3. 权限（PERMISSIONS）

复用既有权限矩阵，**本设计不新增权限键**：

| 指标族 | 所需权限 | OWNER | ADMIN | OPS | FINANCE | VIEWER |
|---|---|---|---|---|---|---|
| Claim Pipeline（状态计数） | `claimTrackingApprove` **或** `claimTrackingReceive` | ✅ | ✅ | ✅ | ❌ | ❌ |
| Claim 文本 | `viewClaimText` | ✅ | ✅ | ✅ | ❌ | ❌ |
| Claim 金额 | `viewClaimAmounts` | ✅ | ✅ | ✅ | ❌ | ❌ |
| Recovery 计数/状态 | `claimTrackingApprove` | ✅ | ✅ | ❌ | ❌ | ❌ |
| Recovery 金额（Confirmed/Received/Outstanding/Variance） | `viewBilling` **且** `recoveryPayoutRecord` | ✅ | ✅ | ❌ | ✅ | ❌ |
| Loss Pool 汇总 | `viewClaimItemSummary` | ✅ | ✅ | ✅ | ✅（受限字段） | ❌ |

规则：

1. **字段级裁剪先于聚合**：无权查看金额的角色，其响应中**不存在金额键**（不是 `amount: 0`）。
   MSG-20260929-29 §二明确：返回 0 会造成信息泄露与业务误解。
2. **FINANCE 的既有限制不变**：可看 Recovery 金额与 Loss Pool 受限字段，不可看 Claim 文本/金额/证据。
3. **VIEWER 一律 fail-closed**（`permissionsFor` 返回 `DENY_ALL`）。
4. 越权请求返回**统一 403**，不得通过错误差异泄露资源存在性。

---

## 4. 查询模型（QUERY MODEL）

### 4.1 形状

```
GET /operations/dashboard?window=7d            → 一次性汇总（默认 7d）
GET /operations/claims?bucket=<bucket>&cursor   → 单桶明细（游标分页）
GET /operations/recovery?cursor                 → 回收与到账明细
```

* 全部为 **GET + 只读**；无 POST/PATCH。
* 所有查询强制 `organizationId` 注入（禁止「先查再判」）。
* 响应结构：`{ generatedAt, window, metrics: {...}, buckets: {...} }`（汇总与明细分离）。

### 4.2 D3：窗口参数化

* `window` 默认 `7d`；允许 `1d / 7d / 14d / 30d`。
* **上限 30d**：超过即 `400 INVALID_WINDOW`（禁止 `window=3650` 这类大扫描）。

### 4.3 分页与排序

* 明细一律**游标分页**（`(dueAt, id)` 或 `(occurredAt, id)`），不使用 offset。
* 到期桶按 `dueAt` **升序**；其余桶按更新时间倒序。
* 单页上限 100；默认 25。

### 4.4 计算与一致性

* 汇总为**即时计算**（no cache table）；同一请求内用**同一 `generatedAt`**。
* 金额一律 `Decimal(18,4)`、HALF_UP、字符串输出（禁 `float`）。
* 不做跨租户聚合；不做全表扫描：每个桶必须命中既有索引
  （`Claim(organizationId,status,dueAt)`、`ClaimItem(organizationId,status,occurredAt)`、
  `Settlement(organizationId,confirmationStatus)`、`Settlement(organizationId,reconciliationStatus)`、
  `RecoveryPayout(organizationId,receivedAt)`）。
* 若某桶需要新索引 → 单独提 **Index Delta** 审核（本设计不请求）。

### 4.5 审计与可观测性

* 看板**本身是读操作，不写 AuditLog**（审计只记录状态变更）。
* 若未来需要导出，导出行为**必须**单独设计并审计（当前明确不做）。
* 每个查询端点输出结构化计数日志（桶名、行数、耗时），不含金额与文本。

---

## 5. 验收（实现阶段）

1. 每个桶的谓词与 §1 表格**逐字一致**，并有单测（含边界：`dueAt = now`、无 `deadlineSource`、终局不进入到期桶）。
2. **D1 专项**：`SUBMITTED + dueAt 非空 + respondedAt 为空` → 必须落在「待回执」；`respondedAt` 非空 → 不落在「待回执」。
3. 投影复用既有 `projectRecoveryState` / `listExpiringClaims`，不复制一份新实现。
4. **新增（MSG-20260929-29 §八.1）**：dashboard **不得成为写入口** —— 断言仅有 GET 路由，且请求前后相关表行数与 `updatedAt` 不变（no mutation）。
5. **新增（MSG-20260929-29 §八.2）**：金额裁剪测试至少覆盖 **VIEWER / FINANCE / OWNER** 三种角色
   （VIEWER：403；FINANCE：有 Recovery 金额、无 Claim 金额键；OWNER：齐全）。
6. 租户隔离用例：A 租户汇总不得包含 B 租户任何行（真实库断言）。
7. 性能：每个桶在合成数据集上命中索引（输出 `EXPLAIN` 供审计）。
8. 窗口约束用例：`window=31d` / `window=3650` → 400。

---

## 6. 对本裁决的落实（R1 修订记录）

| 裁决项 | 处置 |
|---|---|
| D1 REVISE（待回执不得用 dueAt） | §1.1 改为 `status IN (SUBMITTED, ACKNOWLEDGED) AND 无 response event`；response event 主判定 = `Claim.respondedAt`，`AuditLog` 事件作交叉校验；§5.2 增加专项用例 |
| D2 HOLD（v1 不做 Case 聚合） | §0 明确排除；未来单独 `CASE-VIEW-DESIGN` |
| D3 GO（窗口参数化） | §4.2：默认 7d、上限 30d、越界 400 |
| 命名（「待确认」易误解） | §1.1 改为「草稿 / 待提交确认」（Draft） |
| 新增验收 1（不得成为写入口） | §5.4 |
| 新增验收 2（金额裁剪覆盖三角色） | §5.5 |

---

## 7. 实现边界（MSG-20260929-29 已批准）

**允许**：GET 查询端点 · Projection service · 权限裁剪 · 游标分页 · 查询测试。

**禁止**：新事实表 · 写路径 · 自动动作 · 规则判断扩展 · Billing 修改。

其余边界未变：自动提交 FORBIDDEN、自动扣佣 HOLD、平台轮询 HOLD、金额口径零改动。
