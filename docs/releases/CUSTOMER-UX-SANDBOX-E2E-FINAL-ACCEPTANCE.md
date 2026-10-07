# CUSTOMER-UX-SANDBOX-E2E — FINAL ACCEPTANCE

**验收单元**：`CUSTOMER-UX-SANDBOX-E2E-FINAL-ACCEPTANCE`
**仓库 / 分支**：`anthonannabella-dev/crossclaim-ai` · `acceptance/customer-sandbox-e2e`
**基线 HEAD**：`4c304a4df892785c88f0774f9feb0199d54c7dff`（AEL = PASS / CLOSED 的封板点）
**生产权限**：NONE —— 本轮未解锁任何 HOLD / FORBIDDEN 项

---

## 0. 一句话结论

一个第一次接触 CrossClaim 的客户，现在可以**不看文档、不需要工程师解释**完成：
第一次访问 → 注册 → 邮箱验证 → 登录 → 看懂首页 → 写下追回目标 → 被引导去连接/上传 →
看到连接后的客户语言状态 → 刷新/登出重登后继续；而在**真实外部边界**（平台提交、报关、支付）
系统用客户语言说明「还没有接入」，不伪造成功。

本轮发现并修复了 4 组**真实客户阻断 / 工程术语外泄**问题（见 §4），并用真实浏览器旅程 + 四域 sandbox E2E 复测。

---

## 1. 验收方式（真实客户视角）

| 项 | 做法 |
| --- | --- |
| 客户身份 | 全新邮箱、全新组织，走真实 HTTP + 真实 PostgreSQL（**不是** service/test function 直调） |
| 浏览器 | 真实 Chromium（本机 Edge，`playwright-core` channel `msedge`），真页面 / 真点击 / 真表单提交 |
| viewport | desktop 1440×900 + mobile 390×844（同一客户同一浏览器换设备，会话延续） |
| 沙箱出口 | dev/test-only sandbox API：`createServer()` 与生产完全同构，只把 **signup gate 打开** + **邮件出口换成文件 sink** |
| 生产改动 | **零**：sandbox 只存在于 `apps/api/acceptance/` 与 `apps/web/acceptance/`（不进 `dist`、不进生产路径） |

运行方式（可复现）：

```bash
node apps/web/acceptance/customer-e2e/run.mjs      # 起 sandbox API(3100) + web(3011) + 真实浏览器旅程
```

产物：`reports/acceptance/<run-id>/`（截图 + `journey-summary.json` + 服务日志）。

---

## 2. 客户旅程（desktop）

| # | 步骤 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 首次访问 `/`（未登录） | PASS —— 看到「第一次使用 CrossClaim？」+ 它能做什么 + 三步 + 15% 计费说明 + 创建账号/登录 CTA | `01-home-logged-out.png` |
| 2 | `/signup` 真实填表提交 | PASS —— 「账号已创建」+ 「下一步：打开验证邮件」+ 「重新发送验证邮件」；**默认视图无 `organizationId`、无 `PC-01B`** | `02-signup-created.png` |
| 3 | 邮箱验证（sandbox 邮件出口） | PASS —— 邮件确实被发出（sink 落文件）且 token 验证成功 | `journey-summary.json` |
| 4 | `/login` 真实登录 | PASS —— 登录页有「还没有账号？创建账号」入口；登录后落到首页 | `03-home-first-run.png` |
| 5 | 首页信息架构 | PASS —— Goal Console / 建议任务 / 需要你处理 / 四张结果卡 / 平台卡 / 按币种不跨币种求和 | 同上 |
| 6 | 自然语言目标 | PASS —— 输入「帮我把 Amazon 上可以追回的钱找回来」→ 服务端理解并记录 + 生成计划；无 runner/judge/policy 术语 | `04-goal-recorded.png` |
| 7 | 连接引导 | PASS —— `/connections` 客户语言向导（连接 Amazon / 上传承运商账单 / 上传海关资料）；**默认视图无 FILE_UPLOAD / PLATFORM / CUSTOMS_BROKER / credentialRef** | `05-connections-wizard.png` |
| 8 | 建立连接 | PASS —— 选择「上传承运商账单」→ 自动推导内部字段 → 创建成功，列表显示客户语言渠道名 | `06-connection-created.png` |
| 9 | 刷新 / 登出重登 | PASS —— 刷新后连接仍在；登出回到首次使用页；再次登录后连接仍在（可继续原任务） | `07-after-relogin.png` |
| 10 | 页面健康 | PASS —— 零未捕获异常、零控制台错误（favicon 类忽略） | `journey-summary.json` |

