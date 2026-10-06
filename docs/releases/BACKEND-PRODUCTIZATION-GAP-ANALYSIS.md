# BACKEND PRODUCTIZATION — 增量缺口审计（BE-1）

授权：HOST 2026-10-06「后端按增量缺口审计，不要为了架构美观重写稳定代码」。
方法：**先扫描既有实现与测试证据**，再按 B1–B10 给出 GAP ANALYSIS；已有即复用，缺失且对「上线 / 真实 API 接入」
有价值的才列为待实施；**本轮不做任何重写**，仅产出审计结论。
审计基线：`gate/7-commercial-validation`（HEAD 见文末 / durable state）。

---

## 0. 总览

| 项 | 结论 |
|---|---|
| BACKEND_PRODUCTIZATION | **PASS**（审计完成；未强制迁移，未建第二事实源） |
| B1_FASTIFY | **DESIGN_ONLY**（按 HOST 要求**不**为技术栈重写 Node HTTP） |
| B2_INTEGRATION_FOUNDATION | **PARTIAL**（registry/契约/能力与凭据边界已有；OAuth session / SyncState / SecretVault 未一等建模） |
| B4_B10_GAP_STATUS | 见 §2（B3/B4/B10 = IMPLEMENTED（只读、HOLD 外部）；B5/B6/B7/B8/B9 = PARTIAL，逐项给出缺口与价值判断） |
| 第二事实源 | **未新增**（本程序只加投影/端口/判定层；canonical fact 仍是唯一事实源） |
| 回归基线 | **443 文件 / 4461 tests（4460 pass + 1 既有隔离 flake）**，未被破坏 |

---

## 1. 后端能力面扫描（HOST 第 4 条要求逐项）

| 能力面 | 现状（证据） | 判定 |
|---|---|---|
| SI / RSI runtime | `runtime/rsi-{domain-pack,controller,event-loop,task-runner,project-executor,verdict-watcher,restart-reconcile}.ts`；`rsi-*` 52 套件 / 315+ tests；本程序 B 单元新增真实 PG reboot reconcile 10/10 | **PASS** |
| Standing Authorization | 本程序 SA-1…SA-4b：核心 + 风险分级 + resolver + 真实调用点（hitl-submission / action-pack-runtime）+ 19/10/14/5 测试；**持久化表未实施（REQUEST ONLY）** | **PASS（判定与接线）/ PARTIAL（持久化）** |
| Action Guard / HITL | `services/action-guard/*`（catalog、runtime-guard、approval-verifier、hitl-submission、kill-switch、audit projection）+ 全套件；本程序仅新增**可选**参数，未改语义 | **PASS** |
| CanonicalFact / Evidence / Opportunity | `services/canonical/{writer,derive,duplicate-resolution,identity-backfill}.ts` + `CanonicalFact/CanonicalFactSource` 模型 + `EvidenceArtifact`/`RecoveryOpportunity` | **PASS** |
| Case / Claim / Appeal | `services/claims/*`、`services/workflow/*`（claim submit/prepare、appeal）、模型 `Case/Claim/Appeal/ClaimItem` | **PASS** |
| Customs / Duty Recovery | 本程序 B 部分新增 文档分类 / 7501 抽取 / 对账 / 证据链 / 匹配 / US rule pack / drawback 路由 / broker readiness / claim-ready vNext / 成功费 guard + 全链 PG E2E | **PASS（只读与判定层）** |
| Provider / Carrier / Platform adapters | `services/carriers/*`（auth contract / account discovery / tracking / invoice·POD / capability / SLA / estimate / evidence bundle / claim package）、`services/adapters/*`、`services/amazon sp read`、`services/customs/customs-provider-*`；真实网络 = HOLD_EXTERNAL | **PASS（契约层）/ HOLD_EXTERNAL（真实网络）** |
| Settlement / RecoveryLedger / Fee / Billing | `services/settlement/*`（record-settlement/fee/reversal + reconciliation）、`services/billing/*`、`services/commercial/fee-policy`、本程序 B-S11 成功费严格化 | **PASS** |
| OAuth / Connection lineage | `SourceConnection` + account lineage 策略（`services/account-lineage/policy.ts`）+ `customs-provider-tenant-binding`；真实 OAuth = HOLD（无生产凭据） | **PARTIAL（契约/绑定已有；OAuth session 持久化未建）** |
| multi-platform / multi-account | `PlatformAccount` + 全链路 `organizationId + platformAccountId` 双维过滤（本程序新增模块均强制） | **PASS** |
| audit / idempotency / transaction / concurrency / tenant isolation | audit（AuditLog + action-guard audit projection）、幂等（UNIQUE + 幂等键）、事务（PG 事务 + CAS）、并发（HITL concurrency / race / multi-worker）、隔离（tenant-isolation 套件 + tenant guard 触发器） | **PASS** |
| production kill switch / external write gates | `action-guard/kill-switch-adapter.ts`、`guard-enforcement`、`action-pack-runtime` external-write HOLD；本程序 SA 不得绕过 | **PASS（仍关闭）** |

