# C-0010-C2 执行手册（Stripe test mode 接入验证）

> 状态：**待宿主授权**。本手册只描述授权到位后怎么跑，不包含任何密钥取值。
> 依据：MSG-20260928-100 / -104 / -106（架构方批准确认）。

## 0. 前置条件（宿主确认清单）

| 条件 | 状态 | 说明 |
|---|---|---|
| Stripe **test** 账号 | 待宿主 | 只使用 test mode，不接生产 |
| test webhook signing secret | 待宿主 | 只写本机环境变量，**不入库 / 不回显 / 不进日志** |
| 宿主机允许使用 Stripe CLI | 待宿主 | 架构方选定方式 b：`stripe listen --forward-to` |
| `PAYMENTS_ENABLED` 默认 false | 已具备 | 验证期间才临时置 true，结束立刻回 false |

未满足以上任意一条 → 不执行本手册，C-0010-C2 保持 HOLD。

## 1. 本地准备（不含任何 provider 写操作）

```powershell
# 1) 起本地 PostgreSQL（已有容器）
docker start crossclaim-postgres

# 2) 迁移 + 生成客户端
cd D:\crossclaim-ai\apps\api
$env:DATABASE_URL='postgresql://<user>:<pass>@127.0.0.1:55432/crossclaim'
npx prisma migrate deploy
npx prisma generate

# 3) 起 API（webhook 路由 /payments/webhook 必须可达）
npx tsc --noEmit
npm run dev
```

`PAYMENT_WEBHOOK_SECRET` 与 `PAYMENTS_ENABLED` 只在**启动 API 的那个 shell** 里设置：

```powershell
$env:PAYMENT_WEBHOOK_SECRET='<从 Stripe test 控制台/CLI 读取，仅存在于本 shell>'
$env:PAYMENTS_ENABLED='true'
$env:PAYMENT_REVIEW_THRESHOLD='1000.0000'
```

## 2. 打通事件通道（方式 b：Stripe CLI）

```powershell
stripe listen --forward-to http://127.0.0.1:3000/payments/webhook
# CLI 会打印 test webhook signing secret：把它写进上面的环境变量后重启 API
```

## 3. 触发测试事件（按验收矩阵逐条）

| # | 触发 | 期望 |
|---|---|---|
| 1 | `stripe trigger payment_intent.succeeded`（metadata.invoiceId 指向一张 ISSUED 账单） | 200；`PaymentEvent` 1 条；attempt SUCCEEDED 且带 paymentId；`Payment` 1 条；账单 PAID |
| 2 | 同一条事件由 CLI 重放 | 200 DUPLICATE；不新增第二个 attempt、不新增第二笔 Payment |
| 3 | `stripe trigger payment_intent.payment_failed` | 200；只记事件，账单不变 |
| 4 | `stripe trigger charge.refunded` | 200；只记事件，账单不变、不产生 attempt |
| 5 | Provider Delivery Failure（REVISE-2）：让 API 在第一次投递时返回 5xx/timeout（例如暂时关掉 API 进程再投），随后恢复并让 provider 重投 | attempt#1 `RETRYABLE_FAILED` → attempt#2 `SUCCEEDED` → `Payment = 1` → 账单 PAID |

> 提示：Stripe CLI 的重放/重投能力就是本项验收要验证的真实重试路径；不要用本地脚本伪造重试。

## 4. 验收 SQL（只读）

```sql
-- 事件链
SELECT e."providerEventId", a."attemptNo", a."status", a."resultStatus",
       p."id" AS payment_id, b."status" AS invoice_status, b."paidAmount"
FROM "PaymentEvent" e
JOIN "PaymentProcessingAttempt" a ON a."paymentEventId" = e."id"
LEFT JOIN "Payment" p ON p."id" = a."paymentId"
LEFT JOIN "BillingInvoice" b ON b."id" = p."invoiceId"
WHERE e."organizationId" = '<org>'
ORDER BY a."attemptNo";

-- 唯一性：同一事件只允许一个成功执行来源 / 一笔 Payment
SELECT "paymentId", count(*) FROM "PaymentProcessingAttempt"
WHERE "status" = 'SUCCEEDED' GROUP BY 1 HAVING count(*) > 1;   -- 期望 0 行

-- 成功但缺 paymentId（I1）
SELECT count(*) FROM "PaymentProcessingAttempt"
WHERE "status" = 'SUCCEEDED' AND "paymentId" IS NULL;          -- 期望 0

-- 审计完整性
SELECT action, count(*) FROM "AuditLog"
WHERE "organizationId" = '<org>' AND action LIKE 'payment.%'
GROUP BY 1 ORDER BY 1;
```

## 5. 结束与回滚（必须执行）

1. `PAYMENTS_ENABLED=false`，重启 API（或直接停掉本地 API）
2. 关闭 Stripe CLI 转发会话；删除本 shell 里的 `PAYMENT_WEBHOOK_SECRET`
3. 确认没有留下生产端点、没有接入生产账号、没有发生任何真实扣款
4. 若验证暴露生产代码缺口：先回报架构方，再改生产逻辑（不在 C2 里顺手改）

## 6. 本手册**不会**做的事

- 不创建真实客户支付、不发起真实扣款、不启用自动扣款
- 不保存 secret、不保存完整 webhook payload
- 不修改 `Settlement`、不改 Billing 规则、不做自动退款
