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
