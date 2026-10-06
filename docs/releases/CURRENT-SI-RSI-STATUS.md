# CURRENT SI/RSI STATUS（唯一现行状态件）

> 授权：HOST 2026-10-06「SI/RSI GAP-CLOSURE DIRECTIVE」步骤 A（DOC-STATE-RECONCILIATION，docs-only）。
> 本文件是**唯一当前状态来源**；所有历史审计 / 证据文档一律视为 `HISTORICAL_SNAPSHOT`，
> 其内过期状态已标注 `SUPERSEDED_BY=<exact HEAD>`（47 份历史文档已加横幅，原文未改写、未删除）。
> 原则：**禁止**把未完成能力写成 PASS；每个 PASS 必须绑定 exact HEAD + 测试证据。

BASELINE_HEAD = `cdd95258`（本状态件基线；后续单元推进时按最新 HEAD 追加，不回溯改写）
BRANCH = `gate/7-commercial-validation`

---

## 1. 状态表（禁止把未完成写成 PASS）

| 能力 | 状态 | 绑定 HEAD | 证据 / 备注 |
|---|---|---|---|
| `SI_RUNTIME_WIRED` | **YES** | `c0b61792` → `5f9ce46f` → `adcab905` | ONE CrossClaim SI Runtime 存在：`apps/api/src/runtime/rsi-{domain-pack,controller,event-loop,task-runner,project-executor,verdict-watcher}.ts`；测试 `rsi-domain-pack-wiring` / `rsi-si-runtime-e2e` / `rsi-runtime-e2e` |
| `RECOVERY_SI_PACK_WIRED` | **YES** | `c0b61792`（Recovery pack）+ `adcab905`（唯一 product 组装点） | `runtime/recovery-si-pack.ts` + `runtime/recovery-si-product-composition.ts`；测试 `rsi-si-runtime-real-guard-e2e`、`rsi-domain-pack-wiring` |
| `REASONING_MODEL_GATEWAY` | **PARTIAL** | `6e98e66e` → `dcccd89d` → `d89b42dc` → `25ad94ea` | 唯一 Model Gateway capability port 已接入（禁第二 Model Router）；**本地模拟可用**，真实网络 / 付费模型 = `HOLD_EXTERNAL`。测试 `rsi-si-model-gateway`、`rsi-si-model-chain-e2e`、`rsi-local-sim-adapter`、`rsi-model-router` |
| `CONTROLLED_RSI_READY` | **PARTIAL** | PHASE 5 收口 `b3629ffc`（MSG-20261005-83） | controlled learning 采用链（candidate → approval → rollback plan → controlled config proposal → canary/shadow → adoption review）全为 `PROPOSAL_ONLY / SHADOW_ONLY / ROLLBACK_PLAN_ONLY`，**无自动执行入口**；`CONTROLLED_RSI` 的“可控性”已具备，生产采用未启用 |
| `LONG_HORIZON_RUNTIME` | **PARTIAL** | `b1ac2323`（P6-PROD-U1 FINAL3）+ 既有 continuation/event loop | continuation、event loop、lease、lease fencing、outbox、multi-worker、startup reconciliation、durable recovery basis 已有并闭合；**RSI 自身的 reboot-safe 收敛**仍见下一行 |
| `RSI_REBOOT_RECONCILE` | **PASS**（本机 PG 取证；systemd 实机另计） | `RSI-RSI-B-HEAD` | 见 §3.1：`rsi-reboot-reconcile-db` **10/10**（reboot 不重复 / stale lease recovery / lease fencing / exactly-one continuation / repeated startup 幂等 / duplicate event 幂等 / crash-mid-transition）；`RSI_REBOOT_RECONCILE = PASS`、`SYSTEMD_RUNTIME_VALIDATION = HOST_ACTION_REQUIRED` |
| `DURABLE_RSI_REBOOT_RECOVERY` | **PASS**（本机 PG 取证） | `RSI-RSI-B-HEAD` | `DURABLE_RSI_STATE = PASS`；`DUPLICATE_AFTER_REBOOT = ZERO`；Incident/Task/Candidate/EvaluationRun/PromotionDecision/RollbackRecord/Lease 八张表为 durable SSOT（`rsi-persistence-db` 8/8 + `rsi-reboot-reconcile-db` 10/10） |
| `OPERATIONAL_MEMORY` | **PARTIAL** | 既有 cost ledger / daily-weekly inspection / fixtures | `rsi-cost-ledger`、`rsi-daily-inspection`、`rsi-weekly-review`、`rsi-golden-fixtures` 存在；**operational persistence ≠ Experience Memory**（见下） |
| `EXPERIENCE_MEMORY` | **YES（v1，端口 + 纯函数）** | `RSI-RSI-C-HEAD` | `services/experience-memory/experience-memory.ts`：FACT/AGGREGATE/HEURISTIC · tenant/account/provider/domain 四维 scope · server-derived 强制 · append-only 端口 · ruleVersion/窗口/sourceCount/confidence/sourceRefs · 凭据与 raw provider payload 拒收 · LOW_SAMPLE→ADVISORY|FAIL_CLOSED · CONFLICT→NO_AUTOMATIC_LEARNING · STALE→DOWNWEIGHTED|IGNORED · 只影响 recommendation/ranking/confidence/planning。测试 `experience-memory` 22/22。**持久化（表）为未实施的 Schema Delta 请求**：`docs/releases/EXPERIENCE-MEMORY-V1-SCHEMA-DELTA-REQUEST.md` |
| `META_LEARNING` / `META_IMPROVEMENT` | **PARTIAL（v1 编排与闸门已就位）** | 链上各段：`docs/releases/SI-RUNTIME-PHASE5-CONTROLLED-LEARNING-ADOPTION-CLOSURE.md`；编排闸门：`RSI-RSI-D-HEAD` | `services/meta-learning/meta-learning-orchestrator.ts` 把 12 段链固化为**可判定闸门**（Outcome→Experience→Proposal→Candidate→Replay→Benchmark→Security→Policy→Independent Judge→Guard→Sandbox Adoption→Observation），强制 verifiable reward（Δ 低于阈值 / 样本 0 / 无证据 → BLOCKED_BY_REWARD）、Experience 不足阻断、Builder≠Judge、Guard 允许、SANDBOX-only 采用 + 回滚计划前置、观测回归 → 回滚要求；禁止能力（改 Policy Core / 第二 Guard / 绕 Action Catalog / 关 Kill Switch / 扩权 / 开 Payment·Customs / 取生产凭据 / 自动生产推广回滚）请求即抛错。测试 `meta-learning-orchestrator` 20/20。**`META_IMPROVEMENT_INTEGRATED = false` 保持**：端到端链目前以「各段证据 + digest」形式被闸门验证，尚未由真实上游模块产出全链证据并经架构审计，故不声明 true |
| `RECOVERY_SIMULATION` | **YES（v1）** | `RSI-RSI-E-HEAD` | `services/recovery-simulation/recovery-decision-simulator.ts`：Recovery Decision Simulator（非通用 World Model）—— 4 方案对比（SUBMIT_NOW / COLLECT_MORE_EVIDENCE / HUMAN_OR_BROKER_REVIEW / DEFER），逐项输出 expectedRecovery · successProbability · calibratedConfidence · expectedCost · expectedTime · downsideRisk · requiredEvidence · policy/guard constraints · sourceExperienceRefs；`externalActionPerformed=false`；经验不足 → 确定性 Rule/Policy 回退且**所有数值为 null**；无依据不得编造概率/金额/成本。测试 `recovery-decision-simulator` 17/17 |
| `REAL_MODEL_RUNTIME` | **HOLD_EXTERNAL** | — | `REAL_MODEL_NETWORK` / `PAID_MODEL_CALLS = HOLD`；仅本地模拟 adapter 可用 |
| `REAL_PROVIDER_RUNTIME` | **HOLD_EXTERNAL** | — | Amazon / TikTok / Walmart / Shopify / UPS / FedEx / DHL / Customs Provider / PSP 全部走逐 Provider Gate；当前无生产凭据 |
| `EXTERNAL_ACTION_RUNTIME` | **HOLD_EXTERNAL** | — | `PLATFORM_WRITE_TRANSPORT_ENABLED=false`；External Write / Payment / Customs Filing / Transport = HOLD；`ACTION_RUNTIME_PRODUCTION_ENABLED=false` |
| `STANDING_AUTHORIZATION` | **YES（v1；核心 + 判定接入 + 真实调用点接线）** | `22962b73`（核心）+ `9e46cbe5`（verifier/enforcement 接线）+ `44f07162`（resolver + hitl-submission / action-pack-runtime 真实调用点） | `services/standing-authorization/*`：server-derived / versioned / revocable / auditable / tenant·account scoped + scope digest；风险分级 TIER 0–3（11 维度，受监管恒 TIER_3）；判定解析器 `standing-authorization-resolver`；接线 `verifyApprovalOrThrow` / `withActionGuard` / `hitl-submission` / `action-pack-runtime`（一次性审批 **OR** 有效授权；授权仅满足 `humanApproval`；8 项非可绕过 gate 未满足即 DENY；高金额 HITL KEEP；SA ≠ Broker POA）。测试 19/19 + 10/10 + 14/14 + 5/5。报告：`docs/releases/STANDING-AUTHORIZATION-V1-REPORT.md` |
| `LOW_RISK_AUTONOMY` | **PARTIAL（判定与真实入口已就绪；默认启用 + 授权持久化待授权/审计）** | `44f07162` | TIER_1 低风险动作可在有效授权范围内自动放行，且已接入真实入口（未传 `standingAuthorization` 即保持既有"每次审批"）；**默认启用**需逐调用点评估风险分级上下文；**授权持久化表未实施**（`docs/releases/STANDING-AUTHORIZATION-PERSISTENCE-DELTA-REQUEST.md`，REQUEST ONLY） |
| `PRODUCTION_READY` | **NO** | — | 不得因 SI/RSI 内部能力完善而改为 YES |

