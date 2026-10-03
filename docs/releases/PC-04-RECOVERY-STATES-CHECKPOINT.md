# PC-04 ERROR / RECOVERY STATES CHECKPOINT（customer-visible failure projection）

状态：**READY_FOR_REVIEW / IMPLEMENTATION CHECKPOINT**（待架构方裁决）
IMPLEMENTATION_HEAD = 6758e9b
IMPLEMENTATION_HEAD_FULL = 6758e9b38886b842182df161d621e0e7c9b620d9
CI = SUCCESS · RUN_ID = 37027265617 · CI_HEAD = 6758e9b
授权：MSG-20261003-84 ④⑤⑥（PC-04 ERROR / RECOVERY STATES）。
边界：NO platform write · Payment = 0 · autopay = OFF · collection = OFF · external payment write = OFF · R13 HOLD · TRANSPORT=false · 无生产凭据。

## 1. 范围逐项落地（MSG-84 ④ 1–8）

| 项 | 要求 | 实现 |
|---|---|---|
| 1 Unified customer error projection | 从既有事实聚合连接 / 导入 / claim·package 的失败状态；Payment 真实执行 HOLD 不处理 | `listRecoveryStates()`：SourceConnection（REVOKED / NEEDS_AUTH / ERROR + lastErrorAt / unbound legacy / PAUSED+bound）、ImportBatch（FAILED / PARTIAL + rowsTotal·rowsOk·rowsFailed）、ClaimItem（DISCOVERED / REVIEW_REQUIRED / READY_TO_APPEAL / closedReason=REJECTED） |
| 2 Stable customer recovery codes | 稳定 code + label / explanation / nextAction / recoverable；不得暴露 stack / SQL / provider raw error | `RECOVERY_CATALOG` 覆盖 RECONNECT_REQUIRED / REUPLOAD_REQUIRED / IMPORT_PARTIAL / RETRY_AVAILABLE / MANUAL_ACTION_REQUIRED / EVIDENCE_REQUIRED / APPEAL_REQUIRED / CONTACT_SUPPORT；每项含 label·explanation·nextAction·recoverable，并随响应返回 catalog |
| 3 Connection recovery states | NEEDS_AUTH → 重新授权；ERROR → 安全摘要；REVOKED → 重新连接；BOUND_INACTIVE → 尚未启用；UNBOUND legacy → 需要绑定账户；不实现真实 OAuth | 对应 code：NEEDS_AUTH→RECONNECT_REQUIRED；REVOKED→RECONNECT_REQUIRED；**platformAccountId=NULL（优先）→MANUAL_ACTION_REQUIRED**；PAUSED+bound→MANUAL_ACTION_REQUIRED；ERROR→`classifyConnectionError()`（auth→RECONNECT_REQUIRED / timeout·network·429·5xx→RETRY_AVAILABLE / 其他→CONTACT_SUPPORT） |
| 4 Import recovery states | FAILED → reupload·retry guidance；PARTIAL → 成功·失败计数 + 错误报告入口；不默认暴露 raw row error | FAILED→REUPLOAD_REQUIRED；PARTIAL→IMPORT_PARTIAL（details 含 rowsTotal·rowsOk·rowsFailed + `errorReportRef=/imports/:id/error-report`）；IMPORTED 不上报 |
| 5 Claim / package recovery states | 复用 PC-03 readiness，不引入新判定 | DISCOVERED→EVIDENCE_REQUIRED；REVIEW_REQUIRED→MANUAL_ACTION_REQUIRED；READY_TO_APPEAL 或 closedReason=REJECTED→APPEAL_REQUIRED |
| 6 Retry semantics | 只有存在安全 retry endpoint 才能 actionable=true；否则只给 guidance | 统一 `retry { available:false, actionable:false, reason:'NO_SAFE_RETRY_ENDPOINT' }`（当前无安全 retry endpoint）；验收逐项断言 `actionable=false` |
| 7 Error disclosure policy | 禁止 stack / SQL / Prisma error / credentialRef / token / secret / storageKey / internal audit payload / provider raw auth response | 只回传稳定 code + 安全摘要（不含 raw lastError 原文）；验收断言响应文本不含 `SQLSTATE` / 表名字面量 / partner 标识 / `credentialRef` / `passwordHash` / `storageKey` |
| 8 UI | 覆盖 connections / imports·upload / case·claim package；先加清晰状态块，不做 mega-dashboard | 新增 `RecoveryBanner`（服务端 capability 驱动；仅 `retry.actionable` 为 true 才渲染重试按钮）并接入 `/connections`（CONNECTION）、`/upload`（IMPORT）、`/cases/[id]/claim-package`（CASE） |

