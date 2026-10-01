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
- **evidence.read 小批次**：已接入 `GET /cases/:id/evidence` + Action Guard 只读契约（缺 guard / 能力不可用失败关闭；租户与权限检查复用既有投影；拒绝不泄露内容/地址/存储引用），专项 6/6 → 送审中
- 剩余：`appeal.submit` / `platform.write`（EXTERNAL_WRITE，继续 HOLD）
