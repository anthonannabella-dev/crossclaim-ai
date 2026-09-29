# CUSTOMS RATE REFERENCE ADAPTER DESIGN — CrossClaim AI

> 状态：**DESIGN ONLY（未实现）** · 依据架构方 **MSG-20260929-13 Q3：Step 1 已批准（GO）**
> 本文档即该裁决要求的验收文档。分支 `gate/7-commercial-validation` · Codex · 2026-09-29

---

## 1. 边界（严格照 MSG-20260929-13）

允许：参照数据适配 · 版本化 · 校验报告。

禁止：`customs_duty_rates` 建表 · Schema 迁移 · 规则或税率适用判断 · 退税金额计算 · HS Code 归类 · 对外申报 · 自动抓取官方数据。

数据流（只有这一段）：

    官方发布的税率表 / 301 豁免清单（人工上传）
        → 解析 → 字段白名单映射 → 生效窗口解析 → 行级校验
        → 规范化参照工件（带版本指纹） + 校验报告

**本阶段不落库**：不新增模型、不改 Prisma Schema。`CUSTOMS-RATE-DATA-MODEL-DESIGN.md` 是**另一份**待提交设计，未获批前不建表。

---

## 2. 支持格式与数据类型

| 输入 | 处理 |
|---|---|
| CSV / TSV | 解析 + 映射 |
| XLSX | 解析（第一个工作表；多表记 ambiguity） |
| JSON | 数组或 `{ items: [...] }` |
| PDF（C88 / 7501 等） | **仅结构识别 → QUARANTINE**（OCR 维持 BACKLOG，MSG-20260929-13 C4） |
| 其它 | QUARANTINE（`UNKNOWN_FORMAT`） |

两类参照数据：关税税率表（duty rate table）与 Section 301 豁免清单（exclusion list）。

---

## 3. 字段白名单

| 规范字段 | 必需 | 别名示例 | 适用 |
|---|---|---|---|
| `countryCode` | 是 | country, country_code, 国家代码, destination | 两类 |
| `hsCode` | 是 | hs, hs_code, hts, hts code, tariff code, 税则号 | 两类 |
| `baseDutyRate` | 税率表必需 | base rate, general rate, duty rate, 基础税率 | 税率表 |
| `preferentialRate` | 否 | preferential, fta rate, 优惠税率 | 税率表 |
| `exclusionFlag` | 否 | exclusion, 301 exclusion, section 301, 豁免标记 | 两类 |
| `exclusionId` | 否 | exclusion id, 豁免编号 | 豁免清单 |
| `effectiveDate` | 是 | effective_date, effective from, 生效日期 | 两类 |
| `expirationDate` | 否 | expiration_date, effective to, 失效日期 | 两类 |
| `sourceNote` | 否 | source, authority, reference, 来源 | 两类 |

说明：HS Code 在本阶段只被**规范化为字符串**，绝不被归类或改写。

---

## 4. 解析与归一规则（防猜）

1. HS Code 规范形态：去除分隔符（`.` `-` 空格）后必须为 6 / 8 / 10 位数字；其它长度或含字母 → 该行 QUARANTINE（`INVALID_HS_CODE`）。原文与规范值的对应关系在报告可查。
2. 国家代码：接受 ISO 3166-1 alpha-2（大小写归一）。出现 `US-CA` 这类子辖区 → QUARANTINE（`INVALID_COUNTRY_CODE`，不截断）。
3. 税率：接受 `8.5` 或 `8.5%`（百分数）与 `0`；写成小数 `0.085` 且列名未声明为小数 → QUARANTINE（`AMBIGUOUS_RATE_SCALE`）。只存字符串，**不做任何乘除**。
4. 日期：只接受 `YYYY-MM-DD` / `YYYY/MM/DD` / 带时区 ISO 8601；其余 → QUARANTINE（`INVALID_DATE`）。
5. `expirationDate <= effectiveDate` → QUARANTINE（`INVERTED_WINDOW`）。
6. 重叠窗口（同 country+hsCode 期间重叠）→ 不判定谁优先，记 `AMBIGUOUS_WINDOW` 进人工确认清单；「唯一生效」关系属 Step 2 的 Schema 设计（`superseded relation`）。
7. `exclusionFlag` 只接受真/假字面量（`true/false`、`Y/N`、`yes/no`、`1/0`）；其余 → QUARANTINE（`INVALID_FLAG`），不把「301」当真假。

