# FINAL AUDIT PACKAGE —— AGENT EXPERIENCE LAYER + DURABLE AUTHORIZATION + GOAL ORCHESTRATION

被审对象：分支 `gate/7-commercial-validation`
`EXACT_HEAD = FINAL-HEAD-PLACEHOLDER`（本文件与最终收口同一提交；基线 `299b008a`）
审计请求：**独立架构 / 安全 / 产品验收**。请只依据本文件与仓库实际内容判定。

---

## 0. 一句话范围

把已有自动化能力（ONE SI Runtime + Recovery SI Pack + Action Guard + HITL + Provider Adapter + Settlement/Billing）
升级为「客户表达目标 → 系统理解 → 按授权自动执行 → 只在必要时找客户」的 Agent-Native 体验层；
**新增的是入口/投影/授权与连接生命周期**，执行引擎、事实源、守卫、策略核心**一律复用既有实现**。

## 1. 交付清单（P0–P9，全部 CLOSED / PUSHED）

| 单元 | 内容 | 实现 HEAD | 关键证据 |
|---|---|---|---|
| P0 | Standing Authorization **持久化**（1 表；追加式版本 / 撤销留痕 / scope 不可改写 / tenant·account scoped） | `0a710d8b` | `standing-authorization-persistence-db` 10/10 |
| P1 | Agent Goal Domain 薄层（contract / schema / compiler / validator / capability / planner / runtime adapter） | `406d0433` | `agent-goal` 29/29 |
| P2 | Goal → 既有 ONE SI Runtime 接线（只经既有任务队列，不直接调 runner） | `e504f35a` | `agent-goal-runtime-wiring` 7/7（真实 `composeRsiRuntime`） |
| P3 | 最小 Goal 持久化（`AgentGoal` / `AgentGoalRun` = 客户意图 + 执行投影，非业务 SSOT） | `05717294` | `agent-goal-persistence-db` 8/8 |
| P4a | 目标 HTTP 入口（编译 → 校验 → 落库 → 计划预览，零执行） | `ba3e8cb0` | `agent-goal-http-db` 5/5 |
| P4b | 首页 Goal Console + 四张核心结果卡（禁跨币种求和） | `999998b1` | i18n / UI render / web build |
| P5 | Needs Your Attention（复用既有 TaskCenter，单一待办中心） | `7a0149d9` | UI render 103/103 起 |
| P6 | Agent Run 页面 `/recoveries/runs/:id`（业务语言，无内部术语） | `8356549c` | `agent-goal-http-db` 6/6 |
| P7 | Authorization 管理 UI `/authorizations`（只读 + 撤销；无 scope 编辑） | `d4194cf3` | `standing-authorization-http-db` 4/4 |
| P8 | Navigation Progressive Disclosure（一级 5 项；**零 route 删除**） | `e9ce6731` | `nav.no.route.removed` 断言 |
| P9 | durable OAuth 授权会话 + ConnectionSyncState + 按需授权 UX + Customs 授权复用 | `e9cc7dc9` + `299b008a` | `oauth-session-connection-sync-db` 6/6 |

## 2. HOST 第 10 条要求的返回字段

```
AGENT_EXPERIENCE_LAYER          = PASS（P0–P9 全部 CLOSED 并推送）
STANDING_AUTHORIZATION_DURABLE  = PASS（1 表 + 追加式版本 + 撤销留痕 + scope 不可改写；重启后可加载）
GOAL_COMPILER                   = PASS（确定性优先，modelCallCount=0；未知意图 fail safely；注入拒绝）
GOAL_RUNTIME_WIRING             = PASS（只经既有任务队列；caller runner 不得抢占 recovery 命名空间）
HOME_GOAL_CONSOLE               = PASS（真实 POST /agent-goals；如实标注 HOLD；四张卡）
AGENT_RUN_UI                    = PASS（业务语言；无 runner/judge/policy engine/model router 字面量）
NEEDS_ATTENTION                 = PASS（复用既有 TaskCenter；12 类；按需授权项真实出现/消失）
AUTHORIZATION_UI                = PASS（/authorizations；状态来自后端；无 scopeDigest 生成；无范围编辑）
NAVIGATION_PROGRESSIVE_DISCLOSURE = PASS（一级 5 项 + More/Advanced；零 route 删除）
OAUTH_AUTHORIZATION_SESSION     = PASS（durable；state 仅存摘要；一次性；resumeGoalId 绑定）
CONNECTION_SYNC_STATE           = PASS（检查点投影；非第二连接事实源；纯函数重试策略）
CAPABILITY_LOSS                 = 0（既有 route / 页面 / API 全部保留）
ONE_SI_RUNTIME                  = PASS（未改动其语义；goal 只作为入队来源）
SECOND_RUNTIME                  = 0
SECOND_SCHEDULER                = 0（新模块内无 setInterval/setTimeout/cron/Worker）
SECOND_GUARD                    = 0（复用既有 Action Guard；静态约定检查 7/7 通过）
FULL_REGRESSION                 = FULL_REGRESSION_PLACEHOLDER
FINAL_AUDIT                     = PENDING（本包等待独立审计）
PRODUCTION_READY                = NO（外部能力全部 HOLD，见 §5）
```

