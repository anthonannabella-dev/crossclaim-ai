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

---

## 8. FINAL-R2 修订（回应 MSG-20261009-12 的三项 P0 与五项 P1）

> 本轮**仍为只读设计修订**：仅修改本文档、状态机契约、权限矩阵、时序图与测试验收规范。
> 不实现或修改任何代码（不实现适配器、不接线、不改 Runtime / 队列 / Action Guard、不建 Builder/Judge、
> 不改 Prisma / migration / 封板分支、不开真实外写）。

### 8.1 CHANGE 1（P0）封闭「授权撤销 ↔ 执行副作用」竞态

审计指出：fenced settle 只能证明**最终状态写入**被拒绝，不能证明窗口内已经发生的副作用不存在。
必须把「撤销」与「副作用提交」之间的顺序变成**可证明**的。

1. **最终授权门（final authorization gate）**：在**实际执行动作之前**、紧邻副作用入口处，再次调用可信适配器
   （`authorizeAtExecution`），校验组织身份、授权版本、撤销状态、有效期、动作类型与限额。
2. **执行期持续校验**：动作执行期间按固定节拍校验**租约未过期 + fencing token 未被替换**；失败即触发取消协议。
3. **取消协议（cancellation protocol）**：为每个副作用定义取消语义 ——
   `CANCEL_SAFE`：可在提交前中止且不产生外部可见效果；`CANCEL_UNSAFE`：一旦开始即可能产生外部可见效果
   ⇒ **本阶段禁止**（`EXTERNAL_WRITE` / 支付 / 报关 / 运输恒 HOLD）。
4. **副作用提交边界（commit boundary）**：每个可见副作用必须声明**唯一提交点**（如「数据库事务 COMMIT」或「外部请求发出」）；
   提交点之前失败 ⇒ 无副作用；提交点之后失败 ⇒ **必须如实记录为"可能已发生"**，
   **不得**因事后 settle 失败而标记为「零副作用」。
5. **线性化要求**：撤销与副作用提交之间必须存在可证明的线性化顺序；实现手段（择一或组合，实施阶段由审计确认）：
   ① 提交点持有**与授权版本绑定的行级锁 / 条件写**（撤销必须先取得同一锁）；
   ② 提交点前做一次**带版本号的 CAS 提交**；③ 等效串行化 + 防重 + 取消协议。若无法证明 ⇒ 动作进入 `BLOCK` / `HUMAN_REVIEW`。
6. **不可逆动作**：本阶段继续**禁止**；不得以「执行前二次检查」替代可证明的线性化。

**验收矩阵（实施阶段必须逐格覆盖；零副作用断言只允许覆盖"可被系统实际阻断"的窗口）**：

| 撤销发生时点 | 期望行为 | 证据要求 |
| --- | --- | --- |
| claim 前 | 不领取 | claim 拒绝 + 原因码 |
| claim 后、执行前 | 被最终授权门拒绝 | 门禁拒绝记录；零次调用副作用入口 |
| 执行中、提交前 | 取消协议生效 | 取消证据 + 无提交记录 |
| 提交边界处 | 线性化保证：撤销先赢或提交先赢，二者其一 | 顺序证明（锁 / CAS / 串行化证据） |
| 提交后 | 如实登记"可能已发生"，不得宣称零副作用 | 副作用登记 + 事后人工处置路径 |

### 8.2 CHANGE 2（P0）A 路径候选与客户任务的强身份隔离

1. **不得以改 kind 继承客户授权**：内部故障候选**不是**客户请求；不得把 `INTERNAL_FAULT` 改写成
   `CUSTOMER_GOAL_QUEUE` 以复用客户 Standing Authorization。
2. **候选必须保留**：`incidentId`、可信租户关系（服务端解析所得，而非载荷自报）、任务类型、来源身份。
3. **载荷 `organizationId` 不是身份**：一律不得作为可信组织身份（沿用 PHASE 2 契约）。
4. **两处分别重解析**：**入队前**与**认领后**必须各自重新解析授权与身份（两次独立解析，任一次失败即拒绝）。
5. **不自动扩权**：现有客户授权**不得**自动扩大到内部代码修改；内部修复须走 CHANGE 3 的独立权限模型。
6. **不得绕过 Guard**：`INTERNAL_FAULT` 不得借队列转换绕过 Action Guard / 审批 / Kill Switch。
7. **关联与恢复契约**：定义 incident ↔ task 的持久化关联（外键语义）、去重键规则（同因不重复入队）、
   状态转移（见 §9）与崩溃恢复规则（不重复消费、不身份漂移）。
