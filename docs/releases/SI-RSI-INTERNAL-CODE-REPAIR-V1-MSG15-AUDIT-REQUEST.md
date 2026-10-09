# SI/RSI INTERNAL CODE REPAIR V1 —— MSG-20261009-15 送审（两部分分别呈现）

审计编号（请在回复标题中沿用）：MSG-20261009-15
REVIEWED_HEAD = 1ed3f0b3（分支 feat/si-rsi-internal-code-repair-v1）
设计评审锚点（U1 授权依据）：46e9cd9d；U1 实施提交：101cd842；CHANGE 13–16 设计提交：1ed3f0b3
上一轮裁决：MSG-20261009-14 = PASS WITH REVISE（PHASE3_A_MINIMAL_SCOPE_AUTHORIZED=YES，授权单元 = U1_READ_ONLY_SUBSET；
NEXT_AUTHORIZED = PHASE3_A_U1_READ_ONLY_IMPLEMENTATION + DESIGN_ONLY_CHANGES_13_TO_16；NEXT_AUDIT = MSG-20261009-15）
durable 记录：设计文档 §15（U1 实施规格）与 §16（CHANGE 13–16 契约）

按裁决要求，本送审分两部分，**分别**呈现证据与结果，不用 U1 的实现通过代替 U2–U5 的设计或实施验收。

═══════════════════════════════════════════
第一部分（A）：U1 只读实现 + 验证证据
═══════════════════════════════════════════

A1. 交付文件（仅新增，未修改任何既有文件 —— 与授权文件白名单一致）
- apps/api/src/services/self-repair/trusted-facts-adapter.ts（只读适配器 + 只读 Prisma 端口 + 边界声明）
- apps/api/src/__tests__/phase3a-u1-trusted-facts-adapter.test.ts（端口级 12 用例）
- apps/api/src/__tests__/phase3a-u1-trusted-facts-adapter-db.test.ts（真实 PostgreSQL 4 用例）
- docs/releases/SI-RSI-INTERNAL-CODE-REPAIR-V1-PHASE3-DESIGN.md（追加 §15 规格）
- docs/releases/SI-RSI-INTERNAL-CODE-REPAIR-V1.md（checkpoint）
未触碰 Prisma schema / migration、既有任务队列、rsi-durable-task-source、runtime 控制流、封板分支。

A2. 接口签名（不可伪造的输入面）
createTrustedFactsAdapter({ readPort, executionContext, now? }) → { resolve({ organizationId, actionType, amountUsd? }) }
- resolve **没有** payload / request / model 参数 ⇒ 候选载荷、请求体、模型输出在**类型层面**无法成为可信身份或可信事实；
- organizationId 必须来自服务端会话/授权上下文；executionContext（subjectRef + operationRecheck）由运行时注入；
- 输出 facts 与既有 TriageTrustedFacts 同构，可直接喂给既有 triageFaultIncident。

A3. 可信数据来源（只读）
- organizationIdResolved ← TRUSTED_PERSISTED_IDENTITY：Organization.findUnique（SELECT）；identityVersion 取该行 updatedAt（不新增列）；
- authorizationActive ← SERVER_AUTHORIZATION_STATE：StandingAuthorization.findFirst（SELECT，取最高 authorizationVersion），
  校验撤销状态 / 生效期（effectiveAt/expiresAt）/ 动作类型 / 金额上限；
- operationRecheck ← TRUSTED_EXECUTION_CONTEXT：运行时注入；NOT_CONFIRMED 直接 fail-closed。
provenance 记录 source / resolvedFrom / subjectRef / identityVersion / authorizationVersion / scopeDigest / resolvedAt，
并给出 factVersion = org:<identityVersion>|auth:<authorizationVersion>（每次调用重新读取，不缓存）。

A4. fail-closed 原因码（8 种）
TENANT_CONTEXT_REQUIRED / ORGANIZATION_NOT_FOUND / AUTHORIZATION_NOT_FOUND / AUTHORIZATION_REVOKED /
AUTHORIZATION_NOT_EFFECTIVE / ACTION_TYPE_NOT_ALLOWED / MONETARY_LIMIT_EXCEEDED / OPERATION_RECHECK_NOT_CONFIRMED。
无法解析的金额（非十进制）一律视为**超限**（fail-closed）；allowedActionTypes 若为 JSON 非字符串数组形态 ⇒ 视为空集合（后续 fail-closed）。

