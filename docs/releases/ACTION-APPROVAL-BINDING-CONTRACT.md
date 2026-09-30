# 审批绑定与生命周期契约（授权项 ② · R1 → R4；② 第二批 payment.capture 接入中）

依据：**MSG-20260930-17**（R1 REVISE）→ **MSG-20260930-18**（R2 REVISE）→ **MSG-20260930-19**（R3 REVISE）→ **MSG-20260930-20**（R4 REVISE，自动路径锁内判定与事件顺序）→ **MSG-20260930-21**（R4 = PASS；下一批次 = ② 第二批 payment.capture）→ **MSG-20260930-22**（R5 REVISE：审批必须绑定真实账单操作与迁移；下一批次 = 账单入口 R6，随后 replay → 冻结批次 retry-due）。
本文件随每轮裁决同步：**只保留已兑现的表述**，未实现的承诺不得留在契约里。
范围：受保护业务入口（首批 = recovery-outcome → 资金确认）的**操作级**审批授权。

---

## 1. 审批身份（CHANGE A）

| 项 | 契约 |
| --- | --- |
| 批准标识 | **审批事件的 `AuditLog.id`**：`recovery.review_approved` 那一行的 id 即 `approvalId`。不接受随机 ID、他案 ID、他租户 ID |
| 为什么不用"案件状态" | 案件 APPROVED 只说明"该案被批准过一次"；本次操作的授权必须可定位到**具体审批事件**（含审批人、时间、绑定载荷） |
| 是否新增表 | **不新增独立 Approval 表**（避免 Schema 涟漪）；仅当审计事件方案无法满足绑定或原子性时才改走最小 Schema Delta，并附迁移证据 |
| 审批人 | 记入事件的 `actorUserId`；R3 起必须同时满足「用户状态 ACTIVE + 该租户有效成员 + 角色 ∈ {OWNER, ADMIN}」 |
| 执行人 | **与审批人分别校验**：R3 起必须同时满足「用户状态 ACTIVE + 该租户有效成员 + 角色 ∈ {OWNER, ADMIN, FINANCE}」；不要求与审批人同一人 |
| 主体校验时机 | 事务外（wrapper）与**事务内（资金锁内）各校验一次**，口径一致：任一次发现失效即拒绝 |

## 2. 绑定内容（CHANGE A）

审批事件写入时必须绑定本次操作的**规范化载荷指纹**：

```text
boundPayload = {
  amount: <4 位小数规范化字符串>,
  currency: <ISO 大写>,
  basisReference: <规范化字符串>,
  evidenceArtifactId: <或 null>,
  fingerprintVersion: 'v1'
}
```

执行时逐项比对；**任一关键字段变化 → 拒绝并要求重新审批**。动作绑定与版本：

- `approvalId` 对应的审批事件必须声明 `boundAction`（本批 = `commission.charge`）；
- 入口映射在代码注释与文档中显式记录：`POST /cases/:id/recovery-outcome`（资金确认）↔ 动作 `commission.charge`；
- **R3**：读取审批时校验 `boundPayload.fingerprintVersion`；**缺失或未知版本一律拒绝** `APPROVAL_VERSION_UNSUPPORTED`
  （写入时的 `normalizeBoundPayload` 固定产出 `v1`，不能替代读取时校验）；
- **禁止**通过 `requiredStateForAction = NOT_REQUIRED` 绕过动作目录的人工审批要求——该分支已删除。

## 3. 生命周期（CHANGE B）

| 状态 | 判定 | 处理 |
| --- | --- | --- |
| 有效期 | 审批事件记录 `expiresAt`（默认 24h，可配置）；`now >= expiresAt`。R3：`now` 必须是**两把锁获取之后重新读取的服务端时间**，不得沿用等待锁之前的时间 | 拒绝 `APPROVAL_EXPIRED` |
| 撤销 | 出现晚于该审批的 `recovery.review_rejected` / `recovery.approval_revoked` | 拒绝 `APPROVAL_REVOKED` |
| 消费 | 存在携带同一 `approvalId` 的 `recovery.approval_consumed` | 进入幂等返回**之前**仍必须先通过本节全部重验（见 §4） |
| 审批轮次 | 审批事件必须晚于其对应的 `recovery.review_required`，且 `review_required` 与审批之间不得插入另一轮（**R4**：同案件生命周期事件时间在案件锁内生成并严格递增，见 §4.2） | 否则 `APPROVAL_NOT_APPROVED` |
| 数据源异常 | 查询/解析失败 | 拒绝 `APPROVAL_SOURCE_ERROR`（事务内外同一原因码；**不得**伪报为租户不匹配或裸 `SOURCE_ERROR`） |

