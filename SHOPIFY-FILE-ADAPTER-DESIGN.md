# SHOPIFY-FILE-ADAPTER-DESIGN

> 状态：**APPROVED IN PRINCIPLE**（架构方 MSG-20260929-06：`SHOPIFY-FILE-ADAPTER / SCOPE: same as C-0009.1-A`）
> 提出：2026-09-29（Codex）· 分支 `gate/7-commercial-validation`
> 性质：**范围文档（Design Only）**——本文件用于取得实施批准，不含实现承诺。

---

## 0. 一句话

把 **Shopify Admin 后台导出的订单/争议文件**（CSV / XLSX / JSON）映射成 VALIDATION-RUN 需要的**规范输入**，
与既有 C-0009.1-A 平台导出适配器**同一模式、同一边界**：只做「结构化」，不做业务判断。

---

## 1. 边界（逐条对齐 MSG-20260929-06）

| 允许 | 禁止 |
|---|---|
| CSV / XLSX 导入 | Shopify API（任何形式） |
| 字段映射 | 自动同步 / 轮询 / 游标 |
| quarantine（无法理解的数据） | Dispute 提交（Stripe/PayPal/卡组织） |
| canonical input（14 列规范输入） | 退款动作 |
| validation report（结构校验报告） | 规则判断（可追回、是否合理） |
| — | 佣金计算 / 资金动作 |

补充（沿用 C-0009.1-A 的既有裁定）：

- **不新增 Schema**；复用现有适配器与报告渲染能力。
- **不覆盖原始数据**；只登记 sha256、行数与原始行号。
- **PDF 仅结构识别**，一律 QUARANTINE（不引入 OCR）。

---

## 2. 支持文件格式

| 格式 | 来源（示例） | 处理 |
|---|---|---|
| CSV | Shopify Admin → Orders → Export（"Orders" 视图）；Disputes/Chargeback 列表导出 | 解析表头 → 别名映射 → 规范化 |
| XLSX | 同上（导出为 Excel） | 复用零依赖 XLSX 读取（sharedStrings + sheet1） |
| JSON | 若商家从 App / 报表工具导出 JSON 数组 | 取并集表头 → 同 CSV 流程 |
| PDF | 平台账单/争议通知 PDF | **仅结构识别 → QUARANTINE**（`PDF_STRUCTURE_ONLY_NO_OCR`） |
| 其他/无法识别 | 任意未知二进制或文本 | QUARANTINE（`UNKNOWN_FORMAT`） |

---

## 3. 字段映射（Shopify → 14 列规范输入）

规范列（沿用 C-0009.1）：`orderId, trackingNo, invoiceNo, channel, promisedDeliveredAt, actualDeliveredAt,`
`billedAmount, billedCurrency, invoiceAmount, invoiceCurrency, evidenceRef, settlementRef, claimOutcome, note`

### 3.1 必需列

| 规范字段 | Shopify 来源（别名，大小写/空格/下划线不敏感） | 说明 |
|---|---|---|
| `orderId` | `Name` / `Order Name` / `Order ID` / `ID` | 订单号（如 `#1001`）原样保留 |
| `trackingNo` | `Tracking Number` / `Tracking Numbers` / `Tracking No` | 多单号时**取第一个并记 ambiguity**，不拼接、不猜 |
| `invoiceNo` | `Invoice Number` / `Invoice No` / `Reference` | **Shopify Orders 导出通常没有发票号** → 记 `UNKNOWN: invoiceNo missing / ACTION: manual confirmation required`，不自行用订单号顶替 |

### 3.2 可选列

| 规范字段 | Shopify 来源（别名） | 说明 |
|---|---|---|
| `channel` | `Channel` / `Source` / `Sales Channel` | 缺省留空 |
| `promisedDeliveredAt` | `Promised Delivery` / `Estimated Delivery`（若导出含） | 缺失即留空（SLA 判定不在此层） |
| `actualDeliveredAt` | `Delivered At` / `Fulfilled At` / `Delivered`（若导出含） | 缺失即留空 |
| `billedAmount` / `billedCurrency` | `Total` / `Shipping` / `Currency` | 只有命名明确时才映射；`Subtotal`+`Taxes` 需拆分时**不猜** |
| `invoiceAmount` / `invoiceCurrency` | `Invoice Total` / `Invoice Currency` | 仅当文件确有发票列 |
| `evidenceRef` | `Tracking URL` / `Note` / `Fulfillment` | 作为证据引用；不解析内容 |
| `settlementRef` | `Payout ID` / `Settlement`（若导出含） | 缺失留空 |
| `claimOutcome` | `Dispute Status` / `Chargeback Status`（Disputes 导出） | 原样字符串 |
| `note` | `Notes` / `Tags` | 原文保留 |

