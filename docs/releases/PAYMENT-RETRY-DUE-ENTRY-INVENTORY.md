# retry-due 入口盘点（Gate 7 / 授权项② 第二批：冻结批次 retry-due）

依据：MSG-20260930-22 §6(2)（冻结清单批次审批设计裁决）与 MSG-20260930-28 §7（ACK：按既定顺序立即推进冻结批次 retry-due，无需额外确认）。
本文件为**接入前盘点**，用于在七段式中明确实际接入范围，避免把"未接入"写成"已完成"。

## 1. 现有入口与调用链（现状，未接守卫与批次审批）

| 层 | 位置 | 现状 |
| --- | --- | --- |
| HTTP | `services/workflow/http-routes.ts` → `PAYMENT_RETRY_DUE_PATH = /^\/payments\/processing\/retry-due$/` | 受认证会话；POST；`server.ts` 白名单已含该路径 |
| 服务 | `services/workflow/payment-attempt.ts` → `runDueRetries(prisma, { organizationId, role, limit }, { now })` | 仅 `assertPermission(setCommercialTerms/advanceBilling)`；**无 Action Guard、无批次审批** |
| 选单 | 同上 | **动态** 查询 `status=RETRYABLE_FAILED AND nextRetryAt <= now`，`orderBy nextRetryAt asc`，`take = min(max(limit ?? 20, 1), 100)` |
| 逐项执行 | 同上 | 无 `paymentId` → 直接 `DEAD_LETTER` + 原因；有上下文 → `startAttempt(SYSTEM)` + `recoverPaymentSucceeded(...)`（**每个 item 各自独立事务**） |
| 资金保护 | `applyPaymentSucceeded`（R8–R10 已加固） | 事务内取发票 advisory lock、锁后重读 `status/total/currency`、PAID CAS 含 `total`/`currency` 事实 |
| 缺口 | — | ① 无服务端 `batchId`/冻结清单；② 无清单指纹（版本/关联发票/金额币种/操作类型）；③ 无有效期与数量上限之外的授权约束；④ 执行可**动态**纳入批准后新增的 due 项；⑤ 无"每项执行前重验事实/权限/生命周期/幂等并留证"；⑥ 无 SYSTEM 预授权范围声明；⑦ 未复用 replay 已验收的**事件锁 → 发票锁 → Payment 行锁 + 最终快照**协议 |

**结论：当前 retry-due 是"按需扫描 + 动态选单"的运维入口，没有任何人工审批边界。** 这是本批次要关闭的缺口。

## 2. 已批准的设计要求（架构方裁决，须逐条落地）

1. **租户隔离**；服务端生成 **`batchId`**。
2. 指纹 = **排序后的明确 attempt/event 清单**及版本、关联发票、金额币种、操作类型，**加有效期与数量上限**。
3. 执行**不得动态扩展到批准后新出现的 due 项**。
4. 每项执行前**重验当前事实、权限、生命周期及幂等条件**；变化项**拒绝或跳过并留证**。
5. **不接受**只绑定 `limit`、查询条件或"当前所有到期项"的开放批次。
6. 后台重试须明确 **SYSTEM 执行身份与预先授权范围**，不能借用未核验用户身份。
7. 复用资金收口路径时，**保持 replay 已验收的锁顺序（事件锁 → 发票锁 → Payment 行锁）、最终事实保护与事务边界**。

## 3. 拟接入范围（本批次交付）

- 新增受保护动作身份 **`payment.retry_due`**（`MONEY_MOVEMENT`，requires `humanApproval` + `productionGate`），与 `payment.capture` / `payment.replay` 三者互不通用、互不消费。
- **冻结（freeze）**：`POST /payments/processing/retry-due/freeze` —— 服务端生成 `batchId`，选取当前 due 项（`RETRYABLE_FAILED` 且 `nextRetryAt <= now` 且 `paymentId` 非空），**排序**（`nextRetryAt asc, id asc`），逐项固化指纹（`attemptId`/`paymentEventId`/`paymentId`/`invoiceId`/`externalPaymentId`/`providerEventId`/`payloadHash`/规范化金额币种/`attemptNo`/操作类型/处理版本），并记录**有效期**（默认 15 分钟）与**数量上限**（默认 ≤ 20，服务端硬上限）。冻结清单以 `PaymentRetryBatch` 审计记录（`entityType='PaymentRetryBatch'`，`entityId=batchId`）落库。
- **审批（approve）**：同一入口 `POST /payments/processing/retry-due/review`（REQUEST/APPROVE/REJECT；审批人 OWNER/ADMIN；APPROVE 由服务端在锁内组装绑定载荷 = `batchId` + 清单摘要 + 有效期 + 数量上限）。
- **执行**：`POST /payments/processing/retry-due` 必须携带 `approvalId` + `batchId`，经 HITL 边界：
  ① 锁内重读批次记录并核对清单摘要（**逐项**比对，任何新增/删除/顺序变化 → 拒绝）；
  ② 逐项执行前重验：事件/发票/Payment 事实与冻结值一致、权限与生命周期仍有效、幂等条件成立；不一致项 → **跳过并留证**（不执行、不消费）；
  ③ 每项复用 replay 的资金路径与锁协议，**同一事务**内完成 attempt/资金写入/审计；
  ④ 批次消费事件 `payment.retry_due_consumed`（独立于 capture/replay 的消费事件）；
  ⑤ SYSTEM 执行身份：`actorType=SYSTEM`、`actorRef=payment-retry-worker`，并在审计中记录"预先授权范围 = 冻结清单 + batchId + 有效期"。
- **不做**：不扩大为全仓库资金模型改造；不新增独立审批表（批次记录走既有审计域，与审批/消费事件同族）。

## 4. 明确后置（不在本批次）

- webhook 侧改造（保持"接收已发生付款事实 ≠ 授权新扣款"）。
- 其他未接入受保护入口（`claim.submit` / `appeal.submit` / `platform.write` / `secret.rotate`）。
- 真实支付渠道扣款、真实凭据、生产资金能力（继续 HOLD）。

## 5. 测试计划（真实 HTTP + PostgreSQL）

1. 冻结 → 审批 → 执行全链路：`batchId` 一致、清单逐项执行、批次消费恰一次、审计带 `batchId`/`approvalId`/SYSTEM 身份。
2. 缺 `approvalId` / `batchId` → 409/400 精确拒绝，零副作用。
3. **批准后新增 due 项** → 执行只处理冻结清单，新增项不被执行。
4. 冻结后清单内某项事实变化（金额/币种/provider/发票） → 该项跳过并留证，其余项正常执行。
5. 有效期过期 / 撤销 / 主体停用 / 跨域冒用（capture 或 replay 审批用于 retry-due，反向亦然）。
6. 数量上限与 `limit` 越界：服务端夹取，且不得绕过冻结清单。
7. 消费审计失败 → 整批事务回滚（不留部分执行）。

## 6. 待架构方确认的口径（本批次将在七段式中显式列出）

- 冻结清单的**哈希算法**（本批次拟用 `sha256` over 规范化 JSON 清单）。
- 批次内**部分失败**的语义（本批次：逐项独立事务 + 跳过留证；批次整体状态记为 `PARTIAL`/`COMPLETED`，不因单项失败回滚已成功项）。
