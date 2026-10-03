# INDEPENDENT-SITE / CHARGEBACK — SCHEMA DELTA REQUEST（BG-021）+ CHANGE E 范围裁定请求

> 类型：**Schema Delta Request（仅请求批准；不含 migration）+ 范围裁定请求**
> 依据：MSG-20261003-135 CHANGE D / CHANGE E；MSG-20261003-138（BG-013 已 CLOSED，可作为同构先例）
> 分支 `gate/7-commercial-validation` · Codex · 2026-10-04
> 前置（已交付、无 Schema 变更）：`services/independent-site/chargeback-recovery-flow.ts`（8/8）+ PS04 Phase 1 只读链（BG-010）

---

## 0. 请求摘要

CHANGE D 已用「fixture / manual-handoff」版把独立站内部闭环跑通（递交 → 响应 → 验证到账 → RecoveryLedger → 15% fee → 发票草稿），
但**事实仍是进程内的**。本请求把该闭环的**事实层**落库，形状与 BG-013（IOR）同构：

1. submit ≠ won ≠ settled ≠ recovered ≠ billable —— 三类事实各自 append-only，互不覆盖；
2. `executionKey` 幂等 + 同一 dispute 的并发启动 exactly-one；
3. 跨租户 fact 一律拒绝；同一 dispute 的响应 / 到账必须引用**同租户**的递交事实；
4. 禁止 PAN / CVV / PSP secret / 支付凭据原文进入事实层。

获批后另起提交实施 migration；HOLD_EXTERNAL 全保持（不接 Shopify / Stripe / PayPal，不实现 dispute.submit）。

## 1. 新增枚举（3）

```
enum Ps04HandoffChannel { MANUAL_PORTAL MANUAL_EMAIL FIXTURE }
enum Ps04ResponseDisposition { WON LOST PARTIAL UNKNOWN }
enum Ps04SettlementVerification { VERIFIED UNVERIFIED }
```

与服务层词表逐一对齐（`PS04_HANDOFF_CHANNELS` / `PS04_RESPONSE_DISPOSITIONS` / `PS04_SETTLEMENT_VERIFICATION`）。

## 2. 新增表 ①`IndependentSiteHandoffFact`（append-only，每 dispute 至多一条）

| 字段 | 类型 | 可空 | 说明 |
|---|---|---|---|
| `id` | `String @id` | 否 | |
| `organizationId` | `String` | 否 | FK → Organization（Cascade） |
| `merchantRef` / `paymentAccountRef` | `String` | 否 | **safe reference**（paymentAccountId 的 tokenized 形式） |
| `disputeReference` | `String` | 否 | 弱引用外部 dispute |
| `packageId` / `packageDigest` | `String` | 否 | claim-ready 包身份（digest 64 hex） |
| `channel` | `Ps04HandoffChannel` | 否 | 人工递交渠道 |
| `handoffReference` | `String` | 否 | 人工递交凭据（machine-safe） |
| `attestedByActorId` | `String` | 否 | human attestation |
| `executionKey` | `String` | 否 | 服务端派生幂等键 |
| `contentDigest` | `String` | 否 | 事实摘要（64 hex） |
| `observedAt` / `createdAt` | `DateTime` | 否 | |

约束/索引（请求批准）：

| # | 项 | 目的 |
|---|---|---|
| H1 | `@@unique([organizationId, disputeReference])` | 同一 dispute 的**并发启动 exactly-one**（loser 显式 CONFLICT） |
| H2 | `@@unique([organizationId, contentDigest])` | 幂等 append（重放不产生第二行） |
| H3 | CHECK：引用列 `^[A-Za-z0-9._:@#/-]{1,96}$` 且 `!~ '^[0-9]{6,12}$'` | 拒绝含空格自由文本 / 纯数字账号 |
| H4 | CHECK：`packageDigest ~ '^[0-9a-f]{64}$'`、`contentDigest ~ '^[0-9a-f]{64}$'` | 摘要形状 |
| H5 | `@@index([organizationId, paymentAccountRef, observedAt])` | 按账户回看 |

## 3. 新增表 ②`IndependentSiteResponseFact`（append-only，可多条）

