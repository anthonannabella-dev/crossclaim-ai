# PC-02 OPPORTUNITY LIST CHECKPOINT（customer-visible read projection）

状态：**READY_FOR_REVIEW / IMPLEMENTATION CHECKPOINT**（待架构方裁决）
IMPLEMENTATION_HEAD = 742dcfc
IMPLEMENTATION_HEAD_FULL = 742dcfcb3a85a7de6780794baa9679105b21146c
CI = SUCCESS · RUN_ID = 37023332864 · CI_HEAD = 742dcfc
授权：MSG-20261002-82 ⑥⑦⑧⑨（PC-02 OPPORTUNITY LIST；只做客户可用的机会列表，不扩底层架构）。
边界：NO platform write · Payment = 0 · autopay = OFF · collection = OFF · external payment write = OFF · R13 HOLD · TRANSPORT=false · 无生产凭据。

## 1. 范围逐项落地（MSG-82 ⑥ 1–7）

| 项 | 要求 | 实现 |
|---|---|---|
| 1 read API / projection | 只读当前 organization 机会；字段安全集合；不暴露 raw SourceTransaction / secret / credentialRef / internal audit payload | `GET /opportunities` → `listOpportunities()`；select 只取展示字段 + `platformAccount(id/platform/externalAccountId/displayName)`；验收断言响应文本不含 `credentialRef` / `raw` / `sourceTransaction` / `passwordHash` / `secret` / `token` / `organizationId` |
| 2 Filtering | status / domain / channel / account / detected date / amount threshold；不做复杂查询语言 | `status` `domain` `channel` `accountId` `detectedFrom` `detectedTo` `minRecoverable`（枚举取值直接来自 Prisma 枚举，避免与 Schema 漂移）；非法值 → 400 `INVALID_INPUT` |
| 3 Stable sort / pagination | deterministic + limit + cursor；默认 `detectedAt DESC + id DESC` | `orderBy [{detectedAt:'desc'},{id:'desc'}]`；cursor = base64url(`ISO|id`)，同刻并列用 id 继续；`limit` 默认 20 / 最大 100；`hasMore` + `nextCursor` |
| 4 Account isolation | 多 PlatformAccount 明确归属；绝不跨 tenant；legacy NULL 不得借 connection 推断 | `accountState: ATTRIBUTED | LEGACY_UNATTRIBUTED`；`accountId` 为 NULL 时 `account: null` 且不查询 connection（验收专门构造「存在已绑定 connection」的场景仍不推断） |
| 5 Customer-visible status | 内部枚举 → 客户可读状态 | `CUSTOMER_STATUS`：DETECTED→`NEEDS_REVIEW`「待确认」/ QUALIFIED→`RECOVERABLE`「可追回」/ REJECTED→`EXCLUDED`「已排除」/ CONVERTED→`IN_CASE`「已进入案件」/ EXPIRED→`EXPIRED`「已过期」 |
| 6 Detail entry | 列表可进入既有 action / case flow，不重写 case creation | 每项返回 `actions { canQualify, canReject, canCreateCase }`（由 status 派生）；UI 以链接进入既有 `/cases?opportunity=<id>` 流程 |
| 7 Empty / loading / error states | loading / no opportunities / filtered no results / API error / unauthorized / expired session | UI 分别呈现：加载中、无机会（引导导入）、筛选无结果、API error、401「会话已失效」 |

## 2. 交付物

| 文件 | 说明 |
|---|---|
| `apps/api/src/services/workflow/opportunity-list.ts` | PC-02 只读投影 + 过滤 + 稳定分页 + 客户状态 + 归属/能力投影 |
| `apps/api/src/services/workflow/http-routes.ts` | 新增 `GET /opportunities` 分支（含 method gate / known-path guard 登记） |
| `apps/api/src/server.ts` | `WORKFLOW_PATH` 放行 bare `/opportunities`；**退役**旧 data-routes 的 bare `/opportunities` 入口（见 §4 披露） |
| `apps/api/src/__tests__/opportunity-list-http-db.test.ts` | PC-02 HTTP + PostgreSQL 验收 6/6（覆盖 ⑧ 的 13 项接口类要求） |
| `apps/web/app/opportunities/page.tsx` + `opportunity-list.tsx` | 客户入口 `/opportunities`：筛选（status/domain/channel/account/最低金额）、表格、加载更多、状态语义与错误态 |
| `API.md` | 新增 `GET /opportunities` 契约行（API contract 闸门） |

