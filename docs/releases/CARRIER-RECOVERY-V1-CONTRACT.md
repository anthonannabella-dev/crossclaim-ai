# CARRIER RECOVERY V1 CONTRACT（HOST DIRECTIVE 2026-10-02 补充五）

> 状态：**已登记（RECORDED）** —— 产品方向登记，**不实现**；不打断 R46 → Settlement/Billing → Full Regression 主队列。
> 边界：复用既有能力（Carrier Reference Data Adapter / FREIGHT_RATE_V1 / RuleVersion / RuleEvaluation / RecoveryOpportunity / Evidence / Claim / Approval / Settlement / Billing），**REUSE > EXTEND > NEW BUILD**。

## 登记状态

| 项 | 值 |
| --- | --- |
| CARRIER_RECOVERY_V1_REGISTERED | YES |
| COMMON_CARRIER_ENGINE_REGISTERED | YES |
| UPS_REGISTERED / FEDEX_REGISTERED / DHL_REGISTERED / USPS_REGISTERED | YES |
| 50_PLUS_AUDIT_TARGET_REGISTERED | YES |
| TOP_10_V1_RULES_REGISTERED | YES |
| UPS_COMPLIANCE_GATE_REGISTERED | YES |
| PROVIDER_CAPABILITY_MATRIX_REQUIRED | YES |
| CURRENT_R46_QUEUE_UNCHANGED | YES |
| CARRIER_RECOVERY_IMPLEMENTATION_STARTED | NO |

登记时间：2026-10-01T18:03:15.282Z

## 1. 产品目标

CARRIER RECOVERY ENGINE（V1：**UPS / FedEx / DHL / USPS**；后续 SF / 4PX / YunExpress / Cainiao / DPD / GLS / Royal Mail 等）。
客户体验：Connect/Upload Carrier Data → CrossClaim Audit → Recovery Opportunities → Expected Recoverable → Evidence → Human Approval → Claim/Dispute/Claim-Ready Package → Tracking → Recovery Confirmed → Settlement。

## 2. 架构原则（不得每个承运商一套系统）

```
COMMON CARRIER RECOVERY ENGINE
  InvoiceNormalizer / ShipmentNormalizer / ContractNormalizer / ReferenceData /
  RuleVersion / RuleEvaluation / RecoveryOpportunity / Evidence / Claim /
  Appeal·Dispute / HumanApproval / Settlement / Reconciliation
Provider-specific（仅限）：Data Adapter · Rule Pack · Claim/Dispute Adapter · Provider Policy / Reference Data
```

## 3. Audit Dimensions（V1 先 10 条，再 10 → 30 → 50+）

V1 Top-10：① Contract/Rate mismatch ② Fuel surcharge error ③ DAS/Remote Area surcharge error ④ Duplicate charge ⑤ Discount not applied ⑥ Weight/DIM weight error ⑦ Zone error ⑧ SLA/late-delivery eligibility ⑨ Wrong service level ⑩ Refund/credit approved but not received。
每条 Rule 必须：deterministic where possible · versioned · effective-date aware · auditable · reproducible · evidence-backed · tenant-safe · **ambiguous → fail-closed**。
**AI 不得替代可确定计算的 fee / rate / eligibility rule。**

## 4. 数据优先级

CUSTOMER CONTRACT → CUSTOMER RATE CARD → CUSTOMER BILLING/INVOICE EXPORT → CUSTOMER SHIPMENT/OMS/WMS/MANIFEST → OFFICIAL CARRIER REFERENCE DATA → OFFICIAL POLICY/SLA → DEFAULT RULE。
**不得**用公开 tariff 覆盖客户真实合同价格；沿用既有 Rule Tier precedence。

## 5. UPS Compliance Gate（必须）

**不得**把「UPS STANDARD API → bulk audit → invoice reconciliation → refund calculation」视为当然允许的商业用途（UPS API 条款可能限制 API Information 用于 audit / adjustments·refunds calculation / invoice reconciliation / financial performance analytics）。
V1 对 UPS 默认优先 **CUSTOMER-PROVIDED DATA**（UPS Invoice/Billing Export、Customer UPS Contract/Rate Card、Shipment Manifest、OMS/WMS export、customer-authorized evidence）→ Normalize → Audit → Opportunity → Evidence → Claim-Ready/Dispute。
只有完成 **UPS API TERMS REVIEW** 或 **SPECIAL PARTNER / AUTHORIZED ACCESS** 后，才允许扩大 UPS API 自动化范围。**不得为「全自动」绕过 Provider Terms。**

## 6. Provider Capability Matrix（FedEx / DHL / USPS 各自建立）

READ：invoices · shipment events · rating data · adjustments · refund status；WRITE：claim · dispute · adjustment request · supporting evidence · appeal。
每个 capability 标记：SUPPORTED / MANUAL / CUSTOMER_UPLOAD / PARTNER_REQUIRED / PROHIBITED / UNKNOWN（**UNKNOWN 默认 fail-closed**）。
**不得**因技术可调用就假设合同/政策允许商业自动审计或自动申诉。

## 7. 冻结

NO automatic Settlement from R45 · NO automatic Fee · NO automatic Invoice issuance · NO Payment activation · NO autopay · NO platform write · TRANSPORT=false · NO production credentials；R13 Payment Activation Gate = HOLD。
本指令不改变当前主线：**R46 → Settlement/Billing → Full Regression** 继续自治执行。
