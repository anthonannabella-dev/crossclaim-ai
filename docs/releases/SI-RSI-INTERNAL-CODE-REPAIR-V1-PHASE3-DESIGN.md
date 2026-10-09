# SI/RSI INTERNAL CODE REPAIR V1 —— PHASE 3（只读设计）设计文档

> 授权依据：MSG-20261009-11（`PHASE3_DESIGN_AUTHORIZED = YES · READ ONLY`；`PHASE3_IMPLEMENTATION_AUTHORIZED = NO`；
> `AUTONOMOUS_CODE_REPAIR_AUTHORIZED = NO`）。
> 本文**只做设计**：仅允许「阅读现有实现 / 设计契约 / 编写测试计划 / 形成审计材料」；
> **不得**实施修复代理、不得创建执行器、不得生产接线、不得开放任何执行权限。

## 0. 现状盘点（只读，引用真实文件）

| 现有能力 | 真实入口 | 对本设计的约束 |
| --- | --- | --- |
| ONE SI Runtime 组装 | `apps/api/src/runtime/rsi-run.ts`（`composeRsiRuntime`、`RsiRuntimeComposition`、`runtimeMembers()`） | A 路径候选**只能**交回此组装；`SECOND_RUNTIME = 0` |
| durable 任务源（claim / 授权重解析 / fencing） | `apps/api/src/runtime/rsi-durable-task-source.ts`（`createAutonomyTaskSource().claim/settle/fail/renew/reclaimExpired`，`CLAIM_AUTHORIZATION_DENY`） | 执行前校验的唯一合法位置；候选不得绕过它 |
| 任务形状 | `apps/api/src/services/autonomy/rsi-continuation-engine.ts`（`RsiSafeTask`） | 候选消费需要产出**该形状**且带可信 `organizationId` |
| Action Guard / 审批 / Kill Switch | `apps/api/src/services/action-guard/`（`actionRequiresHumanApproval`、`verifyApprovalOrThrow`、`ACTION_SCOPE_MAP`、`createActionGuardCapabilitySource`、`runtime-guard-composition`） | 任何动作必须过 Guard；外写类动作恒 HOLD |
| 生命周期契约 | `apps/api/src/services/autonomy/rsi-lifecycle.ts`（`transition`、`RSI_OWNER_GATED_ACTIONS`、`canAutoPromote`） | 状态跃迁与 OWNER 门禁不得自造 |
| 故障诊断/分流/登记（本轮成果） | `apps/api/src/services/self-repair/fault-classification.ts`（`buildFaultIncidentIntent`）、`fault-triage.ts`（`triageFaultIncident`、`TRUSTED_FACT_SOURCE_REQUIREMENTS`）、`fault-triage-sweep.ts`（first-write-wins 登记） | 本设计的**输入**：已持久化的 `INTERNAL_FAULT` + 已登记 triage 快照 |
| 客户队列锚点 | `apps/api/src/services/agent-goal/prisma-task-queue-port.ts`（`admit`，kind = `CUSTOMER_GOAL_QUEUE`） | 修复平面 Incident（kind = `INTERNAL_FAULT`）**不得**复用该容器 |

## 1. 设计 1：可信服务端适配器（对应 **P3-01**）

目标：把「可信事实」从**声明**提升为**来源可证明**。

1. **唯一读取入口**：新增 `FaultTrustedFactsAdapter`（PHASE 3 实施时创建）。
   - 输入：`incidentId` + **服务端会话/授权上下文**（不是请求体）。
   - 输出：`TriageTrustedFacts` + `provenance`（每条事实的来源证明）。
2. **来源证明（provenance）**：每条事实必须带可核验来源：
   - `organizationIdResolved` ← 可信身份关系（组织记录 / 绑定关系）**主键命中**，附 `resolvedFrom` 与 `resolvedAt`；
   - `authorizationActive` ← 授权存储的**当前**行（含 `revocationState`、`effectiveAt/expiresAt`、`authorizationVersion`）；
   - `operationRecheck` ← 执行上下文（本次运行时的只读/幂等确认），附 `checkedBy`（受信任的运行时成员标识）。
