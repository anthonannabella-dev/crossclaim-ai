# SI/RSI INTERNAL CODE REPAIR V1 —— PHASE 3 设计 FINAL-R3 复审请求（只读收口，仍未实施）

审计编号（请在回复标题中沿用）：MSG-20261009-14
REVIEWED_HEAD = 46e9cd9d（分支 feat/si-rsi-internal-code-repair-v1）
上一轮裁决：MSG-20261009-13 = PASS WITH REVISE（PHASE3_DESIGN_FINAL_ACCEPTED=YES_WITH_CONDITIONS；
PHASE3_IMPLEMENTATION_AUTHORIZED=NO；REQUIRED_CHANGES = CHANGE 9–12；NEXT_AUTHORIZED=PHASE3_DESIGN_FINAL_R3_READ_ONLY；
NEXT_AUDIT=MSG-20261009-14）
durable 记录：docs/releases/SI-RSI-INTERNAL-CODE-REPAIR-V1-PHASE3-DESIGN.md（§11 CHANGE 9–12、§12 验收矩阵 A1–A10、§13 最小安全实施单元 U1–U5、§14 未实施声明）

重要声明：本轮**仍为纯设计收口**。未实现适配器 / 候选消费通道 / 提交协议 / 沙箱 / Builder / Judge；
未修改 Runtime / 队列 / Action Guard / Prisma / migration / 封板分支；未开启任何外部副作用。
EXTERNAL_WRITE = HOLD；REAL_PROVIDER_EXECUTION = NOT_AUTHORIZED；AUTO_MERGE = FORBIDDEN；AUTO_DEPLOY = FORBIDDEN；PRODUCTION_READY = NO。

一、CHANGE 9（P0）动作分类与副作用提交协议
1) 动作分类表：
   - PURE_READ（读取/比对/生成候选）：**允许**；无副作用；仍须租户谓词 + 授权。
   - ISOLATED_WRITE（隔离工作区内写入候选补丁/测试产物，非仓库）：**允许**；提交点=隔离工作区落地；工作区绑定 + 内容哈希；不得触碰仓库/封板。
   - REVERSIBLE_INTERNAL_COMMIT（可回滚的内部变更）：**本阶段 NOT_AUTHORIZED**；未来须：提交点=单个 PostgreSQL 事务 COMMIT、
     行级锁或条件更新建立可证明顺序、回滚脚本、授权版本校验点。
   - IRREVERSIBLE_OR_EXTERNAL（外部写/支付/报关/物流/生产库写入/封板·合并·部署）：**NOT_AUTHORIZED（恒 HOLD）**；
     需跨系统协调协议，缺协议即 BLOCK。
2) 每个允许写入动作的提交协议：
   ① 唯一提交点；② 紧邻提交点前的**授权版本 CAS**（WHERE authorizationVersion=$v AND revocationState='ACTIVE'）；
   ③ 幂等标识 idempotencyKey = digest(incidentId, actionType, targetRef, factVersion)；
   ④ 持久化登记：提交前写 intent，提交后写 outcome（含提交凭证摘要）；未跨提交点 ⇒ NOT_COMMITTED；跨提交点但确认丢失 ⇒ UNKNOWN（进入对账）；
   ⑤ **线性化**：撤销与提交竞争同一行锁/同一条件写 ⇒ 必然唯一胜者；提交成功后的撤销**不得追溯**宣称提交未发生；
   ⑥ 跨事务/外部系统不得仅凭本地 CAS 宣称原子性（缺协调协议 ⇒ BLOCK）；
   ⑦ SETTLE_REJECTED_BUT_EFFECT_POSSIBLE ⇒ 必须进入持久化对账或人工处置，**禁止自动重复执行**。
3) 关闭标准：动作分类表 + 每类提交协议；无法证明安全性者标 NOT_AUTHORIZED。

二、CHANGE 10（P0）候选消费的权威身份与幂等契约
权威关系（Incident → Candidate → Task → Attempt）：
- Incident：既有 AutonomyIncident（kind=INTERNAL_FAULT；incidentId/detectedAt/status/sourceRefs 白名单快照）。
- Candidate（设计，未实现）：candidateId / incidentId / sourceKind（PHASE1_CLASSIFIER|PHASE2_TRIAGE）/ trustedSubjectRef（**服务端解析**）/
  identityVersion / status / dedupeKey。