## 3. 客户旅程（mobile 390×844）

| 步骤 | 结果 | 证据 |
| --- | --- | --- |
| 首页（同会话） | PASS —— Goal Console 可用、已登录状态正确 | `m1-mobile-home.png` |
| `/connections` | PASS —— 客户语言向导在移动端同样可用 | `m2-mobile-connections.png` |
| `/authorizations` | PASS —— 授权页客户语言、可撤销入口可见 | `m3-mobile-authorizations.png` |

**BROWSER_E2E = PASS（38/38 checks）**　**MOBILE_E2E = PASS（含在 38 checks 内）**

---

## 4. 发现的问题与最小修复（含复测）

| ID | 严重度 | 问题（客户视角） | 最小修复 | 复测 |
| --- | --- | --- | --- | --- |
| UX-1 | **P0 阻断** | 注册后客户被卡死：注册不触发验证邮件、页面没有重发入口、登录页没有注册入口，且成功页把 raw `organizationId` 直接摊给客户（还有内部票号 `PC-01B`） | ① API：`/auth/signup` 成功后 **best-effort** 立即请求验证邮件，并在响应里如实返回 `verificationEmail.delivered`；② Web：成功页改为「下一步 + 重发按钮 + 去登录」，`organizationId` 收进「高级信息（工程字段）」折叠区；③ `/login` 增加「创建账号」入口 | journey：`signup.*` 6 项 PASS；`auth/self-signup/email-lifecycle` 19/19 PASS |
| UX-2 | **P1** | `/connections` 把内部数据模型当主要交互：`FILE_UPLOAD / API / PLATFORM / LOGISTICS / CUSTOMS / AMAZON_FBA / CUSTOMS_BROKER` 与 `credentialRef` 全在客户默认视图 | 客户语言向导（连接 Amazon / 上传承运商账单 / 上传海关资料 / 其他·高级），自动推导 `kind/domain/channel`；工程字段与 `credentialRef` 只在「其他 / 高级」出现；列表渠道名客户语言化 | journey：`connections.*` 5 项 PASS；UI render 138/138 |
| UX-3 | **P1** | 未登录首页只显示「需要登录」，第一次来的客户不知道 CrossClaim 是什么、第一步做什么 | 未登录首页 = 首次使用引导（能做什么 / 三步 / 计费说明 / 创建账号 + 登录） | journey：`firstRun.*` 6 项 PASS |
| UX-4 | **P2** | 客户文案里混入审计/工程标签：`OWNER / ADMIN / OPS`、`External Write = HOLD`、`Provider = HOLD` | 5 语言字典改为客户语言（案件可见范围、外提交通道尚未开放、提交通道尚未接入），并同步 UI render 断言到客户语言（保留「必须告诉客户边界」的守卫） | i18n 834 键 5 语言 parity / 硬编码 0；UI render 138/138 |

固定口径：新增客户可见字符串全部进现有字典（5 语言 parity），**客户硬编码字符串 = 0**。

---

## 5. 四大追回域 Sandbox E2E（真实 HTTP + 真实 PostgreSQL）

| 域 | 覆盖链路 | 证据（本轮实跑） |
| --- | --- | --- |
| Platform | qualification runtime（默认 runtime 组合、持久化判定，不重算） + `platform.write` 边界（HTTP + ledger + golden path；transport 恒关、零外写） | `platform-qualification-runtime-http-e2e-db` 1/1、`platform-write-http-db`、`platform-write-golden-path-db` |
| Logistics / Carrier | 承运商人工补录 / claim response 的 **HTTP E2E**（DB row + 审计恰好一次、重复 POST → `ALREADY_RECORDED`、跨租户 404、角色 403、未知 package 404） | `carrier-manual-submission-http-e2e-db` 8/8、`carrier-claim-response-http-e2e-db` 8/8 |
| Customs | duty recovery chain（真实 HTTP 触发，含四个永久 HOLD 字段）+ 授权中心 + sandbox filing provider | `customs-duty-recovery-chain-e2e-db`、`customs-recovery-chain-http-e2e-db` 4/4、`customs-authorization-center-e2e-db`、`customs-sandbox-filing-provider` 9/9 |
| Independent Site | Phase 1 生产者 + runtime 组合（真实 HTTP + PG，投影自动产生、`notPersisted=[]`） | `independent-site-phase1-runtime-http-e2e-db` 1/1、`independent-site-internal-closure` |

