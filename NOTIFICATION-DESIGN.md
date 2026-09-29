# NOTIFICATION — DESIGN（R1：按 MSG-20260929-32 修订）

> 类型：**Design Only**（MSG-20260929-31 NEXT：Notification = DESIGN-FIRST）
> PREVIOUS: MSG-20260929-32（**GO_WITH_MINOR_REVISE**：D1 PASS / D2 GO / D3 HOLD / **D4 REVISE = 允许有限聚合**）
> 分支 `gate/7-commercial-validation` · Codex · 2026-09-29 · ROUND: **R1**

**本文件只定义：Event → Trigger → Recipient → Template → Permission → Audit。**
不实现任何渠道，不新增任何表，不发起任何对外联系。

---

## 0. 边界（本设计的硬约束）

允许：事件目录、触发语义、收件人解析规则、模板字段契约、权限裁剪、审计要求。

**明确不做**（MSG-20260929-31）：

* ❌ Email provider / SMS / 企业微信 / 任何第三方推送通道
* ❌ 自动外部联系（不联系客户、平台、承运商、保险方）
* ❌ 平台通知发送（不向 Amazon / TikTok / Walmart 等发任何消息）
* ❌ 新增事实表、新增 migration、修改现有 Schema
* ❌ 任何"自动行动"：通知只能**告知人**，不能代替人做决定

与既有边界一致：自动提交 Claim/Appeal = FORBIDDEN；自动扣佣 = HOLD；平台轮询 = HOLD。

---

## 1. 事件目录（EVENT CATALOG）

五个 MSG-20260929-31 指定的必备事件 + 一个候选（默认关闭）。
**全部由既有事实或既有审计动作派生，不新增字段、不新增表。**

| # | eventId | 语义 | 判定来源（既有） | 触发方式 | 缺省严重度 |
|---|---|---|---|---|---|
| N1 | `claim.deadline_approaching` | 申诉截止临近 | `Claim.dueAt`（复用看板 `deadline_approaching` 桶 / `listExpiringClaims`） | **状态型**（按调度评估） | HIGH |
| N2 | `claim.response_received` | 平台已回应 | `Claim.respondedAt` 由空变非空，或 AuditLog `claim.response_recorded` / `claim.terminal_recorded` | 事件型 | INFO |
| N3 | `recovery.confirmation_required` | 回收已进入待确认 | `Settlement.confirmationStatus = PENDING_CONFIRMATION`，或 AuditLog `recovery.review_required` | 事件型 + 状态型 | HIGH |
| N4 | `recovery.payout_discrepancy` | 到账与确认金额不符 | 投影推导 `reconciliationStatus = DISPUTED`（received > confirmed），或 AuditLog `settlement.reconciliation_changed` → `DISPUTED` | 事件型 | CRITICAL |
| N5 | `review.required_high_value` | 高额需人工复核 | AuditLog `recovery.review_required` / `payment.review_required`（阈值 > 1000 + 币种） | 事件型 | HIGH |
| N6 | `claim.overdue`（候选，默认关闭） | 已逾期未决 | 看板 `overdue` 桶 | 状态型 | CRITICAL |

> 命名规则：`<域>.<事实>`；**不得**把通知本身当成事实来源 —— 通知是投影，事实永远在 Claim / Settlement / AuditLog。

---

## 2. 触发语义（TRIGGER）

### 2.1 两类触发

| 类型 | 定义 | 幂等键 | 去重规则 |
|---|---|---|---|
| **事件型** | 由既有审计动作或字段状态跃迁驱动 | `(eventId, entityId, actionOrTransition)` | 同一键**只发一次**；重复投递需显式重放标记（人类触发），不自动 |
| **状态型** | 由投影按调度评估（如每日一次） | `(eventId, entityId, bucketKey)`，`bucketKey` = 观察日期（UTC） | 仅在**进入**条件的那一天发一次（"进入即通知"）；处于该状态期间不重复轰炸 |

### 2.2 进入/离开语义（状态型必须成对定义）

* N1 `claim.deadline_approaching`：进入 = `dueAt ∈ [now, now+W)` 且状态非终局且 `respondedAt` 为空；离开 = 已回应 / 已终局 / 已逾期（转入 N6）。
* N3 `recovery.confirmation_required`：进入 = 首次出现 `PENDING_CONFIRMATION`；离开 = `CONFIRMED` 或 `REJECTED_BY_REVIEW`。

### 2.3 触发前置条件（全部满足才产生通知）

