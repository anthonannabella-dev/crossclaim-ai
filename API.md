# API 参考（内部）

**状态：部分完成（NOT COMPLETE）** —— 覆盖 Gate 6 / C-0008-B1 为止已实现的端点。
C-0008-B2（Case / Evidence / Claim Draft / Billing）的端点尚未实现。

> **边界**：`apps/api` 目前**只在本机/内部使用**（未做公网部署、未做生产加固）。
> 认证：邀请制 Email/密码为默认路径；自助注册 `POST /auth/signup` 存在但由 `PUBLIC_SIGNUP_ENABLED` 控制（默认关闭），注册后需完成邮箱验证才能登录（`EMAIL_NOT_VERIFIED`）。任何端点都不接受第三方平台凭据明文。

---

## 通用约定

- 传输：`Content-Type: application/json; charset=utf-8`（上传端点除外）
- 会话 Cookie：`cc_session`（`HttpOnly; SameSite=Lax; Path=/; Max-Age=43200`）
- 会话校验为**三步**：`tokenHash → Session → Membership(organizationId, userId, isActive)`，缺任一步即 401
- 会话时效：绝对 12 小时 + 空闲 30 分钟；`lastSeenAt` 按 5 分钟节流写入
- 登录失败：同一账号连续 5 次失败锁 15 分钟（`ACCOUNT_LOCKED`）
- 所有租户数据查询/写入都带 `organizationId`；跨租户一律按「不存在」处理
- 每个请求在响应结束时写一条结构化 `http_request` 日志（`method / path / status / ms`）；`/files/<token>` 的路径在日志中脱敏为 `/files/[REDACTED]`

---

## 运行与健康

| 方法 | 路径 | 说明 | 成功 |
|---|---|---|---|
| GET | `/health` | 健康检查（含数据库探测） | 200；依赖不可用时 503 `degraded` |
| GET | `/healthz` | 同上（探针兼容命名） | 同上 |
| GET | `/readyz` | Readiness（P2-1）：DB 可用 + migration 完整 + resolver 可解析。只返回 `{ ready, reasons, checkedAt, version }`；`reasons` 为原因码 `DATABASE_UNAVAILABLE` / `MIGRATION_MISMATCH` / `KILL_SWITCH_RESOLVER_FAIL_CLOSED`，**不含** SQL 错误/连接串/堆栈/secret。ready=false → 503（部署层据此摘流）；与 `/health`（liveness）语义分离 | 200 `{ ready: true, reasons: [] }`；不满足 → 503 |
| GET | `/metrics` | Prometheus 文本指标（进程内计数） | 200 `text/plain`；`METRICS_ENABLED!=true` 时 404 |

## 文件下载

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/files/<token>` | 用签名令牌下载文件（令牌内含租户与 FileAsset 绑定；每次下载写 `file.downloaded` 审计） |

- 400 `malformed_token`：令牌百分号编码非法
- 403 `invalid_or_expired_token`：令牌无效 / 过期 / 越权（统一回复，避免探测）
- 503 `audit_unavailable`：下载审计写库失败 —— 先拒发文件（fail closed）
- 503 `file_download_unavailable`：本进程未装配 storage（fail closed）
- 成功响应带 `content-disposition`（`filename*` RFC 5987）与 `x-content-type-options: nosniff`

## 认证

| 方法 | 路径 | 请求体 | 成功 | 失败 |
|---|---|---|---|---|
| POST | `/auth/login` | `{ email, password, organizationId? }` | 200 `{ userId, organizationId, role }` + `Set-Cookie` | 401 `INVALID_CREDENTIALS`（统一文案，不区分账号是否存在）；403 `ACCOUNT_LOCKED` / `ACCOUNT_DISABLED` |
| POST | `/auth/logout` | — | 204 + 清除 Cookie（写 `auth.session_revoked`） | — |
| GET | `/auth/me` | — | 200 `{ userId, organizationId, role }` | 401 `UNAUTHENTICATED` |
| POST | `/auth/verify-email` | `{ token }` | 200 `{ verified: true }`（原子消费：consume + `emailVerified=true`，**不改** `passwordChangedAt`；写 `user.email_verified`） | 400 `INVALID` / `ALREADY_CONSUMED` / `SUPERSEDED`；410 `EXPIRED`；503 `EMAIL_LIFECYCLE_UNAVAILABLE` |
| POST | `/auth/resend-verification` | `{ email }` | 202 `{ accepted: true }`（重发会 supersede 该用户既有未消费 token） | 503 `EMAIL_LIFECYCLE_UNAVAILABLE` |
| POST | `/auth/forgot-password` | `{ email }` | 202 `{ accepted: true }`（**统一口径**：不暴露邮箱是否存在 / 是否已停用） | 503 `EMAIL_LIFECYCLE_UNAVAILABLE` |
| POST | `/auth/reset-password` | `{ token, password }` | 200 `{ reset: true, revokedSessions }`（原子：consume + 新 hash + `passwordChangedAt` + 撤销全部 session；写 `user.password_reset_completed`） | 400 `INVALID` / `ALREADY_CONSUMED` / `SUPERSEDED` / `PASSWORD_POLICY`；410 `EXPIRED`；503 `EMAIL_LIFECYCLE_UNAVAILABLE` |
| POST | `/auth/signup` | `{ email, password, organizationName, displayName? }` | 201 `{ userId, organizationId, role, emailVerified, sessionIssued, nextStep }`（**不发放 session**；`emailVerified=false`，nextStep=`EMAIL_VERIFICATION_REQUIRED`） | 403 `SIGNUP_DISABLED`（PC-01A feature gate 默认关闭）；409 `EMAIL_ALREADY_REGISTERED`；400 `INVALID_EMAIL` / `INVALID_INPUT` / `ORGANIZATION_NAME_REQUIRED` |

其他方法：405 `METHOD_NOT_ALLOWED`。

## 采集与导入

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/uploads` | 上传 CSV：字节级内容扫描 → 存储（sha256 去重）→ 导入流水线 → ImportBatch / SourceTransaction / CanonicalFact |

请求头：`content-type: text/csv`（或等价）、`x-file-name: <name>`。

成功响应：

```json
{
  "status": "IMPORTED",
  "fileAssetId": "…",
  "scan": { "status": "PASSED", "detectedMime": "text/csv", "sha256": "…", "sizeBytes": 123 },
  "import": { "batchId": "…", "status": "IMPORTED", "rowsOk": 1, "rowsFailed": 0, "duplicates": 0 }
}
```

- 200：内容与既有 FileAsset 完全一致（`status: "DUPLICATE"`，不重复导入）
- 201：新文件已导入
- 400 `MISSING_FILE_NAME`、401 `UNAUTHENTICATED`、405 `METHOD_NOT_ALLOWED`
- 413：超过 25 MiB 上限
- 422：内容扫描拒绝（可执行文件、压缩包、PDF、图片、NUL 字节、MIME 伪造等）