3. **不可信载荷边界**：适配器**只读可信存储**；请求体 / 客户端字段 / 模型输出**只能作为「待核验线索」**，
   绝不可直接映射为事实（沿用 `FORBIDDEN_TRUSTED_FACT_SOURCES`）。
4. **租户隔离**：适配器强制租户谓词（组织 id 必须来自会话/身份解析）；跨租户读取返回空并记 fail-closed 原因码。

**验收设计（PHASE 3 实施后）**：`P3-01` 门禁 = 至少 3 个负向用例证明「客户端伪造 identity 头 / 模型产出的事实声明 /
伪造 `trustedFactSources` 标签」均无法产生 `organizationIdResolved=true` 或 `authorizationActive=true`。

## 2. 设计 2：执行前重验时序（对应 **P3-02 / P3-03**）

固定时序（**任一环失败即 fail-closed**，且失败必须在 durable 记录中留痕）：

1. **候选读取**：从 `AutonomyIncident`（kind=`INTERNAL_FAULT`、status=`DIAGNOSED`）读取 triage 快照；
2. **快照作废判定**：若 `triagedAt` 超过允许时效、或 `authorizationVersion` 已变化 ⇒ 视为**过期快照**，重新分流（不得直接消费）；
3. **身份重解析**：由适配器重新解析组织身份（P3-01）；
4. **授权重验**：重新读取授权（未撤销、未过期、动作类型允许、金额上限允许）；
5. **上下文重验**：重新确认操作类型与幂等/副作用状态（`operationRecheck`）；
6. **故障状态重验**：确认 Incident 仍为 `DIAGNOSED`（`CLOSED/REJECTED/TASKED` ⇒ 拒绝）；
7. **Guard 检查**：交由既有 Action Guard / 审批链（`actionRequiresHumanApproval` / `verifyApprovalOrThrow`）；
8. **租约与 fencing**：交由既有 `createAutonomyTaskSource().claim/settle` 路径（owner + 未过期租约 + 旧 owner 不得覆盖）。

**竞态撤销**：第 4 步与第 8 步之间发生撤销 ⇒ 由既有 claim 授权重解析与 fenced settle 兜住；
本设计额外要求：**任何**在执行窗口内的授权状态变化都必须导致终止（不得"先到先得"）。

## 3. 设计 3：A 路径候选消费路径（对应 **P3-04**）

- **不新增** Scheduler / Controller / Runtime / 队列；候选**只能**通过既有两个入口进入执行：
  ① `createPrismaTaskQueuePort().admit()`（写入 `CUSTOMER_GOAL_QUEUE` 容器下的 durable 任务）；
  ② 既有 `createAutonomyTaskSource().claim()`（授权重解析 + 租约 + fencing）。
- 候选转换必须**显式携带**执行前重验所需的全部输入（组织身份、授权版本、操作类型、幂等/副作用状态、故障 id），
  且**不得**把 `autoRecoverAuthorized` 直接当作执行许可（PHASE 2 已登记的不变量）。
- 与客户队列的**结构隔离**保持：`INTERNAL_FAULT` 容器不得被客户执行器认领（既有 claim 仅信任 `CUSTOMER_GOAL_QUEUE`）。
- 外写类动作（`EXTERNAL_WRITE`）在本设计中**恒 HOLD**，不进入候选生成。

## 4. 设计 4：代码修复权限模型（对应 **P3-05**，仅设计）

> 注意：PHASE 3 实现授权为 **NO**；本节只定义 PHASE 3/4 实施时必须满足的权限模型。

