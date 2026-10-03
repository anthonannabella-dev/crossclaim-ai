# PRODUCT-SCOPE-04 — Independent-site / Chargeback Recovery 设计稿（跨渠道 Recovery OS）

> 状态：**设计 + backlog（不实施大范围代码）**
> 依据：HOST PRODUCT DIRECTION（2026-10-01，范围冻结）
> 约束：Gate 7 / Action Guard / claim.prepare 既审计队列**继续原计划**，本任务不打断；不新增真实外写。

## 0. 产品范围冻结（长期方向）

CrossClaim AI = **跨境资金损耗 Recovery OS**，不是 Amazon/FBA 单点理赔工具。最终统一承载四类 Recovery：

| # | Recovery 类别 | 渠道示例 | 典型损耗 |
| --- | --- | --- | --- |
| 1 | Platform Recovery | Amazon FBA/FBM、TikTok Shop/FBT、Walmart/WFS | 少赔/错赔、库存与费用差异、退款/赔付遗漏 |
| 2 | Logistics Recovery | UPS / FedEx / DHL / Freight Forwarder | SLA/GSR 延误、运费账单差异、重复收费/附加费、丢件破损 |
| 3 | Customs / Trade Recovery | 报关行、税则/税率 | 关税多缴、归类/税率差异、B2B 可追回损耗 |
| 4 | Independent-site / Payment Recovery | Shopify、Stripe、PayPal | Chargeback / Dispute / 拒付及相关资金损耗 |

**统一引擎（后端复用，前端发现规则可不同）**

```
Source Data → Canonical Fact → RecoveryOpportunity → Case → Evidence
   → Claim / Appeal / Dispute → Settlement → RecoveryLedger → Billing
```

架构纪律：

1. 不为每个渠道重做一套孤立系统；平台/物流/海关/独立站共享案件、证据、权限、审计、到账、账本、收费能力。
2. 不把 CrossClaim 收缩为 Amazon FBA reimbursement tool。
3. 牌照 / 正式报关 / 平台真实写入：保持既有合规边界与人工卡口。
4. 真实 API、生产凭据、平台外写：**继续 HOLD**，除非后续单独开闸。
5. 本设计**不**要求立即新增 Chargeback 代码。

---

## A. 现有领域模型能否无破坏地承载 Chargeback / Dispute

**结论：核心链路可直接复用；缺口集中在 3 处枚举维度 + 1 处争议语义承载点，均可在不破坏既有数据的前提下扩展。**

### A.1 可复用（字段级证据）