上传时若该组织还没有 `FILE_UPLOAD` 连接，会通过 Gate 5 的生命周期服务创建一条默认连接（写审计）。

## 只读数据（Web 工作台）

| 方法 | 路径 | 成功 |
|---|---|---|
| GET | `/imports` | 200 `{ items: [{ id, status, rowsTotal, rowsOk, rowsFailed, startedAt, finishedAt, fileAssetId, connectionId }] }` |
| GET | `/imports/:id/error-report` | 200 `{ batchId, status, rowsTotal, rowsOk, rowsFailed, failureStage, issues: [{ rowNumber, errorCode, errorCategory, field, action }], issuesTruncated, duplicates, emptyRowsSkipped }`（**只回错误码/行号/动作，不回原始值、PII、原始文件内容**；MSG-20260929-10 Q1） |
| GET | `/opportunities` | 200 `{ items: [{ id, status, opportunityType, title, amountExpected, amountActual, recoverableAmount, currency, detectedAt }] }`（金额为 4 位小数字符串） |
| GET | `/recovery-states` | — | 200 `{ items: [{ scope, refId, title, code, label, explanation, nextAction, recoverable, safeSummary, occurredAt, details, retry }], catalog }`（PC-04 客户可见失败/恢复投影；稳定 code；不含 raw internal error / secret） | 401 `UNAUTHENTICATED`；403 `FORBIDDEN`（FINANCE / VIEWER） |
| GET | `/recovery-money` | query：`caseId`（可选） | 200 `{ organization: { byCurrency, collection, payment }, cases, feeNote }`（PC-05 客户可见追回金额只读投影；按币种分组、无 FX、EXPECTED≠RECEIVED、fee calculated≠collected、collection=NOT_ENABLED） | 401 `UNAUTHENTICATED`；403 `FORBIDDEN`（VIEWER；FINANCE 可见账单金额）；404 `NOT_FOUND`（caseId 跨租户 / 不存在） |
| GET | `/accounts` | — | 200 `{ organizationId, platforms: [{ platform, accounts: [{ id, platform, externalAccountId, displayName, identityVersion, status, createdAt, connections, activeConnectionCount }] }], unboundLegacyConnections, onboarding, legend }`（PC-06 账户管理只读投影；PlatformAccount 与 SourceConnection 分层；多平台多账户分组；不含 credentialRef / token / config） | 401 `UNAUTHENTICATED`；403 `FORBIDDEN`（非 OWNER / ADMIN） |
| GET | `/entitlements` | — | 200 `{ plan, planKnown, entitlements: [{ key, allowed, limit, used, remaining, usageState, reason, source, available, upgradeRequired, paymentRequired, entry }], packageUnlock, upgrade }`（PC-07 客户权益 / 套餐解锁只读投影；未知 plan → 全部 DENIED；`paymentRequired` ≠ 可付款；升级 available=false + `PAYMENT_NOT_ENABLED`） | 401 `UNAUTHENTICATED`；403 `FORBIDDEN`（VIEWER） |
| GET | `/health/live` | — | 200 `{ status: 'ok', kind: 'liveness', checkedAt }`（liveness：只证明进程存活，不依赖任何下游） | — |
| GET | `/health/ready` | — | 200 `{ kind: 'readiness', status, checks, killSwitchResolver, ... }`（readiness：数据库连通性等下游检查） | 503 `degraded`（依赖不可用，便于负载均衡摘除） |
| GET | `/ops-readiness` | — | 200 `{ liveness, readiness, killSwitch, actionGuard, failedJobs, rateLimit, transport, runbookRef, checkedAt }`（PC-08 只读运维就绪视图；`transport` 恒为 `DISABLED`；不含 secret） | 401 `UNAUTHENTICATED`；403 `FORBIDDEN`（非 OWNER / ADMIN）；503 `ops_unavailable` |
| GET | `/commercial/policies` | 是 | 200 `{ items: [...] }`（CURRENT 商业/法律文档；`?includeSuperseded=true` 含历史版本） | 401 `UNAUTHENTICATED` |
| GET | `/commercial/policies/:key` | 是 | 200 `{ document, versions }`（`?version=` 可寻址 superseded 历史版本） | 401 `UNAUTHENTICATED`；404 `POLICY_NOT_FOUND`（未知 key/version fail-closed） |
| POST | `/commercial/policies/:key/accept` | 是 | 201/200 `{ created, document, acceptance }`（显式接受事实，append-only；重复接受幂等） | 400 `EXPLICIT_ACCEPTANCE_REQUIRED`（禁止隐式接受）；404 `POLICY_NOT_FOUND`；409 `POLICY_VERSION_NOT_ACCEPTABLE` |
| GET | `/commercial/acceptances` | 是 | 200 `{ items: [...] }`（当前 actor 的接受事实；跨租户不可见） | 401 `UNAUTHENTICATED` |
| GET | `/commercial-readiness` | 是 | 200 `{ policies, acceptance, disclosures, feeCollection, integrations, transport, checkedAt }`（payment=ZERO / collection=OFF / activation=HOLD / integrations=EXTERNAL_GATE / transport=DISABLED） | 401 `UNAUTHENTICATED` |
| GET | `/provider-readiness` | 是 | 200 `{ providers: [{ provider, authKind, contractReady, productionCredentials: ABSENT, readiness: EXTERNAL_GATE, reason, requiredHostActions, platformWriteEnabled: false, callbackPath }], carriers: [{ provider, authKind, authFlows, selectedAuthFlow, authFlowSelectionReason, accountIdentityStrategy, authContractReady, accountDiscoveryContractReady, authImplemented: false, accountDiscoveryImplemented: false, identityVerificationRequired: true, productionCredentials: ABSENT, productionApprovalState: NOT_REQUESTED, sandboxState: AVAILABLE, platformWriteEnabled: false, transportEnabled: false, requiredHostActions }]（CARRIER QUEUE #3 / #3 FINAL：UPS = selectedAuthFlow AUTHORIZATION_CODE + identityStrategy PROVIDER_DISCOVERY；FedEx = INTEGRATOR_CREDENTIAL_REGISTRATION + PROVIDER_VERIFIED_REGISTRATION；无泛化 CARRIER_READY）, checkedAt }`（合同就绪 ≠ 生产可用） | 401 `UNAUTHENTICATED` |
| GET | `/payment-activation-readiness` | 是（OWNER / ADMIN） | 200 `{ ready, posture, internalReady, gates, status, checks, blockers, feeDueVsCollected, reversalPolicy, checkedAt }`（PC-12A：payment=ZERO / collection=OFF / autopay=OFF / externalWrite=OFF / r13=HOLD；多 gate 独立，单一 env flag 不解锁） | 401 `UNAUTHENTICATED`；403 `FORBIDDEN` |

三者都按会话 `organizationId` 过滤，最多 100 条（默认 20）。非 GET 请求不匹配该处理器，按 404 处理。

