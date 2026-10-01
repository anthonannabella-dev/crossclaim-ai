# B2-FIX R1 任务队列（自治循环；完成即自动进入下一项）

## B2-FIX R1 —— 架构方最终裁决 MSG-20260930-10 = PASS（REVIEWED_HEAD 62dffa6 / CODE_HEAD 1144401）

- [x] RuleSet ownership immutable behavior tests (8626e56)
- [x] 1. RuleVersion + RuleEvaluation reference behavior tests（MSG-09 TEST 清单 7/7；0023f51）
- [x] 2. D：既有租户触发器逐项核对（清单式 CI 断言；c74d9bb）
- [x] 3. E：独立临时 PostgreSQL 两段升级（c74d9bb）
- [x] 4. F：迁移同名重纳 byte-identical + checksum（c74d9bb）
- [x] 5. G：历史口径纠偏（docs/releases/B2-FIX-R1-RECORD-CORRECTIONS.md；c74d9bb）
- [x] 6. final local verification（prisma validate / tsc / 17 专项 / 两段升级全绿）
- [x] 7. final CI（62dffa6 run 36650230743 → 5/5 SUCCESS）
- [x] 8. 审查对比 PR #10（base b2-fix-r1-baseline —— 架构方已注明其不交付到 main）
- [x] 9. READY_FOR_REVIEW（已投递并回读验证）
- [x] 10. ChatGPT final audit（MSG-20260930-10 = PASS，已逐字归档 FULL_COPY_OK 52/52）
- [x] 11. 面向 main 的正常集成 PR #11（base main；集成 HEAD e40d4f9；CI run 36651145264 = 5/5 SUCCESS；正式审计请求 comment 5901785441）
- [x] 12. MSG-20260930-10 的三项非阻塞文字口径修正（§8.4 限定 + §10 新增；随集成 PR 复核）

## 边界（持续有效）

- Production Enablement / 真实外写 / 资金操作 / 客户提交 / 生产凭据 = HOLD。
- 本次 PASS ≠ 自动审计桥 / 自治 runner / 产品整体 / 真实数据 / 生产启用通过。
- 进入下一重大 Gate 需架构方裁决；合并决策归架构方，且不得绕过分支保护。

## 下一队列（已授权，等待 PR #11 裁决后再开工）

- [ ] 13. Gate 7 授权队列推进：① ACTION GUARD = 已完成（CP1）；③ PRODUCTION CONTROL PLANE = **PASS**（MSG-20260930-16 / REVIEWED_HEAD e460a82）；**支付域三类受保护内部入口（capture / replay / retry-due）当前工程范围已收口**（retry-due = PASS，MSG-20261001-01 / REVIEWED_REF 9a806eb）；**当前动作 = ② 剩余业务入口的下一小批次**（按 `docs/releases/ACTION-GUARD-CP2-STATUS-AND-INTEGRATION-CHECKLIST.md` §3 选择，逐批次送审）；**② 整体 NOT COMPLETE 之前不开 ⑤/⑥/⑦**（MSG-20260930-16 与 MSG-20261001-01 §7）。
- 开工前先确认：不与 PR #11 的集成范围冲突；涉及安全/资金/规则引擎/Gate 边界的部分需架构方裁决。

## 双账（B2）

| 账目 | 状态 | 证据 |
| --- | --- | --- |
| B2-FIX R1 工程修复（审 PASS） | PASS | MSG-20260930-10（REVIEWED_HEAD 62dffa6 / CODE_HEAD 1144401） |
| B2-FIX R1 面向 main 的集成（审 PASS + MERGE APPROVED） | PASS | MSG-20260930-11（REVIEWED_HEAD e40d4f9 / PR #11 / comment 5901910080） |
| 已交付 main | MERGED + main CI 5/5 SUCCESS（run on 16b47a2） | merge commit `16b47a2` |

