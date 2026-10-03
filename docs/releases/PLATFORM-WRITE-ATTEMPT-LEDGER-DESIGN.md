# PLATFORM WRITE — 持久化执行账本与审批消费原子边界设计

> 依据：**MSG-20261001-17 = PASS WITH REVISE**（CHANGE B / C / D）
> 状态：**设计稿（未实施）** —— 本轮不写 migration、不接 HTTP、不接真实 adapter、不开启 transport
> 分支 `gate/7-commercial-validation` · Codex · 2026-10-01 · ROUND: **R34**（待送审）

---

## 0. 裁决原文口径（本轮必须回答什么）

- **CHANGE A**：暂不接对外 HTTP 入口。当前没有持久化 attempt ledger，也没有「审批消费 + attempt 创建/占位」的事务边界；此时开放 HTTP 会让进程级状态承担外部请求的重试、并发和崩溃恢复语义。
- **CHANGE B**：先设计持久化 `PlatformWriteAttempt`，再申请 Schema Delta；**不得直接写 migration**。
- **CHANGE C**：审批消费必须与「获得执行权」形成数据库事务原子边界；真实网络调用不得假装与事务原子，需定义 `UNKNOWN_PROVIDER_RESPONSE` 及 reconciliation/recovery 语义。
- **CHANGE D**：`PLATFORM_WRITE_TRANSPORT_ENABLED=true` 不单独构成真实写入授权。

## 1. 现状事实（写设计前先与代码对齐）

| 事实 | 位置 | 对设计的影响 |
| --- | --- | --- |
| 尝试账本当前只有内存实现 | `apps/api/src/services/platform-write/ledger.ts` | 仅可服务单进程测试；**不能**作为跨请求去重依据 |
| 状态机已定义 | `apps/api/src/services/platform-write/state-machine.ts` | 账本状态必须与之逐一对齐，禁止引入第二套状态词表 |
| 快照与幂等键已定义 | `apps/api/src/services/platform-write/snapshot.ts`（`platform-write-request/v1`；`pw1-<sha256(version|digest)[0..40]>`） | 幂等键可直接作为账本唯一键的组成部分 |
| 审批事实来源 = 审计事件 | 审批 = `AuditLog` 中 `recovery.review_approved` 事件的 **id**；消费 = 追加 `recovery.approval_consumed` 事件（`changes.approvalId`） | CHANGE C 的事务边界必须把**消费事件**与**attempt 占位/CAS**放进同一数据库事务 |
| 传输闸门恒关 | `apps/api/src/services/platform-write/types.ts`（`PLATFORM_WRITE_TRANSPORT_ENABLED = false`） | 账本落地后开关仍保持 false；真实通道另需 CHANGE D 的独立授权 |
| 既有近似实现 | `PaymentProcessingAttempt`（payment 域） | 字段与约束风格沿用，降低评审成本 |

## 2. 目标 / 非目标

**目标（本设计覆盖）**：跨进程唯一执行链、可恢复的尝试记录、审批不可重复授权、崩溃后结果可判定、对账语义明确。

**非目标（本轮明确不做）**：真实 transport、平台 adapter、对外 HTTP 入口、凭据、资金动作、客户提交、Schema 实施（另需批准）。