---

## 2. 已过期历史状态（SUPERSEDED；历史裁决不删除）

下列陈述在其**当时**是准确的，但已被后续实现取代；相应文档已加 `HISTORICAL_SNAPSHOT` 横幅：

| 过期陈述 | 出现位置（示例） | SUPERSEDED_BY |
|---|---|---|
| `RUNTIME_WIRING = NONE` | `RECOVERY-SI-PHASE2-*` / `SI-COST-OPTIMIZATION-*` / `AUTOPILOT-CLOSURE-REPORT.md` | `c0b61792`（STEP_3_RUNTIME_POLICY_WIRING：Recovery SI 作为 domain capability pack 接入 ONE SI Runtime） |
| `STEP_3_RUNTIME_POLICY_WIRING = NOT_AUTHORIZED` | `SI-RSI-UNIFICATION-*` / `SI-RUNTIME-COMPONENT-REGISTRY.md` / `SI-COST-OPTIMIZATION-*` | `c0b61792` + `ca23b1df` / `adcab905` / `ca298187` / `5f9ce46f`（FINAL-2..6） |
| `RSI_OUTCOME_SINK_RUNTIME_WIRING = NOT_AUTHORIZED` | `RECOVERY-SI-PHASE2-C-*` / `RECOVERY-SI-PHASE2-D-*` | `5f9ce46f`（FINAL-6 路由边界）+ PHASE 2 `6e98e66e` / `25ad94ea` |

