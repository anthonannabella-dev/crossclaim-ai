# Legacy Project Migration Audit

```yaml
Source:
  E:\zhuihuiweikuan-saas
Target:
  D:\crossclaim-ai
Audit date:
  2026-09-28
Auditor:
  Codex
Method:
  只读分析（读取源码、package.json、schema、docker-compose、git 历史）
  未修改旧项目业务代码、未改数据库、未改密钥、未推送旧项目到任何新远端
Status:
  DRAFT — 等待 ChatGPT 架构审计（PASS / REVISE / BLOCK）
```

> **阅读须知**：本文中每一个"事实"都来自对 `E:\zhuihuiweikuan-saas` 的实际读取，
> 不是推测。凡是我无法确认的，都明确标注为「需确认」。

---

## 0. 结论摘要（先看这里）

| 维度 | 结论 |
|---|---|
| 旧项目定位 | 出口报关合规 AI SaaS（**不是**资金追回） |
| 可直接复用（REUSE） | **平台底座**：多租户、鉴权、审计、对象存储、文档管线、任务队列、Webhook、许可证闸门 |
| 需要重构（REFACTOR） | 长流程状态机、计费、部分前端信息架构 |
| 应当废弃（REJECT） | **报关申报业务本身**（报关单/批次/报文/关税/CBAM/退税） |
| 最大风险 | 旧项目里**已经混入了 CrossClaim 的领域模型**（见 §16.1），必须分离 |
| 规模 | 后端 101 文件 / 17,865 行；前端 61 / 14,852；Prisma 39 个模型 |
| 许可证 | 旧项目自身 **MIT**；npm 直接依赖 99 个全部宽松（有 5 处需登记，见 §12） |

**一句话**：旧项目值得要的是**平台底座**，不是**业务**。而它的业务恰好占了大部分代码量——
迁移的价值密度集中在 `backend/src/{middleware,config,services/queue,services/webhook,services/ai}` 与 `ops/`。

---

## 1. Existing Architecture

### 1.1 模块全景

| 目录 | 角色 | 技术栈 | 规模 | 端口 |
|---|---|---|---|---|
| `backend/` | 主 API | Node 22 + TS 5.6 + Express 4 + Prisma 5 + PostgreSQL 16 | 101 文件 / 17,865 行 | 3000 |
| `frontend/` | 客户/运营后台 | React 18 + Vite 6 + Ant Design 5 + Zustand 5 | 61 文件 / 14,852 行 | 5173 |
| `hs-query-frontend/` | HS 编码查询站 | **Next 16 + React 19 + Tailwind 4 + shadcn/ui** | 10 文件 / 932 行 | — |
| `ocr_service/` | 单据 OCR 微服务 | Python + FastAPI + PaddleOCR | 1 文件 / 202 行 | 8002 |
| `bots/` | 通知机器人 | Node + Express（飞书/钉钉 webhook） | 1 文件 / 53 行 | 8001 |
| `data_fetcher/` | 数据采集 | Python（HS 编码/税率/CBAM） | 7 文件 / 2,760 行 | — |
| `tradeflow/` | Activepieces 自定义 pieces | TS（HS 分类/批量/税率/CBAM） | 13 文件 / 765 行 | — |
| `ops/` | 运维与门禁 | 脚本 + 配置 | — | — |
| `prisma/`、`backend/prisma/` | 数据模型 | Prisma（39 个 model） | — | — |

### 1.2 基础设施（docker-compose.yml）

```
postgres:16-alpine   redis:7-alpine   SeaweedFS(S3 :8333)
Activepieces :8081   backend :3000    ocr :8002   bots :8001   frontend :8080
（2026-09-28 新增）temporal :7233     temporal-ui :8088   ai :8003（profile=ai）
```

### 1.3 代码组织

- 后端 26 个路由文件 / 54 个服务文件，按 `routes/` + `services/` 分层，无领域分模块
- 状态机用**数据库字段 + node-cron 扫描**表达（`groupPipelineService` + `cronJobs`）
- 无依赖注入、无 repository 层，服务直接调用 Prisma

