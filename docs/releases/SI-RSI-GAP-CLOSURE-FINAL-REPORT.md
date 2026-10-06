# SI/RSI GAP-CLOSURE — 最终回报（CURRENT SI/RSI CAPABILITY MATRIX）

授权：HOST 2026-10-06「SI/RSI GAP-CLOSURE DIRECTIVE」（严格顺序 A→B→C→D→E）
分支：`gate/7-commercial-validation`
原则：**不重做 SI/RSI、不建第二 Runtime / Policy Engine / Guard / Control Plane**；只补真实缺口；
所有 PASS 绑定 exact HEAD + 测试证据；未完成能力一律不写成 PASS。

本程序基线（A 之前的 HEAD）：`cdd95258`

---

## 1. 单元台账（exact HEAD + 证据）

| 单元 | 内容 | exact HEAD | 证据 |
|---|---|---|---|
| **A** | DOC-STATE-RECONCILIATION（docs-only） | `e7cde93f` | 新增唯一现行状态件 `docs/releases/CURRENT-SI-RSI-STATUS.md`；47 份含过期状态陈述的历史文档加 `HISTORICAL_SNAPSHOT` + `SUPERSEDED_BY=c0b61792` 横幅（仅前置、原文未改写、历史裁决未删除） |
| **B** | RSI-REBOOT-DURABLE-RECONCILE FINAL | `9eb30b6d` | 新增 `rsi-reboot-reconcile-db.test.ts` **10/10**（真实 PostgreSQL）；RSI 全量回归 52 文件 / **315 tests PASS** |
| **C** | EXPERIENCE MEMORY v1 | `0b28ab52` | 新增 `services/experience-memory/experience-memory.ts` + `experience-memory.test.ts` **22/22**；回归 54 文件 / **494 tests PASS**；持久化表 = 未实施的 Schema Delta 请求 |
| **D** | META LEARNING / CONTROLLED IMPROVEMENT v1 | `1fa2821d` | 新增 `services/meta-learning/meta-learning-orchestrator.ts` + `meta-learning-orchestrator.test.ts` **20/20**；回归 57 文件 / **542 tests PASS** |
| **E** | RECOVERY SIMULATION v1 | `RSI-RSI-E-HEAD` | 新增 `services/recovery-simulation/recovery-decision-simulator.ts` + `recovery-decision-simulator.test.ts` **17/17** |

全量回归（`npx vitest run`，本程序收口时）：见 §4。
`tsc --noEmit`：每个单元均 **exit 0**。GitHub Actions：**NOT_OBSERVED**（不声称 CI 绿）。

---

## 2. CURRENT SI/RSI CAPABILITY MATRIX

状态取值：`YES` / `PARTIAL` / `NO` / `BLOCKED_ON_HOST` / `HOLD_EXTERNAL`

| 能力 | 状态 | 绑定 HEAD / 证据 |
|---|---|---|
| `SI_RUNTIME` | **YES** | `c0b61792` → `5f9ce46f` → `adcab905`；`rsi-domain-pack-wiring` / `rsi-si-runtime-e2e` / `rsi-runtime-e2e` |
| `RECOVERY_SI_PACK` | **YES** | `c0b61792` + `adcab905`；`recovery-si-pack.ts` / `recovery-si-product-composition.ts`；`rsi-si-runtime-real-guard-e2e` |
| `CONTROLLED_RSI` | **PARTIAL** | PHASE 5 收口 `b3629ffc`（planning-only：PROPOSAL_ONLY / SHADOW_ONLY / ROLLBACK_PLAN_ONLY，无自动执行入口）；生产采用未启用 |
| `REASONING_MODEL_GATEWAY` | **PARTIAL** | `6e98e66e` → `25ad94ea`（唯一 Model Gateway port；禁第二 Model Router）；本地模拟可用，真实/付费模型 = `HOLD_EXTERNAL` |
| `LONG_HORIZON_RUNTIME` | **PARTIAL** | `b1ac2323`（P6-PROD-U1 FINAL3）+ continuation / event loop / lease / outbox / multi-worker / startup reconciliation |
| `DURABLE_RSI_REBOOT_RECOVERY` | **YES**（本机 PG 取证） | `9eb30b6d`；`RSI_REBOOT_RECONCILE = PASS`、`DURABLE_RSI_STATE = PASS`、`DUPLICATE_AFTER_REBOOT = ZERO` |
| `OPERATIONAL_MEMORY` | **PARTIAL** | cost ledger / daily inspection / weekly review / golden fixtures 已存在；**operational persistence ≠ Experience Memory** |
| `EXPERIENCE_MEMORY` | **YES**（v1 端口实现） | `0b28ab52`；`experience-memory` 22/22；持久化表 = `EXPERIENCE_MEMORY_SCHEMA_DELTA = REQUEST ONLY`（未实施） |
| `META_LEARNING` | **PARTIAL** | `1fa2821d`（12 段端到端闸门 + verifiable reward 强制 + SANDBOX-only）；**`META_IMPROVEMENT_INTEGRATED = false`**（真实全链证据待架构审计） |
| `RECOVERY_SIMULATION` | **YES**（v1） | `RSI-RSI-E-HEAD`；`recovery-decision-simulator` 17/17；模拟不执行、无数值编造 |
| `REAL_MODEL_RUNTIME` | **HOLD_EXTERNAL** | `REAL_MODEL_NETWORK` / `PAID_MODEL_CALLS = HOLD`；仅本地模拟 adapter |
| `REAL_PROVIDER_RUNTIME` | **HOLD_EXTERNAL** | Amazon / TikTok / Walmart / Shopify / UPS / FedEx / DHL / Customs Provider / PSP 全部走逐 Provider Gate；无生产凭据 |
| `EXTERNAL_ACTION_RUNTIME` | **HOLD_EXTERNAL** | `PLATFORM_WRITE_TRANSPORT_ENABLED=false`；External Write / Payment / Customs Filing / Transport = HOLD |