## 3. 验证证据（对照 MSG-82 ⑧）

| # | 验收项 | 证据 |
|---|---|---|
| 1 | same tenant opportunities visible | 「same tenant visible；foreign tenant invisible；无敏感字段」 |
| 2 | foreign tenant opportunities invisible | 同上（ORG_B 机会不出现在 ORG 列表） |
| 3 | multi-account opportunities correctly attributed | 「multi-account 正确归属」：A / A2 各自归属，`account.id` 与其 PlatformAccount 一致 |
| 4 | legacy NULL account does not get guessed | 同上：legacy 行 `accountState=LEGACY_UNATTRIBUTED`、`account=null`，即使存在已绑定 connection 也不推断 |
| 5 | status filter | 「status / domain / channel / account / amount / date 过滤」 |
| 6 | domain / channel filter | 同上 |
| 7 | account filter | 同上（`accountId=<A2>` 仅返回 A2 的机会） |
| 8 | amount / date filter | 同上（`minRecoverable` / `detectedFrom` / `detectedTo`） |
| 9 | deterministic pagination | 「deterministic pagination」：limit=2 三页合计 5 条、无重复、`hasMore` 正确、重复查询顺序一致 |
| 10 | unauthorized → 401 | 「unauthorized → 401；无权限 → 403」 |
| 11 | no permission/session → fail-closed | 同上：FINANCE / VIEWER → 403（`reviewOpportunities` 权限矩阵，未知角色 fail-closed） |
| 12 | API response contains no sensitive fields | 「same tenant visible…」中逐项断言禁止字段名 |
| 13 | empty state | 「empty state 与 action flags」：items=[] / hasMore=false |
| 14 | opportunity actions / case flow regression green | `workflow-http-db` 7/7（qualify / reject / case / 连接管理 / 建案 / 商务确认 / 案件读取）全绿；`http-logging` 1/1 |
| 15 | tenant isolation regression green | 本套件跨租户断言 + 既有 `c2-*` / tenant 触发器套件在 CI 全绿 |
| 16 | tsc api/web 0 errors | `tsc --noEmit`（apps/api）0 error · `tsc --noEmit`（apps/web）0 error |
| 17 | full CI success | RUN_ID = 37023332864 · head = 742dcfcb3a85a7de6780794baa9679105b21146c · 5 jobs 全绿 |

补充：本地 API contract 闸门 `API_CONTRACT_OK`（新增 `GET /opportunities` 已登记，无未文档化路由 / 无未实现文档）。

## 4. 必须披露的一处路径变更

`GET /opportunities` **此前**由 C-0008-A 的只读 data-routes 提供（返回 `{items:[{id,status,opportunityType,title,amount*,currency,detectedAt}]}`，无过滤、无分页、无归属信息）。PC-02 之后该路径由 workflow 路由提供客户可见列表（含过滤 / 游标分页 / account 归属 / 客户状态 / actions）。server.ts 中 `url === '/opportunities'` 的 data-routes 分发已退役，**同一 URL 不再有两个处理器**。

影响面：仓库内除本批新增测试外，无其他消费者依赖旧 data-routes 形状（`apps/web` 未使用；`http-logging.test.ts` 仅断言 401 路径，保持通过）。若架构方要求保留旧形状，可改为 `GET /opportunities/legacy` 或在响应中并存字段——本轮未这样做，以避免同一 URL 双语义。

## 5. 明确未做（遵守 MSG-20261002-82 ⑨）

未做 X4 cross-provider entity resolution；未做 AI ranking redesign；未做 Growth SEO；未触碰 billing / payment；未做 provider real write；未新增 account lineage 规则；未做 analytics mega-dashboard。未改 Schema / 未加 migration。

## 6. 下一执行单元（待裁决）

若 PASS：按 PC 队列进入 **PC-03 Claim package view**（客户可读的 package / basis / 提交状态；只读投影 + 既有流程入口）。
边界保持：NO platform write · Payment = 0 · autopay = OFF · collection = OFF · external payment write = OFF · R13 HOLD · TRANSPORT=false · 无生产凭据。
