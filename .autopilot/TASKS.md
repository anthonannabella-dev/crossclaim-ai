
### HOST DIRECTIVE 2026-10-01「冻结底座 + 加速交付」（长期有效）

- **TRACK B · 平台 API 准入准备线（R11）**：`docs/platform-approval/`（总纲 + 五平台 scope 矩阵 + 数据流 + 安全证据 + 隐私生命周期 + OAuth 生命周期 + IR + 宿主清单）；**不得阻塞 TRACK A**（R44 → R45 → R46 → Full Regression → Production Candidate）。

- **开源优先复用 + 商用许可统一机制（R10）**：矩阵 `docs/releases/OPEN_SOURCE_REUSE_MATRIX.md`；登记表 `tools/license-gate/oss-registry.json`；校验 `node tools/license-gate/check-oss-registry.mjs --root .`（挂在既有 license-gate CI job）；模型权重 `MODEL_LICENSES.md`。新模块开工前必须分类 EXISTING / LEGACY_REUSE / OSS_NOW / OSS_LATER / REJECT，并做 A/B/C 许可判定；**不阻塞当前队列**。

- **持久自治规则（跨轮次/会话/runner 重启生效）**：`.autopilot/RULES.md` + `.autopilot/rules.json`；runner 每轮写入 HEARTBEAT，CI 由 `tools/autopilot/check-autopilot-rules.mjs` 校验。
- `ARCH_REVIEW_REQUIRED = NO` ⇒ 直接进入下一执行单元，**不得以「无新裁决」停止或空转**；合法停止条件仅 READY_FOR_REVIEW / HOST_ACTION_REQUIRED / ARCHITECT_BLOCK / UNRESOLVED_TECHNICAL_BLOCK。

- 策略文档：`docs/releases/DELIVERY-ACCELERATION-POLICY.md`；AGENTS.md §三·五。
- 节奏：IMPLEMENT → targeted tests → commit → CI → 风险分类；未触碰高风险边界则直接进入下一执行单元（不空转等裁决）。
- 审计：增量风险审计（只交本轮新增/变化边界 + 证据）；已 PASS 且未变化的底座不再重复送审。
- 架构级审计仅限：Schema 实质变化 / 租户隔离边界 / 权限模型 / 审批·HITL 边界 / 真实外部写 / 资金·结算·扣费 / 幂等·事务·并发一致性 / 安全边界。
- 每轮回报必须含：FOUNDATION_REUSED / NEW_RISK_BOUNDARY / ARCH_REVIEW_REQUIRED。
- 历史清单（Prisma ledger port / T1–T3 / R1 / approval_consumed 同事务 / T2 事务外投递 / PG1–PG10 / reconcile 策略测试）= platform-write ledger 批次，已于 MSG-20261001-21 PASS 关闭。

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
- [x] 14. R44 — Manual Recovery HTTP/API Boundary（MSG-20261001-41 = PASS — CLOSED；REVIEWED_HEAD eca4207 / CI 36865362444 SUCCESS 5/5）（MSG-20261001-39 裁决 NEXT）：仅做入口边界 —— authn → tenant/role → action guard → 服务端 package/basis 解析（客户端不得自证 digest/basis）→ 复用既有 S3/S4 service → 响应语义；验证跨租户 404、重复/并发、错误 package/reference binding、失败零推进、handler 不复制 S3/S4 事务逻辑。禁止 outcome/reimbursement reconciliation、Settlement/Billing 联动、任何平台写 transport。先提交实现计划/边界送审。
- [ ] 15. R44-A — Manual Recovery Approval Creation Boundary（MSG-20261001-41 裁决 NEXT）：谁可创建 approval → 绑定 Claim/Case/package/versioned basis → approval lifecycle → HTTP request contract → 与既有 execution endpoint 对接。冻结规则：creation 与 execution 共用同一 server-side package/basis builder；客户端不得传可信 digest/basis；不得只绑裸 packageId；package 变更（supersede/withdraw/digest/version）后 execution 必须拒绝；creator/executor 各自动作时重验 membership/role。测试 14 项见 STATE.r44_rereview_verdict.r44a_tests。范围外：outcome/reimbursement reconciliation、Settlement/Billing linkage、Amazon write transport、生产凭据。
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

### R42 · Amazon FBA Recovery Write-Operation Capability Evidence（DOCS ONLY，2026-10-01）

- 交付：`docs/releases/AMAZON-FBA-RECOVERY-WRITE-OPERATION-EVIDENCE.md`（12 项输出 + 六项门槛矩阵 + 排除清单 + 取证限制）。
- 证据：官方索引 `llms.txt`（216,733 bytes）全量检索 —— `reimburse` / `claim` / `safe-t` / `a-to-z` / `dispute` **均 0 命中**；相关域仅只读（Finances 检索、FBA Inventory `getInventorySummaries`；`createInventoryItem` 等为 sandbox-only；`createReport` 仅创建报表任务）。
- 结论：**NOT_AVAILABLE / NOT_PROVEN → NEEDS_MANUAL**；Amazon 保持 READ-ONLY；组合根不纳入生产。
- 明确排除：`createReport` / reimbursement 查询 / inventory adjustment 查询 / Seller Central UI / Case·Support 泛化能力 / 浏览器自动化。
- 下一步：提交 R42 送审（docs-only）。

### MSG-20261001-28 裁决（R42 REVISE：证据语言 + negative matrix + 三级状态）

- DECISION：**REVISE**（REVIEWED_HEAD 5c0591d；归档 FULL_COPY_OK）；产品/安全方向 KEEP，仅收紧证据语言与可复核性。
- CHANGE A（已落）：结论改为 `PUBLIC WRITE OPERATION NOT FOUND / NOT PROVEN`；不得写无条件 `NOT_AVAILABLE` / 「官方不存在」。
- CHANGE B（已落）：新增 operation-level negative evidence matrix（Finances / FBA Inventory / Reports / Fulfillment Inbound / Fulfillment Outbound / Notifications / reimbursement·adjustment 读取来源 → closest candidate → why NOT recovery submission）。
- CHANGE C（已落）：三级状态 `PROVEN_AVAILABLE` / `PROVEN_UNAVAILABLE` / `NOT_PROVEN`；本轮落 **NOT_PROVEN** + `executionDisposition = NEEDS_MANUAL`（未来 private/partner API 只产生新 evidence revision）。
- TEST（架构方要求）：文档无绝对表述、最终状态 NOT_PROVEN、NOT_PROVEN→NEEDS_MANUAL、六项门槛仍 fail-closed、不创建 write adapter、不改 TRANSPORT=false、不新增组合根/凭据/网络/Schema —— 均满足（本轮 docs-only）。
- NEXT：提交 R42 RE-REVIEW（docs-only）；通过后进入 **R43 — Amazon Manual Recovery Handoff Design**（ClaimItem → evidence completeness → recovery package → human approval → submission instructions/export → submitted-manual recording → outcome/reimbursement reconciliation）。