---

## 5. 版本指纹与工件形状

    {
      "artifactType": "CUSTOMS_DUTY_RATE" | "CUSTOMS_301_EXCLUSION",
      "sourceSha256": "<64 hex>",
      "sourceFormat": "CSV" | "XLSX" | "JSON",
      "generatedAt": "<ISO>",
      "adapterVersion": "customs-reference/v1",
      "fieldCoverage": { "<规范字段>": { "mapped": true, "column": "<原始列名>" } },
      "unmappedColumns": ["..."],
      "windows": { "minEffectiveDate": "...", "maxEffectiveDate": "...", "openEndedCount": 0 },
      "entries": [ { "rowNumber": 2, "rowHash": "<64 hex>", "countryCode": "US", "hsCode": "85044095", "baseDutyRate": "8.5000", "preferentialRate": "0.0000", "exclusionFlag": true, "effectiveDate": "2026-01-01", "expirationDate": null } ]
    }

同一输入重复执行 → 工件完全一致（除 `generatedAt`）。

---

## 6. quarantine 策略

文件级（缺必需列 / PDF / 未知格式）→ 整文件 QUARANTINE + ACTION，不产部分工件。

行级（非法日期 / 倒置窗口 / HS 长度非法 / 国家码非法 / 税率刻度歧义 / flag 非法）→ 该行不进 `entries`，进 `quarantinedRows`（只留 rowNumber + 行哈希，**不留原始值**）。

---

## 7. 不确定字段处理

- 未识别列 → `unmappedColumns`，不猜。
- `exclusionFlag` 缺失 → 记 `unknown`（**不等于 false**）；报告区分 `missing` 与 `false`。
- 多来源文件（同时含税率与豁免清单）→ 只按第一张表识别；其余记 `MULTI_TABLE_AMBIGUITY`。
- 无法判定一律 QUARANTINE + ACTION。

---

## 8. 明确不做（防越界）

- 不按 `Import_Date` 匹配历史税率（Rule Engine Design 另行提交）；
- 不判断「是否溢缴」「该退多少」；
- 不生成《关税退税诊断报告》（Step 4）；
- 不解析 PDF 报关单（OCR BACKLOG）；
- 不做 HS Code 归类判断（合规边界评审前置，MSG-20260929-13 C5）。

---

## 9. 验收用例（实施后随 Checkpoint 提交）

1. 税率表 CSV（6/8/10 位 HS）→ PASS，条目数与生效窗口区间正确。
2. 301 豁免清单 CSV → PASS，`exclusionFlag` 正确解析为布尔。
3. HS 带点号（`8504.40.95`）→ 规范为 10 位，原文可追溯。
4. HS 长度非法（`8504`）→ 该行 QUARANTINE（`INVALID_HS_CODE`）。
5. 国家码 `US-CA` → QUARANTINE（`INVALID_COUNTRY_CODE`）。
6. 税率 `0.085` → QUARANTINE（`AMBIGUOUS_RATE_SCALE`）；`8.5` / `8.5%` / `0` 均 PASS。
7. `expirationDate <= effectiveDate` → QUARANTINE（`INVERTED_WINDOW`）。
8. 重叠窗口 → `AMBIGUOUS_WINDOW` 进人工清单。
9. `exclusionFlag` 缺失 → 记 `unknown`，与 `false` 区分。
10. PDF（7501 样例）→ `PDF_STRUCTURE_ONLY_NO_OCR` QUARANTINE，零条目。
11. 同一文件跑两次 → 工件一致（除 `generatedAt`）。
12. 全程离线断言：无网络、无数据库写入。

---

## 10. 变更影响

领域模型 / Schema / 资金链路 / 规则引擎 / 安全边界 / 对外动作：**零改动**。依赖：无新增。Gate：不进入新 Gate。

---

## 11. 请裁决

NEED: **GO / REVISE / HOLD**（CUSTOMS-RATE-REFERENCE-ADAPTER-DESIGN）。若 GO，我将实施并提交 Implementation Checkpoint（含 12 条用例结果与适配报告）。