8. **本轮不修改队列代码**：上述均为设计契约；任何队列实现变更须单独授权与审计。

### 8.3 CHANGE 3（P0）修复权限分离覆盖「补丁生成 → 发布」全过程

| 维度 | FINAL-R2 强化条款 |
| --- | --- |
| 工作区绑定 | 每个补丁候选绑定：基线 commit、**逐路径允许清单**、变更内容哈希（候选 diff 摘要） |
| 路径限制 | 禁止符号链接逃逸、路径穿越、`.git/hooks`、子模块、间接配置文件与脚本调用逃逸；仅允许清单内**常规文件** |
| 命令限制 | 测试命令不得继承生产凭据、Docker socket、宿主敏感挂载或发布权限；默认禁网；命令白名单 |
| Judge 独立性 | Judge 不得由 Builder 构造 / 覆盖评审依据；必须核验**真实可复现**测试输出（命令 + 退出码 + 原始日志摘要） |
| 结果不可变性 | Judge 审核的补丁哈希必须与最终候选补丁哈希**完全一致**；不一致 ⇒ `BLOCK` / `PATCH_DIGEST_MISMATCH` / `NO_APPLY` |
| 提交边界 | 即使 Judge PASS 也只能产出**已验证候选**；禁止自动合并 / 自动部署 / 修改封板分支 |
| 回滚边界 | 回滚能力必须**实际可行**（含数据与配置）；对不可逆副作用**不得承诺**自动回滚 |
| 白名单口径 | `services/**` 不再作为整体默认安全范围，改为**逐路径允许清单**（每项需审计确认） |

### 8.4 CHANGE 4–8（P1）条款

- **CHANGE 4 · provenance 生命周期**：provenance 必须绑定**执行主体 + 租户 + 会话 + 事实版本 + 读取时间**；
  旧证明、跨主体证明、跨会话证明**不得复用**（每次执行前重新读取）。
- **CHANGE 5 · 快照规则**：明确 `triagedAt` TTL、授权版本、状态变更与**重新分流**规则；**过期快照不得进入执行**。
- **CHANGE 6 · 重试与成本上限**：分流 / 补丁 REVISE **有界**（次数 + 模型成本 + 时长），超限 ⇒ `BLOCK`（禁止无限重试）。
- **CHANGE 7 · 真实性验证**：安全边界必须由**真实 PostgreSQL + 真实运行时路径**的负向测试证明；
  **不允许**仅用 mock 证明安全边界。
- **CHANGE 8 · 崩溃收敛**：定义崩溃后状态收敛契约与不可重复提交契约；恢复后**不得**重复副作用或身份漂移。

### 8.5 失败矩阵补充场景（追加至 §5）

| 场景 | 预期行为 | 门禁 |
| --- | --- | --- |
| **TOCTOU（检查与使用之间状态变化）** | 拒绝并重新分流 | 最终授权门 + 事实版本比对（CHANGE 1/4） |
| **路径逃逸（符号链接 / 穿越 / hooks / 子模块 / 间接配置）** | 拒绝候选并留证 | 逐路径白名单 + 工作区绑定（CHANGE 3） |
| **崩溃恢复后重复消费 / 身份漂移** | 不重复副作用、不漂移身份 | 状态收敛与不可重复提交契约（CHANGE 8） |
| **JUDGE_PASS_PATCH_CHANGED_AFTER_REVIEW** | `BLOCK` / `PATCH_DIGEST_MISMATCH` / `NO_APPLY` | Judge 审核哈希 ≡ 最终候选哈希（CHANGE 3/6） |

## 9. 状态转移表（候选入队 → 认领 → 执行 → 终止）

| # | 当前状态 | 触发 | 下一状态 | 守卫（全部 fail-closed） |
| --- | --- | --- | --- | --- |
| 1 | `CANDIDATE_REGISTERED`（PHASE 2 登记） | 调度扫描 | `ENQUEUE_PENDING` | 快照未过期（TTL / 版本）；非外写；非安全或权限信号 |
| 2 | `ENQUEUE_PENDING` | 入队 | `ENQUEUED` | 入队前重解析身份 + 授权；不得改 kind；不得绕 Guard |
| 3 | `ENQUEUED` | 领取 | `CLAIMED` | 认领后**再次**重解析身份 + 授权；租约获取成功 |
| 4 | `CLAIMED` | 执行前 | `EXECUTING` | **最终授权门**通过；租约未过期；fencing token 有效 |
| 5 | `EXECUTING` | 提交点前 | `CANCELED` | 撤销 / 租约失效 / 取消协议触发 ⇒ 无副作用 |
| 6 | `EXECUTING` | 到达提交边界 | `COMMITTED` 或 `REJECTED_AT_COMMIT` | 线性化（锁 / CAS / 串行化）决定胜者；不可二者皆真 |
| 7 | `COMMITTED` | 事后 settle | `SETTLED` 或 `SETTLE_REJECTED_BUT_EFFECT_POSSIBLE` | 若 settle 被拒且已过提交点 ⇒ 如实登记"可能已发生"，交人工处置 |
| 8 | 任意 | 撤销发生（任何时点） | `BLOCKED` / `CANCELED` / `REJECTED_AT_COMMIT`（按 §8.1 矩阵） | 若已过提交点，**不得**宣告零副作用 |
| 9 | 任意 | 崩溃 | `RECOVERING` → 收敛（不重复副作用） | 既有 reconcile + CHANGE 8 契约 |
| 10 | 任意 | 判定需修代码 | `CODE_REPAIR_CANDIDATE`（独立权限模型） | CHANGE 3 全过程门禁；不得自动落地 |

