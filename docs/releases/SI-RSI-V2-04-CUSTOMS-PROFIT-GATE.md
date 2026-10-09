# SI-RSI V2-04 — CUSTOMS PROFIT GATE（付费执行前盈亏门）

> 授权：HOST DIRECTIVE 2026-10-09「CUSTOMS OPPORTUNITY UNLOCK & AUTO-COMMISSION V2」PHASE D。
> 基线：`1efc2e67`（V2-03）。分支：`feat/customs-opportunity-unlock-v2`。

## 1. 交付物

| 文件 | 说明 |
| --- | --- |
| `apps/api/src/services/customs/customs-profit-gate.ts` | 版本化盈亏门判定（纯函数 + 定点算术） |
| `apps/api/src/__tests__/customs-profit-gate.test.ts` | 21 项单测 |

## 2. 判定链（全部满足才 PASS）

```text
费率政策存在 且 rateBps 非空 且 币种一致 且 判定日生效
预计追回金额 > 0（来自 C5，不得来自客户自报）
成功概率存在 且 显式声明为估算 且 0 < p < 1
provider 报价存在且为合法定点数
报价 ≤ 单次核验上限  且  报价 ≤ 租户剩余预算
贡献毛利 ≥ 该币种绝对下限（缺定义 → HOLD）
贡献毛利/收入 ≥ 政策 bps 下限
→ PASS；否则 HOLD（累积原因码）
```

## 3. 关键实现约束

| 约束 | 实现 |
| --- | --- |
| 严禁只看预计追回总额 | 收入按**风险调整**：`projectedSuccessFee = recovered × rateBps`，再 `× successProbability` |
| 不得把未知伪装成确定概率 | 必须 `probabilityIsEstimate = true`；`p = 1` 亦拒绝（确定性断言不是估算） |
| 复用既有费率政策 | 直接接收 `FeePolicy`（`CUSTOMS_SUCCESS_15`）对象，**不新建第二套费率**；政策未生效 / 币种不符 / 无费率一律 HOLD |
| 金额采用定点数 | 全链路 BigInt（scale 6），**无一处分浮点**；费率与风险调整一律**向下取整到分**（不高估收入） |
| 缺报价 / 超预算 | `PROVIDER_QUOTE_MISSING` / `PER_CHECK_BUDGET_EXCEEDED` / `TENANT_BUDGET_EXCEEDED` → HOLD，不调用外部服务 |
| 订阅收入不得随意补贴 | 必须有 `allowSubscriptionSubsidy=true`，否则 HOLD |

输出字段与 PHASE D 清单一一对应：`projectedSuccessFee` / `earnedSubscriptionContribution`
（经 `subscriptionContributionApplied`）/ `providerQuotedCost` / `expectedDirectCost`
（经 `expectedCost`）/ `maximumPerCheckCost` / `tenantRemainingBudget` / `expectedContributionMargin`
（含 `...Bps`）。

## 4. 回归结果（本机真实执行）

```text
VITEST  customs-profit-gate   21/21 PASS
TSC     apps/api --noEmit     0 error
```

## 5. 仍未证明

```text
PROFIT_GATE_WIRING=NOT_DONE  尚未接入运行时的执行前门禁（PHASE F 接线属 V2-07）
REAL_PROVIDER_QUOTE=NOT_VERIFIED  provider 未接线，报价来源仍为宿主待提供
POSTGRESQL_IT=NOT_RUN        本机无 PostgreSQL
```

## 6. 边界自证

`CUSTOMS_PROFIT_GATE_BOUNDARY`：`externalCallPerformed=false`、`providerInvoked=false`、
`chargedAmount=null`、`paymentCaptured=false`、`autoCollectionEnabled=false`、
`usesFloatingPoint=false`、`productionCredentials='ABSENT'`。
未新增调度器 / Runtime，未触碰 `main` / release 分支 / U1 封板代码。