### MSG-20261001-29 裁决（R42 CLOSED → R43 Manual Recovery Handoff Design）

- DECISION：**PASS**（REVIEWED_HEAD 419489b / CI 36849923746 SUCCESS）；CHANGE A/B/C 全部收口，**R42 正式关闭**（无需继续 Amazon 自动写入能力搜索）。
- 风险转化：未来若 Amazon 公开新 operation/partner API，只新增 evidence revision 并重走六项 transport Gate，不修改历史 R42 事实。
- NEXT：**R43 — Amazon Manual Recovery Handoff Design（只交 Design Proposal，不实现）**：ClaimItem → Evidence Completeness → Recovery Package → Human Approval → Submission Instructions/Export → SUBMITTED_MANUAL → Outcome Tracking → Reimbursement/Settlement Reconciliation。
- R43 十二项重点与「生成材料 ≠ 已提交 ≠ 已受理 ≠ 已赔付」四事实分离见 STATE.next_action。
- 边界冻结：AMAZON WRITE HOLD · REAL WRITE ADAPTER HOLD · TRANSPORT=false · 生产凭据/真实外写 继续 HOLD。

### MSG-20261001-30 裁决（R43 设计 REVISE → 先做 R43-A Schema Delta Request）

- DECISION：**PASS WITH REVISE**（REVIEWED_HEAD 07b7009）；总体架构方向批准（四事实分离、证据完整性门槛、package 标注 NOT SUBMITTED、审批绑定 package digest、export 不产生已提交事实、SUBMITTED_MANUAL 仅人工确认、outcome 事实证据、reconciliation 本阶段只读、全链路 fail-closed）。
- CHANGE A：SUBMITTED_MANUAL 走既有 **ClaimItem 状态机**（ClaimItemStatus 已含该状态），AuditLog 仅 append-only 证据；providerCaseRef/submittedAt/submittedBy/submissionEvidence **先提 Schema Delta Request**。
- CHANGE B：动作名 `recovery.manual_submit` 批准；OWNER/ADMIN 批准、执行者须当前 ACTIVE member 且执行时重验；approval 绑定 `claimItemId + caseId + packageDigest`；package 变化 → 旧审批失效；consumption 与成功确认**原子**；并发/重复确认至多一次成功。
- CHANGE C：导出第一版 = **PDF + machine-readable JSON manifest**（先定义 artifact，不实现）；证据只引用既有 EvidenceArtifact/FileAsset；export 不存 credential/token；artifact 默认 **24 个月**保留（取更严格者）；**时间桶不得作为提交链核心幂等依据**。
- CHANGE D：Reconciliation 与资金域**继续分离**（只输出 matched/unmatched/ambiguous；不得触碰 Settlement/Billing/RecoveryLedgerEntry/费用）；后续单独提交 Recovery Reconciliation → Settlement Boundary Design。
- NEXT：**R43-A — Manual Recovery Persistence Schema Delta Request**（docs-only，8 项）；获批后再提交 R43 Implementation Plan；不要直接进入完整 R43 实现。
- 保持：AMAZON WRITE HOLD · REAL WRITE ADAPTER HOLD · TRANSPORT=false · 生产凭据/真实外写 HOLD · **SETTLEMENT/BILLING LINKAGE HOLD**。

### MSG-20261001-31 裁决（R43-A Schema Delta 批准 + CHANGE A/B/C → R43-B Implementation Plan）

- DECISION：**PASS WITH REVISE**（REVIEWED_HEAD f2a20b9；Issue #2 comment 5930157696；CI 36853926652；逐字归档 FULL_COPY_OK）。
- 获批：4 张新表（`RecoveryPackage` / `RecoveryPackageArtifact` / `RecoveryManualSubmission` / `RecoveryManualSubmissionEvidence`）+ 2 枚举；8 项持久化边界均有结论。
- 决议要点：①`READY_TO_APPEAL` 为唯一前置；②`requires` 仅 `[humanApproval]`，但仍需 RBAC/action guard（ACTIVE user/membership、当前角色、tenant boundary、action permission）；③v1 单链 `@@unique([organizationId, claimItemId])`；④`providerCaseRef` 可空但补录须 canonical + 租户 partial unique + append-only audit；⑤独立 package 表；⑥submission-evidence 联结表；⑦I1/I2 只读一致性 checker 必須进入 CI（只报告不自动修复）；⑧append-only 需按 CHANGE A 收紧。
- CHANGE A：artifact / submission / submission-evidence 全表 immutable；`RecoveryPackage` **仅核心字段 immutable**（identity / binding / digest / version），`status` 只能经受控 CAS；禁止普通 update 改 digest · Claim/Case binding · packageVersion；SUPERSEDED/WITHDRAWN 必須带 reason + actor + audit；实现前定义可变字段白名单。
- CHANGE B：`approvalId` 必須进入单链不变量 —— 同一 approval 不得授权两条 manual submission；新增 `UNIQUE(organizationId, approvalId)`；若创建时必有则设为 required；与 `recovery.approval_consumed` 同事务。
- CHANGE C：`providerCaseRef` 唯一性必須基于 **canonical value**（trim → Unicode normalize → provider 特定归一化）并保存/比较 canonical identity；Amazon 大小写语义未证明前不得擅自 lower-case。
- TEST：M1–M11 接受为基础矩阵，另增 9 项（双向一致性 / 同 approval 并发 / digest·binding 不可改 / CAS 合法性 / immutable 直接 UPDATE 被拒 / canonical 重复被拒 / ref 为空仍可确认 / 补录不改变 accepted 事实 / checker 只报告）；PG1–PG10 / H1–H9 / D1–D4 基线继续保留。
- NEXT：**R43-B — Manual Recovery Persistence Implementation Plan（docs-only，10 项）** —— ①migration 顺序 ②四表 FK/unique/index ③tenant + immutable/controlled-mutation triggers ④package CAS 状态机 ⑤`recovery.manual_submit` Action Guard ⑥approval + ClaimItem + submission + audit 原子事务 ⑦providerCaseRef canonicalization ⑧consistency checker ⑨M1–M11 + MSG-31 新增验收 ⑩rollback 仅设计不执行；不需再送一轮 Schema Request，经审后才编码。
- 保持：AMAZON WRITE HOLD · REAL WRITE ADAPTER HOLD · TRANSPORT=false · PRODUCTION CREDENTIALS HOLD · REAL EXTERNAL WRITE HOLD · SETTLEMENT/BILLING LINKAGE HOLD。

### MSG-20261001-32 裁决（R43-B 批准 + CHANGE A/B/C → R43 Implementation S1）