---

## 3. HOST 要求的返回字段

```
CURRENT_HEAD              = <本回报所在 commit>
RSI_REBOOT_RECONCILE      = PASS（本机真实 PostgreSQL 取证；9eb30b6d）
                              SYSTEMD_RUNTIME_VALIDATION = HOST_ACTION_REQUIRED（Linux/systemd 实机未伪造）
EXPERIENCE_MEMORY_V1      = YES（端口实现 + 22/22；持久化表待 Schema Delta 裁定）
META_IMPROVEMENT_INTEGRATED = false（保持；端到端真实全链证据未齐）
RECOVERY_SIMULATION_V1    = YES（17/17；externalActionPerformed=false）
REAL_MODEL_RUNTIME        = HOLD_EXTERNAL
EXTERNAL_ACTION_RUNTIME   = HOLD_EXTERNAL
PRODUCTION_READY          = NO
```

### REMAINING_HOST_ACTION_REQUIRED

1. `SYSTEMD_RUNTIME_VALIDATION`：Linux/systemd 实机验证（随系统启动 + 崩溃自动拉起）；本程序按规范标 `HOST_ACTION_REQUIRED`，**未自证 PASS**。
2. `EXPERIENCE_MEMORY_SCHEMA_DELTA`：是否批准最小持久化 Delta（1 表 `ExperienceRecord`，append-only + 租户隔离）；见 `docs/releases/EXPERIENCE-MEMORY-V1-SCHEMA-DELTA-REQUEST.md`。
3. `META_IMPROVEMENT_INTEGRATED`：需真实上游模块产出全链证据（Outcome→Experience→…→Observation）并经架构审计后才可置 true。
4. 若要把 `CONTROLLED_RSI` 从 PARTIAL 推进到生产采用：需新的 HOST 授权（当前 `AUTO_PRODUCTION_PROMOTION/ROLLOUT/ROLLBACK = false`）。

### REMAINING_HOLD_EXTERNAL

`EXTERNAL_WRITE` · `PAYMENT` · `CUSTOMS_FILING` · `PRODUCTION_CREDENTIALS` · `PRODUCTION_ENABLEMENT` ·
`REAL_MODEL_NETWORK` · `PAID_MODEL_CALLS` · `TRANSPORT` · `P2_F` · `P2_G` = **HOLD**。

`SECOND_RUNTIME` · `SECOND_POLICY_ENGINE` · `SECOND_GUARD_IMPLEMENTATION` · `SECOND_CONTROL_PLANE` ·
`SECOND_MODEL_GATEWAY` · `SECOND_COST_LEDGER` · `SECOND_META_EVIDENCE_STORE` = **FORBIDDEN**（未创建）。
`L5_RELAXATION` = **FORBIDDEN**。MCP / A2A = **NOT REQUIRED**（未来仅作兼容层）。

---

## 4. 全量回归

| 项目 | 结果 |
|---|---|
| 全量 `npx vitest run` | **439 文件 / 4413 tests → 4412 passed + 1 failed**；唯一失败为既有 isolation debt `recovery-si-phase2-e-db` P2E-DB5（**单独运行 20/20 PASS**，与本程序改动无关，历史切片同一失败） |
| 本程序新增/修改套件 | `rsi-reboot-reconcile-db` 10/10 · `experience-memory` 22/22 · `meta-learning-orchestrator` 20/20 · `recovery-decision-simulator` 17/17 |
| RSI 全量 | 52 文件 / 315 tests（B 时点）→ 后续含 C/D/E 后 **57 文件 / 542 tests**（D 时点） |
| Schema Delta | **未实施**（C 的持久化表仅请求；本程序未新增表/未新增 migration） |

---

## 5. 语义边界（长期断言）

1. **不建第二 Runtime / Policy Engine / Guard / Control Plane / Model Gateway / Cost Ledger / Meta Evidence Store**。
2. RSI 不得改/绕唯一 Policy Core、不得绕 Action Catalog、不得自行关 Kill Switch、不得自行扩权 / 开 Payment / 开 Customs Filing / 取生产凭据（D 模块请求即抛错）。
3. Experience Memory 只影响 recommendation / ranking / confidence / planning；append-only、server-derived、四维 scope、禁凭据与原始 provider payload。
4. Meta Learning 无 verifiable reward / measurable KPI 不得 promote；采用仅限 SANDBOX；回归 → 回滚。
5. Recovery Simulation **只是模拟与建议**：`externalActionPerformed=false`、`worldModelComplete=false`、数值必须有依据（否则 null + insufficientEvidence）。
6. `simulation ≠ World Model complete`、`operational persistence ≠ Experience Memory`、`Candidate + Judge ≠ Meta Learning complete`、`本地模型模拟 ≠ Production Model Runtime`、`Internal code complete ≠ Production Ready`。

