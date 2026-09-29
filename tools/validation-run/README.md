# Validation Run Toolkit（C-0009.1 / C-0009.1-A）

两条输入路径，都**不需要任何 API 与凭据**：

## 路径 1：平台导出文件直接丢进来（推荐）

支持 **CSV / JSON / XLSX**；PDF 只做结构识别（不做 OCR 自动化），未知结构一律 **QUARANTINE**。

```powershell
cd D:\crossclaim-ai\apps\api
npx tsx ../../tools/validation-run/run.ts --in <平台导出文件> --input-kind desensitized-real-structure
```

产出（目录 `out/validation-run-<sha256 前 8 位>/`）：

```text
VALIDATION-INPUT-ADAPTER-REPORT.md   适配报告：支持格式状态 / 字段覆盖率 / 不确定项(UNKNOWN+ACTION) / 未识别列
canonical-input.csv                  规范化后的 14 列输入
anonymized.csv                       脱敏后的输入
summary.json / report.md             结构校验结果（三层状态）
```

若适配器判定 QUARANTINE（必需列缺失 / 结构读不懂 / PDF / 未知格式），它会**直接停下**并只给适配报告：
请按报告里的 `ACTION: manual confirmation required` 人工确认映射后再跑，**工具不会替你猜**。

## 路径 2：用 14 列模板手工整理

模板：`tools/validation-run/template.csv`（文件名或前几行含 `TEMPLATE` 时一律判为 `NOT_RUN`，不算验证）。

## 规矩（架构方定的，工具遵守）

- 只回答「文件能不能被结构化」；**不判断费用是否合理、不判断能不能追回**（那是规则引擎与人的事）
- 只写本地产物：不写库、不接平台、不发外部请求
- 报告里只登记 sha256 与行数，不登记客户名/账号/合同原文
