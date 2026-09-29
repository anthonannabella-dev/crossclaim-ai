# CUSTOMS RATE REFERENCE ADAPTER — IMPLEMENTATION CHECKPOINT

> 分支 `gate/7-commercial-validation` · Codex · 2026-09-29 · 依据 **MSG-20260929-14（GO_IMPLEMENTATION / STEP1 ONLY）**

## 1. 交付物

| 文件 | 说明 |
|---|---|
| `apps/api/src/services/reference-data/index.ts` | 参照数据适配器（关税部分：税率表 / 301 豁免清单） |
| `apps/api/src/__tests__/reference-data.test.ts` | 26 条验收用例（关税 12 条见下） |
| `CUSTOMS-RATE-REFERENCE-ADAPTER-DESIGN.md` | 获批设计（本检查点按其 §9 逐条验证） |

## 2. 支持范围（与设计一致，且只做字符规范化）

- 输入：CSV / TSV、XLSX、JSON；**PDF（C88 / 7501）→ 仅结构识别 → QUARANTINE（OCR 仍 BACKLOG）**
- 两类参照数据：`CUSTOMS_DUTY_RATE` / `CUSTOMS_301_EXCLUSION`
- HS Code 只做字符串规范化：去 `.` `-` 空白后必须 6 / 8 / 10 位数字；**不改写、不归类、不推断**
- 输出：规范化参照工件 + 校验报告；**不建表、不匹配 Import_Date、不算退税额、不生成诊断报告、不申报**

## 3. 测试结果（本地实跑）

| 用例 | 结果 |
|---|---|
| 01 税率表 CSV → PASS，条目与窗口正确（`85044095` 等） | PASS |
| 02 301 豁免清单 → flag 解析为布尔 + 到期日保留 | PASS |
| 03 HS 带点号 `8504.40.95` → `85044095`（含义不变） | PASS |
| 04 HS 长度非法 `8504` → INVALID_HS_CODE | PASS |
| 05 国家码 `US-CA` → INVALID_COUNTRY_CODE（不截断） | PASS |
| 06 税率 `0.085` → AMBIGUOUS_RATE_SCALE；`8.5` / `8.5%` / `0` 通过 | PASS |
| 07 窗口倒置 → INVERTED_WINDOW | PASS |
| 08 同 HS 重叠窗口 → AMBIGUOUS_WINDOW | PASS |
| 09 `exclusionFlag` 缺失 → `unknown`（与 `false` 区分） | PASS |
| 10 PDF（7501 样例）→ PDF_STRUCTURE_ONLY_NO_OCR，零条目 | PASS |
| 11 同输入两次 → 工件一致（除 generatedAt） | PASS |
| 12 JSON（`items` 数组）可用，未知列只登记 | PASS |

合计：与承运商共用 `reference-data.test.ts`，**26/26 通过**；`tsc --noEmit` 通过。

## 4. quarantine 案例（可复现）

| 触发 | 层级 | 报告字段 |
|---|---|---|
| 缺 `Base Rate` / `Effective Date` 列 | 文件级 | `status=QUARANTINE`、`quarantineReason=MISSING_REQUIRED_FIELD`、`artifact=null` |
| HS 长度非法 | 行级 | `quarantinedRows[{rowNumber,rowHash,reason=INVALID_HS_CODE}]`（**不含原始值**） |
| 国家码带子辖区 | 行级 | `reason=INVALID_COUNTRY_CODE` |
| 税率写成小数 | 行级 | `reason=AMBIGUOUS_RATE_SCALE` |
| `exclusionFlag` 非法字面量 | 行级 | `reason=INVALID_FLAG` |

## 5. 与合规边界的关系（仍保持冻结）

- 未做任何 HS 归类；`customs_duty_rates` 未建表；未做 `Import_Date` 历史税率匹配；
- 未生成《关税退税诊断报告》；未接任何官方 API，也未抓取官网数据；
- 合规边界评审（HS Code 责任归属）仍是进入 Step 3 的前置条件（MSG-20260929-13 C5）。

## 6. 已知限制（不猜）

- `exclusionFlag` 缺失记 `unknown`（三态），报告区分 `missing` 与 `false`；
- 重叠窗口只报歧义，「唯一生效关系」留给 `CUSTOMS-RATE-DATA-MODEL-DESIGN.md` 与规则设计；
- XLSX 只读第一个工作表（读取器限制，已声明）。
