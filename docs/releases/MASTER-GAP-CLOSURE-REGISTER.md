# MASTER GAP CLOSURE REGISTER（目标 → 实现 → 缺口）

维护规则：每完成一个单元即重算；本表是 SAFE_CONTINUATION_QUEUE 的唯一权威来源。
最近重算：2026-10-03（HEAD `c4370ea`；依据 MSG-20261003-126 与全部已交付批次；G4 C1–C5 已收口）。

## A. 目标 → 状态

| # | FINAL TARGET | 当前实现（证据） | 状态 |
|---|---|---|---|
| 1 | Platform Recovery | Amazon 只读 adapter + 平台连接/账号体系 + 平台信号仅作 `CUSTOMS_OPPORTUNITY_SIGNAL` | PARTIAL（真实 adapter = EXTERNAL） |
| 2 | Carrier / Logistics Recovery | Queue #3–#10 全链：auth/account → tracking read → invoice/POD read → evidence bundle → SLA eligibility → recovery estimate → claim-ready input → claim package → human submission（append-only + DB 真值）→ carrier response/status read model（MSG-123 CLOSED，impl `dff7161`） | INTERNAL COMPLETE（真实 provider ingest = EXTERNAL） |
| 3 | Customs / Trade Recovery | C15 filing provider 契约（`a992d2f`）、C16 授权就绪 + C19 状态读模型 + C21 one-click 编排（`db5c378`）、C19 可信 ingest + C20 refund→fee（`c5dedaf`）；C17 账本 = MSG-20261003-126 **PASS/CLOSED**（root+fact，impl `0c35106`）；C1 报关单事实契约层 DONE（`3f5b9e3`）。 | PARTIAL（C2–C14 + C1 持久化内部待做） |
| 4 | 一次账户体系下多平台多账号连接 | SourceConnection / PlatformAccount / account discovery / connection onboarding + tenant 守卫 | INTERNAL COMPLETE（真实 OAuth = EXTERNAL） |
| 5 | Opportunity Detection | RecoveryOpportunity + detection spine + Qualification | INTERNAL COMPLETE（平台侧信号需真实 adapter） |
| 6 | Evidence / Recovery Graph | EvidenceArtifact / EvidenceEdge / CanonicalFact / ShipmentEvidenceBundle | INTERNAL COMPLETE（Customs evidence：C1 契约层 DONE（impl `f7b85ee`）+ C2 计算真值 DONE（impl `d8fd6c3`）+ C3 差异检测 DONE（impl `6768952`）+ C4 资格判定 DONE（impl `c4370ea`）+ C5 估算 DONE（impl `c4370ea`，estimateOnly / 不可计费）；持久化待 Schema Delta 审计） |
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
| ~~G1~~ **DONE** | 统一 fee guard 收口：所有 `FeeCalculation` 创建路径必须过 `evaluateFeeGuard`（`commission-reconciliation.ts` 已按 ㉕ 改造：matched settlement → verified recovered truth → 绑定 agreement policy → guard → FeeCalculation；`record-fee.ts` 既有装配保留） | MSG-20261003-124 ㉓㉔㉕⑥ | `record-fee.ts` 保留既有装配、只在 create 前接 guard；`commission-reconciliation.ts` 改为 matched settlement → verified recovered truth → RecoveryCommercialEligibility → SettlementFeeEligibility → resolve versioned policy → guard → FeeCalculation；补 ㊱ 回归 |
| ~~G2~~ **DONE** | C17 `CustomsSubmissionAttempt`（幂等根）+ `CustomsSubmissionAttemptFact`（append-only） | MSG-20261003-126 PASS/CLOSED | 已收口：root UNIQUE + fact append-only + tenant lineage + SUBMITTED 必带 providerSubmissionId + 并发原子（FOR UPDATE）+ IDEMPOTENCY_KEY_CONFLICT + FACT_IMMUTABLE_MISMATCH；真实 PG 13/13 |
| G3 | C21 HTTP：`POST /customs-opportunities/:id/start-recovery` + `GET .../filing-status` + `customs.recovery.start` Action Guard/RBAC | MSG-20261003-124 ⑭–㉑ | 实现并按 `filingSubmitted=false` / `externalExecutionStatus=NOT_STARTED` 语义暴露；真实 DB E2E（401/403/404/400/200/409 语义） |
| ~~G4~~ **DONE / CLOSED** | Customs C1–C7 内部链：**C1** 事实契约 → **C2** duty 真值 → **C3** 分类/税率差异 → **C4** 三态资格（SHANGE A 方向语义）→ **C5** 估算（estimateOnly、消费 C4 候选）→ **C6** claim-ready package（确定性装配）→ **C7** handoff-only | HOST DIRECTIVE 2026-10-03 补充四 §3 ㉓ + **MSG-20261003-127 REVISE → MSG-20261003-128 PASS/CLOSED** | 全部收口：契约 85/85、customs 全套 154/154、两批 Schema Delta（事实层 append-only + 四个 append-only 计算投影）迁移 50 条、触发器清单 89/30、CI 5/5（4ed8714 / 749040c）；架构方明确**无需再送 G4 checkpoint** |
| ~~G5~~ **DONE** | 前端真实接线（只读页 + 人工补录表单 + start-recovery 表单全部上线） | MASTER GAP CLOSURE 检查项 E | **已核查并记录**：`apps/web` 49 文件 / 34 条后端路径，均不含 Queue #10 与 C21/C19 新能力 → 结论 **CONFIRMED_GAP（只读 UI 接线待做）**；映射见 `docs/releases/FRONTEND-WIRING-MAP.md` |
| ~~G6~~ **DONE** | 文档同步（README / FINAL-GATE / PRODUCTION-READINESS / API BACKLOG ↔ 代码） | 检查项 F | 逐文档比对最近实现（Queue #10、Customs C15–C21、15% cutover）并更新 |
| ~~G7~~ **DONE（Customs）** | 非 happy-path 覆盖复核 | 检查项「测试只覆盖 happy path」 | Customs：新增 C1→C7 全链回归 7/7（少缴拒绝估算 / INDETERMINATE 传播 / 混币·PII·篡改事实·证据引用 fail-closed / 确定性）；Carrier 侧此前已覆盖租户/幂等/并发/超时；**剩余**：下一目标域接入时同步补非 happy-path |
| ~~G8~~ **DONE** | contract-only → 持久化复核 | 检查项「contract-only 未持久化」 | 已收口：Customs C1–C5 具备 append-only 持久化（`customs-entry-fact-store`：contentDigest 幂等、投影只追加、latest 由 computedAt 推导），真实 PG 验收 7/7（重复 ingest→exactly one、digest 冲突 fail-closed、投影重算留历史、UPDATE/DELETE 触发器拒绝、跨租户 lineage 拒绝） |
| ~~G9~~ **DONE** | Schema 字段无 DB constraint 复核 | 检查项「Schema 有字段但无 DB constraint」 | 已收口：扫描 27 候选 → 补 currency 形状 CHECK（3 列）、platform-write 状态 CHECK、引用/类型非空 CHECK（4 列）、`RecoveryPayout.sourceType` 闭合枚举 CHECK；动态字符串判定为非缺口并留档；守卫 `db-constraint-coverage` 21/21，运行库 10/10 约束经 psql 核实 |
| G10 | service→HTTP 未接线复核 | 检查项「service 有但 HTTP 未接线」 | **映射已建立**（`FRONTEND-WIRING-MAP.md` §3）：已接线 carrier manual/response、customs start-recovery/filing-status、platform write、claim、billing、evidence、provider readiness；未接线者为 C15/C16/C19 ingest/C20/fee preview（均按设计供上层使用或 HOLD_EXTERNAL） |


