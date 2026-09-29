# CARRIER REFERENCE DATA ADAPTER — IMPLEMENTATION CHECKPOINT

> 分支 `gate/7-commercial-validation` · Codex · 2026-09-29 · 依据 **MSG-20260929-14（GO_IMPLEMENTATION / STEP1 ONLY）**

## 1. 交付物

| 文件 | 说明 |
|---|---|
| `apps/api/src/services/reference-data/index.ts` | 参照数据适配器（承运商 + 关税，单模块） |
| `apps/api/src/__tests__/reference-data.test.ts` | 26 条验收用例（承运商 12 + 关税 12 + 旁路 2） |
| `CARRIER-REFERENCE-DATA-ADAPTER-DESIGN.md` | 获批设计（本检查点按其 §9 逐条验证） |

## 2. 支持范围（与设计一致）

- 输入：CSV / TSV、XLSX、JSON（数组或 `{ items: [...] }`）；PDF → 仅结构识别 → QUARANTINE
- 三类参照数据：`CARRIER_FUEL_SURCHARGE` / `CARRIER_DAS_ZIP` / `CARRIER_SLA_SUSPENSION`
- 输出：规范化参照工件（`artifactVersion=reference-data/v1` + `sourceSha256` + 每行 `rowHash`）+ 校验报告
- 复用 C-0009.1-A 适配框架的解析与 XLSX 读取；**无 Schema、无依赖、无网络、无数据库写入**

## 3. 测试结果（本地实跑）

| 用例 | 结果 |
|---|---|
| 01 燃油费率表 CSV → PASS，条目与窗口正确 | PASS |
| 02 DAS 邮编表 → 保留前导零 `01234` | PASS |
| 03 SLA 暂停公告 → 区间与原因正确 | PASS |
| 04 缺必需列 → 文件级 QUARANTINE + ACTION | PASS |
| 05 行内 `03/04/2026` → 该行 INVALID_DATE，其余行照常 | PASS |
| 06 窗口倒置 → INVERTED_WINDOW | PASS |
| 07 重叠窗口 → AMBIGUOUS_WINDOW（不自动择一） | PASS |
| 08 费率 `0.125` → AMBIGUOUS_RATE_SCALE | PASS |
| 09 未知列 → 只登记不进映射（且不回传原文） | PASS |
| 10 PDF → PDF_STRUCTURE_ONLY_NO_OCR | PASS |
| 11 同输入两次 → 工件一致（除 generatedAt） | PASS |
| 12 重复行 → 保留两行 + duplicates 计数 | PASS |

合计：`reference-data.test.ts` **26/26 通过**；`tsc --noEmit` 通过。

## 4. quarantine 案例（可复现）

| 触发 | 层级 | 报告字段 |
|---|---|---|
| 缺 `effectiveDate` 列 | 文件级 | `status=QUARANTINE`、`quarantineReason=MISSING_REQUIRED_FIELD`、`artifact=null` |
| `03/04/2026` 日期 | 行级 | `quarantinedRows[{rowNumber,rowHash,reason=INVALID_DATE}]`（**不含原始值**） |
| 费率 `0.125` | 行级 | `reason=AMBIGUOUS_RATE_SCALE` |
| 重叠生效窗口 | 报告级 | `ambiguities[].detail` 含 `AMBIGUOUS_WINDOW` + 行号 |

## 5. 实施中发现并修正的两个问题（自测阶段）

1. **列定位错误**：初版用 `row.indexOf(列名)` 在**数据行**里找列名 → 全部行判为缺字段。
   修正为按表头建立 `字段 → 列下标` 映射（`indexMap`），只在表头定位。这是实现缺陷，不是设计变更。
2. **缺必需列未做文件级隔离**：初版只在行级报缺字段。按设计 §6 改为**表头级直接 QUARANTINE**
   （不产出部分工件）。

## 6. 仍冻结（无变化）

`carrier_rules` 建表 · `RuleEvaluation` · SLA 违约判定 · 燃油费错扣判定 · DAS 误判判定 · Claim 金额 · 申诉函 · 自动提交 · 官网抓取。

## 7. 已知限制（不猜）

- XLSX 只读第一个工作表；多表情形目前无法自动识别为 ambiguity（读取器限制），已在设计 §7 声明，未做臆测。
- 承运商名只做大小写/空白归一，不做品牌归一（属规则层）。
