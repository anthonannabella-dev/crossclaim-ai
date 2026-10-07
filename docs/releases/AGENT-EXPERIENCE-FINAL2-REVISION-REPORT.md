# AEL FINAL2 — 独立审计三条 CHANGE 的最小修订报告

**程序**：AGENT EXPERIENCE LAYER + DURABLE AUTHORIZATION + GOAL ORCHESTRATION
**分支**：`gate/7-commercial-validation`　**生产权限**：NONE

---

## 0. 触发与范围

| 项 | 值 |
| --- | --- |
| 审计裁决 | `MSG-20261007-01` = **PASS WITH REVISE / NOT CLOSED**（逐字归档于 `AI-ARCHITECT-INBOX.md`，`FULL_COPY_OK` 198 行一致） |
| 审计基准 HEAD | `299b008a64cefafa561b56a07d619276c2157912`（`REVIEWED_CODE_HEAD`） |
| P9 anchor | `e9cc7dc91d227dc1fbc1832b5f7a8911835e6c57` |
| 验收包 | `docs/releases/FINAL-AUDIT-PACKAGE.md`（包提交 `a316749a`，封包 `e5eaab01`） |
| 本次性质 | 只做三条 required CHANGE 的**最小修订面**；不新增 Runtime / Scheduler / Guard / Policy Engine / Goal execution engine；不改动任何硬边界 |
| 修订 HEAD | C1 `25bf985b`　C2 `9d2d7c6b`　C3 `3c426361` |

审计已 KEEP/PASS 的项（本次**未触碰**语义）：`STANDING_AUTHORIZATION_DURABLE`、`GOAL_COMPILER`、
`GOAL_RUNTIME_MAIN_WIRING`、`OAUTH_STATE_SINGLE_USE`、`CONNECTION_SYNC_STATE`、`ACTION_GUARD_SINGLE_CATALOG`、
`SECOND_RUNTIME/SCHEDULER/GUARD = 0`、`CAPABILITY_LOSS = 0`、`PRODUCTION_READY = NO`。

---

## 1. CHANGE 1 — `GOAL_RUNTIME_SINGLE_ENTRY`（CLOSED / PUSHED `25bf985b`）

**审计指出的问题**：`services/agent-goal/index.ts` 仍公开导出 `createGoalRuntimeAdapter()`，其 `dispatch()`
直接调用注入的 `runtime.run(...)` —— 这是可被误用的 direct-runner surface（等于在 Goal 域留下第二条执行准入面）。

**最小修订**：

* barrel（`goal-runtime-adapter` 的 re-export）删除 —— `agent-goal/index.ts` 不再导出 adapter 工厂；
* `goal-runtime-adapter.ts` 明确标注 **INTERNAL / TEST-ONLY**，且不再自带断言实现；
* 断言 `assertRecoveryNamespaceOnly` / `assertNoSecondRuntime` 移入 **`goal-runtime-binding.ts`**，
  即产品侧唯一执行准入面（仍只投递既有 `task:recovery:*` 队列，不直接调用 runner）；
* P1 测试改为按显式路径引用 adapter（承认它只是测试替身）；
* P2 测试删除 adapter 使用，改为断言 barrel 不导出 `createGoalRuntimeAdapter` / `GOAL_RUNTIME_ADAPTER_BOUNDARY`；
* `architecture-contract` 新增 3 条静态契约：① barrel 不得 `export * from './goal-runtime-adapter'`；
  ② 产品代码不得出现 `runtime.run(` / `RsiEvidenceRunner`；③ adapter 文件必须自述 `INTERNAL / TEST-ONLY`。

**证据**：`architecture-contract` 170/170；`agent-goal` 29/29；`agent-goal-runtime-wiring` 7/7；api `tsc --noEmit` = 0。

**没有新建第二条执行路径**：Goal → 既有 ONE SI Runtime 的唯一产品准入仍是 `createGoalRuntimeBinding()`
（队列投递 + 幂等，`SECOND_RUNTIME = 0`）。

---

