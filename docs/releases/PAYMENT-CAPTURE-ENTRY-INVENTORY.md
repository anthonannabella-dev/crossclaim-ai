# 授权项② 第二批 — `payment.capture` 入口与调用链盘点（R5 送审用）

依据：**MSG-20260930-21**（R4 = PASS，下一批次 = ② 第二批 `payment.capture` 真实服务端入口接入；
要求先盘点现有资金执行入口和调用链，在七段式中明确实际接入范围）。
约束：不接入真实支付凭据、不发起真实扣款、不启用生产资金能力；合成数据 + 测试适配器。

## 1. 动作目录中的 `payment.capture`

| 项 | 值（当前代码） |
| --- | --- |
| 风险类 | `MONEY_MOVEMENT` |
| 门闸要求 | `humanApproval` + `productionGate` |
| Kill Switch scope | `billing`（`ACTION_SCOPE_MAP`） |
| 强制入口调用点 | **无**（`withActionGuard` / HITL 边界目前只接 `commission.charge`） |

结论：`payment.capture` 目前**只是目录项**，没有任何受守护的服务端入口——与 R4 裁决的判断一致。

## 2. 资金执行入口盘点（用户/运维可触发）

| 入口 | 服务函数 | 实际效果 | 当前守卫 |
| --- | --- | --- | --- |
| `POST /billing/:id/status` | `advanceBillingInvoice`（`workflow/billing.ts`） | 发票状态推进；`→ PAID` 时写 `paidAt/paidAmount/externalRef` + `billing.status_changed` 审计（事务内 CAS） | 无（仅 `advanceBilling` 权限） |
| `POST /payments/events/:id/replay` | `replayPaymentEvent`（`workflow/payment-attempt.ts`） | 重放 provider 事件（要求白名单 reason；无 paymentId → 409） | 无（仅角色/租户） |
| `POST /payments/processing/retry-due` | `runDueRetries`（`workflow/payment-attempt.ts`） | 到期 attempt 重放（宿主侧调度调用） | 无 |
| `POST /payments/webhook` | `handlePaymentWebhook`（`workflow/payment-webhook.ts`） | **外部 provider 驱动**：验签 → `executeAttempt` → 发票 PAID/对账失败事件 | 无 Action Guard（以签名 + 幂等 `providerEventId` 为边界，非会话动作） |

## 3. 调用链

```text
[用户会话] POST /billing/:id/status ──▶ advanceBillingInvoice ──▶ BillingInvoice(PAID) + 审计
[用户会话] POST /payments/events/:id/replay ──▶ replayPaymentEvent ──▶（事件状态回放/对账）
[用户会话] POST /payments/processing/retry-due ──▶ runDueRetries ──▶ executeAttempt ──▶ provider 端口
[外部]     POST /payments/webhook（验签）──▶ handlePaymentWebhook ──▶ executeAttempt ──▶ provider 端口
```

`executeAttempt`（`payment-attempt.ts`）是实际“尝试收款/重试”的核心，只有 webhook 与 retry-due 两条链会到达它；
所有 provider 交互经端口注入（测试用合成适配器），**没有真实支付凭据**。

## 4. 建议的实际接入范围（送审确认）

**纳入本批次（受保护的动作级入口）**

1. `POST /billing/:id/status`（尤其 `→ PAID` 的收费确认）——动作 `payment.capture`；
2. `POST /payments/events/:id/replay`——动作 `payment.capture`（运维补偿，同样改变资金事实）；
3. `POST /payments/processing/retry-due`——动作 `payment.capture`（批量补偿入口）。

三条都经 `createHitlSubmissionBoundary().submit()`，复用 R1–R4 已冻结的机制：`approvalId`=审批事件 id、
服务端固定 `boundAction`、规范化载荷指纹、锁内**案件/目标**串行化与完整重验、消费事件、最终成功/拒绝审计关联。

**本批次不纳入但需在七段式说明**

- `POST /payments/webhook`：外部 provider 驱动、非会话动作，边界是签名验证 + `providerEventId` 幂等 +
  已知事件形状校验；是否额外加 Action Guard 需架构方裁定（若纳入，需明确“谁的审批”语义）。
