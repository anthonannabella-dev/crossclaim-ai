# API 参考（内部）

**状态：部分完成（NOT COMPLETE）** —— 覆盖 Gate 6 / C-0008-B1 为止已实现的端点。
C-0008-B2（Case / Evidence / Claim Draft / Billing）的端点尚未实现。

> **边界**：`apps/api` 目前**只在本机/内部使用**（未做公网部署、未做生产加固）。
> 认证是邀请制 Email/密码 + HttpOnly 会话 Cookie；没有任何端点接受第三方平台凭据明文。

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
| GET | `/opportunities` | 200 `{ items: [{ id, status, opportunityType, title, amountExpected, amountActual, recoverableAmount, currency, detectedAt }] }`（金额为 4 位小数字符串） |

两者都按会话 `organizationId` 过滤，最多 100 条（默认 20）。非 GET 请求不匹配该处理器，按 404 处理。

## 机会人工复核（C-0008-B1）

| 方法 | 路径 | 请求体 | 成功 |
|---|---|---|---|
| POST | `/opportunities/:id/qualify` | — | 200 `{ opportunityId, from: "DETECTED", to: "QUALIFIED", reason: null }` |
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

## 权限矩阵

见 [DOMAIN_MODEL.md](./DOMAIN_MODEL.md#角色与权限c-0008-b1架构方批准)。
实现唯一位置：`apps/api/src/services/workflow/permissions.ts`；未知角色 fail closed。

## 尚未实现（C-0008-B2）

Case 创建、Evidence 查看、Claim Draft 查看、Billing 展示与状态推进 —— 均未实现，也没有对应的 HTTP 端点。

## 相关文档

- 架构契约：[ARCHITECTURE_CONTRACT.md](./ARCHITECTURE_CONTRACT.md)
- 领域模型与权限矩阵：[DOMAIN_MODEL.md](./DOMAIN_MODEL.md)
- Web 应用说明：[apps/web/README.md](./apps/web/README.md)
- 架构方裁决归档：[AI-ARCHITECT-INBOX.md](./AI-ARCHITECT-INBOX.md)