### 1.4 git 状态

```yaml
旧项目是否原本受版本控制: 否（2026-09-28 前无 .git）
当前: 已在旧项目内初始化 git（11→15 个提交），并【被推送到 GitHub】
```

> ⚠️ 见 §13.1：**旧项目当前正躺在 GitHub 的 main 上**，这与「E: 不作为正式仓库」的定位冲突。

---

## 2. Reusable Modules（建议 REUSE）

以下模块与「报关」业务**无耦合**，是通用 SaaS 底座，可整体搬迁。

| 模块 | 文件 | 为什么可复用 | 迁移代价 |
|---|---|---|---|
| 多租户鉴权 | `middleware/auth.ts`、`routes/routes/auth.ts`、`routes/routes/apiTokens.ts` | JWT + bcryptjs + `ApiToken` + 登录失败锁定 + 密码重置，成熟 | 低 |
| 租户生命周期 | `services/tenantService.ts`、`routes/routes/tenantSelfService.ts`、`services/autoRenewal.ts` | 试用期/冻结/套餐/续费状态机 | 中（与计费耦合，需拆） |
| 审计 | `services/auditService.ts`、`services/documentAuditService.ts`、`AuditLog` | 已具备 entity 关联（migration `add_auditlog_entity_link`） | 低 |
| 对象存储 | `minio` 客户端 + SeaweedFS | S3 兼容，`Evidence.fileKey` 直接可用 | 低 |
| Webhook | `services/webhook/{eventEmitter,deliverer,eventTypes,index}.ts` + `WebhookSubscription/Delivery` | 事件投递 + 重试 + 订阅模型 | 低 |
| 任务队列 | `services/queue/pipelineQueue.ts`（BullMQ） | 批量任务（导入/OCR/解析）正是 CrossClaim 需要 | 低 |
| 文件解析 | `parseFile.ts`（ExcelJS + PapaParse）＝**本次新写** | 直接就是 CrossClaim 的 ImportAdapter 雏形 | 极低（已在 CrossClaim 形态） |
| 导入编排 | `services/recovery/import/index.ts` ＝**本次新写** | 批次留痕 + 行级失败 + PARTIAL 语义 | 极低 |
| 文档能力 | `pdf-parse`、`tesseract.js`、`mammoth`、`archiver`、`sharp`、`jspdf`、`aliyunOcr.ts` | 单据处理工具箱 | 低 |
| OCR 微服务 | `ocr_service/`（FastAPI + PaddleOCR） | 独立服务，跨语言无耦合 | 低 |
| AI 客户端 | `services/ai/deepseek.ts`、`services/ai/smartClassify.ts` | 模型调用封装（含缓存与限流） | 中（需接 LangGraph） |
| 许可证闸门 | `ops/license-gate/` | 扫描器 + allowlist + CI，**与业务无关** | 低（可直接搬） |
| 观测 | `winston` + `morgan` + `healthService` | 日志与健康检查 | 低 |

---

## 3. Refactor Candidates（建议 REFACTOR）

| 模块 | 旧做法 | 为什么要改 | 改成什么 |
|---|---|---|---|
| 长流程状态机 | 状态字段 + `node-cron` 每 10 分钟扫"卡死" + 恢复补丁 | 跨天/跨周流程无法可靠表达；恢复靠猜 | **Temporal workflow**（CrossClaim 已装 SDK） |
| 批处理调度 | `groupPipelineService` 里 `process.nextTick` + BullMQ 混用 | 职责不清 | Temporal 管长流程；BullMQ 只管分钟级批处理 |
| 计费/支付 | `services/payment/*` + `TimeGrant` + `Payment` | 与报关套餐语义绑定 | 抽象为 `Settlement`/Billing，独立模块 |
| 通知 | `notificationHub` + `emailService` + `smsService` + `bots/` | 渠道分散 | 统一 Notify 适配层（邮件/短信/IM） |
| 前端信息架构 | `frontend/`（AntD，61 文件） | 视觉与技术栈与 CrossClaim 目标不一致 | 不作为 UI 基础；仅参考「列表-详情-审核」结构 |
| `hs-query-frontend/` | Next 16 + shadcn/ui，仅 932 行 | 技术栈**正是** CrossClaim 想要的 | 作为 CrossClaim 前端**脚手架**，业务页重写 |
| AI 调用 | Prompt 硬编码在服务内 | 难迭代、难审计 | 抽为 Prompt 资源 + LangGraph 节点 |

