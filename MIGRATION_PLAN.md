# MIGRATION_PLAN —— 旧项目迁移计划

**旧项目**：`E:\zhuihuiweikuan-saas`（Legacy Source Project，原则上只读）
**正式工程**：`D:\crossclaim-ai`（Production Project）

审计结论见 [LEGACY_MIGRATION_AUDIT.md](./LEGACY_MIGRATION_AUDIT.md)。

---

## 一、总原则

1. **不整体复制。** 单模块分析 → 架构审计 → 定 REUSE / REFACTOR / REJECT → 迁移 → 测试 → PR → 复审。
2. **不为复用旧代码破坏新架构。** 旧模型与 CrossClaim 核心模型冲突时，以新架构为准。
3. **旧项目只作资产来源。** 不在旧项目上继续建设 CrossClaim，不在 E: 生成生产文件。
4. 需要运行旧代码验证时，复制到临时目录或正式工程后运行。

---

## 二、三个状态

| 状态 | 含义 |
|---|---|
| `REUSE` | 可直接迁移（含必要适配） |
| `REFACTOR` | 按 CrossClaim 架构改造后迁移 |
| `REJECT` | 不迁移 |

---

## 三、模块判定摘要

### REUSE（平台底座）

| 模块 | 旧项目位置 | 备注 |
|---|---|---|
| 许可证闸门 | `ops/license-gate/` | 已迁入 `tools/license-gate/` |
| 多租户与鉴权 | `middleware/auth.ts`、`routes/routes/auth.ts` | 需按 `Organization`/`Membership` 重构后再谈 |
| 审计 | `services/auditService.ts` | 迁入 `AuditLog` |
| 对象存储 | `minio` 客户端 | 变为 Storage Adapter |
| Webhook | `services/webhook/` | 事件投递骨架 |
| 任务队列 | `services/queue/pipelineQueue.ts`（BullMQ） | 短任务队列 |
| 文件解析 | ExcelJS / PapaParse 适配层 | 已具 CrossClaim 形态 |
| 文档能力 | `pdf-parse` / `tesseract.js` / `mammoth` / `sharp` / `aliyunOcr` | 工具箱 |
| OCR 服务 | `ocr_service/`（FastAPI + PaddleOCR） | 独立容器接入 |

### REFACTOR（要改造）

| 模块 | 旧做法 | 目标 |
|---|---|---|
| 长流程状态机 | 状态字段 + `node-cron` 扫描恢复 | **Temporal workflow** |
| 计费 | `services/payment/*` + `TimeGrant` | `Settlement` / `BillingInvoice` / `FeeCalculation` |
| AI 调用 | Prompt 硬编码在服务内 | Prompt 外置 + LangGraph 节点 |
| 通知 | 多渠道分散 | 统一 Notify 适配层 |
| 前端脚手架 | `hs-query-frontend`（Next + shadcn） | 作为 `apps/web` 脚手架，业务页重写 |

### REJECT（不迁移）

报关申报与报文（`declarationBuilder` / `Declaration` / `BatchGroup`）、
CBAM / 退税（`cbamCalculator` / `taxRebate*`）、HS 与原产地规则库（除非经裁决用于关税追回）、
Activepieces、代理/VPS 工具链、AGPL 的 `claudecodeui`、三层交付包痕迹。

> **待裁决**：关税 / HS / 原产地**数据与算法**是否"有条件复用"（CrossClaim 含 CUSTOMS 域）。
> 见审计报告 §16.2 与 §17 Q4 —— 在裁决前不迁移这部分。

---

## 四、迁移 Wave

### Wave 0 · 工程地基 ✅ 进行中

- [x] 领域模型（`apps/api/prisma/schema.prisma`）
- [x] 架构契约与领域规则（`ARCHITECTURE_CONTRACT.md` / `DOMAIN_MODEL.md`）
- [x] Agent 协作规则（`AGENTS.md`）+ Watcher（`tools/agent-bridge/`）
- [x] 许可证闸门迁入（`tools/license-gate/`）
- [x] CI 骨架
- [ ] Logging
- [ ] Health Check
- [ ] Storage Adapter
- [ ] Audit 基础逻辑

### Wave 1 · 数据进入系统

CSV / Excel / PDF / Word / Image 解析 → `FileAsset` → `ImportBatch` → `SourceTransaction`

### Wave 2 · 平台基础能力

`Organization` / `User` / `Membership` / Auth / API Token / Webhook / Queue
（**不要原样复制旧项目**）

### Wave 3 · 智能与流程层

Temporal / LangGraph / Docling / DeepSeek Client / Prompt 外置 / Rule Engine

### Wave 4 · **第一个完整返钱闭环**（Logistics）

```
Carrier Invoice + Contract / Rate Card + Tracking
→ Normalize → RuleEvaluation → RecoveryOpportunity → Case
→ Evidence → Claim → Settlement → RecoveryLedger → Billing
```

### Wave 5 · Amazon FBA Adapter

### Wave 6 · 关税追回与 Broker 协作

---

## 五、每个 Wave 的验收

1. 本地可运行（fresh clone 能装能跑）
2. 有测试（单元 + 集成，核心链路要有 E2E）
3. CI 绿
4. 许可证闸门绿（含 Python 侧）
5. PR 内含章程 §十六 要求的全部条目
6. 经 `AI-BRIDGE` 审计

**未达标的 Wave 不得宣布完成**，状态标注 `NOT COMPLETE`。