## 4. 原子执行与恰一次（CHANGE B · R3 修订）

在确认回收的资金事务内（顺序固定）：

1. `SELECT pg_advisory_xact_lock(hashtext('cc-recovery-case:' || caseId))` —— **无条件**获取案件锁（含缺 `approvalId` 的兼容调用）；
2. 有 `approvalId` 时再取 `cc-approval:<approvalId>`（锁顺序恒为「案件 → 审批」，故同案不同审批也只能形成一条资金链）；
3. 锁内**重新**读取服务端时间并重验 §2/§3 全部条件（不沿用事务外结论，也不沿用等待前的时间）；
4. **锁内按案件**核查既有资金链（无论 `approvalId` 是否已消费）：四类对象任一缺失 → `ILLEGAL_TRANSITION`，**不得**返回空 ID 冒充成功；
5. 合法幂等返回必须能证明「这条链就是本审批消费产生的」：比对消费事件的 `approvalId` / `operationId` 与本次规范化载荷（金额、币种），并对齐 Settlement 金额；不一致 → `APPROVAL_NOT_APPROVED` / `APPROVAL_PAYLOAD_MISMATCH`；
6. 通过后才写 `recovery.approval_consumed`（含 `approvalId`、`operationId`、执行主体、目标）与资金对象（Settlement → RecoveryLedgerEntry → FeeCalculation → BillingInvoice）。

由此得到：

- 首次提交：恰好一次资金写入 + 一条消费记录；
- **合法幂等重试**（同 `approvalId` + 同载荷 + 链完整）：返回既有结果（`created=false`），不再产生资金对象；
- 并发首次提交：advisory lock 串行化，只有一条链；其余请求读到完整链后走幂等分支；
- **撤销 / 过期 / 主体失效优先于幂等返回**：即使该审批此前已成功消费过，重试时若已撤销、已过期或主体失效，一律**最终拒绝**（R3 口径变更，取代 R2 的「先返回既有结果」）；
- 同案不同审批并发：旧审批被新一轮 `review_required` 取代后拒绝，全案仍只有一条完整链。

### 4.2 生命周期事件顺序（R4）

- 自动写入（`assertHighValueReviewCleared` 的 `review_required`）与显式 REQUEST/APPROVE/REJECT **都在案件锁内**读取事件、推导状态、决定是否写入与 `previousState`；锁外读取只能作为预检查，不决定写入。
- 生命周期事件时间在**案件锁内**生成；同一案件内严格递增（若当前毫秒不晚于已有最新事件，则顺延 1ms），使 `createdAt` 的 `<` / `>` 在事务内外都有确定语义，不假设毫秒时间唯一。
- 因此「自动路径读到旧状态 → 期间完成 APPROVE → 仍按旧状态追加 REQUEST」的交错不再可能：自动路径要么在锁内看到 `APPROVED` 而不写入，要么先写入 `review_required`（此时后续 APPROVE 的轮次顺序明确，旧审批在新轮次生效后被拒绝）。

### 4.1 缺 `approvalId` 的兼容路径（R3 显式收口）

- 受保护 HTTP 入口**无法进入**该路径：动作 `commission.charge` 在动作目录中要求 `humanApproval`，缺 `approvalId` 时守卫直接 `REQUIRE_APPROVAL`（409），`perform` 零执行；
- **高额确认若缺操作级审批**（USD 超阈值 / 非 USD）：服务端入口直接拒绝 `REVIEW_REQUIRED`——「案件已 APPROVED」不是操作级审批的替代；
- 低额、且由服务内部直接调用（非受保护入口）的兼容调用仍保留，但同样受**案件锁**保护，不得再出现"绕过最终边界"的返回。

## 5. 审计与口径（CHANGE D）

实际落库的审计事件（与代码一致，不再保留未兑现的事件名）：

