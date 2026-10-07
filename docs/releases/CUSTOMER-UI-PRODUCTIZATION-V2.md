# CUSTOMER-UI-PRODUCTIZATION-V2 — 执行记录

## 基线

* repo：`anthonannabella-dev/crossclaim-ai`
* 分支：`feat/customer-ui-productization-v2`（从已封板 `acceptance/customer-sandbox-e2e` @ `e0e4a8a1` 新建；封板分支保持不动）
* 上游已封板：CUSTOMER-UX-SANDBOX-E2E = PASS / CLOSED（MSG-20261007-07；SECURITY_BOUNDARY = PASS）
* 冻结区（本轮未改动）：Goal compiler / goal identity / goal runtime lineage、Standing Authorization 语义与 resolver、
  ONE SI Runtime 组合、Action Guard、Evidence / Judge、Policy Core、Provider domain model、Claim state machine、
  Payment 边界、External Write 边界、Provider transport 边界、Queue 语义、exactly-once / idempotency、
  既有 audit facts、既有 persistence truth、既有 API contracts。
* 本轮只改 `apps/web/**`（客户视图模型 / 信息架构 / 导航 / 文案 / 层级 / 响应式 / 状态呈现）。

## 单元状态

| 单元 | 状态 | 要点 |
| --- | --- | --- |
| P1 首页 Goal Hero | DONE | 首页唯一 Hero；建议目标收敛为 4 条；结果区全客户语言 |
| P2 黄金金额区 | DONE | 四张指标紧随 Hero：可追回 / 追回中 / 已到账 / 需要你处理（逐币种原样展示） |
| P3 Active Recovery | DONE | 新增「CrossClaim 正在帮你做什么」，3–5 条，只消费已有后端事实 |
| P4 Needs Attention | DONE | 仅当存在真实人工待办时渲染；每条含发生什么 / 影响 / 为什么需要你 / 下一步 |
| P5 Navigation simplification | DONE | 一级 5 项客户语言对齐 + `/recoveries` 真实路由 + 更多/高级顺序按 HOST 指令 |
| P6 Opportunity / Case 客户语言 | DONE | 追回机会 / 追回任务 / 提交材料 / 支持材料；案件详情按 HOST 顺序重排，raw 字段折叠进「处理详情」 |
| P7 Authorization UX | DONE | 「CrossClaim 可以替你做什么」+「以下情况仍会先问你」+ 撤销入口保留；账户引用 / 版本折叠进「授权详情」 |
| P8 工程字段隔离 | DONE | 5 语言「工程/技术字段」措辞清零（字典级 guard）；深层详情统一为「详细信息 / 授权详情」 |
| P9 Connections 简化 | DONE | 卡片主视图回答五问（含「CrossClaim 能否继续工作」与「最近同步」）；credentialRef / raw 字段与原始错误下沉到「详细信息」 |
| P10 Mobile / a11y | DONE | 7 条关键路由的 h1/溢出/aria 健康检查 + 键盘焦点 + 移动端新增页面验证 |
| P11 i18n 终扫 | DONE | parity PASS / 0 硬编码 / raw enum 回落清零（新增 check-i18n 静态 guard）+ 未知状态客户语言回落 |
| P12 全客户旅程回归 | DONE | 103 项真实浏览器旅程 + next build + api/web tsc + UI render + i18n 全绿；能力保全与 runtime freeze 证据见下 |
| CUSTOMER-UI-PRODUCTIZATION-V2-FINAL | QUEUED | 独立审计单元（不复用上一轮 CLOSED 状态） |

## P1–P4 变更（首批）

### 首页信息架构

```text
1. AI Goal Hero（唯一主入口，自然语言目标 + 4 条建议目标）
2. 四张黄金指标（可追回 / 追回中 / 已到账 / 需要你处理；逐币种，禁跨币种求和）
3. CrossClaim 正在帮你做什么（3–5 条 active flows）
4. 需要你处理（仅当存在真实人工待办时出现）
5. 更多详情（平台与渠道覆盖 / 资金概览 / 最新可追回机会 / 导入记录 / 安全说明）
```

* 旧首页 Hero（重复卖点段落 + 内部角色码 OWNER/ADMIN 徽标）已移除；主 CTA 与金额入口保留在「更多详情」头部，
  能力零丢失（平台卡 / 机会 / 导入 / 安全说明 / 明细金额全部仍在同一页面，只是降级为第二层）。