## 2. CHANGE 2 — `OAUTH_SUCCESS_STATE_MACHINE`（CLOSED / PUSHED `9d2d7c6b`）

**审计指出的问题**：`succeedOAuthAuthorizationSession` 未要求 `status = CONSUMED`，也没有原子 CAS；
`SUCCEEDED` 可被任意改写绑定；`connectionId` / `resumeGoalId` 只是自由字符串；PG-P9-3 测试把该旁路固定了下来。

**最小修订**：

* `succeedOAuthAuthorizationSession`：
  * 先校验 `connectionId` 存在于**同租户** `SourceConnection`（血缘）→ 否则 `OAUTH_SESSION_CONNECTION_NOT_FOUND`；
  * `SUCCEEDED` 重入：仅当 `connectionId` + `credentialRef` **完全相同**才幂等；不同 binding → `OAUTH_SESSION_BINDING_CONFLICT`；
  * `PENDING`（未消费）/ `FAILED` → `OAUTH_SESSION_INVALID_TRANSITION`（PENDING 不得直接成功）；
  * 终态只允许由原子 CAS `WHERE id AND organizationId AND status='CONSUMED'` 取得；CAS 未命中则回读并按
    同 binding 幂等 / 并发冲突 / 非法迁移分别判定（并发安全，不会把旁路重新打开）。
* `failOAuthAuthorizationSession` 同样改走 CAS（`PENDING`/`CONSUMED` 均可，`FAILED` 幂等，`SUCCEEDED` 不可转失败）。
* `initiateOAuthAuthorizationSession`：`resumeGoalId` 必须是**同租户既有 `AgentGoal`**
  → 否则 `OAUTH_SESSION_GOAL_NOT_FOUND`（durable lineage，不再接受自由字符串）。
* 新迁移 `20261007200000_oauth_session_transition_guard`：数据库级状态机
  （允许 `PENDING→CONSUMED`、`PENDING→FAILED`、`CONSUMED→SUCCEEDED|FAILED`；禁止其他迁移）
  \+ 终态绑定不可改写（`OAUTH_SESSION_BINDING_IMMUTABLE`）；
  触发器 `cc_oauth_session_transition__OAuthAuthorizationSession` 已登记进
  `tools/tenant-triggers/append-only-triggers.json`（真实库清单校验 OK）。
* 测试：**修正 PG-P9-3**（成功前必须先经一次性 `take()`，不再把旁路当正确行为）；
  PG-P9-1 / PG-P9-3 的 `resumeGoalId` 改为真实 `AgentGoal`；新增
  **PG-P9-7…PG-P9-11**：PENDING 不得直接成功 / 同连接不同 credentialRef → BINDING_CONFLICT / 跨租户连接拒绝 /
  `resumeGoalId` 同租户血缘 / DB 状态机与绑定不可改写。

**证据**：`oauth-session-connection-sync-db` **11/11**（真实 PostgreSQL）；
定向回归 **235/235**（oauth-session + provider-callback + connection-lifecycle-db + connection-onboarding-db +
workflow-connections-db + b2-tenant-ownership-behavior-db + tenant-isolation + architecture-contract）；
api `tsc` = 0；`prisma migrate deploy` OK；append-only/controlled-mutation 触发器清单 = 73 OK。

**未来语义（OAuth redirect → callback → verified connection → resume original goal）**：
`initiate`（持久会话 + 原始 state 不落库 + 同租户 goal 血缘）→ `take`（一次性消费 CAS）→
`succeed`（CAS 终态 + 连接/凭据引用 + `resumeGoalId`）→ 上层按 `resumeGoalId` 恢复原目标；全程零外部写。

---

## 3. CHANGE 3 — `NON_BYPASSABLE_GATE_FAIL_CLOSED`（CLOSED / PUSHED `3c426361`）

**审计指出的问题**：`collectBlockingGates()` 只在字段 `=== false`（或 `NOT_SATISFIED`）时阻断，
`undefined` 直接放过 —— 未知 ≠ 满足，Production Gate / Kill Switch / tenant·account Isolation
不得因快照缺字段而通过。