- 真实支付渠道、真实凭据、真实扣款：继续 HOLD，本批次绝不触达。

## 5. 验收映射（沿用本批已冻结的五项要求）

| 要求 | 本批次落地方式 |
| --- | --- |
| 服务端操作级审批绑定 | 三入口统一要求 `approvalId`（审批事件 id）+ 服务端固定 `boundAction=payment.capture` + 规范化载荷指纹（金额/币种/引用/证据） |
| 默认拒绝、拒绝零资金/外部副作用 | 无审批 / 载荷不符 / 过期 / 撤销 / 主体失效 → 403，且发票状态、Payment、attempt、审计消费均无业务写入 |
| 有效期、撤销、消费 | 复用 R1–R3 已冻结的 `expiresAt` / revoked / consumed 语义与原因码 |
| 重试重新核验、并发恰一次 | 每次提交重新核验；目标级 advisory lock（invoiceId/paymentEventId）+ 事务内 CAS，重复提交走幂等 |
| 策略-审批-最终结果审计关联 | `action_guard.evaluated` / `action_guard.approval_decision` / 最终执行审计（发票或支付对象）+ 锁内拒绝审计，均带 approvalId/operationId/执行主体/目标 |

## 6. 待架构方在本轮七段式中确认的点

1. 上述三条入口是否即为本批次接入范围（或需增减）；
2. webhook 是否纳入 Action Guard（若纳入，审批语义如何定义）；
3. `payment.capture` 的载荷指纹应包含哪些字段（建议：invoiceId、金额、币种、externalRef/支付引用、证据或事件 id）。

## 7. 实现计划（按 R1–R4 已验证的模式，逐文件）

现状差异：支付域已有 `payment.review_*` 状态机（`payment.ts` 的 `submitPaymentReview`）但与 recovery 的 R0 版本同型——
只表达“发票曾被批准过”，**没有** `approvalId`、`boundPayload`、`boundAction`、`expiresAt`、消费事件与锁内重验。

| 步骤 | 文件 | 内容 |
| --- | --- | --- |
| P1 | `workflow/payment.ts` | APPROVE 写入 `boundAction='payment.capture'` + 规范化 `boundPayload`（invoiceId/金额/币种/引用/证据）+ `expiresAt` + `fingerprintVersion:'v1'`；缺关键字段拒绝；返回 `approvalId`（审批事件 id） |
| P2 | `action-guard/approval-tx-verify.ts` | 把事务内验证器参数化为「审批事件 action 家族 + 目标实体类型」，recovery 行为保持不变（默认参数），新增 `payment.capture` 变体（`payment.review_approved` / `BillingInvoice`） |
| P3 | `action-guard/hitl-approval-verifier.ts` | 允许按动作选择审批事件家族（默认 recovery）；两套验证器继续共用判定口径 |
| P4 | `workflow/http-routes.ts` | 三条入口经 `createHitlSubmissionBoundary().submit({ action:'payment.capture', approvalId, payload })`；`approvalId` 缺失 → 守卫 REQUIRE_APPROVAL（409），perform 零执行 |
| P5 | `workflow/billing.ts` / `payment-attempt.ts` | 目标级 advisory lock（`cc-payment-invoice:<invoiceId>` / `cc-payment-event:<eventId>`）+ 锁内完整重验 + 消费事件 + 幂等返回；被拒绝时零资金写入，并写 `payment.capture_rejected` 审计 |
| P6 | 测试 | 真实 HTTP + PostgreSQL：审批绑定/载荷变更/过期/撤销/消费/主体失效/并发恰一次/拒绝零副作用/审计关联；保留既有支付域套件 |
| P7 | 文档 | 绑定契约新增支付域章节；`payment.capture` 写入清单登记；非阻塞整理项（契约标题/依据链、4.1/4.2 排序） |

风险控制：本批次只加「服务端入口 + 机制」，不接真实渠道与凭据；provider 端口继续由测试适配器注入。
