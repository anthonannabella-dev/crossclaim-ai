# 审批绑定与生命周期契约（授权项 ② R1 · MSG-20260930-17 CHANGE A/B）

依据：**MSG-20260930-17**（② 第一批 = REVISE）。本文件先把契约写死，随后按契约实现与送审。
范围：受保护业务入口（首批 = recovery-outcome → 资金确认）的**操作级**审批授权。

---

## 1. 审批身份（CHANGE A）

| 项 | 契约 |
| --- | --- |
| 批准标识 | **审批事件的 `AuditLog.id`**：`recovery.review_approved` 那一行的 id 即 `approvalId`。不接受随机 ID、他案 ID、他租户 ID |
| 为什么不用"案件状态" | 案件 APPROVED 只说明"该案被批准过一次"；本次操作的授权必须可定位到**具体审批事件**（含审批人、时间、绑定载荷） |
| 是否新增表 | **本 R1 不新增独立 Approval 表**（避免 Schema 涟漪）；仅当审计事件方案无法满足绑定或原子性时才改走最小 Schema Delta，并附迁移证据 |
| 审批人 | 记入事件的 `actorUserId`（须为该租户 ACTIVE 成员，且具备审批角色） |
| 执行人 | **与审批人分别校验**：执行人须为该租户成员且具备执行该动作的权限；不要求二者同一人，也不得用硬编码 OWNER 代替 |

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

执行时逐项比对；**任一关键字段变化 → 拒绝并要求重新审批**。动作绑定：

- `approvalId` 对应的审批事件必须声明 `action`（本 R1 = `commission.charge`）；
- 入口映射必须在代码注释与文档中显式记录：`POST /cases/:id/recovery-outcome`（资金确认）↔ 动作 `commission.charge`；
- **禁止**通过 `requiredStateForAction = NOT_REQUIRED` 绕过动作目录的人工审批要求——该分支删除。

## 3. 生命周期（CHANGE B）

| 状态 | 判定 | 处理 |
| --- | --- | --- |
| 有效期 | 审批事件记录 `expiresAt`（默认 24h，可配置）；`now >= expiresAt` | 拒绝 `APPROVAL_EXPIRED` |
| 撤销 | 出现晚于该审批的 `recovery.review_rejected` / `recovery.approval_revoked` | 拒绝 `APPROVAL_REVOKED` |
| 消费 | 存在 `recovery.approval_consumed`（携带同一 `approvalId`） | 拒绝 `APPROVAL_ALREADY_CONSUMED`（幂等重试见 §4） |
| 审批轮次 | 审批事件必须晚于其对应的 `recovery.review_required`，且 `review_required` 与审批之间不得插入另一轮 | 否则 `APPROVAL_NOT_APPROVED` |
| 数据源异常 | 查询/解析失败 | 拒绝 `APPROVAL_SOURCE_ERROR`（**不得**统一伪报为租户不匹配） |

## 4. 原子执行与恰一次（CHANGE B）

在确认回收的资金事务内（顺序固定）：

1. `SELECT pg_advisory_xact_lock(hashtext('cc-approval:' || approvalId))` —— 以审批为粒度的串行化；
2. 锁定后**重新**读取审批事件与消费事件（不沿用事务外结论）；
3. 校验 §2/§3 全部条件；
4. 写 `recovery.approval_consumed`（含 `approvalId`、`operationId`、执行主体、目标）；
5. 写资金对象（Settlement → RecoveryLedgerEntry → FeeCalculation → BillingInvoice）。

由此得到：

- 首次提交：恰好一次资金写入 + 一条消费记录；
- **合法幂等重试**（同 `approvalId` + 同载荷）：返回既有结果，**不再产生资金对象**（明确 409/既有结果，不用宽松断言）；
- 并发首次提交：advisory lock 串行化，只有一个进入第 4 步，其余读到消费记录后走幂等分支；
- 撤销与执行串行化：撤销若先获得锁并落事件，执行方后续校验即拒绝。

## 5. 审计与口径（CHANGE D）

- 三类记录必须可区分：**策略 ALLOW**（`action_guard.evaluated`，含 action/decision/code/risk/actor/org）、
  **审批核验结果**（新增 `action_guard.approval_verified` / `action_guard.approval_rejected`，含 approvalId、reason、执行主体、目标、operationId）、
  **最终执行结果**（资金/消费事件）。
- 记录执行主体、目标、审批身份与操作关联标识；**不记录凭据或原始敏感载荷**（只记录规范化指纹）。
- 删除过度声明：静态字符串检查仅为「有限静态约定检查」；不使用「类型与测试层面不可行」等表述。
- 口径修正：「零副作用」准确表述为「**零业务/资金副作用**」——安全审计允许新增。
- 未配置守卫的错误码：默认装配路径（READ_ONLY）→ `ACTION_GUARD_REQUIREMENTS_NOT_MET`；
  直接缺依赖分支 → 统一改为 `ACTION_GUARD_NOT_CONFIGURED`（不再用 `WorkflowError FORBIDDEN` 混淆两条路径）。

## 6. 验收矩阵（CHANGE C 对应）

| 场景 | 期望 | 资金对象 |
| --- | --- | --- |
| 已 APPROVED 案件 + 随机/他案/他租户 approvalId | 拒绝（NOT_FOUND / TARGET / TENANT） | Settlement/RecoveryLedgerEntry/FeeCalculation/BillingInvoice 均 0 |
| 审批动作不匹配（如 claim.submit） | 拒绝 ACTION_MISMATCH | 同上 0 |
| 执行人非成员/无权限 | 拒绝 ACTOR_MISMATCH | 同上 0 |
| 金额/币种/依据/证据版本变更 | 拒绝 PAYLOAD_MISMATCH | 同上 0 |
| 过期 / 撤销 / 已消费 | 拒绝 EXPIRED / REVOKED / ALREADY_CONSUMED | 同上 0 |
| 审批源异常 | 拒绝 SOURCE_ERROR | 同上 0 |
| 首次成功后授权状态变化再重试 | 幂等：返回既有结果，不新增资金对象 | 四类均恰为 1 |
| 并发首次提交 | 仅一次成功，其余幂等/拒绝 | 四类均恰为 1 且关联一致 |

> 本契约先于实现提交，实现与测试按本文件逐条对齐后再送审。