| 能力 | 现有承载 | 对 Chargeback 的适用性 |
| --- | --- | --- |
| 事实层 | `CanonicalFact`（`domain` / `channel` / `factKey` / `externalId` / `occurredAt` / `amount` / `currency` / `status`） | 可承载支付渠道事实（争议创建、争议关闭、余额交易、退款、冲回），`factKey = REFERENCETYPE:EXTERNALID` 天然幂等 |
| 机会层 | `RecoveryOpportunity`（`domain` / `channel` / `opportunityType` / `amountExpected` / `amountActual` / `recoverableAmount` / `claimDeadline` / `status`） | 「争议金额 + 渠道 + 举证时限」可完整表达；`claimDeadline` 对应 dispute `evidence_due_by` |
| 案件层 | `Case`（`domain` / `status` / `claimedAmount` / `recoveredAmount` / `currency` / `dueAt` / `nextActionAt`） | 与渠道无关，可直接承载 dispute 案件与回收金额 |
| 证据层 | `EvidenceArtifact` / `EvidenceEdge` / `CaseEvidence` / `ClaimItemEvidence` | 可直接承载「争议证据包」（订单凭证、物流签收、沟通记录、AVS/CVV 结果） |
| 条项层 | `ClaimItem`（含 `status` / `closedReason` / `responsibleParty`） | 可承载「争议条项」（按订单/交易/金额条目） |
| 主张层 | `Claim`（`DRAFT→SUBMITTED→ACKNOWLEDGED→APPROVED/PARTIALLY_APPROVED/REJECTED/NO_RESPONSE/WITHDRAWN`）+ `ClaimDeadlineSource` + `ClaimTerminalReasonCode` | 可直接承载「抗辩/申诉的分轮次与结果」 |
| 上诉层 | `Appeal`（`DRAFT/SUBMITTED/UNDER_REVIEW/UPHELD/OVERTURNED/REJECTED/WITHDRAWN`） | 可承载 chargeback 的**二次申辩 / 上诉** |
| 到账层 | `Settlement`（`EXPECTED/RECEIVED/PARTIAL/DISPUTED/VOID` + 确认轴/对账轴 + 冲回链 `reversedBySettlementId`） | **`DISPUTED` + 冲回链**天然对应「到账后被拒付/回退」 |
| 账本层 | `RecoveryLedgerEntry`（`DISCOVERED/RECOVERED/ADJUSTMENT/REVERSAL/WRITE_OFF` + `voidsEntryId`） | 拒付造成的资金回退可记 `REVERSAL`/`ADJUSTMENT`，且可作废不删行 |
| 收费层 | `BillingInvoice` / `FeeCalculation` / `Payment` | 按案件收费、收款尝试与幂等键与渠道无关 |
| 接入层 | `SourceConnection`（`domain`/`channel`/`kind`：FILE_UPLOAD/API/SFTP/EMAIL/MANUAL）/ `FileAsset` / `ImportBatch` / `SourceTransaction` + `adapters`（registry / ingest-bridge / source-guard） | 先支持导出报表（FILE_UPLOAD），后接只读 API（API）；写面适配器在注册阶段即被拒绝 |
| 平台能力 | Action Guard（动作目录 / 能力闸门 / 人工审批）、审计（`AuditLog`）、权限矩阵、租户隔离（`organizationId` 全表带） | 争议动作可直接纳入既有闸门与审计，不需要新机制 |

### A.2 缺口（需要扩展的点）

1. **`enum RecoveryDomain` 无独立站/支付域**：当前仅 `PLATFORM / LOGISTICS / CUSTOMS`。
2. **`enum Channel` 无独立站与支付渠道**：当前仅 Amazon/UPS/FedEx/DHL/FF/INSURANCE/CUSTOMS_BROKER/OTHER。
3. **`enum RouteTarget` 无支付服务商**：当前 `PLATFORM/CARRIER/FREIGHT_FORWARDER/INSURER/CUSTOMS_AUTHORITY/CUSTOMS_BROKER/CUSTOMER_SELF/NONE`；chargeback 的对抗对象是 **支付服务商 / 收单行**。
4. **争议语义承载（非表结构问题）**：chargeback 有「举证时限 — 抗辩提交 — 仲裁结果 — 资金回退」的**顺序语义**，现有 `Claim`/`Appeal` 状态机可表达其结果，但缺少显式的「争议阶段/举证截止」承载惯例；建议以最小字段表达而非新表。

---

## B. 最小 Schema Delta（若确实需要）

### B.1 推荐（最小、向后兼容）

| # | 变更 | 内容 | 破坏性 |
| --- | --- | --- | --- |
| D1 | `enum RecoveryDomain` 增加值 | `INDEPENDENT_SITE`（与四类命名一致；若架构方偏好 `PAYMENTS` 亦可） | 无（枚举新增） |
| D2 | `enum Channel` 增加值 | `SHOPIFY`、`STRIPE`、`PAYPAL`；按冻结范围补齐 `TIKTOK_SHOP`、`WALMART` | 无 |
| D3 | `enum RouteTarget` 增加值 | `PAYMENT_PROCESSOR`（争议对抗对象）；如后续需要发卡行仲裁再加 `ISSUING_BANK` | 无 |
| D4（可选） | `Claim` 增加 2 个可空字段 | `disputeStage`（枚举 `CHARGEBACK_RECEIVED` / `EVIDENCE_DUE` / `RESPONSE_SUBMITTED` / `UNDER_REVIEW` / `WON` / `LOST`）、`disputeEvidenceDueAt` | 无（可空新增） |

> D4 的替代方案：完全复用 `ClaimItem.status` + `Claim.deadlineSource` + `Claim.terminalReasonCode` 表达争议阶段，**不新增字段**。若架构方倾向「不扩字段」，则本设计按替代方案落地。