> 说明：架构方要求「B2 已审 PASS」与「已交付 main」分别记账；上表即两账分列。
>
> 测试数量归属（架构方 MSG-20261001-01 §5 要求分别绑定提交）：**4c695c0** ＝ 本机 144 文件 / 1334 用例（1314 passed + 20 skipped，phase1-runbook 当时仍失败）；**9a806eb** ＝ CI 144 文件 / **1335** tests PASS（映射单测 9/9、retry-due 28/28、phase1-runbook 20/20）。两者不得混写。

## Gate 7 授权队列（MSG-20260930-03，8 项）

| 项 | 状态 | 证据 |
| --- | --- | --- |
| ① ACTION GUARD（设计 → 实现） | 已完成（CP1 = 纯决策函数 + 审计事件） | 8109003 / 26f78e8 起 |
| ② RUNTIME BUSINESS BLOCKING（Action Guard CP2） | **进行中（整体 NOT COMPLETE）** | 第一批 HITL 提交入口：已接入（见 `ACTION-GUARD-CP2-STATUS-AND-INTEGRATION-CHECKLIST.md` §5/§6）；账单登记入口 `payment.capture` = PASS（MSG-20260930-24 / REVIEWED_REF 73115a3）；`payment.replay` = PASS（MSG-20260930-28 / REVIEWED_REF 08fc45d）；冻结批次 `payment.retry_due` = **PASS**（MSG-20261001-01 / REVIEWED_REF 9a806eb / CI run 36726898061 / Issue #2 comment 5915049394）；**支付域三类受保护内部入口当前工程范围收口**（不等于生产/真实资金/②全覆盖）；其余入口见 §3 清单 TODO |
| ③ PRODUCTION CONTROL PLANE | **已完成 = PASS** | MSG-20260930-16（REVIEWED_HEAD e460a82 / Issue #2 comment 5902610608）；实现：`control-plane.ts` / `control-plane-wiring.ts` / `control-plane-status.ts` / `capability-source.ts` / `kill-switch-adapter.ts`（四层模式 READ_ONLY/DRY_RUN/MANUAL_REVIEW/WRITE_ENABLED，默认 READ_ONLY；配置异常回落 READ_ONLY） |
| ⑤ RELIABILITY | 待开工（**须待 ② 业务覆盖完成**） | MSG-20260930-16 原文顺序：「修复后再推进 ② 业务接入第一批 HITL 提交入口，**优先于新增⑤可靠性工作**」 |
| ⑥ OPERATIONS-ADMIN | 待开工 | — |
| ⑦ SECURITY HARDENING | 待开工 | — |

> CP2 已交付：runtime-guard（fail closed + 审计不可用降级）/ capability-source（Kill Switch 接线）/ guard-enforcement（唯一执行入口 + 不可绕过静态检查），共 34 项 Action Guard 单测。


## 产品范围冻结（HOST PRODUCT DIRECTION 2026-10-01）

CrossClaim AI = **跨境资金损耗 Recovery OS**（四类 Recovery：Platform / Logistics / Customs / Independent-site & Payment），
不是 Amazon/FBA 单点理赔工具；四类共享统一引擎
`Source Data → Canonical Fact → RecoveryOpportunity → Case → Evidence → Claim/Appeal/Dispute → Settlement → RecoveryLedger → Billing`。

- 冻结范围为**长期方向**，不改变既有队列：Gate 7 / Action Guard / claim.prepare 等**继续原计划**，不暂停、不回滚、不重开已 PASS 项。
- 牌照 / 正式报关 / 平台真实写入：维持既有合规边界与人工卡口；真实 API、生产凭据、平台外写继续 **HOLD**。
- 今后每次架构设计与审计以「跨渠道 Recovery OS」为产品总方向。

### 新增后续产品任务：PRODUCT-SCOPE-04 — Independent-site / Chargeback Recovery

