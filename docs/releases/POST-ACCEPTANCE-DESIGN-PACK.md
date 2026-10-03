# POST-ACCEPTANCE DESIGN PACK（P0-4 / P0-2 / P0-3 / P1 设计与审计前置）

- 依据：HOST DIRECTIVE 2026-10-04「POST-ACCEPTANCE GAP CLOSURE」§四/五/七/八/九/十
- 原则：涉及 **Schema / Auth 安全边界 / 新运行时依赖 / 数据保留语义** 的部分**先设计并送架构审计**，本轮不擅自落库。

## 1. Durable Worker / Scheduler Runtime（§四）

### 1.1 现状

- `apps/api` 运行时依赖基本只有 Prisma；`DEPLOYMENT.md` 提到 Temporal 为**可选**但未落地。
- 现有周期性能力仅靠进程内定时 + 重试，**不具备** durable 语义（进程重启后任务丢失）。
- 明确禁止：`setInterval` / 内存队列冒充 durable scheduler。

### 1.2 候选技术 tradeoff

| 维度 | Temporal | BullMQ + Redis |
|---|---|---|
| durable 保证 | 事件溯源工作流，最强（含长事务、补偿） | 队列 + 重试，持久但非工作流引擎 |
| 运行成本 | 需 Temporal Server + DB（自托管）或云服务（**付费**） | 需 Redis（自托管/云，成本低） |
| 与 Node/Prisma 契合 | TS SDK 成熟；需 worker 进程模型 | 原生 Node、与现有 worker 进程模型契合 |
| 引入风险 | 较大（新服务 + 新概念 + 云依赖可能触发 HOST 付费审批） | 较小（一个中间件 + 一门库） |
| 适用场景 | 跨天/跨系统长流程、需补偿 | 轮询、刷新、webhook 跟进、重试、deadline scan |

**建议（待审计）**：**BullMQ + Redis** 作为 Layer 3 第一实现，理由是当前待办（provider polling / OAuth refresh / webhook follow-up / status reconciliation / retry+backoff / deadline scan / notification dispatch / payment retry / customs status refresh）均为**短任务 + 重试**语义，不需要工作流补偿；且避免引入需付费审批的托管服务。若未来出现跨天长流程，再评估 Temporal。

### 1.3 最小 runtime 契约（设计，未实现）

必须支持：Job identity（`jobId` + `executionKey`）、idempotency key、retry policy、指数退避、max attempts、dead-letter/failed terminal、timeout、concurrency limit、tenant/account/provider binding、trace/audit reference、graceful shutdown（SIGTERM 等待 in-flight）、**进程重启后恢复**。

**审计问题**：① 是否批准引入 BullMQ + Redis（含许可证审计：BullMQ MIT / Redis 采用 RSALv2/SSPLv1 —— **需确认自托管 Redis 的法律可用性**，或改用 Valkey/KeyDB）；② Redis 作为**新的必需外部依赖**是否接受；③ 若否决，是否同意 Token Bucket in Postgres（无新依赖但吞吐较低）。

## 2. Email Verification Token Lifecycle（§二）

- 端点：`POST /auth/verify-email`、`POST /auth/resend-verification`。
- Token：随机 32B；**只存 hash**（`sha256` + 独立 salt），明文仅出现在邮件链接；不进日志。
- 生命周期：`expiresAt`（建议 24h）、**single-use**（消费即 `consumedAt`）、重放 → fail-closed、按邮箱+IP rate limit、审计 `auth.email_verified`。
- 成功后：`emailVerified=true`、`emailVerifiedAt`；**不得**自动授予任何 Organization 权限；不影响业务事实。
- 邮件投递：`EMAIL_DELIVERY = EXTERNAL_GATE`（无 provider），token lifecycle 与 HTTP 契约可先完成。
- **Schema Delta（待批）**：`EmailVerificationToken(userId, tokenHash, expiresAt, consumedAt, createdAt, requesterIpHash)` + 索引 `(userId, tokenHash)`。

## 3. Password Reset Lifecycle（§三）

- 端点：`POST /auth/forgot-password`、`POST /auth/reset-password`。
- **不泄露邮箱是否存在**（恒定响应与恒定耗时）；token hash-only、expiry（建议 30min）、one-time、重放拒绝、rate limit。
- 成功：更新 `passwordChangedAt`、**撤销该用户全部现有 session**、审计 `auth.password_reset`。
- **Schema Delta（待批）**：`PasswordResetToken(userId, tokenHash, expiresAt, consumedAt, createdAt, requesterIpHash)`。

