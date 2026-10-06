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
| `RSI_REBOOT_RECONCILE` | **PARTIAL（本程序 B 的目标）** | 既有：`rsi-restart-reconcile.ts` / `rsi-reconcile-prisma-store.ts` | 已实现 lease 过期/回收 + 任务 requeue（带状态前置条件，重复执行 0 行更新），测试 `rsi-restart-reconcile`、`rsi-persistence-db`；但 backlog `RSI-RT-06-state-reconcile` 仍标 `BLOCKED_ON_SCHEMA_DELTA_AUDIT`，且缺 reboot E2E（Test C/F）、duplicate-event 幂等与 crash-mid-transition 的端到端取证 → B 单元收口 |
| `DURABLE_RSI_REBOOT_RECOVERY` | **PARTIAL** | 同上 | Incident / Task / Lease 已有持久化；Candidate / Evaluation / Promotion / Rollback 的 durable SSOT 与「reboot 不重复」需 B 单元逐项证明 |
| `OPERATIONAL_MEMORY` | **PARTIAL** | 既有 cost ledger / daily-weekly inspection / fixtures | `rsi-cost-ledger`、`rsi-daily-inspection`、`rsi-weekly-review`、`rsi-golden-fixtures` 存在；**operational persistence ≠ Experience Memory**（见下） |
| `EXPERIENCE_MEMORY` | **NO（本程序 C 的目标）** | — | 当前无结构化 Experience Memory（FACT/AGGREGATE/HEURISTIC、ruleVersion、时间窗口、source count、confidence、append-only raw experience） |
| `META_LEARNING` / `META_IMPROVEMENT` | **PARTIAL（本程序 D 的目标）** | 链上各段 HEAD 见 `docs/releases/SI-RUNTIME-PHASE5-CONTROLLED-LEARNING-ADOPTION-CLOSURE.md` | Outcome→Learning Evidence→Offline Evaluation→Meta-improvement Candidate→Approval→Rollback Plan→Controlled Proposal→Canary/Shadow→Adoption Review 已封板（planning-only）；**`META_IMPROVEMENT_INTEGRATED = false`**（缺 Experience Memory 驱动与端到端 sandbox adoption + observation + regression detection + rollback 的完整验证） |
| `RECOVERY_SIMULATION` | **NO（本程序 E 的目标）** | — | 当前无 Recovery Decision Simulator（多方案对比 + calibratedConfidence + sourceExperienceRefs + fallback 到确定性 Rule/Policy） |
| `REAL_MODEL_RUNTIME` | **HOLD_EXTERNAL** | — | `REAL_MODEL_NETWORK` / `PAID_MODEL_CALLS = HOLD`；仅本地模拟 adapter 可用 |
| `REAL_PROVIDER_RUNTIME` | **HOLD_EXTERNAL** | — | Amazon / TikTok / Walmart / Shopify / UPS / FedEx / DHL / Customs Provider / PSP 全部走逐 Provider Gate；当前无生产凭据 |
| `EXTERNAL_ACTION_RUNTIME` | **HOLD_EXTERNAL** | — | `PLATFORM_WRITE_TRANSPORT_ENABLED=false`；External Write / Payment / Customs Filing / Transport = HOLD；`ACTION_RUNTIME_PRODUCTION_ENABLED=false` |
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
| B | RSI-REBOOT-DURABLE-RECONCILE FINAL | PENDING |
| C | EXPERIENCE MEMORY v1 | PENDING |
| D | META LEARNING / CONTROLLED IMPROVEMENT v1 | PENDING |
| E | RECOVERY SIMULATION v1 | PENDING |

---

## 4. 硬边界（本程序期间不得解锁）

`EXTERNAL_WRITE` / `PAYMENT` / `CUSTOMS_FILING` / `PRODUCTION_CREDENTIALS` / `PRODUCTION_ENABLEMENT` /
`REAL_MODEL_NETWORK` / `PAID_MODEL_CALLS` / `TRANSPORT` / `P2_F` / `P2_G` = **HOLD**；
`SECOND_RUNTIME` / `SECOND_POLICY_ENGINE` / `SECOND_GUARD_IMPLEMENTATION` / `SECOND_CONTROL_PLANE` /
`SECOND_MODEL_GATEWAY` / `SECOND_COST_LEDGER` / `SECOND_META_EVIDENCE_STORE` = **FORBIDDEN**；
`L5_RELAXATION` = **FORBIDDEN**；
`AUTO_PRODUCTION_PROMOTION` / `AUTO_PRODUCTION_ROLLOUT` / `AUTO_PRODUCTION_ROLLBACK` = **false**；
MCP / A2A = **NOT REQUIRED**（未来仅作兼容层，不得改变 SSOT / Policy / Guard / Control Plane / Action Catalog 归属）。

Unix/systemd 实机验证不得伪造：需要宿主时标 `SYSTEMD_RUNTIME_VALIDATION = HOST_ACTION_REQUIRED`。

