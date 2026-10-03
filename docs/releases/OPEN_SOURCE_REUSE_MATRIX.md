# OPEN_SOURCE_REUSE_MATRIX

> 持久规则依据：`.autopilot/RULES.md` **R10 开源优先复用 + 商用许可证统一机制**；机器可读镜像 `.autopilot/rules.json` → `open_source_reuse`。
> 登记表：`tools/license-gate/oss-registry.json`（校验器 `tools/license-gate/check-oss-registry.mjs`，挂在既有 `license-gate` CI job）。
> 模型权重：`MODEL_LICENSES.md`（代码许可 ≠ 权重许可，必须分开登记）。

## 0. 分类定义

| 分类 | 含义 |
| --- | --- |
| `EXISTING` | 当前 CrossClaim 仓库已有能力 → 直接复用 |
| `LEGACY_REUSE` | 旧 `zhuihuiweikuan-saas`（只读）有可迁移能力 |
| `OSS_NOW` | 当前阶段应立即接入的成熟开源组件 |
| `OSS_LATER` | 当前只保留接口，后续再接 |
| `REJECT` | 许可证 / 架构 / 维护性 / 安全性不适合，不引入 |

> 通用基础能力**不得重复自研**：只要矩阵里已有成熟方案（EXISTING / LEGACY_REUSE / OSS_NOW），就必须复用。


## 0.5 EXISTING —— 已在生产使用的核心依赖（直接复用，禁止再造同类基础能力）

| 依赖 | 分类 | 许可证 | 等级 | 商用 | 备注 |
| --- | --- | --- | --- | --- | --- |
| `@prisma/client` / `prisma` | `EXISTING` | Apache-2.0 | A | YES | 唯一 ORM；禁止引入第二套 ORM（如 SQLAlchemy） |
| `next` | `EXISTING` | MIT | A | YES | 前端框架 |
| `react` / `react-dom` | `EXISTING` | MIT | A | YES | 前端 UI |
| `redis` | `EXISTING` | BSD-3-Clause（7.x 钉住） | A | YES | 禁止升级 8+（AGPLv3 / RSALv2） |
| `xlsx` | `EXISTING` | Apache-2.0（0.18.5 钉住） | A | YES | 禁止升大版本；计划迁移 `exceljs`(MIT) |
| `minio-client` | `EXISTING` | Apache-2.0（客户端） | A | YES | 服务端必须继续用 SeaweedFS（Apache-2.0），禁止部署 MinIO 服务端（AGPL） |

## 1. AI / Agent 层

链路目标：`Recovery OS → AI service interface → FastAPI → Pydantic structured output → LangGraph → DeepSeek / Claude / 其他模型`；
文档解析由 **Docling** 等承担；AI 只负责理解、抽取、解释、证据推荐、Claim / Appeal 草稿。

| 能力 | 分类 | 组件 | 许可证 | 商用 | 边界 |
| --- | --- | --- | --- | --- | --- |
| AI service interface | `OSS_NOW` | **FastAPI** | MIT | YES | 仅 AI 服务层；不得承载领域事务 |
| structured output / 校验 | `OSS_NOW` | **Pydantic** | MIT | YES | 输出 schema 化，禁止自由文本决定业务事实 |
| agent orchestration | `OSS_NOW` | **LangGraph** | MIT | YES | 编排仅限 AI 侧；不进入 Postgres 事务边界 |
| 文档解析 | `OSS_NOW` | **Docling**（代码 MIT） | MIT（代码） | YES（代码） | **每个模型权重单独登记**，未核实不得进生产 |
| 模型调用 | `OSS_LATER` | DeepSeek / Claude 等 API | 商业条款（非开源） | REVIEW | 需审「数据是否用于训练」等条款；不得由 LLM 决定业务事实 |
| 中文扫描件补充 OCR | `OSS_LATER` | PaddleOCR | Apache-2.0 | YES（受限） | 仅在 Docling 中文效果不足时启用 |

**永远不得交给 LLM 决定**：金额 · Fee / Success Fee · Deadline · Ledger · Settlement · Billing · 状态推进 · 权限判断 · 审批消费（继续由确定性代码 / SQL / Rule Engine 控制）。

## 2. 文档 / OCR / 解析层