---

## 2. B1–B10 GAP ANALYSIS（逐项，含"是否值得实施"判断）

| 阶段 | 目标（directive §PHASE） | 现状 | 缺口 | 本轮处置 |
|---|---|---|---|---|
| **B1** | HTTP Layer 迁移 Node HTTP → Fastify + `/api/v1` 兼容 | `docs/releases/PHASE-B1-FASTIFY-HTTP-LAYER-DESIGN.md` 存在；生产 `apps/api/src/server.ts` 仍是 Node HTTP（其注释明确"不在此处提前锁死"） | 无实现（仅设计） | **DESIGN_ONLY** —— 按 HOST「不要为技术栈升级重写」**不实施**；如需推进须单独立项（迁移仅限 HTTP adapter，禁止动 service/domain/Guard/permissions） |
| **B2** | Integration Foundation：ProviderAdapter / OAuthAuthorizationSession / ConnectionCapability / ConnectionSyncState / SecretVault | `integrations/core/registry.ts`（provider 绑定骨架，`networkImplemented=false`、未知 provider fail-closed）、`action-runtime/provider-adapter-contract.ts`、`carriers/connector-capability.ts`、`carriers/carrier-auth-contract.ts`、`customs-provider-tenant-binding.ts` | ① OAuthAuthorizationSession **未一等建模**（授权会话生命周期/回调校验缺位）；② ConnectionSyncState（增量同步游标）缺位；③ SecretVault（密钥托管抽象）缺位（当前凭据仍以 credentialRef + 无生产凭据运行） | **PARTIAL** —— B2 的**真实 API/OAuth 接入必需**部分（①②）值得实施，但 ① 需要 Schema Delta 审计，② 可先做端口；③ SecretVault **不建议**在无生产凭据前实施（HOLD_EXTERNAL）。本轮不实施，登记为下一批候选 |
| **B3** | UPS / FedEx 第一接入：OAuth + Account Discovery + Tracking Read + Capability Detection（禁 Direct Claim API） | `carriers/{carrier-auth-contract,carrier-account-discovery,carrier-tracking-read,connector-capability}.ts` + 测试（`acquisition`、`accounts-http-db`、`carrier-connector-capability`） | 真实 OAuth/网络调用（HOLD_EXTERNAL：无生产凭据）；Direct Claim API 明确禁止 | **IMPLEMENTED（契约与只读能力）/ HOLD_EXTERNAL（真实网络）** —— 复用现有 Carrier Queue，不重写 |
| **B4** | Invoice / POD / Rate / SLA 数据接入 | `carrier-invoice-pod-read`、`carrier-recovery-estimate`、`carrier-sla-eligibility`、`carrier-evidence-bundle`、`carrier-claim-package` + 套件 | 真实 provider 取数与费率表（HOLD_EXTERNAL） | **IMPLEMENTED（只读契约）** —— 复用 |
| **B5** | Structured Domain Facts：`shipment/v1`、`customs-entry/v1` | `services/canonical/*` + `CanonicalFact/CanonicalFactSource`；`customs-entry-contract.ts` + `customs-entry-fact-store.ts`（append-only + 投影） | ① `shipment/v1` 未以独立 schema 命名（等价语义由 CanonicalFact kind 承载）；② `customs-entry/v1` 已有实际实现（contract + store） | **PARTIAL** —— 不新增第二事实源；如需 `shipment/v1` 显式 schema，应作为 CanonicalFact 的**投影/契约版本**而非新表 |
| **B6** | Dual-Path Routing：Platform Shipping vs Independent Carrier | 路由事实存在：`RouteTarget` 枚举（PLATFORM / CARRIER / FREIGHT_FORWARDER / INSURER / CUSTOMS_AUTHORITY / CUSTOMS_BROKER / CUSTOMER_SELF / NONE）+ `RecoveryRoute` 模型 + `services/recovery-rules/*`（remedy/route 选择） | 无名为 `DualPath` 的模块（命名差异，非能力缺失） | **PARTIAL（已由既有 RouteTarget/RecoveryRoute 覆盖）** —— **不新建**双路径引擎，避免第二事实源 |
| **B7** | Document AI：7501 / C88 / 中国报关单 / invoice / POD | 本程序 + 既有：`document-ingestion`（CSV/XLSX/JSON → PDF native → OCR fallback）、`customs-document-classification`、`customs-7501-extraction`、`customs-fact-reconciliation`、`carrier-invoice-pod-read` | ① C88（EU 报关单）与**中国报关单**未实现（无对应 jurisdiction rule pack / 文档种类规则）；② 收费 OCR = HOLD_EXTERNAL（当前仅 mock/本地 PDF 文本层） | **PARTIAL** —— 7501 / invoice / POD / 分类已实现；C88·中国报关单应通过**新增 jurisdiction rule pack**（复用既有 rule-pack 契约）实施，价值取决于是否进入 EU/CN 市场 |
| **B8** | AsyncJob + Outbox（PostgreSQL 原生；不强化 Redis/Temporal） | `ControlledConfigExecutionOutbox` 模型 + `config-execution-durability/{types,state-machine,reservation,prisma-durable-store}.ts` + PG 套件（transactional outbox、多 worker、stale lease、crash recovery） | 无**通用** AsyncJob 框架（当前仅受控配置执行域） | **PARTIAL** —— 域内 outbox 已具备并 PG 验证；通用 AsyncJob 若为真实 API 接入所需（长时任务/重试）值得做，但须复用既有 outbox 语义而非第二套 |
| **B9** | Submission Adapter：一期只开 CLAIM_READY_PACKAGE / PORTAL_DEEPLINK；DIRECT_API 需官方资质 + Action Guard 全绿 | `carriers/connector-capability.ts`（capability 词汇）、`customs/customs-handoff-boundary.ts`、`customs/claim-ready-package-vnext.ts`（estimateOnly / billable=false / filingPerformed=false） | 无统一 `SubmissionAdapter` 接口（能力已分散存在）；DIRECT_API = HOLD_EXTERNAL | **PARTIAL** —— 建议以**适配器接口 + 既有 capability 词汇**补齐（不新建状态机）；DIRECT_API 保持 HOLD |
| **B10** | Customer Projection APIs：Overview / Action Center / Recoveries / Integrations / Executive Report | API：`/opportunities`、`/recovery-money`、`/recovery-states`、`/integration-status`、`/carrier-claim-packages`、`/customs-opportunities`、`/entitlements`、`/accounts`、`/cases`、`/billing/*/status`、`/uploads`；Web：opportunities / money / connections / customs / integration-status / plan / accounts / cases / admin / operations / recover（FE-1 复核 15/15 路径匹配、无漂移） | Executive Report 以 `insights.csv` + `/operations` 承载；未发现独立 "Executive Report" 端点 | **IMPLEMENTED**（语义已覆盖） —— 复用 |

