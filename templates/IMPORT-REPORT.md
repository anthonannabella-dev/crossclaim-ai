# IMPORT-REPORT

> 模板（P2-4）。真实数据 WAITING_HOST_DATA；未取得真实数据前不得填写推测值。

## 输入摘要

- 文件名：
- 行数：
- 时间范围：
- 脱敏声明：

## Stage A 记账（必须自洽）

| 项 | 数量 |
|---|---|
| input rows | |
| normalized rows | |
| quarantine rows | |
| rejected rows | |
| 差值（必须为 0） | |

> 若差值 ≠ 0 → **silent drop**，阶段一不通过（先修导入记账，不得估算）。

## 导入结果

- ImportBatch：
- 成功 / 失败 / 隔离：
- 错误分类（白名单字段：errorCode / rowNumber / field / sourceColumnName / action）：

## 幂等

- 重复导入验证：`dedupeKey` 命中数 =
- 是否产生重复 SourceTransaction：否（必须）
## Stage 0 入场前置检查（preflight 证据，只读）

- 命令：`node tools/validation/phase1-runbook.mjs preflight <dataset.csv>`
- verdict：`READY_FOR_STAGE_A` / `NEEDS_FIX`（退出码 0 / 1）
- 阻断项结果：non-empty / header-present / required-columns / min-rows / no-pii-columns / no-ragged-rows / unique-order-id / dates-parsable
- 非阻断提示：recent-window-preferred（时间窗）、alias-hints（别名提示，**不自动映射**）
- 数据集 sha256：

> 说明：Stage 0 只做结构/列名/数量/可解析性检查；**不猜字段、不自动补值、不做金额运算**。
> 空值与币种一致性等数值语义问题在 Stage A 与 `DATA-QUALITY-REPORT.md` 记录。
