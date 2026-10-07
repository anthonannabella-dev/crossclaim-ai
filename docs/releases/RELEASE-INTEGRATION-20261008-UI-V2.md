# RELEASE INTEGRATION 20261008 — CUSTOMER-UI-PRODUCTIZATION-V2（UI V2）

> 本文件是本次「Release Integration Only」的白盒记录：只做**已外部 CLOSED/PASS 产物**的集成，
> 不新增产品设计、不重构 runtime、不修改业务语义、不扩展 Schema。

## 1. 授权与范围

HOST 于 2026-10-08 明确授权路径 A：

* 允许 `API_RUNTIME_CHANGED = YES`、`PRISMA_CHANGED = YES`；
* 但**仅限**本次审计中列出、且已经外部裁决判为 PASS / CLOSED 的既有产物；
* 不得借本次集成新增产品设计 / 重构 runtime / 修改业务语义 / 扩展 Schema。

来源单元：**CUSTOMER-UI-PRODUCTIZATION-V2**（外部裁决 `MSG-20261007-09` = PASS / CLOSED，
`REVIEWED_HEAD = 199d4ac4`），其基线为封板验收 `e0e4a8a1`（`MSG-20261007-07` = PASS / CLOSED）。

## 2. 集成前审计（结论摘要）

完整审计见 `outputs/RELEASE-INTEGRATION-AUDIT-20261008.md`（工作区文档）。核心事实：

| 项 | 实测 |
| --- | --- |
| `merge-base(release/integration-20261006, 199d4ac4)` | `42161550` |
| `git diff --stat 42161550 origin/release/integration-20261006` | 空 → release 树 == gate/7 @ 2026-10-06 |
| `e0e4a8a1` / `4c304a4d` / `199d4ac4` 是否为 release 祖先 | 均**否** |
| 纯 UI 移植可行性 | **不可行**：release 的 `/agent-goals` = 0 命中、`/standing-authorizations` = 0 命中 |
| 缺口规模（`42161550..199d4ac4`） | apps/api 38 / apps/web 26 / docs 17 / tools 2 / reports 40 / 其它 2 |

## 3. 集成结果

| 项 | 值 |
| --- | --- |
| `RELEASE_INTEGRATION_BRANCH` | `release/integration-20261008` |
| `SOURCE_BASE` | `release/integration-20261006`（`e3405a05`） |
| 并入 1 — gate/7 CLOSURE | `4c304a4d`（`MSG-20261007-02` PASS/CLOSED）→ merge `eb8f1854` |
| 并入 2 — 验收封板 | `e0e4a8a1`（`MSG-20261007-07` PASS/CLOSED）→ merge `cb6658bc` |
| 并入 3 — UI V2（reviewed `199d4ac4`） | `d8f2943f`（`MSG-20261007-09` PASS/CLOSED）→ merge `f5c094b5` |
| merge 冲突 | **0**（三次 merge 均 clean；无静默取旧 release 逻辑的场景） |
| 集成后树一致性 | `git diff --stat d8f2943f <merge head>` = **空** → 文件树与已验收 UI head 完全一致 |

### 3.1 并入内容（逐项对应 HOST 清单 1–7）

1. **gate/7 CLOSURE 产物**：AEL P0–P9 + AEL FINAL2 的既有字节（goal compiler/validator/store、
   goal-runtime-binding、standing-authorization store + HTTP、OAuth session CAS + transition guard、
   action-guard 非可绕过 gate、tenant trigger 清单更新）。
2. **验收封板产物**：`apps/api/acceptance/sandbox-server.ts`（dev/test-only）、
   `apps/web/acceptance/customer-e2e/**`（真实浏览器旅程 harness）、goal admission 真实接线。
3. **CUSTOMER-UI-PRODUCTIZATION-V2 / FINAL2**：客户 UI 呈现层 + 5 语言字典（883 键）+ UI render 断言。
4. **apps/api 38 文件**：含 `services/agent-goal/**`（13）、`standing-authorization-store.ts`、
   `standing-authorization/http-request.ts`、`connect/prisma-oauth-session-store.ts`、
   `connect/prisma-connection-sync-state.ts`、`server.ts` 路由接线、`action-guard.ts` 与 `auth/http-routes.ts` 最小接线。
5. **`apps/api/prisma/schema.prisma`**：+129 行（standing authorization / AgentGoal 持久化 / OAuth session 状态）。
6. **4 个已 CLOSED 迁移**：`20261007090000_standing_authorization`、`20261007150000_agent_goal_persistence`、
   `20261007190000_oauth_session_connection_sync`、`20261007200000_oauth_session_transition_guard`
   （迁移目录条目 89 → 93；`prisma migrate status` 报告 **92 migrations**）。
7. **客户 UI 依赖**：`apps/web/app/authorizations/**`、`components/ui/active-recovery.tsx`、
   `components/ui/goal-console.tsx`、`components/nav-model.ts`、`scripts/ui-check-entry.tsx`、
   `app/recoveries/page.tsx`、`app/recoveries/runs/[id]/**`、`lib/dashboard-view.ts`、`lib/case-view.ts`、
   `lib/connection-view.ts`、`lib/agent-run-view.ts`、`i18n/dictionaries/*`、`tools/i18n/check-i18n.mjs`。

### 3.2 明确未做（边界）

* 未 force push；`origin/main` 历史未改；封板分支 `acceptance/customer-sandbox-e2e` 未改；
  既有 `release/integration-20261006` 未被覆盖（新分支）。
