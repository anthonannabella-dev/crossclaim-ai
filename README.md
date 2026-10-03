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

**工程层已到 Gate 7（商业化验证）** —— Gate 0–6 已按 merge commit 合并；Gate 7 的工程能力已建成，
**商业验证仍 OPEN**（等待真实/脱敏真实结构账单 `VALIDATION-RUN-001`）。

已完成：

- 领域模型 **77 个（71 核心 + 6 联结）**、**66 条迁移**、**95 个租户完整性触发器**（另有人工追回提交域与 reconciliation 域的 append-only / 受控 supersede / generation 守卫触发器清单）：`apps/api/prisma`
- 2026-10-03 内部完成（详见 docs/releases/MASTER-GAP-CLOSURE-REGISTER.md）：CARRIER QUEUE #10（carrier response append-only 事实 + DB 真值 + tenant-scoped 读模型）已 CLOSED；CUSTOMS C15/C16/C19/C20/C21 契约层 + C17 submission ledger（root + append-only fact，并发/幂等收口）已 CLOSED；Commercial C10–C11（15% versioned FeePolicy cutover + ESTIMATE_ONLY 预览 + 统一 fee guard 收口）已落地。前端只读接线（carrier response / customs filing-status）列入 SAFE_CONTINUATION_QUEUE（见 docs/releases/FRONTEND-WIRING-MAP.md）。
- Gate 1 运行时地基（Storage Adapter / Audit / Import foundation / Adapter interface）
- Gate 2 物流首个纵向闭环（Detection Spine + Recovery Closure）
- Gate 3 双模式采集与证据晋级（FILE_UPLOAD + 只读 API Connector + 跨来源对账）
- Gate 4 Canonical Fact 层 + 检测身份迁移（`DETECTION_IDENTITY_MODE` 默认 legacy）
- Gate 5 生产采集运行时（SourceConnection 生命周期 / 上传运行时 / 只读连接器 / 有界重试 Runner）
- Gate 6 客户运营层（认证 / 连接管理 / 机会复核 / 建案 / 回收结果 / 账单 / 案件与证据读取）
- Gate 7 工程能力：处置洞察与导出、**高额回收人工卡口**、掩码与交付物状态、**佣金对账**
  （dry-run 默认、只建 DRAFT、永不自动置 PAID）、**支付域**（Payment / PaymentEvent /
  PaymentProcessingAttempt + 执行恢复 + 财务对账差异清单）、**Claim 归一化**（ClaimItem /
  证据联结 / 来源指纹）、**规则引擎审计**（残差分类 / 版本漂移 / 新鲜度，仅只读）、
  **平台连接器抽象层**（Connector 契约 / 编排器 / quarantine，不含任何真实平台接入）
  · **i18n 轻量层**（C-0015-I18N-LAYER：zh-CN / en-US / de / ja / es 五语字典 + `cc_lang`
  cookie 与 `Accept-Language` 识别 + UI 文案切换；不含 LLM 多语言输出，架构方 MSG-20260929-05 批准）
- CI：全新 PostgreSQL 上真实执行迁移并跑 **81 文件 / 719 用例**（含真实库不变量与租户隔离），
  另有 Web typecheck/build 与双 workspace 许可证闸门

尚未完成 / 明确 HOLD：

- `VALIDATION-RUN-001`（商业验证唯一缺口，需要一份脱敏真实结构账单；脚手架已就绪）
- C-0010-C2 真实 Stripe **test mode** 联调（需宿主授权：test 账号 / webhook signing secret / Stripe CLI）
- 真实平台连接器（OAuth / 凭据 / 限流 / 游标持久化）——抽象层已就绪，接入需另行开闸
- 所有 **API / 第三方账号**接入项已汇总为 `reports/API-INTEGRATION-BACKLOG.md`（宿主逐项开闸；清单不含任何凭据取值）
- `apps/ai`、生产部署与安全/运维文档

> **本地跑测试需要数据库**：
> `docker run -d --name crossclaim-postgres -e POSTGRES_USER=crossclaim -e POSTGRES_PASSWORD=ccdevpass -e POSTGRES_DB=crossclaim -p 127.0.0.1:55432:5432 postgres:16-alpine`
> 然后 `DATABASE_URL=postgresql://crossclaim:ccdevpass@localhost:55432/crossclaim npx prisma migrate deploy && npm test`
> 初始化可操作数据（幂等；生产环境默认拒绝）：`cd apps/api && npm run db:seed`

详见 [MIGRATION_PLAN.md](./MIGRATION_PLAN.md)。

---

## 离线验证工具（宿主可自行运行）

三者都是**离线**工具：无网络、无凭据、不写数据库、不产生任何商业结论。

1. 统一验证 Harness（推荐入口，任意平台导出文件）

       cd apps/api
       npx tsx ../../tools/validation-run/harness.ts --in <文件路径> [--platform SHOPIFY] [--out <输出目录>]

   产出 `HARNESS-REPORT.md`（适配结果 + 数据质量 + 结构校验 + 商业评审骨架）与 `harness-summary.json`。
   平台由表头特征猜测，需人工确认；`commercialConclusion` 恒为 `OPEN`。

2. C-0009.1 验证工具包（脱敏 → 结构校验 → 报告）

       cd apps/api
       npx tsx ../../tools/validation-run/run.ts --in <csv> --out <目录>

3. 人工填写模板：`DATA-QUALITY-REPORT-TEMPLATE.md`（Harness 自动填前 5 节，商业评审段由人工填写）

> 真实/脱敏文件到手后：跑 Harness → 按模板补写商业评审 → 结论写进 `reports/C-0009.1-validation-runs.md`，
> 再据此提交 `C-0015-SCENARIO-SELECTION.md` 选定唯一 MVP 场景。
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
| `DEPLOYMENT.md` | 部署步骤、环境变量清单、初始化与回滚 |
| `SECURITY.md` | 认证、租户隔离、凭据边界、上传安全 |
| `OPERATIONS.md` | 健康检查、日志、审计动作、故障处置 |
| `CODE_COMPLETE_REPORT.md` | 离线完成度审计（活文档，含离线工作队列） |
| `REAL-DATA-VALIDATION-BACKLOG.md` | 真实依赖登记（RD-01…RD-12）与三轨状态口径 |
| `PRODUCTION-READINESS-CHECKLIST.md` | 生产就绪判据（A–H 门 + 上线前 Validation 清单） |
| `FINAL-GATE-REVIEW.md` | 最终总审（Gate 1–10 + Production Candidate 判定：CODE COMPLETE / INTEGRATION PENDING / REAL VALIDATION PENDING / BLOCKERS） |
| `docs/releases/PRODUCTION-CANDIDATE-v1.0.md` | Production Candidate v1.0 归档（FINAL PASS / CODE COMPLETE / 待集成与待验证清单 / 已知边界 / 上线清单） |
| `reports/ADMIN-BACKOFFICE-AUDIT.md` | 后台异常处置能力核查（运维视角能力/缺口/上线清单） |

*（以上文档均已建立；`apps/ai` 仍待立项。）*