失败明细端点（架构方 MSG-20260929-10 Q1）只允许返回 `rowNumber / errorCode / errorCategory / field / action`：不回 `message` 自由文本、不回批次 `provenance`（平台名 / 游标 / 平台原始载荷）、不回任何原始业务值；跨租户或不存在的批次一律 404（不区分「不存在」与「无权」）。

## 机会人工复核（C-0008-B1）

| 方法 | 路径 | 请求体 | 成功 |
|---|---|---|---|
| POST | `/opportunities/:id/qualify` | — | 200 `{ opportunityId, from: "DETECTED", to: "QUALIFIED", reason: null }` |
| GET | `/opportunities` | query：`status` / `domain` / `channel` / `accountId` / `detectedFrom` / `detectedTo` / `minRecoverable` / `limit`(1..100) / `cursor` | 200 `{ items, nextCursor, hasMore, appliedFilters, pageSize }`（只读客户可见机会列表；tenant-scoped；legacy NULL account 标记 `LEGACY_UNATTRIBUTED`，不推断） | 400 `INVALID_INPUT`（非法过滤值 / cursor / limit）；401 `UNAUTHENTICATED`；403 `FORBIDDEN`（FINANCE / VIEWER） |
| POST | `/opportunities/:id/reject` | `{ reason }` | 200 `{ opportunityId, from: "DETECTED", to: "REJECTED", reason }` |

- 仅允许 `DETECTED → QUALIFIED` / `DETECTED → REJECTED`；`DETECTED → CONVERTED` 只能由 Recovery Closure 建案流程触发
- 拒绝原因词表：`wrong_amount` / `duplicate` / `not_recoverable` / `other`
- 400 `REASON_REQUIRED`（缺原因，响应附 `allowedReasons`）、`INVALID_REASON`、`INVALID_BODY`
- 403 `FORBIDDEN`（角色无复核权限）、404 `NOT_FOUND`（不存在或跨租户）、409 `ILLEGAL_TRANSITION`
- 状态变化与 `AuditLog`（`actorType=USER` + `actorUserId`）在**同一事务**内写入

## 采集连接管理（C-0008-B1）

| 方法 | 路径 | 请求体 | 成功 | 权限 |
|---|---|---|---|---|
| GET | `/connections` | — | 200 `{ items: [...] }`（不含 `credentialRef` 取值，只给 `hasCredentialRef`） | OWNER / ADMIN |
| POST | `/connections` | `{ label, kind, domain, channel, platform?, credentialRef? }` | 201 `{ id, status }` | OWNER / ADMIN |
| POST | `/connections/:id/status` | `{ to, reason? }` | 200 `{ from, to }` | OWNER / ADMIN |
| POST | `/connections/:id/credential-ref` | `{ credentialRef \| null }` | 200 `{ hasCredentialRef, status }` | OWNER / ADMIN |

- `kind` 仅允许 `FILE_UPLOAD` / `API`；`domain ∈ {PLATFORM, LOGISTICS, CUSTOMS}`；`channel` 取 Channel 枚举
- `FILE_UPLOAD` 初始 `ACTIVE`；`API` 初始 `NEEDS_AUTH` 且必须给出 `credentialRef`（引用名）
- `credentialRef` **只接受引用名**：命中 `Bearer …` / `sk-…` / `ghp_…` / `AKIA…` 形态一律 400 `SECRET_NOT_ACCEPTED`；长度上限 128，禁止控制字符
- `API` 连接的 `platform` 必须是**已注册适配器**，否则 400 `PLATFORM_NOT_REGISTERED`（当前部署未注册任何适配器 ⇒ fail closed）
- 状态机沿用 Gate 5：`NEEDS_AUTH → ACTIVE`、`ACTIVE ⇄ PAUSED`、`ERROR → {ACTIVE, PAUSED, NEEDS_AUTH}`、任意 → `REVOKED`（终态）
- 409 `ILLEGAL_TRANSITION`（未定义或重复迁移）、`DUPLICATE_CONNECTION`（同渠道同名）
- 审计动作：`source_connection.created` / `source_connection.status_changed` / `source_connection.credential_rotated`（**绝不记录引用值本身**）

---

## 建案与商务确认（C-0008-B2-1）

| 方法 | 路径 | 请求体 | 成功 | 权限 |
|---|---|---|---|---|
| POST | `/opportunities/:id/case` | `{ commercialTerms? }` | 201 `{ caseId, caseNo, opportunityId, claimId, created, commercialTermsPending }` | OWNER / ADMIN / OPS（费率只能由 OWNER / ADMIN 随建案提交） |
| POST | `/cases/:caseId/commercial-terms` | `{ commercialTerms }` | 200 `{ caseId, caseNo, confirmed, alreadyConfirmed, commercialTermsPending }` | OWNER / ADMIN |

- 准入：机会必须为 `QUALIFIED` 或 `CONVERTED`（`DETECTED` → 409 `ILLEGAL_TRANSITION`）
- 建案复用 Gate 2 Recovery Closure，幂等：`caseNo = CASE-<opportunityId>`，重复调用返回 `created: false`
- OPS 建案时费率进入 **pending**（响应 `commercialTermsPending: true`），由 OWNER / ADMIN 事后确认；**不存在默认费率或推测费率**
- 审计：`case.created`（含 `commercialTermsPending`）与 `commercial_terms.created`（含 `successFeeRate`、`source`、`reConfirmed`），均带 `actorUserId`
- 当前仅支持 `domain=LOGISTICS / channel=OTHER`（Closure scope 未泛化，超出 → 409 `SCOPE_NOT_SUPPORTED`）

## 回收结果确认（C-0008-B2-3a）

| 方法 | 路径 | 请求体 | 成功 | 权限 |
|---|---|---|---|---|
| POST | `/cases/:caseId/recovery-outcome` | `{ recoveredAmount, currency, basisReference, evidenceArtifactId?, note? }` | 201（首次）/ 200（幂等复用）`{ settlementId, ledgerEntryId, feeCalculationId, billingInvoiceId, recoveredAmount, feeAmount, created, exceedsClaim }` | OWNER / ADMIN / FINANCE |

- 前置条件（**不会自动推进**）：`Case.status = WON`、第 1 轮 `Claim.status = APPROVED`、该案件已完成商务确认
- 拒绝：`recoveredAmount <= 0`、非十进制字符串、`currency` 与案件不一致（409 `CURRENCY_MISMATCH`）、空 `basisReference`、请求含 `simulateSettlement`
- 金额：全程 `Decimal`，4 位 HALF_UP；`recoveredAmount > claimedAmount` 不阻断，但写入 `recovery_amount_exceeds_claim` 警告审计
- 落地（同一事务）：Settlement(`RECEIVED`) → RecoveryLedgerEntry → FeeCalculation(`RECOVERED_AMOUNT_PCT`) → BillingInvoice(`DRAFT`)，一个案件最多一条 Settlement（幂等）
- 审计：`recovery_outcome.confirmed`（含 caseId / recoveredAmount / currency / basisReference / evidenceArtifactId）、`case.status_changed`（WON → SETTLED），均带 `actorUserId`
- Settlement（第三方赔付）与 BillingInvoice（向客户收费）是**两个不同主体**，不得合并

