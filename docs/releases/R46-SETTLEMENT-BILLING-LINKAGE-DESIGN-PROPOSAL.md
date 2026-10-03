# R46 — Settlement / Billing Linkage · Design / Boundary Proposal

> 依据：**MSG-20261002-51 = PASS — R45 CLOSED**（③ 批准进入 R46，但**第一轮只提交 Design Proposal**，不得直接实现）。
> 状态：**docs-only 设计提案** —— 本文件不改 Schema、不写 migration、不改代码、不加依赖。
> R46 是**新的高风险资金边界**，需重新开 Gate；本轮只定义事实边界与转换条件。
> 配套红线：R12（Success Fee / Billing 永久红线）· R13（支付授权分离与 Onboarding / 自动收费契约）· R14（Customs / BrokerConnector）。

---

## 0. 边界（本轮不实现，且继续冻结）

**NO Settlement creation from R45 · NO FeeCalculation creation · NO BillingInvoice issuance · NO Payment activation · NO autopay · NO platform write · TRANSPORT=false · NO production credentials**；
R13 的 **Payment Activation Gate 继续 HOLD**，不得因 R45 CLOSED 自动解锁。

## 1. 事实分层（回答 Q1 / Q2 / Q3 的总纲）

```text
R45（derived，可重算）
  ReimbursementFact(OBSERVED)  →  ClaimReconciliationProjection(RECONCILED / FULLY_RECONCILED)
        ↓  仅作为“候选信号”，不是资金事实
R46（financial facts，append-only / 受控状态机）
  Settlement(RECEIVED / PARTIAL)   ← 必须有外部到账证据 + humanApproval
        ↓
  RecoveryLedgerEntry              ← 账本事实（既有模型）
        ↓
  FeeCalculation                   ← 计费事实（费率来自既有 FeeBasis）
        ↓
  BillingInvoice                   ← 应收事实
        ↓
  Payment / PaymentEvent           ← 实收事实（独立 Payment Activation Gate；当前 HOLD）
```

硬不变量（逐层不可跳跃）：

```text
REIMBURSEMENT_OBSERVED / RECONCILED
   ≠ Settlement RECEIVED
   ≠ Fee earned
   ≠ Billing payable
   ≠ Payment collected
```

## 2. 逐条回答 MSG-20261002-51 的 15 问

### Q1 什么事实才允许从 R45 进入 Settlement

只有**外部可验证的资金到账事实**才允许建立 Settlement：银行流水 / PSP 结算单 / 平台结算报告（settlement report）+ 可追溯证据（EvidenceArtifact）。
R45 的 projection（含 FULLY_RECONCILED）**不**直接创建 Settlement；R45 只提供“候选信号”与可追溯的对账证据。
Settlement 写入必须同时满足：`status = RECEIVED`（或 PARTIAL 的已到账部分）· `confirmationStatus = CONFIRMED` · `reconciliationStatus ∈ { RECONCILED, PARTIAL }` · `evidenceId` 非空 · 未被冲回（`reversedBySettlementId IS NULL`）。

### Q2 FULLY_RECONCILED 是必要条件还是充分条件

**既不是充分条件，也不是独立必要条件。**

- 不充分：对账完成 ≠ 钱到账；不得由 FULLY_RECONCILED 推导 Settlement；
- 不必要（单独看）：真实到账可能由银行/PSP 先于对账确认（例如平台结算单先到、对账随后完成）；
- 但它是对账侧的**必要组成**：只有 reconciliation 完成且无未决异常（无 AMBIGUOUS / CONFLICTING_EVIDENCE）时，Settlement 才能进入 `reconciliationStatus = RECONCILED`，从而成为**可计费**前置。

### Q3 provider reimbursement observation 与真实到账 / Settlement.receivedAt 如何区分

| 维度 | ReimbursementFact(OBSERVED)（R45） | Settlement.receivedAt（R46） |
| --- | --- | --- |
| 视角 | provider 侧“观察到一笔赔付” | **我方/客户收款账户**实际入账 |
| 证据来源 | 平台 API / 报表 / 人工录入 + 证据 | 银行流水 / PSP 结算 / 平台结算报告 + 证据 |
| 语义 | 观察事实（可能只是账面 accrual） | 资金事实（可用于计费） |
| 可否计费 | **否** | 满足 Q1 条件后**是** |
| 撤销方式 | REIMBURSEMENT_REVERSED 新事实 | reversedBySettlementId 冲回链 |