| G11 | Customs G4 能力 HTTP/前端接线（C1–C7 目前只有 service/契约层） | 检查项「service 已实现但 HTTP 未接线」「UI 无真实 backend」 | 计划：只读 GET（entry fact / duty truth / discrepancy / eligibility / estimate / claim-ready package）+ 受 Action Guard 保护的 handoff 记录端点；前端只读页接线；全程 filingSubmitted=false / TRANSPORT=false |

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

## E. BUSINESS SURVIVAL GATES（生死线，HOST FINAL ACCEPTANCE RULES 2026-10-03）

| 生死线 | 状态 | 证据 |
|---|---|---|
| **A. 海关合规与证据链比对**（Import ↔ Return/Export/Destruction） | **CLOSED**（CI `3417377` success） | 匹配契约 10/10；Return 事实 append-only 持久化 PG 5/5；全链 evidence PG E2E 8/8（EXACT 只计匹配数量 / PARTIAL 按比例 / AMBIGUOUS 与 digest 篡改一律零计入 / qualification 未过 409 / VIEWER 绕过 403 / policyVersion 重算 latest 生效 / 跨租户不可见）；只读视图单测 3/3；**路由级 HTTP E2E 4/4**（401/403/404/200 + 跨租户 404）；migration `20261003160000`/`20261003180000`；CI：`33d8633` success（含全部上述单测/DB 套件） |
| **B. 数据安全与客户筛选** | **CLOSED** | Qualification Gate 单测 11/11（qualified/conditional/not-qualified/indeterminate + 成本占比 + 政策版本）；判定 append-only 持久化 PG 5/5（幂等、历史与 latest、触发器拒绝 UPDATE/DELETE、跨租户隔离）；**后端强制 Gate**：未通过 → HTTP 409，VIEWER 绕过 → 403（PG E2E 断言）；Enterprise Trust 状态模型 + 禁自证守卫 2/2（`SOC2_COMPLIANT`/`ISO27001_CERTIFIED`/`BANK_GRADE_SECURITY` 仅允许在否定/未取得语境出现；`EXTERNAL_AUDITED` 当前 0 项）；CI：`33d8633` success |

说明：A 的路由级 HTTP E2E 提交 `3417377` 已 CI success；两条生死线均**不改变** HOLD_EXTERNAL（真实 filing / broker 提交 / 外呼 / 生产凭据 / 资金动作仍关闭）。