- 设计稿：`docs/releases/PRODUCT-SCOPE-04-INDEPENDENT-SITE-CHARGEBACK-RECOVERY-DESIGN.md`（A 领域模型承载评估 / B 最小 Schema Delta / C Shopify·Stripe·PayPal 接入需求 / D 复用映射 / E 设计要点与 backlog）。
- 当前状态：**设计 + backlog 完成，未实施大范围代码**；不打断正在进行的 Gate 7 审计队列。
- 开工前置：D1–D3 枚举扩展（Schema/领域）与资金链路（PS04-5）必须经架构方裁决。


## 自治循环 reconcile 协议（HOST AUTOPILOT PERSISTENCE UPDATE 2026-10-01）

每轮 STEP 0 固定顺序（GitHub 正式裁决优先于本地过期 STATE）：

1. GitHub Issue #2 最新正式 ARCHITECT VERDICT
2. `AI-ARCHITECT-INBOX.md` 最新 MSG
3. `.autopilot/STATE.json`
4. `.autopilot/TASKS.md`

冲突时自动修正低优先级记录（head / current_head / last_chatgpt_message / architect_decision_pending / reviewed_head），修正后继续执行，不停轮。
循环语义：PASS → 下一小批次；REVISE → 立即改并按 CHANGE 重新送审；BLOCK → 停止被否定方案并提替代方案；仅 AGENTS.md §七 HOST APPROVAL REQUIRED 打断循环。

### PRODUCT-SCOPE-04 backlog（登记与设计排队；不抢占 Gate 7 队列）

| ID | 任务 | 依赖 / 前置 | 状态 |
| --- | --- | --- | --- |
| PS04-1 | 枚举扩展迁移（`RecoveryDomain += INDEPENDENT_SITE` / `Channel += SHOPIFY·STRIPE·PAYPAL` / `RouteTarget += PAYMENT_PROCESSOR`；`ALTER TYPE` 独立迁移） | 架构方裁决（Schema/领域） | 排队 |
| PS04-2 | 只读接入：Shopify / Stripe / PayPal（CSV → CanonicalFact） | PS04-1 | 排队 |
| PS04-3 | 检测规则：未响应争议 / 证据缺失 / 金额差异 | PS04-2 | 排队（规则引擎需裁决） |
| PS04-4 | 争议容器映射（ClaimItem/Appeal 复用；可选 disputeStage 字段） | PS04-1 | 排队 |
| PS04-5 | 资金联动：Settlement `DISPUTED` 冲回 + Ledger `REVERSAL` | PS04-4 | 排队（资金链路需裁决） |
| PS04-6 | Action Guard 动作登记与接线（`dispute.evidence.prepare` → `dispute.submit`） | PS04-4 | 排队（EXTERNAL_WRITE 保持 HOLD） |
| PS04-7 | 权限 / 审计 / 看板投影（争议域） | PS04-6 | 排队 |

> 说明：以上为**表格式登记**，不使用 `- [ ]`，以免被 runner 当作当前 Gate 7 队列的下一个执行任务；实施顺序由架构方在 ② 收口后另行裁决。


### ② 队列进展（2026-10-01）

- `claim.submit` = **PASS**（MSG-20261001-07 / REVIEWED_REF 28e0cd9）
- `claim.prepare` = **PASS**（MSG-20261001-10 / REVIEWED_REF d6d239b）
- `billing.draft` = **PASS**（MSG-20261001-13 / REVIEWED_REF d81a86f）
- `evidence.read` = **PASS**（MSG-20261001-14 / REVIEWED_REF 549dba8）
- `appeal.submit` = **PASS**（MSG-20261001-16 / REVIEWED_HEAD 7d888cc / CI 36820104474）—— CHANGE A/B/C 收口：版本化服务端提交快照（审批创建与执行共用同一规范化算法、Appeal 行锁后重算比对）+ 路由/行锁/读取校验/CAS 显式绑定 round=2 并核对 Claim 同租户同案件 + 专项 13 项关键验收；仅登记内部结果（platformWriteExecuted=false）
- 记录：evidence.read 小批次历史记录 —— 已接入 `GET /cases/:id/evidence` + Action Guard 只读契约（缺 guard / 能力不可用失败关闭；租户与权限检查复用既有投影；拒绝不泄露内容/地址/存储引用），专项 6/6 → 送审中
- 剩余：`platform.write`（EXTERNAL_WRITE，继续 HOLD）。下一批仅允许先完成接口、状态机、权限、幂等、审批绑定、模拟适配器与 fail-closed 测试；真实平台外写、客户提交、资金动作一律不启用。

