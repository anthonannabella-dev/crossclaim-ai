# C-0004 · Logistics 纵向闭环 fixture（非生产数据）

这一组文件是 **fixture**：用于在 Gate 2 跑通第一条确定性物流追回链路，
**不包含任何真实客户数据**，也**不参与生产运行**。

- 目标链路：Carrier invoice + Rate Card/contract + Tracking →（Import foundation）
  SourceTransaction → RuleEvaluation → RecoveryOpportunity → Case → Evidence →
  Claim draft → Simulated Settlement → RecoveryLedger → FeeCalculation/Billing
- 数据全部为人工构造的示例订单号 / 运单号 / 金额，可安全提交进仓库。
- Schema 与 migration 的落表范围由架构方 C-0004 裁定后再动；本目录先行，不代表已批准的数据模型。

## 文件

| 文件 | 对应输入 | 说明 |
|---|---|---|
| `carrier-invoice.csv` | 承运商账单 | 走既有 Import foundation（列映射 + 行级校验 + 幂等） |
| `rate-card.csv` | 合同 / Rate Card | 用于规则比对的费率基准（lane + service + 单价 + 燃油） |
| `tracking.csv` | 轨迹 | 用于 SLA / 延误类规则的到达时间证据 |

## 约定

1. 金额一律十进制字符串（最多 4 位小数），币种 3 位字母 —— 与 `SourceTransaction` 的存储规则一致。
2. 日期只使用 `YYYY-MM-DD` 或带时区的 ISO 8601（无时区的自由格式会被 import 层拒绝）。
3. 同一份 fixture 重复导入必须**不新增交易**（幂等键 `organizationId|connectionId|referenceType|externalId|rowFingerprint`）。