## 3. 数据模型草案（`PlatformWriteAttempt`）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | `String @id @default(uuid())` | 主键 |
| `organizationId` | `String` | 租户；所有查询必须带此列 |
| `action` | `String` | 受保护动作名（`platform.write`），单一来源常量 |
| `snapshotVersion` | `String` | `platform-write-request/v1` |
| `snapshotDigest` | `String` | 服务端快照摘要（64 hex） |
| `idempotencyKey` | `String` | `pw1-*`；同一逻辑提交恒定 |
| `attemptNo` | `Int` | 从 1 开始；失败重试递增 |
| `status` | `PlatformWriteAttemptStatus` | 见 §4；默认 `PENDING` |
| `targetKind` / `targetId` | `String` / `String` | CLAIM / APPEAL + 对象 id（弱引用，不建 FK） |
| `platform` | `String` | 目标平台标识（写入口径，不代表已获授权） |
| `simulated` | `Boolean @default(true)` | 是否模拟通道；真实通道开启后必须为 false 才允许真实调用 |
| `approvalId` | `String?` | 审批事件 id（`recovery.review_approved` 的 id） |
| `basisReference` | `String?` | 审批绑定的快照摘要；必须等于 `snapshotDigest` |
| `errorClass` / `errorCode` | `String?` / `String?` | 白名单分类与错误码（如 `UNKNOWN_PROVIDER_RESPONSE`） |
| `errorSummary` | `String?` | 限长短句；禁止 payload / token / secret |
| `startedAt` / `finishedAt` | `DateTime?` / `DateTime?` | 执行权取得与收敛时间 |
| `nextRetryAt` | `DateTime?` | 退避表达式；无需守护进程 |
| `providerRef` | `String?` | 上游引用（真实通道才有意义；模拟通道为 `SIMULATED-*`） |
| `reconciledStatus` / `reconciledAt` | `String?` / `DateTime?` | `UNKNOWN_PROVIDER_RESPONSE` 的对账结论 |
| `createdAt` / `updatedAt` | `DateTime` | 审计时间轴 |

## 4. 状态机对齐（不新增词表）

| 服务层状态 | 账本状态 | 说明 |
| --- | --- | --- |
| `PENDING` | `PENDING` | 已占位，未取得执行权 |
| `IN_FLIGHT` | `IN_FLIGHT` | 已消费/预留审批执行权，外部调用进行中 |
| `SUCCEEDED` | `SUCCEEDED` | 终态；不可改写 |
| `RETRYABLE` | `RETRYABLE` | 未达上限，等待 `nextRetryAt` |
| `FAILED` | `FAILED` | 上游硬拒绝，终态 |
| `DEAD_LETTER` | `DEAD_LETTER` | 达上限（3），终态 |
| `BLOCKED` | `BLOCKED` | fail-closed 拒绝（未投递） |
| （新增）不确定结果 | `UNKNOWN_PROVIDER_RESPONSE` | **仅**真实通道可能产生；模拟通道不得出现在此状态 |

## 5. 三条并发不变量的落地方式（CHANGE B 必答）

**I1：同一幂等键最多存在一条有效执行链**
- 约束：`@@unique([organizationId, idempotencyKey])`（有效链 = 非 `FAILED` 且非 `DEAD_LETTER` 的复重试；选项 A）
- 备选（选项 B）：`@@unique([organizationId, idempotencyKey, attemptNo])` + 应用层保证同一键只推进同一 attempt 链。
- 取舍：选项 A 更严格、实现简单，但需要「失败后重新发起」走新键（由业务显式决定）；选项 B 保留重试历史行，但需要额外读锁判断「同键不得同时存在两条 IN_FLIGHT」。**建议 A，请架构方裁定**。

**I2：同一审批不能授权两个不同 snapshot**
- 约束：`@@unique([organizationId, approvalId])`（`approvalId` 非空时）；写入前断言 `basisReference === snapshotDigest`。
- 任何不一致一律拒绝并要求重新审批（不覆盖、不复用）。

**I3：崩溃/超时重试不得产生两个 `SUCCEEDED`**
- 应用层 CAS：`UPDATE ... WHERE id = ? AND status = IN_FLIGHT`；影响行数 0 即放弃。
- 数据库兜底（Postgres）：`CREATE UNIQUE INDEX ... ON PlatformWriteAttempt (organizationId, idempotencyKey) WHERE status = SUCCEEDED`。
- 需要 Prisma 迁移原生 SQL 支持（`prisma migrate` 允许在迁移内写 raw SQL）。**是否采用 partial unique index 请架构方裁定**（见待裁决问题 1）。

## 6. 执行权与审批消费的原子边界（CHANGE C 核心）

**禁止的顺序**：校验审批 → 外部调用 → 最后消费审批（外部调用成功后崩溃会二次执行）。

