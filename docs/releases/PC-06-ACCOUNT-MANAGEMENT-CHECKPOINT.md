# PC-06 ACCOUNT MANAGEMENT CHECKPOINT

状态：**READY_FOR_REVIEW / IMPLEMENTATION CHECKPOINT**（待架构方裁决）
IMPLEMENTATION_HEAD = ac65f32
IMPLEMENTATION_HEAD_FULL = ac65f325a62f1bb6c1b5428fc902f25d6fabbc9e
CI = SUCCESS · RUN_ID = 37035849172 · CI_HEAD = ac65f32
授权：MSG-20261003-89 ⑭（PC-06 ACCOUNT MANAGEMENT）。
边界：只读投影 · NO platform write · Payment = 0 · collection = OFF · TRANSPORT=false · 无生产凭据。

## 1. 范围逐项落地（MSG-89 ⑭ 1–6）

| 项 | 要求 | 实现 |
|---|---|---|
| 1 Account list | 客户可查看当前 tenant 的 platform / account displayName / externalAccountId / identityVersion / account status / connections count / active·inactive state / createdAt；只读 server-derived | `getAccountManagementView()` 的 `platforms[].accounts[]`：id / platform / externalAccountId / displayName / identityVersion / status / createdAt / connections / activeConnectionCount |
| 2 Multi-account grouping | UI 必须支持「一个 platform 下的多个 account」，不得重新引入 provider singleton 假设 | 返回结构为 `platforms: [{ platform, accounts: [...] }]`；验收用例断言 AMAZON 下并列 AMZ-A / AMZ-B 两个账户、UPS 下另一账户 |
| 3 Connection visibility | 每个 PlatformAccount 下展示关联 connection：id / label / channel·domain / status / lastSyncAt / lastErrorAt（安全摘要）/ auth·reconnect capability；**禁止** credentialRef / config secret / token / OAuth payload | connection 视图含 id / label / kind / channel / domain / status / lastSyncAt / lastErrorAt / accountState / safeHealthNote / rebind；select 未读取 `credentialRef` 与 `config`；验收断言响应不含 credentialRef 值、`token`、`secret_table`、原始错误文本 |
| 4 Bound / unbound semantics | 必须明确显示 BOUND_ACTIVE / BOUND_INACTIVE / UNBOUND_LEGACY；legacy unbound 不可自动猜 account；沿用 Track B explicit bind/rebind policy | `connectionState()` 由 `platformAccountId` + `status` 推导；未绑定连接**单列** `unboundLegacyConnections`（不出现在任何 account 之下）；`legend` 明确三种状态语义 |
| 5 Account onboarding entry | UI 可以提供 Connect account，但仅调用已有安全 onboarding/bind/rebind capability；**不接**真实 provider OAuth（real OAuth/API 仍 EXTERNAL INTEGRATION GATE） | `onboarding.connectAccountEntry = /connections`、`onboarding.realOAuthState = 'EXTERNAL_INTEGRATION_GATE'`；UI 只渲染入口链接，不发起授权 |
| 6 Rebind visibility | 客户可理解当前 connection 绑定的 PlatformAccount；若已有安全 rebind endpoint 可暴露 entry，但必须 same tenant | 已绑定 connection 的 `rebind = { available: false, reason: 'ALREADY_BOUND_IMMUTABLE' }`（绑定不可变）；legacy unbound 的 `rebind = { available: true, reason: 'LEGACY_UNBOUND_EXPLICIT_REBIND' }`，入口指向既有 `/connections`（`POST /connections/:id/rebind`） |

## 2. 交付物

| 文件 | 说明 |
|---|---|
| `apps/api/src/services/workflow/account-management-view.ts` | PC-06 只读投影（PlatformAccount 与 SourceConnection 分层、多账户分组、安全字段、bound/unbound 语义） |
| `apps/api/src/services/workflow/http-routes.ts` | 新增 `GET /accounts`（method gate / known-path guard 登记） |
| `apps/api/src/server.ts` | `WORKFLOW_PATH` 放行 `/accounts` |
| `apps/api/src/__tests__/accounts-http-db.test.ts` | PC-06 HTTP + PostgreSQL 验收 5/5 |
| `apps/web/app/accounts/page.tsx` + `account-management-view.tsx` | 客户账户管理页：平台分组、账户与连接表格、未绑定连接告警区、图例与 onboarding/realf OAuth 状态说明 |
| `API.md` | 新增 `GET /accounts` 契约行 |

## 3. 验证证据

| # | 验收项 | 证据 |
|---|---|---|
| 1 | 权限边界 | 「unauthorized → 401；OPS / FINANCE / VIEWER → 403；ADMIN → 200」（`manageConnections`） |
| 2 | 多账户分组 | 「多账户分组」：AMAZON 两个账户并列；UPS 一个账户；identityVersion = v1 |
| 3 | bound 语义 | 同上：ACTIVE → BOUND_ACTIVE、PAUSED → BOUND_INACTIVE；legend 三键齐备 |
| 4 | connection 安全字段 | 「connection 只暴露安全字段」：响应不含 credentialRef / vault 引用 / token / 原始错误文本 / config；`safeHealthNote` 只说明「详细信息仅内部可见」 |
| 5 | UNBOUND_LEGACY | 「UNBOUND_LEGACY」：legacy 连接单列、不落到任何 account、`rebind.available = true`；已绑定连接 `rebind.available = false`（binding immutable） |
| 6 | tenant isolation | 「tenant isolation」：外租户账户与连接不出现在响应中 |
| 7 | onboarding 语义 | 用例断言 `connectAccountEntry = /connections`、`realOAuthState = EXTERNAL_INTEGRATION_GATE` |
| 8 | tsc api·web | 本地 `tsc --noEmit` 0 error |
| 9 | API contract | `API_CONTRACT_OK`（新增 `GET /accounts` 已登记） |
| 10 | full CI | RUN_ID = 37035849172 · head = ac65f325a62f1bb6c1b5428fc902f25d6fabbc9e · 5 jobs 全绿 |

## 4. 明确未做

未接真实 provider OAuth/API（EXTERNAL INTEGRATION GATE 保持）；未新增写端点、未在本批执行 bind/rebind（仅暴露既有安全入口）；未改 Schema、未加 migration；未把 PlatformAccount 与 SourceConnection 合并成单一模型；未触碰 payment / external write / production credentials。

## 5. 下一执行单元（待裁决）

若 PASS：PC-06 = PASS / CLOSED → 按队列进入 **PC-07 Entitlement + package unlock（不含真实扣款）**。
边界保持：NO platform write · Payment = 0 · autopay = OFF · collection = OFF · external payment write = OFF · R13 HOLD · TRANSPORT=false · 无生产凭据。
