# PHASE1-DATA-FIELD-DICTIONARY — 字段说明（交付/质控口径）

> 依据：架构方 **MSG-20260930-02** 批准等待期「文档完善（数据字段说明）」。
> 目的：让宿主/操作者明确「交什么列、写什么值、哪些是 Phase 1 的、哪些不是」，避免把两类契约混用。
> 纪律不变：**系统不猜字段、不自动改写表头、不自动补值**；缺口只登记、只退回补齐。

---

## 0. 两套契约不要混用

| 契约 | 用途 | 列 |
|---|---|---|
| **Phase 1 交付契约**（`HOST-DATA-REQUEST.md` / `inbox/README.md`） | 宿主交给 Phase 1 验证的**最小列集**；`preflight` 直接检查的就是这套 | 必需 4 列：`order_id`、`occurred_at`、`amount`、`currency`（+ 可选列） |
| **Validation Run 契约**（`tools/validation-run/template.csv`，14 列） | 平台导出**结构适配器**的规范输入（判断「文件能不能被结构化」） | `orderId`、`trackingNo`、`invoiceNo`、`channel`、`promisedDeliveredAt`、`actualDeliveredAt`、`billedAmount`、`billedCurrency`、`invoiceAmount`、`invoiceCurrency`、`evidenceRef`、`settlementRef`、`claimOutcome`、`note` |

两者**不是同一套列名**：Phase 1 的 4 列是最小验证入口；14 列是适配器契约（含物流/账单字段）。
例如 UCI 零售导出只命中 14 列中的 2 列，因此适配器给出 `QUARANTINE (REQUIRED_COLUMNS_MISSING)` —— 这是**预期行为**，不是系统故障。

## 1. Phase 1 必需列（阻断项）

| 列 | 含义 | 格式 / 取值 | 示例 | 常见错误 |
|---|---|---|---|---|
| `order_id` | 订单唯一标识 | 字符串；**同一订单在所有行必须一致**（可哈希） | `SO-1001` | 重复值（同单多行未聚合/未标注）；空值 |
| `occurred_at` | 订单/退款发生时间 | ISO 8601（`YYYY-MM-DD` 或带 `T`） | `2026-09-01T00:00:00Z` | 本地化写法（`2026/9/1`）、多格式混排、时区含义不明 |
| `amount` | 金额 | 纯数字，**不要**货币符号/千分位逗号；退款按来源口径保留**正负号** | `120.50` / `-45.00` | `¥120.50`、`1,234.50`、空值、用科学计数法 |
| `currency` | 币种 | 3 位 ISO 代码（大写） | `JPY` / `USD` / `EUR` | `￥`、`RMB`、`美元`、混币种未标注 |

> Stage 0（`preflight`）只做**结构/列名/数量/可解析性**检查：不判断金额是否合理、不做任何运算、不读取内容语义。
> 空值、币种一致性等**数值语义**问题在 Stage A（导入）与 `DATA-QUALITY-REPORT.md` 记录，不在此处猜测。

## 2. Phase 1 可选列（有则更有利于 Stage B/C）

| 列 | 含义 | 示例 | 作用 |
|---|---|---|---|
| `refund_amount` | 退款金额 | `45.00` | 退款/结算异常线索 |
| `shipping` | 运费 | `12.00` | 运费口径比对 |
| `shipping_method` | 配送方式 | `Express` | 与 SLA 相关的线索 |
| `destination_country` | 目的国（**国家即可，不要地址**） | `JP` | 关税/合规相关线索 |
| `weight` | 重量（含单位） | `1.20kg` | 计费重比对 |
| `fulfillment_status` | 履约状态 | `fulfilled` | 状态异常线索 |
| `financial_status` | 财务状态 | `paid` / `refunded` | 金额/结算异常线索 |
| `tracking_number` | 运单号（可哈希，同单一致） | `1Z9...` | 物流链路对齐 |
| `order_name` | 订单展示名（**非** PII） | `#1001` | 人工复核可读性 |
| `product_name` | 商品名（**非** PII） | `Widget` | 人工复核可读性 |

## 3. 禁止列（出现即 `NEEDS_FIX`）

买家/收件人姓名、邮箱、电话、地址、邮编、证件号，以及任何平台凭据、API Key、支付卡数据。
列名命中即判定（保守）；**不读取内容**，因此不会产生隐私暴露。
业务标识（`order_name`、`product_name`、`variant_name`、`file_name` 等）在**白名单**内，不计为 PII。

## 4. 交付前自检（10 秒）

```text
node tools/validation/phase1-runbook.mjs preflight <dataset.csv>
```

- 期望：`verdict = READY_FOR_STAGE_A`（退出码 0），`blockingChecks = []`
- 否则：按 `blockingChecks` 与 `checks[].detail` 逐项补齐；`alias-hints` 只是别名提示，**不会**让检查自动通过

## 5. 相关文档

- 交付请求与登记表：[`HOST-DATA-REQUEST.md`](HOST-DATA-REQUEST.md)
- 执行手册（含常见错误案例）：[`PHASE1-VALIDATION-RUNBOOK.md`](PHASE1-VALIDATION-RUNBOOK.md)
- 投放目录说明：[`inbox/README.md`](inbox/README.md)