| 能力 | 分类 | 组件 | 许可证 | 商用 | 边界 |
| --- | --- | --- | --- | --- | --- |
| PDF / DOCX / 图片 / 扫描件解析 | `OSS_NOW` | Docling | MIT（代码） | YES（代码） | 权重另登记；自动下载模型必须双许可检查 |
| XLSX / CSV 表格解析 | `OSS_NOW` | ExcelJS（MIT）、PapaParse（MIT） | MIT | YES | 替换旧 `xlsx`（SheetJS 版本已钉住） |
| 自研完整解析引擎 | `REJECT` | — | — | — | 许可证不是问题，**架构上是重复造轮子** |

## 3. 外部平台 Connector / Adapter

结构固定：`Platform SDK / HTTP → Adapter → Canonical ingest → CanonicalFact → Rule Engine → RecoveryOpportunity → Recovery OS`。
平台 SDK、认证、分页、限流、字段命名**不得**写进 Recovery OS 核心。

| 平台 | 分类 | 接入方式 | 说明 |
| --- | --- | --- | --- |
| Amazon（SP-API） | `OSS_NOW`（官方 SDK/HTTP）/ `EXISTING`（读取链路已建） | 官方 API + 薄 Adapter | 任何真实写回继续 HOLD |
| TikTok Shop / Walmart | `OSS_LATER` | 先定 Adapter 接口 | 未获授权前不得接真实凭据 |
| UPS / FedEx / DHL | `OSS_LATER` | 先定 Adapter 接口 | 同上 |

## 4. 外围自动化（只允许：通知 / 定时 / Webhook / 非关键同步 / 非关键搬运 / 内部运营自动化）

| 工具 | 分类 | 许可证 | 判定 |
| --- | --- | --- | --- |
| Activepieces（core） | `OSS_LATER` | MIT（core）/ `packages/ee` 另授权 | MIT 部分可候选；**ee/enterprise 不得当 MIT 用**；仅外围 |
| n8n | `REJECT`（作为依赖） | Sustainable Use License | 不作为普通开源依赖；仅「受限外围工具」评估；不得嵌入客户产品 / 不得默认托管客户凭据；Embed/Enterprise 商业许可单独立项 |
| Temporal | `OSS_LATER` | MIT | 仅在确需 durable workflow 时评估；不得替代 Postgres 事务 |
| Stagehand（浏览器 Agent） | `OSS_LATER` | MIT | 阶段 3 才评估；不得绕过 Action Guard 与真实外写 HOLD |

## 5. 许可证等级（与 `tools/license-gate/allowlist.json` 同源）

| 等级 | 内容 | 处置 |
| --- | --- | --- |
| **A** | MIT / Apache-2.0 / BSD-2 / BSD-3 / ISC / 其他宽松商用许可 | 默认可进入候选 |
| **B** | GPL / LGPL / AGPL / MPL / EPL / BSL / SSPL / Sustainable Use / Elastic / 自定义 Community / Source Available / 带商业限制的模型许可 | 必须人工审查（登记 `decision=REVIEW`） |
| **C** | 无 LICENSE / 不明确 / 商用不明确 / 模型来源不明 / 禁止商用 / 要求公开整体源码且未获批 / 与商业 SaaS 冲突 | 默认禁止进入生产 |

> 不得因为 GitHub 仓库公开就默认「可以商用」。

## 6. 冻结与自研重点

- **冻结（不得为引入 OSS 而大换底座）**：Recovery OS · 数据模型 · Tenant Isolation · HITL · Action Guard · Audit · Transaction / CAS / Row Lock · Ledger · Billing · Kill Switch。
- 任何 OSS 组件不得绕过：Tenant Isolation · RBAC · Approval/HITL · Audit · Idempotency · Transaction · Ledger invariants · Action Guard · Kill Switch。
- **自研继续集中**：Recovery OS · Canonical Fact · Rule Engine · Recovery Opportunity · Evidence Graph · Case/Claim/Appeal · Settlement · Recovery Ledger · Success Fee / Billing · 合规边界 · 多平台追回逻辑 · 结果交付闭环。

## 7. 模块级输出（每进入新大模块时）

```
FOUNDATION_REUSED =
LEGACY_REUSED =
OSS_CANDIDATE =
OSS_DECISION = EXISTING / LEGACY_REUSE / OSS_NOW / OSS_LATER / REJECT
LICENSE =
COMMERCIAL_USE = YES / REVIEW / NO
LICENSE_RISK =
NEW_RISK_BOUNDARY =
ARCH_REVIEW_REQUIRED = YES / NO
```
