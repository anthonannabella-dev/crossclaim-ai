# Customs / Duty Drawback 与 **BrokerConnector** 长期产品契约（R14）

> 依据：**HOST DIRECTIVE 2026-10-02（补充三）**。
> 状态：**长期产品规则** —— 仅登记到 roadmap / product contract / architecture boundary；
> **不改变、不打断** 当前 R45 → R46 队列。进入 **Customs / BrokerConnector 实施批次**时，
> 再提交独立设计、Schema Delta、合规审计与测试。
> 配套：`SUCCESS-FEE-BILLING-REDLINE.md`（R12）· `PAYMENT-AUTHORIZATION-AND-ONBOARDING-CONTRACT.md`（R13）。

---

## 1. 新增长期抽象：**BrokerConnector**

```
CrossClaim Recovery Opportunity
→ Evidence / Claim Package
→ BrokerConnector
→ Licensed Customs Broker / ABI Service
→ CBP
→ Outcome / Reimbursement
→ CrossClaim Reconciliation
```

**BrokerConnector 必须支持未来多种 transport（不得把核心绑定某一家 Broker）**：

| transport | 说明 |
| --- | --- |
| API / Webhook | 具备 API 能力的 broker / ABI 服务商 |
| ABI Vendor Integration | 通过 ABI 软件厂商通道 |
| EDI / SFTP | 传统 EDI / 批量文件交换 |
| Manual Broker Portal | 必要时的人工门户（辅助通道，非主链路默认） |

> Connector 只负责**传输与状态映射**；不得把任何 broker 专有字段写入 Recovery OS 核心领域模型。

---

## 2. 执业边界：CrossClaim 不是 Customs Broker

1. CrossClaim **不得**因为可以自动生成材料而自称 Customs Broker；
2. CrossClaim **不得**执行依法必须由 **licensed customs broker** 承担的 customs business；
3. V1 职责划分（优先合作模式）：

| 主体 | 职责 |
| --- | --- |
| Licensed Customs Broker | licensed review · filing · CBP communication |
| CrossClaim | 数据接入 · Recovery detection · matching · Evidence Package · workflow · tracking · reconciliation |

---

## 3. 三类授权域**完全独立**（与 R13 一致）

| 授权域 | 用途 | 不得推导出 |
| --- | --- | --- |
| **Platform OAuth**（Amazon/TikTok Shop/Walmart/Shopify…） | 平台数据/API 能力 | Broker POA；Payment Authorization |
| **Broker POA**（如适用，直接 POA） | Broker 与 drawback claimant / importer 之间依法所需的直接授权关系 | Platform OAuth；Payment Authorization |
| **Payment Authorization**（PaymentMandate / PaymentMethod） | 客户向 CrossClaim 支付成功费 | Platform OAuth；Broker POA |

**冻结**：任何一项都不得自动推导出另一项。CrossClaim **不得伪造、代替或从 Platform OAuth 推导 Broker POA**；
Broker 的授权关系必须由 Broker 依其执业要求与 claimant/importer 直接建立。

---

## 4. Broker Fee 与 CrossClaim Fee 必须独立表达

- 领域模型、合同主体、Invoice、Payment attribution 上必须**可独立表达** Broker Fee 与 CrossClaim Fee；
- **禁止默认**模式：「CrossClaim 向客户收统一百分比 → 再按每笔 Customs Business 给 Broker 分佣」；
- 该模式涉及**美国 Customs Broker compensation / fee-sharing 规则**，**实施前必须经过专门合规审查**；
- 优先探索 Broker 的 **fixed fee / per-file fee / volume pricing / platform fee**，而不是默认按每笔追回金额与 CrossClaim 分佣。

---

## 5. 客户体验统一，法律/收费主体可分离

- 客户在 CrossClaim 内完成**资料、授权与状态跟踪**（单一入口，不重复整理材料、不手工搬运数据）；
- Broker 后台可以是**独立法律主体与独立收费主体**；
- 数据搬运由 BrokerConnector 承担，客户不承担系统间的手工动作。

---

## 6. 退款资金：不默认代收、不形成资金池

- Duty drawback 退款**原则上优先直接进入 claimant / customer 的合法收款账户**；
- CrossClaim **不得默认代收**客户 Customs refund、**不得形成资金池**、**不得从退款中截留佣金**；
- 任何此类模式必须**另开 Funds Custody / Money Movement 合规审计**后才可评估。

---

## 7. CrossClaim 自身成功费（沿用 R12 / R13）

```
verified recovery / Settlement
→ FeeCalculation
→ BillingInvoice
→ 有效 Payment Authorization / Mandate
→ Payment Provider 收款
```

**无有效授权则只生成 Invoice，不自动扣款。**

---

## 8. 实施时点与 Gate

| 项 | 当前状态 |
| --- | --- |
| R45 → R46 | 队列不变（S4 送审 → S5 → R46） |
| BrokerConnector 设计 / Schema Delta / 合规审计 / 测试 | **未开始**（进入 Customs/BrokerConnector 批次时另行提交） |
| Broker Fee 分佣模式 | **禁止默认**；实施前须专门合规审查 |
| 代收退款 / 资金池 | **HOLD**（需独立 Funds Custody / Money Movement 审计） |
| 生产凭据 / 真实外写 | **HOLD** |

---

## 9. 状态字段（涉及 Customs/Broker 时输出）

```
CUSTOMS_BROKER_CONNECTOR = REGISTERED / IMPLEMENTED / N-A
CROSSCLAIM_ACTS_AS_CUSTOMS_BROKER = NEVER（恒为 NEVER；出现即缺陷）
BROKER_POA_SOURCE = BROKER_DIRECT / N-A（不得为 PLATFORM_OAUTH）
AUTHORIZATION_DOMAINS_SEPARATED = YES（平台 OAuth / Broker POA / Payment Authorization 三域独立）
BROKER_FEE_MODEL = FIXED / PER_FILE / VOLUME / PLATFORM_FEE / TBD（默认禁止按追回金额分佣）
CROSSCLAIM_CUSTODY_OF_REFUND = NONE（默认 None；否则须独立合规审计）
```
