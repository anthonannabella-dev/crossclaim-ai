# Recovery SI Phase 2 C —— PREPARE Tool 设计/实施边界（设计请求，零代码）

- 分支：`gate/7-commercial-validation`
- **REVIEWED_HEAD = `83860905`**（本文件所在提交；**本批零代码、零 Schema、零运行时接线**）
- 前置：**MSG-20261005-15 = PASS / CLOSED**（`REVIEWED_HEAD = c04c3c43`；FNV `b741dcca` / 178 行 / `FULL_COPY_OK`）。该裁决明确：`P2_C_PREPARE = NOT_AUTHORIZED`，且「下一步如要继续，应先单独送 P2-C PREPARE 的设计/实施边界；不要自动进入 P2-D」。
- 本轮性质：**设计请求**。提交目的仅为取得 P2-C 的范围授权；**不实现任何 PREPARE 工具、不新建表、不写库**。

## 1. 为什么 P2-C 必须与 P2-B 分开

MSG-20261005-13 已裁定：`P2-B = READ_ONLY`、`P2-C = INTERNAL_WRITE`，两者安全等级不同，
「即使不 submission，它也已经从 observation 跨到了 mutation」。因此 P2-C 需要独立的设计边界与验收口径。

## 2. 需要先回答的一个关键问题：P2-C v1 是否落库

PREPARE 的原始定义是「可能创建 Claim draft / RecoveryPackage / artifact 等内部业务写入」。
但仓库现状是：Phase 1/2-A/2-B 均**零 Schema 变更**，而 P2-E（持久化 RecoveryPlan / DecisionEvidence）
已被单独归入 `HOLD_SCHEMA_DELTA`。因此 P2-C 存在两种可能形态：

| 选项 | 形态 | 安全等级 | 与 P2-E 的关系 |
| --- | --- | --- | --- |
| **A（建议）** | **确定性包生成（纯函数）**：由 verified action 生成结构化 `RecoveryPackage` 对象并返回给调用方，**零落库**、零外写 | 接近 READ + COMPUTE（无 mutation） | 任何持久化 / 登记 / 版本历史都留到 P2-E（Schema Delta 单审） |
| **B** | **允许写入既有 append-only 实体**（例如既有 claim draft / artifact 引用表），但仍**不得 submission、不得外写** | INTERNAL_WRITE | 需要明确「写入白名单」；若需新表或新列，则自动升级为 Schema Delta（= P2-E） |

本设计请求**建议先批 A**（零 Schema、可快速验收），把 B 的落库范围连同 P2-E 的 Schema Delta 一起另审。
若架构方倾向 B，请只给出**最小写入白名单**与幂等键定义，不要在本轮顺带实现。

## 3. 无论 A 还是 B 都成立的不变量

1. **只有已验证的 plan action 才能触发 PREPARE**：执行入口不接受外部 verification 快照，必须像 P2-B 一样
   **在执行入口内部重新** `prioritizeOpportunities()` + `verifyRecoveryPlan()`（沿用 `CHANGE_B1` 语义）；
2. **静态绑定**：PREPARE 工具名来自静态 domain→工具绑定表，模型 / planner 不得构造 service 名；
3. **tenant 双绑定**：`input.organizationId === ctx.organizationId` 且 `input.organizationId === actor.organizationId`，
   任何不一致 fail-closed 且**零写入**；
4. **输出身份绑定 + 敏感扫描**：`output.opportunityRef === input.opportunityRef`，secret / token / 文件路径 / 存储引用一律拒绝；
5. **幂等**：同一 `(organizationId, opportunityRef, actionKind, planDigest)` 重复调用必须收敛到同一个包
   （同一 `packageDigest`），不得重复写入、不得产生第二个包；
6. **append-only / 无破坏**：不得 update / delete 既有事实；不得回填、不得覆盖；
7. **零外写清单**（本阶段**一张都不写**）：`Claim submission`、`CustomsSubmissionAttempt`、`PlatformWriteAttempt`、
   `Payment`、`Settlement`、`RecoveryLedger`、`Billing`、provider request；