---

## 4. Reject / Remove（建议 REJECT）

| 模块 | 文件/模型 | 拒绝理由 |
|---|---|---|
| 报关申报领域 | `declarationBuilder.ts`、`declarationService.ts`、`declarationElements.ts`、`Declaration`、`BatchGroup`、`GroupValidation` | CrossClaim 不产生报关单报文 |
| 报关 XML | `generateCustomsXML` / `buildEcommerceXml`（附8 系列） | 海关报文与资金追回无关 |
| 关税与 CBAM | `cbamCalculator.ts`、`carbonPricingUpdater.ts`、`CBAMRecord` | 与追回业务不同（**但见 §16.2 的例外**） |
| 退税 | `taxRebate*.ts`、`TaxRebateRecord` | 同上 |
| HS/原产地规则库 | `HSCode`、`FtaAgreement`、`OriginRule`、`RCEPRule`、`data_fetcher/` | 报关归类专用（**例外见 §16.2**） |
| Activepieces | `tradeflow/activepieces-main`（第三方完整仓库）+ `Activepieces` 容器 | MIT 核心但 `ee/` 另授权；不引入 |
| 代理/VPS 工具链 | `proxy_switch.ps1`、`vultr_*`、`hysteria*`、`.hermes*` | 与产品无关，且含凭据 |
| 第三方 UI 工具 | `claudecodeui/`（**AGPL-3.0**） | 强 copyleft，已移出 |
| 交付包痕迹 | `_tmp_patch/`、根目录散落 `.ts/.tsx`、`fixed_*.js`、`dist_old_bak/` | 三层重叠、应用状态不一致 |

---

## 5. Database Models（39 个）

### 5.1 到 CrossClaim 的映射

| 旧模型 | 处置 | 映射到 CrossClaim | 说明 |
|---|---|---|---|
| `Tenant` | **REUSE** | `Tenant` / `Organization` | 多租户根基，保留 |
| `SubAccount` | **REFACTOR** | `User` / `Member` | 需补细粒度角色（现默认 `operator`，无权限矩阵） |
| `AuditLog` | **REUSE** | `AuditLog` | 已有 entity 关联 |
| `ApiToken` | **REUSE** | `ApiToken` | 渠道/外部接入都用得上 |
| `Document` | **REFACTOR** | **`Evidence`** | 需补 `sha256`、`kind`、来源 |
| `SupplierInvoice`、`ExportInvoice`、`ReceiptRecord` | **REFACTOR** | **`RecoveryLedger`** 分录 | 现为"收付款"语义，需转成"可追回/已追回" |
| `Payment`、`TimeGrant`、`TenantUsage` | **REFACTOR** | `Settlement` / Billing | 订阅计费 |
| `WebhookSubscription`、`WebhookDelivery` | **REUSE** | 同名 | 事件外发 |
| `HSCode`、`FtaAgreement`、`OriginRule`、`RCEPRule` | **REJECT**（有条件） | — | 见 §16.2 |
| `Declaration`、`BatchGroup`、`GroupValidation` | **REJECT** | — | 报关专用 |
| `CBAMRecord`、`TaxRebateRecord`、`PolicyAlert`、`Announcement`、`LicenseRecord`、`RecordArchive` | **REJECT** | — | 报关/合规业务 |
| `Admin`、`EmailVerificationToken`、`PasswordResetToken`、`LegalConsent`、`ApiCallLog` | **REUSE** | 同名/合并 | 平台支撑 |
| **`LossSignal`、`RecoveryCase`、`CaseSignal`、`Claim`、`Evidence`、`RecoveryLedgerEntry`、`ChannelAccount`、`ImportBatch`** | **REFACTOR + 改名** | 见 §16.1 | ⚠️ **这 8 个是我在旧项目里新增的 CrossClaim 模型** |

