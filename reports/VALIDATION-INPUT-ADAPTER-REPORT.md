# VALIDATION-INPUT-ADAPTER-REPORT（C-0009.1-A）

> 架构方裁定 MSG-20260929-02 批准的验收产物。
> 只说明「文件能不能被结构化」；**不做业务判断、不生成索赔、不接平台、不改 Schema**。
> 本报告的事实来源：仓库内单元用例（9 条）+ 本地实跑（见每项的「实跑」列）。

## 1. 支持格式（PASS / QUARANTINE）

| 格式 | 状态 | 说明 |
|---|---|---|
| **CSV**（平台导出） | ✅ PASS | 别名表命中即映射；实跑 Amazon 风格导出：必需列 3/3、可选列 8/11、`adapterStatus=PASS` |
| **JSON**（对象数组） | ✅ PASS | 键并集做表头；单元用例 2 行数据全部映射 |
| **XLSX**（首张工作表） | ✅ PASS | 零依赖读取（zlib 解压 + sharedStrings + sheet1）；单元用例验证表头与首个数据行 |
| **PDF** | ⛔ QUARANTINE | 只做结构识别，不进入 OCR 自动化（`PDF_STRUCTURE_ONLY_NO_OCR`） |
| **未知格式 / 结构读不懂** | ⛔ QUARANTINE | `UNKNOWN_FORMAT` / `STRUCTURE_UNREADABLE`，并给出 ACTION |
| **模板文件（template.csv）** | ⛔ NOT_RUN | 文件名或前几行含 `TEMPLATE` → 一律不计入商业验证（沿用 C-0009.1 规矩） |

## 2. 字段覆盖率（规范 14 列）

必需列（3）：`orderId`、`trackingNo`、`invoiceNo`；可选列（11）：其余。
实跑 Amazon 风格导出（`sample-amazon-export.csv`）：

| 规范列 | 命中的原始表头 |
|---|---|
| `orderId` | `Amazon Order ID` |
| `trackingNo` | `Tracking Number` |
| `invoiceNo` | `Invoice No` |
| `channel` | `Carrier` |
| `promisedDeliveredAt` | `Promised Delivery` |
| `actualDeliveredAt` | `Delivered At` |
| `billedAmount` | `Freight Charge` |
| `invoiceAmount` | `Invoiced Amount` |
| `invoiceCurrency` | `Currency`（有歧义，见下） |
| `evidenceRef` | `POD` |
| `note` | `备注` |
| `billedCurrency` / `settlementRef` / `claimOutcome` | （未命中，保持空） |

→ **必需列 3/3 · 可选列 8/11**；未命中的列**保持空**，不猜、不用别的列顶替。

## 3. 不确定项（必须人工确认，绝不自行猜）

```text
UNKNOWN: currency — 只有一列通用币种，无法判断它属于账单还是运费
ACTION: manual confirmation required

UNKNOWN: billedCurrency — 运费币种缺失（未自行复制账单币种）
ACTION: manual confirmation required
```

## 4. 无法识别的原始列

实跑样例中：**无**。
若出现，会原样列进 `VALIDATION-INPUT-ADAPTER-REPORT.md` 的「无法识别的原始列」一节，**不映射、不猜测**。

## 5. 数据治理承诺（实现层面）

- 字段白名单：只产出规范 14 列；原始文件**只读**，从不覆盖、不改写
- 保留**原始行号**（`rowNumber`，含表头偏移）与**逐行原始内容指纹**（`rawRowHash`，sha256）
- 源文件只登记 **sha256 与行数**；报告不含客户名、账号、合同原文
- 全程本地：无网络、无凭据、无平台账号；不写数据库

## 6. 执行方式（宿主可直接用）

```powershell
cd D:\crossclaim-ai\apps\api
npx tsx ../../tools/validation-run/run.ts --in <平台导出文件> --input-kind desensitized-real-structure
```

产出（`out/validation-run-<sha256 前 8 位>/`）：
`VALIDATION-INPUT-ADAPTER-REPORT.md/json` · `canonical-input.csv` · `anonymized.csv` · `summary.json` · `report.md`

适配器判 QUARANTINE 时会**直接停下**并只给适配报告——请按 ACTION 人工确认映射后再跑。