- DECISION：**PASS WITH REVISE**（REVIEWED_HEAD 409dbd0；Issue #2 comment 5930209791；CI 36854327085；归档 FULL_COPY_OK）。Implementation Plan 主体批准：S1→S7 分批实施、四表职责分离、approvalId required + UNIQUE(org, approvalId)、v1 单链、package digest/binding/version immutable、Artifact/Submission/SubmissionEvidence append-only、canonical ref 与 raw 分离、同事务跃迁、checker 只读、M1–M20 + PG/H/D。
- 实施细节四项：①risk=INTERNAL_WRITE + requires=[humanApproval]（humanApproval 不替代 RBAC 层）②`cc_append_only__<Table>` 不进 `required-triggers.json`，但**必須新建独立 append-only/controlled-mutation trigger checklist 并在 CI 显式验证（fresh + upgrade）** ③checker：CI 不一致 = hard failure；生产只 report/alert④PDF 优先复用现有依赖，JSON manifest 为规范事实载体。
- CHANGE A：新增第五张 append-only 表 `RecoveryManualSubmissionReference`；Submission 本体保持完全 immutable；禁止在 Submission 上直接 UPDATE providerCaseRef。
- CHANGE B：`RecoveryPackage` 终态仅 SUPERSEDED/WITHDRAWN；EXPORTED 不阻断后续 export/approval/manual-submit；export 表达为 append-only export event/artifact。
- CHANGE C：approval basis 至少绑定 claimItemId + caseId + packageVersion + digestVersion + packageDigest；创建与执行共用同一个服务端 canonical builder。
- NEXT（无需 docs-only 复审）：**R43 Implementation S1** —— Schema + migration + triggers + trigger inventories + fresh/upgrade tests → 单独 Implementation Checkpoint；S1 通过后才能进入 S2–S5。若采用第五张表，S1 同步更新模型计数（43→44）、FK、tenant/append-only 触发器与 checker 设计。
- 保持：AMAZON WRITE HOLD · REAL WRITE ADAPTER HOLD · TRANSPORT=false · PRODUCTION CREDENTIALS HOLD · REAL EXTERNAL WRITE HOLD · SETTLEMENT/BILLING LINKAGE HOLD。

### R43 Implementation S1（Schema / migration / triggers / inventories）—— 已实现，Checkpoint 待裁决

- 交付：5 表 + 2 枚举（模型 44 = 40 core + 4 join）；5 支迁移（表 / 租户触发器 / package 受控变更 / append-only / 完整性 CHECK）；append-only 独立清单 + 校验器 + CI 与升级双路径验证；新增 S1 DB 不变量测试 10 项。
- 证据：two-stage upgrade OK；S1 DB test 10/10；回归 43 files / 523 tests PASS；tsc PASS；prisma validate valid。
- 送审：REVIEWED_HEAD d39c53e（Issue #2 comment 5930423157 / CI 36855842245）；待 S1 Checkpoint 裁决。
- NEXT：PASS → S2（package 生成 + canonical manifest + digest + CAS；先做现有依赖 PDF 能力检查）；REVISE → 按 CHANGE 修改重送；BLOCK → 停止该方案。

### MSG-20261001-33 裁决（R43 S1 关闭 → R43 S2 Recovery Package Implementation）

- DECISION：**PASS**（REVIEWED_HEAD d39c53e；归档 FULL_COPY_OK）。S1 关闭；M6 合并进 M1 获认可；append-only 清单方案满足条件。
- NEXT：**R43 S2 — Recovery Package Implementation**：package generation → canonical JSON manifest → digest/version → artifact generation → package CAS lifecycle；S2 完成后提交 Implementation Checkpoint。
- S2 禁止：不注册 recovery.manual_submit / 不消费 approval / 不改 ClaimItem 状态 / 不创建 RecoveryManualSubmission / 不接 HTTP confirmation / 不外写 / 不联动 Settlement·Billing。
- S2 PDF 依赖：先做现有依赖能力检查，优先复用；必须新增则单独提 dependency delta。JSON manifest 为规范事实载体，PDF 为派生物。

### MSG-20261001-34 裁决（R43 S2 关闭 → R43 S3 recovery.manual_submit）

- DECISION：**PASS**（REVIEWED_HEAD 4ad4016；归档 FULL_COPY_OK）。S2 关闭；S2 测试 15/15 列为长期回归基线。
- NEXT：**R43 S3 — recovery.manual_submit**：严格顺序实现锁内重验 + 原子人工提交确认（详见 STATE.r43s2_verdict.s3_spec）；S3 验收 14 项（s3_acceptance）。
- S3 禁止：不得顺带 providerCaseRef 后补 / outcome tracking / reconciliation / Settlement linkage（留 S4/S5）。
- 保持：AMAZON WRITE HOLD · REAL WRITE ADAPTER HOLD · TRANSPORT=false · PRODUCTION CREDENTIALS HOLD · REAL EXTERNAL WRITE HOLD · SETTLEMENT/BILLING LINKAGE HOLD。

### MSG-20261001-35 裁决（R43 S3 REVISE → 补 CHANGE A/B/C 后 RE-REVIEW）

- DECISION：**REVISE**（REVIEWED_HEAD b6be095；归档 FULL_COPY_OK）。S3 主体 KEEP；执行人权限与审计名认可。
- CHANGE A/B/C：成功审计失败回滚、approval_consumed 失败回滚、digestVersion/packageDigest 不匹配拒绝（均已补测试）。
- NEXT：**R43 S3 RE-REVIEW**（不扩大范围）；S3 PASS 前不进入 S4。

### MSG-20261001-36 裁决（R43 S3 关闭 → R43 S4 providerCaseRef 补录）

- DECISION：**PASS**（REVIEWED_HEAD 4c6c865；归档 FULL_COPY_OK）。S3 正式关闭。
- NEXT：**R43 S4**：受保护 reference 补录动作 + canonicalization + append-only INSERT + 审计 + 读取/展示；12 项要求见 STATE.r43s3_rereview_verdict.s4_scope。
- 禁止：不 UPDATE Submission / 不产生 accepted·reimbursed·recovered / 不改 ClaimItem 状态 / 不消费旧 approval / 不进入 outcome·reconciliation。

### MSG-20261001-37 裁决（R43 S4 关闭 → R43 S5 只读 checker + CI）

- DECISION：**PASS**（REVIEWED_HEAD 6b5ec65；归档 FULL_COPY_OK）。S4 正式关闭。
- NEXT：**R43 S5**：`tools/consistency/check-recovery-manual-submission.mjs` 12 项只读检查；CI 同时覆盖 fresh deploy / upgrade path / clean / intentional-drift；不得 repair mode。
- 保持：AMAZON WRITE HOLD · REAL WRITE ADAPTER HOLD · TRANSPORT=false · PRODUCTION CREDENTIALS HOLD · SETTLEMENT/BILLING LINKAGE HOLD。

