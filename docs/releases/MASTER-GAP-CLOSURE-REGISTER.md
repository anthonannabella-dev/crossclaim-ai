# MASTER GAP CLOSURE REGISTER（目标 → 实现 → 缺口）

维护规则：每完成一个单元即重算；本表是 SAFE_CONTINUATION_QUEUE 的唯一权威来源。
最近重算：2026-10-03（HEAD `0693821`；依据 MSG-20261003-123/124 与全部已交付批次）。

## A. 目标 → 状态

| # | FINAL TARGET | 当前实现（证据） | 状态 |
|---|---|---|---|
| 1 | Platform Recovery | Amazon 只读 adapter + 平台连接/账号体系 + 平台信号仅作 `CUSTOMS_OPPORTUNITY_SIGNAL` | PARTIAL（真实 adapter = EXTERNAL） |
| 2 | Carrier / Logistics Recovery | Queue #3–#10 全链：auth/account → tracking read → invoice/POD read → evidence bundle → SLA eligibility → recovery estimate → claim-ready input → claim package → human submission（append-only + DB 真值）→ carrier response/status read model（MSG-123 CLOSED，impl `dff7161`） | INTERNAL COMPLETE（真实 provider ingest = EXTERNAL） |
| 3 | Customs / Trade Recovery | C15 filing provider 契约（`a992d2f`）、C16 授权就绪 + C19 状态读模型 + C21 one-click 编排（`db5c378`）、C19 可信 ingest + C20 refund→fee（`c5dedaf`）；C17 账本 = MSG-124 REVISE（拆 root+fact） | PARTIAL（C1–C14 内部 + C17 待做） |
| 4 | 一次账户体系下多平台多账号连接 | SourceConnection / PlatformAccount / account discovery / connection onboarding + tenant 守卫 | INTERNAL COMPLETE（真实 OAuth = EXTERNAL） |
| 5 | Opportunity Detection | RecoveryOpportunity + detection spine + Qualification | INTERNAL COMPLETE（平台侧信号需真实 adapter） |
| 6 | Evidence / Recovery Graph | EvidenceArtifact / EvidenceEdge / CanonicalFact / ShipmentEvidenceBundle | INTERNAL COMPLETE（Customs evidence = GAP C1） |
| 7 | Eligibility / Rule Evaluation | RuleSet/RuleVersion + carrier SLA eligibility（35/35）+ reconciliation 规则 | INTERNAL COMPLETE（Customs eligibility = GAP C4） |
| 8 | Estimated Recoverable Amount | carrier recovery estimate（ELIGIBLE-only、多币种、保守规则） | INTERNAL COMPLETE（Customs amount = GAP C5） |
| 9 | Claim-Ready Package | carrier claim package（deterministic packageId、evidence manifest） | INTERNAL COMPLETE（Customs package = GAP C6） |
| 10 | Human Approval / Action Guard | Action Guard catalog + capability + kill switch + HITL 提交边界 + RBAC 矩阵 | INTERNAL COMPLETE（`customs.recovery.start` = GAP G3） |
| 11 | Submission / Broker Handoff 安全边界 | carrier manual submission（human attestation）+ C15/C16/C21 契约（不代客户提交） | INTERNAL COMPLETE（真实 filing = HOST） |
| 12 | Carrier / Platform / Customs Response Tracking | carrier response facts + tenant-scoped read model（MSG-123）；C19 customs 状态读模型契约 | PARTIAL（customs 持久化 = GAP C17/G3） |
| 13 | Settlement / Recovered Cash Truth | PC-05 / R45–R46 资金真值链 + SettlementReconciliation + RecoveryPayout | INTERNAL COMPLETE（真实资金 = HOST） |
| 14 | 15% Success Fee 商业模型 | FeePolicy registry + 20%→15% versioned cutover（`0693821`） | PARTIAL（统一 fee guard 接线 = GAP G1） |
| 15 | Fee Preview / Fee Guard / Billing | `estimate`→ESTIMATE_ONLY preview + `evaluateFeeGuard` + BillingInvoice(DRAFT) 既有链 | PARTIAL（多路径收口 = GAP G1） |
| 16 | Dashboard / Admin / Operations | admin console + operations dashboard + audit/permission-matrix 只读面 | PARTIAL（新增模块前端接线核查 = GAP G5） |
| 17 | Audit / RBAC / Tenant Isolation | 全库 tenant 触发器清单 + append-only 清单 + audit coverage 闸门 + RBAC 矩阵 | INTERNAL COMPLETE（新增 customs 表随批同步） |
| 18 | Idempotency / Concurrency / Retry / Failure Recovery | platform.write 账本（CAS/ambiguous/no-blind-retry）+ Queue #9B/#10 幂等与并发 + P2002 收敛 | PARTIAL（C17 账本 = GAP G2） |
| 19 | Security / Privacy / Credential Boundary | safe-reference 模式、POD 掩码、无 credential 落库、SECURITY 相关测试与文档 | INTERNAL COMPLETE（真实凭据 = HOST） |
| 20 | HTTP / DB / Schema / Frontend / Tests / CI / Docs | 86/73 route contract、CI 5 jobs 全绿、migrations 可空库执行、前后端类型检查 | PARTIAL（docs 同步 = GAP G6；前端接线 = GAP G5） |