## 4. Notification Phase 1（In-App，§五）

- 首批事件：`claim.deadline_approaching`、`claim.response_received`、`recovery.confirmation_required`、`recovery.payout_discrepancy`、`review.required_high_value`。
- 能力：列表、read/unread、acknowledge、**recipient tenant isolation**、dedupe（`(organizationId, recipientUserId, dedupeKey)` 唯一）、deep link、severity、permission trimming（无权限者不投递）。
- **Schema Delta（待批）**：`Notification(id, organizationId, recipientUserId, kind, severity, titleKey, deepLink, dedupeKey, createdAt)` + `NotificationRead(notificationId, userId, readAt) `；`NotificationDelivery` 留待 Phase 2（email）。
- 明确：**不得**自动联系外部平台。

## 5. Mutation CSRF / Origin Audit（§七）

| 路径类别 | 现状 | 判定 |
|---|---|---|
| Kill switch 写路径 | 已有 Origin/Referer + `x-crossclaim-csrf` | 保持（基准实现） |
| `/auth/login` `/auth/logout` | 仅 SameSite=Lax | **够用**（无跨站自动携带风险的敏感副作用；登录本身无 cookie 依赖） |
| claim.prepare / claim.submit / appeal.submit | SameSite=Lax | **建议加 Origin guard**（高价值 + 有真实副作用） |
| billing / payment review | SameSite=Lax | **建议加 Origin guard**（资金相关） |
| connection / account / member mutation | SameSite=Lax | **建议加 Origin guard** |
| customs start-recovery | SameSite=Lax + Action Guard | **建议加 Origin guard** |

结论：`MUTATION_CSRF_AUDIT = REVISE`（建议对高价值/资金/授权类 mutation 统一 Origin guard；**不机械复制**——需保留无 cookie 的 API 客户端可用性，因此按「存在 session cookie 且非只读」判定）。实现前请架构方确认判定口径。

## 6. Distributed Rate Limit Readiness（§八）

- 现状：`rate-limit.ts` 为进程内 Map（多实例失效）。
- 方案 A：反代 / Cloudflare / API Gateway 限流（`EXTERNAL_INFRA_REQUIRED`，需宿主）。
- 方案 B：Redis-backed limiter（与 §1 的 Redis 依赖合并评估）。
- 必须覆盖：`/auth/login`、`/auth/signup`、`/auth/verify-email`、`/auth/resend-verification`、`/auth/forgot-password`、`/auth/reset-password`、OAuth callback、webhook。
- 单机 baseline 保留。

## 7. Production Alerting Design（§九）

报警清单（design-only，真实监控系统属 HOST/infra）：

`api_5xx_rate` · `readyz_failure` · `db_unavailable` · `provider_auth_failure` · `provider_rate_limit_exhausted` · `oauth_refresh_failure` · `webhook_verification_or_retry_failure` · `job_retry_exhausted` · `queue_backlog` · `customs_submission_failure` · `payment_reconciliation_mismatch` · `disk_memory_pressure`。

输出：`OBSERVABILITY-INTEGRATION-DESIGN.md`（本轮给出清单与触发阈值建议）；接入外部监控 = HOST_ACTION_REQUIRED；不得购买服务。

## 8. Data Retention / Export / Delete（§十）

必须区分：

| 类别 | 处置 |
|---|---|
| 可删除客户数据 | 原始上传、画像、连接与凭据引用、通知 |
| 必须保留（法律/财务/审计） | Billing/发票、Settlement 事实、AuditLog（保留期后**匿名化**而非删除）、Customs 申报相关文档（法定保留期） |

流程：用户删除请求 → 停未来同步（revoke connection）→ 撤销 session → 软删除 + 到期物理清理；Organization 删除需 owner 二次确认 + 冷却期；**禁止**直接 cascade 全租户冒充合规删除。导出：结构化导出（JSON/CSV）+ 审计。任何 Schema/保留政策变更**先送架构审计**。

## 9. 本轮未实现（避免伪完成）

- 上述 Schema Delta（验证/重置 token、通知、保留字段）**未落库**（等审计）。
- Durable worker runtime **未实现**（等依赖审计）。
- 真实邮件投递 / 真实监控 / 真实 backup·secret 演练 = HOST / EXTERNAL_GATE。
