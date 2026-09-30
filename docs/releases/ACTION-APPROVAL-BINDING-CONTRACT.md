# 审批绑定与生命周期契约（授权项 ② · R1 → R3）

依据：**MSG-20260930-17**（R1 REVISE）→ **MSG-20260930-18**（R2 REVISE）→ **MSG-20260930-19**（R3 REVISE）。
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
| 审批轮次 | 审批事件必须晚于其对应的 `recovery.review_required`，且 `review_required` 与审批之间不得插入另一轮 | 否则 `APPROVAL_NOT_APPROVED` |
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

> 实现与测试（`action-guard-hitl-*`、`workflow-hitl-db`、`workflow-outcome-db`）按本文件逐条对齐后送审。