* 卡片堆叠收敛：Hero 与 Active Recovery 使用无边框/分隔线结构，减少 border + shadow + badge 竞争。

### Goal Hero（P1）

* 建议目标改为 HOST 指定措辞（5 语言同步），数量从 5 收敛为 4。
* 提交后结果区不再暴露 `domain`（PLATFORM / LOGISTICS / CUSTOMS / INDEPENDENT_SITE）与「已生成 N 条执行任务」，
  改为客户语言：「已开始检查」+ 业务范围标签（平台账单与漏赔 / 物流费用 / 关税 / 独立站与支付）+ 授权说明。
* 前端仍不做任何业务判定：只 POST `/agent-goals` 并展示服务端返回事实。

### Active Recovery（P3）

* 新增 `buildActiveFlows()`（`apps/web/app/lib/dashboard-view.ts`）：
  只把**已有后端事实**翻译为客户语言 —— goal 的 `ADMITTED` / `RUNNING`（标题用客户自己输入的目标文本）
  与既有 case 的后端 `statusLabel`；不新增事实源、不做金额计算、不展示 task namespace / queue id / provider 内部状态。
* 新增组件 `apps/web/app/components/ui/active-recovery.tsx`：最多 5 条，超出进详情页。

### Needs Attention（P4）

* 仅在 `tasks.length > 0` 时渲染；复用既有 TaskCenter（单一待办模型，未新建第二套）。

## P5 变更（第二批）

### 一级导航（客户语言对齐 HOST 指令）

| 位置 | 条目（zh-CN / en-US） |
| --- | --- |
| 一级 | 首页 / 追回进度（Recovery progress）/ 资金（Money）/ 需要我处理（Needs my attention）/ 连接（Connections） |
| 更多 | 追回机会 / 追回任务 / 关税追回 / 数据导入 / 账户 |
| 高级 | 自动追回授权 / 账单 / 套餐 |

* href 顺序已在 ui-check 中固化为断言（`nav.v2.primary.order` / `nav.v2.more.order` / `nav.v2.advanced.order`），
  且继续断言没有任何 `/admin*` / `/operations*` 进入客户导航，`/recoveries` 等 12 个既有 href 一个都不能少（`nav.no.route.removed`）。
* 说明：HOST 指令 §五把 More 里的 cases 写作「案件」，§六的客户语言映射把 Case 定为「追回任务」。
  两处冲突按 §六（明确的客户语言映射）执行，条目标签取「追回任务」；文案与顺序均记录在案，供 FINAL 审计核对。

### 新增 `/recoveries` 客户页（修复一级导航 404）

* 此前一级导航「追回进度」指向的 `/recoveries` 并没有 page 文件（路由缺失）。本批次补齐
  `apps/web/app/recoveries/page.tsx`：只消费 `/agent-goals` 与 `/recovery-money` 的既有事实，
  用 `buildActiveFlows()` 渲染客户语言列表 + 空状态 + 「去首页输入新目标 / 查看金额明细」入口；
  未登录时显示登录提示（复用既有 recoveriesPage 命名空间 + 3 个新 sign-in 文案）。
* 冻结区零改动：Goal / Authorization / Runtime / Guard / Queue / API contract 均未触碰。

## 证据

### 批次 1（P1–P4）


| 项 | 结果 |
| --- | --- |
| web tsc | 0 |
| i18n | OK：5 语言 / 851 键 parity / 客户硬编码 **0** |
| UI render check | **148/148 OK**（新增 10 项：Goal Hero 上限 4 建议 / 无 raw domain / 无任务计数 / Active Recovery 映射与上限 / 空状态 / 无内部状态码） |
| 浏览器客户旅程（真实 Edge + HTTP + PostgreSQL；desktop 1440×900 + mobile 390×844） | **65/65 PASS**（新增：hero-first、Hero 在金额之前、Active Recovery 可见、无「工程字段/技术字段」、首页无内部角色码、目标结果区无 raw code / 任务计数） |
| 浏览器证据目录 | `reports/acceptance/2026-10-07T15-52-05-717Z/` |
| api tsc | 0（本轮未改 `apps/api`） |

### 批次 9（P12）

**P12 全量回归（exact code HEAD `ca5678dd`）**