### Q4 partial reimbursement 如何映射

- R45：多笔 OBSERVED 事实逐笔记录；projection 可为 PARTIALLY_RECONCILED；
- R46：`Settlement.status = PARTIAL` + `amount = 已到账部分`；**只按已到账部分**计费（Fee/Billing 不预收未到账差额）；
- 二者不同层：PARTIALLY_RECONCILED（对账口径）≠ PARTIAL（资金口径）。

### Q5 reversal / correction 到来后已生成的 Settlement 如何处置

1. **不修改、不删除**既有 Settlement（append-only + 受控状态机）；
2. 新增反向/更正事实（`reversedBySettlementId` 冲回链；R45 侧 REIMBURSEMENT_REVERSED）；
3. 已生成的 FeeCalculation 必须**重算**；已签发 BillingInvoice 走既有受控状态机（VOID / WRITTEN_OFF），**不得直接改金额**；
4. 已收款情形（Payment）不在本轮范围；退款/拒付语义见 Q14。

### Q6 一个 Claim 多笔 reimbursement / 多笔 Settlement

允许 1:N：一个 ClaimItem 可以有多笔 OBSERVED 事实与多笔 Settlement（每笔到账一条 Settlement，各自带证据与审批）；
累计口径：Settlement 累计（已确认到账、未冲回）用于计费；projection 仍只做候选与异常检测，**不成为资金累计源**。

### Q7 currency mismatch / FX 是否允许

v1 **不允许 FX / 自动换汇**：Settlement.currency 必须与 expected basis / EPS 币种一致，否则 `CURRENCY_MISMATCH` fail-closed；
跨币种场景另开独立设计（含汇率来源、时点、审计与合规），不在 R46 v1 内实现。

### Q8 success fee 的计费 basis

计费基数 = **已确认到账且未被冲回**的 Settlement 金额（PARTIAL 取已到账部分）；
费率来源 = 既有 FeeCalculation 的 `FeeBasis`（RECOVERED_AMOUNT_PCT / FIXED / TIERED；`NONE` 不得开票）；
**禁止**使用 projection 的 netMatchedObservedAmount、平台 approved 状态或 ClaimItem 金额字段作为计费基数（R12 §1 已冻结）。

### Q9 FeeCalculation / BillingInvoice 在什么时间点允许产生

| 事实 | 允许产生的前提 |
| --- | --- |
| FeeCalculation | Settlement 满足 R12 可计费判定（RECEIVED/CONFIRMED/RECONCILED 或 PARTIAL + 证据 + 未冲回）+ 受保护动作 + humanApproval |
| BillingInvoice | 存在有效 FeeCalculation（金额 > 0、币种一致、FeeBasis ≠ NONE）+ 受保护动作；沿用既有 `billing.draft` 的锁后重读 / 依据唯一 / `BILLING_BASIS_REQUIRED` 口径 |
| Payment 收取 | **不在 R46 v1**；需 R13 Payment Activation Gate 放行（客户明确预授权 + 通道正式验收） |

### Q10 如何保证 reconciliation 重跑不会重复生成 Settlement/Fee/Billing

四道防线：

1. **层级隔离**：reconciliation 重跑只更新 projection（derived），**不触碰** Settlement / Fee / Billing；
2. **服务端幂等键**：Settlement 键（org + claimItemId + 到账引用 + receivedAt + amount + currency）、Fee 键（settlementId + feeBasis + policyVersion）、Billing 键（沿用既有 BILL-<caseNo> 与 `@@unique` 口径）；命中即复用，不新建；
3. **approval 恰好消费一次**：每个受保护动作一次审批，重复执行返回既有事实（execution replay）；
4. **checker**：R46 收口时把「Fee/Billing 依据存在且唯一」「Settlement 与 Fee 币种/金额关系」「重跑后资金域零变化」纳入只读一致性检查。

### Q11 manual override 是否能直接触发资金域

**不能。** override 只影响 projection 的匹配解释（MATCHED / UNMATCHED），属于对账层；
资金域（Settlement / Fee / Billing）必须由**到账事实 + 独立审批**驱动，禁止从 override 推导。