## 账单（服务费，C-0008-B2-3b）

| 方法 | 路径 | 请求体 | 成功 | 权限 |
|---|---|---|---|---|
| GET | `/billing` | — | 200 `{ items: [{ id, invoiceNo, status, caseNo, subtotal, total, paidAmount, currency, issuedAt, paidAt, reference, serviceFee }] }` | OWNER / ADMIN / OPS / FINANCE |
| POST | `/billing/:invoiceId/status` | `{ to, paymentReference?, note? }` | 200 `{ invoiceId, from, to, paymentReferenceProvided }` | OWNER / ADMIN / FINANCE |

- 状态机：**只允许 `DRAFT → ISSUED → PAID`**；`DRAFT → PAID` 直接跳转一律 409（即便带 note）
- 每次迁移都是 **CAS**（按当前状态条件更新，`count === 1`）；并发推进只有一个能成功，另一个 409
- `PAID` 必须提供 `paymentReference` 或 `note`，否则 400 `PAYMENT_REFERENCE_REQUIRED`
- 审计 `billing.status_changed`：记录 from/to、金额、货币、`paymentReferenceProvided` 与 note（截断）；**绝不写入支付流水原文**
- **主体边界**：BillingInvoice = 我方向客户收取的服务费；Settlement = 第三方（承运商/平台/保险）赔付给客户的回收款。两者是不同对象，UI 上必须分开，不得出现「追回金额已支付」这类混淆表述

## 案件 / 证据 / Claim 正文（C-0008-B2-2）

| 方法 | 路径 | 成功 | 权限 |
|---|---|---|---|
| GET | `/cases` | 200 `{ items: [{ id, caseNo, title, status, domain, currency, claimedAmount, recoveredAmount, createdAt, opportunityIds, claimRounds }] }` | OWNER / ADMIN / OPS |
| GET | `/cases/:caseId` | 200 案件详情（含关联机会与 Claim **元数据**：round / status / target / dueAt） | OWNER / ADMIN / OPS |
| GET | `/cases/:caseId/evidence` | 200 `{ items: [{ evidenceId, role, kind, title, description, reliability, capturedAt, addedAt, hasFile }] }` | OWNER / ADMIN / OPS |
| GET | `/cases/:caseId/claim` | 200 `{ id, caseId, round, version, status, generatedAt, isFinal, sections }` | **仅 OWNER / ADMIN / OPS** |
| GET | `/cases/<id>/claim-package` | — | 200 `{ case, account, package, why, evidence, missingItems, readiness, actions }`（PC-03 客户可见材料包只读投影；PACKAGE READY ≠ CLAIM ACTUALLY SUBMITTED，`providerWrite=HOLD_NEEDS_MANUAL`） | 401 `UNAUTHENTICATED`；403 `FORBIDDEN`（FINANCE / VIEWER，沿用证据权限）；404 `NOT_FOUND`（跨租户 / 不存在）；409 `CLAIM_PACKAGE_ACCOUNT_MISMATCH` |

- **Claim 正文只在此端点返回**；`/cases` 与 `/cases/:caseId` 一律不含正文（FINANCE / VIEWER 也因此看不到）
- FINANCE / VIEWER 访问案件与证据 → 403（财务事实请走 `/billing`）
- 正文响应不含任何内部 prompt / 模型信息 / 生成轨迹；存在最终文本时优先返回最终文本（`isFinal: true`）
- 证据只返回元数据：文件字节必须走既有签名 URL 通道（`/files/<token>`，租户绑定）
- 跨租户案件 → 404

## 处置洞察与导出（C-0009.1）

| 方法 | 路径 | 成功 | 权限 |
|---|---|---|---|
| GET | `/opportunities/insights` | 200 `{ items: [ 洞察对象 ] }` | OWNER / ADMIN / OPS |
| GET | `/opportunities/insights.csv` | 200 `text/csv`（固定 5 列：`opportunity_id, invoice_reference, recoverable_amount, rule_reason, evidence_reference`） | OWNER / ADMIN / OPS |
| GET | `/opportunities/:opportunityId/basis` | 200 单条洞察（含复算证据块与 `calculationTimestamp`） | OWNER / ADMIN / OPS |

- 掩码只是**展示字段**：同一响应同时返回原始值与 `*Masked` 版本，客户自有数据永不隐藏
- CSV 只含上述 5 列，不含凭据或内部信息；FINANCE / VIEWER → 403

## 高额回收人工卡口（C-0009.2）

| 方法 | 路径 | 请求 | 成功 | 权限 |
|---|---|---|---|---|
| GET | `/cases/:caseId/recovery-review` | — | 200 `{ caseId, state, threshold, lastEventAt, lastActorUserId }` | OWNER / ADMIN / OPS |
| POST | `/cases/:caseId/recovery-review` | `{ decision: 'REQUEST' \| 'APPROVE' \| 'REJECT', reason?, recoveredAmount?, currency? }` | 200 `{ caseId, state, decision }` | REQUEST：OWNER / ADMIN / FINANCE；APPROVE / REJECT：**仅 OWNER / ADMIN** |

- 阈值 `HITL_RECOVERY_THRESHOLD`（默认 `1000.0000`）：USD **严格大于**才卡口，非 USD 一律卡口
- 状态由审计推导（`recovery.review_required` / `approved` / `rejected`）；`approved` 必须晚于 `required`
- 未获批就确认回收结果 → **409 `REVIEW_REQUIRED`**，且零资金写入

## 申诉包交付物状态（C-0009.3）

| 方法 | 路径 | 成功 | 权限 |
|---|---|---|---|
| GET | `/cases/:caseId/appeal-package` | 200 `{ deliverable, customerDataAccess }` | OWNER / ADMIN / OPS |

- `deliverable.state = LOCKED`、`unlockAvailable: false`（解锁能力留待商业化 Gate 单独设计）
- `customerDataAccess` 的 `rawFiles` / `evidenceChain` / `auditTrail` 始终 `AVAILABLE`：**不得以支付绑定作为数据访问条件**

## 佣金对账（C-0009）

| 方法 | 路径 | 请求 | 成功 | 权限 |
|---|---|---|---|---|
| POST | `/commissions/reconcile` | `{ items: [{ payoutReference?, platformOrderId?, amount, currency, payoutDate? }], dryRun? }` | 200 `{ dryRun, results: [{ reconciliationStatus, billingStatus, matchType, matchedFields, confidenceReason, feeAmount }] }` | OWNER / ADMIN（FINANCE → 403） |

