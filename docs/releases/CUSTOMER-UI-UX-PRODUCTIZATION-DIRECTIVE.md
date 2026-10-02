# CUSTOMER UI / UX PRODUCTIZATION —— HOST DIRECTIVE REGISTER

来源：HOST DIRECTIVE（CrossClaim AI — Customer UI / UX 产品化重构实施要求），随附 Multi-Platform / Multi-Account 产品架构要求与 PLATFORM_API_APPROVAL_READINESS 并行准备线。
状态：**REGISTERED —— 设计优先、增量实施、不打断当前主线**。

## 0. 范围切分（重要）

| 指令内容 | 归属 | 处理 |
|---|---|---|
| CrossClaim Customer UI / UX 产品化（§产品定位 → §响应式） | **本仓库（CrossClaim）** | 本文档 §3 登记 + 排队 |
| Multi-Platform / Multi-Account 产品架构要求 | **本仓库** | §2 复用核查（已满足，无需重构） |
| PLATFORM_API_APPROVAL_READINESS | **本仓库** | §1（已登记） |
| Content OS / Hermes 56s 成片视觉训练（Shot Director 判据、B-roll 禁令、单变量实验） | **不属于本仓库**（Content OS 项目） | 未在本仓库登记；需在 Content OS 工作区落地 |
| Hermes Venture Intelligence OS v3.0 / 自动行业雷达 v6.1 / 全域商机雷达 + 需求真实性审计 | **不属于本仓库**（Venture Radar 项目） | 未在本仓库登记；需在该项目工作区落地 |

本仓库只登记与 CrossClaim 代码/产品相关部分，避免把无关领域写进 CrossClaim 领域文档。

## 1. PLATFORM_API_APPROVAL_READINESS（已登记，保持并行线）

- 既有落点：`docs/platform-approval/`（`PRIVACY_DATA_LIFECYCLE.md` 等）+ `.autopilot/STATE.json` 的 `platform_readiness_policy`（P1 Amazon / TikTok Shop / Walmart / Shopify；P2 WooCommerce；P3 later）。
- 统一接入原则已固化：Official API / OAuth → Platform Adapter → SourceConnection → SourceTransaction → CanonicalFact → Rule Engine → RecoveryOpportunity → Evidence / Case / Claim → Settlement → RecoveryLedger → Billing；禁止平台 SDK 进核心、禁止保存客户密码 / Cookie / 模拟登录作为生产接入。
- V1 = **READ-ONLY FIRST + LEAST PRIVILEGE + MINIMUM DATA**；REAL EXTERNAL WRITE 与自动提交继续 HOLD；AI Prepare → Human Review → Human Approve → Approved Submission。
- 边界未变：本线**不打断**主开发队列。

## 2. Multi-Platform / Multi-Account —— 复用核查（结论：**已满足，禁止另建模型**）

| 指令要求 | 仓库现状 | 结论 |
|---|---|---|
| 一个 Organization 同时连接多个平台 | `PlatformAccount.platform`（AMAZON / TIKTOK_SHOP / WALMART / SHOPIFY / UPS / FEDEX / DHL / CUSTOMS … 单列枚举） | ✅ 已支持 |
| 同一平台多个店铺 / seller account | `PlatformAccount` 唯一键 `(organizationId, platform, externalAccountId, identityVersion)`；1 account → N connections | ✅ C2 已交付（TRACK C2 = CLOSED） |
| 每个店铺/账号独立授权、独立同步、独立失效 | `SourceConnection`（`status` / `credentialRef` / `platformAccountId`）+ explicit bind/rebind + REVOKED 不得 ingest | ✅ 已交付（TRACK B / PC-06） |
| Organization 层统一汇总 | 既有 `RecoveryOpportunity` / `Case` / `Settlement` 均带 `organizationId`；`/accounts` 已提供 platform → accounts → connections 分组 | ✅ 已支持 |
| 客户可见「ALL ACCOUNTS + 分平台金额 + 展开到 Case」 | 需要 UI 层聚合投影（**仅 UI/投影，不改领域模型**） | ⏳ UI 阶段实施（§3 UI-2 / UI-5） |

**硬约束**：UI 必须复用 `PlatformAccount + SourceConnection + account provenance`，**不得**另建 UI 独立 account 事实模型。

## 3. Customer UI / UX 产品化（本仓库待实施）

### 3.1 产品定位与一级导航

- 定位：**资金追回控制台**（Stripe 可信度 / Ramp 结果导向 / Linear 信息密度），禁止机械复制皮肤，禁止「AI 炫技 Dashboard」。
- 客户一级导航：`Overview` · `Recoveries` · `Integrations` · `Reports` · `Billing`；`/operations`、`/admin/*` 保持内部 Console，不作为客户一级导航；`/upload` 归入 Integrations → Customs / Documents。
- 客户侧统一用 **Recoveries** 表达，不暴露 Case / ClaimItem / Settlement 等内部术语（API 不变）。

### 3.2 金额三层语义（禁止混用）

