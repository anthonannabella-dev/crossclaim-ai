# CARRIER REFERENCE DATA ADAPTER DESIGN — CrossClaim AI

> 状态：**DESIGN ONLY（未实现）** · 依据架构方 **MSG-20260929-12 Q3：Step 1 = Carrier Reference Data Adapter 已批准（GO）**
> 本文档即该裁决要求的验收文档。分支 `gate/7-commercial-validation` · Codex · 2026-09-29

---

## 1. 边界（严格照 MSG-20260929-12）

允许：参照数据适配 · 版本化工件 · 校验报告。

禁止：`carrier_rules` 建表 · `RuleEvaluation` · SLA 违约判定 · 燃油费错扣判定 · DAS 误判判定 · Claim 金额 · 申诉函 · 自动提交 · 抓取官网。

数据流（只有这一段）：

    官方发布的参照文件（人工上传）
        → 解析 → 字段白名单映射 → 生效窗口解析 → 行级校验
        → 规范化参照工件（带版本指纹） + 校验报告（可读、可审计）

**本阶段不落库**：不新增模型、不改 Prisma Schema、不写 `ImportBatch` / `SourceTransaction`（那是业务事实层，不是参照层）。

---

## 2. 支持格式与数据类型

| 输入 | 处理 |
|---|---|
| CSV / TSV | 解析 + 映射 |
| XLSX | 解析（取第一个工作表；多表时记 ambiguity） |
| JSON | 数组或 `{ items: [...] }` |
| PDF | **仅结构识别 → QUARANTINE**（无 OCR，沿用 C-0009.1-A 行为） |
| 其它 | QUARANTINE（`UNKNOWN_FORMAT`） |

三类参照数据（按**内容**判定，不按文件名猜）：

1. 燃油附加费率表（fuel surcharge table）
2. DAS / 偏远邮编表（DAS ZIP reference）
3. SLA 退费承诺暂停公告（Money-Back Guarantee suspension notice）

---

## 3. 字段白名单

只有下表列出的列名（含别名）会被映射；**未识别的列只列出，不猜**。

| 规范字段 | 必需 | 别名示例 | 适用文件 |
|---|---|---|---|
| `carrierName` | 是 | carrier, carrier_name, 承运商 | 三类 |
| `effectiveDate` | 是 | effective_date, effective from, start date, 生效日期 | 费率表 / DAS |
| `expirationDate` | 否 | expiration_date, effective to, end date, 失效日期 | 费率表 / DAS |
| `rateValue` | 是 | fuel rate, surcharge rate, percentage, 燃油费率 | 费率表 |
| `serviceLevel` | 否 | service, service level, 服务等级 | 费率表 |
| `postalCode` | 是 | zip, zip code, postal code, 邮编 | DAS |
| `dasType` | 否 | type, das type, extended, remote, 类型 | DAS |
| `state` | 否 | state, province, 州 | DAS |
| `startDate` | 是 | start date, from, suspension start, 开始日期 | SLA 公告 |
| `endDate` | 是 | end date, to, suspension end, 结束日期 | SLA 公告 |
| `scopeNote` | 否 | scope, region, service, 范围 | SLA 公告 |
| `reasonNote` | 否 | reason, announcement, 说明 | SLA 公告 |
| `sourceNote` | 否 | source, reference, 来源 | 三类 |

`carrierName` 只做大小写与空白归一，**不做承运商名映射**（「FedEx Express → FedEx」属规则层）。

---

## 4. 生效窗口解析规则（防猜）

1. 日期只接受 `YYYY-MM-DD` / `YYYY/MM/DD` / 带时区 ISO 8601；`03/04/2026` 这类 → 该行 QUARANTINE（`INVALID_DATE`），不猜月日顺序。
2. `expirationDate` 缺省 = 开放区间（`null`，表示「至下一条生效为止」），报告中显式标注。
3. `expirationDate <= effectiveDate` → QUARANTINE（`INVERTED_WINDOW`）。
4. 同承运商 / 同服务等级出现**重叠窗口** → 不判定谁优先，记 `AMBIGUOUS_WINDOW` 并进人工确认清单。
5. SLA 公告 `startDate > endDate` → QUARANTINE。
6. 费率值只接受百分数形式：`12.5` 或 `12.5%`；写成小数（`0.125`）且列名未声明为小数 → QUARANTINE（`AMBIGUOUS_RATE_SCALE`），避免 100 倍误差。