A5. 验证证据（本轮实测）
- 端口级（纯函数）：vitest run src/__tests__/phase3a-u1-trusted-facts-adapter.test.ts ⇒ 12/12 PASS
  （可信解析成功 + 8 类 fail-closed + 金额边界/不可解析 + 静态断言：源码不含 .create(/.update(/.delete(/.upsert(/$executeRaw/$queryRaw，且不含候选载荷/模型输入字段）。
- 真实 PostgreSQL（隔离库 crossclaim_p3r2_iso）：vitest run ...-db.test.ts ⇒ 4/4 PASS
  （有效授权解析成功且 factVersion 形如 org:…|auth:3；组织不存在 / 撤销 / 过期 / 动作不允许 / 超限额 逐项 fail-closed；
  **只读副作用断言**：调用前后 AutonomyTask / AutonomyLease / AutonomyIncident 计数不变）。
- 类型检查：apps/api tsc --noEmit ⇒ 0 error。
- 运行环境：本机隔离库；未使用共享开发库；未执行生产部署或迁移。

A6. U1 明确未做（非目标）
不写业务表 / 不创建候选或任务 / 不获取租约 / 不调用运行时 / 不产生外部副作用 / 不接入 rsi-run / 不改队列认领语义 /
不实现 U2–U5 / 未新增 Scheduler·Controller·Runtime / 未改 schema·migration / 未改封板分支。
**PHASE3_U1_IMPLEMENTATION_CLOSED 仍为 NO**（等待本部分独立实施审计）；runtimeSourceIsolationImplemented 仍为 false（硬门未绕过）。

═══════════════════════════════════════════
第二部分（B）：CHANGE 13–16 只读设计修订（+ A11/A12）
═══════════════════════════════════════════

B1. CHANGE 13（P0）分离「DB 提交」与「隔离文件提交」的线性化协议
- 按动作类别分别定义提交点/授权时效模型/失败恢复：PURE_READ（无提交，但须租户+授权+数据访问范围）；
  ISOLATED_WRITE（四段协议）；REVERSIBLE_INTERNAL_COMMIT 与 IRREVERSIBLE_OR_EXTERNAL **继续 NOT_AUTHORIZED**；
- ISOLATED_WRITE 四段：① 仅写 `<workspace>/.staging/<attemptId>/`（不外露）；② 同文件系统原子 rename 到内容寻址
  `candidates/<candidateDigest>/`（摘要一致 ⇒ 幂等 no-op；不一致 ⇒ NO_APPLY）；③ 发布前后记录不可变摘要并置目录只读；④ 撤销/失败清理 staging；
- **顺序不可证时**：不得宣称"撤销后绝无写入"，必须二选一 —— BLOCK，或限制为不向其它组件暴露的临时产物（staging-only）；
- 关闭标准：每种允许写入动作有独立提交点/授权时效/失败恢复；**不得把 DB CAS 的保证外推到文件系统或外部系统**。

B2. CHANGE 14（P0）消除终态与 RECOVERING 的语义冲突（三维独立表达）
- CommitFact（COMMITTED 附凭证摘要 / REJECTED_AT_COMMIT / COMMIT_OUTCOME_UNKNOWN / 未提交）· TaskState · RecoveryControl（IDLE/RECOVERING/RECONCILING）；
- 终态凭证状态不得被 RECOVERING 覆盖；RECOVERING 只表示恢复作业进行中，**不改写提交事实**；
- 仅权威机制明确确认未提交 ⇒ 允许 REJECTED_AT_COMMIT；已确认 COMMITTED 后即使 settle 失败 ⇒ 不得回退为取消/拒绝；
- COMMIT_OUTCOME_UNKNOWN 不得因超时自动转 REJECTED_AT_COMMIT（仅可经权威对账转出）；
- SETTLED 必须携带最终结果类型（SUCCEEDED / BLOCKED / REJECTED），不得默认等价成功。

B3. CHANGE 15（P1）收紧 Candidate / Task / Attempt 身份与幂等
- 每次真实认领生成唯一 attemptId（由 leaseId + fencingGeneration 派生）并持久化；leaseId/fencingToken/attemptId 关系显式；
- **续约不生成新业务 Attempt**；同一任务重新认领必须 fencingGeneration += 1；旧世代提交一律拒绝；
- Candidate 去重键 = digest(权威目标 + 任务类型 + 事实版本 + 租户隔离维度)，输入取服务端解析结果；
- 去重冲突 ⇒ 返回既有记录或产出**显式冲突证据**（不得静默丢弃事实不同的候选）；
- identityVersion 失效后旧 Attempt 不得提交，但历史审计事实保留（只追加）。

B4. CHANGE 16（P1）强化验证产物绑定与沙箱失效条件
- Judge 可信输入绑定五元组：baselineCommit + candidateDigest + verificationPolicyVersion + testEnvironmentDigest + testResultDigest（缺一 ⇒ NO_PASS）；
- Builder 不能控制 TestRunner 的执行程序/策略/结果存储；
- 禁止未授权网络访问、凭据读取、宿主挂载、特权容器；不允许从不可信工作区直接执行 hooks 或测试入口；
- 路径验证处理符号链接/硬链接/目录替换/子模块；**realpath 不足以消除 TOCTOU** ⇒ 实际打开与写入须用安全文件句柄（等价 O_NOFOLLOW）+ 目录约束（等价 openat/dirfd）；
- 隔离失败/超时/结果缺失/摘要不一致 ⇒ NO_PASS；
- Judge 输出语义：VERIFICATION_PASS ≠ SECURITY_APPROVAL ≠ MERGE_AUTHORIZATION ≠ DEPLOY_AUTHORIZATION（须显式记录）。

B5. 追加验收定义（A11/A12，实施阶段要求，本轮不宣称通过）
- A11 Terminal State Integrity：已权威确认终态 + 崩溃恢复 + 旧 fencing owner 提交 ⇒ 终态不被改写、旧 owner 提交被拒、无重复副作用；
- A12 Workspace Publication Boundary：撤销与文件发布竞争 ⇒ 能证明允许顺序（唯一胜者）；无法证明必须拒绝公开候选产物（staging-only 或清理）。

B6. 本轮未实施声明
第二部分**纯设计**；除 U1（只读）外未实施任何能力；U2–U5 未授权未实施；
AUTONOMOUS_CODE_REPAIR / BUILDER_EXECUTION / JUDGE_EXECUTION / PATCH_APPLY = NO；
EXTERNAL_WRITE = HOLD、AUTO_MERGE / AUTO_DEPLOY = FORBIDDEN、PRODUCTION_READY = NO。

═══════════════════════════════════════════
请求裁决
═══════════════════════════════════════════
请分别裁决（不要混同两部分）：
A 部分：1. U1_READ_ONLY_IMPLEMENTATION（接口/来源/fail-closed/provenance 是否达标）
        2. U1_EVIDENCE_SUFFICIENCY（端口级 12 + 真实 PG 4 + tsc 0 + 只读副作用断言是否充分）
        3. U1_SCOPE_COMPLIANCE（是否严格未越界：未写业务表/未建任务/未接线/未改 schema·队列·runtime·封板）
B 部分：4. CHANGE13_FILESYSTEM_COMMIT_LINEARIZATION
        5. CHANGE14_TERMINAL_STATE_RECOVERY_SEMANTICS
        6. CHANGE15_CANDIDATE_ATTEMPT_IDENTITY_CONTRACT
        7. CHANGE16_SANDBOX_VERIFICATION_ARTIFACT_BINDING
        8. A11_A12_DEFINITIONS
总体：9. SCOPE_HONESTY
并给出：
FINAL VERDICT: PASS | PASS WITH REVISE | REVISE | BLOCK
REVIEWED_HEAD: <sha>
PHASE3_U1_IMPLEMENTATION_CLOSED: YES | NO
PHASE3_A_U2_TO_U5_AUTHORIZED: YES | NO
CHANGE_13_TO_16_ACCEPTED: YES | NO
NEXT_AUTHORIZED: <你方明确授权的下一步范围>
CHANGES: <必须执行的修订>
RISKS: <剩余风险>
请在本会话直接回复（不要写入我的仓库，也不要尝试访问外部系统）。若上文不可读，回复「需要重发」。
