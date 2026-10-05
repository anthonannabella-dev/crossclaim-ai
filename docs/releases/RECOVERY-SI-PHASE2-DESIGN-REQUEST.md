# Recovery SI Phase 2 —— 设计送审请求（仅设计，零代码改动）

- 分支：`gate/7-commercial-validation`；**REVIEWED_HEAD = `aadb4a0b`**（本文件提交后以 STATE.CURRENT_HEAD 为准）。
- 前置：**MSG-20261005-12 = PASS / CLOSED**（Recovery SI Phase 1 冻结；FNV acc593d5 / 124 行 / FULL_COPY_OK）。
- 本轮性质：**设计请求，零代码、零 schema、零运行时改动**；提交目的仅为取得 `PHASE2 = SEPARATE_ARCHITECT_APPROVAL_REQUIRED` 所需的架构授权。

## 1. 为什么现在提

Phase 1 冻结在 `state → prioritize → plan → verify → policy → decision`，明确不含 `decision → runtime loop → invoke tool → external action`。
Recovery SI 目前只能产出决策，不能消费；宿主要求"最大化客户可追回资金"必须走到 Phase 2。按裁决，Phase 2 必须单独审，因此先送设计。

## 2. 提议的分阶段授权（建议按此顺序，**每阶段单独验收**）

| 阶段 | 内容 | 依赖 | 建议处置 |
| --- | --- | --- | --- |
| **P2-A** | SI 决策 → RSI **Outcome Signal** 映射（只读；`predicted vs actual`、失败原因、time-to-recovery 等作为 RSI 观察信号） | 无 | 建议**先批**（零外写、零执行） |
| **P2-B** | **只读 Tool 实接**：registry 中的 READ 类工具（`opportunity.list` / `evidence.inspect` / `customs.authorization.readiness` …）真实调用现有确定性服务，**不写库、不外写** | P2-A | 建议**先批**（仍受 tenant + rate/并发约束） |
| **P2-C** | **PREPARE 类 Tool**：`claim.prepare` / 包生成（仍不外写、不 submission） | P2-B | 建议随 P2-B 一并审，可延后 |
| **P2-D** | **Action Guard handoff**：`READY_FOR_EXECUTION` → 经 Action Guard → Authorization/HITL/OWNER Gate → Deterministic Executor（首版仍 `executionMode = SIMULATED`，只走 dry-run 路径） | P2-C | 建议**单独**审，且必须先有 Guard 集成证据 |
| **P2-E** | **持久化 RecoveryPlan / DecisionEvidence** | — | 需 **Schema Delta 审计**（当前 `SCHEMA_DELTA_REQUIRED = NO` 仅覆盖 Phase 1） |
| **P2-F** | **Model assistance**（经既有 Model Router 生成计划解释/证据建议） | — | 需 **RSI_MODEL_NETWORK / RSI_PAID_MODEL_CALLS** 解禁，另行审 |
| **P2-G** | **Real executor / External Write / Customs Filing / Payment** | — | 建议**保持 HOLD**，不属于本设计请求范围 |

## 3. 需要确认的不变量（Phase 2 继续沿用 Phase 1 结论）

1. **不建第二套 Runtime**：继续复用 Controller / Event Loop / Model Router / Judge / Cost·Evidence Ledger / Reconcile·Lease / Kill Switch / Policy Engine；
2. **权限不放宽**：L5 永久禁区（External Write / Payment / Transport / Production Credentials / REAL_CLAIM_SUBMIT / CUSTOMS_FILING / COMMISSION_CAPTURE / PRODUCTION_ENABLEMENT / KILL_SWITCH_DISABLE）继续保持，Recovery SI **不得**自行授权；
3. **金额与事实口径不变**：金额只来自持久化事实；多币种不跨币种相加/比较（Phase 1 已冻结的 `CHANGE_A` 语义在 P2 沿用）；`expectedRecovery` 必须能回溯到确定性打分；
4. **fail-closed 不变**：tenant / 陈旧 snapshot / 陈旧机会 / 引用不存在 / 工具未登记 均保持 Phase 1 语义；
5. **READY_FOR_EXECUTION 语义**：仍为决策标记；P2-D 之前不得被任何消费者当作执行许可。

## 4. 请求裁决

1. 是否批准按 **P2-A → P2-B →（P2-C）→ P2-D** 分阶段推进？首版是否只批 **P2-A + P2-B（只读）**？
2. P2-D（Action Guard handoff，仍 dry-run）需要哪些**最小**证据集合才可动？
3. P2-E 的 Schema Delta 是否同意**单独送审**（本设计请求不含 schema 变更）？
4. P2-F / P2-G 是否维持 HOLD？
5. 若设计需要修订，请只列最小集合。

## 5. 边界声明（本请求不改动）

```
EXTERNAL_WRITE = HOLD        PAYMENT = HOLD
TRANSPORT = HOLD             PRODUCTION_CREDENTIALS = HOLD
REAL_CLAIM_SUBMIT = HOLD     CUSTOMS_FILING = HOLD
RSI_MODEL_NETWORK = HOLD     RSI_PAID_MODEL_CALLS = HOLD
SCHEMA_DELTA_REQUIRED = NO（Phase 1 范围）
FINAL_ACCEPTANCE_HEAD = 0f7f7ac
```