### MSG-20261001-38 裁决（R43 S5 关闭 → R43 S6 全量回归收口）

- DECISION：**PASS WITH REVISE**（REVIEWED_HEAD a2c4306；归档 FULL_COPY_OK）。S5 关闭，无需单独 S5 RE-REVIEW。
- 认可：checker 纯只读（DETECT ≠ REPAIR 为长期不变量，后续禁加 --fix/自动修复）；clean→0、漂移→非零；fresh + upgrade 双路径；终态 package → NOTICE 事实报告。
- S6 必须补：CHANGE A（approval 语义强校验映射/补齐）+ CHANGE B（DB 接受的业务漂移 fixture → checker 拒绝 → zero repair）。
- S6 报告矩阵：M1–M20 / PG1–PG10 / H1–H9 / D1–D4 / S2–S5 基线 / fresh migration / two-stage upgrade / trigger inventories / architecture contract / tsc / prisma validate / 全量 suite；不得用 skip/放宽断言/删除历史测试收绿。
- NEXT：**R43 S6 — Full Regression / Release Checkpoint**（不新增产品能力）→ 最终 R43 Implementation Checkpoint（由架构方判定 R43 是否整体关闭）。
- 保持：AMAZON WRITE HOLD · REAL WRITE ADAPTER HOLD · TRANSPORT=false · PRODUCTION CREDENTIALS HOLD · REAL EXTERNAL WRITE HOLD · SETTLEMENT/BILLING LINKAGE HOLD。

### R43 S6（Full Regression / Release Checkpoint）—— 已实现，最终 Checkpoint 待裁决

- 交付：checker 新增 approval 语义强校验（5c）+ 6 个新测试用例（S6-A1/A2/A3、S6-B1/B2/B3）；未新增产品能力、未改 Schema/migration/触发器清单。
- 证据：checker 11/11；全量 165 files / 1574 tests PASS；two-stage upgrade OK；租户触发器 42 / append-only 5；tsc + prisma validate PASS；api-contract + audit-coverage OK。
- 送审：REVIEWED_HEAD f77da82（Issue #2 comment 5931572320 / CI 36861687249）。
- NEXT：PASS（且 R43 整体关闭获批）→ 转为下一授权队列批次（② 剩余业务入口，须另送审）；REVISE → 按 CHANGE 重送；BLOCK → 停止。
- 保持：AMAZON WRITE HOLD · REAL WRITE ADAPTER HOLD · TRANSPORT=false · PRODUCTION CREDENTIALS HOLD · SETTLEMENT/BILLING LINKAGE HOLD。

### MSG-20261001-39 裁决（R43 整体关闭 → R44 Manual Recovery HTTP/API Boundary）

- DECISION：**PASS — R43 CLOSED**（REVIEWED_HEAD f77da82；CI 36861687249 SUCCESS 5/5；归档 FULL_COPY_OK）。R43 S1–S6 整体关闭，不再创建 S7/S8。
- 冻结：R43 完成定义（持久化闭环）+ 永久回归基线（M1–M28 / PG1–PG10 / H1–H9 / D1–D4 / canonical·digest / approval semantic binding / 事务故障回滚 / 并发 exactly-once / reference canonicalization / checker intentional drift / fresh + two-stage upgrade / trigger inventories / architecture·audit contracts）。
- NEXT：**R44 — Manual Recovery HTTP/API Boundary**（仅入口边界：authn → tenant/role → action guard → 服务端 package/basis 解析 → 复用 S3/S4 服务 → 响应语义）；不得实现 outcome/reconciliation、不得联动 Settlement/Billing、不得开启任何平台写 transport。
- 后续独立批次：R45 Outcome/Reimbursement Reconciliation、R46 Settlement/Billing Linkage（各自单独设计+审计）。
- 保持：AMAZON WRITE HOLD · REAL WRITE ADAPTER HOLD · TRANSPORT=false · PRODUCTION CREDENTIALS HOLD · SETTLEMENT/BILLING LINKAGE HOLD。

### R44（Manual Recovery HTTP/API Boundary）—— 已实现，增量风险审计待裁决

- 交付：`apps/api/src/services/recovery/http-request.ts` + 路由接线 + 路径白名单 + 错误映射；`recovery-manual-http-db.test.ts` 10 项；`docs/releases/R44-MANUAL-RECOVERY-HTTP-BOUNDARY-CHECKPOINT.md`。
- 证据：10/10 真库 HTTP 用例；recovery-manual-* 69/69；action-guard 62/62；tsc / api-contract / prisma validate 全绿（未改 Schema）。
- 送审：REVIEWED_HEAD 219a67c（Issue #2 comment 5931742832 / CI 36863814805）。
- 并行下一单元（不等裁决、不空转）：R45 Outcome / Reimbursement Reconciliation 的 Design + Schema Delta Request（docs-only）。
- 保持：AMAZON WRITE HOLD · REAL WRITE ADAPTER HOLD · TRANSPORT=false · PRODUCTION CREDENTIALS HOLD · SETTLEMENT/BILLING LINKAGE HOLD。

### MSG-20261001-40 裁决（R44 = PASS WITH REVISE → 补 CHANGE A + CI SUCCESS 后 RE-REVIEW）

- DECISION：**PASS WITH REVISE**（REVIEWED_HEAD 219a67c；归档 FULL_COPY_OK）。
- CHANGE A：manual-submit 与 manual-reference 各自补「跨租户 / wrong-case → 404」HTTP 用例，并断言失败零副作用（ClaimItem / Submission·Reference / approval consumption / 资金域不变）。
- CHANGE B：精确 HEAD 的 CI 必须 SUCCESS（送审时为 in_progress）。
- 口径：R44 = Execution HTTP Boundary（非完整 E2E）；审批创建入口属 **R44-A** 独立批次。
- NEXT：R44 RE-REVIEW → 通过后 R44 HTTP Execution Boundary = CLOSED → 进入 R44-A。

### R44 RE-REVIEW（CHANGE A + CI SUCCESS）—— 待裁决

- CHANGE A 已补：两入口各自的跨租户/错案件 404 + 失败零副作用（14/14）。
- CHANGE B 已满足：09e9f6d 与 eca4207 的 CI 均 success 5/5；夹具确定化修复消除 APPROVAL_NOT_APPROVED 偶发。
- 送审：REVIEWED_HEAD eca4207（Issue #2 comment 5932108490 / CI 36865362444）。
- NEXT：PASS → R44 Execution Boundary CLOSED → 进入 **R44-A Approval Creation Boundary**；REVISE → 按 CHANGE 重送；BLOCK → 停止。

### MSG-20261001-41 裁决（R44 CLOSED → 进入 R44-A Approval Creation Boundary）