### Q12 所有状态转换的 Action Guard / humanApproval 边界

| 动作（建议命名，待批） | 风险级别 | 闸门 |
| --- | --- | --- |
| `settlement.record`（建立/更新 Settlement 到账事实） | INTERNAL_WRITE | humanApproval + 锁后 ACTIVE membership/role 重验 + 证据 |
| `billing.fee_calculate`（生成 FeeCalculation） | INTERNAL_WRITE | humanApproval + 锁后重验 + 依据唯一 |
| `billing.invoice_issue`（开具 BillingInvoice） | INTERNAL_WRITE | humanApproval + 锁后重验（沿用 `billing.draft` 口径） |
| `payment.capture`（实际收款） | MONEY_MOVEMENT | humanApproval + **productionGate**（当前 HOLD） |

所有动作沿用既有范式：advisory/行锁 → 锁后实时角色重验 → 审批边界重验（boundAction + boundExtra 指纹）→ 事实写入 → 业务审计 → approval 消费 → commit；失败整体回滚。

### Q13 与既有 R12/R13 Payment Activation Gate 的关系

- R12 定义**可计费判定与禁止清单**：R46 的 Fee/Billing 必须完全遵循（本提案 §Q8/Q9 即其落地）；
- R13 定义**支付授权分离**：Platform OAuth ≠ Payment Authorization；R46 只生成账单事实，**不得**在没有有效 Payment Mandate 时自动扣款；
- **Payment Activation Gate 继续 HOLD**：R45 CLOSED 不构成解锁条件。

### Q14 退款 / 冲正 / chargeback 的后续语义

- 冲正（provider 侧）：以新事实表达（R45 REIMBURSEMENT_REVERSED / R46 冲回链），已生成的 Fee/Billing 按 Q5 处置；
- 退款（我方退回客户）：属反向资金流，需独立设计（授权、审计、对账影响）；
- chargeback / 拒付：涉及 PSP 与合规，**v1 只登记语义、不实现**；任何实现前需独立合规审查。

### Q15 财务事实与审计事实如何分离

| 类别 | 载体 | 性质 |
| --- | --- | --- |
| 财务事实 | Settlement / RecoveryLedgerEntry / FeeCalculation / BillingInvoice / Payment | 有状态机与唯一约束的**业务真值** |
| 审计事实 | AuditLog（append-only 事件） | 谁在何时做了什么、依据什么审批 |

不允许用 AuditLog 充当金额真值，也不允许用状态机字段替代审计链；两者交叉验证（checker 同时检查事实状态与审批语义）。

## 3. 幂等 / 并发 / 事务（继承既有底座）

- 全部沿用既有 advisory lock / FOR UPDATE / CAS / 幂等键 / approval 恰好一次消费；
- 资金事务与 projection 重算**不得耦合**：projection 可重算，资金事实不可重算；
- 任何后置失败必须整体回滚（以 R45 S4 的故障注入验收为模板）。

## 4. 风险

1. **语义滑坡**：把 RECONCILED / FULLY_RECONCILED 误解为 money received 或 billable revenue（本提案以 §1 硬不变量封堵）；
2. **重复计费**：重跑 / 重放导致重复 Settlement/Fee/Billing（以 Q10 四道防线封堵）；
3. **越权计费**：override 或 projection 直接触发资金域（Q11 明确禁止）；
4. **授权越界**：把 Platform OAuth 或 Broker POA 当成支付授权（R13 已冻结，R46 不得违反）；
5. **资金池/代收**：未经独立合规审计的代收模式（R14 已冻结）。

## 5. 请裁决

1. §1 的事实分层与硬不变量、§2 对 15 问的答复是否认可？
2. Q2（FULLY_RECONCILED 既非充分也非独立必要，但对账侧必要组成）与 Q11（override 不得触发资金域）两个口径是否批准？
3. 是否批准下一步按 **R46-A（Settlement / Billing Linkage Schema Delta Request，docs-only）→ R46-B（Implementation Plan）→ S1…Sn** 推进（每个 Schema 变更单独送审）？

> 边界（重申）：本提案不实现任何资金域代码；在 R46 Design 获批前保持 **NO Settlement creation from R45 · NO FeeCalculation · NO BillingInvoice · NO Payment activation · NO autopay · NO platform write**；R13 Payment Activation Gate 继续 HOLD。
