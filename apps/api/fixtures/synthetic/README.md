# Synthetic datasets（Phase A）

平台级 realistic 合成数据集：**纯文本、无真实客户数据、无凭据、无网络**。
用途：在没有真实导出文件的前提下，覆盖各平台解析 / 归一化 / 参照数据路径，并作为 `REAL-DATA-VALIDATION-BACKLOG.md` 的模拟覆盖证据。

| 文件 | 走哪个适配器 | 期望结果 |
|---|---|---|
| `shopify-orders-sample.csv` | validation-run 适配器 | PASS，必需列 3/3；多单号只取第一个 + ambiguity |
| `amazon-settlement-sample.csv` | validation-run 适配器 | PASS（Order ID/Tracking Number/Invoice Number 命中别名） |
| `tiktok-settlement-sample.csv` | validation-run 适配器 | PASS |
| `walmart-settlement-sample.csv` | validation-run 适配器 | **QUARANTINE**：以 PO Number 为主键，适配器不把 PO 当订单号（不猜测）→ 已知差距，待真实文件确认 |
| `carrier-invoice-sample.csv` | validation-run 适配器 | 平台专有列（Carrier/Service/Fuel Rate 等）只进未知列清单，不猜测 |
| `customs-7501-sample.csv` | validation-run 适配器 | QUARANTINE（缺 orderId/trackingNo/invoiceNo），未知列全部登记 |
| `carrier-fuel-rate-sample.csv` | 承运商参照数据适配器 | PASS → `CARRIER_FUEL_SURCHARGE` |
| `carrier-das-zip-sample.csv` | 承运商参照数据适配器 | PASS → `CARRIER_DAS_ZIP`，邮编保留前导零 |
| `customs-duty-rate-sample.csv` | 关税参照数据适配器 | PASS → `CUSTOMS_DUTY_RATE` |
| `customs-301-exclusion-sample.csv` | 关税参照数据适配器 | PASS → `CUSTOMS_301_EXCLUSION` |

纪律：合成数据集只能证明「解析与归一化路径可用」，**不能**替代真实数据验证（见 backlog RD-01…RD-07）。

## 已知差距（由合成数据暴露）

- **Walmart 结算导出主键**：真实导出常以 PO Number / Purchase Order Number 作为行标识，而 canonical 14 列要求 orderId。
  当前适配器不做 PO→orderId 的猜测映射，因此该文件会 QUARANTINE 并附带 ACTION。
  处置：拿到真实 Walmart 导出后确认列名与语义，再决定是否新增别名（属数据映射决策，需与架构方确认，见 REAL-DATA-VALIDATION-BACKLOG.md RD-03）。
