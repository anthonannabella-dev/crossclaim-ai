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
| P8 工程字段隔离 | QUEUED | 主 UI 去除「工程字段 / 技术字段」措辞，技术标识移入 Support/Admin diagnostics |
| P9 Connections 简化 | QUEUED | 客户主视图只答：连了什么 / 是否正常 / 最近同步 / 是否要重新授权 |
| P10 Mobile / a11y | QUEUED | 390×844 首屏 Goal + Money + Needs Attention 优先 |
| P11 i18n parity + hardcode scan | 持续 | 每个单元都跑；P1–P4 已加入 5 语言并 0 硬编码 |
| P12 全客户旅程回归 | QUEUED | 每批次跑真实浏览器旅程 |
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

P6 → P7 → P8 → P9 → P10 → P11 → P12 → CUSTOMER-UI-PRODUCTIZATION-V2-FINAL。
每个单元同样执行：IMPLEMENT → STATIC CHECK → web tsc → UI render check → i18n check →
真实浏览器客户旅程 → 定向回归 → commit → push → 更新本记录。