1. 实体属于**同一租户**（`organizationId` 强制注入，与看板一致）
2. 该事件对**收件人角色**而言在其权限范围内（见 §3）
3. 未处于静默期（同一幂等键已通知过）
4. 系统未处于 Kill Switch 状态（见 §5.3）

---

## 3. 收件人解析（RECIPIENT）

### 3.1 解析顺序（确定性）

```
事件 → 需要的"动作权限" → 该租户内拥有该权限的活跃 Membership → 有效收件人集合
```

| 事件 | 所需动作权限 | 可收件角色 |
|---|---|---|
| N1 deadline_approaching | `claimTrackingApprove` | OWNER / ADMIN |
| N2 response_received | `claimTrackingReceive` | OWNER / ADMIN / OPS |
| N3 confirmation_required | `claimTrackingApprove` | OWNER / ADMIN |
| N4 payout_discrepancy | `recoveryPayoutRecord` | OWNER / ADMIN / FINANCE |
| N5 review_required_high_value | `claimTrackingApprove` | OWNER / ADMIN |

### 3.2 硬规则

1. **绝无外部收件人**：收件人只可能是本租户的活跃成员；不接受 email/SMS/webhook 形式的外部地址（哪怕未来引入渠道，也必须先过架构裁决）。
2. **VIEWER 永不收件**（`DENY_ALL`，fail-closed）。
3. **收件人集合为空**时：不静默丢弃 —— 记录为"无收件人"的可观测事件（供 Admin 后续处理），但不外发。
4. 跨租户零泄漏：解析与渲染都必须带 `organizationId`，禁止"全局广播"。

---

## 4. 模板契约（TEMPLATE）

只定义**字段**，不定义渠道格式（邮件主题/短信字数等属渠道层，当前不存在）。

| 字段 | 类型 | 说明 |
|---|---|---|
| `eventId` | string | §1 的稳定标识（前端可据此选图标/深链） |
| `severity` | `INFO \| HIGH \| CRITICAL` | 由事件目录给定，不接受调用方覆盖 |
| `title` | string | 短标题（不含金额、不含 Claim 正文） |
| `body` | string | 人类可读描述（受 §4.1 裁剪规则约束） |
| `entity` | `{ type, id }` | 事实对象引用（Claim / Settlement / Case） |
| `deepLink` | string | 指向看板/案件页的内部路径（不含 token） |
| `requiredAction` | string | 期望的人工作业（如"批准提交""录入到账""处置争议"） |
| `dueAt` | string? | 仅 N1/N6 携带（来自 `Claim.dueAt`，含 `deadlineSource`） |
| `generatedAt` | string | 生成时刻（同一批次一致） |

### 4.1 内容裁剪（与看板同口径）

* 金额字段（`responseAmount` / confirmed / received / outstanding / variance）**仅**当收件人同时具备 `viewBilling` 与 `recoveryPayoutRecord` 时出现；否则**整个金额字段不存在**（不是 0）。
* 永远不出现：凭据与密钥、`storageKey`、原始文件内容、Claim 正文全文、其他租户任何信息、模型 prompt/trace。
* N4（争议）在 FINANCE 视图中可含金额；在 OWNER/ADMIN 视图中含金额与实体引用；不含 Claim 正文。

### 4.2 有限聚合摘要（D4 裁决后口径）

MSG-20260929-32 D4 = **REVISE**：允许**有限聚合摘要**，但必须同时满足四个"同"：

| 约束 | 说明 |
|---|---|
| 同租户 | `organizationId` 相同（永不跨租户聚合） |
| 同事件 | 同一 `eventId`（禁止把不同事件混进一条摘要） |
| 同权限范围 | 同一 `visibility` 分组（STANDARD / WITH_AMOUNTS 不合并） |
| 同时间窗口 | 同一评估窗口（状态型按 UTC 日期分桶） |

* **summary only / detail filtered**：摘要只给**总数**（例：「今日有 12 个 Claim 接近截止」）；
  明细仍逐条按权限裁剪，且摘要最多附带 N 个实体样本（默认 N=5），**必须同时给出总数**，不得只列前 N 个而隐藏其余。
* v1 只有 N1（`claim.deadline_approaching`）开启聚合（状态型、噪音最高）；其余事件一律逐条（`aggregation: false`）。
* 聚合是**投影的投影**：仍不落库、不投递、不新增表。

---

## 5. 权限与审计（PERMISSION / AUDIT）

### 5.1 读取通知

通知的读取复用现有权限矩阵，**不新增权限键**：