| 记录 | 事件 | 关键字段 |
| --- | --- | --- |
| 策略评估 | `action_guard.evaluated` | action / decision / code / risk / actor / org |
| 审批核验结果 | `action_guard.approval_decision` | `decision`（ALLOW/DENY）、`code`、`reasonCodes`/`reason`、`actorUserId`（执行主体）、`approvalId`、`operationId`、目标（`entityType=ActionGuardTarget` + `entityId`） |
| 首次执行成功 | `recovery_outcome.confirmed` | `entityType=Settlement` + `entityId=Settlement.id`（可与具体 Settlement 关联）、`approvalId`、`operationId`、`result=CONFIRMED`（USER actor 记 `actorUserId`） |
| 审批消费 | `recovery.approval_consumed` | `approvalId`、`operationId`、`caseNo`、金额、币种（USER actor 记 `actorUserId`） |
| 最终拒绝（新增） | `recovery.outcome_rejected` | `actorUserId`（执行主体，因主体可能已停用而记入 `changes`）、`approvalId`、`operationId`、`caseId`/`caseNo`、`stage`（ENTRY_GATE / LOCKED_RECHECK）、`reason`、`result=REJECTED` |

- 拒绝路径的审计写入失败**不得覆盖原始拒绝错误**（放行路径相反：缺审计端口或写入失败必须失败关闭）；
- 只记录规范化指纹与关联标识，**不记录凭据或原始敏感载荷**；
- 口径修正：「零副作用」准确表述为「**零业务/资金副作用**」——安全审计允许新增；
- 静态字符串检查仅为「有限静态约定检查」，不使用「类型与测试层面不可行」这类表述；
- 未配置守卫的错误码：默认装配路径（READ_ONLY）→ `ACTION_GUARD_REQUIREMENTS_NOT_MET`；直接缺依赖分支 → `ACTION_GUARD_NOT_CONFIGURED`。

## 5.1 支付域：`payment.capture`（② 第二批）

| 项 | 值 |
| --- | --- |
| 受保护动作 | `payment.capture`（目录要求 `humanApproval` + `productionGate`；Kill Switch scope `billing`） |
| 审批事件族 | `payment.review_required` / `payment.review_approved` / `payment.review_rejected`（挂在 `BillingInvoice` 上，与 `recovery.review_*` 的 `Case` 族彻底分离） |
| 消费事件 | `payment.capture_consumed`（含 `approvalId`/`operationId`/`invoiceId`/状态迁移与金额；与资金写入同事务） |
| 审批写入 | `submitPaymentReview` 的 APPROVE 必须绑定 `boundAction` + 规范化 `boundPayload`（金额/币种/依据）+ `expiresAt` + `fingerprintVersion`，并返回 `approvalId` |
| 锁与顺序 | 发票级 advisory lock（`cc-payment-invoice:<invoiceId>`）；生命周期事件时间在锁内生成且同发票严格递增（与 recovery 同规则） |
| 入口闭环（R5/R6） | `POST /billing/:id/status` 经 HITL 边界接入；缺 Action Guard 即 fail-closed；缺 `approvalId` → 409 REQUIRE_APPROVAL |
| 审批创建入口（R6 新增） | `POST /billing/:id/payment-review`（受认证会话；审批人 OWNER/ADMIN），REQUEST/APPROVE/REJECT，APPROVE 由服务端组装绑定载荷 |
| 真实操作绑定（R6 CHANGE A） | 审批指纹 = `invoiceId` + **精确 `from`→`to`** + 金额 + 币种 + 依据 + 证据 + 版本；`payment.capture` 审批**只能用于 `to=PAID`**（签发等迁移走独立授权） |
| 锁内事实核对（R6 CHANGE A） | 执行时在发票锁内**重读** `status/total/currency`，与批准快照逐项比对；不一致 → 403 `APPROVAL_PAYLOAD_MISMATCH`（堵住"批准 1 USD 却登记 1500 USD"） |
| 最终审计（R6 CHANGE D） | `billing.status_changed` 记 `approvalId`/`operationId`/`result`；锁内拒绝写 `payment.capture_rejected`（stage/reason/执行主体/审批/操作/结果，SYSTEM actor，事务外写入且失败不覆盖原错误） |
| 幂等语义 | 状态迁移**不是**幂等创建：审批已消费且发票已在目标状态时，重复提交返回 409 `ILLEGAL_TRANSITION`，消费记录保持 1（零新增副作用） |