- DECISION：**PASS — R44 CLOSED**（REVIEWED_HEAD eca4207；CI 36865362444 SUCCESS 5/5；归档 FULL_COPY_OK）。
- NEXT：**R44-A — Manual Recovery Approval Creation Boundary**：谁可创建 approval → 绑定 Claim/Case/package/versioned basis → approval lifecycle → HTTP request contract → 与既有 execution endpoint 对接。
- 冻结：creation 与 execution 同一 builder；客户端不得自证 digest/basis；不得只绑裸 packageId；package 变更 → execution 拒绝；creator/executor 各自重验 membership/role。
- 范围外：outcome/reimbursement reconciliation · Settlement/Billing linkage · Amazon write transport · 生产凭据。

### R44-A（Manual Recovery Approval Creation Boundary）—— 已实现，增量风险审计待裁决

- 交付：`services/recovery/http-request.ts`（requestManualRecoverySubmitApproval）+ `services/workflow/recovery-review.ts`（接受 recovery.manual_submit + boundExtra）+ 路由/白名单 + `recovery-manual-approval-http-db.test.ts` 12 项。
- 证据：12/12 新用例；recovery-manual-* + admin-recovery-review 102/102；tsc PASS；prisma validate valid；无新增依赖。
- 送审：REVIEWED_HEAD 4c43b41（Issue #2 comment 5932597311 / CI 36868784356）。
- NEXT：PASS → R44-B（reference 审批创建）或架构方指定；REVISE → 按 CHANGE 重送；BLOCK → 停止。

### MSG-20261001-42 裁决（R44-A CLOSED → 进入 R44-B Reference Approval Creation）

- DECISION：**PASS**（REVIEWED_HEAD 4c43b41；归档 FULL_COPY_OK）。R44-A 关闭。
- NEXT：**R44-B**：为 `recovery.manual_submit_reference_recorded` 建独立 approval creation 入口；raw→canonical 由服务端；extra 绑 submissionId + claimItemId + providerCaseRefCanonical；action isolation 双向；幂等；creation 不创建 Reference；canonical 变化 → execution fail-closed。
- 范围外：outcome tracking · reimbursement reconciliation · Settlement/Billing linkage · Amazon write · provider acceptance inference。

### R44-B（Reference Approval Creation Boundary）—— 已实现，增量风险审计待裁决

- 交付：`services/recovery/http-request.ts`（requestManualRecoveryReferenceApproval）+ `services/workflow/recovery-review.ts`（接受 reference 动作 + 三项 extra 校验）+ 路由/白名单；`recovery-manual-reference-approval-http-db.test.ts` 12 项。
- 证据：12/12 新用例；家族回归 114/114；tsc PASS；prisma validate valid；无新增依赖。
- 送审：REVIEWED_HEAD f5c322e（Issue #2 comment 5932871096 / CI 36870628101）。
- NEXT：PASS → R44-B CLOSED；若确认 Manual Recovery HTTP approval+execution 边界整体闭合 → 按排序进入 R45（需先 Design + Schema Delta）。

### MSG-20261001-43 裁决（R44-B CLOSED / Manual Recovery HTTP 边界整体闭合 → R45 Design）

- DECISION：**PASS**（REVIEWED_HEAD f5c322e；归档 FULL_COPY_OK）。R44-B 关闭；Manual Recovery HTTP approval + execution boundary **整体 CLOSED**（不再开 R44-C/D）。
- NEXT：**R45 — Outcome / Reimbursement Reconciliation**；第一批只交 **Design / Boundary Proposal**。
- R45 四类事实：SUBMITTED_MANUAL ≠ PROVIDER_ACCEPTED ≠ REIMBURSEMENT_OBSERVED ≠ RECONCILED；12 项设计见 STATE.r44b_verdict.r45_design_items；不确定必须 fail-closed。
- R45 禁止：Settlement / Billing / Fee / 改写 RecoveryLedger / 自动外写 / 开启 transport / observed reimbursement 直接等同可收费 recovered amount。

### R45（Outcome / Reimbursement Reconciliation）—— Design / Boundary Proposal 待裁决

- 交付：`docs/releases/R45-OUTCOME-REIMBURSEMENT-RECONCILIATION-DESIGN.md`（docs-only）。
- 关键：四类事实分离（SUBMITTED_MANUAL ≠ PROVIDER_ACCEPTED ≠ REIMBURSEMENT_OBSERVED ≠ RECONCILED）；12 项设计边界；不确定一律 fail-closed。
- 送审：REVIEWED_HEAD 4d01a09（Issue #2 comment 5932927885）。
- NEXT：裁决 PASS 后按 Q7 提交 Schema Delta Request 或 Implementation Plan（仍不实现代码）。
- 禁止：Settlement / Billing / Fee / 改写 RecoveryLedger / 自动外写 / transport。

### MSG-20261001-44 裁决（R45 Design = PASS WITH REVISE → R45-A Schema Delta Request）

- DECISION：**PASS WITH REVISE**（REVIEWED_HEAD 4d01a09；归档 FULL_COPY_OK）。7 项裁决 + CHANGE A/B/C 见 STATE.r45_design_verdict。
- NEXT：**R45-A — Outcome / Reimbursement Reconciliation Schema Delta Request**（docs-only；仍不实现）。
- 禁止：Settlement / Billing / Fee / 改写 RecoveryLedger / 平台外写 / transport。

### R45-A（Reconciliation Schema Delta Request）—— 待裁决

- 交付：`docs/releases/R45-A-RECONCILIATION-SCHEMA-DELTA-REQUEST.md`（docs-only，未实施）。
- 送审：REVIEWED_HEAD aa9225e（Issue #2 comment 5933085332）。
- NEXT：PASS → R45-B Implementation Plan（仍不写代码）；REVISE → 修订后重送；BLOCK → 停止。
- 禁止：Settlement / Billing / Fee / RecoveryLedger 改写 / 平台外写 / transport。

### MSG-20261001-45 裁决（R45-A Schema Delta = PASS WITH REVISE → R45-B Implementation Plan）

- DECISION：**PASS WITH REVISE**（REVIEWED_HEAD aa9225e；归档 FULL_COPY_OK）。4 项裁决 + CHANGE A–D 见 STATE.r45a_verdict。
- NEXT：**R45-B Implementation Plan**（docs-only；仍不实施 Schema/代码）。
- 禁止：Settlement / Billing / Fee / RecoveryLedger 改写 / 平台外写 / transport。

### R45-B（Reconciliation Implementation Plan）—— 待裁决

- 交付：`docs/releases/R45-B-RECONCILIATION-IMPLEMENTATION-PLAN.md`（docs-only，未实施）。
- 送审：REVIEWED_HEAD 25389be（Issue #2 comment 5933149170）。
- NEXT：PASS → 进入 S1（Schema/migration/触发器清单）；REVISE → 修订计划；BLOCK → 停止。
- 禁止：Settlement / Billing / Fee / RecoveryLedger 改写 / 平台外写 / transport。