### 5.2 与 CrossClaim 规范模型的差异（重要）

CrossClaim 的规范模型是：`RecoveryOpportunity` / `RecoveryGraph` / `EvidenceGraph` /
`RecoveryRouting` / `RecoveryLedger` / `Case` / `Settlement` / `RuleEngine`。

| 我建在旧项目里的 | 应对应到 | 差异 |
|---|---|---|
| `LossSignal` | **`RecoveryOpportunity`** | 改名即可，语义一致 |
| `RecoveryCase` | **`Case`** | 改名 |
| `Evidence` | **`EvidenceGraph`** 的节点 | 缺"图"结构（节点/边） |
| — | **`RecoveryGraph`** | **完全缺失** |
| — | **`RecoveryRouting`** | **完全缺失** |
| `RecoveryLedgerEntry` | `RecoveryLedger` 分录 | 概念一致，命名需对齐 |
| — | **`Settlement`** | **完全缺失** |
| — | **`RuleEngine`** | **完全缺失**（旧项目规则是硬编码常量） |
| `Claim` / `CaseSignal` / `ChannelAccount` / `ImportBatch` | 无直接对应 | 建议保留为支撑表 |

**结论：不要把旧项目里的这 8 个表原样搬过去。** 以 CrossClaim 规范模型为准，它们只作为"字段设计参考"。

---

## 6. Authentication / Tenant

| 能力 | 旧项目现状 | 可复用性 |
|---|---|---|
| 多租户隔离 | `Tenant` + 全表 `tenantId` | ✅ 直接复用 |
| 登录 | JWT（`jsonwebtoken`）+ bcryptjs | ✅ |
| 子账号 | `SubAccount`（含 `role`，默认 `operator`） | ⚠️ 需补权限矩阵 |
| API 令牌 | `ApiToken` + 外部网关 `/submit-once`（限流+审计） | ✅ |
| 登录防护 | 失败次数 + 锁定 + 密码重置令牌 | ✅ |
| 第三方登录 | 微信 openId/unionId 字段（`add_wechat_fields` 迁移） | ✅ |
| 合规留痕 | `LegalConsent` | ✅ |
| **缺失** | OAuth/SSO、2FA、细粒度 RBAC、组织层级 | ❌ 需新做 |

> 旧项目**没有** Better Auth / NextAuth。若 CrossClaim 要 SSO，需要在 REFACTOR 时叠加。

---

## 7. File / Document Pipeline

### 7.1 已有能力

| 能力 | 实现 | 状态 |
|---|---|---|
| PDF 文本抽取 | `pdf-parse` | ✅ 可用（纯文本 PDF） |
| 图片 OCR | `tesseract.js` | ✅ 可用 |
| 中文扫描件 | `ocr_service/`（PaddleOCR，独立容器） | ✅ 可用 |
| 云 OCR 兜底 | `aliyunOcr.ts`（阿里云 OCR API） | ✅（需密钥） |
| Word | `mammoth` | ✅ |
| 打包/压缩 | `archiver`、`jszip` | ✅ |
| 图像处理 | `sharp` | ✅ |
| PDF 生成 | `jspdf`、`pdfGenerator.ts` | ✅ |
| Excel/CSV | `exceljs` + `papaparse`（**本次新装**） | ✅ |
| 版面/长文档解析 | — | ❌ **缺**（Docling 待接入） |

### 7.2 已知缺口

