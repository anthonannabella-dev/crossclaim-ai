# inbox/ — Phase 1 真实数据投放目录

> 用途：宿主把 Phase 1 的**真实/脱敏**导出文件放到这里（`D:\crossclaim-ai\inbox\`），然后告知路径。
> **安全约束**：本目录下的数据文件**不会进入 Git**（见仓库根 `.gitignore` 的 `inbox/*` 规则，仅保留本 README）。请勿把真实客户数据提交到仓库。

## RD-01（首批优先）· Shopify Orders Export

- 格式：CSV 或 XLSX
- 建议规模：**≥500 单**（推荐 1,000–10,000），时间范围**最近 3 个月**优先
- 必须字段：`Order ID`、`Order Name`、`Created At`、`Fulfillment Status`、`Financial Status`、`Tracking Number`、`Fulfilled At`、`Currency`、`Total Price`
- 可选字段：`Refund Subtotal`、`Shipping`、`Shipping Method`、`Destination Country`、`Weight`（或 `Refund Status`、`Dispute Status`、`Chargeback Status`）
- 脱敏建议：姓名/地址/邮箱/电话可整列替换为占位符；订单号可哈希，但**同一订单内保持一致**
- 命名建议：`shopify-orders-<YYYYMM>-<YYYYMM>.csv`
- 表头命名（推荐）：直接使用 canonical 名 `order_id,occurred_at,amount,currency`；
  若保留 Shopify 原生列名（`Order ID` / `Created At` / `Total Price`），需人工确认映射表——**系统不会自动猜字段**

## RD-02（第二优先）· Amazon 结算类导出

- `Amazon Settlement Summary` / `Transaction Report` / `FBA Inventory Reconciliation`（CSV/XLSX）

## RD-04（第三优先）· 承运商运费账单

- DHL / FedEx / UPS / 专线账单（CSV/XLSX）
- 至少含：`Shipment ID`、`Tracking No`、`Ship Date`、`Destination ZIP`、`Charge Amount`、`Service Level`、`Delivery Date`

## 放开文件后会发生什么

```text
node tools/validation/phase1-runbook.mjs preflight <dataset.csv>   # Stage 0：入场前置检查（只读）
```

`Shopify Export → Stage 0 preflight → Import → Normalization → Validation → Quarantine → Candidate Discovery → Human Verification → PHASE1-RESULT.md`

交付清单与登记表见 [`HOST-DATA-REQUEST.md`](../HOST-DATA-REQUEST.md)；验收标准、完整性等式与 Decision Gate 见
[`PHASE1-REAL-DATA-VALIDATION.md`](../PHASE1-REAL-DATA-VALIDATION.md)。