### MSG-20261001-46 裁决（R45-B Implementation Plan = PASS WITH REVISE → 授权进入 R45 S1）

- DECISION：**PASS WITH REVISE**（REVIEWED_HEAD 25389be；归档 FULL_COPY_OK）。七表模型 + CHANGE A–C + Q1 basis supersede 事务顺序修正 + Q3 projection 整体替换 + Q4 S1 证据清单，见 STATE.r45b_verdict。
- Q1：supersede 与 replacement INSERT 必须**同一事务**：lock → SELECT current effective FOR UPDATE → 校验 approval/binding/provenance → UPDATE old supersededAt（CAS）→ INSERT new → audit/approval consumption → commit；partial unique 仅最终防线。
- NEXT：**R45 S1 — Schema / Migration / Trigger / Inventory**（首次 Schema 实质变更）。S1 只做数据结构与数据库不变量，完成后**先送 Implementation Checkpoint** 再进 S2。
- S1 排除项：ingest / projector / protected-action HTTP·service / provider API / Settlement·Billing / production credentials。
- 禁止：Settlement / Billing / Fee / RecoveryLedger 改写 / 平台外写 / transport / 生产凭据。

### R45 S1（Schema / Migration / Trigger / Inventory）—— Implementation Checkpoint 待裁决

- 交付：七表 + 七枚举 + M1–M5 迁移 + 两套触发器清单 + 26 项数据库级验收（`docs/releases/R45-S1-RECONCILIATION-SCHEMA-CHECKPOINT.md`）。
- S1 范围纪律：只做数据结构与数据库不变量；未接入 ingest / projector / 受保护动作 HTTP·service / provider API。
- 送审：REVIEWED_HEAD 8129998（Issue #2 comment 5933790490）。
- 需裁决：generation 一致性顺序由「CAS → DELETE → INSERT」调整为「DELETE → CAS → INSERT」（立即判定；deferred 在 Prisma 下静默回滚）。
- NEXT：PASS → R45 S2（ingest）；REVISE → 修订；BLOCK → 停止。
- 禁止：Settlement / Billing / Fee / RecoveryLedger 改写 / 平台外写 / transport / 生产凭据。

### MSG-20261001-47 裁决（R45 S1 = PASS WITH REVISE → 批准 S1 主体 + generation 顺序调整 → 进入 R45 S2 ingest）

- DECISION：**PASS WITH REVISE**（REVIEWED_HEAD 8129998；归档 FULL_COPY_OK）。S1 主体满足授权范围；Q2 批准 `DELETE → CAS → INSERT`（立即判定）；Q3 批准进入 S2。详见 STATE.r45_s1_verdict。
- 新增永久验收：DELETE 已执行后 CAS 或 INSERT 人为失败 → 事务回滚后旧 projection generation 与旧 membership **逐行保持**。
- CHANGE A（预登记）：projection.basisId / tolerancePolicyId 弱引用 → S3 读取强校验（exists / 同租户 / scope / effective·version）+ S5 checker 判 dangling·cross-tenant·scope mismatch 为 inconsistency。
- CHANGE B（预登记）：evidenceArtifactIds text[] 为 v1 有条件方案 → 人工 outcome 写路径逐条验证（存在 / 同租户 / 类型状态 / 不重复）；checker 检测 dangling·cross-tenant；未来升级关系表。
- CHANGE C（预登记）：system exact policy 必须「确定性查询 → 受控幂等创建 → unique scope 收敛 → Projection 持久化真实 policyId+version」；禁止隐式 0/0。
- NEXT：**R45 S2 — ingest only**（ProviderOutcomeFact / ReimbursementFact + identity/fingerprint + replay 幂等 + reversal ingest）；不含 projector、不含人工 outcome 受保护 HTTP。
- 禁止：Settlement / Billing / Fee / RecoveryLedger 改写 / 平台外写 / transport / 生产凭据。

### R45 S2（Reconciliation ingest）—— Implementation Checkpoint 待裁决

- 交付：identity v1 指纹 + provider outcome / reimbursement ingest（幂等复用 vs fail-closed 区分）+ 19 项新增验收（7 纯函数 / 12 真实 PostgreSQL）。
- S2 范围纪律：未实现 projector、未开放人工 outcome 受保护 HTTP、零 Schema 变更。
- 送审：REVIEWED_HEAD 8706b2d（Issue #2 comment 5934172241）。
- NEXT：PASS → R45 S3（deterministic projector，DELETE → CAS → INSERT）；REVISE → 修订；BLOCK → 停止。
- 禁止：Settlement / Billing / Fee / RecoveryLedger 改写 / 平台外写 / transport / 生产凭据。

### R12（Success Fee / Billing 永久红线）—— HOST DIRECTIVE 2026-10-02

- 红线：`Reimbursement observed ≠ recovered ≠ billable`；只有 `Settlement = RECEIVED`（+ CONFIRMED + RECONCILED/PARTIAL + 证据可追溯 + 未被冲回）才可计费开票。
- 自动扣款：独立 Production / Payment Authorization Gate，**HOLD**（需客户明确预授权 + 支付通道正式验收 + 架构方与宿主书面放行）。
- 落盘：`docs/releases/SUCCESS-FEE-BILLING-REDLINE.md` / `.autopilot/RULES.md` R12 / `.autopilot/rules.json` / runner / checker。
- R46 设计/计划必须显式引用本红线并逐条对应可计费判定与禁止清单。
- 队列：R45 不变（S2 送审中 → S3 → S4 → S5）。

### MSG-20261002-48 裁决（R45 S2 = PASS → S2 CLOSED → 进入 R45 S3 Deterministic Projector）

- DECISION：**PASS**（REVIEWED_HEAD 8706b2d；归档 FULL_COPY_OK）。S2 CLOSED；`MANUAL_PATH_DEFERRED` 获批；批准进入 S3。详见 STATE.r45_s2_verdict。
- NEXT：**R45 S3 — Deterministic Projector**（范围冻结：immutable facts + effective basis + effective tolerance policy + 合法 override inputs → deterministic computation → persisted Projection + ProjectionFact membership；**不得**顺带实现 S4 受保护写动作）。
- 事务顺序（冻结）：lock projection/claim scope → 固定输入 → 强校验 basis/policy → deterministic rebuild → inputDigest → DELETE old membership → CAS header → INSERT new membership → audit → commit；失败必须完整恢复。
- 永久验收 16 项见 STATE.r45_s2_verdict.s3_permanent_acceptance；S3 完成后先提交 S3 Implementation Checkpoint 再决定是否进入 S4。
- 风险：不得把旧 Projection 当业务计算输入。
- 禁止：Settlement / Billing / Fee / RecoveryLedger 改写 / 平台外写 / transport / 生产凭据。

