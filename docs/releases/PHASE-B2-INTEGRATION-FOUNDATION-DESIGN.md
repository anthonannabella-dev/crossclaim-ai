# PHASE B2 — INTEGRATION FOUNDATION 设计（design only / 待 Schema Delta 审核）

来源：`docs/releases/BACKEND-ARCHITECTURE-DIRECTIVE.md` §4⑤⑥⑦⑧、§30、§32 PHASE B2。
状态：**DESIGN ONLY / PROGRESS**（不含代码与 migration；8 个模型必须先过架构方 Schema Delta 审核）。
边界：**NO platform write · Payment = 0 · autopay/collection/external write OFF · R13 HOLD · TRANSPORT=false · 无生产凭据**。

## 1. 已存在、不得重复建设（复用清单）

| 需求 | 既有实现（复用） | 缺口 |
|---|---|---|
| provider 接入契约 | `services/connect/provider-integration-contract.ts`（authKind / readOnlyScopes / callbackPath / pkce / capability） | 无（B2 只做持久化与编排接线） |
| OAuth state（一次性 / TTL / 租户绑定 / PKCE server-side） | `services/connect/oauth-state.ts` + `provider-callback.ts`（PC-11A） | 持久化表（OAuthAuthorizationSession） |
| carrier 授权 + 身份策略 | `services/carriers/carrier-auth-contract.ts`、`carrier-account-discovery.ts`（PROVIDER_DISCOVERY / PROVIDER_VERIFIED_REGISTRATION） | 持久化 lineage / verified account registry |
| 只读事实平面 | `carrier-tracking-read.ts`、`carrier-invoice-pod-read.ts`、`carrier-evidence-bundle.ts` | 结构化事实持久化（DomainFactSnapshot） |
| 凭据引用边界 | `SourceConnection.credentialRef`（平台侧）+ SecretVault 抽象（待建） | SecretVault 适配器 |

## 2. 8 个待审模型（§30）与复用/边界

| 模型 | 用途 | 关键不变量 | 与既有事实源的关系 |
|---|---|---|---|
| OAuthAuthorizationSession | 授权会话持久化（state hash / PKCE ref / scopes / returnPath / expiry / consumedAt） | state 只存 hash；verifier 不入库；expiry 明确；callback CAS；重放与跨租户拒绝 | 平移 `oauth-state.ts` 契约，不改变其语义 |
| ConnectionCapability | 每条连接的真实能力（ACCOUNT/SHIPMENT/TRACKING/INVOICE/POD/CLAIM_* / SETTLEMENT_READ + SUPPORTED/UNSUPPORTED/REQUIRES_SCOPE/REQUIRES_PARTNER_APPROVAL/UNKNOWN） | 必须挂 organizationId + connectionId；UI 不得猜测 | 由 `connector-capability.ts` / `carrier-auth-contract.ts` 投影生成，不新增 provider 事实源 |
| ConnectionSyncState | 每 resourceType 的 cursor / watermark / 失败计数 | 唯一键 (connectionId, resourceType)；tenant 作用域 | 替代把 cursor 塞进 SourceConnection.config |
| DomainFactSnapshot | 版本化结构化事实（shipment/v1、customs-entry/v1） | immutable / versioned / 带 snapshotDigest / schemaVersion | **必须**经 DomainFactSnapshotSource 关联 SourceTransaction（禁止无来源事实） |
| DomainFactSnapshotSource | Structured Fact → SourceTransaction 溯源 | 强外键 + tenant 一致 | 保证 canonical 链闭合 |
| DocumentExtraction | 文档 AI 抽取结果（7501 / C88 / 中国报关单 / invoice / POD / OTHER） | status ∈ PENDING/PROCESSING/EXTRACTED/NEEDS_REVIEW/FAILED；payloadDigest；reviewRequired | 输出只能进 SourceTransaction / DomainFactSnapshot，**禁止** PDF→LLM→Claim |
| AsyncJob | PostgreSQL 原生作业队列（FOR UPDATE SKIP LOCKED） | idempotencyKey / attemptCount / maxAttempts / backoff(nextRunAt) / dead-letter / tenant scope | 与 Outbox 配套；一期不引入 Redis/Temporal/Celery |
| OutboxEvent | 事务性发件箱（DB commit 与事件同事务） | 事件与业务写同事务；禁止 memory callback / Redis publish 作为唯一证据 | 驱动 canonicalize → evaluate → opportunity 链 |

## 3. 依赖与顺序

1. Schema Delta 提案（8 模型 + 索引 + RLS/租户触发器对齐既有 tenant 触发器清单）→ 架构方审核。
2. SecretVault 抽象（`services/secrets/secret-vault.ts` + adapters）——**凭据永不入 PostgreSQL**；DB 只留 credentialRef。
3. ProviderAdapter registry（`apps/api/src/integrations/{core,providers}`）在既有 connect/carriers 契约之上做编排，不复制事实。
4. AsyncJob + Outbox 接入既有 canonical/rule 链（不改规则语义）。

## 4. 非目标

不引入 Python/FastAPI/Pydantic/Celery；不引入 Redis/Temporal（一期）；不新增与 PlatformAccount / SourceConnection / Claim / Settlement 平行的第二事实源；不改动既有 API contract。

## 5. 验收（实施批次）

prisma validate PASS；migration 与既有 tenant/append-only 触发器清单一致；tsc api/web 0；targeted + 全量 DB 测试 PASS；CI 5 jobs 全绿；不变量（tenant isolation / account provenance / evidence lineage / idempotency / masking / audit / Action Guard / HITL / settlement·payout truth / fee·billing 分离）全部保持。

## 6. 待架构方裁决点

① 8 模型 Schema Delta 是否放行（含 DomainFactSnapshot 与 CanonicalFact 的边界）；② SecretVault 适配器选型（一期抽象 + 测试实现，生产实现属 HOST）；③ AsyncJob/Outbox 的并发与幂等验收口径；④ B2 实施批次排期（在 Queue #6/#7 之后）。
