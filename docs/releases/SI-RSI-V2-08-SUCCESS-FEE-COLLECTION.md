# SI-RSI V2-08 — 15% 成功费五态分层与收款门禁

> 授权：HOST DIRECTIVE 2026-10-10「V2-AUTONOMOUS-20261010-01」§四。**不含真实扣款授权**。
> 基线：`c4163f75`（V2-07）。分支：`feat/customs-opportunity-unlock-v2`。

## 1. 交付物

| 文件 | 说明 |
| --- | --- |
| `apps/api/src/services/customs/customs-success-fee-collection.ts` | 五态分层判定（纯函数） |
| `apps/api/src/__tests__/customs-success-fee-collection.test.ts` | 15 项单测 |

## 2. 五个状态互不混用（全部可达且有测试）

| 状态 | 触发条件 |
| --- | --- |
| `SUCCESS_FEE_CALCULATED` | 算出金额但**不构成应收**：结算未证实 / 缺结算号 / 金额非法 / 币种缺失 / **同一结算重复通知** |
| `SUCCESS_FEE_RECEIVABLE` | 应收成立但**不具备自动收款能力**（宿主未开闸或支付方式不支持）→ 走应收账单路径，不假装扣款 |
| `PAYMENT_COLLECTION_HOLD` | 能力具备但门禁未放行：客户撤销授权 / 客户未授权 / Kill Switch / 扣款失败 |
| `PAYMENT_COLLECTION_AUTHORIZED` | 门禁全开，等待真实收款事实（含部分到账待收） |
| `PAYMENT_COLLECTED` | 仅由**可信支付事实**驱动且金额不超过应收 |

## 3. 逐条对应 §四要求

| 要求 | 实现 / 测试 |
| --- | --- |
| 无真实回款不产生应收 | `verified=false` → `CALCULATED` |
| 只有预估不产生应收 | 金额 `0` / 非法 / 缺币种 → `CALCULATED` |
| 无可信结算证据不产生应收 | 同上一行 + 缺 `settlementId` |
| 重复 Webhook 不重复收费 | `billedSettlementIds` 命中 → `DUPLICATE_FEE_SUPPRESSED` |
| 币种与金额精度 | 费率 1500 bps，定点向下取整到分（`1.00 → 0.15`）；跨币种合计返回 `null`，不做汇率换算 |
| 部分回款 | `500.00 / 1500.00` → 保留余额 `1000.00` + `PARTIAL_COLLECTION_PENDING` |
| 退款 / 冲正可审计 | 生成 `REVERSAL` / `REFUND_ADJUSTMENT` / `CHARGEBACK_ADJUSTMENT` 调整记录（含 `signedAmount`） |
| 客户取消授权不被忽略 | `revoked=true` → `PAYMENT_COLLECTION_HOLD` + `CUSTOMER_AUTHORIZATION_REVOKED` |
| 收款权限未开闸保持禁止 | `hostAutoCollectionEnabled=false` → 永不进入 `AUTHORIZED`/`COLLECTED` |

## 4. 回归结果（本机真实执行）

```text
VITEST  customs-success-fee-collection  15/15 PASS
VITEST  V2 套件合计                    165/165 PASS
TSC     apps/api --noEmit                0 error
```

## 5. 边界与阻断

```text
REAL_COLLECTION=NOT_AUTHORIZED   未授权真实扣款；本模块不持卡、不发起扣款、不调用支付通道
AUTO_COLLECTION=HOLD             默认与未开闸时恒为 HOLD；开启需宿主单独授权
PAYMENT_PROVIDER=BLOCKED         无测试商户与密钥，真实收款链路未验证
POSTGRESQL_IT=NOT_RUN            本机无 PostgreSQL，收费台账持久化未做 DB 级验证
```

## 6. 边界自证

`CUSTOMS_FEE_COLLECTION_BOUNDARY`：`storesCardData=false`、`initiatesCharge=false`、
`collectionInitiated=false`、`paymentCaptured=false`、`autoCollectionDefault='HOLD'`、
`chargedAmount=null`、`productionCredentials='ABSENT'`。
未新增 Runtime / 调度器，未触碰 `main` / release 分支 / U1 封板代码，未重开 U2 Design R21。