### 长期回归任务（HOST PRODUCT DIRECTION 2026-10-01；不改变 Gate 7 批次顺序）

| 任务 | 内容 | 触发时机 | 状态 |
| --- | --- | --- | --- |
| `GOLDEN-PATH-E2E` | Golden Path E2E（真实 PostgreSQL）：Source Data → Canonical Fact → RecoveryOpportunity → Case → Evidence → Claim Prepare → Claim Submit → 模拟外部处理结果 → Settlement → RecoveryLedger → FeeCalculation → Billing；逐跳校验关联 ID / organizationId / caseId / claimId / settlementId、金额币种状态快照审计审批一致性、任一阶段失败不得非法推进 | 在合适的回归阶段纳入长期 CI；建立后每批次与 S4/S5 必跑 | 排队（未实施） |
| `CROSS-MODULE-REGRESSION` | 命中核心领域模型 / Schema / 状态机 / Action Guard / Claim-Appeal / Settlement / RecoveryLedger / Billing / platform.write / Adapter / Import-CanonicalFact 的改动 → 批次专项之外必须跨模块回归 | 每批次 | 长期有效（已生效） |
| `STATE-MACHINE-REGRESSION` | 状态机改动 → 全局 state-machine regression | 状态机改动 | 长期有效（已生效） |
| `AUTHORIZATION-REGRESSION` | 权限 / Action Guard 改动 → authorization regression | 权限改动 | 长期有效（已生效） |
| `CONTRACT-REGRESSION` | 模块接口变更 → contract regression | 接口变更 | 长期有效（已生效） |

> 全文：`docs/releases/ENGINEERING-REGRESSION-POLICY.md`；AGENTS.md 已同步同一约束。

### platform.write 进展（2026-10-01 · R37 P1/P2）

- `POST /cases/:id/platform/write` 已接线（EXTERNAL_WRITE · fail-closed）：服务端从 DB 事实重算快照/摘要/幂等键；客户端自证 digest/basisReference/payload/organizationId 一律 400；幂等键不一致 409。
- 守卫：`platform.write` 经 withActionGuard（humanApproval）；未注入 Action Guard → 403 ACTION_GUARD_NOT_CONFIGURED；审批绑定 `basisReference` = 服务端快照摘要；载荷策略白名单 `NON_MONEY_APPROVAL_ACTIONS += platform.write`。
- transport 恒关：零投递、零账本写入、不消费审批；响应 `platformWriteExecuted=false` / `executionDisposition=NEEDS_MANUAL`。
- 验收：`platform-write-http-db.test.ts` 12/12（H1–H4/H7 子集，真实 HTTP + PostgreSQL）；跨模块回归 37 文件 / 470 项 PASS；全量 154 文件 / 1472 项 PASS；tsc PASS。
- 剩余：P3 T1/T3 编排接线（`acquireExecutionRight` / `settleAttempt`）→ P4 H5/H6/H8（重放同一链 / 并发唯一链 / 断连幂等）→ P5 全量回归 + Golden Path E2E + CI → 送审 Integration Boundary Implementation Checkpoint。

### platform.write 进展（2026-10-01 · R37 P3）