## B. INTERNAL REMAINING GAP（SAFE_CONTINUATION_QUEUE，按优先级）

| ID | 缺口 | 来源 | 动作 |
|---|---|---|---|
| G1 | 统一 fee guard 收口：所有 `FeeCalculation` 创建路径必须过 `evaluateFeeGuard` | MSG-20261003-124 ㉓㉔㉕⑥ | `record-fee.ts` 保留既有装配、只在 create 前接 guard；`commission-reconciliation.ts` 改为 matched settlement → verified recovered truth → RecoveryCommercialEligibility → SettlementFeeEligibility → resolve versioned policy → guard → FeeCalculation；补 ㊱ 回归 |
| G2 | C17 `CustomsSubmissionAttempt`（幂等根）+ `CustomsSubmissionAttemptFact`（append-only 状态） | MSG-20261003-124 ③④⑤⑥㊲ | Schema/migration + tenant/append-only 清单 + store + PG 回归（timeout 不建第二根、ambiguous 不重发、SUBMITTED 必带 providerSubmissionId）→ 送 **C17 FINAL SCHEMA CHECKPOINT** |
| G3 | C21 HTTP：`POST /customs-opportunities/:id/start-recovery` + `GET .../filing-status` + `customs.recovery.start` Action Guard/RBAC | MSG-20261003-124 ⑭–㉑ | 实现并按 `filingSubmitted=false` / `externalExecutionStatus=NOT_STARTED` 语义暴露；真实 DB E2E（401/403/404/400/200/409 语义） |
| G4 | Customs C1–C7 内部链（evidence/data contract → duty truth → classification discrepancy → eligibility → estimate → claim-ready package） | HOST DIRECTIVE 2026-10-03 补充四 §3 ㉓ | 逐单元契约→持久化→HTTP→测试；真实 filing 不在此范围 |
| G5 | 前端真实接线核查（carrier response 读模型 / customs status / fee preview 等新能力是否真正调用后端） | MASTER GAP CLOSURE 检查项 E | 核查 `apps/web` 页面与 API 调用，补齐缺失接线与可展示状态（不引入外部写） |
| G6 | 文档同步（README / FINAL-GATE / PRODUCTION-READINESS / API BACKLOG ↔ 代码） | 检查项 F | 逐文档比对最近实现（Queue #10、Customs C15–C21、15% cutover）并更新 |
| G7 | 非 happy-path 覆盖复核（跨租户 / 幂等 / 并发 / 失败恢复）针对新增模块 | 检查项「测试只覆盖 happy path」 | 复核并补测 |
| G8 | contract-only → 持久化复核 | 检查项「contract-only 未持久化」 | 逐模块核对（Carrier 已闭环；Customs C16/C19/C21 依赖 G2/G3） |
| G9 | Schema 字段无 DB constraint 复核 | 检查项「Schema 有字段但无 DB constraint」 | 每次新增表时同步 CHECK/UNIQUE/触发器并加静态断言 |
| G10 | service 已实现但 HTTP 未接线复核 | 检查项「service 有但 HTTP 未接线」 | 建立 service→route 映射表并消除孤儿 service |

## C. 外部 / 宿主依赖（不进入 SAFE_CONTINUATION_QUEUE）

| ID | 事项 | 分类 |
|---|---|---|
| E1 | 真实 carrier provider read/write（UPS/FedEx API、webhook、portal） | HOST_APPROVAL_REQUIRED / API_INTEGRATION_REQUIRED |
| E2 | 真实 customs broker / filing provider 接入与申报 | HOST_APPROVAL_REQUIRED / LEGAL_OR_LICENSE_REQUIRED |
| E3 | 平台真实 adapter（TikTok / Walmart / Shopify OAuth + read） | API_INTEGRATION_REQUIRED |
| E4 | 生产部署 / DNS / 付费服务 / 生产凭据 | HOST_APPROVAL_REQUIRED |
| E5 | 真实客户数据 / 真实资金链路 / 实际扣费 | HOST_APPROVAL_REQUIRED / REAL_DATA_REQUIRED |
| E6 | 牌照与法律结论（broker / IOR / 代表客户） | LEGAL_OR_LICENSE_REQUIRED |

## D. INTERNAL_CODE_COMPLETE 判定

当前：**FALSE**（内部缺口 G1–G10 未清零）。判定条件见 `docs/releases/MASTER-GAP-CLOSURE-DIRECTIVE.md` §0。