- 无统一的"文档 → 结构化字段"契约（每个业务各写各的抽取逻辑）
- `sampledocs/` 的样板单是**图片型 PDF**（无文本层），只能走 OCR
- 无文档去重（`sha256` 是我新增 `Evidence` 时才加的）

---

## 8. AI / Agent

| 项 | 现状 |
|---|---|
| 模型 | **DeepSeek**（`services/ai/deepseek.ts`，OpenAI SDK 兼容层） |
| 调用点 | `aiPreCheckSupplement`（合规预检补充）、`smartClassify`（HS 归类） |
| 缓存/限流 | `cacheGet/cacheSet`（Redis）+ `p-limit` 并发控制 |
| Prompt 管理 | ❌ **硬编码在服务源码里** |
| Agent 编排 | ❌ 无（无 LangGraph / 无工具调用） |
| 结构化输出校验 | ⚠️ 部分（`verify_deepseek*.js` 是散落脚本） |
| 幻觉防护 | ⚠️ 弱：AI 输出直接进 `issues` 数组（`category:'ai_analysis'`） |

**结论**：AI 调用**封装可复用**，"AI 参与判定"的用法**不可复用**——
CrossClaim 已定红线「AI 只出建议，不改账本」，旧项目没有这条红线。

---

## 9. Workflow / Jobs

| 机制 | 位置 | 评价 |
|---|---|---|
| 长流程 | `groupPipelineService.ts` + 状态字段 | ⚠️ 用字段拼状态机，跨天流程不可靠 |
| 卡死恢复 | `cronJobs.ts`（每 10 分钟扫描） | ⚠️ **补丁式**，是旧项目最大技术债 |
| 批处理队列 | `services/queue/pipelineQueue.ts`（BullMQ） | ✅ 可用 |
| 定时任务 | `node-cron`（`cronJobs`、`autoRenewal`、`hsCodeUpdater`、`ftaUpdater`、`taxRebateUpdater`、`carbonPricingUpdater`、`policyMonitor`） | ✅ 可用（除报关相关） |
| 持久化工作流 | — | ❌ **缺**（Temporal 已装 SDK，未写 workflow） |

**迁移建议**：不要移植 `groupPipelineService` 的状态机；用 Temporal 重写。
BullMQ 与 `cronJobs` 的**调度骨架**可复用。

---

## 10. Frontend / UI

| 项目 | 技术 | 可复用性 |
|---|---|---|
| `frontend/` | React 18 + Vite + AntD 5，61 文件 | ⚠️ **不作为 CrossClaim UI 基础**；可参考 `DeclarationComparePage`（逐条差异对比）、`BillOfLadingCheckPage`（核对流）、`ArchiveSearchPage`（检索）的**信息架构** |
| `hs-query-frontend/` | Next 16 + Tailwind 4 + shadcn/ui | ✅ **作为 CrossClaim 前端脚手架**（技术栈正是目标栈），业务页重写 |

可复用的**交互模式**（非代码）：
卡片式统计 + 列表筛选 + 详情抽屉 + 审核动作 + 导出。

---

## 11. External Integrations

| 集成 | 用途 | 迁移建议 |
|---|---|---|
| 阿里云 OCR | 单据识别 | ✅ 保留（可切换） |
| DeepSeek | LLM | ✅ 保留 |
| 微信支付 / 支付宝 | 订阅收款 | ✅ REFACTOR 为通用 Billing |
| 飞书 / 钉钉 Webhook | 通知 | ✅ 保留 |
| SMTP | 邮件 | ✅ 保留 |
| SeaweedFS（S3） | 文件存储 | ✅ 保留 |
| Activepieces | 工作流外挂 | ❌ REJECT |
| 中国海关单一窗口数据 | HS/监管码 | ❌ REJECT（除非走 §16.2） |

---

## 12. License Audit

### 12.1 旧项目自身

```yaml
根 LICENSE: MIT License, Copyright (c) 2026 Customs Compliance AI SaaS
```

→ 自有 MIT 代码迁移到 CrossClaim 无法律障碍（同一权利人）。