### 3.3 只进 metadata（不进 canonical 字段，仅用于报告）

`Financial Status`、`Fulfillment Status`、`Created at`、`Paid at`、`SKU`、`Lineitem name`、
`Dispute Reason`、`Dispute Amount`（金额只登记为 metadata，**不做任何判断**）。

### 3.4 未识别列

一律进入报告的 `unknownColumns`，**只列出、不猜测含义**（与 C-0009.1-A 一致）。

---

## 4. 数据白名单与 PII 处理

| 项 | 规则 |
|---|---|
| 写入 canonical 的列 | 仅上表 14 列白名单；其余列永不写规范输入 |
| PII（`Email` / `Phone` / `Customer Name` / 地址 / 备注中的个人信息） | **默认掩码**（复用既有 anonymize 能力）；掩码版本另存 `anonymized.csv` |
| 平台特有字段 | 只进 `source`/metadata 证据载荷，不进核心领域模型（架构契约 §6） |
| 原始文件 | 只读、不覆盖、不重命名；报告只登记 sha256 与行数 |

---

## 5. quarantine 策略

| 触发条件 | 结果 |
|---|---|
| 缺任一必需列（`orderId`/`trackingNo`/`invoiceNo`） | `QUARANTINE` + 逐列 `ACTION: manual confirmation required` |
| 结构无法解析（坏 CSV / 空 JSON 数组 / 损坏 XLSX） | `QUARANTINE`，返回可读报告（不抛未捕获异常） |
| PDF / 未知格式 | `QUARANTINE`（原因码见 §2） |
| 多单号 / 字段值格式异常（如金额非数字） | 保留原值 + 记 ambiguity；**不修正、不推断** |
| 行级治理 | 每行保留 `rowNumber`（1-based，含表头偏移）与 `rawRowHash`（sha256） |

---

## 6. 交付物

```text
out/validation-run-<sha8>/
  SHOPIFY-ADAPTER-REPORT.md     支持格式状态 / 字段覆盖率 / UNKNOWN + ACTION / 未识别列
  canonical-input.csv           14 列规范输入
  anonymized.csv                掩码后的输入
  summary.json / report.md      结构校验三层状态（engineering / validationRun / commercialConclusion）
```

---

## 7. 实现方式（复用，不新造）

1. 复用 `apps/api/src/services/validation-run/adapters/*`（格式识别、别名映射、quarantine、报告渲染）。
2. 新增**别名条目**（Shopify 列名）+ 一个 Shopify 场景 fixture 集。
3. `tools/validation-run/run.ts` 增加 `--source shopify`（仅影响报告标题与别名集合，不改变处理逻辑）。
4. **无 Schema 变更、无新依赖、无网络调用**。

---

## 8. 验收标准（实施后提交）

| # | 用例 | 期望 |
|---|---|---|
| 1 | Shopify Orders CSV（含 Order Name / Tracking Number / Currency / Total） | `PASS`，必需 2/3（`invoiceNo` 触发 ACTION） |
| 2 | Shopify Orders CSV 带发票列 | `PASS`，必需 3/3 |
| 3 | Shopify Disputes CSV | `PASS`，`claimOutcome` 映射自 `Dispute Status` |
| 4 | 缺 `orderId` | `QUARANTINE` + 明确 ACTION |
| 5 | 多单号 | `PASS` + ambiguity 记录（取第一个） |
| 6 | 重复行 | 两行都保留，`rawRowHash` 相同 |
| 7 | 1 万行批量 | `PASS`，行数一致，耗时 < 20s（CI 阈值） |
| 8 | PDF / 未知格式 | `QUARANTINE` |
| 9 | 全程离线断言 | 无网络、无凭据、不写数据库 |

---

## 9. 已知未知（不猜，先记录）

1. **Shopify Orders 导出通常无发票号** → 真实文件到位前，`invoiceNo` 恒为 ACTION；是否需要用户在导入时手工指定映射列，等真实文件确认。
2. **Disputes 导出列名因地区/语言而变化** → 别名表先覆盖英文列名；其余进 `unknownColumns`。
3. **多单号订单占比未知** → 先用"取第一个 + ambiguity"的保守策略。

---

## 10. 变更影响评估

| 维度 | 影响 |
|---|---|
| 领域模型 / Prisma | **无** |
| 资金链路 | **无** |
| 规则引擎 | **无** |
| 安全边界 | **无新增面**（无网络、无凭据；PII 默认掩码） |
| 依赖与许可证 | **无新增依赖** |
| Gate 边界 | 不进入新 Gate；属 C-0009.1-A 同模式的输入层扩展 |

---

## 11. 请求裁决

请裁定：**GO**（按 §7 实现并提交 §8 验收）/ **REVISE**（指出需修改项）/ **HOLD**（继续等待真实文件）。