## 10. FINAL-R2 未实施声明（不虚报）

本轮为**纯设计修订**：未实现 `FaultTrustedFactsAdapter`、未建立候选消费通道、未实施 Builder/Judge、未接线、未开放任何执行权限；
`EXTERNAL_WRITE = HOLD`、`PRODUCTION_READY = NO`；历史测试债与历史载荷残留仍未关闭；Linux / Provider / 生产端到端仍未验证。


---

## 11. FINAL-R3 收口（回应 MSG-20261009-13 的 CHANGE 9–12）

> 本轮**仍是只读设计收口**：仅修订契约、验收矩阵与实施单元划分。不实现、不接线、不修改任何运行时代码。

### 11.1 CHANGE 9（P0）动作分类与副作用提交协议

**动作分类表**：

| 类别 | 示例 | 本阶段是否允许 | 唯一提交点 | 必需机制 |
| --- | --- | --- | --- | --- |
| `PURE_READ` | 读取事实、比对、生成候选 | **允许** | 无（无副作用） | 只读；仍须租户谓词 + 授权 |
| `ISOLATED_WRITE` | 在**隔离工作区**写入候选补丁/测试产物（非仓库） | **允许** | 隔离工作区写入完成 | 工作区绑定 + 内容哈希；不得触碰仓库 / 封板 |
| `REVERSIBLE_INTERNAL_COMMIT` | 可回滚的内部变更（本阶段不实施，仅设计备用） | **NOT_AUTHORIZED** | 单个 PostgreSQL 事务 COMMIT | 行级锁或条件更新建立可证明顺序 + 回滚脚本 + 授权版本校验点 |
| `IRREVERSIBLE_OR_EXTERNAL` | 外部写、支付、报关、物流、生产库写入、封板 / 合并 / 部署 | **NOT_AUTHORIZED（恒 HOLD）** | — | 需跨系统协调协议；缺协议 ⇒ BLOCK |

**提交协议（每个允许写入的动作）**：
1. **唯一提交点**声明（DB COMMIT / 隔离工作区落地）；
2. **授权版本校验点**：紧邻提交点前的 CAS —— `WHERE "authorizationVersion" = $v AND "revocationState" = 'ACTIVE'`；
3. **幂等标识**：`idempotencyKey = digest(incidentId, actionType, targetRef, factVersion)`；
4. **持久化副作用登记**：提交前写 `intent`，提交后写 `outcome`（含提交凭证摘要）；
   未跨提交点 ⇒ `outcome = NOT_COMMITTED`；跨提交点但确认丢失 ⇒ `outcome = UNKNOWN`（进入对账）。
5. **线性化**：撤销与提交竞争**同一行锁 / 同一条件写** ⇒ 必然**唯一胜者**；提交成功后发生的撤销**不得追溯**宣称提交未发生。
6. **跨事务 / 外部系统**：不得仅凭本地 CAS 宣称原子性；**缺少协调协议的动作继续 BLOCK**。
7. `SETTLE_REJECTED_BUT_EFFECT_POSSIBLE` ⇒ 必须进入**持久化对账**或人工处置，**禁止**自动重复执行。

**关闭标准**：形成动作分类表 + 每类提交协议；无法证明安全性的动作明确标记 `NOT_AUTHORIZED`。

### 11.2 CHANGE 10（P0）权威身份与幂等契约

**权威关系（Incident → Candidate → Task → Attempt）**：