四域合计本轮实跑：**11 test files / 74 tests / 74 PASS**（单一命令，真实 PostgreSQL）。

> 说明：本轮**没有**新建第二事实源或第二 runtime；四域全部复用既有服务、既有 fixture / sandbox adapter，
> 浏览器旅程覆盖其中「客户可见」的一段（目标 → 连接 → 状态 → 恢复原任务），域内深链路用既有 HTTP+PG E2E 取证。

---

## 6. 没有真实 API 时的行为（NO_API_BEHAVIOR）

| 场景 | 客户看到 | 证据 |
| --- | --- | --- |
| 未接入的平台渠道（TikTok / Walmart / 独立站） | 「该渠道的采集适配器尚未接入，暂不提供连接」（首页平台卡） | 旅程截图 `03-home-first-run.png` |
| 平台/海关真实提交 | 「材料包就绪不等于已提交：对外提交通道尚未开放」 | 首页「对外提交状态」 |
| 海关申报 | 「材料准备完成后仍需人工代理或申报服务提交：提交通道尚未接入」 | `/customs` |
| 支付 / 收款 | 「当前不会自动扣款：支付与收款通道尚未开启」「已计算费用不等于已收费」 | `/billing`、`/money` |
| 邮件通道 | 「邮件发送通道尚未接入（外部通道尚未开放）：验证邮件暂时无法送达…可稍后重发」 | `/signup` 成功页 |

**NO_FAKE_SUCCESS = PASS**：所有未接入能力都以客户语言明确说明「尚未接入」，
且服务端响应（`sessionIssued=false`、`nextStep=EMAIL_VERIFICATION_REQUIRED`、
`platformWriteExecuted=false`、customs 四个 HOLD 字段）与前端文案一致，不存在「已真实提交/已报关/已扣款」的假状态。

**EXTERNAL_BOUNDARY = 诚实停机**：真实平台提交、报关、支付、佣金扣费、生产凭据全部仍为 HOLD。

---

## 7. 容错 / 幂等（复用既有真实 PG E2E）

| 场景 | 证据 |
| --- | --- |
| 重复提交（同一 provider source / 重复 POST） | carrier HTTP E2E：第二次 → `200 ALREADY_RECORDED`，仍一行、审计一次 |
| 重复 callback / webhook 重放 | `customs-provider-c17-reconciliation-db`、`action-guard-*replay*` 族（既有 PASS） |
| 授权撤销 / 连接失效 | `standing-authorization-persistence-db` 10/10（撤销留痕 + 立即 fail-closed）、`connection-lifecycle-db` |
| 跨租户 ID | carrier/customs HTTP E2E 的 404（anti-enumeration）+ `tenant-isolation` 全绿 |
| OAuth 中断 / 一次性 state | `oauth-session-connection-sync-db` 11/11（PENDING→CONSUMED→SUCCEEDED + 绑定冲突 + 跨租户拒绝） |
| 页面刷新 / 登出重登 | 本轮浏览器旅程 PASS（连接与目标状态延续） |

---

## 8. 回归与构建（exact HEAD）

| 项 | 结论 |
| --- | --- |
| API 全量 `npx vitest run` | **4550 / 4551 passed** —— 唯一失败 = 既有 `recovery-si-phase2-e-db` P2E-DB5 并行隔离 flake（`payment.count()` 被并行套件污染；单跑 20/20 PASS）。与 AEL FINAL2 基线**同一条**失败，本轮修复未引入新失败 |
| 四域 sandbox E2E（定向） | 11 files / 74 tests / 74 PASS |
| `api tsc --noEmit` | 0 |
| `web tsc --noEmit` | 0 |
| `next build`（web） | **✓ Compiled successfully**（30 个静态页全部生成；Route 列表正常） |
| UI render check | `UI_RENDER_CHECK=OK checks=138` |
| i18n 校验 | `I18N_CHECK=OK locales=5 keys=834 statusCodes=13 customerHardcodes=0` |
| `prisma validate` | valid（本轮未改 Schema / 未加迁移） |
| 真实 PostgreSQL | docker `crossclaim-postgres`（127.0.0.1:55432），上述 E2E 全部真库运行 |
| GitHub Actions | **NOT_OBSERVED**（exact HEAD 无 CI run；上述为本地证据，不得写成 CI green） |
| 已知既有债 | `recovery-si-phase2-e-db` P2E-DB5 并行隔离 flake（单跑通过）—— 单独记录，不掩盖，不因此重写稳定代码 |