| 字段 | 类型 | 可空 | 说明 |
|---|---|---|---|
| `id` / `organizationId` | | 否 | |
| `disputeReference` | `String` | 否 | |
| `disposition` | `Ps04ResponseDisposition` | 否 | WON 本身**不**代表到账 |
| `amount` | `Decimal? @db.Decimal(38, 6)` | 是 | 可空（LOST/UNKNOWN） |
| `currency` | `String` | 否 | 形状 CHECK（ISO-4217 形式） |
| `source` | `String` | 否 | 仅 `MANUAL_ENTRY` / `FIXTURE`（真实 PSP 读取仍 HOLD） |
| `contentDigest` / `observedAt` / `createdAt` | | 否 | |

约束：`@@unique([organizationId, contentDigest])`；CHECK `amount IS NULL OR amount >= 0`；`disposition` 枚举即白名单。

## 4. 新增表 ③`IndependentSiteSettlementFact`（append-only，可多条）

| 字段 | 类型 | 可空 | 说明 |
|---|---|---|---|
| `id` / `organizationId` | | 否 | |
| `disputeReference` | `String` | 否 | |
| `amount` | `Decimal @db.Decimal(38, 6)` | 否 | 付款方入账金额 |
| `currency` | `String` | 否 | 形状 CHECK |
| `verification` | `Ps04SettlementVerification` | 否 | 未验证 → recovered = 0、不可计费 |
| `reference` | `String` | 否 | 到账引用（machine-safe） |
| `contentDigest` / `receivedAt` / `createdAt` | | 否 | |

约束：`@@unique([organizationId, contentDigest])`；CHECK `amount >= 0`；
CHECK `verification <> 'VERIFIED' OR reference <> ''`（VERIFIED 必须可追溯）。

## 5. 运行库不变量（与 BG-013 同族）

| 不变量 | 机制 |
|---|---|
| append-only | `cc_append_only__*` 触发器（UPDATE / DELETE 拒绝） |
| tenant | `cc_tenant_*`（BEFORE INSERT OR UPDATE） |
| 归属不可变 | `cc_tenant_immutable__*`（tgtype 19） |
| **同租户 lineage** | `cc_ps04_lineage__*`：response / settlement 必须存在**同租户**且同 dispute 的 `IndependentSiteHandoffFact` |
| 无支付凭据 | 事实层无 PAN/CVV/secret 字段；H3 拒绝纯数字账号形状 |

## 6. 明确不包含

- 不写 migration（获批后另起提交）；
- 不接真实 PSP / webhook / 生产凭据；不实现 `dispute.submit`；
- 不新增真实资金动作（`Payment=0` / `collection=OFF` 不变）。

## 7. 待批问题（请逐条裁定）

1. 三表 + 三枚举是否批准（含 H1 的「每 dispute 一条 handoff」口径）？
2. `paymentAccountRef` 是否允许以 tokenized reference 存储（当前提案：允许，仅形状约束）？
3. `VERIFIED` 到账是否还要求 `evidenceArtifactRef`（BG-013 的 POA 采用了「VERIFIED ⇒ evidence 非空」，此处是否要求对称）？
4. `currency` 形状 CHECK 的口径（ISO-4217 三字母大写 vs 现有 `CurrencyShape` 约束口径）？
5. 是否需要 `latest` view（由 `observedAt DESC, id` 推导）而非物化列？

## 8. CHANGE E 范围裁定请求（同一请求内）

MSG-20261003-135 CHANGE E 要求：**要么**补齐四域内部 Golden Path 所需的最小 frontend wiring，**要么**由宿主正式修改协议范围。

当前实际接线：

| 域 | 内部 Golden Path 所需只读 UI | 状态 |
|---|---|---|
| Customs | `integration-status`：filing status、return→claim evidence、entry fact + 四类 latest 投影（本轮 BG-020 端点） | **已接** |
| Carrier | `integration-status`：carrier response 读模型 + manual response 表单 | **已接** |
| Platform | `cases/[id]/claim-package`、`opportunities` 只读面 | 部分（platform.write 无 UI，按设计 NEEDS_MANUAL） |
| Independent-site | `money/recovery-money-view` 只读面 | 部分（PS04 闭环无独立 UI；事实层亦未落库 → 见 BG-021） |

请裁定 `Platform` 与 `Independent-site` 的**最小 UI 边界**：是「有只读投影即可」还是「必须覆盖 golden path 的关键节点」？
Codex 不自行降低协议标准；若由宿主修改协议范围，请明确新的判定口径。