| 项 | 结果 |
| --- | --- |
| 真实浏览器客户旅程（desktop 1440×900 + mobile 390×844） | **103/103 PASS** |
| api tsc | 0 |
| web tsc | 0 |
| next build | exit 0 |
| UI render check | 183/183 OK |
| i18n | 5 语言 / 881 键 parity / 客户硬编码 0 / RAW_ENUM_FALLBACK_HITS=0 |
| 浏览器证据目录 | `reports/acceptance/2026-10-07T16-34-26-796Z/` |

**HOST §十二 P12 十八项旅程覆盖映射**

| # | 旅程项 | 覆盖断言 |
| --- | --- | --- |
| 1 | 未登录入口 | `firstRun.*` |
| 2 | 注册 | `signup.*`（含 sandbox 邮件验证） |
| 3 | 登录 | `login.*` |
| 4 | Goal 创建 | `goal.recorded` / `goal.result.customer.language` / `goal.id.available` |
| 5 | 黄金指标 | `home.hero.before.metrics` / `headline.*`（UI render） |
| 6 | Active Recovery | `home.activeRecovery.visible` / `recoveries.page.capability` |
| 7 | Needs Attention | `home.needsAttention.visible` / `goal.needs.authorization.visible` / `needsAttention.authorization.cleared` |
| 8 | Connections | `connections.*` / `mobile.connections.wizard` |
| 9 | Opportunity | `opportunities.page.customer.language` |
| 10 | Case | `cases.page.customer.language` / `cases.page.no.engineering.columns` |
| 11 | Authorization | `authorizations.capabilities.visible` / `authorizations.always.ask.visible` / `mobile.authorizations.visible` |
| 12 | Customs | `authz.customs.reuse.link`（UI render）+ 客户导航「关税追回」 |
| 13 | Money | `a11y./money.*` / `home.currencyRule.visible` |
| 14 | Mobile navigation | `mobile.*`（首页 / 连接 / 授权 / 追回进度 / 追回任务 + 无横向溢出） |
| 15 | Advanced progressive disclosure | `nav.v2.*`（一级 5 项 + 更多 + 高级）+ `/recoveries` 真实路由 |
| 16 | 授权撤销 | `auth.page.revoke.cta`（UI render）+ `auth.page.revoked.*` |
| 17 | 无 raw engineering exposure | `home.no.engineer.jargon` / `recoveries.no.raw.engineering` / `connections.primary.no.raw.binding` / `connections.raw.enums.not.primary` / `goal.result.customer.language` |
| 18 | 无 capability loss | `nav.no.route.removed`（12 个既有 href 全在）+ 路由清单回归（下） |

**能力保全证据（vs 封板基线 `e0e4a8a1`）**

* 改动范围只有：`apps/web/**`、`tools/i18n/check-i18n.mjs`、`docs/**`、`reports/acceptance/**`；
  `apps/api/**` 与 `prisma/**` **零改动**（`git diff --name-only e0e4a8a1..HEAD -- apps/api prisma` 为空）——
  即 API contract / persistence truth / queue 与幂等语义 / Action Guard / Goal identity / Standing Authorization 语义未被触碰。
* 路由清单：基线 31 个 `page.tsx` → 现在 32 个；**移除 0 个**，新增 1 个 `apps/web/app/recoveries/page.tsx`（修复一级导航原本 404 的「追回进度」）。
* 一级导航 12 个既有 href 全部保留（`nav.no.route.removed` 断言）；`/admin*`、`/operations` 继续不进入客户导航（`nav.v2.no.admin.entries`）。
* 金额仍逐币种原样展示：`headline.*` / `home.currencyRule.visible` / `recovery-money` 明细未改动；新增的 Active Recovery 视图模型不做任何金额计算，也不新增事实源。
* 浏览器旅程仍覆盖真实链路：`goal.admitted.to.existing.queue` → `runtime.claimed.and.projected`（ONE SI Runtime 真实认领）→ `runtime.replay.no.second.run` → `admission.external.write.false`。

**Runtime / Authorization freeze**

* `SECOND_RUNTIME = 0` / `SECOND_SCHEDULER = 0` / `SECOND_GUARD = 0`（本单元只改 web 呈现层；watchdog 是 Codex 开发任务 continuation，不进入产品 runtime）。
* Standing Authorization 语义与 resolver 未改（授权页只改客户表达；撤销入口与后端真实撤销能力保留）。
* 全部 HOLD 不变：REAL_PROVIDER_WRITE / CUSTOMS_FILING / PAYMENT / AUTO_COMMISSION_CHARGE / PRODUCTION_CREDENTIALS /
  PRODUCTION_ENABLEMENT / REAL_MODEL_NETWORK / PAID_MODEL_CALLS / EXTERNAL_WRITE / TRANSPORT。
