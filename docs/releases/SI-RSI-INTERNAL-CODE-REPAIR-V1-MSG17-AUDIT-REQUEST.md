# SI/RSI INTERNAL CODE REPAIR V1 —— MSG-20261009-17 送审（U1 FINAL-R3：CHANGE 24–25）

审计编号（请在回复标题中沿用）：MSG-20261009-17
REVIEWED_HEAD（U1 代码 commit）= 612f687d（分支 feat/si-rsi-internal-code-repair-v1）
本轮执行依据：MSG-20261009-16 的 NEXT_AUTHORIZED = PHASE3_A_U1_FINAL_R3_CHANGE24_25_ONLY
上一轮裁决：MSG-20261009-16 = PASS WITH REVISE（U1 未关闭；REQUIRED_CHANGES = CHANGE 24（P0）+ CHANGE 25（P1））
durable 记录：checkpoint 文档 §2.15；独立证据包 tools/verification/self-repair/phase3a-u1-final-r3-evidence.json
（同目录另有原始输出 phase3a-u1-final-r3-vitest-raw.txt 与 phase3a-u1-final-r3-tsc-raw.txt）

本轮**只**处理 CHANGE 24 与 CHANGE 25，不重复打开已通过的金额规则，也不扩大 PHASE 3 的其他实施单元。
请裁决：是否达到 PHASE3_U1_IMPLEMENTATION_CLOSED = YES（U2–U5 仍应保持 NO）。

═════════ 第一部分（A）：CHANGE 24（P0）必需资源范围的可信导出 ═════════

A1. 问题回顾（上一轮审计原话）
- 送审规则曾规定「未提供的资源维度不构成约束」，因此当可信服务端未传某个实际必需的 platformAccountId /
  provider / jurisdiction 时，授权匹配可能扩大到不应覆盖的资源；多条有效授权会被拒绝，但
  **仅存在一条错误范围的授权时，唯一性本身不能阻止误授权**。

A2. 本轮修复（机制取代约定）
1) 新增**服务端动作策略**（模块常量，非调用者输入）：
   TRUSTED_FACTS_ACTION_SCOPE_POLICY =
     recovery.read            -> required: [platformAccountId, provider]；optional: [domain, jurisdiction]
     internal.repair.propose  -> required: [platformAccountId, provider]；optional: [domain, jurisdiction]
   未登记的动作类型 ⇒ SCOPE_POLICY_NOT_DEFINED（fail-closed，不猜测）。
2) **资源范围值改为只来自可信执行上下文**（executionContext.resourceScope，服务端解析注入）；
   resolve() 入参**不再存在** resourceScope 字段 —— 调用者既不能决定哪些维度是必需的，
   也不能通过省略维度来放大授权匹配面。（上一轮把 resourceScope 放在请求入参，属不可信来源，本轮移除。）
3) 必需维度缺失 / 空串 / 非字符串 ⇒ REQUIRED_SCOPE_MISSING（fail-closed）。
4) 授权匹配覆盖 provider / platformAccountId / domain / jurisdiction：已提供的维度一律参与匹配，
   提供了空串视为不匹配（不降级、不忽略）。
5) provenance 新增 scopePolicy { source: SERVER_ACTION_POLICY, actionType, required, optional, providedDimensions }，
   使「必需维度由谁决定、实际提供了哪些维度」可审计。

A3. 审计明确要求的负向测试（单授权情况）
| 场景 | 可信范围 | 结果 |
| --- | --- | --- |
| 跨账户 | platformAccountId = acct-other | AUTHORIZATION_NOT_FOUND |
| 跨 Provider | provider = SHOPIFY | AUTHORIZATION_NOT_FOUND |
| 跨 domain（可选维度） | domain = FINANCE | AUTHORIZATION_NOT_FOUND |
| 跨 jurisdiction（可选维度） | jurisdiction = JP | AUTHORIZATION_NOT_FOUND |
（端口级与真实 PostgreSQL 各有一组；真实库结果以 U1_EVIDENCE kind=SINGLE_AUTHORIZATION_SCOPE_NEGATIVES 记录。）

═════════ 第二部分（B）：CHANGE 25（P1）固定 HEAD 的独立证据包 ═════════

证据包 = tools/verification/self-repair/phase3a-u1-final-r3-evidence.json（schema 版本 crossclaim.si-rsi.u1-final-r3-evidence/1）

B1.（要求①）固定 REVIEWED_HEAD 的源码 diff、完整测试输出、退出码、测试文件对应关系
- codeCommit = 612f687d（含 codeCommitSubject、codeBranch）；u1FileSha256 给出三个 U1 文件的 sha256；
  u1DiffFromCommit = 该 commit 对三个 U1 文件的 unified diff；
  commands[] 逐条给出命令、cwd、隔离库标识、exitCode 与原始输出（rawOutput）；
  testFileMapping 给出「测试文件 → 覆盖对象」对应关系。

B2.（要求②）逐项用例名称与结果
- tests[] 共 55 项（file / name / status），全部 passed：
  端口级 48 项（phase3a-u1-trusted-facts-adapter.test.ts）+ 真实 PostgreSQL 7 项（…-db.test.ts）。
- 摘要行：Test Files 2 passed (2) / Tests 55 passed (55)；VITEST_EXIT=0；TSC_EXIT=0。