* N1 / N3 / N5 → `claimTrackingApprove`
* N2 → `claimTrackingReceive`
* N4 → `recoveryPayoutRecord`
* 金额部分 → 追加 `viewBilling`

### 5.2 审计

* **v1（本设计）不落库、不投递，因此不写 AuditLog**：通知是纯派生投影，与看板一致（读操作不产生审计）。
* 若未来引入"持久化未读状态"或"真实投递"，则**必须**：
  1. 先提交 Schema Delta（新表 `Notification` / `NotificationDelivery`）；
  2. 新增审计动作 `notification.dispatched`、`notification.acknowledged`（并同步 `OPERATIONS.md` 清单）；
  3. 记录 `recipientUserId`、`channel`、`eventId`、`entityRef`，**不记录**消息正文中的敏感字段。

### 5.3 Kill Switch（设计层要求）

必须有一个租户级开关，关闭后：不再产生任何新通知（包括内部呈现）；已产生的只读不删。

MSG-20260929-32 §八 补充要求：Kill Switch 一旦进入实现，必须同时具备
**（1）有权限**（只有 OWNER/ADMIN 可切换，复用 `claimTrackingApprove`，不新增权限键）、
**（2）有审计**（动作名在实现阶段确定并同步 `OPERATIONS.md`）、
**（3）有变更记录**（记录切换人、时间、原值/新值）。

本轮实现采用**注入式开关**（`killSwitchEnabled` 由调用方传入），不新增存储、不新增权限键；真正的持久化开关属未来 Schema Delta。

---

## 6. 未来实现阶段的验收（等 GO 后提交）

1. **幂等**：同一幂等键重复评估只产生一条通知（事件型 + 状态型各一组用例）。
2. **进入即通知**：状态型只在进入条件当天产生一次；持续停留不重复。
3. **无外部渠道**：代码中不存在 email/SMS/webhook/第三方 SDK 调用（静态断言 + 依赖清单断言）。
4. **裁剪**：FINANCE 收到的通知中**不存在** Claim 文本/金额键；VIEWER 不产生任何通知。
5. **租户隔离**：A 租户的通知只含 A 的实体（真实库断言）。
6. **无收件人可观测**：收件人集合为空时产生可观测事件，不静默丢弃、不外发。
7. **Kill Switch**：开启后不再产生新通知，且变更被审计。
8. **无写入事实**：通知路径不修改 Claim / Settlement / Billing 的任何字段（前后快照断言）。

---

## 7. 请裁决

NEED: **GO / REVISE / HOLD**（NOTIFICATION-DESIGN）

* **D1 事件目录**：N1–N5 是否完整、命名是否接受？N6（`claim.overdue`）默认关闭是否正确？
* **D2 状态型去重窗口**：按"进入即通知（每实体每事件一次）"是否正确？还是允许周期性提醒（如每 3 天）？
* **D3 v1 是否需要"未读状态"落库**：当前建议 **HOLD**（纯派生、零状态、零新表）；若要未读，需要单独 Schema Delta。
* **D4 聚合摘要**：是否允许同一事件多实体合并为一条摘要（含总数与上限）？还是 v1 一律逐条？

> 边界未变：不接任何渠道、不自动对外联系、不发平台通知；自动提交 FORBIDDEN、自动扣佣 HOLD、金额口径零改动。
---

## 8. R1 修订记录与实现范围（MSG-20260929-32）

| 裁决项 | 处置 |
|---|---|
| D1 PASS（N1–N5 启用，N6 默认关闭） | 事件目录保持；N6 明确标注为 N1 的升级语义，默认不评估 |
| D2 GO（进入即通知，不做周期提醒） | 幂等键：事件型 `event\|entity\|transition`；状态型 `event\|entity\|UTC 日期` |
| D3 HOLD（不落库未读状态） | v1 无状态投影；不新增 `Notification` 表、不新增 `readAt` |
| D4 REVISE（允许有限聚合） | §4.2 已按"四个同"重写；v1 仅 N1 聚合，summary + detail 分离 |
| Kill Switch 三要素 | §5.3 已补权限 / 审计 / 变更记录要求 |

### 8.1 已批准的实现范围（MSG-20260929-32 §九）

**允许**：Notification projection service · event derivation · recipient resolution · permission filtering · idempotency calculation · tests。

**禁止**：Email / SMS / 企业微信接入 · `Notification` 表 · 未读状态 · 外部发送 · 自动联系客户或平台。

已实现：`apps/api/src/services/operations/notification-projection.ts`（纯投影 + 读侧装配，无写路径、无端点、无投递）。