| 层 | 权威来源 | 关键字段 |
| --- | --- | --- |
| `Incident` | 既有 `AutonomyIncident`（kind = `INTERNAL_FAULT`） | `incidentId`、`detectedAt`、`status`、`sourceRefs`（PHASE 1 白名单快照） |
| `Candidate` | 修复平面新增的候选记录（**设计**；未实现） | `candidateId`、`incidentId`、`sourceKind`（`PHASE1_CLASSIFIER` / `PHASE2_TRIAGE`）、`trustedSubjectRef`（**服务端解析**）、`identityVersion`、`status`、`dedupeKey` |
| `Task` | 既有 `AutonomyTask`（复用，不新增队列） | `taskId`、`incidentId`、`dedupeKey`、`status`、`attempts` |
| `Attempt` | 既有 `AutonomyLease`（复用） | `taskId`、`ownerRef`、`expiresAt`、`status`（fencing token 语义） |

**规则**：
1. `incidentId` 必须关联**权威持久化 Incident**，不得依赖候选载荷声明；
2. **去重键覆盖任务种类 + 修复目标 + 事实版本**（避免误合并不同故障）；同一 Incident 可产生多个候选，各自独立去重键；
3. `identityVersion` 变化 ⇒ **原 Task 失效**（置 `BLOCKED`/`STALE`）并重新分流；**禁止**自动迁移租户或扩大权限；
4. 入队前解析、认领后解析、**提交前最终授权检查** 三者**都要**（前者不能替代后者）；
5. Attempt 必须由 lease 唯一标识；重复消息按 `idempotencyKey` 去重；崩溃恢复按 §11.4 的 `RECOVERING` 收敛。

**拒绝规则**：重复（dedupeKey 命中）⇒ 拒绝且不新建；并发（CAS 失败）⇒ 拒绝且留证；身份漂移（`identityVersion` 不一致）⇒ BLOCK 且重新分流。

### 11.3 CHANGE 11（P1）沙箱隔离与可信验证边界

1. **三方隔离**：Builder（生成候选）/ TestRunner（执行测试）/ Judge（裁决）使用**相互隔离**的执行上下文与权限。
2. **工作区绑定**：固定基线 commit + 允许路径清单 + 内容摘要（`candidateDigest`）。
3. **验证记录不可由 Builder 伪造**：测试输入、实际执行命令、环境约束、退出码、原始日志摘要由 TestRunner 侧生成并持久化；
   Builder **无写权限**。
4. **禁止** Builder 修改 Judge 策略、测试入口、权限策略或验证结果存储。
5. **路径检查覆盖解析后的真实目标**（`realpath`），并防止「检查后替换」：先解析真实路径，再在同一句柄/事务内使用（消除 TOCTOU 窗口）。
6. **fail-closed 清单**：隔离失败、资源耗尽、超时、恶意补丁、测试结果不确定 ⇒ 一律拒绝（不得进入 Judge PASS）。
7. `Judge PASS` **仅**表示候选满足**当前验证策略**，不等于补丁安全、生产可发布或可自动合并。

### 11.4 CHANGE 12（P1）状态转移的提交语义

| 状态 | 不变量 | 终态 |
| --- | --- | --- |
| `CANCELED_BEFORE_COMMIT` | 有取消证据**且**未跨越提交点 | 是 |
| `REJECTED_AT_COMMIT` | 提交被权威机制拒绝 | 是 |
| `COMMITTED` | 存在**可信提交凭证**（凭证摘要已落库） | 否（可转 `SETTLED`） |
| `COMMIT_OUTCOME_UNKNOWN` | 提交结果不确定；**禁止盲重试** | 否（仅能经对账转出） |
| `SETTLED` | 结果已持久化收敛 | 是 |
| `SETTLE_REJECTED_BUT_EFFECT_POSSIBLE` | 收口失败但**不能排除**副作用已发生 | 否（对账 / 人工） |
| `RECOVERING` | 依据权威事实恢复，**不直接重放**副作用 | 否 |

**合法迁移（摘要）**：`CLAIMED →`（提交前撤销）`CANCELED_BEFORE_COMMIT`；`CLAIMED →`（提交被拒）`REJECTED_AT_COMMIT`；
`CLAIMED →`（提交成功）`COMMITTED`；`CLAIMED`/`COMMITTED →`（确认丢失）`COMMIT_OUTCOME_UNKNOWN`；
`COMMITTED → SETTLED`；`COMMITTED`/`COMMIT_OUTCOME_UNKNOWN → SETTLE_REJECTED_BUT_EFFECT_POSSIBLE`；
任意状态 →（崩溃）`RECOVERING` → 依据权威事实回到上述状态之一（**不得**直接重放副作用）。
**终态不可逆**：`CANCELED_BEFORE_COMMIT` / `REJECTED_AT_COMMIT` / `SETTLED` 一旦成立不得改写 ——
尤其**不得**把已 `COMMITTED` 的事实改写成"已取消"。
**并发恢复**：`RECOVERING` 期间必须以 fencing token 排斥旧 owner；恢复**不得重置**预算计数。