B3.（要求③）两条拒写探针**各自独立事务**与**原始 PostgreSQL 错误**
- 每条探针单独调用 runInReadOnlyTransaction（各自 BEGIN…SET TRANSACTION READ ONLY），互不共用事务；
- 实际捕获（dbProbeEvidence[]，kind=WRITE_PROBE，independentTransaction=true）：
  - DELETE_IN_READ_ONLY_TX：PrismaClientKnownRequestError，Raw query failed. Code: 25006.
    Message: ERROR: cannot execute DELETE in a read-only transaction
  - CREATE_TABLE_IN_READ_ONLY_TX：PrismaClientKnownRequestError，Raw query failed. Code: 25006.
    Message: ERROR: cannot execute CREATE TABLE in a read-only transaction
- 独立性证明：断言两条错误**分别含各自语句动词**（DELETE / CREATE TABLE），
  因此第二条不是「事务已中止」的连带错误（上一轮指出的正是这一点）。

B4.（要求④）证明经**公共 U1 入口**进入只读事务（而非测试手工构造端口）
- dbProbeEvidence[]，kind=PUBLIC_ENTRY_PROBE：
  path = createTrustedFactsAdapter.resolve → TrustedFactsReadPort.withReadOnlyTransaction；
  该包装仅在真实端口 withReadOnlyTransaction 回调内工作，即与适配器读取**同一个事务**；
  在该事务内读取 current_setting(transaction_read_only) = on，且同事务内再次尝试写入被拒
  （writeRejected=true，错误同为 PG 25006 / cannot execute DELETE in a read-only transaction）；
  同时 resolvedOk=true（公共入口解析成功，说明证据采自真实路径而非旁路）。

B5.（要求⑤）七张相关表前后状态（计数 + 关键记录摘要）
- dbProbeEvidence[]，kind=TABLE_SNAPSHOT：Organization / StandingAuthorization / AuditLog / RecoveryOpportunity /
  AutonomyTask / AutonomyLease / AutonomyIncident 的计数，加上 Organization.updatedAt 与
  授权行摘要（id:authorizationVersion:revocationState:scopeDigest）；before 与 after 完全一致（identical=true）。

═════════ 第三部分（C）：边界、诚实声明与未验证项 ═════════

C1. 本轮改动范围：仅三个 U1 文件（适配器 + 两个测试）+ 审计文档 + 证据包。
- 未新增 Scheduler / Controller / Runtime；未改 Prisma schema / migration；
- 未接入任务队列 / rsi-run / 任何执行体；未实现 U2–U5；
- 只读端口仍只使用 SELECT；唯一原生 SQL 仍是 SET TRANSACTION READ ONLY（源码级断言保留）。
C2. runtimeSourceIsolationImplemented 仍为 false（未推翻硬门）。
C3. 未验证项（如实标注，不主张已完成）：Linux / systemd 实机、真实浏览器端到端、
    真实 Provider / 模型调用（REAL_PROVIDER_WRITE 等一律 HOLD）、CI 流水线、生产环境与生产迁移。
C4. 外部写 / 自动合并 / 自动部署 / 生产就绪 一律保持禁止。

═════════ 请 求 裁 决 ═════════
1. CHANGE24_REQUIRED_SCOPE_TRUST_BOUNDARY（策略决定必需维度 + 可信来源 + 单授权错误范围负向测试）
2. CHANGE25_INDEPENDENT_EVIDENCE_PACKAGE（固定 HEAD 的 diff/输出/退出码/对应关系、逐项用例、独立事务探针与原始错误、公共入口证据、七张表状态）
3. U1_READ_ONLY_BOUNDARY_PRESERVED（只读边界是否仍成立、是否新增执行权限或外部副作用）
4. SCOPE_HONESTY（是否如实标注未验证项）
5. PHASE3_U1_IMPLEMENTATION_CLOSED（YES / NO）

并请以下述机器可读块收尾：
MSG-20261009-17 / FINAL
AUDIT_ID=MSG-20261009-17
REVIEWED_HEAD=612f687d
FINAL_VERDICT=PASS | PASS_WITH_REVISE | REVISE | BLOCK
CHANGE24_REQUIRED_SCOPE_TRUST_BOUNDARY=...
CHANGE25_INDEPENDENT_EVIDENCE_PACKAGE=...
U1_READ_ONLY_BOUNDARY_PRESERVED=...
SCOPE_HONESTY=...
PHASE3_U1_IMPLEMENTATION_CLOSED=YES | NO
PHASE3_A_U2_TO_U5_AUTHORIZED=YES | NO
REQUIRED_CHANGES=<下一轮必须执行的修订编号，无则 NONE>
NEXT_AUTHORIZED=<贵方确认授权的下一最小单元 / 范围>
NEXT_AUDIT=MSG-20261009-18
EXTERNAL_WRITE=HOLD
AUTO_MERGE=FORBIDDEN
AUTO_DEPLOY=FORBIDDEN
PRODUCTION_READY=NO

请在本会话直接回复（不要写入我的仓库或外部系统）。不要因为收到唤醒就默认通过；
若证据包字段不足或无法据此复核，请直接判 REVISE 并列出缺失项。