> 说明：`RSI-CONTROL-PLANE-STATUS.md` 由 `tools/autopilot/backlog.json` 生成，属机械快照；
> 其中 `RSI-RT-06-state-reconcile = BLOCKED_ON_SCHEMA_DELTA_AUDIT` 是 B 单元要收口的**真实**缺口，不作为过期状态。

---

## 3. 本程序（SI/RSI GAP-CLOSURE）单元台账

| 单元 | 内容 | 状态 |
|---|---|---|
| A | DOC-STATE-RECONCILIATION（docs-only） | **CLOSED**（本文件 + 47 份历史文档横幅） |
| B | RSI-REBOOT-DURABLE-RECONCILE FINAL | **CLOSED（本机 PG 取证 + exact HEAD/tests；systemd 实机 = HOST_ACTION_REQUIRED）** |
| C | EXPERIENCE MEMORY v1 | **CLOSED（v1 端口实现 + 22/22；持久化表 = Schema Delta REQUEST ONLY，未实施）** |
| D | META LEARNING / CONTROLLED IMPROVEMENT v1 | **CLOSED（v1 编排闸门 + 20/20；META_IMPROVEMENT_INTEGRATED 保持 false，待真实全链证据 + 架构审计）** |
| E | RECOVERY SIMULATION v1 | **CLOSED（17/17；模拟不执行、数值必须有依据）** |