- `dryRun` 默认 `true`（零写入）；执行时只建 `FeeCalculation` + `BillingInvoice(DRAFT)`
- `Settlement` 状态不变，账单**永不**直接置 `PAID`；重复执行 → `ALREADY_CHARGED`
- 匹配只认 `payoutReference` / `platformOrderId`；**仅时间窗一律不匹配**
- `confidenceReason` 是规则理由，不是 AI 置信度

## 支付（C-0010-A）

| 方法 | 路径 | 请求 / 头 | 成功 | 权限 |
|---|---|---|---|---|
| GET | `/payments` | — | 200 `{ items: [{ id, invoiceId, invoiceNo, invoiceStatus, amount, currency, status, createdAt }] }` | OWNER / ADMIN / OPS / FINANCE（`viewBilling`） |
| POST | `/payments/webhook` | 原始 body + `Stripe-Signature: t=…,v1=…` | 200 `{ httpStatus, processingResult, reason, invoiceId? }`；验签失败 → 400 | 不走会话：验签即鉴权 |

- 开关 `PAYMENTS_ENABLED` 默认 `false`：关闭时**验签通过后**写 `IGNORED` 事件并返回 200（不返回 503，避免 provider 重试风暴）
- 幂等：`(provider, providerEventId)` 唯一；重复或并发重放 → `DUPLICATE` + 200
- 金额与币种必须与账单**完全相等**，否则不推进 PAID 并写 `payment.reconciliation_failed`
- 推进用 CAS：`UPDATE … WHERE id = ? AND organizationId = ? AND status = 'ISSUED'`
- 高额卡口 `PAYMENT_REVIEW_THRESHOLD`（默认 `1000.0000`）与 Recovery 卡口**完全独立**；动作域 `payment.review_*`，审批仅 OWNER / ADMIN，FINANCE 只读
- 只保存事件元数据（`eventId` / `eventType` / `payloadHash` / `receivedAt` / `processingResult`）：**不保存 payload 原文、卡数据或 provider 机密**
- 无法归属租户的事件不落库，只写结构化安全日志
- 事件容器的 `api_version` 期望值为 `2024-06-20`，但**不做硬闸**（fail-soft）：不匹配时写结构化告警
  `payment.provider_version_mismatch`（字段：`provider` / `providerEventId` / `expectedApiVersion` /
  `receivedApiVersion` / `action: CONTINUE`），仍按白名单字段解析；只有白名单字段缺失才 IGNORED / REJECTED

## 支付对账（C-0010-B）

| 方法 | 路径 | 成功 | 权限 |
|---|---|---|---|
| GET | `/payments/reconciliation` | 200 `{ generatedAt, scannedInvoices, items: [...], counts: {...} }` | OWNER / ADMIN / OPS / FINANCE（`viewBilling`） |
| GET | `/payments/reconciliation.csv` | 200 `text/csv`（固定 7 列：`invoiceId, paymentId, amount, currency, status, differenceType, recommendation`） | 同上 |

- **只读**：本模块零写入 —— 差异只出清单，由 OWNER / ADMIN 人工裁定；**不允许自动修账 / 自动冲正**
- 数据源：`Payment` × `BillingInvoice` × `AuditLog`（Payment HITL 事件）
- `status` 列形如 `ISSUED|SUCCEEDED`（发票状态|付款状态），发票没有付款行时为 `NO_PAYMENT`
- `differenceType` 取值：
  - `AMOUNT_MISMATCH`：成功付款金额 ≠ 发票 total
  - `CURRENCY_MISMATCH`：币种与发票不一致
  - `AWAITING_PAYMENT_REVIEW`：钱已到但被 Payment 人工卡口拦住（`payment.review_required` 未获批）
  - `PAYMENT_WITHOUT_PAID_INVOICE`：钱已到但发票未 PAID（含卡口被驳回的情况）
  - `PAID_WITHOUT_PAYMENT`：发票 PAID 但没有任何付款行（人工 / 银行到账需补录引用）
  - `PAID_AMOUNT_MISMATCH`：发票 `paidAmount` ≠ 成功付款合计
  - `FAILED_PAYMENT`：provider 报失败，仅留痕，不需要动作
- 判定顺序固定：金额 → 币种 → 卡口 → 未 PAID；金额不符时不再叠加其他类型
- 扫描范围为最近 200 张发票（上限 500）；**跨租户发票绝不出现**
- CSV 与 JSON 同源；导出不含凭据、签名与 provider 机密

## 支付执行与恢复（C-0010-B2）

| 方法 | 路径 | 请求 | 成功 | 权限 |
|---|---|---|---|---|
| POST | `/payments/events/:paymentEventId/replay` | `{ reason, note? }` | 200 `{ paymentEventId, attemptId, attemptNo, status, resultStatus }` | **仅 OWNER / ADMIN** |
| POST | `/payments/processing/retry-due` | `{ limit? }`（默认 20，上限 100） | 200 `{ scanned, retried: [...], deadLettered: [...] }` | **仅 OWNER / ADMIN** |

- `reason` 是白名单枚举：`DATABASE_TIMEOUT` / `CAS_CONFLICT` / `UNKNOWN_PROVIDER_RESPONSE` / `MANUAL_RECOVERY` / `OTHER`；缺失或非白名单 → 400，零写入
- 重放只能沿执行尝试记录下来的 `attempt.paymentId` 回到**同一条** Payment 事实重新推进账单；
  没有该上下文 → **409 `PAYMENT_CONTEXT_REQUIRED`**（绝不接受人工补金额 / 人工改归属）
- 执行尝试（`PaymentProcessingAttempt`）与入站事件（`PaymentEvent`）同为 append-only：同一事件同一时刻只允许一个进行中的尝试；
  一个 Payment 最多一个成功执行来源；成功之后不允许改绑（CAS 只收口 RUNNING）
- 自动重试**只限技术失败**（数据库瞬断 / 写冲突等），退避 1 / 5 / 15 分钟、上限 3 次；超限 → `DEAD_LETTER`，进入下方对账清单
- 业务结论（金额不符 / 币种不符 / 人工卡口未通过 / 非法状态）不自动重试，由人工裁定
- 首次把 paymentId 写到尝试上会写审计 `payment.processing_payment_linked`；人工重放写 `payment.processing_replayed`
  （含 `paymentEventId` / `oldAttemptNo` / `newAttemptNo` / `reason` / `actorUserId`）；审计**不含** payload、签名与密钥
- 无队列、无后台线程：`retry-due` 由宿主侧调度调用；第一版不引入任何调度依赖
- 恢复成功**额外**写审计 `payment.processing_recovered`（`paymentEventId` / `attemptId` / `paymentId` / `resultStatus` / `recovery: true`），
  与 webhook 的正常成功在审计上可区分