---

## 9. 边界（全程未解锁）

HOLD：REAL_PROVIDER_WRITE、CUSTOMS_FILING、PAYMENT、AUTO_COMMISSION_CHARGE、PRODUCTION_CREDENTIALS、
PRODUCTION_ENABLEMENT、REAL_MODEL_NETWORK、PAID_MODEL_CALLS、EXTERNAL_WRITE、TRANSPORT、P2_F、P2_G。

FORBIDDEN：SECOND_RUNTIME、SECOND_SCHEDULER、SECOND_GUARD、SECOND_POLICY_ENGINE、SECOND_CONTROL_PLANE、
SECOND_MODEL_GATEWAY、SECOND_COST_LEDGER、SECOND_META_EVIDENCE_STORE、L5_RELAXATION。

KEEP：> USD 1,000 → OWNER/ADMIN、≥ USD 10,000 → ADMIN；Action Guard / compliance gates 全保留；
Standing Authorization ≠ Broker POA；LLM 不决定权限/eligibility/金额；前端不重算业务判定。

---

## 10. 返回值

```
CUSTOMER_FIRST_RUN                 = PASS（未登录首页 = 首次使用引导；注册 → 验证 → 登录全链路可用）
CUSTOMER_GUIDANCE                  = PASS（Goal Console + 建议任务 + 需要你处理；无需读文档）
CUSTOMER_CAN_START_WITHOUT_HELP    = PASS（3–5 分钟内知道第一步：创建账号 → 连接/上传 → 写目标）
GOAL_TO_AUTHORIZATION              = PASS（目标被服务端理解并记录；缺连接/授权时给客户语言下一步）
AUTHORIZATION_TO_RESUME            = PASS（刷新 / 登出重登后继续原任务；/authorizations 可撤销）
BROWSER_E2E                        = PASS（真实 Chromium，desktop 1440×900，38/38 checks）
MOBILE_E2E                         = PASS（390×844，同会话延续）
PLATFORM_SANDBOX_E2E               = PASS（qualification runtime + platform.write 边界；零外写）
LOGISTICS_SANDBOX_E2E              = PASS（carrier HTTP E2E 16/16；重复 POST 幂等）
CUSTOMS_SANDBOX_E2E                = PASS（duty chain + 授权中心 + sandbox filing provider；四个 HOLD 字段）
INDEPENDENT_SITE_SANDBOX_E2E       = PASS（Phase 1 生产者 + runtime 投影）
NO_API_BEHAVIOR                    = PASS（未接入能力全部客户语言 + 诚实停机）
FAILURE_RECOVERY                   = PASS（刷新 / 重登 / 撤权 / 跨租户 / 一次性 state）
IDEMPOTENCY                        = PASS（重复提交 → ALREADY_RECORDED；审计恰好一次）
NO_FAKE_SUCCESS                    = PASS（无「已真实提交/已报关/已扣款」假状态）
EXTERNAL_BOUNDARY                  = PASS（真实 provider / 报关 / 支付仍 HOLD）
PRODUCTION_GATE                    = PASS（PRODUCTION_READY = NO；未解锁任何边界）
CUSTOMER_VISIBLE_TECHNICAL_JARGON  = 0（默认客户路径无 FILE_UPLOAD/PLATFORM/credentialRef/PC-01B/External Write = HOLD）
BLOCKING_UX_ISSUES                 = 0（发现 1 个 P0 + 2 个 P1 + 1 个 P2，已最小修复并复测）
REMAINING_API_DEPENDENCIES         = Amazon/TikTok/Walmart/独立站采集适配器、真实平台提交、CBP/ABI filing、
                                     支付与佣金通道、生产凭据与邮件投递（均需宿主单独授权）

CUSTOMER_ACCEPTANCE                = PASS（本地验收全部通过；**最终 CLOSED 需右侧独立 ChatGPT 裁决**）
INTERNAL_SANDBOX_E2E               = PASS
REAL_EXTERNAL_EXECUTION            = NOT_EXECUTED
REAL_VALIDATION_COMPLETE           = NO
PRODUCTION_READY                   = NO
```