## 2. 交付物

| 文件 | 说明 |
|---|---|
| `apps/api/src/services/workflow/recovery-states.ts` | PC-04 只读失败/恢复投影 + 稳定 code 目录 + 错误分类 |
| `apps/api/src/services/workflow/http-routes.ts` | 新增 `GET /recovery-states`（method gate / known-path guard 登记） |
| `apps/api/src/server.ts` | `WORKFLOW_PATH` 放行 `/recovery-states` |
| `apps/api/src/__tests__/recovery-states-http-db.test.ts` | PC-04 HTTP + PostgreSQL 验收 6/6 |
| `apps/web/app/components/recovery-banner.tsx` | 客户可见恢复提示（稳定 code + 安全摘要 + 下一步；无假重试按钮） |
| `apps/web/app/connections/page.tsx` / `upload/page.tsx` / `cases/[id]/claim-package/page.tsx` | 接入状态块 |
| `API.md` | 新增 `GET /recovery-states` 契约行 |

## 3. 验证证据（对照 MSG-84 ⑤）

| # | 验收项 | 证据 |
|---|---|---|
| 1 | NEEDS_AUTH → RECONNECT_REQUIRED | 「connection：NEEDS_AUTH / ERROR / REVOKED / legacy unbound 的稳定 code 与安全摘要」 |
| 2 | connection ERROR → safe summary | 同上（ERROR 项只给安全摘要 + 稳定 code） |
| 3 | REVOKED → reconnect guidance | 同上 |
| 4 | legacy unbound → binding required | 同上（`platformAccountId=NULL` 优先判定为 MANUAL_ACTION_REQUIRED） |
| 5 | import FAILED → reupload·retry guidance | 「import：FAILED → REUPLOAD_REQUIRED；PARTIAL → IMPORT_PARTIAL」 |
| 6 | import PARTIAL → counts + safe error report link | 同上（details.rowsOk/rowsFailed + `/imports/:id/error-report`） |
| 7 | claim NEEDS_EVIDENCE reuse PC-03 state | 「claim / package：DISCOVERED → EVIDENCE_REQUIRED…」 |
| 8 | APPEAL_REQUIRED reuse existing state | 同上（READY_TO_APPEAL → APPEAL_REQUIRED） |
| 9 | no raw internal error leakage | 连接用例断言响应不含 `SQLSTATE` / 表名字面量 / partner 标识 |
| 10 | no credential·token·secret·storageKey | 同上逐项断言 |
| 11 | foreign tenant failure invisible | 「foreign tenant failure invisible」 |
| 12 | unauthorized → 401 | 「unauthorized → 401；FINANCE / VIEWER → 403」 |
| 13 | role boundary preserved | 同上（复用 reviewOpportunities 权限；FINANCE / VIEWER 403） |
| 14 | nonexistent retry endpoint never advertised as executable | 连接用例对全部 items 断言 `retry.actionable === false` 且 reason=`NO_SAFE_RETRY_ENDPOINT` |
| 15 | existing connection/import/claim regressions green | CI 全量（connection / import / claim 各套件） |
| 16 | tsc api·web 0 | 本地 `tsc --noEmit`（api / web）0 error |
| 17 | full CI SUCCESS | RUN_ID = 37027265617 · head = 6758e9b38886b842182df161d621e0e7c9b620d9 · 5 jobs 全绿 |

补充：本地 API contract `API_CONTRACT_OK`（新增 `GET /recovery-states` 已登记）。

## 4. 明确未做（遵守 MSG-84 ⑥）

未实现 real provider OAuth；未引入 unified distributed job scheduler；未开启 payment retries；未做 external write；未做 automatic support agent；未做 X4；未重写 monitoring backend。PC-04 仅交付 customer-visible error/recovery states；未改 Schema、未加 migration、未新增写端点。

## 5. 下一执行单元（待裁决）

若 PASS：按 PC 队列进入 **PC-05 Recovered money visibility**（到账/结算/费用/账单的客户可读只读投影）。
边界保持：NO platform write · Payment = 0 · autopay = OFF · collection = OFF · external payment write = OFF · R13 HOLD · TRANSPORT=false · 无生产凭据。