* REAL_EXTERNAL_EXECUTION = NOT_EXECUTED；REAL_VALIDATION_COMPLETE = NO；PRODUCTION_READY = NO。

### 批次 8（P11）

**i18n 终扫与「raw enum 回落」清零**

* 未知状态一律回落到客户语言：`status.UNKNOWN` 从「未知状态 / Unknown status / Unbekannter Status / 不明なステータス / Estado desconocido」
  改为「状态待确认 / Status being confirmed / Status wird geprüft / 状態を確認中 / Estado por confirmar」。
* 未知渠道回落 `channelOther`（既有键），未知角色回落新增 `common.roleOther`（成员 / Member / Mitglied / メンバー / Miembro）。
* 代码层清零 raw enum 回落（原来 `?? code` / `return code;` 会把后端枚举直接显示给客户）：
  `lib/case-view.ts`、`components/connection-manager.tsx`（status / 能否继续 / 渠道）、`accounts/account-management-view.tsx`、
  `accounts/page.tsx`（角色）、`billing/page.tsx`、`opportunities/opportunity-list.tsx`、`connections/page.tsx`（角色）。
* **新增 durable gate**：`tools/i18n/check-i18n.mjs` 第 6 项 —— 扫描客户视图源码，出现 `?? code` / `return code;` 即 FAIL
  （本轮该 guard 当场抓出 `opportunity-list.tsx` 一处遗漏，已修复）。

| 项 | 结果 |
| --- | --- |
| i18n | **OK**：5 语言 / 881 键 parity / 客户硬编码 **0** / `RAW_ENUM_FALLBACK_HITS=0` |
| web tsc | 0 |
| UI render check | **183/183 OK**（新增 4 项：UNKNOWN 客户语言、roleOther 存在、caseStatusLabel 未知码回落中英文） |
| 浏览器客户旅程 | **103/103 PASS** |
| 浏览器证据目录 | `reports/acceptance/2026-10-07T16-30-23-066Z/` |

### 批次 7（P10）

**桌面 1440×900 / 移动 390×844 / 可访问性**

* 桌面逐页健康检查（7 条关键路由 `/ /recoveries /cases /opportunities /authorizations /connections /money`）：
  每页恰好 1 个 `h1`、无横向溢出（scrollWidth ≤ clientWidth+1）、存在 aria 标签（`[aria-label]` / `[aria-labelledby]` / `nav` / 表单输入）。
* 键盘可达性：`Tab` 后焦点离开 `body`（`a11y.keyboard.focus.moves`）。
* 移动端新增页面：`/recoveries` 客户语言可见、`/cases` 客户语言可见且无横向溢出（沿用既有 390×844 移动上下文与真实会话）。
* 既有移动检查（首页 Goal Hero 优先、无横向溢出、连接向导、授权页）保持通过。

| 项 | 结果 |
| --- | --- |
| web tsc | 0 |
| i18n | OK：5 语言 / 880 键 parity / 客户硬编码 **0** |
| UI render check | **179/179 OK** |
| 浏览器客户旅程（desktop + mobile） | **103/103 PASS**（新增 25 项：21 项逐页 a11y/溢出/标签 + 键盘焦点 + 3 项移动端新页面） |
| 浏览器证据目录 | `reports/acceptance/2026-10-07T16-25-07-262Z/` |

### 批次 6（P9）

**连接页客户视图（只答五问）**

| 客户问题 | 呈现（由既有事实派生，未新增事实源） |
| --- | --- |
| 连接了什么 | 连接名称 + 客户语言渠道名（既有） |
| 当前是否正常 | 状态徽标（客户语言，既有） |
| 最近同步 | 新增「最近同步」行：有 `lastSyncAt` 显示日期，缺失时如实显示「暂无同步记录」（不伪造） |
| 是否需要重新授权 | 「CrossClaim 能否继续工作」行：可继续 / 需要你重新授权后才会继续 / 已暂停 / 已停止 |
| CrossClaim 能否继续工作 | 同上；由既有连接状态派生，未知状态回落到「需要重新授权」（fail-safe，不吹哨） |