### 12.2 依赖（使用 `ops/license-gate/check-licenses.mjs` 实测）

```yaml
扫描范围: 99 个已安装的直接依赖（root / backend / frontend / hs-query-frontend / bots）
结果: 全部落在 allow 档，未命中任何 GPL / AGPL / SSPL / BSL / source-available
```

**5 处必须登记或处理的项**（已写入 `ops/license-gate/allowlist.json` 的例外表）：

| # | 项 | 情况 | 处置 |
|---|---|---|---|
| 1 | `jszip` | `(MIT OR GPL-3.0-or-later)` 双许可 | 锁 MIT 分支 |
| 2 | `xlsx@0.18.5` | 最后一个放开源许可的 SheetJS 版本 | 迁移到 ExcelJS（本次已装） |
| 3 | `minio` 客户端 | 客户端 Apache-2.0 可用；**MinIO 服务端是 AGPL-3.0** | 继续用 SeaweedFS，禁用 MinIO 服务端 |
| 4 | `tradeflow/activepieces-main` | MIT Expat 核心 + `packages/ee/` 另授权 | 只作外部外挂，不进运行时 |
| 5 | `redis:7-alpine` | Redis 7 是 BSD-3；**Redis 8+ 转 AGPLv3/RSALv2** | 钉住 7.x |

### 12.3 未覆盖范围（**需在 CrossClaim 补齐**）

- ❌ **Python 侧未做许可证扫描**（`pip-licenses` 未接入）→ `ocr_service`、`ai_service`、`data_fetcher` 的依赖未被审计
- ❌ **传递依赖未扫**（只扫直接依赖）→ 需 SBOM 工具
- ❌ **模型权重未审计** → 见 §13.4
- ⚠️ `docling` 代码 MIT，但**其加载的模型权重各有许可证**，必须逐条登记

---

## 13. Security Risks

### 13.1 🔴 旧项目当前正躺在 GitHub 的 main 上（**定位冲突**）

前序会话中，旧项目整体（418 文件 / 15 提交）被推送到了
`github.com/anthonannabella-dev/crossclaim-ai` 的 `main`。

按本轮定位，E: 是**旧项目**、D: 才是正式仓库 → **远端 main 的内容与预期不符**。

```yaml
影响: CrossClaim 正式仓库当前装的是旧报关 SaaS 代码
未受损: 旧项目本地完整；远端历史可直接回退到 444a246（占位 commit）
需决策: 见 §17 问题 1
```

### 13.2 🔴 明文凭据（历史 + 当前）

> **本文档刻意不复述任何凭据取值。** 审计只需说明"泄露了什么类别、处置到什么程度"，
> 不需要、也不应该把凭据本身再写一遍——否则文档自身就成了新的泄露源。

| 项 | 状态 |
|---|---|
| `config.yaml`（第三方代理客户端配置：**服务器地址 + auth 凭据**，取值此处不列） | ✅ 已从**全部 git 历史**清除，且**从未到达远端**（按内容扫描全部提交，0 命中） |
| `.env`、`backend/.env`（含 DeepSeek/OpenAI/DB/Redis/SeaweedFS/JWT/支付宝/微信/SMTP 凭据） | ⚠️ 文件仍在磁盘（本机开发必需），**未进 git**；**凭据本身尚未轮换** |
| `.vultr_pwd`、`vultr_key.txt`、`_ap_token.txt`、`.token_cache` | ✅ 已移出仓库并加入 `.gitignore` |
| `verify.sh` | ⚠️ 含本地开发用口令（与 `.env` 真实值不同；同类示例本已在 `CLAUDE.md` 中公开） |

> **待办**：凭据轮换仍未执行（只有用户本人能做）。

### 13.3 其他

