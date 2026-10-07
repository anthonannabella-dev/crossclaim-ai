# AGENT GOAL 持久化（P3）—— 交付与证据

授权：HOST 2026-10-07「AGENT EXPERIENCE LAYER + DURABLE AUTHORIZATION + GOAL ORCHESTRATION」P3。
`EXACT_HEAD = AGENT-GOAL-P3-HEAD`（基线 `1094c08a`）
审计件：`docs/releases/AGENT-GOAL-PERSISTENCE-DELTA-AUDIT.md`

结论：**P3 = CLOSED**。新增 2 表（`AgentGoal` / `AgentGoalRun`）承载「客户意图 + 执行投影」，
**不是** Opportunity / Case / Claim / Evidence / Money / Settlement 的 SSOT，也不构成第二事实源。

---

## 1. 先扫描再实现

* 既有 `RecoveryOpportunity` / `Case` / `Claim` / `EvidenceArtifact` / `Settlement` / `RecoveryLedgerEntry` 已覆盖全部业务事实 —— 本单元**不复制**其中任何一个；
* 既有 RSI durable 底座（`Autonomy*` 表）覆盖 incident/task/candidate/promotion/lease —— 本单元**不建第二调度状态机**；
* 既有凭据禁用检查（`services/experience-memory`）可直接复用，避免第二套内容安全策略。

## 2. 交付文件

| 类别 | 文件 |
|---|---|
| Schema | `apps/api/prisma/schema.prisma`：`AgentGoal` + `AgentGoalRun`（模型总数 109 → 111） |
| Migration | `apps/api/prisma/migrations/20261007150000_agent_goal_persistence/migration.sql` |
| 服务 | `apps/api/src/services/agent-goal/goal-store.ts`（persist / load / list / 状态迁移 / run 生命周期） |
| 测试 | `apps/api/src/__tests__/agent-goal-persistence-db.test.ts`（8 例，真实 PostgreSQL） |
| 清单 | `tools/tenant-triggers/required-triggers.json`（+2 baseline）、`append-only-triggers.json`（+2 身份不可改写 + 2 前缀） |
| 架构契约 | `architecture-contract.test.ts`：模型总数 111、CORE 86、两表纳入 TENANT_OWNED |
| 文档 | `AGENT-GOAL-PERSISTENCE-DELTA-AUDIT.md`（本审计件）+ 本报告 |

## 3. 不变量（实现即强制）

| 要求 | 实现 |
|---|---|
| tenant scoped | `organizationId` 非空 + `cc_tenant_agentgoal` / `cc_tenant_agentgoalrun`（后者带 `goalId → AgentGoal` 同租户校验）+ `cc_tenant_immutable__*` |
| 客户意图 + 执行投影，不是 SSOT | `AGENT_GOAL_PERSISTENCE_BOUNDARY` 显式声明 8 项 `isXxxSsot = false`、`isRecoveryStateMachine = false`；`assertGoalRecordIsNotBusinessTruth` 拒绝被当成业务真值 |
| 不存凭据 | 复用 `assertNoForbiddenExperienceContent`（token / secret / password / cookie / raw credential / raw provider payload） |
| 幂等 | `goalId = agentgoal-<digest(org, 原文, 规范化目标)>`：重复提交 → `REUSED`，不产生第二条意图记录 |
| 身份不可改写 | 触发器禁改 goal 的 `org/createdBy/rawUserIntent/normalizedGoal/createdAt`，run 的 `org/goalId/startedAt/createdAt` |
| 状态机 fail-closed | goal：`PROPOSED→ADMITTED|CANCELLED`、`ADMITTED→RUNNING|FAILED|CANCELLED`、`RUNNING→COMPLETED|FAILED|CANCELLED`，终态不可再变；run：`QUEUED→RUNNING|BLOCKED|FAILED|CANCELLED`、`RUNNING→终态` |
| 数据库兜底 | CHECK：状态词表、意图长度 1..600、`normalizedGoal` 必须是 JSON 对象、**终态必须带 `completedAt` 且非终态必须不带** |
| 不授予权限 / 不执行 | `grantsPermissions = false`、`performsExternalAction = false`；本层不调用任何 provider |

## 4. 测试证据

* `agent-goal-persistence-db` **8/8 PASS**（真实 PostgreSQL）：
  PG-AG1 落库/读取（新连接＝重启等价）· PG-AG2 重复提交幂等（1 行）· PG-AG3 凭据类与畸形输入拒绝 ·
  PG-AG4 goal 状态迁移 fail-closed + 终态不可变 · PG-AG5 跨租户读取/更新隔离 ·
  PG-AG6 run 生命周期（含 completedAt 与 summary）· PG-AG7 数据库兜底（身份不可改写 / run 跨租户 goalId /
  非法状态 / 终态缺 completedAt）· PG-AG8 边界声明（8 项非 SSOT）
* 定向回归 **217/217 PASS**：architecture-contract（163）+ agent-goal（29）+ runtime-wiring（7）+
  goal-persistence（8）+ standing-authorization-persistence（10）
* `api tsc --noEmit` = exit 0；`prisma validate` = valid；`migrate deploy` 90 migrations 全部成功
* 触发器清单（对照真实库）：required **116 baseline / 93 immutable / 2 scoped**；append-only **70** 全 OK

## 5. 边界（未解锁）

本单元不开启任何外部能力：`REAL_PROVIDER_WRITE` / `CUSTOMS_FILING` / `PAYMENT` / `AUTO_COMMISSION_CHARGE` /
`PRODUCTION_CREDENTIALS` / `PRODUCTION_ENABLEMENT` / `EXTERNAL_WRITE` / `TRANSPORT` = **HOLD**；
高金额 HITL **KEEP**；Standing Authorization ≠ Broker POA；goal / run 不参与 eligibility / 金额 / 成功费判定。

## 6. 下一步

P4 —— 首页升级 AI Recovery Manager / Goal Console（保留既有 Dashboard 全部内容；四张结果卡；
禁跨币种求和；客户可见字符串全部进 i18n dictionary）。