| 维度 | 设计 |
| --- | --- |
| 允许修改范围 | 仅限**显式白名单路径**（例如 `apps/api/src/services/**` 中的既有模块、测试文件）；白名单外一律拒绝 |
| 禁止修改范围 | 封板 `release/rc-20261008-linux-deploy-v1`、`main`、迁移文件、Action Guard / 权限 / 支付 / 外写相关门禁代码、任何密钥材料 |
| 补丁候选 | Builder 产出**候选补丁 + 证据**（diff、受影响测试、回放结果）；候选不得直接落地 |
| 独立 Judge | Builder ≠ Judge（复用既有 `assertBuilderJudgeSeparation` 语义）；Judge 只依据**可复现证据**裁决 |
| 隔离执行 | 沙箱/隔离工作区执行测试；**低权限 + 受限 FS + 命令白名单**；禁网默认；禁读生产密钥 |
| 回滚 | 每个候选必须附回滚步骤与前后状态哈希；回滚失败 ⇒ BLOCK |
| 外写阻断 | 修复平面不得获得任何外部写/支付/报关/运输能力（ACTION_GUARD + 常量级 HOLD） |
| 退出条件 | 任何一环未闭合 ⇒ `HUMAN_REVIEW`（不得自动合并/自动提交/自动部署） |

## 5. 设计 5：失败矩阵与门禁（对应 **P3-06**）

| 失败场景 | 预期行为 | 门禁 |
| --- | --- | --- |
| 伪装来源（客户端/模型伪造可信事实） | 拒绝，不产生候选 | 真实服务端来源负向测试（非字符串级） |
| 授权过期 / 已撤销 | fail-closed，记原因码 | 执行前重验（P3-02/03） |
| 租户切换 / 跨租户读取 | 返回空 + 拒绝 | 适配器租户谓词 |
| 竞态撤销（校验后被撤销） | 执行终止，不产生副作用 | claim 重解析 + fenced settle |
| 过期快照被消费 | 拒绝并重新分流 | 快照时效 + 版本比对 |
| 重放 / 重复执行 | 幂等：同因不重复生效 | durable 唯一键 + first-write-wins 登记 + 幂等操作 |
| 错误修复（Judge 判定不合格） | REVISE 有界重试后 BLOCK | 独立 Judge + 重试上限 |
| Judge 拒绝 / 越预算 / 超时 | BLOCK，不落地 | 预算与超时门禁 |
| 数据库断连 / 崩溃 | fail-closed；恢复后按既有 reconcile 收敛 | 既有 FAILURE_RECOVERY 门禁 |

**测试计划（PHASE 3 实施时才执行）**：单元（契约/负向）→ 真实 PostgreSQL（租户/授权/竞态）→ 真实运行时路径（fencing/恢复）→ 全量回归；
每类失败场景至少 1 条负向用例，并在提交材料中给出可复现命令与退出码。

## 6. 未实现事项与前置条件（如实登记）

1. `TRIAGE_TRUSTED_FACT_CONTRACT.runtimeSourceIsolationImplemented = false` —— **来源真实性隔离未实现**
   （`PHASE3_IMPLEMENTATION_PREREQUISITE = TRUSTED_ADAPTER_SOURCE_PROVENANCE_EXECUTION_TIME_RECHECK`）。
2. A 路径**尚无消费通道**（PHASE 2 只登记候选；接线属 PHASE 3 实施范围，当前未授权）。
3. 代码修复代理、隔离沙箱、独立 Judge 接线、回滚机制**均未实现**。
4. Linux/systemd、真实 Provider/模型、CI、生产环境**未验证**；`EXTERNAL_WRITE = HOLD`、`PRODUCTION_READY = NO`。
5. 历史测试债（P2E-DB5、broker hook）与历史载荷敏感残留**均未关闭**。

## 7. 待审计的设计裁决请求（拟随 MSG-20261009-12 提交）

请裁决：① 可信适配器的来源证明形态是否充分；② 执行前重验时序是否覆盖全部 P0 前置条件；
③ 候选消费路径是否确实不新增第二运行时；④ 修复权限模型的允许/禁止边界是否足够保守；
⑤ 失败矩阵与门禁是否覆盖审计列出的全部场景。
