# AGENT GOAL 持久化 —— 最小 Schema Delta 审计件（P3）

授权：HOST 2026-10-07「AGENT EXPERIENCE LAYER + DURABLE AUTHORIZATION + GOAL ORCHESTRATION」P3。
纪律：Schema Delta 先出最小审计件；本程序为 HOST 直接授权的实施单元，故**审计件与实施同批交付**。
`EXACT_HEAD = AGENT-GOAL-P3-HEAD`

---

## 1. 真实缺口

P1 的 goal 是纯计算结果（无持久化），P2 的 binding 只把计划并入既有队列。
因此「用户表达目标 → 后台运行 → 用户回来看结果」缺少**意图记录**与**执行投影记录**：
刷新即丢、无法审计「谁在什么时候让系统做什么」。

## 2. 提议并实施的最小 Delta（2 表，无新增枚举）

| 表 | 用途 | 关键列 |
|---|---|---|
| `AgentGoal` | 客户意图（Customer Intent） | `id`(=goalId) · `organizationId` · `createdBy` · `rawUserIntent` · `normalizedGoal`(JSONB) · `status` · `createdAt` · `updatedAt` |
| `AgentGoalRun` | 一次执行投影（Execution Projection） | `id`(=runId) · `organizationId` · `goalId` · `status` · `startedAt` · `completedAt` · `summary`(JSONB) · `createdAt` · `updatedAt` |

约束 / 索引：

* `@@unique([organizationId, id])`（两表，租户一致性约定）+ 查询索引 `(organizationId, status, createdAt)` / `(organizationId, goalId, startedAt)`；
* CHECK：goal `status ∈ {PROPOSED,ADMITTED,RUNNING,COMPLETED,FAILED,CANCELLED}`、`1 ≤ length(rawUserIntent) ≤ 600`、`createdBy` 非空、`normalizedGoal` 必须是 JSON 对象；
* CHECK：run `status ∈ {QUEUED,RUNNING,COMPLETED,BLOCKED,FAILED,CANCELLED}` 且**终态必须带 `completedAt`、非终态必须不带**；
* 触发器：两表 tenant 基线（run 额外带 `goalId → AgentGoal` 同租户校验）+ 归属不可变；
* 身份不可改写：`AgentGoal` 禁改 `organizationId/createdBy/rawUserIntent/normalizedGoal/createdAt`；`AgentGoalRun` 禁改 `organizationId/goalId/startedAt/createdAt`（修正一律新建）。

## 3. 明确不做（防止第二事实源）

* **不**建 Opportunity / Case / Claim / Evidence / Money / Settlement 的替代表；
* **不**建第二套 Recovery 状态机（本表 `status` 只描述「目标 / 这次运行」，与 Recovery 生命周期无关）；
* **不**存凭据：`rawUserIntent` / `normalizedGoal` 过既有 Experience Memory 禁用内容检查；
* **不**授予权限、不执行外部动作、不决定金额 / 资格 / 成功费。

## 4. 影响面与回滚

* 影响：新增 2 表 + 4 个触发器 + 2 个清单登记项；**不修改任何既有表**；
* 回滚：Drop 两表即回到本单元之前形态；
* 架构契约：模型总数 109 → 111（2 表纳入 CORE / TENANT_OWNED）。

## 5. 证据

见本单元报告 `docs/releases/AGENT-GOAL-PERSISTENCE-P3-REPORT.md`（真实 PostgreSQL 验收 + 触发器清单对照）。