## 3. 架构验证（可复核）

1. **没有任何第二 Runtime / Scheduler / Guard / Policy Engine / Goal execution engine**：
   - `services/agent-goal/goal-runtime-adapter.ts` 与 `goal-runtime-binding.ts` 显式声明
     `createsRuntime/createsScheduler/createsEventLoop/createsWorkflowEngine = false`、`callsRunnerDirectly = false`；
   - 新模块全文检索 `setInterval|setTimeout|cron|new Worker` → **0 命中**；
   - 集成回归用真实 `composeRsiRuntime` 证明：goal 任务派发到保留 pack `recovery-si`，caller runner 调用 **0 次**；
     经 `domainPacks` 注入 `recovery-si` 被拒（`RECOVERY_SI_RESERVED_PACK_ID_REJECTED`）。
2. **单一动作词汇**：所有动作名来自 `services/action-guard/action-guard.ts` 的 `ACTION_GUARD_CATALOG`；
   域分组 `ACTION_DOMAIN_MEMBERSHIP` 也由该文件（目录所有者）声明；
   `action-guard-enforcement` 静态约定检查（受保护动作字面量必须与守卫同文件）**7/7 通过**。
3. **Goal 不是事实源**：`AgentGoal` / `AgentGoalRun` 显式声明 8 项 `isXxxSsot = false` 与
   `isRecoveryStateMachine = false`；`assertGoalRecordIsNotBusinessTruth` 拒绝被当业务真值使用。
4. **连接单一事实源**：`ConnectionSyncState` 只是 `SourceConnection` 的检查点投影
   （`(organizationId, connectionId)` 唯一 + `connectionId → SourceConnection` 同租户触发器）；
   `OAuthAuthorizationSession` 只描述授权会话，不复制连接身份。
5. **Recovery 路由不可被抢占**：`task:recovery:*` 只能由保留 pack 处理；非该命名空间的入队一律拒绝。

## 4. 安全边界验证

| 要求 | 实现 / 证据 |
|---|---|
| 客户端伪造 scope 一律拒绝 | `POST /agent-goals` 只接受 `intent`；授权撤销只接受 `reason`；伪造 `organizationId/scopeDigest/allowedActionTypes/monetaryLimitUsd` 的 HTTP 回归证明落库值未被改写 |
| 前端不生成 `scopeDigest`、不提交 server-only 字段 | 撤销请求体只有 `reason`；UI 断言 `auth.page.no.scope.editing` |
| tenant / account 隔离 | 所有新表带 tenant 基线触发器；跨租户读恒空、跨租户写 404 或触发 `check_violation` |
| 凭据不入库 | Goal 意图文本过 Experience Memory 禁用内容检查；OAuth 只存 `stateDigest`（sha256）与 `credentialRef` 引用名；PKCE verifier 仅服务端 |
| 重放 / 一次性 | OAuth state `(organizationId, stateDigest)` 唯一 + 消费用行级 CAS（PENDING→CONSUMED）；重复消费恒 null |
| 撤销必须留痕 | `StandingAuthorization` CHECK 强制非 ACTIVE 状态必须带 `revokedAt` + `revokedBy` |
| 高金额 HITL 不可绕过 | 阈值常量 KEEP（>USD 1,000 → OWNER/ADMIN；≥ USD 10,000 → ADMIN）；授权只满足 `humanApproval` 唯一闸门 |
| Standing Authorization ≠ Broker POA | 代码常量 + API 响应 + 页面文案三处声明；Customs 15-gate readiness 未改动 |
| Customs 授权复用而非重建 | `/authorizations` 链到既有 `/customs/authorization`，并说明不可替代 |