- `orchestrator.ts`：T1（`acquireExecutionRight`：唯一执行链 + 审批唯一绑定 + CAS + 同事务消费）→ T2（仅门控放行且 `simulated` 端口可投递）→ T3（`settleAttempt` CAS 收敛）。
- `approval-tx-port.ts`：事务内审批核验复用 `verifyApprovalBoundary`（事件族 `recovery.review_approved` / 目标 Case / 载荷指纹 basisReference=快照摘要 / 有效期 / 撤销 / 轮次），消费事实写 `recovery.approval_consumed`（同事务）。
- 门控未放行（global gate / adapter 能力 / 授权）→ 一律 NEEDS_MANUAL，**零账本、零消费、零投递**；T2 结果不可判定 → MANUAL_REVIEW + UNKNOWN_PROVIDER_RESPONSE（禁止重发）。
- 验收：`platform-write-orchestrator-db.test.ts` 10/10（真实 PostgreSQL；含 H5 重放同一链、H6 并发唯一链、H8 断连重试不重发、跨动作冒用拒绝）；platform-write + action-guard 回归 36 文件 / 352 项 PASS；tsc PASS。
- 待裁决（列入 Checkpoint）：transport 关闭时是否应登记 attempt 并消费审批（现行为为不登记、不消费）。
- 剩余：P4 HTTP 层 H5/H6/H8 与补充断言 → P5 全量回归 + Golden Path E2E + CI → 送审。

### MSG-20261001-23 裁决（R38 Integration Boundary Implementation Checkpoint）

- DECISION：**PASS WITH REVISE**（REVIEWED_HEAD f2e1188；归档 FULL_COPY_OK）。
- CHANGE A（已批准现行为）：transport 未获独立 Gate 时 `TRANSPORT=false → NEEDS_MANUAL → attempt=0 → approval_consumed=0 → sinkCalls=0`；不得为「记录请求」伪造 execution attempt（如需请求历史，另建 `platform.write_not_executed` 审计事实）。
- CHANGE B：接受编排层真实 PostgreSQL 证据；补 HTTP 边界证明（handler→orchestrator 唯一执行入口；handler 不持有 write sink、不直接调用 ledger T1、不直接消费 approval、不自造可信 snapshotDigest、无绕过 orchestrator 的路径）。
- CHANGE C：本轮不定义 transport=true 的「成功响应」语义；等第一个真实 provider adapter 设计时按 provider 语义单独批准。
- CHANGE D：本 checkpoint 建立**最小 Golden Path E2E**（安全 Golden Path：HTTP → authn → membership/role → Action Guard → server snapshot → approval binding → orchestrator → transport=false → NEEDS_MANUAL），纳入 CI 作为长期基线。
- NEXT：完成 CHANGE B/D → 全量回归 + CI → 提交 **R38 RE-REVIEW**（无需再走 Design/Plan）。Integration Boundary 关闭后进入 **Provider Adapter Readiness / First Provider Design Gate**。
- 期间保持：REAL ADAPTER HOLD · TRANSPORT=false · PRODUCTION CREDENTIALS HOLD · REAL EXTERNAL WRITE HOLD · CUSTOMER SUBMISSION HOLD。

### MSG-20261001-23 CHANGE B/D 实施（2026-10-01）

- CHANGE B（HTTP→orchestrator 唯一执行入口）：`http-request.ts` 的 `perform` 改为调用 `runPlatformWriteAttempt`；handler 不持有 sink（`sink: null`）、不直接调用 ledger T1、不直接消费 approval、不自造可信 digest；`transport=true` 仍 503 fail-closed（响应语义未获批）。
- CHANGE D（最小 Golden Path E2E）：`platform-write-golden-path-db.test.ts` D1–D4 —— 合法审批 → 200 `platformWriteExecuted=false` / `executionDisposition=NEEDS_MANUAL` / `attempt=0` / `approval_consumed=0` / `sinkCalls=0` / Payment·Settlement·Ledger·Fee·Billing 全 0 / Claim 仍 DRAFT；跨租户 404；缺审批 fail-closed；重复提交同一安全终点。
- 架构契约：`B1` 断言入口只经编排器、T1/T2/T3 仅存在于 orchestrator；原 P4 的 H9 断言已按 CHANGE B 更新。
- 回归：platform-write 家族 71 tests PASS；全量 156 files / 1489 tests PASS；tsc PASS。
- NEXT：提交 R38 RE-REVIEW → PASS 后进入 Provider Adapter Readiness / First Provider Design Gate。