待架构方裁定（本批次未接）：

- `POST /payments/events/:id/replay` 的审批主体（目标为 `PaymentEvent`，载荷指纹如何定义）；
- `POST /payments/processing/retry-due` 的审批主体（一次调用可能覆盖多张发票，是否需要「批次摘要指纹」）；
- `POST /payments/webhook` 是否纳入 Action Guard（当前边界 = 验签 + `providerEventId` 幂等 + 事件形状校验）。

## 5.2 三项设计裁决（MSG-20260930-22，已授权实施）

- **replay**：执行主体=当前认证用户（独立核验有效成员与执行权限），审批人 OWNER/ADMIN；审批目标=具体 `PaymentEvent`，指纹绑定其关联发票、事件/支付身份、规范化金额币种、预期恢复动作、处理版本与载荷摘要；**不绑定用户可替换的原始 JSON**；事件或关键关联变化即失效；不得把账单确认审批用于 replay。
- **retry-due**：采用**冻结清单批次审批**——租户隔离、服务端生成 `batchId`、指纹=排序后的明确 attempt/event 清单及版本+关联发票+金额币种+操作类型+有效期与数量上限；执行不得动态扩展到批准后新出现的 due 项；每项执行前重验事实/权限/生命周期/幂等，变化项拒绝或跳过并留证；不接受只绑定 limit 或查询条件的开放批次；后台重试须以 SYSTEM 身份运行并带预先授权范围。
- **webhook**：接收付款事实**不引入每次人工审批**，保持验签、重放保护、幂等、租户/发票/金额币种匹配与审计边界；但「接收已发生付款」与「发起新扣款/外写」必须分离——验签成功不等于授权扣款，后续处理仍受运行模式、Kill Switch、生命周期与适用审批规则约束。

## 6. 验收矩阵（CHANGE C 对应）

| 场景 | 期望 | 资金对象 |
| --- | --- | --- |
| 已 APPROVED 案件 + 随机/他案/他租户 `approvalId` | 拒绝（NOT_FOUND / TARGET / TENANT） | 四类均 0 |
| 审批动作不匹配（如 `claim.submit`） | 拒绝 ACTION_MISMATCH | 四类均 0 |
| 执行人/审批人非成员、停用或无权限 | 拒绝 ACTOR_MISMATCH（事务内外同口径） | 四类均 0 |
| 金额/币种/依据/证据变更 | 拒绝 PAYLOAD_MISMATCH | 四类均 0 |
| 指纹版本缺失/未知 | 拒绝 VERSION_UNSUPPORTED | 四类均 0 |
| 过期 / 撤销 | 拒绝 EXPIRED / REVOKED（含**等锁期间**发生的情形） | 四类均 0 |
| 审批源异常 | 拒绝 SOURCE_ERROR | 四类均 0 |
| 既有资金链缺项 | 拒绝 `ILLEGAL_TRANSITION`，不返回空 ID、不消费审批 | 不新增任何对象 |
| 首次成功后授权撤销再重试 | **最终拒绝**（R3：重验优先于幂等返回） | 仍恰为 1 套且不新增 |
| 合法重复请求（同审批 + 同载荷） | 幂等返回既有结果 | 四类均恰为 1 |
| 并发首次提交（同一审批） | 仅一次 201，其余 200 | 四类均恰为 1 |
| 同案件不同审批并发 | 旧审批被取代后拒绝 | 全案最多一条完整链 |
| 受保护入口缺 `approvalId` | 409 REQUIRE_APPROVAL | 四类均 0 |
| 支付域（`payment.capture`，账单入口）缺 `approvalId` | 409 `ACTION_GUARD_HUMAN_APPROVAL_REQUIRED` | 发票状态与支付对象不变 |
| 支付域审批已消费后重复提交 | 409 `ILLEGAL_TRANSITION`（状态迁移非幂等），消费记录仍为 1 | 无新增副作用 |

> 实现与测试（`action-guard-hitl-*`、`workflow-hitl-db`、`workflow-outcome-db`）按本文件逐条对齐后送审。