### B.2 迁移纪律（架构方裁决点）

1. PostgreSQL `ALTER TYPE ... ADD VALUE` **不能与使用新值的事务同批提交**；D1–D3 必须是**独立迁移**，且新增值在该迁移提交后才可用于业务写入。
2. 本批**无数据回填、无破坏性变更、无表重建**。
3. 若架构方判定「枚举扩展属于领域与 Schema 变化」→ 按既有规则**先审计后实施**，本设计稿即为送审材料。

---

## C. Shopify / Stripe / PayPal 数据接入需求

### C.1 通用纪律

- 连接模型复用 `SourceConnection`（`organizationId` + `channel` + `kind` + `label` 唯一）；凭据只存 `credentialRef`（**生产凭据继续 HOLD**）。
- 幂等：`CanonicalFact.factKey = REFERENCETYPE:EXTERNALID`（`externalId` 为渠道方原生 id）。
- 归一：金额/币种一致性校验（`amountExpected` vs `amountActual`），时区统一 UTC。
- 先只读（报表导出 → FILE_UPLOAD），后只读 API；**任何写面适配器在注册阶段即被拒绝**。

### C.2 各渠道所需数据

| 渠道 | 首选接入 | 事实来源 | 关键字段 | factKey 示例 |
| --- | --- | --- | --- | --- |
| Shopify | 后台导出 CSV（FILE_UPLOAD）→ 后续 Admin GraphQL（API，只读） | 订单、退款、Shopify Payments 争议 | `order_id`、`created_at`、`refund_id`、`amount`、`currency`、`dispute_id`、`dispute_status`、`dispute_reason`、`evidence_due_by`、`gateway` | `ORDER:1234567890` / `DISPUTE:gid://shopify/ShopifyPaymentsDispute/1` |
| Stripe | 后台导出（FILE_UPLOAD）→ 后续 Disputes/Balance/Payouts REST（API，只读） | `dispute.*`、`charge.dispute.*` 事件、Balance transactions、Refunds、Payouts | `dispute_id`、`charge_id`、`payment_intent`、`amount`、`currency`、`reason`、`status`（`needs_response`/`under_review`/`won`/`lost`）、`evidence_details.due_by`、`balance_transaction`、`payout_id` | `DISPUTE:dp_123` / `BALANCE_TXN:txn_123` |
| PayPal | 后台导出（FILE_UPLOAD）→ 后续 Disputes + Transactions Search API（只读）+ Webhook 事件 | 争议（Customer Disputes）、交易、退款 | `dispute_id`、`reason`、`status`、`dispute_amount`、`create_time`、`seller_response_due_date`、`transaction_id`、`refund_id` | `DISPUTE:PP-D-12345` / `TXN:8AB12345CD` |

### C.3 后续（真 API / Webhook）前置条件

1. 只读 Token 的最小 scope（Disputes:read / Transactions:read），凭据入 `credentialRef`（HOST 审批后）。
2. Webhook 验签 + 重放保护 + 幂等（复用既有 webhook 边界纪律）。
3. 沙箱/测试模式数据先行；真实客户数据继续 HOLD。

---

## D. 可直接复用 vs 需要新增（Chargeback 场景映射）

