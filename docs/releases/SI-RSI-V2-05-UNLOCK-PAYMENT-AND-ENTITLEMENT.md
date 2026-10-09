# SI-RSI V2-05 — 付费权益解锁核心（报价 / 验签 / 幂等 / 生命周期）

> 授权：HOST DIRECTIVE 2026-10-09「CUSTOMS OPPORTUNITY UNLOCK & AUTO-COMMISSION V2」PHASE C。
> 基线：`e1de343f`（V2-04）。分支：`feat/customs-opportunity-unlock-v2`。

## 1. 交付物

| 文件 | 说明 |
| --- | --- |
| `apps/api/src/services/customs/customs-unlock-payment.ts` | 服务端报价 + 订单校验 + Webhook 验签 + 幂等发放 + 生命周期 |
| `apps/api/src/__tests__/customs-unlock-payment.test.ts` | 23 项单测 |

## 2. PHASE C 十条要求的落地映射

| 要求 | 实现 |
| --- | --- |
| ① 服务端生成版本化价格与有效期报价 | `issueCustomsUnlockQuote()`：`quoteVersion` + `expiresAt`（缺省 30 分钟），价格/币种/额度全部服务端权威 |
| ② 服务端核验 order ↔ organizationId/opportunityId/商品 | `validateCustomsUnlockOrder()`：四要素 + 金额 + 币种，任一不符即拒绝 |
| ③ 托管收银台 | 适配层只产出报价与订单校验结果，**不产生任何收银台跳转实现**（真实跳转属宿主接线，见 §5） |
| ④ 不自行存储完整卡信息 | `storesCardData=false`；模块内无任何卡字段 |
| ⑤ 支付通知必须验签并核对金额币种 | `verifyCustomsPaymentNotification()`：HMAC-SHA256(`ts.body`) + `timingSafeEqual` + 时间戳容忍窗（缺省 300s）；再核对 amountMinor / currency |
| ⑥ 支付事件幂等 | `applyVerifiedPaymentEvent()`：`eventId` 重复 → `DUPLICATE_IGNORED`；`entitlementId` 由 `quoteId` 确定性派生（`ent-<quoteId>`） |
| ⑦ 事务内创建/发放权益 | 纯函数产出权益记录，持久化由调用方在事务内完成（**真实 DB 事务验收 = BLOCKED**，本机无 PostgreSQL） |
| ⑧ 前端状态 / URL / 伪造回调解锁 | 发放只依赖「验签通过 + 报价匹配」，与前端状态无关；跨租户 / 改价 / 换机会全部 HOLD |
| ⑨ 退款·过期·取消·争议一致性 | `applyEntitlementLifecycle()`：退款→REVOKED 且未用额度可退；争议→REVOKED 不承诺退还；取消→停续费但保留已付额度至期末；期末→EXPIRED 清零 |
| ⑩ 交付失败时的退款/额度恢复政策 | `unusedQuotaDisposition` 显式三态（`REFUND_ELIGIBLE_FOR_UNUSED` / `RETAINED_UNTIL_PERIOD_END` / `REVOKED_ALL`），不做"付了钱永久卡死" |

## 3. 仍保持 HOLD 的部分

- `paymentsEnabled=false`（现有 Payment HOLD）时 `applyVerifiedPaymentEvent()` 返回 `PAYMENTS_HOLD`，**不发放权益**。
- 本模块不发起扣款、不持有卡数据、不调用任何支付通道；`CUSTOMS_UNLOCK_PAYMENT_BOUNDARY` 自证。
- `CUSTOMS_SINGLE_REVIEW=$39` / `CUSTOMS_PLUS_MONTHLY=$49` 仍为**草案价**，须按真实 Provider 成本复核后由宿主确认。

## 4. 回归结果（本机真实执行）

```text
VITEST  customs-unlock-payment   23/23 PASS
VITEST  V2 套件合计             124/124 PASS
TSC     apps/api --noEmit        0 error
```

## 5. 阻断（不伪造 PASS）

```text
REAL_PAYMENT_PROVIDER=BLOCKED      缺支付服务商测试商户号与 Webhook 签名密钥
REAL_WEBHOOK_E2E=BLOCKED           验签逻辑已用本机 HMAC 向量验证；真实链路未验证
HOSTED_CHECKOUT_UI=NOT_IMPLEMENTED 未接入任何收银台跳转
POSTGRESQL_IT=NOT_RUN              本机无 PostgreSQL（127.0.0.1:5432 不可达、Docker 未运行）
PRODUCTION_PAYMENT_ENABLED=NO
```

## 6. 边界自证

`storesCardData=false`、`initiatesCharge=false`、`paymentCaptured=false`、`providerInvoked=false`、
`autoCollectionEnabled=false`、`productionCredentials='ABSENT'`。
未新增调度器 / Runtime，未触碰 `main` / release 分支 / U1 封板代码。