## 12. 可执行验收矩阵（实施阶段必须逐条通过；全部要求真实 PostgreSQL / 真实运行时路径）

| ID | 场景 | 期望 | 证据形态 |
| --- | --- | --- | --- |
| A1 | 授权撤销与 DB COMMIT 同时竞争 | 唯一线性化胜者；提交事实与授权顺序一致 | 并发测试 + 顺序证明（锁/CAS 记录） |
| A2 | 提交成功后进程崩溃、确认丢失 | `COMMIT_OUTCOME_UNKNOWN` → 权威对账；**不重复提交** | 崩溃注入 + 对账日志 + 计数不变 |
| A3 | Judge PASS 后工作区发生变化 | 摘要不一致 ⇒ `NO_APPLY` | `candidateDigest` 比对记录 |
| A4 | 身份版本变化后旧任务恢复 | 旧身份**禁止**继续执行并重新分流 | identityVersion 比对 + 重新分流记录 |
| A5 | 快照过期 / 授权版本变化 | 重新获取可信事实（**不得**简单延长 TTL） | 重新分流记录 |
| A6 | 崩溃恢复后重试/成本预算 | 计数**不被重置** | 预算持久化前后比对 |
| A7 | 路径逃逸（符号链接 / 穿越 / hooks / 子模块）与检查后替换 | 拒绝并留证 | realpath 检查 + TOCTOU 用例 |
| A8 | 沙箱失败 / 超时 / 资源耗尽 / 恶意补丁 / 结果不确定 | fail-closed，无 PASS | 隔离层拒绝记录 |
| A9 | 跨事务 / 外部副作用缺协调协议 | `BLOCK`（标记 `NOT_AUTHORIZED`） | 分类表 + 拒绝记录 |
| A10 | 重复 / 并发入队 | 单一 Task（dedupeKey + CAS） | 计数与 CAS 失败记录 |

**共同要求**：每条须给出**可复现命令 + 退出码 + 证据摘要**；**不允许**仅用 mock 证明安全边界；
安全边界不得只证明独立纯函数，必须覆盖**实际装配路径**。

## 13. 最小安全实施单元划分（供后续单独申请 PHASE 3-A 授权时使用；**本轮全部未实施**）

| 单元 | 覆盖 | 范围（允许） | 非目标 / 禁止 |
| --- | --- | --- | --- |
| U1 | P3-01 / P3-02 | 权威适配器与 provenance（只读可信存储；来源证明与生命周期） | 不写业务、不接线执行、不改 Runtime |
| U2 | P3-04 前置 | 候选记录与 Incident↔Candidate↔Task 关联、去重键、identityVersion 失效规则 | 不改既有队列语义、不新增队列、不触发执行 |
| U3 | P3-03 | 提交协议与线性化（intent/outcome 登记、对账入口） | 不触碰不可逆 / 外部副作用（恒 HOLD） |
| U4 | P3-05 | 沙箱三方隔离 + 不可伪造验证记录 + realpath 路径检查 | 不自动合并 / 不落地补丁 / 不改封板 |
| U5 | P3-06 | 状态语义拆分 + 崩溃收敛 + 预算持久化 + fencing | 不重放副作用、不重置预算 |

每个单元在申请实施时须单独给出：范围、非目标、对应验收矩阵条目（A1–A10）、回滚方案、禁止项；
**任何实施授权都必须单独送审，不得由设计裁决自动推导**。

## 14. FINAL-R3 未实施声明

本轮为**纯设计收口**：未实现 `FaultTrustedFactsAdapter`、未建立候选消费通道与候选记录、未实施提交协议与对账、未实施沙箱 / Builder / Judge、
未改动 Runtime / 队列 / Action Guard / Prisma / migration / 封板分支、未开启任何外部副作用。
`EXTERNAL_WRITE = HOLD`、`REAL_PROVIDER_EXECUTION = NOT_AUTHORIZED`、`AUTO_MERGE = FORBIDDEN`、`AUTO_DEPLOY = FORBIDDEN`、`PRODUCTION_READY = NO`。


---

## 15. PHASE 3-A · U1 实施规格（MSG-20261009-14 前置条件 ②）

> 授权：`PHASE3_A_MINIMAL_SCOPE_AUTHORIZED = YES`，授权单元 = `U1_READ_ONLY_SUBSET`。
> 设计评审锚点：`46e9cd9d`（实施采用独立可追溯提交，本次提交即该独立提交）。

