# SI/RSI INTERNAL CODE REPAIR V1 —— PHASE 3（只读设计）设计复审请求

审计编号（请在回复标题中沿用）：MSG-20261009-12
REVIEWED_HEAD = 101d5912（分支 feat/si-rsi-internal-code-repair-v1）
上一轮裁决：MSG-20261009-11 = PASS（**PHASE2_CLOSED = YES**；PHASE3_DESIGN_AUTHORIZED = YES · READ ONLY；
PHASE3_IMPLEMENTATION_AUTHORIZED = NO；AUTONOMOUS_CODE_REPAIR_AUTHORIZED = NO；NEXT_AUDIT = MSG-20261009-12）
durable 记录：docs/releases/SI-RSI-INTERNAL-CODE-REPAIR-V1-PHASE3-DESIGN.md（设计正文）

重要声明：本轮**只有设计**，未写任何执行代码、未实施修复代理、未接线、未开放任何执行权限；
未改 Prisma schema/migration；未接真实 Provider；未修改封板 RC/main；EXTERNAL_WRITE 继续 HOLD；PRODUCTION_READY = NO。

一、现状盘点（只读，全部为既有实现）
- ONE SI Runtime 组装：runtime/rsi-run.ts（composeRsiRuntime / RsiRuntimeComposition / runtimeMembers()）。
- durable 任务源与授权重解析：runtime/rsi-durable-task-source.ts（claim / settle / fail / renew / reclaimExpired；CLAIM_AUTHORIZATION_DENY）。
- 任务形状：services/autonomy/rsi-continuation-engine.ts（RsiSafeTask，含可选可信 organizationId）。
- Action Guard / 审批 / Kill Switch：services/action-guard/*（actionRequiresHumanApproval、verifyApprovalOrThrow、ACTION_SCOPE_MAP、
  createActionGuardCapabilitySource、runtime-guard-composition）。
- 生命周期契约：services/autonomy/rsi-lifecycle.ts（transition、RSI_OWNER_GATED_ACTIONS、canAutoPromote、assertBuilderJudgeSeparation）。
- 本轮成果（PHASE 1/2，已审计）：services/self-repair/fault-classification.ts、fault-triage.ts、fault-triage-sweep.ts。
- 客户队列锚点：services/agent-goal/prisma-task-queue-port.ts（admit；kind = CUSTOMER_GOAL_QUEUE）。

二、设计 1：可信服务端适配器（对应 P3-01）
1. 唯一读取入口 FaultTrustedFactsAdapter：输入 incidentId + **服务端会话/授权上下文**（非请求体）；输出 TriageTrustedFacts + provenance。
2. 来源证明（provenance）：organizationIdResolved ← 可信身份关系主键命中（附 resolvedFrom/resolvedAt）；
   authorizationActive ← 授权存储当前行（revocationState / effectiveAt / expiresAt / authorizationVersion）；
   operationRecheck ← 执行上下文的再次确认（附受信任运行时成员标识）。
3. 不可信载荷边界：适配器只读可信存储；请求体 / 客户端字段 / 模型输出**只能作为待核验线索**，绝不直接映射为事实
   （沿用既有 FORBIDDEN_TRUSTED_FACT_SOURCES = REQUEST_PARAM / CLIENT_INPUT / MODEL_OUTPUT / UNKNOWN）。
4. 租户隔离：强制租户谓词，组织 id 必须来自会话/身份解析；跨租户读取返回空并记 fail-closed 原因码。

三、设计 2：执行前重验时序（对应 P3-02 / P3-03）
固定八步，任一环失败即 fail-closed 并在 durable 记录留痕：
1) 候选读取（INTERNAL_FAULT + DIAGNOSED 的 triage 快照）；
2) **快照作废判定**：triagedAt 超时效或 authorizationVersion 变化 ⇒ 视为过期快照，重新分流，不得直接消费；
3) 身份重解析（适配器）；
4) 授权重验（未撤销、未过期、动作类型允许、金额上限允许）；
5) 上下文重验（操作类型 + 幂等/副作用状态）；
6) 故障状态重验（必须仍为 DIAGNOSED；CLOSED/REJECTED/TASKED ⇒ 拒绝）；
7) Action Guard / 审批链（actionRequiresHumanApproval / verifyApprovalOrThrow）；
8) 租约与 fencing（既有 createAutonomyTaskSource().claim / settle）。
竞态撤销：第 4 步与第 8 步之间发生撤销 ⇒ 由既有 claim 授权重解析 + fenced settle 兜住；任何执行窗口内的授权状态变化都必须导致终止。

四、设计 3：A 路径候选消费路径（对应 P3-04）
- **不新增** Scheduler / Controller / Runtime / 队列；候选只能经既有两个入口进入执行：
  ① createPrismaTaskQueuePort().admit()（CUSTOMER_GOAL_QUEUE 容器下的 durable 任务）；② createAutonomyTaskSource().claim()。
- 候选转换必须显式携带执行前重验所需输入（组织身份、授权版本、操作类型、幂等/副作用状态、故障 id），
  且不得把 autoRecoverAuthorized 直接当作执行许可。
- 结构隔离保持：INTERNAL_FAULT 容器不得被客户执行器认领（既有 claim 仅信任 CUSTOMER_GOAL_QUEUE）。
- EXTERNAL_WRITE 恒 HOLD，不进入候选生成。

五、设计 4：代码修复权限模型（对应 P3-05；仅设计，实施未授权）
- 允许修改：仅显式白名单路径（例如既有 services/** 模块与测试文件）。
- 禁止修改：封板 release/rc-20261008-linux-deploy-v1、main、迁移文件、Action Guard/权限/支付/外写门禁代码、任何密钥材料。
- 补丁候选：Builder 产出候选补丁 + 证据（diff、受影响测试、回放结果），候选不得直接落地。
- 独立 Judge：Builder ≠ Judge（复用 assertBuilderJudgeSeparation 语义），只依据可复现证据裁决。
- 隔离执行：沙箱/隔离工作区，低权限 + 受限文件系统 + 命令白名单，默认禁网，禁读生产密钥。
- 回滚：每个候选必须附回滚步骤与前后状态哈希；回滚失败 ⇒ BLOCK。
- 外写阻断：修复平面不得获得任何外部写/支付/报关/运输能力。
- 退出条件：任一环未闭合 ⇒ HUMAN_REVIEW（不得自动合并 / 自动提交 / 自动部署）。

六、设计 5：失败矩阵与门禁（对应 P3-06）
| 场景 | 预期行为 | 门禁 |
| 伪装来源（客户端/模型伪造可信事实） | 拒绝，不产生候选 | 真实服务端来源负向测试（非字符串级） |
| 授权过期 / 已撤销 | fail-closed + 原因码 | 执行前重验 |
| 租户切换 / 跨租户读取 | 返回空 + 拒绝 | 适配器租户谓词 |
| 竞态撤销（校验后被撤销） | 执行终止、零副作用 | claim 重解析 + fenced settle |
| 过期快照被消费 | 拒绝并重新分流 | 快照时效 + 版本比对 |
| 重放 / 重复执行 | 幂等：同因不重复生效 | durable 唯一键 + first-write-wins + 幂等操作 |
| 错误修复（Judge 不合格） | REVISE 有界重试后 BLOCK | 独立 Judge + 重试上限 |
| Judge 拒绝 / 越预算 / 超时 | BLOCK，不落地 | 预算与超时门禁 |
| 数据库断连 / 崩溃 | fail-closed，恢复后按既有 reconcile 收敛 | 既有 FAILURE_RECOVERY 门禁 |
测试计划（实施阶段才执行）：单元（契约/负向）→ 真实 PostgreSQL（租户/授权/竞态）→ 真实运行时路径（fencing/恢复）→ 全量回归；
每类失败场景至少 1 条负向用例，并给出可复现命令与退出码。

七、如实登记的未实现事项（不虚报）
1. TRIAGE_TRUSTED_FACT_CONTRACT.runtimeSourceIsolationImplemented = false —— 来源真实性隔离**未实现**
   （PHASE3_IMPLEMENTATION_PREREQUISITE = TRUSTED_ADAPTER_SOURCE_PROVENANCE_EXECUTION_TIME_RECHECK）。
2. A 路径**尚无消费通道**（PHASE 2 只登记候选；接线属实施范围，当前未授权）。
3. 代码修复代理、隔离沙箱、独立 Judge 接线、回滚机制**均未实现**。
4. Linux/systemd、真实 Provider/模型、CI、生产环境**未验证**。
5. 历史测试债（P2E-DB5、broker hook）与历史载荷敏感残留**均未关闭**。

八、请求裁决（逐项）
1. TRUSTED_ADAPTER_PROVENANCE_DESIGN（来源证明形态是否充分）
2. PRE_EXECUTION_REVALIDATION_SEQUENCE（是否覆盖 P3-02/P3-03，含快照作废与竞态撤销）
3. CANDIDATE_CONSUMPTION_PATH（是否确实不新增第二运行时、且不绕过 Guard/fencing）
4. REPAIR_PERMISSION_MODEL（允许/禁止边界与 Judge/回滚/隔离是否足够保守）
5. FAILURE_MATRIX_AND_GATES（是否覆盖审计列出的全部场景）
6. DESIGN_SCOPE_HONESTY（未实现项是否如实登记）
并给出：
FINAL VERDICT: PASS | PASS WITH REVISE | REVISE | BLOCK
REVIEWED_HEAD: <sha>
PHASE3_DESIGN_ACCEPTED: YES | NO
PHASE3_IMPLEMENTATION_AUTHORIZED: YES | NO
NEXT_AUTHORIZED: <你方明确授权的下一步范围>
CHANGES: <必须执行的修订>
RISKS: <剩余风险>
请在本会话直接回复（不要写入我的仓库，也不要尝试访问外部系统）。若上文不可读，回复「需要重发」。
