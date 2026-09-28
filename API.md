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