**T1（数据库短事务，事务内无网络调用）**
1. 锁定并重验审批：读 `recovery.review_approved` 事件行，校验租户 / 动作 / 过期 / 未消费；
2. 取得或创建唯一 attempt：`INSERT ... ON CONFLICT DO NOTHING` 后读回；
3. attempt CAS → `IN_FLIGHT`（带 `attemptNo` 与状态前值），并写 `startedAt`；
4. 追加 `recovery.approval_consumed` 审计事件（`changes.approvalId` 指向该审批），**同事务提交**。

**T2（事务外）**：真实/模拟外部调用。**绝不置于事务内**。

**T3（结果收敛事务）**
- `SUCCEEDED` → CAS 到 `SUCCEEDED` + `providerRef` + `finishedAt`（成功后不可改写）；
- `REJECTED` → `FAILED`；
- `RETRYABLE` → `attemptNo+1` 或写 `nextRetryAt`，未达上限保持可重试；
- 超时 / 连接中断 / 响应不可判定 → **`UNKNOWN_PROVIDER_RESPONSE`**（不直接重试）。

**崩溃恢复**
- 扫描 `status = IN_FLIGHT AND startedAt < now() - threshold` → 标记 `UNKNOWN_PROVIDER_RESPONSE`；
- 对账只允许「查询上游状态」，**不得重发写请求**；结论写 `reconciledStatus` / `reconciledAt`；
- 对账后仍无法判定 → 保持不确定状态并交人工处置（不得自动升级为 SUCCEEDED）。

## 7. 安全与数据最小化

- 账本**禁止**保存 credential / token / secret / 原始平台 payload；只保存摘要、引用与白名单错误码。
- `errorSummary` 限长（建议 <= 200 字符）且不得包含客户机密；平台特有字段不得进入核心领域模型。
- 租户隔离：所有读写必须带 `organizationId`；跨租户绑定（审批/目标对象）一律结构化拒绝。
- 成功行不可变：`SUCCEEDED` 后仅允许追加对账字段，且必须伴随审计事件。

## 8. 索引与保留期（建议）

- `@@index([organizationId, status, nextRetryAt])`（重试扫描）
- `@@index([organizationId, targetKind, targetId])`（按对象回看执行链）
- `@@index([organizationId, createdAt])`（审计对齐）
- 保留期建议与 `AuditLog` 对齐（24 个月），到期**归档而非删除**。

## 9. 迁移与回滚（仅设计，本轮不实施）

- 获批后单迁移「新增枚举 + 新增表 + 索引」，无历史回填、不改既有列。
- 回滚：drop 新表与新枚举；对既有表零影响。

## 10. 下一批实现完成后的验收清单（对应裁决 TEST 段）

同 key 并发、不同 snapshot 错绑审批、审批重复消费、执行权 CAS、事务回滚、进程重启后的幂等、retry 上限、`DEAD_LETTER`、`UNKNOWN_PROVIDER_RESPONSE`、成功 attempt 不可改写、跨租户绑定拒绝。

## 11. 待架构方裁决的问题

1. I1 采用选项 A（唯一键 `organizationId + idempotencyKey`）还是选项 B（含 `attemptNo`）？
2. I3 是否采用 Postgres partial unique index 作为数据库兜底？
3. `approvalId` 是否允许为空（无人工审批的模拟路径）？为空时 I2 的唯一约束如何表达？
4. `UNKNOWN_PROVIDER_RESPONSE` 的处置：自动探测对账 vs 纯人工；由谁触发、多久超时？
5. 保留期与归档形式（24 个月是否合适，归档到何处）。

---

## 12. MSG-20261001-18 裁定收入（本设计的最终口径）

### 12.1 五个问题的裁决结论