| 风险 | 说明 |
|---|---|
| `backend/certs/` 存在于磁盘 | 未被 git 跟踪 ✅；需确认是否需要保留 |
| Docker Desktop 未配出网代理 | 所有 `docker.io` 拉取失败（本环境走 `docker.m.daocloud.io` 镜像源） |
| 根目录散落运维脚本 | `deploy-live.sh` 含 `CONTAINER_NAME=customs-backend` 等部署假设 |
| 无鉴权扫描 | 未见 route 级权限矩阵；26 个路由文件靠 `authenticate` 中间件统一把关（需逐路由复核） |

### 13.4 模型许可证（未审计）

`MODEL_LICENSES.md` 模板已建，但**内容全是"待核实"**。
在启用 Docling / PaddleOCR 的任何模型前必须填实。

---

## 14. Technical Debt

| # | 债务 | 证据 |
|---|---|---|
| 1 | **三层重叠"交付包"** | 根目录散落 `.ts/.tsx` + `_tmp_patch/` + 真正的产品代码，应用状态不一致（已语义比对确认均为旧版/等版） |
| 2 | **测试长期不可运行** | `jest-util` 是 ts-jest 的 peerDependency 且顶层缺失；`p-limit@7` 纯 ESM 无法在 Jest CJS 下加载 → 曾 0 套件可跑（本次修复后可跑 17 套件 / 131 用例） |
| 3 | **文档与代码不符** | `修复说明.md` 附2/附3/附8 声称已实现并"5/5 通过"，实际实现**不在仓库里**（从隔离区找回 7/9，另 2 个为新写） |
| 4 | 源码目录内散落备份 | `groupPipelineService.ts.{bak,cleanbak,diagbak,finalbak,regexbak}`、`declarationBuilder.ts.ecombak` |
| 5 | 生成物重复 | 根目录 `declElements.generated.json`(664KB) 与 `backend/data/` 完全重复 |
| 6 | Prompt 硬编码 | AI 提示词写在服务源码中 |
| 7 | 跨平台脚本 | `apply_patch.sh`、`cleanup.sh` 是 bash，Windows 环境不可用 |
| 8 | CI 覆盖不全 | `.github/workflows/ci.yml` 只覆盖 backend；前端无 CI；许可证门禁为本次新增 |
| 9 | 状态机补丁化 | 见 §9 |
| 10 | 单机假设 | `docker-compose.yml` 写死 `host.docker.internal:7890` 代理（已改为可覆盖变量） |

---

## 15. Migration Plan（建议顺序）

> 原则：**先底座后业务；每步独立 PR + 测试 + 架构复审**。

```yaml
Wave 0 · 地基（无业务依赖，风险最低）
  - ops/license-gate/            → 整体搬入 CrossClaim
  - 多租户与鉴权                 → Tenant/SubAccount/ApiToken/AuditLog 迁移
  - 对象存储 + 审计               → SeaweedFS 客户端 + auditService

Wave 1 · 数据进出
  - services/recovery/import/    → 已是 CrossClaim 形态，直接搬 + 测试
  - ExcelJS / PapaParse          → 已装
  - 文档管线（pdf-parse/tesseract/mammoth/sharp/aliyunOcr）
  - ocr_service/                 → 作为独立容器接入

Wave 2 · 长流程
  - Temporal workflow 骨架       → 用旧项目的"状态流转"作为需求输入，**代码不搬**
  - BullMQ 队列骨架              → 搬
  - Webhook 事件系统             → 搬

Wave 3 · 智能层
  - ai_service/（Docling + LangGraph）→ 在 CrossClaim 内建设
  - DeepSeek 客户端               → 搬封装，Prompt 外置
  - Model License 登记            → 启用模型前必须完成

Wave 4 · 边界业务（需 ChatGPT 裁决，见 §16.2）
  - 关税/HS/原产地 相关代码是否有条件复用

Reject（不迁移）
  - 报关申报/报文/批次/退税/CBAM 业务代码与模型
```

---

## 16. Architecture Conflicts

### 16.1 ⚠️ 旧项目里已被写入 CrossClaim 模型（必须分离）

**这是本次审计发现的最重要冲突。**