### 15.1 文件白名单（本次 U1 实施仅新增以下文件，**未修改任何既有文件**）

| 文件 | 类型 | 说明 |
| --- | --- | --- |
| `apps/api/src/services/self-repair/trusted-facts-adapter.ts` | 新增 | 只读适配器 + 只读 Prisma 端口 + 边界声明 |
| `apps/api/src/__tests__/phase3a-u1-trusted-facts-adapter.test.ts` | 新增 | 端口级（纯函数）验收 12 用例 |
| `apps/api/src/__tests__/phase3a-u1-trusted-facts-adapter-db.test.ts` | 新增 | 真实 PostgreSQL 只读验收 4 用例 |
| `docs/releases/SI-RSI-INTERNAL-CODE-REPAIR-V1-PHASE3-DESIGN.md` | 文档 | 追加本节（§15）与 U1 记录 |
| `docs/releases/SI-RSI-INTERNAL-CODE-REPAIR-V1.md` | 文档 | checkpoint 更新 |

**未触碰**：Prisma schema / migration、既有任务队列（`prisma-task-queue-port`）、`rsi-durable-task-source`、runtime 控制流、封板分支。

### 15.2 接口签名（不可伪造的输入面）

```ts
createTrustedFactsAdapter(input: {
  readPort: TrustedFactsReadPort;          // 只读端口（仅 findOrganization / findStandingAuthorization）
  executionContext: TrustedExecutionContext; // 运行时注入：subjectRef + operationRecheck
  now?: () => Date;
}): TrustedFactsAdapter

TrustedFactsAdapter.resolve(input: {
  organizationId: string;   // 必须来自服务端会话/授权上下文（非候选载荷）
  actionType: string;
  amountUsd?: string;
}): Promise<
  | { ok: true; facts: TriageTrustedFacts; provenance: TrustedFactsProvenance }
  | { ok: false; reason: TrustedFactsFailureReason; provenance: TrustedFactsProvenance | null }
>
```

关键点：`resolve` **没有** payload / request / model 参数 ⇒ 候选载荷、请求体、模型输出在**类型层面**无法成为可信身份或可信事实。
输出 `facts` 与既有 `TriageTrustedFacts` 同构，可直接喂给既有 `triageFaultIncident`。

### 15.3 可信数据来源

| 事实 | 来源 | 实现 |
| --- | --- | --- |
| `organizationIdResolved` | `TRUSTED_PERSISTED_IDENTITY` | `Organization.findUnique`（SELECT）；`identityVersion` 取该行 `updatedAt`（不新增列） |
| `authorizationActive` | `SERVER_AUTHORIZATION_STATE` | `StandingAuthorization.findFirst`（SELECT，取最高 `authorizationVersion`）；校验撤销状态 / 生效期 / 动作类型 / 金额上限 |
| `operationRecheck` | `TRUSTED_EXECUTION_CONTEXT` | 由运行时注入的 `executionContext`（`NOT_CONFIRMED` ⇒ 直接 fail-closed） |

provenance 记录：`source` / `resolvedFrom` / `subjectRef` / `identityVersion` / `authorizationVersion` / `scopeDigest` / `resolvedAt`，
并给出 `factVersion = org:<identityVersion>|auth:<authorizationVersion>`（供快照作废判定；**每次调用重新读取**，不缓存）。

**fail-closed 原因码**：`TENANT_CONTEXT_REQUIRED` / `ORGANIZATION_NOT_FOUND` / `AUTHORIZATION_NOT_FOUND` /
`AUTHORIZATION_REVOKED` / `AUTHORIZATION_NOT_EFFECTIVE` / `ACTION_TYPE_NOT_ALLOWED` / `MONETARY_LIMIT_EXCEEDED` /
`OPERATION_RECHECK_NOT_CONFIRMED`。无法解析的金额（非十进制）视为**超限**（fail-closed）。

### 15.4 非目标（本轮明确不做）

- 不写任何业务表 / 不创建候选记录或任务 / 不获取租约 / 不调用运行时 / 不产生外部副作用；
- **不**接入 `rsi-run` 或其控制流；**不**修改队列认领语义；**不**实现 U2–U5；
- 不新增 Scheduler / Controller / Runtime；不改 schema / migration；不改封板分支；
- `runtimeSourceIsolationImplemented` 仍为 **false**（继续作为阻断执行接线的硬门）。