| 引擎阶段 | Chargeback 场景 | 复用现状 | 需要新增 |
| --- | --- | --- | --- |
| Source Data | Shopify/Stripe/PayPal 报表或 API | 复用 `SourceConnection` / `ImportBatch` / `SourceTransaction` / adapters | 新渠道 connection kind 值使用（D2）+ 解析器 |
| Canonical Fact | `charge.dispute.*`、余额交易、退款 | 复用 `CanonicalFact` + `CanonicalFactSource` | 事实类型命名约定（`DISPUTE:` / `BALANCE_TXN:`） |
| RecoveryOpportunity | 未响应争议 / 证据缺失 / 金额差异 | 复用（`domain/channel/opportunityType/amount*/claimDeadline`） | 检测规则（PS04-3） |
| Case | 争议案件 | **直接复用** | 无 |
| Evidence | 争议证据包（订单、签收、沟通、AVS/CVV） | **直接复用** `EvidenceArtifact` / `ClaimItemEvidence` | 证据清单模板（产品层） |
| Claim / Dispute | 争议条项 + 抗辩提交 + 结果 | 复用 `Claim` / `ClaimItem`（+ 可选 D4 字段） | 提交动作接线（Action Guard，`dispute.submit`，EXTERNAL_WRITE，HOLD） |
| Appeal | 二次申辩/上诉 | **直接复用** `Appeal` | 无 |
| Settlement | 到账被拒付 / 部分回退 | **直接复用**（`DISPUTED` + 冲回链 + 双轴） | 无 |
| RecoveryLedger | 拒付回退记账 | **直接复用**（`REVERSAL` / `ADJUSTMENT`，作废不删行） | 无 |
| Billing | 按回收金额收费 | **直接复用** `BillingInvoice` / `FeeCalculation` / `Payment` | 费率策略（产品层） |
| 安全/审计/权限 | 全流程 | **直接复用** Action Guard / `AuditLog` / 权限矩阵 / 租户隔离 | 新动作登记（IA） |

---

## E. 设计要点 + Backlog

### E.1 争议生命周期（拟）

```
CHARGEBACK_RECEIVED（平台/渠道通知或报表发现）
      → EVIDENCE_DUE（举证时限；RecoveryOpportunity.claimDeadline / disputeEvidenceDueAt）
      → RESPONSE_SUBMITTED（抗辩提交；Action Guard 动作 dispute.submit，人工卡口 + HOLD）
      → UNDER_REVIEW（渠道/发卡行审理；Appeal.UNDER_REVIEW）
      → WON（Settlement: RECEIVED，Ledger: RECOVERED）
      → LOST（Settlement: DISPUTED/VOID + 冲回，Ledger: REVERSAL）
```

### E.2 拟新增 Action Guard 动作（**先登记、后接线**）

| 动作 | 风险类 | 触发点 | 备注 |
| --- | --- | --- | --- |
| `dispute.evidence.prepare` | `INTERNAL_WRITE` | 生成/更新争议证据包 | 与 `claim.prepare` 同构，无人工审批 |
| `dispute.submit` | `EXTERNAL_WRITE` | 向渠道提交抗辩 | 需人工审批 + 平台启用 + 生产闸门；**继续 HOLD** |

### E.3 Backlog（不立即开工；每项若触及领域/Schema/安全/资金 → 架构方裁决）

| ID | 任务 | 依赖 | 备注 |
| --- | --- | --- | --- |
| PS04-1 | 枚举扩展迁移（D1–D3；`ALTER TYPE` 独立迁移） | 架构方裁决（Schema/领域） | 无破坏性；无回填 |
| PS04-2 | 只读接入：Shopify/Stripe/PayPal（CSV → CanonicalFact） | PS04-1 | 生产凭据 HOLD |
| PS04-3 | 检测规则：未响应争议 / 证据缺失 / 金额差异 | PS04-2 | 规则引擎变更需裁决 |
| PS04-4 | 争议容器映射（ClaimItem/Appeal 复用；可选 D4 字段） | PS04-1 | 优先零新增字段方案 |
| PS04-5 | 资金联动：Settlement `DISPUTED` 冲回 + Ledger `REVERSAL` | PS04-4 | 资金链路 → 必须裁决 |
| PS04-6 | Action Guard 动作登记与接线（`dispute.evidence.prepare` → `dispute.submit`） | PS04-4 | EXTERNAL_WRITE 保持 HOLD |
| PS04-7 | 权限/审计/看板投影（争议域） | PS04-6 | 复用既有 admin/ops 投影 |

### E.4 对后续架构与审计的约束

1. 所有新渠道设计必须映射到统一引擎管线，不得新增孤立子系统。
2. 新增动作一律先登记 `ACTION_GUARD_CATALOG` + 能力映射 + 静态清单，再接入口。
3. 平台/物流/海关/独立站共享：`Case` / `Evidence` / `Claim` / `Appeal` / `Settlement` / `RecoveryLedger` / `Billing` / 权限 / 审计。
4. Production Enablement / 真实外写 / 资金 / 客户提交 / 生产凭据：**全部 HOLD**（除非单独开闸）。
