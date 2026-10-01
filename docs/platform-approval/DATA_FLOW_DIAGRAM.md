# DATA_FLOW_DIAGRAM

## 1. 授权与数据流（正式形态）

```
SELLER
  │  explicit authorization（平台官方 OAuth / 商户授权）
  ▼
PLATFORM OAuth / API
  ▼
SECRET MANAGER（Client Secret / Refresh Token / API Key）
  ▼  credential reference（SourceConnection.config 只存引用）
SOURCE CONNECTION
  ▼
READ-ONLY ADAPTER（平台专属；不含写能力）
  ▼
RAW SOURCE DATA（原始事实 + provenance：sourceKind / sourceRef / capturedAt / parserVersion）
  ▼
CANONICAL FACT（统一事实层；平台字段不得污染核心领域模型）
  ▼
DETERMINISTIC RULE ENGINE
  ▼
RECOVERY OPPORTUNITY
  ▼
HUMAN REVIEW
  ▼
CASE / EVIDENCE
  ▼
RECOVERY PACKAGE
  ▼
HUMAN APPROVAL（HITL）
  ▼
MANUAL / APPROVED SUBMISSION
  ▼
OUTCOME
  ▼
SETTLEMENT
  ▼
RECOVERY LEDGER
  ▼
SUCCESS FEE / BILLING
```

## 2. 多源组合（独立站必须支持）

```
StoreAdapter（Shopify / WooCommerce / …）
        +
PaymentAdapter（Stripe / PayPal / Adyen / Shopify Payments / …）
        +
CarrierAdapter（UPS / FedEx / DHL / 货代 / …）
        ▼
   Canonical Fact
        ▼
Recovery Opportunity
        ▼
    Recovery OS
```

支持组合示例：Shopify+Stripe · WooCommerce+PayPal · Shopify+Shopify Payments · WooCommerce+Stripe。
**Chargeback / dispute 不得硬编码为 Shopify 专属模型。**

> CrossClaim 自身向客户收费的 Stripe Billing 集成，与客户业务数据的 PSP 连接**必须严格分离**（不同连接、不同账本）。

## 3. LLM 边界（LLM DOES NOT）

```
LLM DOES NOT:
  - determine money
  - determine fee
  - write ledger
  - grant permission
  - consume approval
  - submit externally without approved boundary
```

LLM 允许范围：理解、抽取、解释、证据推荐、Claim/Appeal 草稿（**AI Prepare**），且输出必须经 Human Review。

## 4. 凭据边界

```
Client Secret / Refresh Token / API Key  →  Secret Manager（唯一存放点）
SourceConnection                          →  credential reference（永不含真实值）
日志 / 错误 / 响应 / Git                  →  永不出现真实凭据值
```