- 并发的执行冲突返回稳定错误码 **409 `ATTEMPT_ALREADY_RUNNING`**，不把数据库唯一约束错误暴露给调用方
- 成功（`SUCCEEDED`）的执行尝试**不可改写**：改绑 `paymentId`、改状态或换事件都会被数据库触发器拒绝；
  成功但 `paymentId` 为空会被 CHECK 约束拒绝

## 权限矩阵

见 [DOMAIN_MODEL.md](./DOMAIN_MODEL.md#角色与权限c-0008-b1架构方批准)。
实现唯一位置：`apps/api/src/services/workflow/permissions.ts`；未知角色 fail closed。

## 尚未实现 / 未启用（截至 C-0010-A）

已有端点（见上文各节）：机会复核、采集连接管理、建案与商务确认、回收结果确认与高额卡口、
处置洞察与导出、申诉包交付物状态、佣金对账、账单展示与推进、案件 / 证据 / Claim 正文、
支付只读视图与 webhook 接收器。

仍未启用：

- **真实支付**：`PAYMENTS_ENABLED` 默认 `false`；生产 webhook、Stripe 账号、域名与 TLS 属 C-0010-C / D，需宿主授权
- **自动提交 Claim / Appeal**：禁止（对外动作必须单独走 Gate）
- **多平台（Amazon SP-API / TikTok Shop / Walmart）与海关 / OCR 线**：HOLD

## 相关文档

- 架构契约：[ARCHITECTURE_CONTRACT.md](./ARCHITECTURE_CONTRACT.md)
- 领域模型与权限矩阵：[DOMAIN_MODEL.md](./DOMAIN_MODEL.md)
- Web 应用说明：[apps/web/README.md](./apps/web/README.md)
- 架构方裁决归档：[AI-ARCHITECT-INBOX.md](./AI-ARCHITECT-INBOX.md)

---

## 运营看板（Operations Dashboard，MSG-20260929-30）

| 方法 | 路径 | 成功 | 权限 |
|---|---|---|---|
| GET | `/operations/dashboard` | 200 租户汇总：`{ generatedAt, window, claimPipeline, recovery, lossPool, denied }`；`window` 默认 `7d`，允许 `1d/7d/14d/30d`，越界 400 `INVALID_WINDOW` | OWNER / ADMIN / OPS（FINANCE 仅回收金额区块；VIEWER 403） |
| GET | `/operations/claims` | 200 `{ items, nextCursor }`（游标分页，单页上限 100） | 需 `claimTrackingApprove` 或 `claimTrackingReceive` |
| GET | `/operations/recovery` | 200 `{ items, nextCursor }`（金额字段按 `viewBilling` + `recoveryPayoutRecord` 裁剪） | 需 `claimTrackingApprove` |

- **只读**：仅 GET；无写路径、不写 AuditLog、不触发任何自动动作
- **投影**：Claim 桶与 Recovery 指标都由既有事实实时计算；看板不是事实源，也不可写入
- **D1**：`awaiting_response` 只看 `respondedAt`（AuditLog 响应事件作交叉校验），与 `dueAt` 无关
- **金额裁剪先于聚合**：无权角色的响应中**不存在**金额键（不是 0），也无法用 total/count 反推
- 所有查询强制 `organizationId` 注入；租户 A 无法观测租户 B 的任何行

---

## Admin Console Phase 1（运营可观测层，MSG-20260929-34）

| 方法 | 路径 | 成功 | 权限 |
|---|---|---|---|
| GET | `/admin/tenant-overview` | 200 租户概览（成员/会话/连接状态计数/导入数/Claim 状态计数/Settlement 数/审计计数与最近活动）；**不含** token/secret/原始连接配置 | OWNER / ADMIN |
| GET | `/admin/audit` | 200 `{ items, nextCursor, window }`；列表**只返回元数据**（action/entityType/entityId/createdAt/actor/severity）；窗口默认 7 天、上限 30 天 | OWNER / ADMIN |
| GET | `/admin/audit/:id` | 200 审计详情（含已脱敏 `changes`）；跨租户 → 404 | OWNER / ADMIN |
| GET | `/admin/system-health` | 200 `{ status, checkedAt, checks }`；降级时**不返回** SQL 错误/连接串/堆栈 | OWNER / ADMIN / OPS |

- **只读**：仅 GET；无写路径、不写 AuditLog、无权限编辑/平台配置/API Key/资金操作
- **单租户视图**：强制 `organizationId`；`actorUserId` 过滤仅用于审计调查，且不得跨租户
- Phase 1 = A1 Tenant Overview + A3 Audit Explorer + A6 System Health；A4/A5/A2 属后续阶段

---

## Admin Console Phase 2 — Import / Validation Operations（MSG-20260929-36）

| 方法 | 路径 | 成功 | 权限 |
|---|---|---|---|
| GET | `/admin/imports` | 200 `{ items, nextCursor }`；每项含 `bucket`（固定映射）与 `flags`（异常角标） | OWNER / ADMIN / OPS |
| GET | `/admin/imports/quality-summary` | 200 `{ projection: true, generatedAt, buckets }`（**显式标注为投影**） | OWNER / ADMIN / OPS |
| GET | `/admin/imports/:batchId/errors` | 200 `{ batchId, items, truncated }`；**仅白名单字段** errorCode / rowNumber / field / sourceColumnName / action | OWNER / ADMIN / OPS |
| GET | `/admin/imports/:batchId` | 200 批次详情（状态桶 + 角标 + 时间线 + 错误条数）；跨租户 → 404 | OWNER / ADMIN / OPS |

- **只读**：仅 GET；不修改 Import、不重跑导入、不删除文件、不修复数据、不手工改状态
- **无下载**：不提供原始文件 / 错误 CSV / 数据导出（未来如需另开 EXPORT-DESIGN）
- **无样本**：L3 不返回原始行内容或脱敏样本（未来如需另开 ADMIN-IMPORT-SAMPLE-VIEW-DESIGN）
- **无金额**：Admin 一律不展示金额 / 币种 / 单价 / 订单价值
- 状态桶为 `ImportBatch.status` 的**固定映射**（in_progress / succeeded / retried_success / partial / failed）；不新增工作流状态，运营补充信息用角标表达（QUALITY_WARNING / RETRIED / UNKNOWN_STATUS）

---

## Admin Console Phase 3 — Recovery Review Queue（MSG-20260929-37）

| 方法 | 路径 | 成功 | 权限 |
|---|---|---|---|
| GET | `/admin/recovery-review` | 200 `{ items, nextCursor }`；每项含 `bucket`（pending_review / approved / rejected，来自既有审核记录）与 `flags`（HIGH_VALUE_REVIEW_REQUIRED / AGED / MISSING_EVIDENCE_REF） | OWNER / ADMIN |
| GET | `/admin/recovery-review/:caseId` | 200 单项只读视图（含证据元数据引用与 `reviewPath` 深链）；跨租户或无审核记录 → 404 | OWNER / ADMIN |

- **Admin 看见流程，但不拥有流程**：不提供 approve / reject / 状态变更端点；审批仍由既有 `/cases/:caseId/recovery-review` 流程承担（其权限与审计不变）
- **角标是 projection flag**，不是状态；`AGED` 阈值固定为代码常量 7 天（不可由 Admin 配置）
- **证据仅元数据**：evidenceId / kind / role / capturedAt；不含文件名、storageKey、URL 或原文
- **不展示任何金额**（含阈值金额）；仅显示 `HIGH_VALUE_REVIEW_REQUIRED` 这类事实标签
- 仅 GET；无写路径、不写 AuditLog、无新表

---

## Admin Console Phase 4 — User / Membership View（MSG-20260929-39）

| 方法 | 路径 | 成功 | 权限 |
|---|---|---|---|
| GET | `/admin/members` | 200 `{ items, nextCursor }`；每项含 `emailMasked`（**默认掩码**）、role、isActive、status、`locked`（仅布尔）、lastLoginAt | OWNER / ADMIN |
| GET | `/admin/members/:userId` | 200 成员详情：会话**仅计数**（total/active/expired）+ 邀请（status/expiresAt/attemptCount）；跨租户 → 404 | OWNER / ADMIN |
| GET | `/admin/permission-matrix` | 200 `{ readonly: true, roles, permissions, matrix }`（只读展示，来源代码常量） | OWNER / ADMIN |
| GET | `/admin/kill-switch` | 200 `{ visibility, switches }`（只读**生效值投影**；OWNER/ADMIN 全量（含 `controlState` / `pendingRequest` / `lastRequest` / `degraded` / `stale` / `evaluatedAt`）、OPS 仅 `scope`/`value`/`source`、FINANCE/VIEWER 403）。`source` 为六值枚举：`global-hard-disabled` / `tenant-control` / `tenant-config` / `global-config` / `environment-default` / `fail-closed`（**破坏性变更**：旧值为 `tenant`/`global`/`default`；生效值 = Config Layer 与 Control Plane 的只读合成，绝不落库） | OWNER / ADMIN / OPS（摘要） |
| POST | `/admin/kill-switch` | 200 `{ status: applied\|awaiting_confirmation, scope, value, requestId, state, replayed, confirmationBy?, expiresAt? }`；body `{ scope, target: enabled\|disabled, phase: request\|confirm, reasonCode, note?, requestId?, idempotencyKey }`。CSRF 同源（Origin/Referer ↔ Host）+ `x-crossclaim-csrf: 1`；幂等按 `(organizationId, idempotencyKey)`（重放不写第二条审计）；`request+disabled` = OWNER 单人即时；`request+enabled` = 15 分钟待确认；`confirm+enabled` = 另一 OWNER/ADMIN 确认（禁止同人闭环）；`SECURITY_INCIDENT` 免限流但审计 `emergency=true`。400 非法组合/字段、403 CSRF 或权限、404 requestId 不存在、405 非 GET/POST、409 冲突或过期、429 限流 | OWNER（发起）/ OWNER, ADMIN（确认） |

- **无写路径**：不存在 invite / updateRole / deactivate / delete / revokeSession / resetPassword 端点
- **邮箱默认掩码**（如 `a***@example.com`）；不返回完整邮箱，也不提供解掩码入口
- 仅 `locked` 布尔；不返回失败次数、锁定时间或解锁入口；邀请不返回 tokenHash 与邀请链接
- 仅 GET；无写路径、不写 AuditLog、无新表、无导出

## Carrier 人工提交记录（CARRIER QUEUE #9B FINAL / MSG-20261003-119）

| 方法 | 路径 | 请求体 | 成功 | 权限 |
|---|---|---|---|---|
| POST | `/carrier-claim-packages/:packageId/manual-submission` | `{ carrierReference?, reportedCarrierSubmissionAt?, note? }` | 201（首次）/ 200（幂等复用）`{ status, submissionRecord }` | OWNER / ADMIN / OPS |

- 语义：**human attestation**（用户自称已完成人工提交），**不提交 carrier claim**；`carrierConfirmationStatus` 恒为 `NOT_VERIFIED`；不产生 providerAccepted / claimApproved / refundApproved。
- Action Guard：动作 `carrier.manual_submission.record`（`INTERNAL_WRITE` + `workflow` kill switch）；未注入 Action Guard → fail closed。
- 身份、租户与 package 事实一律服务端派生（`organizationId` / `actorUserId` / `role` / provider / account / tracking 均不由 client 提供）；client 只能提交上述三个业务字段。
- 状态映射：400 `INVALID_REQUEST`；403 `CAPABILITY_REQUIRED`；404 `PACKAGE_NOT_FOUND` 或 `TENANT_MISMATCH`（沿用 anti-enumeration 约定，不区分存在性）；409 `PACKAGE_NOT_READY`（NEEDS_REVIEW 包不得记录）；201 `RECORDED`；200 `ALREADY_RECORDED`（幂等重放不得视为错误）。
- 存储：`CarrierManualSubmission` 表 `UNIQUE(organizationId, packageId)` 幂等；append-only（创建后不可 UPDATE/DELETE）；business audit `carrier.manual_submission_recorded` 与记录同事务写入。
- 边界：不改动 recovered cash truth（RecoveryPayout / actualRecovered / Settlement）、不产生 successFee、不访问 carrier portal / API、`TRANSPORT=false`。

## Carrier response（CARRIER QUEUE #10 FINAL / MSG-20261003-122）

| 方法 | 路径 | 请求体 | 成功 | 权限 |
|---|---|---|---|---|
| POST | `/carrier-claim-packages/:packageId/responses` | `{ status, providerReference?, observedAt?, note? }` | 201（首次）/ 200（幂等重放）`{ status, responseFact }` | OWNER / ADMIN / OPS |
| GET | `/carrier-claim-packages/:packageId/responses` | — | 200 `{ responses: { currentStatus, currentVerificationLevel, history, provenance, timestamps } }` | 任意已认证成员（tenant-scoped） |

- 语义：**carrier claim 后续响应事实**（status 与 provenance 分离）；人工补录入口**只允许** `source = USER_REPORTED`（恒 `verificationLevel = UNVERIFIED`）——client body 出现 `source` / `verificationLevel` / 身份字段一律 400，provider 验证必须走独立可信 ingest 路径（真实 provider 集成 = `HOLD_EXTERNAL`）。
- Action Guard：动作 `carrier.claim_response.record`（`INTERNAL_WRITE` + `workflow` kill switch）；未注入 Action Guard → fail closed；不启用 `TRANSPORT`。
- 身份与 submission truth 一律服务端派生（`organizationId` / `actorUserId` / `role` / provider / account / tracking 不由 client 提供）；`(:packageId)` 来自 route param，submission truth 由 `CarrierManualSubmission` 按 `(organizationId, packageId)` 读取，不存在 → 404（anti-enumeration）。
- 状态映射：400 `INVALID_REQUEST` / `PROVIDER_REFERENCE_REQUIRED` / `INVALID_TIMESTAMP` / `FUTURE_TIMESTAMP`；403 `CAPABILITY_REQUIRED`；404 `SUBMISSION_NOT_FOUND`；201 `RECORDED`；200 `ALREADY_RECORDED`。
- 存储：`CarrierClaimResponseFact` append-only（UPDATE / DELETE 由 DB 触发器拒绝）+ `UNIQUE(organizationId, packageId, idempotencyKey)` 幂等 + DB CHECK 真值（未知枚举拒绝；`USER_REPORTED` → `UNVERIFIED`；provider 来源必须带 provider reference）；business audit `carrier.claim_response_recorded` 与事实同事务、恰好一次。
- 边界：`APPROVED != PAID != recovered cash`（PAID 事实不写 RecoveryPayout / actualRecovered / FeeCalculation）、不产生 successFee、不发起 payment collection、不调用 carrier API / portal、`TRANSPORT=false`、无生产凭据。

## Customs 内部追回准备（C21 / MSG-20261003-124 ⑭–㉑）

| 方法 | 路径 | 请求体 | 成功 | 权限 |
|---|---|---|---|---|
| POST | `/customs-opportunities/:id/start-recovery` | `{}`（仅必要确认字段；领域字段一律 400） | 200 `{ recoveryStatus: READY_TO_FILE, filingSubmitted: false, externalExecutionStatus: NOT_STARTED, submissionSnapshot }` | OWNER / ADMIN / OPS |
| GET | `/customs-opportunities/:id/filing-status` | — | 200 `{ filingStatus: { currentStatus, currentSourceLevel, history, factCount } }` | 任意已认证成员（tenant-scoped） |
| GET | `/platform-accounts/:platformAccountId/qualification` | — | 200 `{ qualification: { platformAccountId, status, reasonCodes, policyId, policyVersion, algorithmVersion, currency, estimatedRecoveryAmount, estimatedExternalApiCost, estimatedBrokerCost, expectedNetRecovery, costRatio, inputDigest, resultDigest, computedAt }, boundary: { readOnly: true, recomputedOnRead: false, filingAuthorized: false, transportEnabled: false, externalWritePerformed: false, productionCredentials: ABSENT } }` / 403（VIEWER·未知角色）/ 404（无判定或跨租户） | OWNER / ADMIN / OPS / FINANCE（tenant-scoped，只读，不重算） |
| GET | `/independent-site-disputes/:disputeReference/state` | — | 200 `{ dispute, states: { submitted, won, settled, recovered, billable }, response, settlement, amounts: { recoveredAmount, feeAmount, currency }, invoiceDraft, notPersisted: [QUALIFICATION, EVIDENCE_PACKAGE, CLAIM_READY_PACKAGE], boundary: { readOnly: true, recomputedOnRead: false, externalWritePerformed: false, filingSubmitted: false, transportEnabled: false, paymentCollected: false, productionCredentials: ABSENT } }` / 403（VIEWER·未知角色）/ 404（无 handoff root 或跨租户） | OWNER / ADMIN / OPS / FINANCE（tenant-scoped，只读，不重算） |
| GET | `/customs-entry-facts/:entryFactId` | — | 200 `{ entryFact: { id, entryNumber, entryDate, jurisdiction, source, contentDigest, lineCount, totalDutyAmountByCurrency }, projections: { DUTY_TRUTH, DISCREPANCY, ELIGIBILITY, ESTIMATE }, boundary: { readOnly: true, filingSubmitted: false, transportEnabled: false, externalWritePerformed: false, productionCredentials: ABSENT } }` / 403（VIEWER·未知角色）/ 404（事实不存在或跨租户） | OWNER / ADMIN / OPS / FINANCE（tenant-scoped，只读，不重算） |
| GET | `/customs-entry-facts/:entryFactId/return-claim-evidence` | — | 200 `{ evidence: { evidenceId, status, statusReasons, confirmedRecoverableAmountByCurrency, eligibleQuantityByLine, qualificationStatus, policyId, policyVersion, algorithmVersion, computedAt, payload }, boundary: { readOnly: true, recomputedOnRead: false, frontendMayRecalculate: false, filingSubmitted: false, transportEnabled: false } }` / 404（无已裁决证据） | OWNER / ADMIN / OPS / FINANCE（tenant-scoped，只读） |
| POST | `/customs-entry-facts/:entryFactId/recovery-chain` | `{}`（全部输入 server-side 派生） | 200 `{ action: customs.recovery.chain.run, executionKey, package: { packageId, readiness, gaps, estimateOnly, billable, filingSubmitted: false, submissionPerformed: false }, projections, boundary: { filingSubmitted: false, externalWritePerformed: false, transportEnabled: false, productionCredentials: ABSENT, filingAuthorized: false } }` / 403（FINANCE·VIEWER）/ 404 / 409 | OWNER / ADMIN / OPS（INTERNAL_WRITE，tenant-scoped） |

- 语义：该端点**只做内部准备**（server-side validation / qualification / 授权就绪 / filing route 决策 / immutable snapshot / 内部工作流状态）；**不调用 C18 provider、不执行 filing**：`filingSubmitted=false`、`externalWritePerformed=false`、`transportEnabled=false`、`externalExecutionStatus=NOT_STARTED`。
- Action Guard：动作 `customs.recovery.start`（`INTERNAL_WRITE` + `workflow` kill switch）；未注入 Action Guard → fail closed；不启用 `TRANSPORT`。
- client 不得提供 `recoverableAmount` / `classification` / `eligibility` / `ruleVersion` / `ior` / `claimant` / `broker` / `packageDigest` / `feeRate` / `filingRoute` / `deadline` / 身份字段（出现即 400 `INVALID_REQUEST`）。
- 状态映射：400 `INVALID_REQUEST`；403 `CAPABILITY_REQUIRED`；404 `OPPORTUNITY_NOT_FOUND`（anti-enumeration）；409 `ENTRY_FACT_MISSING` / `EVIDENCE_INCOMPLETE` / `NOT_ELIGIBLE` / `AMOUNT_NOT_READY` / `REMEDY_ROUTE_MISSING` / `DEADLINE_PASSED` / `PACKAGE_NOT_READY` / `AUTHORIZATION_NOT_READY` / `FILING_CAPABILITY_MISSING`。
- 读模型不含 credential / broker secret / authority token / raw PII；状态与来源等级分离（`USER_REPORTED` / `PROVIDER_VERIFIED` / `AUTHORITY_VERIFIED`），禁止 `submitted → accepted`、`APPROVED → PAID` 的隐含升级。
- 边界：真实 customs filing = `HOLD_EXTERNAL` / `HOST APPROVAL REQUIRED`；`Payment = 0` / `collection = OFF` / 无生产凭据。