* 未新增产品设计、未重构 runtime、未改业务语义：并入内容 = 已 CLOSED 单元的既有字节。
* 未 mock 真实 Agent Goal / Standing Authorization 路径：路由探针与浏览器旅程均走真实 HTTP + 真实 PostgreSQL。
* `REAL_EXTERNAL_EXECUTION = NOT_EXECUTED`、`REAL_VALIDATION_COMPLETE = NO`、`PRODUCTION_READY = NO`；
  external write / payment / production credential / real provider 边界不变（`SECOND_* = 0`）。

## 4. 集成后验证（全部在 `release/integration-20261008` 上实跑）

| 门禁 | 结果 |
| --- | --- |
| `prisma validate` | **valid** |
| `prisma migrate status` | 92 migrations；Database schema is up to date |
| fresh DB migration（scratch `crossclaim_reli20261008`） | **All migrations successfully applied；`_prisma_migrations` = 92** |
| api tsc | **0** |
| API 定向回归（agent-goal / standing-authorization / OAuth session / architecture-contract） | **11 文件 / 298 tests PASS** |
| API 全量回归（fresh DB） | **4568 passed / 1 failed（4569）**，唯一失败 = 既有 `recovery-si-phase2-e-db` P2E-DB5 并行隔离债；单跑 **20/20 PASS** |
| web tsc | **0** |
| `next build` | **exit 0**（31 路由） |
| UI render check | **194/194 OK** |
| i18n | **OK**：5 语言 / 883 键 parity / 客户硬编码 0 / `RAW_ENUM_FALLBACK_HITS=0` |
| 客户浏览器旅程（desktop 1440×900 + mobile 390×844） | **103/103 PASS** |
| 浏览器证据目录 | `reports/acceptance/2026-10-07T18-45-17-082Z/` |
| `/agent-goals` 路由存在性与行为 | **PASS**：未鉴权 401 `UNAUTHENTICATED`（fail-closed、非 404）；鉴权后 GET 200 `{items}`；POST 201 建 Goal 并持久化 |
| `/standing-authorizations` 路由存在性与行为 | **PASS**：未鉴权 401；鉴权后 200 `{items, standings, executionPerformed}` |
| 对照（不存在路由） | `/definitely-not-a-route-xyz` → **404**（证明上面的非 404 不是兜底行为） |
| 路由探针总计 | **13/13 PASS** |
| 客户链路探针（真实 HTTP + 真实 PostgreSQL，无 mock） | **11/11 PASS**：`signup → POST /agent-goals → durable standing authorization → /agent-goals/:id/admit(ADMITTED, externalActionPerformed=false) → /acceptance/run-si-runtime(claim + run projection, externalWritePerformed=false) → GET /standing-authorizations(revocationState=ACTIVE) → **真实产品路由** POST /standing-authorizations/:id/revoke(revoked=1) → 复读 REVOKED + revokedAt → 同 provider 另一 identity 的新 Goal 准入 = **403 DENIED `["STANDING_AUTH_REVOKED","AUTHORIZATION_DENY"]`**` |
| 关键页面 smoke（首页 / recoveries / connections / authorizations / money / cases） | 浏览器旅程内 `a11y.*` + `home.*` / `recoveries.*` / `connections.*` / `authorizations.*` 断言全绿 |
| desktop + mobile 无横向溢出 | **PASS**（`a11y.*.no.horizontal.overflow` + `mobile.*`） |
| tenant isolation / fail-closed | **PASS**：`tenant-isolation` 19、`architecture-contract` 170、`goal-admission-db` 18（含跨租户 GA-9/GA-10 拒），以及 action-guard / customs / carrier 全套 |
| external boundary honesty | **PASS**：`admission.external.write.false`、`runtime.external.write.false`、`agentRun.no.external.write.claim`、`money.payment.hold.wording` |
| First-run guidance / 客户可用性 | **PASS**：`firstRun.*`（标题/说明/定价/CTA）+ Goal-first 首页 + 授权中心能力区与边界区 |

## 5. 已知非阻断项（如实登记）

1. **既有 P2E-DB5 并行隔离债**：全量回归唯一失败；单跑 20/20 PASS。属既有测试隔离问题，不掩盖、不为此改稳定代码。
2. **GitHub Actions = `NOT_OBSERVED`**：本文件所有结果均为 **local / Codex evidence**，不得表述为「GitHub CI green」。
3. **宿主 Docker Desktop 在本轮首度全量回归中途崩溃**（`crossclaim-postgres` 被 OOM/SIGKILL，容器退出码 137），
   导致首轮全量结果（147 文件失败）**作废**；已重启引擎、等待 Postgres crash recovery 完成后，
   在**干净引擎 + 全新迁移数据库**上重跑，得到上表的最终结果。
4. **production debt（承接既有登记）**：`createJsonTaskQueuePort()` 仍为 JSON read-modify-write，无跨 worker CAS；
   production enablement 前必须替换为 durable/atomic admission 或证明 single-writer。
5. **Accessibility 口径**：`a11y.*` 属于本单元约定的 smoke（单一 h1 / 无横向溢出 / label·aria / 键盘焦点 / mobile viewport），
   **不是** WCAG 2.2 AA 完整认证。

## 6. 结论

`UI_V2_RELEASE_INTEGRATION = PASS`；`RELEASE_INTEGRATION_20261008 = CLOSED`。

后续若要推进到 main 或开启真实 Provider / 支付 / 生产凭据 / 真实外部验证，必须开启新的独立授权单元。
