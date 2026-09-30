# payment.replay 入口盘点（Gate 7 / 授权项② 第二批：replay）

依据：MSG-20260930-22 §6(1)（replay 设计裁决）与 MSG-20260930-24 §7（ACK 顺序 replay → 冻结批次 retry-due）。
本文件为**接入前盘点**，用于在七段式中明确实际接入范围，避免把"未接入"写成"已完成"。

## 1. 现有入口与调用链（现状，未接守卫）

| 层 | 位置 | 现状 |
| --- | --- | --- |
| HTTP | `services/workflow/http-routes.ts` → `PAYMENT_REPLAY_PATH = /^\/payments\/events\/([^/]+)\/replay$/` | 受认证会话；POST；`server.ts` 白名单已含该路径 |
| 服务 | `services/workflow/payment-attempt.ts` → `replayPaymentEvent(prisma, { organizationId, actorUserId, role, paymentEventId, reason, note })` | 权限：`setCommercialTerms` + `advanceBilling`；`reason` 必须命中 `REPLAY_REASONS` 白名单；`note` 经 `redactErrorSummary` |
| 资金写入 | `recoverPaymentSucceeded`（同文件） | 沿 `attempt.paymentId → Payment` 回到同一条资金事实；无上下文 → 409 `PAYMENT_CONTEXT_REQUIRED`，不人工补金额 |
| 审计 | `ATTEMPT_AUDIT.replayed` / `.recovered` / `.linked` / `.failed` | 已有 append-only 的 PaymentProcessingAttempt 与审计事件 |

**结论：当前 replay 入口没有任何 Action Guard / 人工审批边界**，只有角色权限与原因白名单。这是本批次要关闭的缺口。

## 2. 已批准的设计要求（架构方裁决，须逐条落地）

1. 执行主体 = **当前认证用户**，独立核验有效成员与执行权限；审批人 OWNER/ADMIN。
2. 审批目标 = **具体 `PaymentEvent`**，指纹绑定：关联发票、事件/支付身份、规范化金额与币种、**预期恢复动作**、处理版本、**载荷摘要**。
3. **不得绑定用户可任意替换的原始 JSON**（`PaymentEvent.payloadHash` 是合适的摘要来源）；事件或关键关联变化即失效。
4. 采用**明确的 replay 操作身份**（独立 `boundAction`），不得把账单确认审批（`payment.capture`）直接用于 replay，反之亦然。
5. 执行前重新核验主体、事实、生命周期与幂等边界。

## 3. 拟接入范围（本批次交付）

- 新增受保护动作身份 **`payment.replay`**：Action Guard 目录项（`MONEY_MOVEMENT`，requires `humanApproval` + `productionGate`），与 `payment.capture` 完全分离的 `boundAction`。
- `POST /payments/events/:id/replay` 经 **HITL 提交边界**接入（`createHitlSubmissionBoundary`），缺 Action Guard 依赖即 fail-closed，缺 `approvalId` → 409 `ACTION_GUARD_HUMAN_APPROVAL_REQUIRED`。
- 审批事件族复用支付域（挂 `BillingInvoice`）还是新增 `PaymentEvent` 目标族：**本批次采用 `PaymentEvent` 目标**（`targetEntityType: 'PaymentEvent'`，`entityId = paymentEventId`），事件族沿用 `payment.review_required/approved/rejected` + 消费事件 `payment.replay_consumed`（独立于 `payment.capture_consumed`，避免互相消费）。
- 服务端组装指纹（客户端不可替换）：
  `invoiceId`、`paymentEventId`、`provider`、`providerEventId`、`payloadHash`、规范化 `amount`/`currency`、`externalPaymentId`、预期恢复动作（固定 `recoverPaymentSucceeded`）、处理版本（`v1`）。
- 执行侧在**锁内**重读 `PaymentEvent` 与 `Payment` 事实，逐项比对指纹；不一致 → 403（精确 reason），零资金副作用。
- 幂等/并发：同审批并发 → 恰一次新 attempt 与一次消费；已消费后重复提交 → 409 `ILLEGAL_TRANSITION` + 零新增副作用。

## 4. 明确后置（不在本批次）

- 真实支付渠道扣款、真实凭据、生产资金能力（继续 HOLD）。
- 冻结批次 retry-due（本批次之后单独推进，需服务端 `batchId` + 排序清单指纹 + 有效期 + 数量上限）。
- webhook 侧改造（保持"接收事实 ≠ 授权新扣款"边界）。
- 其他未接入受保护入口（`claim.submit` / `appeal.submit` / `platform.write` / `secret.rotate`）。

## 5. 测试计划（真实 HTTP + PostgreSQL）

1. 成功链路：REQUEST → APPROVE（服务端指纹）→ HTTP replay 200；attempt 恰一次、消费恰一次、审计关联 `approvalId`/`operationId`。
2. 缺 `approvalId` → 409 `ACTION_GUARD_HUMAN_APPROVAL_REQUIRED`，零副作用。
3. 指纹不符（事件 `payloadHash` 变化 / 金额币种变化 / 目标 `PaymentEvent` 不同）→ 403 精确 reason，零副作用。
4. 跨域冒用：`payment.capture` 审批用于 replay、replay 审批用于账单确认 → 双向拒绝。
5. 等锁期间事件关键关联变化 → 403；同审批并发 → 恰一次。
6. 审批过期 / 撤销 / 执行主体成员停用 → 精确拒绝且零副作用。

## 6. 待架构方确认的口径（本批次将在七段式中显式列出）

- 事件族目标从 `BillingInvoice` 扩展到 `PaymentEvent` 时，消费事件是否复用 `payment.capture_consumed`（本批次选择**独立** `payment.replay_consumed`，以便审计区分）。
- `payment.replay` 是否需要在控制面新增独立的 `platformEnablement` 开关（本批次沿用 `platformEnabled[action]` 机制）。