- Task：复用既有 AutonomyTask（taskId/incidentId/dedupeKey/status/attempts）。
- Attempt：复用既有 AutonomyLease（taskId/ownerRef/expiresAt/status，fencing token 语义）。
规则：① incidentId 必须关联权威持久化 Incident（非载荷声明）；② 去重键覆盖**任务种类 + 修复目标 + 事实版本**（避免误合并不同故障；
同一 Incident 多候选各自独立去重键）；③ identityVersion 变化 ⇒ **原任务失效**（BLOCKED/STALE）并重新分流，
**禁止**自动迁移租户或扩大权限；④ 入队前解析、认领后解析、**提交前最终授权检查**三者都要（前者不能替代后者）；
⑤ Attempt 由 lease 唯一标识；重复消息按 idempotencyKey 去重；崩溃恢复按 §11.4 收敛。
拒绝规则：重复（dedupeKey 命中）⇒ 拒绝且不新建；并发（CAS 失败）⇒ 拒绝且留证；身份漂移（identityVersion 不一致）⇒ BLOCK 并重新分流。

三、CHANGE 11（P1）沙箱隔离与可信验证边界
① Builder / TestRunner / Judge 使用**相互隔离**的执行上下文与权限；
② 工作区绑定：固定基线 commit + 允许路径清单 + 内容摘要（candidateDigest）；
③ 验证记录**不可由 Builder 伪造**：测试输入、实际命令、环境约束、退出码、原始日志摘要由 TestRunner 侧生成并持久化，Builder 无写权限；
④ 禁止 Builder 修改 Judge 策略、测试入口、权限策略或验证结果存储；
⑤ 路径检查覆盖**解析后的真实目标**（realpath），并在同一句柄/事务内使用以消除检查后替换（TOCTOU）窗口；
⑥ fail-closed：隔离失败 / 资源耗尽 / 超时 / 恶意补丁 / 结果不确定 ⇒ 拒绝（不得进入 Judge PASS）；
⑦ Judge PASS 仅表示满足**当前验证策略**，不等于补丁安全、可发布或可自动合并。

四、CHANGE 12（P1）状态转移的提交语义
七状态与不变量：CANCELED_BEFORE_COMMIT（有取消证据且未跨提交点，终态）/ REJECTED_AT_COMMIT（提交被权威机制拒绝，终态）/
COMMITTED（存在**可信提交凭证**）/ COMMIT_OUTCOME_UNKNOWN（结果不确定，**禁止盲重试**）/
SETTLED（结果已持久化收敛，终态）/ SETTLE_REJECTED_BUT_EFFECT_POSSIBLE（不能排除副作用已发生）/ RECOVERING（依权威事实恢复，不直接重放）。
合法迁移（摘要）：CLAIMED→（提交前撤销）CANCELED_BEFORE_COMMIT；CLAIMED→（提交被拒）REJECTED_AT_COMMIT；
CLAIMED→（提交成功）COMMITTED；CLAIMED/COMMITTED→（确认丢失）COMMIT_OUTCOME_UNKNOWN；COMMITTED→SETTLED；
COMMITTED/UNKNOWN→SETTLE_REJECTED_BUT_EFFECT_POSSIBLE；任意→（崩溃）RECOVERING→依权威事实回到上述状态之一（不得直接重放副作用）。
终态不可逆：三个终态一旦成立不得改写，尤其**不得把已 COMMITTED 改写成"已取消"**。
并发恢复：RECOVERING 期间以 fencing token 排斥旧 owner；恢复**不得重置**预算计数。

