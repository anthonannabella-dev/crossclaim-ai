# PLATFORM WRITE ATTEMPT — SCHEMA DELTA REQUEST

> 类型：**Schema Delta Request（仅请求批准；不含 migration、不含实现）**
> PREVIOUS: **MSG-20261001-17 = PASS WITH REVISE**（CHANGE B：先设计再申请 Schema Delta，不得直接写 migration）
> 分支 `gate/7-commercial-validation` · Codex · 2026-10-01 · ROUND: **R34**

---

## 0. 请求摘要

为 `platform.write` 增加**持久化执行账本**，使跨进程/崩溃场景下的三条并发不变量可被数据库约束保证：

1. 同一幂等键最多存在一条有效执行链；
2. 同一审批不能授权两个不同 snapshot；
3. 崩溃/超时重试不得产生两个 `SUCCEEDED`。

本请求**只申请 Schema 变更批准**；获批后才实施迁移与代码接线，且仍不开启真实 transport。

## 1. 新增枚举

```
enum PlatformWriteAttemptStatus {
  PENDING
  IN_FLIGHT
  SUCCEEDED
  RETRYABLE
  FAILED
  DEAD_LETTER
  BLOCKED
  UNKNOWN_PROVIDER_RESPONSE
}
```

> 与服务层 `services/platform-write/state-machine.ts` 的词表逐一对齐；`UNKNOWN_PROVIDER_RESPONSE` 仅真实通道可能产生。

## 2. 新增表 `PlatformWriteAttempt`

| 字段 | 类型 | 可空 | 说明 |
| --- | --- | --- | --- |
| `id` | `String @id @default(uuid())` | 否 | 主键 |
| `organizationId` | `String` | 否 | 租户；FK → Organization（Cascade） |
| `action` | `String` | 否 | 受保护动作名（`platform.write`，单一来源常量） |
| `snapshotVersion` | `String` | 否 | `platform-write-request/v1` |
| `snapshotDigest` | `String` | 否 | 服务端快照摘要（64 hex） |
| `idempotencyKey` | `String` | 否 | `pw1-*`；同一逻辑提交恒定 |
| `attemptNo` | `Int` | 否 | 从 1 开始 |
| `status` | `PlatformWriteAttemptStatus @default(PENDING)` | 否 | 见 §1 |
| `targetKind` | `String` | 否 | `CLAIM` / `APPEAL`（应用层枚举） |
| `targetId` | `String` | 否 | 目标对象 id（弱引用，不建 FK） |
| `platform` | `String` | 否 | 目标平台标识（写入事实口径） |
| `simulated` | `Boolean @default(true)` | 否 | 真实通道必须显式为 false 才允许真实调用 |
| `approvalId` | `String?` | 是 | 审批事件 id（`recovery.review_approved`.id；**非 FK**） |
| `basisReference` | `String?` | 是 | 审批绑定的快照摘要，必须等于 `snapshotDigest` |
| `errorClass` | `String?` | 是 | 白名单分类 |
| `errorCode` | `String?` | 是 | 白名单错误码（含 `UNKNOWN_PROVIDER_RESPONSE`） |
| `errorSummary` | `String?` | 是 | 限长短句；禁止 payload / token / secret |
| `startedAt` | `DateTime?` | 是 | 取得执行权时间 |
| `finishedAt` | `DateTime?` | 是 | 收敛时间 |
| `nextRetryAt` | `DateTime?` | 是 | 退避时间 |
| `providerRef` | `String?` | 是 | 上游引用（模拟通道为 `SIMULATED-*`） |
| `reconciledStatus` | `String?` | 是 | 对账结论（`CONFIRMED_SUCCEEDED` / `CONFIRMED_FAILED` / `INCONCLUSIVE`） |
| `reconciledAt` | `DateTime?` | 是 | 对账时间 |
| `createdAt` | `DateTime @default(now())` | 否 | |
| `updatedAt` | `DateTime @updatedAt` | 否 | |

**不包含**：credential / token / secret / 原始平台 payload / 平台特有字段。

## 3. 约束与索引（请求批准项）

| # | 约束 | 目的 |
| --- | --- | --- |
| C1 | `@@unique([organizationId, idempotencyKey])` | I1：同一幂等键唯一执行链（选项 A） |
| C2 | `@@unique([organizationId, approvalId])` | I2：一个审批不得授权两个 snapshot（`approvalId` 为空的行不受约束） |
| C3 | Postgres partial unique index：`(organizationId, idempotencyKey) WHERE status = SUCCEEDED` | I3：崩溃/超时重试不得产生两个 SUCCEEDED（需迁移内 raw SQL） |
| C4 | `@@index([organizationId, status, nextRetryAt])` | 重试/恢复扫描 |
| C5 | `@@index([organizationId, targetKind, targetId])` | 按对象回看执行链 |
| C6 | `@@index([organizationId, createdAt])` | 审计对齐 |

## 4. 与既有模型的关系

- 外键仅 `organizationId → Organization`（与 `PaymentProcessingAttempt` 一致）。
- `targetKind` / `targetId` 为**弱引用**，不建 FK：避免在执行账本上引入跨域强耦合。
- `approvalId` 指向 `AuditLog.id`（审批事实来源），**不建 FK**：审批是审计事件，账本只引用其 id 并复制摘要事实。
- 审计链可追踪：`case/claim/appeal → approval(AuditLog) → snapshotDigest → attempt → providerRef`。

## 5. 明确不包含（本轮不做）

- 不改任何既有表/列；
- 不新增 HTTP 入口；
- 不开启 `PLATFORM_WRITE_TRANSPORT_ENABLED`；
- 不接入真实平台 adapter 或凭据；
- 不写 migration（获批后另起一次提交）。

## 6. 影响面与回滚

- 影响面：新增表 + 新增枚举；对既有查询/索引零影响。
- 回滚：`DROP TABLE PlatformWriteAttempt; DROP TYPE PlatformWriteAttemptStatus;`；无数据回填、无破坏性操作。

## 7. 待批问题

1. C1 是否采用选项 A（`organizationId + idempotencyKey` 唯一）而非选项 B（含 `attemptNo`）？
2. C3 的 partial unique index 是否批准（需迁移内 raw SQL）？
3. `approvalId` 是否允许为空？为空时是否需要额外规则（例如仅 `simulated = true` 且 transport 关闭时允许）？
4. `reconciledStatus` 取值集合是否按建议固定为三值？
5. 保留期（建议 24 个月）与归档形式是否接受？