2026-09-28 的会话中，CrossClaim 的追回领域模型（8 个表 + 9 个枚举）被**加进了旧项目的
`backend/prisma/schema.prisma`**，并生成了迁移
`20260928120000_add_recovery_domain`（纯增量，未破坏旧表）。

```yaml
问题: CrossClaim 的领域模型不该存在于旧项目里
风险: 旧项目被继续当作"报关产品"使用时，会带着一套用不上的追回表；
      而 CrossClaim 若从旧项目继承 schema，会把错误命名带过去
建议: 以 CrossClaim 规范模型为准（RecoveryOpportunity/RecoveryGraph/...），
      旧项目里的这 8 个表作为【字段设计参考】，不直接迁移
需决策: 是否从旧项目回滚这 8 个表与迁移？
```

### 16.2 边界情况：关税/HS 是否该 REJECT？

CrossClaim 的渠道包含 **CUSTOMS（关税追回：多缴、退税、反倾销保证金）**。
旧项目在 HS 归类、税率、原产地规则、CBAM 上有**真实数据与算法**。

```yaml
两种取向:
  A. 完全 REJECT —— 保持 CrossClaim 架构纯净，关税追回晚些自建
  B. 有条件 REUSE —— 仅复用【数据】（HSCode/税率/原产地规则）与【计算函数】，
     不复用【报关申报流程】
倾向: B（数据与算法是资产，流程不是）
需决策: §17 问题 4
```

### 16.3 其他冲突

| 冲突 | 说明 |
|---|---|
| 单体服务 vs 领域模块 | 旧项目按技术分层（routes/services），CrossClaim 需要按领域（recovery/evidence/settlement） |
| AI 参与判定 | 旧项目 AI 输出直接进预检结论；CrossClaim 红线是「AI 只出建议」 |
| 队列语义混用 | 旧项目 Temporal 该管的事用 cron 管 |
| 单前端 vs 双前端 | 旧项目有 React/AntD 与 Next/shadcn 两套，需明确只留 Next 一线 |

---

## 17. Questions For ChatGPT

> 以下问题**必须由架构方裁决**，Codex 不应自行决定。

```yaml
Q1. 远端 GitHub main 的处置
    现状: main 上是旧项目（418 文件），与「D: 才是正式仓库」冲突
    选项: (a) 回退 main 到占位 commit 444a246
          (b) 把旧项目保留为独立分支 legacy/zhuihuiweikuan-saas-snapshot，
              再把 main 回退，供后续审计参考
          (c) 暂时不动，等 CrossClaim 首批代码就绪后整体覆盖
    我需要: 明确选择

Q2. 旧项目里那 8 个 CrossClaim 模型（见 §16.1）是否回滚？

Q3. 旧项目的【多租户 + 鉴权 + 审计 + Webhook + 队列】是否确认为
    CrossClaim 的底座，直接迁移（REUSE）？还是要求 CrossClaim 全新实现？

Q4. 关税/HS/原产地数据与算法：REJECT 还是有条件 REUSE？（见 §16.2）

Q5. CrossClaim 的规范模型（RecoveryOpportunity / RecoveryGraph /
    EvidenceGraph / RecoveryRouting / RecoveryLedger / Case /
    Settlement / RuleEngine）是否已有准确定义（字段级）？
    若有，请给出，我按它建 schema；若无，由谁定义？

Q6. 首批允许 Codex 开始迁移的模块是哪些？（建议 Wave 0：license-gate + 鉴权底座）

Q7. 「AI-ARCHITECT-INBOX」的协议格式是否就是本仓库根目录的
    AI-ARCHITECT-INBOX.md？回复是否也写在同一个文件？
```

---

*本报告为只读审计产出，未对 `E:\zhuihuiweikuan-saas` 做任何新的业务改动。*
*等待 ChatGPT 输出：PASS / REVISE / BLOCK + REUSE/REFACTOR/REJECT 清单 + NEXT。*