---

## 4. 硬边界（本程序期间不得解锁）

### 3.1 B 单元闭合证据（RSI-REBOOT-DURABLE-RECONCILE FINAL）

```
RSI_REBOOT_RECONCILE = PASS          （本机真实 PostgreSQL 取证）
SYSTEMD_RUNTIME_VALIDATION = HOST_ACTION_REQUIRED   （Linux/systemd 实机验证不得伪造）
DURABLE_RSI_STATE = PASS
DUPLICATE_AFTER_REBOOT = ZERO
```

* EXACT_HEAD：`RSI-RSI-B-HEAD`（含 `apps/api/src/__tests__/rsi-reboot-reconcile-db.test.ts`）
* TEST_EVIDENCE：
  - `rsi-reboot-reconcile-db` **10/10**（新增）：B1 dedupeKey 唯一（incident/task/candidate/promotion 同因不重复建）·
    B2 stale ACTIVE lease → EXPIRED 且任务回 READY · B3 连续重启第二次起 `idempotentNoop=true` 且行数不变 ·
    B4 crash-mid-transition（IN_PROGRESS 无 lease）→ 回 READY · B5 未过期 ACTIVE lease 被 held（fencing，不抢不偷）·
    B6 多次 reconcile 后每 dedupeKey 仍只有 1 个未终态任务 · B7 duplicate event 被唯一约束挡住 ·
    B8 Builder/Judge 同 actor 被 `RSI_BUILDER_JUDGE_SAME_ACTOR` 拒绝 · B9 证据表 append-only
    （`RSI_EVIDENCE_APPEND_ONLY`）· B10 reconcile 边界（不建任务/不删任务/不读凭据/无网络/无外部写/无支付/无传输）
  - `rsi-persistence-db` 8/8（既有）：Schema 级不变量（UNIQUE(dedupeKey) / CHECK 状态 / append-only / Judge 分离 / 平台级无租户列）
  - `rsi-restart-reconcile` 10/10（既有）：收敛计划的纯函数契约
  - RSI 全量回归：**52 文件 / 315 tests 全部 PASS**
* 说明：`rsi-restart-reconcile.ts` 只做**状态收敛**（先释放过期 lease，再把 IN_PROGRESS 任务放回 READY），
  两条写路径均带状态前置条件（`status='ACTIVE'` / `status='IN_PROGRESS'`），因此重复执行 = 0 行更新 —— 这是幂等的机制保证。

---

`EXTERNAL_WRITE` / `PAYMENT` / `CUSTOMS_FILING` / `PRODUCTION_CREDENTIALS` / `PRODUCTION_ENABLEMENT` /
`REAL_MODEL_NETWORK` / `PAID_MODEL_CALLS` / `TRANSPORT` / `P2_F` / `P2_G` = **HOLD**；
`SECOND_RUNTIME` / `SECOND_POLICY_ENGINE` / `SECOND_GUARD_IMPLEMENTATION` / `SECOND_CONTROL_PLANE` /
`SECOND_MODEL_GATEWAY` / `SECOND_COST_LEDGER` / `SECOND_META_EVIDENCE_STORE` = **FORBIDDEN**；
`L5_RELAXATION` = **FORBIDDEN**；
`AUTO_PRODUCTION_PROMOTION` / `AUTO_PRODUCTION_ROLLOUT` / `AUTO_PRODUCTION_ROLLBACK` = **false**；
MCP / A2A = **NOT REQUIRED**（未来仅作兼容层，不得改变 SSOT / Policy / Guard / Control Plane / Action Catalog 归属）。

Unix/systemd 实机验证不得伪造：需要宿主时标 `SYSTEMD_RUNTIME_VALIDATION = HOST_ACTION_REQUIRED`。

