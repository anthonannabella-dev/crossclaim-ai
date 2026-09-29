# DATA-QUALITY-REPORT

> 模板（P2-4）。与 `DATA-QUALITY-REPORT-TEMPLATE.md` 同族；这里只列阶段一必填项。

## 桶分布

| bucket | 数量 | 说明 |
|---|---|---|
| ok | | 可直接归一化 |
| quarantine | | 可疑但需人工确认 |
| rejected | | 结构/字段非法 |

## 异常清单

| errorCode | rowNumber | field | action |
|---|---|---|---|
| | | | |

## 抽样

- 抽样方法：
- 抽样数量：
- 抽样结论：

## 禁止项

- ❌ 不用真实客户 PII
- ❌ 不猜测金额 / 不自动修正未知字段
- ❌ 不把 Candidate 当作 Claim
