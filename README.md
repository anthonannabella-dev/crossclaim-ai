# CrossClaim AI

**Recovery OS · 资金追回操作系统**

一次接入，持续发现并追回散落在平台、物流、货代、保险和关税里的钱。

---

## 这是什么

CrossClaim 是跨渠道资金追回系统，覆盖三个追回域：

| 域 | 内容 |
|---|---|
| **Platform Recovery** | Amazon FBA 丢失/损坏、库存差异、入库差异、重量尺寸错误、赔付遗漏与错付、退款未归还库存 |
| **Logistics Recovery** | UPS / FedEx / DHL / 货代的运费账单审计、合同费率核对、重复收费、各类附加费、SLA/GSR 延误退款、丢件破损、账单争议 |
| **Customs / Trade Recovery** | 多缴机会发现、数据差异、金额测算、证据整理、案件包生成、Broker 协作、结果追踪、到账核对 |

**边界**：需要牌照的正式申报、最终海关判断与正式提交，由持牌报关经纪（Broker）完成，
CrossClaim 不越权代为完成。

---

## 核心价值链

```
Source Data → Normalize → RecoveryOpportunity → RecoveryGraph
→ EvidenceGraph → RecoveryRouting → Case → Claim / Appeal
→ Settlement → RecoveryLedger → Billing
```

金额、佣金、Deadline、账本结果**一律由确定性代码 / SQL / 规则引擎决定**，不由 LLM 决定。
AI 负责文档理解、字段抽取、异常解释、证据推荐、案件总结、Claim/Appeal 文本。

---

## 仓库结构

| 路径 | 内容 |
|---|---|
| `apps/api/` | 核心 API（Node + TypeScript + Prisma + PostgreSQL） |
| `apps/api/prisma/schema.prisma` | **领域模型（架构基准）** |
| `apps/web/` | 前端（Next.js + React + shadcn/ui + Tailwind） |
| `apps/ai/` | AI 服务（FastAPI + Pydantic + Docling + LangGraph） |
| `tools/agent-bridge/` | Codex ↔ ChatGPT 通信与监视 |
| `tools/license-gate/` | 依赖许可证闸门 |
| `docs/` | 交付文档 |

### 与旧项目的关系

旧项目 `E:\zhuihuiweikuan-saas`（出口报关 SaaS）**只是技术资产来源**，不是本仓库的一部分。
可复用性判定见 [LEGACY_MIGRATION_AUDIT.md](./LEGACY_MIGRATION_AUDIT.md) 与
[MIGRATION_PLAN.md](./MIGRATION_PLAN.md)。**旧项目原则上只读。**

---

## 状态

**进行中（Gate 6 未收口）** —— Gate 0–5 已按 merge commit 合并；Gate 6 / C-0008 客户运营层进行中。

已完成：

- Gate 0 领域模型 **34 个（32 核心 + 2 联结）**：`apps/api/prisma/schema.prisma`
- 数据库迁移（10 个）+ **20 个租户完整性触发器**（业务数据域）
- Gate 1 运行时地基（Storage Adapter / Audit / Import foundation / Adapter interface）
- Gate 2 物流首个纵向闭环（Detection Spine + Recovery Closure）
- Gate 3 双模式采集与证据晋级（FILE_UPLOAD + 只读 API Connector + 跨来源对账）
- Gate 4 Canonical Fact 层 + 检测身份迁移（`DETECTION_IDENTITY_MODE` 默认 legacy，canonical 未启用）
- Gate 5 生产采集运行时（SourceConnection 生命周期 / 上传运行时 / 只读连接器 / 有界重试 Runner）
- Gate 6 / C-0008-A：邀请制认证 + 会话 + 内部 HTTP + Next.js Web 基线（`apps/web`，不含组件库）
- Gate 6 / C-0008-B1：连接管理 + 机会人工复核（DETECTED → QUALIFIED / REJECTED）+ 已批准角色矩阵（等待架构方 Checkpoint 裁决）
- CI：在全新 PostgreSQL 上真实执行迁移并跑 **42 文件 / 439 用例**，另含 Web typecheck/build 与许可证闸门（`apps/api` + `apps/web` 双 workspace 真实扫描）

尚未完成：Gate 6 / C-0008-B2（Case / Evidence 查看 / Claim Draft / Billing 展示）、`apps/ai`、
完整端到端返钱闭环（当前只有测试/演示级 Settlement 注入）、生产部署与安全/运维文档。

> **本地跑测试需要数据库**：
> `docker run -d --name crossclaim-postgres -e POSTGRES_USER=crossclaim -e POSTGRES_PASSWORD=ccdevpass -e POSTGRES_DB=crossclaim -p 127.0.0.1:55432:5432 postgres:16-alpine`
> 然后 `DATABASE_URL=postgresql://crossclaim:ccdevpass@localhost:55432/crossclaim npx prisma migrate deploy && npm test`

详见 [MIGRATION_PLAN.md](./MIGRATION_PLAN.md)。

---

## 文档

| 文档 | 内容 |
|---|---|
| `PRODUCT_SPEC.md` | 产品定义与范围 |
| `ARCHITECTURE_CONTRACT.md` | 不可违反的架构约定 |
| `DOMAIN_MODEL.md` | 领域模型与不变量 |
| `MIGRATION_PLAN.md` | 旧项目迁移计划（Wave 0–6） |
| `LEGACY_MIGRATION_AUDIT.md` | 旧项目只读审计报告 |
| `AGENTS.md` | AI Agent 协作规则 |
| `MODEL_LICENSES.md` | 模型权重许可证登记 |
| `API.md` | 内部 HTTP 端点参考（含角色矩阵与错误码） |

*（`DEPLOYMENT.md` / `SECURITY.md` / `OPERATIONS.md` 待补，未完成的文档不代写。）*