### MSG-20261001-24 裁决（Integration Boundary CLOSED → Provider Adapter Readiness）

- DECISION：**PASS**（REVIEWED_HEAD a23b8db；归档 FULL_COPY_OK 56 行）；MSG-20261001-23 的 REVISE 项全部收口，**Integration Boundary Review CLOSED**。
- 永久回归基线（不得删除或弱化）：Platform Write Ledger PG1–PG10、Integration Boundary H1–H9、Golden Path D1–D4、transport=false 零 attempt/零消费/零 sink、HTTP→orchestrator 唯一入口、跨租户与缺审批 fail-closed。
- NEXT（Provider Adapter Readiness / First Provider Design Gate，**先设计取证、不实现真实写 adapter**）：选定 1 个 provider 作为首个样板，提交 10 项能力档案（endpoint/version/scopes；read·write scope 是否可物理分离；原生 idempotency；request/operation identifier；status-query/reconciliation；ambiguous response 判定；rate limit/retry；credential 生命周期；sandbox/test-mode；自动写入最低能力矩阵评估）。
- 结论口径：任一关键能力无法证明 → 保持 READ-ONLY / NEEDS_MANUAL，不降低现有安全门槛；建议只选一个 provider 先把完整安全模式验证出来。
- 期间保持：REAL ADAPTER HOLD · TRANSPORT=false · PRODUCTION CREDENTIALS HOLD · REAL EXTERNAL WRITE HOLD · CUSTOMER SUBMISSION HOLD。

### R39 · Provider Adapter Readiness（首个样板 provider：Amazon SP-API，2026-10-01）

- 交付：`docs/releases/PROVIDER-ADAPTER-READINESS-AMAZON-SP-API.md`（10 项能力档案 + 最低能力矩阵判定 + 只读接入形态 + 补齐清单 + 待裁决问题）。
- 取证：只读抓取官方文档（`llms.txt` 索引 + 页面 `.md`）；**未访问真实账号、未配置凭据、无写请求**。
- 结论：①⑦⑧⑨ PROVEN；②④⑤ PARTIAL；**③⑥⑩ NOT_PROVEN** → 自动写入最低能力矩阵不满足 → **READ-ONLY 先行；`platform.write` 保持 NEEDS_MANUAL**。
- 代码固化：`amazon-sp-api-readiness.ts` 声明只读描述符（三能力 false）+ `firstProviderWriteDecision()`；回归 `platform-write-provider-readiness.test.ts` 6 项（含「能力不得被静默放宽」、全局 gate 打开仍 `ADAPTER_NOT_ELIGIBLE`）。
- 回归：platform-write 家族 + architecture-contract = 9 files / 186 tests PASS；tsc PASS。
- 下一步：提交 R39 送审 → 裁决后实现只读 adapter 边界（不接真实凭据）或先补逐操作取证。

### MSG-20261001-25 裁决（R39 → Amazon SP-API READ-ONLY Adapter Implementation Plan）