下沉到「详细信息」折叠：`credentialRef` 配置状态与更新入口、`kind / domain / channel / status / platform` 原始值、
`lastSyncAt` / `lastError` 原始值；原始错误串不再直接出现在客户主视图（主视图改为业务语言提示）。
底层事实与 `/connections` API contract 未改动（只在 web 侧增加可选读取 `lastSyncAt`，缺失时降级）。

| 项 | 结果 |
| --- | --- |
| web tsc | 0 |
| i18n | OK：5 语言 / 880 键 parity / 客户硬编码 **0** |
| UI render check | **179/179 OK**（新增 5 项 P9 字典/客户语言断言） |
| 浏览器客户旅程 | **78/78 PASS**（新增：能否继续工作可见、最近同步可见、主视图无 raw binding） |
| 浏览器证据目录 | `reports/acceptance/2026-10-07T16-22-18-295Z/` |
| 可靠性记录 | 本批次一次运行因上一轮残留的 dev server 占用 3011 端口失败（EADDRINUSE）；清理监听进程后重跑全绿，失败目录未入库 |

### 批次 5（P8）

**工程字段隔离（客户主视图清零）**

| 门禁项 | 结果 |
| --- | --- |
| 「工程字段」| 0（5 语言字典 + 渲染 guard） |
| 「技术字段」/ Technical fields / Technikfelder / 技術項目 / campos técnicos | 0 |
| raw digest / raw policy version（客户主文案）| 0（授权卡主文案已无 UUID 与 digest；`scopeDigest`、`termsPolicyVersion` 只在「授权详情」折叠内） |
| 深层详情统一命名 | 详细信息 / 授权详情（`authorizationPage.advancedLabel` = 授权详情；`opportunityAdvanced(Fields)` = 详细信息） |

实现方式：`apps/web/i18n/dictionaries/*.ts` 全量扫描 + 按 key 语义改名（大小写不敏感），
并在 `ui-check-entry.tsx` 增加 5 语言字典级 guard（`p8.no.engineering.wording` / `p8.advanced.labels.renamed`），
防止后续新增文案重新引入该措辞。诊断视图与 RBAC 未改动；未触碰任何后端契约。

| 项 | 结果 |
| --- | --- |
| web tsc | 0 |
| i18n | OK：5 语言 / 872 键 parity / 客户硬编码 **0** |
| UI render check | **174/174 OK**（新增 3 项：字典无工程措辞、advancedLabel = 授权详情、opportunityAdvancedFields = 详细信息） |
| 浏览器客户旅程 | **75/75 PASS** |
| 浏览器证据目录 | `reports/acceptance/2026-10-07T16-15-39-193Z/` |
| 修正记录 | 首轮 sweep 后残留 `es.opportunityAdvancedFields = "Campos técnicos"` 与 `en.opportunityAdvancedFields = "Technical fields"`（大小写/同义词未命中），已用大小写不敏感 + key 语义改名收干净并复跑全绿 |

### 批次 4（P7）

**授权中心（客户表达重做，后端事实不变）**

* 主标题改为「CrossClaim 可以替你做什么」，下面 5 条能力：读取已授权账户数据 / 检查可能追回的金额 /
  整理支持材料 / 准备追回申请 / 在已授权低风险范围内自动继续。
* 单独区域「以下情况仍会先问你」6 条：新平台授权 / 高金额动作 / 报关与 POA / 法规要求的人工确认 /
  超出原授权范围 / 需要真实签署的事项。
* 撤销入口保持可见（`revokeCta` 仍在每张生效卡上）；`/connections` 与海关授权复用入口保留。
* 审计字段折叠：`platformAccountId`（UUID）与 `authorizationVersion / termsPolicyVersion` 从卡片主文案
  移入「授权详情」折叠内（新增 `accountRefLabel`），主文案不再出现 UUID / digest。
* 未触碰：Standing Authorization 表 / resolver / scope 语义 / API contract（本批次只改 `apps/web/**`）。

| 项 | 结果 |
| --- | --- |
| web tsc | 0 |
| i18n | OK：5 语言 / 872 键 parity / 客户硬编码 **0** |
| UI render check | **171/171 OK**（新增 8 项：能力/边界文案、撤销仍在、主文案无 UUID 与 digest、账户引用在折叠内） |
| 浏览器客户旅程 | **75/75 PASS**（新增：授权页能力区可见、边界区可见、主文案无 raw 审计） |
| 浏览器证据目录 | `reports/acceptance/2026-10-07T16-12-09-074Z/` |