**独立终审**：本单元不由 Codex 自行宣布 CLOSED —— 本报告 + exact HEAD + 关键测试证据已提交右侧独立 ChatGPT，
按 `CUSTOMER_USABILITY / FIRST_RUN_GUIDANCE / SANDBOX_END_TO_END / NO_API_FAIL_CLOSED / AUTHORIZATION_RESUME /
EXTERNAL_BOUNDARY_HONESTY / SECURITY_BOUNDARY / PRODUCTION_GATE` 逐项裁决；返回 PASS 才记 CLOSED。

---

## 11. 证据索引（可复现）

| 项 | 位置 |
| --- | --- |
| 浏览器旅程运行器 | `apps/web/acceptance/customer-e2e/run.mjs`（一条命令起 sandbox API + web + 真实浏览器） |
| 旅程断言 | `apps/web/acceptance/customer-e2e/journey.mjs`（desktop + mobile，38 checks） |
| sandbox API（dev/test-only） | `apps/api/acceptance/sandbox-server.ts`（与生产同构，仅开启 signup gate + 文件邮件出口） |
| 本轮运行产物 | `reports/acceptance/2026-10-07T08-30-28-524Z/`（截图 10 张 + `journey-summary.json` + `run-summary.json` + 服务日志） |
| 全量 API 回归日志 | 本地 `vitest run`（4550/4551；失败项与基线一致） |
| 受审 HEAD | 见本文件的提交（`docs/releases/CUSTOMER-UX-SANDBOX-E2E-FINAL-ACCEPTANCE.md` 与该提交同一 HEAD） |

**生产影响**：`apps/*/acceptance/` 不在 `tsc` 的 `include`（`src/**`）内，不进 `dist`，不被任何生产路由引用；
`playwright-core` 仅为 `apps/web` 的 devDependency（不下载浏览器，使用本机已安装 Edge）。

---

## 12. FINAL2 修订记录（按独立终审 MSG-20261007-03）

裁决 MSG-20261007-03 = **PASS WITH REVISE / NOT CLOSED**（逐字归档于 AI-ARCHITECT-INBOX.md；
FNV1A_MATCH 23b7ca2a + FULL_COPY_OK 195 行一致），要求三件事：post-create 术语清理、
Goal → 既有 ONE SI Runtime 的真实接线、Authorization → 同一条 Goal 的恢复闭环。以下为本轮修订与证据。

### 12.1 CHANGE 1 — CUSTOMER_USABILITY（post-create 术语）

* 连接卡默认视图不再显示 raw item.kind；credentialRef 更新控件移入「高级信息（工程字段）」；
* 连接页角色码改为客户语言（组织管理员 / 运营 / 财务 / 只读成员；字典新增 roleOwner/roleAdmin/roleOps/roleFinance/roleViewer，5 语言 parity）；
* 客户文案去掉字面量 HOLD（改为「外部提交通道尚未开放 / 收款与付款尚未启用 / 邮件通道尚未接入」）；
* 浏览器旅程新增 **post-create** 术语扫描（raw 枚举 / credentialRef / OWNER·ADMIN·OPS / HOLD）——
  不再只在创建连接之前扫描（这正是上一轮裁决指出的 acceptance blind spot）。

### 12.2 CHANGE 2 — SANDBOX_END_TO_END（Goal 真正进入既有 SI Runtime）

新增**产品代码**（非测试脚手架）apps/api/src/services/agent-goal/goal-admission.ts +
goal-admission-http.ts + server.ts 接线：

```
Goal → admitAgentGoal（真实 compiler → validator → capability → planner，校验 durable goalDigest）
     → 非可绕过 gate / 高风险动作一律 DENIED
     → 缺 durable Standing Authorization → REQUIRES_AUTHORIZATION
     → createGoalRuntimeBinding() → 既有队列 artifact 准入（RSI_TASKS_PATH，按 dedupeKey 幂等）
     → ONE SI Runtime 认领（既有 composeRsiRuntime；acceptance 只注入只读 runner）
     → recordGoalRunFromRuntime() → AgentGoalRun / run projection
     → externalActionPerformed = false / externalWritePerformed = false
```

### 12.3 客户浏览器 E2E（55/55 PASS，desktop + mobile）

新增链路（与既有 41 项合并执行）：

