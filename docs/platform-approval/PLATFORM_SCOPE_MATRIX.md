# PLATFORM_SCOPE_MATRIX（五平台汇总）

> 列定义（统一口径）：platform · resource · scope · read/write · business purpose · required_for_MVP · PII · restricted/protected · retention · secret/token type · OAuth/revoke support · review required · approval status · implementation status · production validation status。
> 决策口径：`ACCEPT`（V1 申请）/ `LATER`（后续批次再评估）/ `REJECT`（不申请）。所有平台均为 **READ-ONLY FIRST**。

## 0. 汇总（platform-level）

| platform | integration_mode | V1 权限姿态 | PII | restricted/protected | OAuth/revoke | review required | approval status | implementation status | production validation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AMAZON | OFFICIAL_API（Public Developer） | READ-ONLY，最小 Roles | **V1 可避免 Restricted PII** | Restricted Roles 默认不申请 | LWA（设计就绪） | 平台审核 + 安全材料 | NOT_SUBMITTED | NOT_STARTED（adapter 未接） | NONE |
| TIKTOK_SHOP | OFFICIAL_API + Seller Authorization | READ-ONLY，最小 scopes | 最小化 | 按平台定义 | OAuth（设计就绪） | 商业/Connector 审核 + TPRM | NOT_SUBMITTED | NOT_STARTED | NONE |
| WALMART | Solution Provider | READ-ONLY，最小 scopes | 最小化 | 按平台定义 | OAuth（设计就绪） | Solution Provider 审核 | NOT_SUBMITTED | NOT_STARTED | NONE |
| SHOPIFY | OFFICIAL_API（Public App） | READ-ONLY，最小 scopes | **V1 可避免直接身份类 Protected Customer Fields** | Protected Customer Data 分层 | OAuth（设计就绪） | App Review | NOT_SUBMITTED | NOT_STARTED | NONE |
| WOOCOMMERCE | OFFICIAL_API + Application Auth / 只读 REST Key | READ-ONLY（默认） | 最小化 | 无中心化 PCD 审批 | 商户授权（设计就绪） | 无平台审核（自助） | N/A | NOT_STARTED | NONE |

## 1. 平台专属矩阵

详细 scope 行见：

- `AMAZON_SCOPE_MATRIX.md`
- `TIKTOK_SCOPE_MATRIX.md`
- `WALMART_SCOPE_MATRIX.md`
- `SHOPIFY_SCOPE_MATRIX.md`
- `WOOCOMMERCE_SCOPE_MATRIX.md`

## 2. 统一字段级判定（V1）

| 判定 | 规则 |
| --- | --- |
| 申请 READ scope | 仅当该字段参与 Recovery detection / Evidence / Settlement reconciliation / Fee discrepancy / Logistics recovery / Chargeback·dispute recovery / Recovery tracking |
| 不申请 | 仅因「Order 对象里有」「以后可能用到」的字段 |
| 不申请 WRITE | V1 一律不申请写权限（Claim/Appeal 对外提交仍 HOLD） |
| PII 最小化 | 若姓名/地址/电话/邮箱不参与某类 Recovery → 不申请；平台定义 Protected/Restricted 的数据单独分层评估 |
| 凭据 | 一律 CredentialRef / Secret Manager 引用；不得进业务表、日志、回显、Git |

## 3. 与 Recovery OS 的结合方式（不得为平台改核心）

```
Platform Adapter（平台专属）
  → SourceConnection（credential reference）
  → Raw SourceTransaction（原始事实）
  → CanonicalFact（统一事实层）
  → Rule Engine → RecoveryOpportunity → Recovery OS
```

新增平台的目标是：**Adapter + Mapping + Rule Pack**，不修改 Recovery OS 核心；独立站场景必须允许 Store Adapter + Payment Adapter + Carrier Adapter 组合（Shopify+Stripe / WooCommerce+PayPal / Shopify+Shopify Payments / WooCommerce+Stripe 等），Chargeback 不得硬编码为 Shopify 专属模型。

> CrossClaim 自身向客户收费的 Stripe Billing 集成，与客户业务数据的 PSP 连接**必须严格分离**（不同连接、不同账本）。
