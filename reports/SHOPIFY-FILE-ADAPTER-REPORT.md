# SHOPIFY-FILE-ADAPTER-REPORT

> 依据：架构方 **MSG-20260929-07 = GO_IMPLEMENTATION**（SHOPIFY-FILE-ADAPTER-DESIGN 通过）
> 分支 `gate/7-commercial-validation` · 实现复用 C-0009.1-A 适配器框架（仅新增 Shopify 别名 + fixtures + 测试）
> 边界：**只做** CSV/XLSX/JSON 导入、字段映射、quarantine、canonical input、validation report。
> **不做**：Shopify API、自动同步、dispute 提交、退款动作、规则判断、佣金计算、Schema 变更。

---

## 1. 支持格式与状态（实跑证据）

| 输入 | 格式判定 | 结果 |
|---|---|---|
| `shopify/02-orders-with-invoice.csv`（Orders 含发票列） | CSV | **PASS**；必需 3/3，可选 2/11 |
| `shopify/01-orders.csv`（Orders，Shopify 常见无发票号） | CSV | **QUARANTINE**（`REQUIRED_COLUMNS_MISSING`）+ invoiceNo ACTION |
| `shopify/03-disputes.csv`（Disputes 导出） | CSV | **PASS**；`claimOutcome` 映射自 `Dispute Status` |
| `shopify/04-multi-tracking.csv`（多运单号） | CSV | **PASS**；取第一个运单号 + `trackingNo` ambiguity |
| `shopify/05-missing-order-id.csv` | CSV | **QUARANTINE**；`orderId` 未映射，不猜测替代列 |
| PDF / 未知格式 | PDF / UNKNOWN | **QUARANTINE**（`PDF_STRUCTURE_ONLY_NO_OCR` / `UNKNOWN_FORMAT`） |

实跑命令（本地、离线）：

```bash
cd apps/api
npx tsx ../../tools/validation-run/run.ts --in fixtures/scenarios/shopify/02-orders-with-invoice.csv
npx tsx ../../tools/validation-run/run.ts --in fixtures/scenarios/shopify/01-orders.csv
```

首个用例产出：`out/validation-run-a2735d17/`（sha256 `a2735d17d95da556844abfc1c1ab124080ae6d2b9c2d331792d6c5959419e92e`，原始 2 行 → 规范化 2 行）。
第二个用例产出：`out/adapter-quarantine-6734c65e/VALIDATION-INPUT-ADAPTER-REPORT.md`（含 ACTION）。

---

## 2. 字段覆盖率与映射（Orders 含发票列）

| 规范字段 | 命中的原始表头 |
|---|---|
| `orderId` | `Name` |
| `trackingNo` | `Tracking Number` |
| `invoiceNo` | `Invoice Number` |
| `actualDeliveredAt` | `Fulfilled At` |
| `invoiceCurrency` | `Currency` |

- 必需列：**3/3**
- 可选列：**2/11**
- 未识别列（只列出、不猜）：`Total` 等

> `Total` 未自动映射到 `billedAmount`：不同平台该列语义不同（订单总额 / 账单金额），按「不猜」原则进 `unknownColumns`。

---

## 3. 不确定项（UNKNOWN + ACTION）

| 场景 | 报告内容 | 处置 |
|---|---|---|
| Shopify Orders 无发票号 | `invoiceNo` 未映射（必需列 2/3）→ `QUARANTINE` + `manual confirmation required` | 请人工确认发票号来源；**不得用订单号顶替** |
| 多运单号 | `trackingNo` 取第一个 + ambiguity 说明 | 其余单号仍可从原始行 `rawRowHash` 追溯；择优属未来规则层 |
| `Fulfilled At` → `actualDeliveredAt` | 已映射为候选 | 发货时间是否等同妥投需人工确认（SLA 判定不在本层） |
| 金额列语义 | `Total` 进未识别列 | 需人工确认后再决定是否映射 |

---

## 4. 数据治理（与 C-0009.1-A 一致）

- 只有 14 列白名单进入 canonical input；平台特有字段只进 metadata / `source` 证据。
- PII（Email / 电话 / 客户名 / 地址）默认掩码，掩码版本另存 `anonymized.csv`。
- 每行保留 `rowNumber`（含表头偏移）与 `rawRowHash`（sha256）；**原始文件只读、不覆盖**。
- 报告只登记 sha256 与行数，不含凭据、不含平台授权信息。

---

## 5. 验收（本地全绿）

| # | 用例 | 结果 |
|---|---|---|
| 1 | Orders 无发票号 → QUARANTINE + invoiceNo ACTION（不顶替） | ✅ |
| 2 | Orders 带发票号 → PASS，必需 3/3 | ✅ |
| 3 | Disputes 导出 → `claimOutcome` 映射自 `Dispute Status`，不做胜诉/追回判断 | ✅ |
| 4 | 多运单号 → 取第一个 + ambiguity | ✅ |
| 5 | 缺 orderId → QUARANTINE，不猜测替代列 | ✅ |
| 6 | 重复行 → 两行都保留，`rawRowHash` 相同、行号不同 | ✅ |
| 7 | 1 万行批量 → PASS，不丢行，`rowNumber` 连续（2 → 10001） | ✅ |
| 8 | PDF / 未知格式 → QUARANTINE | ✅ |
| 9 | 报告无凭据/授权字段，登记 sha256 | ✅ |

测试文件：`apps/api/src/__tests__/validation-run-shopify.test.ts`（9 用例）+ 既有 `validation-run-scenarios.test.ts`（14）+ `validation-input-adapter.test.ts`（9）共 **32 用例全绿**。

---

## 6. 仍然冻结的部分（未触碰）

```text
Shopify API                 HOLD
Stripe Dispute API          HOLD
PayPal Dispute API          HOLD
自动提交争议                FORBIDDEN
资金托管                    HOLD
15% 自动扣佣                HOLD
HS Code / 关税              BACKLOG
```