- DECISION：**PASS WITH REVISE**（REVIEWED_HEAD 79a7d36；归档 FULL_COPY_OK 75 行）；首个样板 Amazon SP-API 与「READ-ONLY / platform.write=NEEDS_MANUAL」结论均获批准。
- CHANGE A：下一批实现 **READ-ONLY adapter boundary**（descriptor → auth/credential port abstraction → read fetch contract → pagination/rate-limit handling → normalization boundary → 既有 Connector Runner）；不接真实凭据、不访问真实 seller 数据、不扩大 write scope、不实现写操作；可用 fixture / sandbox-compatible shape / mocked transport 验证。
- CHANGE B：只读能力必须 **operation/resource 级** fail-closed（禁止 provider 级粗粒度布尔）；descriptor 需显式声明 resource / operation / required role·scope / restricted-data requirement / pagination model / rate-limit behavior；未登记 operation 一律拒绝；RDT 受限数据保持独立能力边界。
- CHANGE C：六项写回前置**冻结为 transport 门槛**（按具体 operation 取证）；write eligibility = `provider + operation + capability evidence`，不是 provider 全局布尔值。
- 必测 10 项（下一批）：未登记 resource/operation fail-closed；write operation 永远拒绝；无 RDT capability 时拒绝受限数据；pagination cursor 正确传递；429 不产生重复业务记录；retry 不绕过 sourceFingerprint 幂等；malformed/unknown shape → quarantine 不静默丢弃；adapter 不得取得 platform-write sink；`PLATFORM_WRITE_TRANSPORT_ENABLED=true` 时 Amazon 仍 `ADAPTER_NOT_ELIGIBLE`；PG1–PG10 / H1–H9 / D1–D4 永久基线继续通过。
- 目标链路：`Amazon read contract → Fetcher → Normalizer → ClaimItem/Quarantine`（不是打通自动申诉）；不同时开发 TikTok/Walmart。
- 保持：AMAZON WRITE HOLD · REAL WRITE ADAPTER HOLD · TRANSPORT=false · 生产凭据/真实外写/客户提交 HOLD。

### R40 · Amazon SP-API READ-ONLY Adapter（MSG-20261001-25 CHANGE A/B/C 实施，2026-10-01）

- 代码：`services/adapters/amazon-sp-read-only-adapter.ts` —— operation/resource 级 descriptor（resource/operation/requiredRoles/RDT/pagination/rateLimit/path）+ 授权判定（5 类拒绝原因）+ 凭据端口（未配置即 fail-closed）+ GET-only 只读传输端口 + 分页/429 退避抓取 + 规范化（fingerprint、quarantine）+ 幂等落点编排。
- 只读授权 fail-closed：未登记 operation / resource 不符 / WRITE 操作 / 非 GET / 缺 RDT 能力 一律拒绝；`createReport` 已登记为 WRITE 以证明「写操作永远拒绝」不是靠未登记。
- 规范化：`amazon-sp::<resource>::<operation>::<identifier>`（不含金额）；畸形/缺标识 → `MALFORMED_RECORD`，未登记 operation → `UNKNOWN_SHAPE`，**不静默丢弃**。
- CHANGE C 代码化：`AMAZON_WRITE_TRANSPORT_PREREQUISITES`（六项）+ `isAmazonOperationWriteEligible()`；缺任一项 `eligible=false` / `NEEDS_MANUAL`。
- 文档：`docs/releases/AMAZON-SP-READ-ONLY-ADAPTER-PLAN.md`（目标链路、descriptor 表、端口、分页/限流、幂等、TEST 十项矩阵、六项写回门槛）。
- 证据：`amazon-sp-read-only-adapter.test.ts` 10/10（MSG-25 TEST 十项）+ provider readiness 7/7；platform-write + action-guard + read-only = 39 files / 376 tests PASS；tsc PASS。
- 边界：无真实凭据 / 无真实 seller 数据 / 无 write scope / 无写操作 / 无 Schema·migration·依赖变更；TRANSPORT=false。
- 下一步：提交 R40 Implementation Checkpoint 送审。

### MSG-20261001-26 裁决（R40 CLOSED → R41 Fixture → Connector Runner 集成）