五、可执行验收矩阵 A1–A10（实施阶段逐条通过；全部要求真实 PostgreSQL 与真实运行时路径，禁止 mock-only）
A1 撤销与 DB COMMIT 竞争 ⇒ 唯一线性化胜者且提交事实与授权顺序一致；
A2 提交成功后进程崩溃、确认丢失 ⇒ COMMIT_OUTCOME_UNKNOWN → 权威对账、**不重复提交**；
A3 Judge PASS 后工作区变化 ⇒ 摘要不一致 ⇒ NO_APPLY；
A4 身份版本变化后旧任务恢复 ⇒ 旧身份禁止继续执行并重新分流；
A5 快照过期 / 授权版本变化 ⇒ 重新获取可信事实（不得简单延长 TTL）；
A6 崩溃恢复后重试/成本预算 ⇒ 计数不被重置；
A7 路径逃逸（符号链接/穿越/hooks/子模块）与检查后替换 ⇒ 拒绝并留证；
A8 沙箱失败/超时/资源耗尽/恶意补丁/结果不确定 ⇒ fail-closed 且无 PASS；
A9 跨事务/外部副作用缺协调协议 ⇒ BLOCK（标记 NOT_AUTHORIZED）；
A10 重复/并发入队 ⇒ 单一 Task（dedupeKey + CAS）。
共同要求：每条给出可复现命令 + 退出码 + 证据摘要；安全边界必须覆盖**实际装配路径**，不得只证明独立纯函数或模拟适配器。

六、最小安全实施单元划分 U1–U5（供后续**单独**申请 PHASE 3-A 授权时使用；本轮全部未实施）
U1 权威适配器与 provenance（只读可信存储；不写业务、不接线执行、不改 Runtime）；
U2 候选记录与 Incident↔Candidate↔Task 关联、去重键、identityVersion 失效规则（不改既有队列语义、不新增队列、不触发执行）；
U3 提交协议与线性化（intent/outcome 登记 + 对账入口；不触碰不可逆/外部副作用）；
U4 沙箱三方隔离 + 不可伪造验证记录 + realpath 路径检查（不自动合并、不落地补丁、不改封板）；
U5 状态语义拆分 + 崩溃收敛 + 预算持久化 + fencing（不重放副作用、不重置预算）。
每个单元实施时须单独给出范围、非目标、对应验收条目（A1–A10）、回滚方案与禁止项；**任何实施授权都必须单独送审**。

七、如实声明的未实现事项（不虚报）
1. 未实现任何执行能力（适配器/候选通道/提交协议/对账/沙箱/Builder/Judge 均未实现）。
2. 未用 mock 冒充安全边界证明 —— 因为**尚未实施**（A1–A10 是实施阶段的验收要求）。
3. runtimeSourceIsolationImplemented = false 仍成立（PHASE3_IMPLEMENTATION_PREREQUISITE）。
4. Linux/systemd、真实 Provider/模型、CI、生产环境**未验证**；历史测试债与历史载荷残留**未关闭**。

八、请求裁决（逐项）
1. CHANGE9_ACTION_CLASSIFICATION_AND_COMMIT_PROTOCOL
2. CHANGE10_AUTHORITATIVE_IDENTITY_AND_IDEMPOTENCY_CONTRACT
3. CHANGE11_SANDBOX_AND_JUDGE_TRUST_BOUNDARY
4. CHANGE12_STATE_TRANSITION_SEMANTICS
5. ACCEPTANCE_MATRIX_A1_TO_A10（可执行性与覆盖度）
6. MINIMAL_IMPLEMENTATION_UNITS_U1_TO_U5（划分是否足以作为后续单独授权的最小安全范围）
7. DESIGN_ONLY_SCOPE_HONESTY
并给出：
FINAL VERDICT: PASS | PASS WITH REVISE | REVISE | BLOCK
REVIEWED_HEAD: <sha>
PHASE3_DESIGN_R3_ACCEPTED: YES | NO
PHASE3_IMPLEMENTATION_AUTHORIZED: YES | NO
PHASE3_A_MINIMAL_SCOPE_AUTHORIZED: YES | NO（若 YES，请指明授权的最小单元集合 U1–U5 与前置条件）
NEXT_AUTHORIZED: <你方明确授权的下一步范围>
CHANGES: <必须执行的修订>
RISKS: <剩余风险>
请在本会话直接回复（不要写入我的仓库，也不要尝试访问外部系统）。若上文不可读，回复「需要重发」。
