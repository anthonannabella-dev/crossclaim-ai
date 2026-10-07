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
| P5 Navigation | QUEUED | 一级导航已由上一单元分层，本轮复核与文案对齐 |
| P6 Opportunity / Case 客户语言 | QUEUED | Opportunity→追回机会 / Case→追回任务 / Claim Package→提交材料 / Evidence→支持材料 |
| P7 Authorization UX | QUEUED | 「CrossClaim 可以替你做什么」+「以下情况仍会先问你」+ 撤销入口显性化 |
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

## 证据（exact HEAD 见提交）

| 项 | 结果 |
| --- | --- |
| web tsc | 0 |
| i18n | OK：5 语言 / 851 键 parity / 客户硬编码 **0** |
| UI render check | **148/148 OK**（新增 10 项：Goal Hero 上限 4 建议 / 无 raw domain / 无任务计数 / Active Recovery 映射与上限 / 空状态 / 无内部状态码） |
| 浏览器客户旅程（真实 Edge + HTTP + PostgreSQL；desktop 1440×900 + mobile 390×844） | **65/65 PASS**（新增：hero-first、Hero 在金额之前、Active Recovery 可见、无「工程字段/技术字段」、首页无内部角色码、目标结果区无 raw code / 任务计数） |
| 浏览器证据目录 | `reports/acceptance/2026-10-07T15-52-05-717Z/` |
| api tsc | 0（本轮未改 `apps/api`） |

边界：REAL_EXTERNAL_EXECUTION = NOT_EXECUTED；REAL_VALIDATION_COMPLETE = NO；PRODUCTION_READY = NO；
SECOND_RUNTIME = 0 / SECOND_SCHEDULER = 0 / SECOND_GUARD = 0；全部 HOLD / FORBIDDEN 不变。

## 下一批

P5–P8（导航复核与文案对齐、Opportunity/Case 客户语言降级、Authorization 产品化、工程字段隔离），
每批同样执行：实现 → 定向测试 → 浏览器旅程 → commit → push。