### 15.5 U1 验收证据（本次实测）

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| 端口级（纯函数） | `vitest run src/__tests__/phase3a-u1-trusted-facts-adapter.test.ts` | **12/12 PASS** |
| 真实 PostgreSQL（只读端口） | `vitest run src/__tests__/phase3a-u1-trusted-facts-adapter-db.test.ts` | **4/4 PASS**（隔离库 `crossclaim_p3r2_iso`） |
| 类型检查 | `apps/api tsc --noEmit` | **0 error** |

真实 PostgreSQL 覆盖：有效授权解析成功（provenance + `factVersion` 形如 `org:…|auth:3`）；
组织不存在 / 授权撤销 / 授权过期 / 动作类型不允许 / 超限额 逐项 fail-closed；
**只读副作用断言**：调用前后 `AutonomyTask` / `AutonomyLease` / `AutonomyIncident` 计数不变。
静态断言：适配器源码不含 `.create(` / `.update(` / `.delete(` / `.upsert(` / `$executeRaw` / `$queryRaw`，
且不含候选载荷/模型输入字段。

**未宣称**：U1 **实施审计尚未通过**（`PHASE3_U1_IMPLEMENTATION_CLOSED = NO`）；U2–U5 未授权；自动代码修复仍禁止。


---

## 16. CHANGE 13–16 契约（回应 MSG-20261009-14；**只读设计修订**）

> 本轮仅修订设计契约与验收定义；**未实施**任何新能力。已实施的唯一单元是 U1（只读适配器，见 §15）。

### 16.1 CHANGE 13（P0）分离「DB 提交」与「隔离文件提交」的线性化协议

审计要求：**不得把数据库 CAS 的原子性保证外推到文件系统或外部系统**。按动作类别分别定义：

| 类别 | 提交点 | 授权时效模型 | 失败恢复 | 顺序证明 |
| --- | --- | --- | --- | --- |
| `PURE_READ` | 无（不构成副作用提交） | 每次读取前校验租户 + 授权 + **数据访问范围** | 无副作用，重读即可 | 不适用（无提交） |
| `ISOLATED_WRITE` | **原子发布**（见下） | 发布前校验授权版本；撤销与发布之间**不宣称**统一顺序 | 删除 staging 目录；内容寻址发布可幂等重试 | 见下「顺序不可证时」 |
| `REVERSIBLE_INTERNAL_COMMIT` | 单个 PG 事务 COMMIT | 提交点前授权版本 CAS | 回滚脚本（须实际可行） | PG 行锁 / 条件写 |
| `IRREVERSIBLE_OR_EXTERNAL` | — | — | — | **NOT_AUTHORIZED（恒 HOLD）** |

**`ISOLATED_WRITE` 的四段协议**：
1. **staging**：仅写入 `<workspace>/.staging/<attemptId>/`，**不向任何其它组件暴露**；
2. **原子发布**：同文件系统内 `rename()` 到 `<workspace>/candidates/<candidateDigest>/`（内容寻址）；
   目标已存在且摘要一致 ⇒ **幂等 no-op**；摘要不一致 ⇒ `NO_APPLY`；
3. **不可变摘要**：发布前后分别计算并记录 `candidateDigest`；发布后目录置为**只读**；
4. **清理**：撤销 / 失败 ⇒ 删除 staging；**不得**触碰仓库工作树、不得触碰封板分支。

**顺序不可证时的强制回退**：若无法建立「撤销检查 → 文件发布」的可验证统一顺序，
**不得**宣称"撤销后绝无写入"，必须二选一：① `BLOCK`；② 将产物限制为**不向其它组件暴露**的临时产物（staging-only）并在同一 attempt 内清理。

**关闭标准**：每种允许写入的动作都有**独立的提交点、授权时效模型与失败恢复定义**；
DB CAS 的证明**不得**外推到文件系统或外部系统。

### 16.2 CHANGE 14（P0）消除终态与 `RECOVERING` 的语义冲突

**三维独立表达**（互不覆盖）：

| 维度 | 取值 | 语义 |
| --- | --- | --- |
| **提交事实** `CommitFact` | `COMMITTED`（附凭证摘要）/ `REJECTED_AT_COMMIT` / `COMMIT_OUTCOME_UNKNOWN` / 未提交 | **不可变事实**，只追加 |
| **任务执行状态** `TaskState` | `READY` / `CLAIMED` / `EXECUTING` / `SETTLED` / `BLOCKED` | 业务流转 |
| **恢复控制状态** `RecoveryControl` | `IDLE` / `RECOVERING` / `RECONCILING` | **恢复作业**状态，不改写提交事实 |