| 问题 | 裁决 | 对本设计的影响 |
| --- | --- | --- |
| ① I1 选项 | **选 A**：一个 `(organizationId, idempotencyKey)` = **唯一逻辑执行链** | 重试/恢复/对账**不得**另开第二条逻辑 attempt；`attemptNo` 只作为**同一逻辑记录内**的投递/对账计数，不产生可独立成功的第二条链 |
| ② partial unique index | **批准**（`SUCCEEDED` 唯一性） | 数据库承担最终不变量；索引冲突须转为稳定业务错误/幂等结果，不向 API 暴露约束细节 |
| ③ `approvalId` 可空性 | **不批准无条件可空** | Schema 可 nullable，但服务层 + 状态转换测试锁死：`simulated=false && status >= IN_FLIGHT ⇒ 有有效 approvalId`；暂不用过强数据库 CHECK |
| ④ UNKNOWN 处置 | **自动只读对账优先、人工兜底；禁止自动重发写请求** | 状态链 `UNKNOWN_PROVIDER_RESPONSE → RECONCILING → SUCCEEDED / FAILED_CONFIRMED / MANUAL_REVIEW`；默认 1 分钟 / 5 / 15 / 60 分钟退避，最长 24 小时后转人工 |
| ⑤ 保留期与归档 | 24 个月为**默认在线保留期**（非不可变合规结论） | legal/dispute hold 可阻止清理；归档为不可变、加密、访问受控的 append-only 导出；本阶段不实现清理任务 |

### 12.2 CHANGE A —— 区分「逻辑执行链」与「执行/对账历史」

- 本轮只建 `PlatformWriteAttempt`，它就是**唯一逻辑执行记录**；
- retry / reconciliation 信息先记录在**该记录自身**与 `AuditLog`；
- 未来若需要完整逐次 transport 历史，另设 **append-only child model**，不得让 `attemptNo=2/3` 变成同一幂等键的第二次独立写入机会。

### 12.3 CHANGE B —— UNKNOWN 状态的恢复所有权

| 角色 | 可执行动作 | 限制 |
| --- | --- | --- |
| SYSTEM | 只读 reconciliation（查询 provider 状态）、推进 `RECONCILING` | **不得**因此获得任何新的平台写权限；**绝不重发写请求** |
| OWNER / ADMIN（或未来明确批准的运营权限） | 将 `MANUAL_REVIEW` 收敛为终态 | 必须留下 `actor + reason` 审计 |

### 12.4 CHANGE C —— 审批消费必须与执行权具备可并发验证的不变量（附录：现状核查报告）

**现状核查（2026-10-01，代码事实）**：

| 事实 | 位置 | 影响 |
| --- | --- | --- |
| 审批消费 = 写一条 `recovery.approval_consumed` 审计事件（`changes.approvalId`） | `services/action-guard/{approval-tx-verify,hitl-approval-verifier}.ts`；写入点见 `services/claims/claim-submission.ts:221`、`services/appeals/appeal-submission.ts:245`、`services/workflow/recovery-outcome.ts` | **消费本身没有数据库唯一约束**；`AuditLog` 无 `approvalId` 列，无法直接对「同一 approval 消费两次」加唯一约束 |
| 「恰一次」由业务侧保障 | claim 的 DRAFT CAS + 案件 advisory lock；appeal 的 Appeal 行锁 + CAS | 已在既有批次通过真实 PostgreSQL 并发测试（MSG-20261001-07 / -16） |

**本设计的补齐方案（不弱化）**：把「获得执行权」的数据库级不变量放在**新表**上——`@@unique([organizationId, approvalId])`（`approvalId` 非空时）：

1. 取得执行权 = 在 `PlatformWriteAttempt` 上成功插入/CAS 一行；
2. 同一 approval 若已被消费，第二次插入直接违反唯一约束 → 结构化拒绝（不写入、不投递）；
3. 消费审计（`recovery.approval_consumed`）与 attempt 取得执行权**同事务**写入；
4. 因此「两个事务不能消费同一 approval 获得两个执行权」在数据库层可被判据。

> **需要架构方确认（CHANGE C 要求的前置报告）**：上述「以 `PlatformWriteAttempt.(organizationId, approvalId)` 唯一约束作为消费不变量」是否满足 CHANGE C；若要求**直接在审计侧**具备唯一约束（即给 `AuditLog` 增加可唯一约束的 `approvalId` 列），属于额外 Schema 变更，需另行裁定，本设计不擅自实施。