```
输入 Goal A → 首页提示「这个目标需要你授权」
→ 客户语言向导建立采集连接（账户/提供方血缘由服务端推导）
→ sandbox authorization provider（只模拟外部授权结果；durable authorization 走真实 store）
→ 真实产品路由 POST /agent-goals/:id/admit（ADMITTED；admissionOnly=true；externalActionPerformed=false）
→ 既有 ONE SI Runtime 认领（composeRsiRuntime().loop.pollOnce()）→ AgentGoalRun 投影
→ 首页 Needs Your Attention 的授权待办消失
→ /recoveries/runs/:id 看到 run projection，且无「已真实提交 / 已报关 / 已扣款」声明
→ 幂等：重复准入不产生第二次入队/执行；重复 runtime 调用 created=false
```

证据目录：reports/acceptance/2026-10-07T10-37-06-102Z/（含 08-goal-authorized-run.png 与 journey-summary.json）。

### 12.4 CHANGE 3 — AUTHORIZATION_RESUME（授权后恢复原 Goal）

goal-admission-db（真实 PostgreSQL）7/7：

| 用例 | 断言 |
| --- | --- |
| GA-1 | 缺 durable 授权 → REQUIRES_AUTHORIZATION；goal 仍 PROPOSED、零入队、零 run |
| GA-2 | 有效授权 → ADMITTED；并入既有队列（task:recovery:*）、PROPOSED→ADMITTED、externalActionPerformed=false |
| GA-3 | 重复准入 → dedupeKey 幂等，不重复入队 |
| GA-4 | 既有 runtime 认领 → run projection（externalWritePerformed=false、executedBy=ONE_SI_RUNTIME）；重复不再产生第二次执行 |
| GA-5 | 授权撤销后 → DENIED，零入队（撤销后不得继续） |
| GA-6 | 跨租户 goal/account → NOT_FOUND（tenant lineage 不可越界） |
| GA-7 | claim.submit 等高风险动作 → 被 findNonAdmissibleActions 拦下（productionGate / platformEnablement 不可绕过） |

授权事实只来自**真实 durable** Standing Authorization（persistStandingAuthorization / revokeStandingAuthorizationScope）；
sandbox provider 仅替代「外部授权结果」，不替换 durable authorization、goal admission、runtime binding、queue、
SI Runtime 或 Action Guard。未新建第二个 Goal（goalId 不变），刷新/重放不产生第二次执行。

### 12.5 本轮回归（FINAL2）

| 项 | 结论 |
| --- | --- |
| 客户浏览器 E2E | **55/55 PASS**（desktop + mobile；零控制台错误 / 零未捕获异常） |
| goal admission（真实 PG） | **7/7 PASS** |
| 定向回归（admission + goal + SA + OAuth + Action Guard + 四域 E2E + architecture） | **20 files / 352 tests PASS** |
| api tsc --noEmit | 0 |
| web tsc --noEmit | 0 |
| UI render check | UI_RENDER_CHECK=OK checks=138 |
| i18n | I18N_CHECK=OK locales=5 keys=839 customerHardcodes=0 |
| prisma validate | valid（未改 Schema、未加迁移） |
| API 全量回归 | 见提交说明（P2E-DB5 并行隔离 flake 单独记录） |
| GitHub Actions | NOT_OBSERVED |

### 12.6 边界（FINAL2 后仍不变）

REAL_PROVIDER_WRITE / CUSTOMS_FILING / PAYMENT / AUTO_COMMISSION_CHARGE / PRODUCTION_CREDENTIALS /
PRODUCTION_ENABLEMENT / REAL_MODEL_NETWORK / PAID_MODEL_CALLS / EXTERNAL_WRITE / TRANSPORT = HOLD；
SECOND_RUNTIME / SECOND_SCHEDULER / SECOND_GUARD / SECOND_POLICY_ENGINE / SECOND_CONTROL_PLANE /
SECOND_MODEL_GATEWAY / SECOND_COST_LEDGER / SECOND_META_EVIDENCE_STORE / L5_RELAXATION = FORBIDDEN；
高金额 HITL KEEP；Standing Authorization ≠ Broker POA；PRODUCTION_READY = NO。

**本单元仍未 CLOSED** —— 需把本报告 + 新 exact HEAD 再次提交右侧独立 ChatGPT 重裁
（CUSTOMER_USABILITY / SANDBOX_END_TO_END / AUTHORIZATION_RESUME / FIRST_RUN_GUIDANCE / NO_API_FAIL_CLOSED /
EXTERNAL_BOUNDARY_HONESTY / SECURITY_BOUNDARY / PRODUCTION_GATE），拿到 PASS / CLOSED 才关闭。