---

## 5. 版本指纹与工件形状

规范化参照工件（JSON，纯数据、可 diff）：

    {
      "artifactType": "CARRIER_FUEL_SURCHARGE" | "CARRIER_DAS_ZIP" | "CARRIER_SLA_SUSPENSION",
      "sourceSha256": "<64 hex>",
      "sourceFormat": "CSV" | "XLSX" | "JSON",
      "generatedAt": "<ISO>",
      "adapterVersion": "carrier-reference/v1",
      "fieldCoverage": { "<规范字段>": { "mapped": true, "column": "<原始列名>" } },
      "unmappedColumns": ["..."],
      "entries": [ { "rowNumber": 2, "rowHash": "<64 hex>", "carrierName": "...", "effectiveDate": "...", "expirationDate": null, "rateValue": "12.5000" } ]
    }

版本指纹 = `sourceSha256`（原始文件）+ 每行 `rowHash`（规范化后内容的哈希）。同一输入重复执行必须得到**完全一致**的工件（除 `generatedAt`）。

---

## 6. quarantine 策略

| 触发 | 层级 | 结果 |
|---|---|---|
| 缺必需列 | 文件级 | 整个文件 QUARANTINE + ACTION（不产部分工件） |
| PDF / 未知格式 | 文件级 | QUARANTINE（`PDF_STRUCTURE_ONLY_NO_OCR` / `UNKNOWN_FORMAT`） |
| 日期非法 / 窗口倒置 / 费率刻度歧义 | 行级 | 该行不进 `entries`，进 `quarantinedRows`（保留 rowNumber + 行哈希，**不留原始值**） |
| 重复行（内容完全相同） | 行级 | 两行都保留（不静默去重），报告记 `duplicateRows` |
| 空行 | 行级 | 跳过并计数（不算失败） |

原始文件只读，绝不覆盖；报告只登记 sha256 与计数。

---

## 7. 不确定字段处理

- 未识别列：进 `unmappedColumns`，不映射、不猜测语义。
- 承运商名未知：保留原文并记 `unknownCarrierName`，不归类到已知承运商。
- 服务等级 / DAS 类型取值未知：原样保留，记 `unknownValue`，不做枚举归一。
- 多工作表：只处理第一个，记 `MULTI_SHEET_AMBIGUITY`。
- 任何无法判定的情形一律 QUARANTINE + ACTION，不产出「近似值」。

---

## 8. 实现方式（复用，不新建适配系统）

- 复用 C-0009.1-A 适配框架与报告渲染（`services/validation-run/adapters`），只新增参照数据字段白名单与其解析；
- 无 Schema 变更、无新依赖、无网络调用；
- 提供离线 CLI（`tools/reference-data/`）产出工件 + 报告；Step 1 不写数据库。

---

## 9. 验收用例（实施后随 Checkpoint 提交）

1. 燃油费率表 CSV（含生效/失效日期）→ PASS，条目数与窗口区间正确。
2. DAS 邮编表 CSV → PASS，`postalCode` 保留前导零（如 `01234`）。
3. SLA 暂停公告 CSV → PASS，区间正确。
4. 缺 `effectiveDate` 列 → 文件级 QUARANTINE + ACTION。
5. 行内 `03/04/2026` 日期 → 该行 QUARANTINE，其余行照常产出。
6. `expirationDate <= effectiveDate` → 该行 QUARANTINE（`INVERTED_WINDOW`）。
7. 重叠窗口 → `AMBIGUOUS_WINDOW` 进人工清单（不自动择一）。
8. 费率写成 `0.125` → `AMBIGUOUS_RATE_SCALE` QUARANTINE。
9. 未知列（如 `internal_note`）→ 只进 `unmappedColumns`，不映射。
10. PDF → `PDF_STRUCTURE_ONLY_NO_OCR` QUARANTINE，零条目。
11. 同一文件跑两次 → 工件一致（除 `generatedAt`）。
12. 全程离线断言：无网络、无数据库写入。

---

## 10. 变更影响

领域模型 / Schema / 资金链路 / 规则引擎 / 安全边界 / 对外动作：**零改动**。依赖：无新增。Gate：不进入新 Gate。

---

## 11. 请裁决

NEED: **GO / REVISE / HOLD**（CARRIER-REFERENCE-DATA-ADAPTER-DESIGN）。若 GO，我将实施并提交 Implementation Checkpoint（含 12 条用例结果与适配报告）。