### 批次 3（P6）

**客户语言（5 语言，全部走字典）**

| 内部概念 | 客户语言（zh-CN） |
| --- | --- |
| Opportunity | 可追回机会 / 关联的追回机会 |
| Case | 追回任务 |
| Claim package / claim text | 提交材料 |
| Evidence | 支持材料 |
| Create case | 开始追回 |
| Advanced filters (engineering fields) | 更多筛选条件 |

同时清掉客户文案里的内部角色码：`caseDetail.claimText` / `claimDenied` 不再出现 OWNER / ADMIN / OPS，
改为「仅组织管理员可查看」；`claimRounds` 由「报销/索赔轮次」改为「处理轮次」（仅出现在详情折叠内）。

**案件详情主顺序（HOST §十二）**

```text
1. 追回什么（标题 + 任务编号 + 客户语言状态）
2. 金额（索赔金额 / 已回收，逐币种原样展示）
3. 当前进度（既有 RecoveryPipeline）
4. CrossClaim 正在做什么（当前阶段 + 材料状态）
5. 是否需要你操作（未提交 → 人工提交说明；否则「现在不需要你操作」）
6. 提交材料（claim 正文；round / version / status / isFinal 只在最深层「处理详情」折叠内）
7. 支持材料（evidence 列表；原始 kind / role 折叠进「处理详情」）
8. 最近动态（最近一次材料时间）
```

案件列表：去掉「Claim 轮次」列；状态列由 raw 状态码改为 `caseStatusLabel()` 客户语言；
表头改为「任务编号 / 追回内容 / 状态 / 索赔金额 / 已回收」。

| 项 | 结果 |
| --- | --- |
| web tsc | 0 |
| i18n | OK：5 语言 / 858 键 parity / 客户硬编码 **0** |
| UI render check | **163/163 OK**（新增 10 项 P6 字典/客户语言断言，含 no internal role codes） |
| 浏览器客户旅程 | **72/72 PASS**（新增：`/cases` 客户语言与无工程列、`/opportunities` 客户语言与无「工程字段」） |
| 浏览器证据目录 | `reports/acceptance/2026-10-07T16-07-44-182Z/` |
| 可靠性记录 | 本批次首次与第二次浏览器运行分别遇到 `net::ERR_INSUFFICIENT_RESOURCES` 与 signup 等待超时（本机 headless Edge 资源紧张，非代码问题）；清理未完成运行目录后第三次运行全绿，失败目录未入库 |

### 批次 2（P5）

| 项 | 结果 |
| --- | --- |
| web tsc | 0 |
| i18n | OK：5 语言 / 854 键 parity / 客户硬编码 **0** |
| UI render check | **153/153 OK**（新增 5 项导航顺序 / 无 admin 条目 / recoveries 路由字典断言） |
| 浏览器客户旅程 | **68/68 PASS**（新增：`/recoveries` 页面标题、能力列表可见、无 raw engineering exposure） |
| 浏览器证据目录 | `reports/acceptance/2026-10-07T16-00-29-549Z/` |
| 回归说明 | 唯一一次失败是本批次首次运行：`/recoveries` 与既有 `recoveriesPage` 命名空间重名导致 TSC1117；已改为复用既有命名空间后重跑全绿 |

边界：REAL_EXTERNAL_EXECUTION = NOT_EXECUTED；REAL_VALIDATION_COMPLETE = NO；PRODUCTION_READY = NO；
SECOND_RUNTIME = 0 / SECOND_SCHEDULER = 0 / SECOND_GUARD = 0；全部 HOLD / FORBIDDEN 不变。

## 下一批

**CUSTOMER-UI-PRODUCTIZATION-V2-FINAL**：把本记录 + exact HEAD + 证据目录 + 全量测试结果作为自包含验收包，
送入右侧独立 ChatGPT 审计通道（chatgpt-web-audit-bridge：先 durable 记录，再简短唤醒并校验送达，
裁决逐字归档 `tools/verification/archive-verdict.mjs` + `FULL_COPY_OK`）。
不复用上一轮 CUSTOMER ACCEPTANCE 的 CLOSED 作为本轮证据；未获外部 PASS / CLOSED 前不自行宣布完成。