| 层 | 中文 | 事实要求 | UI |
|---|---|---|---|
| Potential Recovery | 潜在可追回 | 仅店铺 / 运单 / 初步交易数据 | **禁止绿色**；Estimated 标记；列出仍需哪些资料 |
| Verified Recoverable | 已确认可追回 | 官方账单 / Tracking / Rate Card / SLA Policy / POD / Customs 文档 / 平台正式记录，且经规则引擎与 Evidence 要求 | 蓝色 |
| Recovered | 已到账 | 必须对应 `Settlement` / `RecoveryPayout` 真实到账链路 | 绿色 |

**禁止**：`Claim Approved` → UI 显示「已到账」；无可靠事实来源 → 禁止生成「节省 238 小时」等虚构指标。

### 3.3 首屏 KPI 固定优先级

1) 已到账 2) 已确认可追回 3) 追回中；辅助：本月追回 / Opportunity 数 / Active Recovery 数 / Recovery Rate / 需用户操作数。「节省人工时间」不得作为首屏核心 KPI。

### 3.4 Action Center（必须真实状态驱动）

只展示真正需要客户参与的事项（OAuth 过期、需连接 UPS/FedEx、Customs 缺资料、需上传 7501 / C88 / 报关单、Claim 待人工批准、高金额 HITL、平台补件、Billing 必要动作）；**禁止**为了让 AI 看起来在工作而生成虚假任务；必须与既有 HITL / Action Guard / Approval Boundary 一致。

### 3.5 Evidence Drawer（核心信任组件）

必须能回答四问：为什么认为可以追回 / 用了什么证据 / 金额怎么算 / 最后向谁提交了什么。数据只能来自真实 `EvidenceArtifact` / `RuleEvaluation` / `RuleVersion` / `Claim` / Claim Tracking / `AuditLog` / `Settlement`；**禁止前端凭空拼接「Agent 已完成」状态**。

### 3.6 Progressive Authorization（与 PC-11A 契约一致）

Stage 1 先连 Marketplace → Stage 2 发现 Carrier potential 后再提示连接 UPS → Stage 3 Customs 走上传资料 / Broker Connector；**禁止**注册阶段强迫一次配置全部平台。UI 必须按 **真实 backend capability** 分别显示 tracking / invoice / POD / claim API 可用性（复用 PC-11A capability matrix 与提交模式语义：已自动提交 / 前往官方提交 / 资料包已准备）。

### 3.7 Executive Mode 与视觉方向

- **Light-first**（客户工作台默认 Light；Admin/Operations 可继续 Dark/Dense）；Executive Mode 隐藏 identifier 与技术状态，展示 Recovered / Verified Pipeline / Recovery Rate 与分通道金额（适合截图 / PDF / CFO）。
- Design Tokens 采用指令给定色板（Canvas #F7F8FA / Surface #FFFFFF / Border #E6E8EC / Primary #101828 / Secondary #667085 / Brand #5B5CE2 / Recovered #12B76A / Processing #2E90FA / Attention #F79009 / Critical #F04438 / Estimated #7F56D9）；**绿色只用于真实成功 / 到账**。
- 依赖控制：继续 Next 15 + React 19 + Tailwind；如需图标可评估 `lucide-react`；Accessibility 复杂交互可评估 Radix primitives；**禁止**一次引入大型 UI Framework；sparkline 首期用原生 SVG。

### 3.8 路由迁移映射

`/` → Overview；`/cases` → `/recoveries`（保留兼容或 redirect）；`/cases/:id` → `/recoveries/:id`；`/connections` → `/integrations`；`/upload` 并入 Integrations；`/billing` 保留；`/operations`、`/admin/*` 保持内部；**底层 API 不变**。

## 4. 实施顺序（PHASE UI-1 … UI-7，逐阶段 PROGRESS）

1. **UI-1** Design Tokens + AppShell + Sidebar + Topbar
2. **UI-2** Overview Dashboard（KPI / Action Center / Category Cards / Active Recoveries）
3. **UI-3** Recoveries List（过滤 + 高密度表）
4. **UI-4** Recovery Detail + Timeline + Evidence Drawer
5. **UI-5** Integrations + Progressive Authorization（含多账户与真实 capability 显示）
6. **UI-6** Executive Mode + Reports
7. **UI-7** Dark Mode + Mobile polish

每阶段验收：`build` PASS · `typecheck` PASS · 现有 API contract 不破坏 · 权限不回退 · masking 不回退 · tenant isolation 不回退 · **不新增虚假业务状态** · 不影响 C2 / Recovery / Settlement 主线。

## 5. 主线保护与门槛

- **不得**因本指令重置任务队列、停掉当前主线、改 Schema、改 API contract、另开平行业务模型；本需求是 **Customer Experience 层升级**，不是领域架构重建。
- 顺序：先收口 **PC-12A FINAL**（当前主线），再进入 **UI-1**；UI-2 起需要后端只读聚合投影时，先确认「是否已有 API 可复用」，**不得新增虚假状态**。
- **ARCH REVIEW REQUIRED**：任何为 UI 引入的 API/Schema 变更（当前评估：不需要）。
- **HOST APPROVAL REQUIRED**：无（本指令不涉及付费服务、生产部署、DNS、删除真实数据、Secret 轮换、真实账号授权或真实数据）。
- 边界保持：NO platform write · TRANSPORT=false · Payment = 0 · collection / autopay OFF · R13 HOLD · 无生产凭据。