**最小修订**（`services/standing-authorization/action-guard-wiring.ts`）：

* 新增 `evaluateGateProof(gate, gates)`：逐 gate 返回 `SATISFIED | NOT_SATISFIED | UNKNOWN`，
  只认快照里的**显式值**；
* 新增 `computeRequiredNonBypassableGates(requiredGates)`：required 集合 =
  **核心三项**（`productionGate` / `killSwitch` / `tenantAccountIsolation`）∪
  由 action 的 `guard.requiredGates` 派生的非可绕过 gate（如 `platformEnablement`）；
* 新增 `assessNonBypassableGates()` → `{ required, satisfied, blocking, incomplete }`；
  `collectBlockingGates(gates, requiredGates?)` 现在返回 `blocking ∪ incomplete`（fail-closed，向后兼容旧签名）；
* `evaluateAutonomousExecution()` 判定结果新增 `requiredNonBypassableGates` 与 `incompleteGateProofs`，
  并把原先的拼接串 reason code 拆成可定位的
  `NON_BYPASSABLE_GATE_SNAPSHOT_INCOMPLETE:<gate>` 与 `NON_BYPASSABLE_GATE_BLOCKED:<gate>`；
* boundary 增补 `requiresExplicitGateProof: true` / `gateProofFailClosed: true` /
  `coreRequiredNonBypassableGates` 与 forbidden 项“把缺失或 UNKNOWN 当满足”；
* 测试：既有“宽松快照上断言 ALLOW / 走 HITL”的用例改为**显式提供所需 gate 证明**（未削弱任何断言，
  只是把隐式放行改成显式证明）；新增 `⑩c` 与 resolver 的 missing-proof 用例覆盖
  “快照为空 / productionGate = UNKNOWN / action 派生 platformEnablement 缺证明”三种 fail-closed 情形。

**证据**：`standing-authorization` 20/20、`standing-authorization-resolver` 15/15、
`standing-authorization-persistence-db` 10/10（PG-SA9 已改为显式证明）；
定向回归 **308/308**（SA 全族 + action-guard 族 + agent-goal 族 + architecture-contract 170/170）；api `tsc` = 0。

**没有新增第二套 Guard**：本修订只是把**既有** Action Guard 的 requiredGates 与**既有** gate 快照语义收紧为
“缺证明即拒绝”，Action Guard 仍是唯一执行权判定（`SECOND_GUARD = 0`）。

---

## 4. 能力守恒（CAPABILITY_LOSS = 0）

| 关注点 | 结论 | 依据 |
| --- | --- | --- |
| 既有 Action Guard 判定权 | 不变（DENY 一律 DENY） | change 3 只收紧 gate 快照缺失语义 |
| Standing Authorization 可满足范围 | 仍**只有** `humanApproval`（TIER_1 低风险） | `STANDING_AUTHORIZATION_SATISFIABLE_GATES` 未变 |
| 一次性人工审批路径 | 保留 | `oneTimeApprovalStillSupported: true` 未变 |
| 高金额 HITL（>1000 OWNER/ADMIN；≥10000 ADMIN） | KEEP | 未触碰 risk-tier-policy |
| Customs 15-gate readiness | 不变 | 未触碰；`SA ≠ Broker POA` 边界不变 |
| 既有 route / 前端能力 | 不变（本修订只改 API 服务层 + 测试） | `git diff` 仅触及 agent-goal barrel / oauth store / SA wiring + 测试 + 1 迁移 |
| 语言 / 文案 | 无新增客户可见字符串（本修订零 UI 改动） | i18n 基线未变 |

