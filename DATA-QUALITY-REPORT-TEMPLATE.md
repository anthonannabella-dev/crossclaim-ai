# DATA QUALITY REPORT TEMPLATE — CrossClaim AI

> 用途：架构方 MSG-20260929-09 方向 C —— 真实客户数据进入后的快速审计模板。
> 用法：`cd apps/api && npx tsx ../../tools/validation-run/harness.ts --in <文件> [--platform <平台>] --out <目录>`
> 会生成 `HARNESS-REPORT.md`（本模板的自动部分）与 `harness-summary.json`（机器可读）。人工只补写「商业评审」段。
> **纪律**：本报告不产出商业结论（`commercialConclusion` 恒为 OPEN）；结论只能由人工写进 `reports/C-0009.1-validation-runs.md`。

---

## 1. 输入（自动）

| 项 | 值 |
|---|---|
| 文件名 | |
| sha256（前 12 位） | |
| 输入类型 | desensitized-real-structure / synthetic / other |
| 平台 | （猜测值 + 是否已人工确认） |
| 生成时间 | |

> 平台由**表头特征**判定，非文件名：命中即标记 `platformConfirmed=false`，必须人工确认后才能写进验证记录。

## 2. 工程状态（自动，三层口径）

| 层 | 值 | 含义 |
|---|---|---|
| engineeringStatus | PASS / FAIL | 适配与校验是否跑通（与商业无关） |
| validationRunStatus | NOT_RUN / RUN_RECORDED | 是否形成一次可引用的验证运行（模板输入恒 NOT_RUN） |
| commercialConclusion | **OPEN**（恒） | 商业结论只能人工裁定 |

## 3. 适配结果（自动）

| 指标 | 值 |
|---|---|
| 适配状态 | PASS / QUARANTINE |
| quarantine 原因 | （如 MISSING_REQUIRED_FIELD / PDF_STRUCTURE_ONLY_NO_OCR） |
| 必需列覆盖 | n / 3 |
| 可选列覆盖 | n / 11 |
| 原始行数 → 已适配行数 | |
| 未识别来源列 | （列出，不猜测语义） |

## 4. 数据质量指标（自动）

| 规范列 | 填充率 % |
|---|---|
| orderId | |
| trackingNo | |
| invoiceNo | |
| promisedDeliveredAt | |
| actualDeliveredAt | |
| billedAmount | |
| billedCurrency | |
| invoiceAmount | |
| invoiceCurrency | |
| evidenceRef | |
| settlementRef | |
| claimOutcome | |
| note | |

系统提示（Hints，不含商业结论）：

- `REQUIRED_COLUMN_EMPTY`：必需列全空 → ACTION manual_confirmation_required
- `CLAIM_OUTCOME_UNKNOWN`：没有任何一行带真实结论（空或 NOT_STARTED）→ 无法据此计算任何追回口径
- `UNKNOWN_COLUMNS_PRESENT`：存在未识别列 → 先确认是否需要，再考虑扩展白名单

## 5. 失败与隔离明细（自动）

| 行号 | 原因 | 动作 |
|---|---|---|
| | INVALID_DATE / MISSING_REQUIRED_FIELD / … | fix_source_row_then_reimport |

> 隔离行只登记 `rowNumber` 与行哈希，**不回传原始值**。

## 6. 可自动化比例（人工填写，需实测）

| 步骤 | 系统可完成？ | 证据 |
|---|---|---|
| 文件结构识别与字段映射 | 是 / 否 | |
| 异常定位（哪一行、什么原因） | 是 / 否 | |
| 归因与判断（是谁的责任、该不该追） | 是 / 否 | 需规则设计获批后 |
| 证据整理与文书起草 | 是 / 否 | 需 Step 4 |
| 提交与对外沟通 | **否**（人工） | 自动提交恒 FORBIDDEN |

## 7. 人工成本实测（人工填写，不要估算）

| 项 | 值 |
|---|---|
| 本批行数 | |
| 人工处理耗时（分钟） | |
| 单条平均耗时 | |
| 若纯人工处理的耗时对比 | |

## 8. 商业评审骨架（人工填写）

1. 这批数据能否支撑一次商业验证？可行 / 不可行 + 理由
2. 哪一步完全由系统完成，哪一步必须人工？
3. 付费信号：客户原话（是否表达付费意愿、愿意为哪一步付钱）
4. 是否存在高频重复的损失类型？
5. 结论：本场景是否值得进入 C-0015 单场景选择（三选一或附加费/关税方向）

## 9. 签署

| 角色 | 姓名 | 日期 | 结论 |
|---|---|---|---|
| 验证执行（Codex） | | | 仅工程结论 |
| 商业评审（人） | | | 商业结论（OPEN → 裁定） |