### R45 S3（Deterministic Projector）—— Implementation Checkpoint 待裁决

- 交付：纯计算层（定点金额 / canonical inputDigest / 状态判定）+ 锁内 IO 层（DELETE → CAS → INSERT 整体替换 membership，含中途失败完整回滚）。
- 范围纪律：未实现 S4 受保护写动作；零 Schema 变更。
- 送审：REVIEWED_HEAD 46074bd（Issue #2 comment 5934720171）。
- NEXT：PASS → R45 S4（basis set / basis supersede / override / provider outcome 人工录入）；REVISE → 修订；BLOCK → 停止。
- 禁止：Settlement / Billing / Fee / RecoveryLedger 改写 / 平台外写 / transport / 生产凭据。

### MSG-20261002-49 裁决（R45 S3 = PASS WITH REVISE → S3 主体 CLOSED → 进入 R45 S4）

- DECISION：**PASS WITH REVISE**（REVIEWED_HEAD 46074bd；归档 FULL_COPY_OK）。S3 主体 CLOSED；详见 STATE.r45_s3_verdict。
- REVISE 落地：① `AMOUNT_EXCEEDS_EXPECTED` 结构化金额异常（区别于匹配歧义）② cross-tenant / dangling basis·policy → fail-closed（不得降级为无 basis）③ inputDigest 覆盖 algorithmVersion 与全部有效输入。
- NEXT：**R45 S4 — Protected Reconciliation Actions**（basis_set / basis_supersede / override / provider_outcome_record；INTERNAL_WRITE + humanApproval + 锁后角色重验；人工 outcome evidence 逐条校验；supersede 顺序与后置失败恢复）。
- 禁止：Settlement / Billing / Fee / RecoveryLedger 改写 / 平台外写 / transport / 生产凭据。

### R13（Success Fee 支付授权分离 / Onboarding / 自动收费契约）—— HOST DIRECTIVE 2026-10-02 补充二

- 授权分离：Platform OAuth ≠ Payment Authorization（不得推导、不得依赖平台余额扣取佣金）。
- Onboarding：免费扫描不得强制绑卡；「开始追回 + 条款 + Payment Mandate」之后才进入正式执行。
- 自动收费：仅当存在有效 Payment Authorization / PaymentMethod / Mandate 才可自动扣款；否则只出账单。
- 支付数据：不保存 PAN / CVV / 网银密码；只保存 provider 引用。
- 实施时点：R46 完成后由独立 Payment Activation Gate 实施（当前 HOLD）；R45 → R46 队列不变。

### R45 S4（Protected Reconciliation Actions）—— Implementation Checkpoint 待裁决

- 交付：四个受保护动作（basis set / supersede / override / 人工 provider outcome）+ 审批绑定 + evidence 逐条校验 + 失败零推进。
- 范围纪律：零 Schema 变更；未开放 Settlement/Billing/Fee/RecoveryLedger/平台外写。
- 送审：REVIEWED_HEAD e4dcee3（Issue #2 comment 5935348764）。
- NEXT：PASS → R45 S5（只读 checker + 全量回归收口）；REVISE → 修订；BLOCK → 停止。
- 禁止：Settlement / Billing / Fee / RecoveryLedger 改写 / 平台外写 / transport / 生产凭据。

### R14（Customs / Duty Drawback / BrokerConnector）—— HOST DIRECTIVE 2026-10-02 补充三

- BrokerConnector：多 transport（API/Webhook · ABI Vendor · EDI/SFTP · Manual Portal）、不绑定单一 Broker、不污染核心领域模型。
- 执业边界：CrossClaim ≠ Customs Broker；Broker 负责 licensed review/filing/CBP communication。
- 三授权域独立：Platform OAuth / Broker POA / Payment Authorization 互不推导。
- 费用独立：Broker Fee 与 CrossClaim Fee 可独立表达；禁止默认分佣模式（需专门合规审查）。
- 退款：优先直达 claimant/customer 账户；不得默认代收/资金池/截留。
- 实施时点：进入 Customs/BrokerConnector 批次时另行提交设计/Schema Delta/合规审计/测试；R45 → R46 不变。

### MSG-20261002-50 裁决（R45 S4 = PASS WITH REVISE → S4 主体 CLOSED → 进入 R45 S5）

- DECISION：**PASS WITH REVISE**（REVIEWED_HEAD e4dcee3；归档 FULL_COPY_OK）。S4 主体 CLOSED；详见 STATE.r45_s4_verdict。
- CHANGE A（先落地）：人工 outcome 完全重放 → `REUSED`；身份冲突 → `EVENT_IDENTITY_CONFLICT`（零推进）。
- CHANGE B/C：S5 checker 必须覆盖 approval 语义与状态语义（19 项最低检查面）。
- NEXT：**R45 S5**（只读 checker + 全量回归收口）→ R45 Full Regression / Release Implementation Checkpoint。
- 禁止：任何自动修复（DETECT ≠ REPAIR）；Settlement / Billing / Fee / RecoveryLedger 改写 / 平台外写 / transport / 生产凭据。

### R45 Release（Full Regression / S5 checker）—— Checkpoint 待裁决

- 交付：只读 checker（14 组）+ 12 项 DB 验收 + CI/升级接入。
- 证据：two-stage upgrade OK · 全量 176 files / 1730 tests PASS · tsc 0 error · prisma validate valid。
- 送审：REVIEWED_HEAD 6f725d1（Issue #2 comment 5935743965）。
- NEXT：PASS（R45 CLOSED）→ R46（Settlement / Billing linkage，独立 Gate）；REVISE → 修订；BLOCK → 停止。
- 禁止：Settlement / Billing / Fee / RecoveryLedger 改写 / 平台外写 / transport / 生产凭据。

### MSG-20261002-51 裁决（R45 CLOSED → R46 Settlement / Billing Linkage Design Gate）

- DECISION：**PASS — R45 CLOSED**（REVIEWED_HEAD 6f725d1；归档 FULL_COPY_OK）。详见 STATE.r45_release_verdict。
- NEXT：**R46 Design Proposal（docs-only，回答 15 问）**；Design 获批前保持初始红线（NO Settlement creation from R45 / NO FeeCalculation / NO BillingInvoice / NO Payment activation / NO autopay / NO platform write）。
- R13 Payment Activation Gate 继续 HOLD；R45 永久回归基线不得删除、skip 或弱化。

### R46（Settlement / Billing Linkage）—— Design Proposal 待裁决

- 交付：`docs/releases/R46-SETTLEMENT-BILLING-LINKAGE-DESIGN-PROPOSAL.md`（docs-only；15 问答复 + 事实分层 + 硬不变量 + 动作闸门建议）。
- 送审：REVIEWED_HEAD 51b27ff（Issue #2 comment 5935875894）。
- NEXT：PASS → R46-A Schema Delta Request（docs-only）；REVISE → 修订设计；BLOCK → 停止。
- 边界：NO Settlement creation from R45 · NO FeeCalculation · NO BillingInvoice · NO Payment activation · NO autopay · NO platform write。