## 5. 仍然 HOLD（未开启的能力）

`REAL_PROVIDER_WRITE` · `CUSTOMS_FILING` · `PAYMENT` · `AUTO_COMMISSION_CHARGE` · `PRODUCTION_CREDENTIALS` ·
`PRODUCTION_ENABLEMENT` · `REAL_MODEL_NETWORK` · `PAID_MODEL_CALLS` · `EXTERNAL_WRITE` · `TRANSPORT` · `P2_F` · `P2_G`

具体到本轮代码：`productionAuthorizationEnabled = false`、`bindExecuted = false`、
`externalActionPerformed = false`、`PLATFORM_WRITE_TRANSPORT_ENABLED = false` 未改动；
所有失败/未知一律 fail-closed。**PRODUCTION_READY = NO**。

## 6. 测试与门禁证据

| 门禁 | 结果 |
|---|---|
| FULL_REGRESSION（`npx vitest run`，真实 PostgreSQL） | `FULL_REGRESSION_PLACEHOLDER` |
| 已知既有 flake | `recovery-si-phase2-e-db` P2E-DB5（并行隔离债）：**单独运行 20/20 PASS**，非本程序引入 |
| `api tsc --noEmit` | exit 0 |
| `prisma validate` / `migrate deploy` | valid / `MIGRATIONS_PLACEHOLDER` migrations 全部成功 |
| 租户触发器清单（对照真实库） | required `TRIG_REQ_PLACEHOLDER`；append-only `TRIG_APP_PLACEHOLDER` 全 OK |
| `architecture-contract` | `ARCH_PLACEHOLDER` |
| i18n（5 语言 parity + 硬编码守卫） | `I18N_PLACEHOLDER` |
| UI render check | `UI_RENDER_PLACEHOLDER` |
| `web tsc --noEmit` / `next build` | exit 0 / exit 0（`WEB_PAGES_PLACEHOLDER`） |

本轮新增/扩展的测试套件（全部真实 PostgreSQL）：`standing-authorization-persistence-db` 10 ·
`standing-authorization-http-db` 4 · `agent-goal` 29 · `agent-goal-runtime-wiring` 7 ·
`agent-goal-persistence-db` 8 · `agent-goal-http-db` 6 · `oauth-session-connection-sync-db` 6。

## 7. 产品验收要点（请重点看这几条）

1. **客户只做三件事**：表达目标 → 需要时授权/审批 → 看追回结果（首页 Goal Console + Needs Your Attention + Agent Run）。
2. **主动授权与按需授权都成立**：`/authorizations`（主动）与 Needs Your Attention 的 AUTHORIZATION 项（按需，
   目标保持 `PROPOSED` 时出现，授权完成后自动消失、继续原目标，无需重新提交）。
3. **UI 不伪造业务状态**：所有金额逐币种原样来自后端（前端零算术、禁跨币种求和）；Go/No-Go 由后端字段决定；
   没有事实就显示空状态；HOLD 在客户可见文案中如实表达。
4. **不暴露内部实现**：Agent Run 页面自动断言不含 runner / judge / policy engine / model router /
   `task:recovery` 字面量；技术 code 只在折叠的「高级信息」里。

## 8. 请审计方给出的结论形式

```
VERDICT: PASS | PASS WITH REVISE | REVISE | FAIL
CHANGES: （REVISE 时逐条列出，可直接执行的修改）
RISKS:   （你认为残余风险的归属：代码 / 流程 / 外部依赖）
```

审计范围建议：§3 架构验证、§4 安全边界、§5 HOLD 声明是否与代码一致、§6 证据是否足以支撑 PASS。
若发现任何「声称完成但代码不成立」的项，请直接指出文件与行为，我们将按 REVISE 立即最小修订并重新送审。