- DECISION：**PASS WITH REVISE**（REVIEWED_HEAD d3f4722；归档 FULL_COPY_OK）；**R40 READ-ONLY adapter boundary = CLOSED**（条件 CI SUCCESS 已满足：run 36845421711 SUCCESS）。
- CHANGE A：CI 已在最终收口前确认 SUCCESS。
- CHANGE B（下一批优先）：**R41 fixture-only integration** —— Amazon descriptor → mocked/fixture Fetcher → Amazon Normalizer → 既有 Connector Runner → `createClaimItem(CONNECTOR_IMPORT)` / Quarantine；**必须复用** sourceFingerprint v1 / ClaimItem 幂等 / cursor 生命周期 / quarantine 白名单 / normalizerVersion / Runner 审计，不得为 Amazon 另建平行链路。
- CHANGE C：write operation 只允许 **docs-only 取证**（优先 FBA reimbursement / inventory-loss recovery 申诉·索赔类），先回答「官方是否存在可用写 operation」；不存在则记录 `WRITE OPERATION NOT AVAILABLE / NOT PROVEN` → NEEDS_MANUAL；禁止浏览器自动化绕过。
- R41 必测 10 项 + PG/H/D 永久基线（见 RUN_LOG）。
- 保持：AMAZON WRITE HOLD · REAL WRITE ADAPTER HOLD · TRANSPORT=false · 生产凭据/真实外写/客户提交 HOLD。

### R41 · Amazon Fixture → 既有 Connector Runner 集成（MSG-20261001-26 CHANGE B，2026-10-01）

- bridge：`services/adapters/amazon-sp-connector.ts` —— `AMAZON_SP_READ_ONLY_CONNECTOR`（无 write scope）+ `createAmazonConnectorFetcher`（单页 + NextToken→nextCursor）+ `createAmazonConnectorNormalizer`（复用 `sourceFingerprintV1`）。
- adapter：新增 `fetchAmazonReadPage`（单页抓取）以匹配 Runner 的「一页一推进」cursor 语义；多页函数改为内部循环复用。
- 集成测试 9 项（真实 PostgreSQL + fixture transport）：正常记录→ClaimItem（platformType AMAZON / claimType ORDER_DISCREPANCY / fingerprintVersion v1）；重放幂等；金额更正不拆单；malformed→Quarantine；quarantine 无 raw/customer/token；cursor 成功推进/失败不推进；normalizerVersion 审计可追溯；Rule Engine 与资金·platform-write 零变化；未登记 resource fail-closed。
- 回归：connector + claim-item + amazon = 7 files / 57 tests PASS；tsc PASS。
- 边界：无真实凭据/账号/网络、无 Schema/migration/依赖变更、TRANSPORT=false。
- 下一步：提交 R41 送审；并可并行准备 docs-only FBA write-operation 取证（不得实现 write adapter）。

### MSG-20261001-27 裁决（R41 CLOSED → R42 FBA 写操作能力取证）

- DECISION：**PASS**（REVIEWED_HEAD 9b399f7；归档 FULL_COPY_OK）；**R41 = PASS_CLOSE**，无需追加实现复审。
- 长期保留：Amazon fixture integration（connector + claim-item + amazon = 57 PASS）作为 regression 基线，真实 connector 接入时不得删除。
- 组合根：**暂不纳入生产**；仅允许 test/fixture composition、disabled descriptor registration、无凭据开发装配；禁止默认运行时实例化 Amazon credential port / 启动即连网 / 有凭据即自动启用 / production composition 隐式开启 ingestion。
- R42（下一批准工作，DOCS / EVIDENCE ONLY）：回答官方是否存在可用的 FBA inventory-loss / reimbursement recovery 写 operation；输出 12 项 + 最终结论（WRITE_ELIGIBLE_FOR_DESIGN | READ_ONLY·NEEDS_MANUAL | NOT_AVAILABLE·NOT_PROVEN）。
- 禁止事项：不得把 createReport / reimbursement 查询 / inventory adjustment 查询 / Seller Central UI 流程 / Case·Support 泛化能力当作“自动发起 FBA 索赔”写入口；不得用浏览器自动化绕过 API 能力缺失。
- 判据：官方文档没有明确证明 = NOT_PROVEN；不能从“能读 reimbursement”推导“能创建 claim”。
- 保持：AMAZON WRITE HOLD · REAL WRITE ADAPTER HOLD · TRANSPORT=false · 生产凭据/真实外写/客户提交 HOLD。