### MSG-20261002-52 裁决（R46 Design = PASS WITH REVISE → R46-A Schema Delta Request）

- DECISION：**PASS WITH REVISE**（REVIEWED_HEAD 51b27ff；归档 FULL_COPY_OK）。详见 STATE.r46_design_verdict。
- NEXT：**R46-A — Settlement / Billing Linkage Schema Delta Request（docs-only）**：一次完整定义 Settlement external identity / reversal·adjustment / Fee↔Settlement membership / net billable basis / idempotency / receipt snapshot / invoice linkage 边界 / indexes·unique·CHECK·triggers / migration impact。
- 必办 CHANGE A–E 与 15 项永久验收；不得在 R46-A 顺便修改 BillingInvoice 状态机。
- 红线不变（NO Settlement creation from R45 / NO FeeCalculation / NO BillingInvoice / NO Payment activation / NO autopay / NO platform write）；R13 Payment Activation Gate 继续 HOLD。

### R46-A（Settlement / Billing Linkage Schema Delta Request）—— 待裁决

- 交付：`docs/releases/R46-A-SETTLEMENT-BILLING-LINKAGE-SCHEMA-DELTA-REQUEST.md`（docs-only；一次完整送审）。
- 送审：REVIEWED_HEAD 103865f（Issue #2 comment 5936029898）。
- 待裁定：§5.4 legacy 冲回链选型；§6.6 FeeCalculation 作废语义。
- NEXT：PASS → R46-B Implementation Plan（docs-only）；REVISE → 修订本请求；BLOCK → 停止。
- 边界：NO Settlement creation from R45 · NO FeeCalculation · NO BillingInvoice · NO Payment activation · NO autopay · NO platform write；R13 Payment Activation Gate 继续 HOLD。

### MSG-20261002-53 裁决（R46-A = PASS WITH REVISE → R46-B Implementation Plan）

- DECISION：**PASS WITH REVISE — APPROVED FOR IMPLEMENTATION PLANNING**（REVIEWED_HEAD 103865f；归档 FULL_COPY_OK）。详见 STATE.r46a_verdict。
- 必办：CHANGE A1（identity 规范依据）/ B1（SettlementAdjustment 字段 + full reversal 等额）/ C1（不得 UPDATE 旧 FeeCalculation）/ E1（snapshot 不可变）/ F（四个 DB 级不变量）。
- 裁定：§5.4 legacy 冲回链「可读、不回填、不双写」；§6.6 独立 Fee 作废/调整事实。
- NEXT：**R46-B Implementation Plan（docs-only）** → S1…S6（每个高风险 Checkpoint 再送审）。
- 边界：NO R45→Settlement automatic creation · NO automatic Fee · NO automatic Invoice · NO Payment activation · NO autopay · NO platform write；R13 Payment Activation Gate = HOLD。

### R46-B（Implementation Plan）—— 待裁决

- 交付：`docs/releases/R46-B-SETTLEMENT-BILLING-LINKAGE-IMPLEMENTATION-PLAN.md`（docs-only）。
- 送审：REVIEWED_HEAD 5d8786e（Issue #2 comment 5936110978）。
- NEXT：PASS → R46 S1（Schema + migrations + triggers + inventories，零资金行为）；REVISE → 修订；BLOCK → 停止。
- 规则：每个 Stage 独立 Implementation Checkpoint 送审；30 项永久验收；既有基线不得删除 / skip / 弱化。

### MSG-20261002-54 裁决（R46-B = PASS WITH REVISE → R46 S1，先收口 CHANGE A/B/C）

- DECISION：**PASS WITH REVISE**（REVIEWED_HEAD 5d8786e；归档 FULL_COPY_OK）。详见 STATE.r46b_verdict。
- S1 前置：F3 / fee-chain uniqueness 最终方案（fee chain identity 定义）；Settlement↔Snapshot 不可漂移；Invoice 不得从 Fee 自动产生。
- S1 范围：Schema + migration + FK + unique/index + CHECK + triggers + inventories + fresh/upgrade tests（**零资金业务行为**）。
- S1 送审报告项：fee-chain uniqueness / snapshot immutability / full-reversal unique 语义 / FK·partial unique·CHECK·triggers / inventories / fresh deploy / two-stage upgrade / architecture contract / 零资金行为证明。
- 冻结：NO automatic Settlement from R45 · NO automatic Fee · NO automatic Invoice · NO Payment activation · NO autopay · NO platform write；R13 Payment Activation Gate = HOLD。

### R46 S1（Schema + migrations + triggers + inventories）—— 已实施，待裁决

- 交付：4 新表 + 2 表纯增列 + 4 migration + 清单（71 / 20）+ 架构契约 140/140 + DOMAIN_MODEL 同步。
- 送审：REVIEWED_HEAD ab00cd9（Issue #2 comment 5936548245）。
- 证据：fresh deploy OK / two-stage upgrade OK / 全量 176 files 1751 tests PASS / tsc 0 error / 零资金业务行为。
- NEXT：PASS → R46 S2（receipt snapshot + Settlement ingest/record）；REVISE → 修订 S1；BLOCK → 停止。

### MSG-20261002-55 裁决（R46 S1 CLOSED / S2 AUTHORIZED）

- DECISION：**PASS WITH REVISE**（REVIEWED_HEAD ab00cd9；归档 FULL_COPY_OK）。详见 STATE.r46_s1_verdict。
- NEXT：**R46 S2 — Receipt Snapshot + Settlement Record/Ingest Protected Write Boundary**（可信到账证据 → server-side canonical snapshot → humanApproval → Settlement；到此停止）。
- S2 硬验收：canonical digest 等价证明；17 项最低永久验收（含并发同 receipt 至多一条、approval 绑定、零资金外溢）。
- 待办（S4 前）：CHANGE A fee-chain 并发竞争验收（真实 PostgreSQL，独立连接）。
- 边界：NO automatic Settlement from R45 · NO automatic Fee · NO automatic Invoice · NO Payment activation · NO autopay · NO platform write；R13 Payment Activation Gate = HOLD。

### Customs Self-Service Pricing（已登记）

- 交付：`docs/releases/CUSTOMS-SELF-SERVICE-PRICING-CONTRACT.md`；RULES R15；STATE.customs_pricing_directive。
- 状态：REGISTERED / IMPLEMENTATION_STARTED = NO；价格 EXPERIMENTAL 可配置。
- 队列：不打断 R45 → R46 → Full Regression；进入 Customs V1 时再实施 Checkout / Entitlement / Package Unlock。