**规则**：
1. 已有可信终态凭证的状态（`CANCELED_BEFORE_COMMIT` / `REJECTED_AT_COMMIT` / `SETTLED`）**不得**进入会覆盖业务事实的 `RECOVERING`；
   `RECOVERING` 只表示"恢复作业进行中"，**不改变**提交事实；
2. 只有权威机制**明确确认未提交**时，才允许 `REJECTED_AT_COMMIT`；
3. 已确认 `COMMITTED` 后，即使 `settle` 失败，**不得**回退为取消或拒绝提交；
4. `COMMIT_OUTCOME_UNKNOWN` **不得**因超时自动转 `REJECTED_AT_COMMIT`（只能经权威对账转 `SETTLED` 或 `REJECTED_AT_COMMIT`）；
5. `SETTLED` 必须携带**明确的最终结果类型**（`SUCCEEDED` / `BLOCKED` / `REJECTED`），**不得**默认等价于成功执行；
6. 必须能证明「提交事实 / 任务执行状态 / 恢复控制状态」三者可**独立表达**且不发生事实覆盖
   （对齐 A11：旧 fencing owner 与崩溃恢复均不得改写已确认终态）。

### 16.3 CHANGE 15（P1）收紧 Candidate / Task / Attempt 身份与幂等边界

1. **attemptId**：每次**真实认领**生成唯一 `attemptId`（可由 `leaseId` + `fencingGeneration` 派生）并持久化；
2. **对应关系**：`leaseId` / `fencingToken` / `attemptId` 三者关系显式定义；**续约**（renew）只延长租约，
   **不得**生成新的业务 Attempt；
3. **fencing 世代**：同一任务被**重新认领**必须使 `fencingGeneration += 1`；旧世代的任何提交一律拒绝；
4. **Candidate 去重键**：`digest(权威目标 + 任务类型 + 事实版本 + 租户隔离维度)`（输入取**服务端解析**结果，不取载荷声明）；
5. **去重冲突**：返回既有记录，或产生**显式冲突证据**；**不得**静默丢弃"事实不同"的候选；
6. **identityVersion 失效**：旧 Attempt **不得**继续提交；但**历史审计事实保留**（只追加、不删除）。

### 16.4 CHANGE 16（P1）强化验证产物绑定与沙箱失效条件

1. **Judge 可信输入绑定**：`baselineCommit + candidateDigest + verificationPolicyVersion + testEnvironmentDigest + testResultDigest`，
   缺任一项 ⇒ `NO_PASS`；
2. **Builder 不能控制** TestRunner 的执行程序、策略与结果存储；
3. **执行环境禁止**：未授权网络访问、凭据读取、宿主挂载、特权容器操作；
4. **不允许**从不可信工作区直接执行 hooks 或测试入口；
5. **路径验证**：须处理符号链接、硬链接、目录替换、子模块及其它逃逸路径；
   **`realpath` 本身不足以消除 TOCTOU** ⇒ 实际打开与写入必须使用**安全文件句柄**（等价 `O_NOFOLLOW`）与**目录约束**（等价 `openat`/dirfd 绑定）；
6. 隔离失败 / 超时 / 结果缺失 / 摘要不一致 ⇒ 一律 `NO_PASS`；
7. **Judge 输出语义**：`VERIFICATION_PASS ≠ SECURITY_APPROVAL ≠ MERGE_AUTHORIZATION ≠ DEPLOY_AUTHORIZATION`（须显式记录）。

### 16.5 追加验收定义（A11 / A12）

| ID | 场景构造 | 期望断言 |
| --- | --- | --- |
| **A11 Terminal State Integrity** | 已权威确认终态 + 崩溃恢复 + 旧 fencing owner 提交 | 终态**不被改写**（提交事实只追加）；旧 owner 提交被拒；无重复副作用 |
| **A12 Workspace Publication Boundary** | 撤销与文件发布并发竞争 | 能证明允许顺序（发布先或撤销先**唯一胜者**）；无法证明时必须**拒绝公开**候选产物（staging-only 或清理），产物不得对外可见 |

**A1–A12 均为实施阶段验收要求，本轮不宣称通过。**

### 16.6 本轮未实施声明（重申）

本轮**仅设计**。已实施且仍待独立审计的仅有 U1（只读适配器，§15）；U2–U5 **未授权、未实施**；
`AUTONOMOUS_CODE_REPAIR / BUILDER_EXECUTION / JUDGE_EXECUTION / PATCH_APPLY = NO`；
`EXTERNAL_WRITE = HOLD`、`AUTO_MERGE / AUTO_DEPLOY = FORBIDDEN`、`PRODUCTION_READY = NO`；
`runtimeSourceIsolationImplemented = false` 仍为阻断执行接线的硬门。