**硬边界（全程保持 HOLD / FORBIDDEN，未解锁）**：
REAL_PROVIDER_WRITE、CUSTOMS_FILING、PAYMENT、AUTO_COMMISSION_CHARGE、PRODUCTION_CREDENTIALS、
PRODUCTION_ENABLEMENT、REAL_MODEL_NETWORK、PAID_MODEL_CALLS、EXTERNAL_WRITE、TRANSPORT、P2_F、P2_G = **HOLD**；
SECOND_RUNTIME、SECOND_SCHEDULER、SECOND_GUARD、SECOND_POLICY_ENGINE、SECOND_CONTROL_PLANE、
SECOND_MODEL_GATEWAY、SECOND_COST_LEDGER、SECOND_META_EVIDENCE_STORE、L5_RELAXATION = **FORBIDDEN**。
LLM 不决定权限 / eligibility / 金额；前端不重算业务判定。

---

## 5. 回归证据（AEL FINAL2 收口，exact HEAD `3c426361`）

| 项 | 结果 |
| --- | --- |
| API 全量回归（`npx vitest run`） | **4550 / 4551 passed** —— 唯一失败 = 既有 `recovery-si-phase2-e-db` 的 P2E-DB5 并行隔离 flake（`payment.count()` 被并行套件污染）；**单独运行 20/20 PASS**，本修订未触及该域 |
| api `tsc --noEmit` | 0 |
| `prisma validate` / `migrate deploy` | valid / 92 migrations 已应用 |
| append-only / controlled-mutation 触发器清单 | 73 OK（真实 PostgreSQL） |
| `architecture-contract` | 170/170 |
| 定向回归（SA 全族 + action-guard 族 + agent-goal 族） | 308/308 |
| OAuth 会话 + 连接同步 | 11/11 |
| Web（`tsc` / `next build` / i18n / UI render） | 本修订**未触及** `apps/web`：web `tsc --noEmit` 在修订 HEAD 复跑 = 0；其余保留 FINAL 基线（next build 30/30 / i18n 803 键硬编码 0 / UI render 138/138） |
| GitHub Actions | NOT_OBSERVED（本地与远端推送为唯一证据；不得写成 CI green） |

**已知既有债务（非本次引入）**：`recovery-si-phase2-e-db` 的 P2E-DB5 并行隔离 flake —— 全量并发运行时偶发，
单独运行 20/20 PASS；本修订未触及该域。

---

## 6. 返回值（AEL FINAL2 收口）

```
AGENT_EXPERIENCE_LAYER          = PASS（P0–P9 CLOSED / PUSHED；三条 CHANGE 已最小修订）
STANDING_AUTHORIZATION_DURABLE  = PASS
GOAL_COMPILER                   = PASS
GOAL_RUNTIME_WIRING             = PASS（单一准入面：createGoalRuntimeBinding）
GOAL_RUNTIME_SINGLE_ENTRY       = PASS（CHANGE 1 已关闭）
HOME_GOAL_CONSOLE               = PASS
AGENT_RUN_UI                    = PASS
NEEDS_ATTENTION                 = PASS
AUTHORIZATION_UI                = PASS
NAVIGATION_PROGRESSIVE_DISCLOSURE = PASS（CAPABILITY_LOSS = 0）
OAUTH_AUTHORIZATION_SESSION     = PASS（CHANGE 2 已关闭：CONSUMED → CAS → binding/血缘 + DB 状态机）
OAUTH_SUCCESS_STATE_MACHINE     = PASS（CHANGE 2 已关闭）
CONNECTION_SYNC_STATE           = PASS
NON_BYPASSABLE_GATE_FAIL_CLOSED = PASS（CHANGE 3 已关闭）
CAPABILITY_LOSS                 = 0
ONE_SI_RUNTIME                  = YES
SECOND_RUNTIME                  = 0　SECOND_SCHEDULER = 0　SECOND_GUARD = 0
FULL_REGRESSION                 = 4550/4551（1 = 既有 P2E-DB5 并行隔离 flake，单跑 20/20）
FINAL_AUDIT                     = 复核中（本报告 + 三条 CHANGE 的 exact HEAD 已提交并推送，等待独立复审裁决）
PRODUCTION_READY                = NO
```

**精确 HEAD**：C1 `25bf985b` → C2 `9d2d7c6b` → C3 `3c426361`（本条报告提交后 HEAD 见 `.autopilot/STATE.json`）。