---

## 3. 结论与边界

* **不重写稳定代码**：本轮 BE-1 为纯审计（无代码改动）；B1 保持 DESIGN_ONLY；B6 明确**不**新建双路径引擎。
* **禁止第二事实源**：所有判定/投影/经验/授权层均为只读或端口化；CanonicalFact + 既有审计/账本仍是唯一事实源。
* **回归基线未破坏**：443 文件 / 4461 tests（4460 pass + 1 既有隔离 flake，单独运行通过）；`api tsc` exit 0；`prisma validate` valid（88 migrations up to date）。
* **值得后续实施（需授权 / 审计）**：B2① OAuth authorization session（Schema Delta 审计后）· B2② ConnectionSyncState（可先端口）· B7 C88/中国报关单 rule pack（进入对应市场时）· B8 通用 AsyncJob（复用既有 outbox 语义）· B9 SubmissionAdapter 接口（复用 capability 词汇）。
* **明确不建议现在做**：B1 Fastify 迁移（无产品价值，风险高）· B2③ SecretVault（无生产凭据前无意义，HOLD_EXTERNAL）· B6 新双路径引擎（既有 RouteTarget 已覆盖）。

**BACKEND_PRODUCTIZATION = PASS**（审计完成；无强制迁移、无第二事实源、基线未破坏）。