8. **权限不变**：`L5` 请求（External Write / Payment / Customs Filing / Real Claim Submit / credentials）**永久拒绝**；
   `ACTION_GUARD_DRY_RUN_ALLOW != EXECUTION_AUTHORIZATION` 继续成立；
   `READY_FOR_EXECUTION` 仍是决策标记（`executionAuthorized = false`、`executorInvoked = false`）；
9. **不建第二套 Runtime**、`SECOND_RUNTIME = FORBIDDEN`、`L5_RELAXATION = FORBIDDEN`；
10. **不自动解锁**：P2-C 通过也不得自动进入 P2-D（Action Guard handoff）、P2-E（Schema）、P2-F（模型）、P2-G（真实执行）。

## 4. 建议的 P2-C 最小验收证据（若批选项 A）

```text
P2C-01  只有 verified PREPARE action 才触发：篡改 / 陈旧 plan → 入口内重新 verify → 零调用
P2C-02  未登记 PREPARE 工具 → fail-closed（TOOL_NOT_REGISTERED，零调用）
P2C-03  跨租户 / actor 错配 → fail-closed 且零调用、零写入
P2C-04  幂等：同键并发两次 → 只产生一个包（packageDigest 相同）、DB 写入 0
P2C-05  DB before/after：Claim submission / CustomsSubmissionAttempt / PlatformWriteAttempt /
        Payment / Settlement / RecoveryLedger / Billing 写入计数全部 = 0
P2C-06  network/provider 调用 = 0；credential 读取 = 0（含静态源码扫描证据）
P2C-07  输出 schema + 身份绑定 + 敏感字段扫描：越界输出一律 fail-closed（output = null）
P2C-08  L5 请求永久拒绝；executionAuthorized = false、executorInvoked = false 保持
```

若批选项 B，请在此之上追加：写入白名单实体、幂等唯一键、并发唯一赢家、append-only（UPDATE/DELETE 拒绝）证据。

## 5. 请求裁定

1. P2-C v1 是否按**选项 A（确定性包生成、零落库）**批准？若否，是否批准选项 B 并给出最小写入白名单？
2. 若选 B：`RecoveryPackage` / `artifact` / `claim draft` 的**幂等键**应如何定义？是否要求 Schema Delta（即并入 P2-E）？
3. P2-C 是否需要 OWNER approval 前置？（现建议：不需要新增审批，但既有 owner gate 不得解除）
4. 第 4 节的最小证据集合是否足够？若不足请只列最小补充项。
5. 是否确认 `P2-D / P2-E / P2-F / P2-G` 在 P2-C 完成后仍需各自单独送审（不得顺带实施）？

请在本次会话中直接回答；不要尝试写回 GitHub。不要使用上一轮缓存。

## 6. 边界声明（本请求不改动）

```text
P2_C = NOT_AUTHORIZED（本请求仅申请设计边界）
P2_D = NOT_AUTHORIZED
P2_E = HOLD_SCHEMA_DELTA
P2_F = HOLD
P2_G = HOLD
RSI_OUTCOME_SINK_RUNTIME_WIRING = NOT_AUTHORIZED
RUNTIME_WIRING = NONE
SCHEMA_DELTA_REQUIRED = NO（本请求零 Schema 变更）
EXTERNAL_WRITE = HOLD
PAYMENT = HOLD
TRANSPORT = HOLD
PRODUCTION_CREDENTIALS = HOLD
REAL_CLAIM_SUBMIT = HOLD
CUSTOMS_FILING = HOLD
RSI_MODEL_NETWORK = HOLD
RSI_PAID_MODEL_CALLS = HOLD
SECOND_RUNTIME = FORBIDDEN
L5_RELAXATION = FORBIDDEN
FINAL_ACCEPTANCE_HEAD = 0f7f7ac
```
