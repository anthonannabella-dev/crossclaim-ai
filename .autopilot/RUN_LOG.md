# RUN LOG

- 2026-09-30: 采纳 AUTONOMOUS DEVELOPMENT LOOP；RuleSet ownership tests 完成（8626e56）；下一步 RuleVersion+RuleEvaluation 引用行为测试。

- TASK1 进行中（本地未绿，未提交该测试文件，避免红 CI）：已建 SYSTEM/A 夹具与 4 条断言；当前失败点=RuleVersion 插入 FK 23503（父 RuleSet 行未落库：唯一键冲突使 ON CONFLICT DO NOTHING 跳过）。下一步：beforeAll 改为先断言父行存在（SELECT 校验）并在缺失时显式失败，或改用 upsert/先删同名规则集；WIP 文件 work/stage/b2-reference-behavior-db.WIP.test.ts。

- TASK1 结果：4 条断言中 3 条通过（A→SYSTEM 允许、B→SYSTEM 允许、同租户 TENANT 引用允许）；夹具根因已修（RuleVersion 无 updatedAt 列 + 值列表多一个 now() → 42601/FK 皆已解决）。第 4 条（跨租户引用 TENANT RuleVersion 应被拒）失败：实际未被拒绝，疑似 RuleEvaluation.ruleVersionId 缺少租户一致性保护。下一步：psql 核查 RuleEvaluation 上是否挂了 cc_tenant 系列触发器/约束；若确缺 → 属租户隔离/Schema 变更，需架构方裁决（不得自行加约束）。

- 已向右侧 ChatGPT 会话直接发送 ARCHITECT_DECISION_REQUEST（RuleEvaluation→RuleVersion 跨租户引用；SEND_HEAD=b4b61eb），发送验证 sent=true/after_last_reply=true；STATE 标记 architect_decision_pending=true、blocked_scope=RuleEvaluation→RuleVersion tenant reference；pending 期间继续 D/E/F/G 中不依赖该裁决的部分。

- TASK1 收口（0023f51）：跨租户「未被拒绝」经运行库取证确认是**测试正则大小写误报**（实际消息为小写 `cross-tenant reference blocked` + SQLSTATE 23514），非保护缺口；按 MSG-20260930-09 TEST 清单补断言（UPDATE 拒绝 / 伪全局版本拒绝 / 缺失版本 FK 23503 / 失败后状态不变），7/7 通过。
- D/E/F/G 批次（c74d9bb）：CI 触发器断言改为**清单式**（28 baseline + 逐表 immutable + scoped + 反向清单）、新增 `tools/migration-checksum`（sha256 冻结 2acbd87a…）、新增 `tools/upgrade-verify/two-stage-upgrade.mjs`（本地 9 步全绿）、新增 `docs/releases/B2-FIX-R1-RECORD-CORRECTIONS.md`。
- 1144401：修正 ci.yml 步骤名中的非法 YAML 冒号（c74d9bb 的 CI run 因 workflow 解析失败而无作业，已用本地 yaml 解析器复核）。
- 右侧 ChatGPT 通道当前不可用（Codex auth token is unavailable）→ 每轮重试；MSG-20260930-09 归档与 RE-REVIEW 回帖待通道恢复。

- 通道恢复：`cua.getState()` 仍返回「Codex auth token is unavailable」，但 `agent.browsers.list()` / `browser.tabs.list()` 可用 → 直接用 Playwright 绑定应用内浏览器标签（该标签当时停在 chatgpt.com 首页，非审计会话）。已 `goto` 会话 `/c/6abc2d93-4448-83e8-a940-94889b355510`（标题「仓库审查裁决」）。
- 逐字归档 MSG-20260930-09：面板 DOM 导出 1737 字符（assistant 轮次），取 `[CHATGPT → CODEX]` 起至 `STATUS:` 末（裁掉前缀「选择 (a)：…」与 UI 文本），写入 `AI-ARCHITECT-INBOX.md`；`tools/verdict-diff/compare.mjs` = **FULL_COPY_OK（54/54 行，缺失 0 / 多出 0）**。提交 62dffa6。
- 已投递 `TYPE: RE-REVIEW`（4650 字符）到同一会话并回读验证（输入框清空 + 会话尾部出现 `你说：` 该消息）；ChatGPT 已开始回复（`回复已开始 / 我会只读核对 PR…`）。send_head=62dffa6，fingerprint=RE_REVIEW:B2-FIX-R1:R1:62dffa6。
- 注意：`.github/workflows/ci.yml` 曾因步骤名中出现未加引号的 `checklist: `（YAML 冒号）导致 workflow 解析失败（run 无作业）→ 已修并加本地 yaml 解析器复核。

- 归档完整性自检（本轮执行）：`AI-ARCHITECT-INBOX.md` 共 269 个 MSG 段落，编号无缺口（20260930-01…09 连续）。
  - C-0003：9 个段落（Checkpoint 1 R1–R4、Checkpoint 2 回报/R1/R2/R4、Gate 1 Final Review）全部带 ```text 逐字正文块 → 无缺口。
  - C-0002：R1 REVISE 已以「补录 MSG-20260928-01R」逐字落库；FINAL PASS / DECISION 由 MSG-20260928-04（yaml 代码块）、
    -05（原文逐字保留，标题已标注）、-07、-08 覆盖。归档中未见独立命名的「C-0002 Round 2 REVISE」段落；
    结合 CHANGE 编号（R1=#1–#12，ROUND 3 中 #13–#15 已成 PASS）看，第二轮内容已并入后续 PASS 记录。
    深挖需在虚拟滚动面板向上回溯到 2026-09-28（预估多次加载），暂记 **待核项**，不臆造补录。
  - 另有 50 个段落（均为 20260929-27…39 的旧格式条目）没有 ```text 围栏但正文仍在 → 属格式差异，非内容缺口。

- **B2-FIX R1 = PASS**（MSG-20260930-10，REVIEWED_HEAD 62dffa6 / CODE_HEAD 1144401 / FIX_PR #10）。已逐字归档并 `compare.mjs` = FULL_COPY_OK（52/52）。
- 架构方三项非阻塞文字修正已落地：docs/releases/B2-FIX-R1-RECORD-CORRECTIONS.md §8.4 结论限定 + 新增 §10（「影响一行」仅限合法正向用例；RuleSet 专项不含 RuleVersion 夹具故不主张版本归属；误报结论限定）。
- 架构方 NEXT：PR #10 的 base 是审查对比快照，合并它不会把修复交付到 main；须沿**正常面向 main 的 PR 路径**集成，核对实际 diff 并取得集成 HEAD 的 CI，不得强推或绕过保护。

- **宿主协议升级：双通道即时唤醒**（GitHub = 唯一正式审计总线/Source of Truth；右侧 ChatGPT Web = 仅短唤醒；每小时巡检降级为 watchdog）。落地记录见 docs/ai-bridge/DUAL-CHANNEL-WAKEUP-PROTOCOL.md。
- 面向 main 的集成 PR：**#11**（head `fix/b2-tenant-immutability-r1-to-main` = `e40d4f9`，base `main`），diff 只含 B2-FIX R1 修复本体（无 Gate 7 功能提交、无审计桥/自治 runner）。
  - 集成分支本地复核：prisma validate PASS、tsc PASS、b2 专项 17/17、两段升级 9 步全绿、MIGRATION_CHECKSUMS_OK。
  - 集成 HEAD CI：run 36651145264 → **5/5 SUCCESS**。
- 正式审计请求（GitHub comment）：id `5901785441` → https://github.com/anthonannabella-dev/crossclaim-ai/pull/11#issuecomment-5901785441（已回读验证，含 GATE/HEAD/CHANGE/Schema/tests/CI/evidence/requested decision）。
- 短唤醒（ChatGPT Web）：已发送并回读验证（输入框清空 + 会话尾部出现该 `你说：` 轮次）；未在 Web 重复全文。

- **MSG-20260930-11 = PASS + MERGE_DECISION: APPROVED**（REVIEWED_HEAD `e40d4f9` / PR #11）。全文 3692 字符已逐字归档：仓库 `AI-ARCHITECT-INBOX.md`（compare.mjs FULL_COPY_OK 85/85）与 GitHub PR #11 comment `5901910080`。
- 连接器阻塞留痕：ChatGPT 的 GitHub 写回需要「允许 ChatGPT 使用 GitHub 吗 / Add Comment To Issue」授权弹窗；该弹窗无法由 Codex 侧激活（Playwright 点击 / force / 坐标 / Enter 均无效，轮次结束后变静态）。架构方在回复中明确授权 Codex 原文归档，故本轮由 Codex 转录，未删减。
- 按裁决执行合并：PR #11（head `e40d4f9`，base `main@fc4e18f`）以 merge commit 合入，merge SHA `16b47a24bf692a333c1734e9ac5642371490d4bf`；未 force push、未绕过保护。
- 双账已分列（见 TASKS.md）：B2 工程修复 PASS / B2 集成 PASS / 已交付 main（main CI 5/5 SUCCESS（run on 16b47a2））。

- Action Guard CP2 送审：HEAD `123d21f`，CI run 36653496477（5/5）；审计请求落在 GitHub Issue #2 → comment `5902082182`（7 段式）。
- 短唤醒已发（不含全文）；右侧 ChatGPT 进入「读 Issue #2 + 123d21f diff + CI 原始证据」的复核阶段。
- 宿主动作已完成：右侧 GitHub 连接器授权（始终允许），权限弹窗消失，后续正式 VERDICT 可直接写回 GitHub。

- 通道诊断（2026-09-30）：ChatGPT 的 GitHub 连接器写回返回 **403 Resource not accessible by integration**（GitHub App 缺 Issues 写权限）。
  影响：若唤醒消息要求「直接写回 GitHub」，ChatGPT 会尝试写入、失败、并结束本轮而不产出裁决（h4=最新一条回复、无 assistant 文本）。
  规避（已生效）：唤醒改为「只在本会话输出完整 VERDICT，不要写入 GitHub」，由 Codex 原文归档到 Issue #2（架构方在 MSG-11/-12 均明确授权）。
  宿主项（非阻塞）：若要 ChatGPT 直写 GitHub，需在 GitHub 侧给该连接器授权 Issues: Write。

- 授权项 ③ 收口并送审：HEAD c70ae2e、CI run 36656201359（5/5）；审计请求 Issue #2 comment 5902419993（CI 更正 5902422241）。
  本轮新增真实依赖集成测试：真实 Kill Switch resolver + 真实 AuditLog 落地（actorType=AI、actorRef 满足 cc_audit_actor_shape_check），覆盖默认拒绝/APPLIED 开启后放行/未开启 scope 拒绝/配置异常回落 READ_ONLY/只读投影零审计；Action Guard 合计 68/68。
  环境自解：Docker Desktop 重启后拉起 crossclaim-postgres（127.0.0.1:55432），本地 DB 测试恢复可用。

## 2026-09-30 · 授权项② 第一批 R3（MSG-20260930-19 REVISE，CHANGE A–D）

- CHANGE A（前序提交 `9065f2f`）：锁后重读服务端时间核验有效期；事务内重验审批人与执行人的用户状态/成员/角色；两套校验器拒绝缺失或未知 fingerprintVersion；原因码统一 APPROVAL_SOURCE_ERROR / APPROVAL_VERSION_UNSUPPORTED。
- CHANGE B（本轮）：`recovery-outcome.ts` 删除事务外的 existingSettlement 早返回；案件 advisory lock **无条件**获取；既有资金链核查移入「锁内 + 完整重验之后」并按**案件**执行（缺 Ledger/Fee/Billing → 409 ILLEGAL_TRANSITION，不返回空 ID）；合法幂等返回必须核对同 `approvalId` 消费事件 + 同 `operationId` + 同规范化载荷（金额/币种/Settlement 金额）；高额确认缺 `approvalId` 直接拒绝 REVIEW_REQUIRED（旧案件状态不是操作级授权替代）；缺 `approvalId` 的兼容路径经证明在受保护 HTTP 入口不可达（守卫先 409 REQUIRE_APPROVAL），入口隔离测试见 C。
- CHANGE B（串行化）：`assertHighValueReviewCleared` 自动写 `review_required` 与显式 REQUEST/APPROVE/REJECT、资金执行共用同一案件锁。
- CHANGE C（本轮新增 `action-guard-hitl-r3-race-db.test.ts`，真实 HTTP + PostgreSQL，9 例）：持有案件 advisory lock 制造真实控制点 —— 等锁期间撤销 → 403 APPROVAL_REVOKED；等锁期间审批过期 → 403 APPROVAL_EXPIRED（证明锁后重读时间生效）；等锁期间成员停用 → 403 APPROVAL_ACTOR_MISMATCH；同案件不同审批并发 → 全案仅一条完整链；既有资金链缺项 → 409 ILLEGAL_TRANSITION；指纹版本异常 → 403 APPROVAL_VERSION_UNSUPPORTED；受保护入口缺 approvalId → 4xx 且零资金；审计端口写入失败 → 放行降级为拒绝且真实库零资金。所有用例精确断言状态码、reason、对象关联与消费计数。
- CHANGE D（本轮）：成功审计 `recovery_outcome.confirmed` 增加 `approvalId`/`operationId`/`result=CONFIRMED` 并保持 `entityId=Settlement.id`（可关联具体 Settlement）；新增最终拒绝审计 `recovery.outcome_rejected`（stage ENTRY_GATE / LOCKED_RECHECK、reason、执行主体记入 changes、result=REJECTED），事务已回滚故用独立连接写入；拒绝路径审计写入失败**不覆盖**原始错误（`guard-enforcement.ts` 同步修正）。
- 既有套件口径同步（R3 生效后的真实合同）：`workflow-hitl-db` 的「复核通过后可确认」改为必须携带操作级 `approvalId`；`action-guard-hitl-concurrency-db` 04 由「撤销后幂等 200」改为「最终拒绝 APPROVAL_REVOKED」。
- 文档同步：`docs/releases/ACTION-APPROVAL-BINDING-CONTRACT.md` 全量改写为 R3 口径（实际审计事件名 `action_guard.approval_decision` / `recovery.outcome_rejected`、原因码、锁顺序、幂等链完整性、兼容路径收口、验收矩阵）。
- 本地验证：`npx tsc --noEmit` PASS；定向 6 套 DB 套件（outcome / hitl / concurrency / http-chain / payment / r3-race）全绿；全量 `npx vitest run` = 139 文件 / 1240 passed + 20 skipped，唯一失败为既知技术债 `phase1-runbook.test.ts`（Node 24 导入不兼容，Node 22 CI 通过），非本批次引入。

- R3 送审（REVIEWED_REF `cb95143`）：CI run `36668581862` = 5/5 SUCCESS（API / Deploy smoke / Web / 许可证闸门 / Backup restore）。
- 正式审计请求（GitHub Issue #2）：comment `5904049895` → https://github.com/anthonannabella-dev/crossclaim-ai/issues/2#issuecomment-5904049895（七段式：GATE/HEAD/FILES/TESTS/CI/BOUNDARY/自我披露/REQUESTED DECISION）。
- 中间一次红 CI 已如实登记：`9065f2f` 的 Deploy smoke 在 `S-1 migrate deploy (fresh database)` 瞬时失败；相邻提交与当前 HEAD 同一步骤成功，本机 `node tools/smoke/deploy-smoke.mjs` 全项通过（20 migrations / 64 triggers / health 200 / readyz 200），判定为 Docker 就绪竞态，不作为通过证据。
- 通道①（右侧 ChatGPT 会话）本轮不可用：computer-use 返回 `Browsers: Error: Codex auth token is unavailable`（apps/browsers 均为空），js_reset 后重试仍失败。属环境级故障，按 SELF_RESOLVE 处理：正式请求已按通道②落在 Issue #2；短唤醒待通道恢复后补发（每次心跳重试），期间不重复写 Issue，不改动已送审的 HEAD。

- R3 证据说明（补充，请求内容不变）：Issue #2 comment 5904097956。说明控制点构造方式（独立连接持案件 advisory lock + pg_try 探测确认持有 + 断言请求在 400ms 内未返回），并如实披露：等待期间的撤销/成员停用为**直接写库**（因撤销入口与资金执行共用案件锁，走 HTTP 会排在资金请求之后，无法构成核验后/执行前的场景）；同时声明未覆盖「HTTP 撤销与 HTTP 确认同时在途」的跨连接竞态。受审 HEAD 仍为 cb95143。


- 预备补丁（未提交，保持受审 HEAD 不变）：work/scripts/r3patch-review-lock-state.mjs 把 ssertHighValueReviewCleared 的**状态判定**也从锁外移入案件锁内（锁内 loadEvents + loadReviewState），消除「刚写入的审批被随后自动写入的 review_required 取代」的轮询竞态。已在工作区临时应用验证：	sc --noEmit PASS、workflow-hitl-db+workflow-recovery-review+ction-guard-hitl-r3-race-db 共 26 例全绿；随后从备份还原，工作区不含该改动（待裁决到达后随下一批次提交并说明）。


- 通道③兜底（事件驱动）：Issue #2 comment 5904165716 以 [CODEX -> CHATGPT] TYPE: READY_FOR_REVIEW 标记提交，触发 .github/workflows/audit-bridge.yml（无审计模型凭据时为 NOT_RUN，只做 HEAD=cb95143 的 CI 对齐与结构化留痕）。
- 通道①续报：computer-use 浏览器提供方持续不可用（Browsers: Error: Codex auth token is unavailable，apps/browsers 清单为空）。已尝试：重试 getState、js_reset 后重试、open_in_codex 重新打开面板浏览器标签 → 均无效。判定为宿主应用级（非标签级）故障，列入 HOST_ACTION_REQUIRED 上报；正式请求不受影响（已在 Issue #2 留档 5904049895 + 证据说明 5904097956）。


- 通道③更正（如实登记）：Issue #2 comment 5904187973。核对 main 与 gate 分支的 .github/workflows 后确认：udit-bridge.yml **只在 gate 分支**，不在默认分支 main；GitHub 的 issue_comment 事件取默认分支的工作流定义，故 comment 5904165716 的 READY_FOR_REVIEW 标记**没有触发任何工作流**（近期 Actions 运行列表亦无 audit-bridge run）。结论：通道③在 workflow 合入 main 前不可用，属合并决策，不由 Codex 绕过分支保护。当前唯一可用的留档通道是 Issue #2 本体；架构方唤醒仍待通道①恢复。


- 资金路径锁外判定小审计（只读，为下一批次做准备）：`advanceBillingInvoice` 的状态校验虽在事务外，但写入使用**事务内 CAS**（`updateMany` 带 `status=from` 条件，`count!==1` 即 ILLEGAL_TRANSITION），无 TOCTOU；`submitRecoveryReview` 的状态判定已在案件锁内；当前唯一「锁外判定」点是 `assertHighValueReviewCleared`（预备补丁 `work/scripts/r3patch-review-lock-state.mjs` 已就绪并验证）。结论：资金路径其余入口的并发不变量均已有明确保护，本批次不必扩大改动面。

- CI 原始证据核对（run 36668581862 / job `API · migration + typecheck + tests` id 109738489655，HEAD cb95143）：
  - `✓ src/__tests__/action-guard-hitl-r3-race-db.test.ts (9 tests) 5579ms` —— 新增的 R3 控制点竞争套件**确实在 CI 中执行**（不只是本机）。
  - `Test Files 139 passed (139)` / `Tests 1260 passed (1260)` —— Node 22 CI 全绿、零 skipped；本机 Node 24 的 `phase1-runbook.test.ts` 导入问题不出现于 CI。

- 通道①恢复并送达 R3 短唤醒（宿主协助打开新建 ChatGPT 窗口后，computer-use 浏览器恢复可用）：在会话 `仓库审查裁决`（chatgpt.com/c/6abc2d93-4448-83e8-a940-94889b355510）发送 `[CODEX → CHATGPT]` 唤醒包，指向 Issue #2 comment 5904049895（R3 七段式）+ 5904097956（证据说明），并将提交后输入框清空、正文出现该轮次且 ChatGPT 进入「正在回应」状态作为送达验证。
- 说明：唤醒包内已注明「GitHub 写回仍受 403 限制，请只在本会话输出完整 VERDICT，由 Codex 原文归档」；受审 HEAD 保持 `cb95143`。

## 2026-09-30 · MSG-20260930-20 = REVISE（授权项② 第一批 R3 复核）→ R4

- 通道①短唤醒已送达并取得裁决：MSG-20260930-20（REVIEWED_REF `cb951432a9e5411e2a40bfaf7c77cb790ef3546e`）= **REVISE**，下一批次 = 授权项② 第一批 **R4**。
- 归档：`AI-ARCHITECT-INBOX.md` 逐字原文（```text 块），`node tools/verdict-diff/compare.mjs` → **FULL_COPY_OK**（原文 72 行 / 归档 72 行，缺失 0、多出 0）。
- 裁决要点（逐条将执行）：**A/D 关闭**，无需重做；**B 留一项阻塞**：`assertHighValueReviewCleared` 仍是「事务外判定 state → 锁内写入 review_required」，可被并发 APPROVE 交错取代；**C 接受限定范围证据**（但要求收紧口径）。
- R4 CHANGE：A 自动路径锁内重读并决定；B 生命周期事件时间至少锁后生成 + 明确同时间/轮次顺序（事务内外同规则）；C 两项有控制点验收（自动路径读到旧状态后暂停 → APPROVE → 恢复不得追加取代性 REQUEST；请求先启动后获锁 / 事件同时间）；D 修正证据口径（删过度声明、缺 approvalId 测试收紧为精确状态码+错误码、竞争证据补强）。
- 架构方明确：**允许立即提交已准备的相关补丁**；受审 HEAD 冻结仅为定位证据，不要求裁决后继续冻结开发。
- 已就绪补丁：`work/scripts/r3patch-review-lock-state.mjs`（`assertHighValueReviewCleared` 的 loadEvents/state 判定移入案件锁内），本地已验证 `tsc --noEmit` PASS + 26 例全绿。

## 2026-09-30 · 授权项② 第一批 R4（MSG-20260930-20 的 CHANGE A–D 收口）

- 实现：`840bf09`（CHANGE A+B：自动路径状态判定移入案件锁内；`nextLifecycleAt` 生命周期事件时间锁内生成且同案件严格递增）、`a545bc0`（CHANGE C+D：新增 `action-guard-hitl-r4-ordering-db.test.ts` 3 例；R3 缺 approvalId 断言收紧为精确 409+错误码；契约新增 §4.2）。
- 验证：`npx tsc --noEmit` PASS；定向 R4 3/3、R3 9/9、`workflow-hitl-db` 5/5、`workflow-recovery-review` 12/12、`action-guard-hitl-http-chain-db` 6/6、`action-guard-hitl-approval-verifier-db` 13/13 全绿；CI run `36671238244`（HEAD `a545bc0`）五作业 SUCCESS。
- 送审：Issue #2 comment `5904438093`（七段式，含自我披露：用例 01 因受保护入口缺 approvalId 在守卫层即 409，改为服务层直调 + 等待期间直写等价事件；`nextLifecycleAt` 复用锁内已读事件以避免在单测 fake 客户端引入新依赖）。
- 通道①：本轮 computer-use 浏览器提供方再次不可用（`Codex auth token unavailable`），R4 短唤醒待通道恢复后补发；正式请求已留档 Issue #2，架构方也可直接在 Issue 上复核。

## 2026-09-30 · 通道①根因诊断 + 技能沉淀（宿主指派）

- R4 短唤醒已送达（通道①恢复后）：会话 `仓库审查裁决` 输入框清空 + 正文出现 `Checkpoint R4` + 进入生成态；指向 Issue #2 comment `5904438093`（请求）与 `5904626397`（证据补充）。
- 根因定位（可复现的判别法）：故障时 `cua.listBrowsers()` **仍成功**（返回 in-app browser + 扩展浏览器），但 `cua.listTabs()` / `cua.getTab()` / `cua.getState()` 抛 `Codex auth token is unavailable`。即**浏览器发现可用、会话级标签自动化不可用**；该 token 与 `metadata.codexSessionId` 绑定（每个 Codex 会话铸造）。
- 已证伪的处置：`js_reset`（内核重置）无效；`open_in_codex` 重新打开面板标签无效；不是页面/标签/登录问题。恢复与「宿主在右侧打开/聚焦 ChatGPT 窗口」同步发生（本次与 04:44Z 各一次）。
- 沉淀技能：`C:\Users\os\.codex\skills\chatgpt-web-audit-bridge`（`SKILL.md` + `references/channel-failures.md` + `references/verdict-capture.md` + `agents/openai.yaml`），`quick_validate.py` → Skill is valid。内容含：落地记录优先、唤醒三步验证、DOM 提取裁决、逐字归档+校验、以及「发现可用/标签不可用」判别表与重试/上报节奏。

## 2026-09-30 · MSG-20260930-21 = PASS（授权项② 第一批 R4）→ 第二批 payment.capture

- 裁决：**PASS**（REVIEWED_REF `a545bc04...`；CI run 36671238244 = 5/5，API 140 files / 1263 tests PASS；R4 顺序套件 3/3、R3 竞争套件 9/9）。A/B/C/D 全部关闭；「recovery-outcome 第一批工程 Checkpoint」获准标记完成；② 整体仍 NOT COMPLETE。
- 归档：`AI-ARCHITECT-INBOX.md`（```text 逐字），`compare.mjs` → 见本轮输出。
- 下一 Checkpoint（架构方指定）：**授权项② 第二批 —— `payment.capture` 真实服务端入口接入**；要求先在七段式中盘点现有资金执行入口与调用链、明确实际接入范围，并按本批次已形成的五项要求验证；不得接入真实支付凭据/真实扣款/生产资金能力。
- 非阻塞整理项（随下一批次做，不另开 R5）：契约标题与依据链更新至 R4、章节 4.1/4.2 排序、区分「事务内外一致」与「测试分别执行」、新增生命周期写入路径登记进写入清单。

## 2026-09-30 · MSG-20260930-22 = REVISE（授权项② 第二批 R5）→ 账单入口 R6

- 裁决：**REVISE**（REVIEWED_REF `6da1dc8b…`；CI run 36676703772 = 5/5，API 141 files / 1269 tests PASS，账单入口 6/6）。认可账单入口接线、目标解析、事件族、锁后时间与主体核验、发票锁、CAS、消费与状态同事务；**范围选择（先账单入口）获认可**。
- 阻塞项（R6 必须关闭）：**A** 审批载荷未与「实际执行的账单事实」核对（批准金额/币种未与锁内 `invoice.total/currency` 比对，也未绑定 from/to 迁移）；**B** wrapper 的 superseded 查询仍硬编码 Case/recovery REQUEST，且 revoked 事件族与事务内不一致；**C** 缺支付入口专项验收（HTTP 全链路/并发/等锁失效/审计失败零副作用/最终拒绝关联），若没有支付审批 HTTP 创建入口须披露或改名；**D** `billing.status_changed` 未带 approvalId/operationId、锁内拒绝无最终拒绝记录、测试顶部注释过时。
- 语义裁决：接受「状态迁移重复请求 409 + 零新增副作用 + 消费仍 1」，不强制改 200；但每次请求必须重新经过授权判断，且不得宣称支付渠道幂等已完成。
- 三项设计裁决（授权实施）：replay = 逐 PaymentEvent 审批（绑定关联发票/事件身份/金额币种/预期恢复动作/处理版本/载荷摘要，禁绑原始 JSON）；retry-due = **冻结清单批次审批**（服务端 batchId、排序清单指纹、有效期与数量上限、执行前逐项重验、不得动态扩展、后台 SYSTEM 身份与预先授权）；webhook = 保持验签/重放保护/幂等/匹配边界，**接收已发生付款事实 与 发起新扣款必须分开**，验签不等于授权扣款。

## 2026-09-30 — MSG-20260930-23 = REVISE（授权项② 第二批 R6）→ 账单入口 R7

- 裁决：**REVISE**；REVIEWED_REF `61699770cde7e8f9481bd9c996401e53dc7a86a1`；CI run 36679787343 = 5/5；API 141 files / 1273 tests PASS，支付专项 10/10 PASS。**已关闭**：支付审批 HTTP 创建入口 + server 白名单、`invoiceId/from/to` 绑定与创建期拒非 PAID、wrapper superseded/revoked 支付事件族、成功/消费审计关联、同审批四路并发恰一次。
- 剩余阻塞：`billing.ts` 锁内 `fresh` 只用于核验，**写入仍取自锁外旧快照** —— CAS 用 `status: from`、金额写 `paidAmount: invoice.total`、成功与消费审计用 `money(invoice.total)`/`invoice.currency`、`paidAt` 与审计时间用锁前 `at`；交错示例：锁外读 1500 → 等待期间变 1600 → 审批绑定 1600 → 锁内 fresh=1600 核验通过，但实际写 1500。另：等锁期间过期/撤销/主体失效与审批审计端口失败专项验证尚未出现在新增 10 项中。
- CHANGE A（`billing.ts`）：锁后读取**完整执行快照**，迁移判断、CAS、金额写入、成功审计、消费记录全部用该快照；批准金额/币种/from→to 必须与快照一致；执行时间锁后生成并统一用于 `paidAt`/消费/成功审计；明确实际采用的防绕过机制（行锁/事实CAS/统一锁协议）；清除受保护路径对锁外 `invoice.total/currency/from/at` 的引用。
- CHANGE B：快照交错测试（明确控制点，不能只靠固定等待）——绑定旧事实→拒绝；绑定锁内新事实→若允许执行，`paidAmount` 与成功/消费审计必须全用新事实。CHANGE C：等锁期间过期/撤销/主体失效 + 审批审计端口失败专项，精确断言 reason、账单状态/金额/引用无非法变化、消费无新增，并发拒绝可因阶段不同但需状态码↔原因对应并证明「一次迁移、一次消费」。CHANGE D：真实落库断言批准金额 = 实际 `paidAmount` = 成功审计金额 = 消费金额/币种一致。
- 语义：继续接受重复确认 409 ILLEGAL_TRANSITION + 零副作用 + 消费仍 1；**签发（DRAFT→ISSUED）需独立授权边界，不得复用 payment.capture 审批**，不得把当前 status 路由描述为已接入签发能力。后续顺序：R7 通过 → replay → 冻结批次 retry-due；MSG-20260930-22 对 replay/retry-due/webhook 的设计裁决继续有效；生产与真实资金继续 HOLD。

## 2026-09-30 — ② 第二批 R7 实施与送审（MSG-20260930-23 的 CHANGE A–D 收口）

- 留档：MSG-20260930-23 逐字归档进 AI-ARCHITECT-INBOX.md（compare.mjs = FULL_COPY_OK，58/58 行，0 缺失 / 0 多出）+ Issue #2 comment 5905995528；commit 5584df8（已 push）。
- 实现 commit 73115a3：billing.ts 统一**锁内执行快照**（迁移判断 / CAS / paidAmount / paidAt / 成功审计 / 消费审计全部取自锁后快照；执行时间锁内生成；锁外读取降级为预检查，只剩 id/status）；CAS 在状态之外同时比较 total + currency（事实 CAS），与统一发票 advisory lock 共同构成防绕过机制；明确拒绝「锁内比较通过、却写入另一份旧快照」。
- 验收：支付入口专项 **16/16**（新增 11 快照交错·审批绑定旧事实→403 + 锁内拒绝审计；12 快照交错·审批绑定锁内新事实→paidAmount/成功审计/消费审计全为 1600 USD；13a/13b/13c 等锁期间过期·撤销·主体停用→精确 403 且零副作用；14 审批审计写入失败→fail-closed）。控制点 = pg_locks 中该发票 advisory lock 的**未授予行**（按 hashtext 匹配发票键），非固定等待。
- 定向回归 14 套件 **85/85**；本机全量 141 文件 / **1259 passed + 20 skipped**，唯一失败为**既知** phase1-runbook.test.ts（Node 24 导入兼容，非阻塞技术债）——不以「全量通过」表述；npx prisma validate = valid，npx tsc --noEmit = PASS。
- CI：HEAD 73115a3，run **36682995038** = 五作业 SUCCESS；API 作业 **141 files / 1279 tests PASS**。
- 送审：Issue #2 comment **5906316560**（七段式）；右侧会话短唤醒已发送并完成送达验证（正文 512 字符作为新用户轮出现、输入框已清空、生成中）。
- 如实披露：用例 11 在旧实现下同样会拒绝，判别旧/新实现的是**用例 12**；控制点中的直写账单事实只证明「锁内重验读取到已提交的新事实」，不代表生产入口之间的完整竞争协议。签发边界未实现，不得描述为已接入。

## 2026-09-30 — MSG-20260930-24 = PASS（授权项② 第二批 R7）→ 下一批次 replay

- 裁决：**PASS**（限定本批次账单登记入口的工程验收）；REVIEWED_REF `73115a3081026029f7fee284dc90f444e3c439f2`；CI run 36682995038 五作业 SUCCESS（API 141 files / 1279 tests PASS，支付专项 16/16）；Prisma validate 与 TypeScript 检查通过。授权项②整体仍 **NOT COMPLETE**，全部生产 HOLD 状态不变。
- CHANGE A（锁内执行快照 + 事实 CAS）**关闭**：锁外仅读 `id/status` 预检查；锁内读完整快照并用于迁移判断、批准金额/币种核对、`extra.from→to`、`paidAmount`、成功与消费审计；`executionAt` 锁后生成，统一用于有效期核验/`paidAt`/`issuedAt`/两类审计；CAS 同时比较租户、目标、状态、`total`、`currency`。认可 `submitPaymentReview` 与账单执行遵循同一发票锁协议。
- CHANGE B（两项快照交错验收）**关闭**：控制点（`pg_locks` 未授予记录）获认可；用例 11 拒绝且无登记/无消费 + 锁内拒绝审计；**用例 12 为判别旧快照写入缺陷的关键回归证据**；架构方接受我方对用例 11 证明力的主动纠正。
- CHANGE C（等锁失效/并发/审计失败）**关闭**：`APPROVAL_EXPIRED` / `APPROVAL_REVOKED` / `APPROVAL_ACTOR_MISMATCH` 三项断言账单保持 ISSUED、`paidAmount` 为零、引用未新增、消费为零；数据库 CHECK 拒绝 `action_guard.approval_decision` 时 HTTP 失败且业务零副作用、成功迁移审计为零；四路同审批并发仍为恰一次迁移 + 一次消费；重复确认 409 `ILLEGAL_TRANSITION` 语义维持。
- CHANGE D（真实落库/审计关联/CI 口径）**关闭**：用例 12 核对批准金额 = 实际登记金额 = 成功审计金额 = 消费金额/币种，保留 `approvalId`/`operationId`/`invoiceId` 关联；契约 §5.3 与测试注释同步；本机 runbook 失败与跳过项不得写成「本机全量通过」，通过依据为最终 CI。
- 非阻塞项与限定：Node 24 runbook 兼容继续登记；控制点直写只证明锁内能读取已提交的新事实；事实 CAS 不等于强制所有写入者遵守 advisory lock，后续写入者必须遵守既定协议。**必须后置**：DRAFT→ISSUED 独立签发授权边界、真实支付渠道扣款与生产资金能力、replay / retry-due / 其他未接入入口、授权项②整体完成与生产启用裁决。
- 下一步（已 ACK 顺序）：**replay** 必须逐 `PaymentEvent` 绑定审批，覆盖关联发票、事件身份、金额/币种、预期恢复动作、处理版本及载荷摘要，执行前重新核验主体/事实/生命周期/幂等；随后 **retry-due** 使用服务端冻结批次（排序清单指纹 + 有效期 + 数量上限，不得动态纳入新 due 项，后台 SYSTEM 需明确预授权范围）；webhook 保持「接收事实 ≠ 授权新扣款」。
- 留档：逐字归档进 AI-ARCHITECT-INBOX.md（compare.mjs = FULL_COPY_OK，62/62 行）+ Issue #2 comment **5906424099**。

## 2026-09-30 — ② 第二批 R8（replay）实施与送审

- 实施 commit 顺序：`deb8585`（动作身份 payment.replay + PaymentEvent 目标族 + 服务端指纹 + 最小受认证审批入口 + 单一事件锁内事务执行 + 既有用例迁移）→ `3448238`（replay 专项验收 9 例）→ `96eedc6`（契约 §5.4 与验收矩阵同步）。
- 关键实现：`payment.replay` 为**独立资金动作身份**（MONEY_MOVEMENT + humanApproval + productionGate），与 `payment.capture` 互不通用；审批目标 = 具体 `PaymentEvent`；指纹 = 关联发票/事件身份（provider:providerEventId）/金额币种/载荷摘要（payloadHash）/预期恢复动作/处理版本，由**服务端**组装（不绑定可替换的原始 JSON）；执行在**单一事件 advisory lock 事务**内完成（锁内执行快照 → 锁内指纹重验 → attempt → 资金写入（applyPaymentSucceeded 复用调用方事务）→ 消费 `payment.replay_consumed`）；锁内拒绝写 `payment.replay_rejected`；缺审批 HTTP 409、服务层直调亦拒绝（无 bypass）。
- 验收：replay 专项 **9/9**（真实 HTTP + PostgreSQL，含等锁期间事实变化/过期/撤销/主体停用、跨域冒用双向拒绝、同审批并发恰一次、锁内拒绝审计）；既有套件迁移后 payment-attempt 6/6、payment-admin-http 6/6；定向回归 11 文件 78 例全绿。
- 本机全量：142 文件 / **1268 passed + 20 skipped**，唯一失败为既知 `phase1-runbook.test.ts`（Node 24 导入兼容，非阻塞技术债）——不以「全量通过」表述。`tsc --noEmit` PASS。
- CI：HEAD `96eedc6`，run **36686652727** = 五作业 SUCCESS；API **142 files / 1288 tests PASS**。
- 送审：Issue #2 comment **5906863811**（七段式）；右侧会话短唤醒已发送并完成送达验证（573 字符作为新用户轮出现、输入框清空、生成中）。
- 如实披露：用例 03 的拒绝来自**提交侧**比对（不产生服务层锁内拒绝审计），锁内拒绝审计由用例 04 证明；控制点中的直写事实仅证明执行阶段读取已提交的新事实。retry-due 仍未接入守卫（下一批次，按冻结清单批次审批设计）；webhook 边界与生产 HOLD 不变。

## 2026-09-30 — MSG-20260930-25 = REVISE（② 第二批 R8 / replay）

- 裁决：**REVISE**；REVIEWED_REF `96eedc6f2eeb473c0494062a9c9bc3b330c6f9b0`；CI run 36686652727 五作业 SUCCESS（API 142 files / 1288 tests PASS，replay 专项 9/9）。已确认完成项保留：独立动作身份、`PaymentEvent` 目标、服务端指纹、受认证审批入口、服务层缺审批拒绝、单事务、同审批并发恰一次、等事件锁期间过期/撤销/停用与 Payment 金额变化拒绝。
- **阻塞发现**：事件锁不能替代**发票事实保护** —— `applyPaymentSucceeded` 读取发票后仅以状态 CAS（`status: ISSUED`）推进 PAID，未取得 R7 的 `cc-payment-invoice:<invoiceId>`，也未比较 `total`/`currency`；可行交错：replay 读到 ISSUED/900 通过后，另一事务把发票改为 950 或改币种，状态 CAS 仍命中并写入 `paidAmount=900` + 消费审批。
- CHANGE A：在 payment-attempt/payment 明确并实现事件、Payment、发票的锁定/事实校验协议（与 R7 发票锁兼容、明确多锁取得顺序避免反向获取、锁后重读最终发票事实、PAID CAS 至少加 `total`/`currency` 事实、明确 Payment 行保护方式、审批重验时间在必要锁取得后生成、attempt+资金+成功审计+消费同事务不回退）。
- CHANGE B：补可判别的跨对象竞争验收（显式控制点证明到达发票核验→更新阶段；金额/币种变化或锁竞争只能被串行化或被重读/事实 CAS 拒绝；不得出现新发票事实与旧 `paidAmount`/旧成功审计同时提交；等待发票锁时至少验证"等待期间审批过期在最后重验被拒"；成功时核对 Payment/发票/审计/消费金额币种一致）。
- CHANGE C：跨域双向冒用（replay 审批用于账单确认反向也要测，精确状态码/原因且两类消费均不新增）、服务层直调缺 approvalId 显式验收、replay 审批决策审计失败放行前关闭、**replay 消费审计失败 → 整个事务回滚**（attempt/发票推进/成功审计不得部分提交）。
- CHANGE D：用例 03 标注为**提交侧**拒绝（删除"锁内快照拒绝"表述）；双向冒用需两方向均执行才算完成；说明 `attempt.status=SUCCEEDED` 与 `resultStatus` 的区别（AMOUNT_MISMATCH/PENDING_REVIEW/ILLEGAL_TRANSITION 也会消费审批并记录 SUCCEEDED attempt → 表示"一次获批恢复尝试已执行"，不是"付款收口成功"）；保留"直写仅证明读取已提交变化"的限制。
- 口径：retry-due 仍直接调用 `runDueRetries`（未接守卫/批次审批）申报准确，本轮不得宣称支付域所有恢复入口已受保护；真实渠道扣款与生产继续 HOLD。下一 Checkpoint = replay R8 修订批次（完成后重跑类型检查、真实 PostgreSQL/HTTP 专项、相关支付回归与最终 HEAD CI，再提交七段式）。

## 2026-09-30 — ② 第二批 R8 修订（R9 送审）

- 实现：`7350ad2`（CHANGE A：事件锁→发票锁固定顺序、锁后重读 status/total/currency、PAID CAS 加事实条件、重验时间在锁后、同事务不回退）、`dc141b5`（CHANGE B/C/D：replay 专项 9→15 例 + 契约 §5.4/矩阵）、`3cd0615`（单测夹具同步锁内快照与事实 CAS 断言）。
- 验收：replay 专项 **15/15**（含等发票锁期间事实变化→AMOUNT_MISMATCH 且绝不写旧 paidAmount；事实 CAS 交错零部分提交；反向冒用精确 403 且两类消费不新增；服务层缺审批零副作用；审批决策审计失败放行前关闭；消费审计失败整事务回滚）；定向回归 11 套件 94 例全绿；本机全量 142 文件 / 1274 passed + 20 skipped（唯一失败为既知 runbook 债，不写"全量通过"）；tsc PASS。
- CI：HEAD `3cd0615`，run **36689383793** = 五作业 SUCCESS；API **142 files / 1294 tests PASS**。如实披露中间 commit `dc141b5` CI 为红（单测夹具未同步），已修复、不作为通过证据。
- 送审：Issue #2 comment **5907298588**（七段式）；右侧会话短唤醒已发送并完成送达验证（704 字符作为新用户轮出现、输入框清空、生成中）。

## 2026-09-30 — ② 第二批 replay R9 修订（R10 送审）

- 架构裁决 MSG-20260930-26 = REVISE（REVIEWED_REF 3cd0615）：已关闭项保留（发票锁/发票事实 CAS/双向冒用/缺审批/两类审计故障/口径），剩余两项 = ① Payment 执行快照在等发票锁前读取、等待后未重读/未保护；② 缺"等待**发票锁**期间审批过期"专项。已逐字归档（compare.mjs = FULL_COPY_OK）+ Issue #2 comment `5907496573`。
- 实现 `9ae6ca2`：定位快照只用于定位；锁顺序固定为**事件锁 → 发票锁 → Payment 行锁**（`SELECT ... FOR UPDATE`）；锁后重读最终快照作为审批核验/资金参数/成功审计/消费的唯一依据；`invoiceId`/`externalPaymentId`/`payloadHash`/`providerEventId` 任一变化即 403 拒绝；重验时间在全部必要锁之后生成。
- 验收：replay 专项 **17/17**（新增 16 等发票锁期间 Payment 变化→403 零新增；17 等发票锁期间审批过期→403 APPROVAL_EXPIRED；用例 01 补真实落库一致性断言 Payment/发票 paidAmount/成功审计/消费 同额同币种）；本机全量 142 文件 / 1276 passed + 20 skipped（唯一失败为既知 runbook 债，不写"全量通过"）；tsc PASS。
- CI：HEAD `9ae6ca2`，run **36690601646** = 五作业 SUCCESS；API **142 files / 1296 tests PASS**。
- 送审：Issue #2 comment **5907528281**（七段式）；右侧会话短唤醒已发送并完成送达验证（677 字符作为新用户轮出现、输入框清空、生成中）。

## 2026-09-30 — MSG-20260930-27 = REVISE（replay R10：行锁身份校验缺口）

- 已关闭项保留：定位快照与最终执行快照分离、事件锁→发票锁→Payment 行锁后重读最终事实、关键关联不一致即拒绝、重验时间在行锁之后、用例 16/17、用例 01 落库一致性、事实 CAS 口径收紧。
- 唯一剩余阻塞：`FOR UPDATE` 查询未确认锁到关联 Payment 本身 —— 查询用事件 `provider` + `externalPaymentId`，未返回/核对 `Payment.id`、`Payment.provider`，也未确认恰一行；可行交错：定位后等发票锁期间改写 Payment.provider，锁查询零行而最终快照仍用事件 provider，可能创建另一条资金记录。
- CHANGE：快照显式携带 `Payment.id`/`Payment.provider`；校验 Payment.provider 与事件 provider 一致（不一致失败关闭）；按租户 + `Payment.id` 加行锁并确认恰一行且 id 正确；最终重读确认执行所用的正是被锁定行；保持锁顺序/时间位置/同事务；可将 paymentId 纳入服务端绑定。补真实 PostgreSQL 验收：等发票锁期间改 Payment.provider（或构造事件与 Payment.provider 不一致）→ 精确拒绝且无新增 Payment/attempt/PAID/成功审计/消费；锁查询零行 → 失败关闭。
- 口径纠正：**PostgreSQL 行锁同样阻塞其他事务对同一行的普通 UPDATE/DELETE**，不只是"协议内写入者"；锁前已提交变化由最终重读处理，锁持有期间的修改由数据库锁串行化。

## 2026-09-30 — ② 第二批 replay R10 修订（R11 送审）

- MSG-20260930-27 = REVISE（唯一剩余：行锁未确认锁定关联 Payment 本身）已逐字归档（FULL_COPY_OK 66/66）+ Issue #2 comment `5907579437`。
- 实现 `08fc45d`：快照显式携带 `Payment.id`/`Payment.provider` 并纳入服务端审批指纹；事件 provider 与 Payment.provider 不一致 → 失败关闭；行锁改为按租户 + **Payment.id** 且断言恰一行/id 一致；最终重读新增比对 `paymentId`/`paymentProvider`，确保定位、锁定、最终快照与执行是同一条 Payment。
- 验收：replay 专项 **19/19**（新增 18 等发票锁期间 provider 改写→403 零新增；19 行锁零行→失败关闭）；支付定向回归 7 套件 71 例全绿；本机全量 142 文件 / 1278 passed + 20 skipped（唯一失败为既知 runbook 债，不写"全量通过"）；tsc PASS。
- CI：HEAD `08fc45d`，run **36691975407** = 五作业 SUCCESS；API **142 files / 1298 tests PASS**。
- 送审：Issue #2 comment **5907760165**（七段式）；右侧会话短唤醒已发送并完成送达验证（627 字符作为新用户轮出现、输入框清空、生成中）。
- 口径纠正：行锁会阻塞其他事务对该行的普通 UPDATE/DELETE（与 advisory lock 无关）；锁前已提交变化由锁后重读处理。

## 2026-09-30 — MSG-20260930-28 = PASS（② 第二批 replay）→ 下一批次：冻结批次 retry-due

- 裁决：**PASS**（限定 `payment.replay` 入口工程验收）；REVIEWED_REF `08fc45d0e1ca8e3c43c99d2ddc67ebaaab8ab0da`；CI run 36691975407 五作业 SUCCESS（API 142 files / 1298 tests PASS，replay 专项 19/19）。授权项②整体仍 **NOT COMPLETE**，全部生产 HOLD 不变。
- 关闭项：资金对象身份（`Payment.id`/`Payment.provider`）纳入快照与服务端审批指纹；按租户 + `Payment.id` 的 `FOR UPDATE` 行锁并断言恰一行/ id 一致；锁后最终快照核对 `paymentId`/`paymentProvider` 及既有关键关联；重验时间在全部必要锁之后；用例 18/19 获接受（19 明确为客户端包装的空结果分支证明，非删除竞争/HTTP 全链路）。
- 接受的口径：行锁会阻塞普通 UPDATE/DELETE（与 advisory lock 无关）；审批边界拒绝 ≠ 获批尝试执行后的非 PAID 领域结果（后者按既定语义记录 attempt 与消费，`SUCCEEDED` ≠ 收口成功）；事实 CAS 失败仅证明无 PAID/无成功资金审计。
- 注意：**旧审批若缺少新增绑定字段（paymentId/paymentProvider）将不满足当前执行核验**，必须重新审批，不得补写或伪造旧审批内容。
- 下一批次（已 ACK，无需额外确认）：**冻结批次 retry-due** —— 服务端 `batchId`、排序后的明确 attempt/event 清单及指纹（版本/关联发票/金额币种/操作类型）、有效期与数量上限；不得纳入批准后新增 due 项；每项执行前重验事实/权限/生命周期/幂等；后台 SYSTEM 执行具备明确预授权范围；复用资金收口路径时保持本轮已验收的锁顺序、最终事实保护与事务边界。webhook 继续区分「接收已发生付款事实」与「授权新扣款」。

## 2026-09-30 — ② 第二批 retry-due（R12 送审）

- 实现链：`81f1b48`（动作身份 payment.retry_due + 消费事件 payment.retry_due_consumed + PaymentRetryBatch 目标分派）→ `8df2c31`（冻结 + 批次审批服务）→ `1c923d5`（executeRetryBatch：单一事务 批次锁→摘要复核→审批核验→逐项重验与执行→批次消费；只处理冻结清单；复用 replay 锁协议；跳过留证；SYSTEM 身份与 FROZEN_BATCH 预授权范围）→ `f9721d0`（路由 freeze/review/受保护执行 + server 白名单）→ `a5fa3d4`（专项验收 8 例）→ `461d442`（运维用例迁移 + 冻结记录审计预算/计数修正）→ `942cdbd`（契约 §5.5 与矩阵）。
- 验收：retry-due 专项 **8/8**（全链路恰一次；缺审批 409；批准后新增 due 项不执行；冻结后事实变化跳过留证；跨域冒用三类消费不新增；有效期过期 403；数量上限夹取；批次消费审计失败整事务回滚）；运维 HTTP 套件迁移后 6/6；本机全量 143 文件 / 1286 passed + 20 skipped（唯一失败为既知 runbook 债，不写"全量通过"）；tsc PASS。
- CI：HEAD `942cdbd`，run **36696202968** = 五作业 SUCCESS；API **143 files / 1306 tests PASS**。
- 送审：Issue #2 comment **5908440892**（七段式）；右侧会话短唤醒已发送并完成送达验证（645 字符作为新用户轮出现、输入框清空、生成中）。
- 边界：webhook 保持独立（验签+幂等+事实接收，不引入每次人工审批）；后台调度器仍由宿主侧提供（本批次交付入口与授权边界）；真实扣款与生产 HOLD 不变。

## 2026-09-30 — MSG-20260930-29 = REVISE（② 第二批 retry-due / R12）

- 已确认完成：独立动作与消费事件族、服务端 batchId + 确定性选单 + 逐项指纹 + sha256 摘要、冻结清单存于既有 AuditLog（PaymentRetryBatch 为逻辑实体）、执行只遍历冻结 items、审批与执行共用批次锁、逐项事实比对与 Payment 行锁、资金处理复用发票锁与事实 CAS、执行/跳过/消费与资金同事务、新增项不纳入/金额变化跳过/消费审计失败回滚已覆盖。
- CHANGE A：冻结有效期必须在**审批与执行**强制生效（实际截止取冻结与审批较早值）；每项取得必要锁后生成当前时间并重新核验审批有效期/主体/撤销/轮次与冻结授权范围，随后才创建 attempt；授权在执行期间失效 → 抛错回滚本次全部执行且不消费批次；成功/消费时间不得使用锁等待前的旧时间；区分"撤销先取得批次锁"与"执行先取得批次锁"的串行化结果。
- CHANGE B：事件锁后重读并保护**原 attempt**（paymentEventId/paymentId/attemptNo/status/nextRetryAt/代际），用一次性认领或后继关系防止重试旧代际；跨批次同 attempt 只能实际执行一次，其余跳过留证；遵守既有重试上限；固定**整批多资源全局确定性锁顺序**（逐项局部顺序不足以防止多批次交叉持锁），并与 replay 兼容；跳过理由精确记录。
- CHANGE C：批次锁后重读并集中校验冻结记录（digestVersion、操作/处理版本、数量 ≤20、有效日期、逐项结构与重复项、存储 itemCount 与清单一致），未知版本/损坏/异常数量失败关闭；审批绑定**冻结截止时间**并在执行核对，避免只绑定独立审批截止时间。
- CHANGE D：关闭旧服务绕过 —— 最终 HEAD 仍导出 `runDueRetries`（动态选单、直接恢复资金、不要求 batchId/approvalId）；须删除/禁用或改为受保护冻结批次执行，迁移既有调用与测试，不得保留给未来调度器绕过审批；口径修正为"**用户授权触发、内部以 SYSTEM 记录执行**"，不得宣称独立后台 worker 认证已完成（调度器继续后置）。
- CHANGE E：补真实 HTTP/PostgreSQL 验收 —— 冻结期限到期（审批仍有效）拒绝且过期冻结不得重新批准延长；等事件/发票/Payment 锁期间审批过期或主体失效 → 最终重验拒绝、无部分提交；等锁期间 attempt 变为不可重试/关联变更/被后继取代 → 跳过；同审批并发恰一次、不同批次含同一 attempt 恰一次；多批次交叉竞争锁协议；摘要篡改/未知版本/实际 >20 项拒绝；旧入口缺审批不能执行；审批决策审计失败关闭（保留消费审计失败回滚）；数量上限须以 **≥21 个候选项**验证。

## 2026-09-30 — ② 第二批 retry-due 修订（R13 送审）

- 实现链：`174bfad`（CHANGE D 关闭旧动态入口）、`5873559`（CHANGE A/C 冻结有效期 + 逐项锁后重验 + 批次记录集中校验）、`8fd45ca`（CHANGE B attempt 代际认领/跨批次去重/整批全局锁顺序）、`b26265f`（CHANGE E 专项 16 例）、`16419e0`（契约 §5.5 与矩阵同步）。
- 关键点：冻结 `expiresAt` 在审批与执行均强制生效（取冻结/审批较早值，过期不得延长）；每项锁后重新生成时间并再次核验审批（失效即抛错回滚整批且不消费）；原 attempt 锁后重读 + 一次性认领（清空 `nextRetryAt`）+ 后继代际取代与重试上限检测；批次内按 `invoiceId|paymentId|paymentEventId` 全局排序取锁；批次记录锁后集中校验（版本/数量≤20/结构/重复项/itemCount/摘要）。
- CHANGE D：旧动态选单入口关闭 —— `runDueRetries` 仅为受保护「冻结批次执行」别名（必须 batchId+approvalId，缺审批拒绝）；口径修正为「用户授权触发、内部以 SYSTEM 记录执行」，不宣称独立后台 worker 认证。
- 验收：retry-due 专项 **16/16**（含冻结过期、等锁期间主体停用、attempt 不可重试跳过、同审批并发恰一次、跨批次同 attempt 恰一次、≥21 候选项→上限 20、摘要篡改失败关闭、旧入口缺审批）；本机全量 143 文件 / 1294 passed + 20 skipped（唯一失败为既知 runbook 债，不写"全量通过"）；tsc PASS。
- CI：HEAD `16419e0`，run **36698793887** = 五作业 SUCCESS；API **143 files / 1314 tests PASS**。
- 送审：Issue #2 comment **5908875652**（七段式）；右侧会话短唤醒已发送并完成送达验证（668 字符作为新用户轮出现、输入框清空、生成中）。

## 2026-09-30 — MSG-20260930-30 = REVISE（retry-due R13 剩余项）

- 已关闭/部分关闭：冻结期限强制（执行同时检查冻结与审批期限形成较早边界）、逐项锁后重验并回滚整批、原 attempt 行锁与代际检查（位置偏早）、后继代际与 MAX_ATTEMPTS（需移至事件锁后）、批次锁后集中校验（审批仍部分用旧记录、itemCount 校验空转）、旧 runDueRetries 绕过已关闭、≥21 候选项验证上限、同审批并发与顺序去重。
- 剩余 CHANGE A（执行时间一致）：当前项的资金处理 / `finishAttempt` / 执行审计 / 批次消费仍用批次锁后但逐项锁等待**之前**的 `at`；必须统一改用锁后 `itemAt`，批次消费用实际完成阶段时间、跳过记录用判定时间，并补受控等锁验收断言时间顺序与 `paidAt`/成功资金审计/执行记录一致。
- 剩余 CHANGE B（安全整批锁协议 + 认领位置）：代际/关联/状态/到期/后继/上限检查必须在**取得事件锁之后**完成；一次性认领置于最终事实与授权确认之后、创建新 attempt 之前，事实变化被跳过的项不得提前清空 `nextRetryAt`；按 invoice|payment|event 排序后逐项取"事件→发票→Payment"仍非安全全局顺序（批次持发票 I 等 E2 事件锁 / replay 持 E2 等 I → 循环等待），须改为整批先按确定性顺序取全部事件锁、再取全部发票锁、再 Payment/attempt 行锁（或等效消除"持发票锁再等事件锁"）。
- 剩余 CHANGE C/E：审批 REQUEST/APPROVE 全部使用**锁后**记录（digest/数量/返回值）；`readRetryBatch` 不得用 items.length 重算 itemCount（须读取并校验**存储值**）；非法 item 结构化失败关闭；补验收：批次与 replay 共享发票的真实受控竞争（无死锁）、两个已冻结批次**真实并发**含同一 attempt 恰一次、等事件锁期间产生后继代际→旧项跳过、等锁期间**审批过期**、已批准后冻结到期执行拒绝、未知 digestVersion/非法 item/itemCount 不符/>20 项精确拒绝、retry-due 审批决策审计失败关闭、两项批次首项已执行且第二项锁后授权失效→**整批回滚**。
- 口径接受：「用户授权触发、内部以 SYSTEM 记录执行」；独立 worker 认证与调度器继续后置；真实资金与生产 HOLD 不变。

## 2026-09-30 — ② 第二批 retry-due 修订（R14 送审）

- 实现：`ff2d73d`（分阶段整批锁协议：全部事件锁→全部发票锁→Payment/attempt 行锁；事件锁后代际/关联/状态/到期/后继/上限检查；认领置于最终事实与授权确认之后且跳过项不清空 nextRetryAt；执行时间统一 itemAt/完成阶段时间；批次记录改读存储 itemCount）、`9332738`（专项 16→22 例）、`662a5f7`（契约 §5.5 与矩阵补充）。
- 验收：retry-due 专项 **22/22**（新增：后继代际跳过且不清空认领标记、等锁期间审批过期、已批准后冻结到期、存储 itemCount 不符、未知 digestVersion、两项批次逐项留证）；本机全量 143 文件 / 1300 passed + 20 skipped（唯一失败为既知 runbook 债，不写"全量通过"）；tsc PASS。
- CI：HEAD `662a5f7`，run **36700845582** = 五作业 SUCCESS；API **143 files / 1320 tests PASS**。
- 送审：Issue #2 comment **5909247588**（七段式）；右侧会话短唤醒已发送并完成送达验证（754 字符作为新用户轮出现、输入框清空、生成中）。
- 请求裁定两点口径：(a) 分阶段锁协议下"首项已执行后再授权失效"是否可结构性排除；(b) 是否需要"批次与 replay 共享发票真实并发竞争"用例及其控制点构造方式。

## 2026-09-30 — MSG-20260930-31 = REVISE（retry-due R14 剩余项）

- 已关闭：`itemAt` 用于本项核验/资金处理/attempt/执行审计（消费用 completedAt、跳过用判定时间）、事件锁后的代际/关联/状态/到期/后继/上限检查、认领位置（跳过项不提前清空）、审批与返回值使用锁后 `lockedBatch`、存储 `itemCount` 校验、未知 `digestVersion` 专项、旧动态入口关闭结论。
- CHANGE A：各阶段资源集合必须**独立排序**（全部事件 ID / 发票 ID / Payment ID / attempt ID 各自确定性比较），不得用事件排序推断其他资源顺序（Set 保留首次出现顺序 ≠ 资源自身全局排序；两批次事件不重叠但共享 I1/I2 时仍可互相持有一张票并等待另一张）。
- CHANGE B：记录并校验行锁结果身份 —— 每个需执行项必须确认其 Payment/attempt 行已锁定（恰一行且 id 正确）；未锁定项明确跳过留证，不得因后续查询可读到行而恢复执行；正常缺失项仍可按批次语义跳过。
- CHANGE C：**不能结构性排除中途授权失效**（TTL 随时间到期、成员状态可被他事务改变、多项含异步 DB 操作）；须以测试专用事务客户端包装 + Promise 屏障构造「首项资金写入后暂停 → 跨审批有效期或停用成员 → 恢复后精确拒绝」并证明首项资金推进/attempt/执行审计/认领标记/批次消费**全部回滚**（用例 22 的"一项执行 + 一项事实变化跳过"不能替代）。
- §2(b) 裁定：**需要**可重复的真实数据库并发验收 —— 批次含 E1/E2 共享发票 I、replay 目标 E2、独立测试连接先持 E2 事件锁；确认批次在等待 E2 且**尚未持有 I 锁**；启动真实 replay 同样等待 E2；释放后有界完成，无死锁、无重复资金推进、无非法部分提交；控制点必须关联具体数据库会话与完整锁身份（不能只用全库任意等待行）。另补：两个已批准批次**真实并发**含同一 attempt 恰一次（用例 13 为顺序执行，不算）、事件集合不同而发票集合交叉的两批次证明发票阶段独立排序、retry-due 审批决策审计失败关闭、受控等锁后的时间顺序与 `paidAt`/成功审计/执行时间一致性断言。
- 口径：用例 19（改写冻结截止时间）为有限证明，不得称为自然时间推进下的完整有效期竞争测试；Node 24 runbook 继续为非阻塞技术债；调度器/独立 worker 认证/真实资金与生产 HOLD 不变。

## 2026-09-30 — ② 第二批 retry-due 修订（R15 送审）

- 实现：`9f6a042`（CHANGE A/B：各阶段资源独立排序 + 行锁结果身份校验与未锁定项跳过留证）、`52ae6d7`（用例 23/24）、`5c8ac8a`（用例 25/26）、`ee0220e`（用例 27）、`f6a9bae`（用例 28）、`b254da9`（契约补充）。
- 证据：retry-due 专项 22 → **28 例**；23 首项资金写入后经 Promise 屏障暂停→停用成员→精确 APPROVAL_ACTOR_MISMATCH 且**整批回滚**（发票不推进/无成功审计/两条认领标记保留/零执行审计与消费）；24 两个已批准批次真实并发同一 attempt → 仅一次实际重试；25 审批决策审计失败放行前关闭；26 受控等锁后时间顺序一致性；27 共享发票批次 vs replay（独立会话持 E2 事件锁，断言批次等事件锁时**未持共享发票锁**，释放后无死锁/无重复推进）；28 发票集合交叉两批次独立排序无死锁。
- 本机全量 143 文件 / 1306 passed + 20 skipped（唯一失败为既知 runbook 债，不写"全量通过"）；tsc PASS；CI run **36704582105** = 五作业 SUCCESS（API 143 files / 1326 tests PASS）。
- 送审：Issue #2 comment **5909787976**（七段式，含两点口径请裁定：同事件并发 fail-closed 500 是否需改为结构化 409；用例 28 的构造边界）；右侧会话短唤醒已发送并完成送达验证（720 字符作为新用户轮出现、输入框清空、生成中）。

## 2026-09-30 — MSG-20260930-32 = REVISE（retry-due R15：冲突语义与验收证据）

- 已关闭：各阶段独立排序、行锁身份记录与未锁定项跳过、用例 23（Promise 屏障 → 整批回滚）、用例 25（审批决策审计失败关闭）、锁后时间/最终事实/代际认领/旧入口关闭结论。
- CHANGE A（本轮不后置）：CI 数据库日志显示 retry-due 相关冲突实为 `PaymentProcessingAttempt_succeeded_payment_key`（成功 Payment 来源唯一约束，发生在 attempt 完成更新阶段），不能笼统归因"同事件正在运行 attempt"。要求：锁后检查已有成功来源/终态 → 明确跳过或结构化 409；仅将已识别的预期约束映射为稳定领域错误；若捕获事务内 DB 异常须先回滚再在事务外映射（不得在失败事务内继续写审计/消费）；不放宽唯一约束、不把未知故障伪装成 409。
- CHANGE B：用例 27 需识别**批次会话 PID**（批次锁或 E1 锁关联）并确认它等待 E2 且未持共享发票锁；确认 replay 也到达对应等待点；有界完成、核对允许状态码与领域原因、**移除任意 500 通行条件**；查询最终资金/attempt/审批消费并区分成功方与回滚/拒绝方。
- CHANGE C：用例 24 不得忽略 rejected（要求一个执行、另一个明确跳过或精确领域拒绝，不得静默忽略未知异常）；用例 26 需真实持锁等待控制点（否则降级标题，不能称为等锁证据）；用例 28 需两批次**事件集合不同**、共享两张发票、发票首次出现顺序相反，并用控制点真实竞争发票资源，断言预期成功与逐发票关联（不能只过滤 deadlock 字符串、不能用"PAID≤2/成功审计≤2"这类双方都未执行也成立的上限）。
- 边界：用例 23 为服务层事务+包装屏障（非 HTTP 全链路）；用例 19 冻结记录改写边界保留；Node 24 runbook 非阻塞技术债；调度器与独立 worker 认证后置；retry-due 与授权项②整体暂不标记完成。

## 2026-09-30 — ② 第二批 retry-due 修订（R16 送审）

- 实现：`f3391d7`（批次侧结构化冲突 + 用例 27 收紧）、`dab0433`（P2002 目标判据加固）、`0021df6`（用例 24 不忽略 rejected、用例 26 真实等锁；用例 27 暂时 skip）、`2dcd6dc`（**replay 路径**补 P2002 映射并恢复用例 27，连续三次 28/28）、`3882d71`（用例 28 重做为可判别构造）、`f7b2298`（契约补充）。
- 取证结论：CI 日志中的冲突实为 `PaymentProcessingAttempt_succeeded_payment_key`（成功 Payment 来源唯一约束），且具体触发点在 **replay 路径**的 `paymentProcessingAttempt.updateMany()` 链接 paymentId（Prisma P2002，meta.target 含 paymentEventId/paymentId）；两条路径现均在事务回滚后映射为稳定 409（`PAYMENT_SOURCE_CONFLICT` / `ATTEMPT_ALREADY_RUNNING`），其余错误原样抛出。
- 证据：用例 27 确定性构造（两会话均到达 E2 等待点、等待者不持共享发票锁、不允许任意 500）；用例 24 不忽略 rejected（一执行、一明确跳过）；用例 26 真实等发票锁后时间顺序；用例 28 事件集合不同＋共享两张发票＋首现顺序相反的判别构造（断言每张发票至多一次 PAID 且至少一张推进、成功审计与发票一一对应）。
- 本机全量 143 文件 / 1306 passed + 20 skipped（唯一失败为既知 runbook 债，不写"全量通过"）；tsc PASS；CI run **36709243880** = 五作业 SUCCESS（API 143 files / 1326 tests PASS）。
- 送审：Issue #2 comment **5910452495**（七段式）；右侧会话短唤醒已发送并完成送达验证（632 字符作为新用户轮出现、输入框清空、生成中）。
- 环境教训：同一时间只能运行一个 vitest 进程（并行争用同一 Postgres 会造成整批误报）。

## 2026-09-30 — MSG-20260930-33 = REVISE（retry-due R16：精确约束映射 + 用例28 事件不相交）

- 已关闭（保留）：批次锁内区分「已有成功来源 / 同事件进行中」并跳过留证；冲突转换发生在事务回滚之后；用例 24 要求两批次均正常完成（一执行、一明确跳过）；用例 26 真实等待发票锁后核对时间顺序；用例 27 先确认批次等待 E2、再启动 replay、确认两个不同 PID 等待且该时刻共享发票无人持锁、不再允许任意 500。
- CHANGE A：当前映射仍有过宽兜底（replay 中未匹配 paymentEventId 的任何 P2002 → PAYMENT_SOURCE_CONFLICT；批次侧剩余 P2002 兜底；部分 meta 正则分支未要求确属唯一约束）。要求改为**明确约束白名单 + 经验证的 Prisma 目标组合**：区分成功来源唯一约束、进行中 attempt 约束及其他已识别约束；**未识别 P2002 / meta 不完整 / 其他数据库错误一律原样抛出**；补上述四类验收；用例 27 对非 200 断言具体状态码与领域原因；取证文档需分别记录**链接阶段**与**完成阶段**的错误，不得合并为未经证实的单一结论。
- CHANGE B：用例 28 两批次仍共享种子事件（seedItem 同时进入 A/B）→ 可能先在共同事件锁串行化，削弱判别力。要求：事件集合**完全不相交**并显式断言交集为空；种子项不得同时进入两批次；按**实际事件锁排序后**的顺序断言两批次发票首现顺序相反；用控制点确保双方完成各自事件锁阶段后再进入共享发票竞争；逐发票断言预期 PAID、成功审计关联、资金数量与无重复执行（不得仅用上限与「至少一张成功」）。
- 口径：保留直接写入冻结记录的有限证明；「连续三次 28/28」为本机申报（架构方未独立重跑），稳定通过不能弥补判别力不足；Node 24 runbook 非阻塞技术债；调度器/独立 worker 认证/真实资金与生产 HOLD 不变。

## 2026-09-30 — ② 第二批 retry-due 修订（R17 送审）

- 实现：`507cb81`（**精确白名单**映射模块 payment-conflict-map + 两条路径接线 + 6 例单测）、`a31ed6f`（错误响应非空领域名回退）、`1356d23`（用例 27 严格断言收口）、`b28469e`（用例 28 重做）、`adfeca2`（契约同步）。
- 白名单规则：仅 P2002 且目标组合确属已识别约束（paymentId+organizationId→PAYMENT_SOURCE_CONFLICT；paymentEventId+organizationId→ATTEMPT_ALREADY_RUNNING）；**未知 P2002 / meta 不完整 / 非唯一错误一律原样抛出**；映射在事务回滚之后、事务之外。取证按**链接阶段 / 完成阶段**分列。
- 用例 27：非 200 分支收紧为「200/403/409 + 非空领域原因（6 个允许码）」。如实披露：此前"空原因"根因是**测试端 replay 腿未解析原始 Response**，非服务端缺陷；修复后连续三次通过。
- 用例 28：两批次**事件集合完全不相交**（断言交集为空）、共享两张发票且按 items 顺序首现相反、**阶段控制点**（独立连接持 I1 锁 → 两批次完成事件锁阶段后均阻塞在 I1，等待者≥2）、逐发票完整断言（PAID 去重且与 payment.succeeded 一一对应、执行 attempt 无重复、支付对象数不变）。
- 本机全量 144 文件 / 1312 passed + 20 skipped（唯一失败为既知 runbook 债，不写"全量通过"）；tsc PASS；CI run **36713753220** = 五作业 SUCCESS（API 144 files / 1332 tests PASS）。
- 送审：Issue #2 comment **5911259416**（七段式）；右侧会话短唤醒已发送并完成送达验证（783 字符作为新用户轮出现、输入框清空、生成中）。

## 2026-09-30 — MSG-20260930-34 = REVISE（retry-due R17：严格白名单 + 用例28 精确结果）

- 已接受：两路径共用 `payment-conflict-map` 且删除宽泛兜底、映射在事务失败之后；用例 27 非 200 收紧（含"空原因源于测试未解析 Response"的根因更正）；用例 28 的竞争构造（种子不进批次、事件交集为空、发票首现相反、阶段等待≥2、无未处理 rejected、PAID 与成功审计建立对应）。
- CHANGE A：`mapKnownPaymentUniqueConflict` 必须**严格结构化** —— 数组 target 仅接受「长度恰为 2、全部字符串、无重复、字段集合精确等于两种已识别组合之一（顺序可互换）」；若支持约束名，仅接受 `meta.target` 中**精确相等**的完整已取证约束名；**删除消息子串匹配与 /attempt/i 猜测路径**；缺失/畸形/未知/多字段 target → null 并原样抛出。补反例单测：无 target 但 message 含约束名；仅 `paymentEventId` + 消息含 attempt；三字段组合；重复字段；混入非字符串；未知约束名。
- CHANGE B：用例 28 需精确最终结果 —— PAID 集合**恰等于** `{invoiceId, secondInvoice.id}`；`payment.succeeded` **恰 2 条**且实体集合与两张发票一致；逐发票断言 `paidAmount`；逐 Payment 核对关联/金额/币种；四个冻结项均有明确执行或跳过结果，成功来源无重复。
- 口径清理：删除测试中"空 body 留待下一轮诊断"旧注释；契约中 R16 的「target 含某字段即可映射」旧规则须标记为已被 R17 取代，避免两套有效口径并存。
- 边界：CI 全绿已确认；本机口径（1312 passed + 20 skipped、既知 runbook 失败）不得写成本机全量通过；"连续三次稳定"为提交方申报；调度器/独立 worker 认证/生产启用与真实资金外写继续后置；capture/replay 已通过范围不因本轮局部 REVISE 撤销。

## 2026-09-30 — ② 第二批 retry-due 修订（R18 / MSG-20260930-34 收口）

- 实现（提交 `4c695c0`）：
  - **CHANGE A 结构化精确白名单**：`services/workflow/payment-conflict-map.ts` 重写 —— 仅 `code === P2002` 且 `meta.target` 结构化匹配才映射（数组 target 长度**恰为 2**、元素全为非空字符串、**无重复**、字段集合**精确等于** `{organizationId,paymentId}` → `PAYMENT_SOURCE_CONFLICT`，或 `{organizationId,paymentEventId}` → `ATTEMPT_ALREADY_RUNNING`，顺序可互换；字符串 target **精确等于** `PaymentProcessingAttempt_succeeded_payment_key` → `PAYMENT_SOURCE_CONFLICT`，用 `hasOwnProperty` 查表）。**删除全部消息子串/关键字猜测**，其余一律 `null` → 原样抛出。
  - **映射单测 8 例（3 正 + 5 反）**：两字段两种顺序 / 约束名精确匹配；反例 = 无 target 但消息含约束名、仅 `paymentEventId` 且消息含 attempt、三字段与非字符串/空串、重复字段、未知约束名与非唯一错误。
  - **CHANGE B 用例 28 精确最终结果**：PAID 集合恰等于两张发票、每张 `paidAmount = AMOUNT`；`payment.succeeded` 恰 2 条且实体集合一致；Payment 恰 2 条且逐行关联/金额/币种核对；四个冻结项「执行 + 跳过」恰 4 且无重复。
- **阶段控制点根因修复（用例缺陷，非服务缺陷）**：旧控制点固定持发票 I1，而服务端按「分阶段 + 每阶段资源 ID 字典序」取锁（R15 CHANGE A），两批次共享同一发票集合 → 第一把发票锁必是字典序较小者。当 I2 的 UUID 更小时，先到批次拿 I2 再等 I1、另一批次被挡在 I2 上，I1 只留 1 个等待者 → **实测 3 次运行 2 次 `CONTROL_POINT_TIMEOUT` 假失败**。已改为持**服务端锁序中的第一把共享发票锁**，并新增：① 开跑前「受审键无残留 advisory lock（5s 有界排空）」前置；② 控制点成立时「4 个事件键等待者 = 0」自证；③ 失败取证（逐键 wait/held + `pg_locks` 现场）。修复后连续 **3/3 通过**，断言未放宽。
- 契约口径清理（`docs/releases/ACTION-APPROVAL-BINDING-CONTRACT.md`）：R17 行改为结构化精确白名单全文；**R16 行标记已被 R17 取代（仅历史留档）**，消除两套口径并存；矩阵「约束映射白名单」行改为严格口径 + 8/8；RD 28 行改为「第一把共享发票锁 + 事件键等待者 = 0 + 精确最终结果」；RD 23–28 历史重复行标注「已被上方同名行取代，仅留档」。
- 证据：`prisma validate` valid；`tsc --noEmit` PASS；定向单进程 **14 文件 / 133 用例全绿**（retry-due 28/28、映射 8/8、replay/capture/attempt/billing/payment-admin/HITL 回归）；本机全量 **144 文件 / 1314 passed + 20 skipped**，唯一失败为**既知** `phase1-runbook.test.ts`（Node 24 导入兼容技术债，非本次改动引入，不写作「全量通过」）。
- CI：HEAD `4c695c0` → run **36718083469** = **5/5 SUCCESS**；API 作业日志 **144 files / 1334 tests PASS**。
- 送审：Issue #2 comment **5911844071**（R18 七段式，含 CHANGE A/B、控制点根因与修复、口径清理、诚实披露）。
- **ChatGPT 唤醒通道本轮不可用**：右侧应用内浏览器会话在 12:33Z 与 13:05Z 两次探测均为 `Codex auth token is unavailable`（会话级令牌缺失，浏览器发现同样失败）→ 唤醒未送达，**待下一轮重试**；请求全文已在 Issue #2 留档，通道中断不影响留档完整性。

### R18 证据补充：控制点假失败在 **CI** 上同样复现

- CI run **36714714672**（commit `485b317`，docs-only runlog 提交）→ 作业 `API · migration + typecheck + tests` **FAILURE**；日志 2026-09-30T12:31:16Z 明示：`action-guard-payment-retry-due-http-db.test.ts` 用例 28 抛 `Error: CONTROL_POINT_TIMEOUT:BOTH_BATCHES_WAITING_ON_SHARED_INVOICE`（12:27:23Z 亦出现同一错误）。
- 含义：上一轮「CI 全绿」并不等于该用例稳定通过，而是**发票 UUID 顺序恰好有利**的抽样；根因即本轮修复的「控制点持错发票锁」。
- 已在 Issue #2 追加留档 comment **5911869998**（不改送审点 `4c695c0`）。

## 2026-09-30 — 工程卫生批次：本机全量与 CI 对齐（phase1-runbook shebang）

- 现象：本机（Node 24）`npx vitest run` 恒为 **144 文件中 1 文件失败 + 20 skipped**（`phase1-runbook.test.ts` collect 失败），而 CI（Node 20）该文件 20/20 通过；每次披露都要附带「本地非全绿」说明。
- 根因（探针实证）：`tools/validation/phase1-runbook.mjs` 首行是 CLI shebang `#!/usr/bin/env node`；原生 ESM 加载器会剥离它，但 **vite-node 的 SSR 转换不会** —— shebang 留在转换产物里，Node 抛 `SyntaxError: Invalid or unexpected token`，整份套件 collect 失败、20 条用例被记为 skipped。
- 探针结论：① 直接动态导入原文件 = **FAIL**；② 无 shebang 的临时副本 = **PASS**；③ 读入源码、剥离 shebang 后经 `data:` URL 导入 = **PASS**（并能读到 `PHASE1_THRESHOLDS`）。据此采用 ③。
- 修复（`65ff124`，仅测试侧）：`phase1-runbook.test.ts` 改为读入源码 → 剥离 shebang → `data:` URL 导入（`@vite-ignore`）。工具本身与其 CLI 用法**未改动**；其余同模式导入（`action-guard.test.ts` 导入的是项目内 `.ts`，无 shebang）不受影响。
- 验证：`phase1-runbook.test.ts` 20/20 PASS；`tsc --noEmit` PASS；**本机全量 144 文件 / 1334 用例全绿**（首次与 CI 完全一致）；CI run **36720354790** = **5/5 SUCCESS**。
- 意义：消除「本地全量永远差一条」的长期披露负担；此后本地与 CI 的证据口径一致。
- 送审点说明：该提交为**测试环境修复**，不改变 R18（retry-due MSG-34 收口）的 REVIEWED_REF —— **R18 送审点仍为 `4c695c0`**（Issue #2 comment 5911844071）。

## 2026-09-30 — 等待 R18 裁决期间：台账/状态同步与披露更正（无代码、无 Schema、无受保护入口扩张）

- 背景：ChatGPT 网页通道自 12:33Z 起不可用（`Codex auth token is unavailable`），已按 MSG-34 §7「不扩大到新的受保护入口」保持队列不扩张；期间只做不触发审计口径的同步工作。
- `2d84330` 台账纠正（依据已归档裁决）：`.autopilot/TASKS.md` 中 ③ PRODUCTION CONTROL PLANE 由「待开工」改记为 **PASS**（MSG-20260930-16 / REVIEWED_HEAD e460a82）；② 记为**整体 NOT COMPLETE**并展开逐批次证据（HITL 提交入口已接入 / `payment.capture` PASS MSG-24 73115a3 / `payment.replay` PASS MSG-28 08fc45d / `payment.retry_due` R18 送审中 4c695c0）；⑤ 标注「须待 ② 业务覆盖完成」（MSG-16 原文优先顺序）。`ACTION-GUARD-CP2-STATUS-AND-INTEGRATION-CHECKLIST.md` §3 同步（`payment.capture` 行由 TODO → 已验收 PASS；表下追加 replay / retry-due 逐批次登记）。CI run **36722007041** = 5/5 SUCCESS。
- `4f552ab` 状态同步：`.autopilot/STATE.json` 仅改描述性字段（current_task / next_task / channel_status / blocked_scope / last_send_* / updated_at），使 runner 打印真实进度；重跑后 `reconcile` 由 RECONCILE_REQUIRED → **IN_SYNC**。CI run **36722262126** = 5/5 SUCCESS。
- 披露更正（Issue #2 comment **5912429899**）：R18 请求中「本机全量 1314 passed + 20 skipped、既知 runbook 失败」一句在申请后已过期 —— 该技术债已按根因修复（见上一条 hygiene 记录，`65ff124`），本机现为 144 文件 / 1334 用例全绿。为避免审核方读到与实际不符的披露而更正；明确为**披露更新**，不改变 retry-due 的送审点 `4c695c0`。
- 待办：通道①恢复后投递 R18 唤醒（Issue #2 comment 5911844071 为正式总线内容）；在此之前不新增受保护入口工作。

## 2026-09-30 — R18 送审点更新：CHANGE A 收紧为「精确相等」（9a806eb）

- 触发：等待裁决期间自查 `4c695c0` 的实现，发现仍残留**同类清洗** —— 字符串 target 与数组元素都先 `trim()` 再比较，因此 `' organizationId'`、`'PaymentProcessingAttempt_succeeded_payment_key '` 这类带空白输入会被洗干净后放行。MSG-20260930-34 §2 要求字符串 target「**精确相等**」，并明确批评上一版「畸形 target 经清洗变成合法组合」——trim 属同一缺陷类别，故主动收紧。
- 变更（提交 `9a806eb`，仅 3 文件）：① `payment-conflict-map.ts` 删除全部 `trim()`，字符串 target 逐字符精确相等才查表；数组 target 长度恰 2 / 全非空字符串 / 无重复 / 字段集合精确相等，**成员不清洗、不过滤**，其余一律 null；② 映射单测 **8 例 → 9 例（3 正 + 6 反）**，新增反例「字段名带空格 / 约束名带前导空格 → null」，MSG-34 列举的六类反例逐条独立断言；③ 契约文档 R17 行与矩阵白名单行同步为 9/9 且写明「不做任何清洗」。
- 验证：`tsc --noEmit` PASS；`prisma validate` valid；映射单测 9/9；retry-due 专项 28/28；replay 套件通过（三文件 56/56）；本机全量 144 文件 / 1334 用例全绿。CI run **36726898061** = **5/5 SUCCESS**，API 日志 **1335 tests PASS**（较 4c695c0 的 1334 多 1 例 = 新增反例单测，数量自洽）。
- 留档：Issue #2 comment **5913068685** 明确「R18 送审 ref 由 4c695c0 更新为 **9a806eb**，其余内容与 4c695c0 相同」，并说明功能面无影响（Prisma 的 meta.target 不含空白）只为严格性。
- 待办更新：通道①恢复后的唤醒消息应指向 **9a806eb**（而不是 4c695c0）。

- 另：在 `docs/releases/ACTION-GUARD-CP2-STATUS-AND-INTEGRATION-CHECKLIST.md` 追加「3.1 代码引用抽查」（纯代码引用地图，明确**不是验收结论**、不改状态列）：`commission.charge` 入口**已接线**（/cases/:id/recovery-outcome，缺守卫 fail closed）；`claim.submit`/`appeal.submit`/`platform.write` 仅有目录+能力映射+静态清单、无路由接线；`claim.prepare`/`billing.draft`/`evidence.read`/`secret.rotate` 接线状态见该表。

## 2026-09-30 — R18 唤醒已送达 + **通道诊断口径更正**（重要）

- **唤醒已送出并验证**（16:05Z 前后）：右侧 ChatGPT 审计会话（`/c/6abc2d93-4448-83e8-a940-94889b355510`，标题「仓库审查裁决」）收到指向 **`9a806eb`** 的 R18 唤醒；验证三要素：正文作为最新一轮出现（DOM 尾部含 `[CODEX → CHATGPT]` 与 `9a806eb`）、页面显示「ChatGPT 正在回应」、会话未中断。
- **诊断口径更正（此前 3 小时的误判）**：`Codex auth token is unavailable` 实际来自 **Edge 扩展浏览器**（`type=extension`，`metadata.extensionInstanceId=266b0aab-…`）。工作流的健康检查用 `cua.getState()`，它会把**所有** surface 的 tab 一并列出；只要 Edge 报错，整个调用失败并返回 `browsers: []`，于是被误读为「ChatGPT 网页通道整体不可用」。
- 实测（16:03Z）：`cua.listBrowsers()` 正常返回两个 surface（`Codex In-app Browser`(id=1, iab) / `Edge`(id=2, extension)）；`cua.listTabs({browser:"1"})` **正常**返回审计会话标签页与用户新开的 `chatgpt.com/` 标签页；`cua.listTabs({browser:"2"})`（Edge）报 token 错误。→ **in-app browser 通道始终可用**，可用会话读取已确认（对话最后一条仍是已归档的 MSG-20260930-34，即架构方尚未看到 R18）。
- 影响：此前「唤醒发不出去、评审无法开始」的结论**过宽**；实际是聚合健康检查被 Edge surface 毒化。已据此在 16:0xZ 直接投递唤醒。此处如实记录，避免后续再用聚合调用判断通道状态。
- 后续口径（SELF_RESOLVE，写入本轮记录，供下一轮沿用）：通道健康检查 = `listBrowsers()` 逐 surface 判断 + 只对需要操作的 surface 调 `listTabs`；Edge 扩展持续报 token 错误时**忽略该 surface**（不影响 in-app browser 的读写），必要时再提示宿主重新连接扩展，而不再要求重开 ChatGPT 会话。

## 2026-09-30/10-01 — MSG-20261001-01 = **PASS**（retry-due R18 / 送审点 9a806eb）

- 唤醒于 16:05Z 送达后，架构方在审计会话给出 R18 裁决：**PASS（本批次工程验收）**，REVIEWED_REF = 9a806eb303194d185b83547a581ba8c9069ec584；CI run 36726898061 = 5/5（API 144 files / **1335** tests、retry-due 28/28、映射单测 9/9、phase1-runbook 20/20）。
- 关闭项：CHANGE A 结构化精确白名单（含删除 trim 清洗）；CHANGE B 用例 28 精确最终结果；阶段控制点修复（持服务端排序后的第一把共享发票锁）获接受；runbook 修复获接受（明确「未删除测试或放宽断言」）。
- 结论边界：**支付域三类受保护内部入口（payment.capture / payment.replay / payment.retry_due）当前工程范围收口**；但明确不代表真实网关扣款、生产资金执行、webhook 新授权、调度器/独立 worker 认证、②全覆盖、Gate 7 或生产上线。授权项②整体仍 **NOT COMPLETE**。
- 非阻塞纠偏（架构方 §5）：状态记录中需分别绑定提交 —— 本机 **1334**（4c695c0 时代）与最终 CI **1335**（9a806eb）不可混写；已在本记录与 TASKS.md 中区分。
- 下一步（架构方 §7）：同步清单/状态（payment.retry_due = PASS、reviewed ref、修正测试数量与旧送审点引用）→ 在 ② 剩余业务入口中按集成清单选择**下一小批次**并提交七段式审计请求；不得跳过 ② 剩余项进入 ⑤/⑥/⑦，不得重开已通过的 ③。

## 2026-10-01 — ② 下一小批次范围登记（PROGRESS，依据 MSG-20261001-01 §7）

- 现状：① 完成；③ = PASS（MSG-16）；② 第一批（HITL 提交入口 → `commission.charge`）= PASS（MSG-21）；② 第二批（`payment.capture` / `payment.replay` / `payment.retry_due`）全部 PASS（MSG-24 / MSG-28 / **MSG-20261001-01**）；webhook 依 MSG-22 §(3) 为独立边界，不纳入逐次人工审批。
- 剩余待覆盖：`claim.submit` / `appeal.submit` / `platform.write`（EXTERNAL_WRITE）、`claim.prepare` / `billing.draft`（INTERNAL_WRITE）、`evidence.read`（READ_ONLY）、`secret.rotate`（HOST ONLY）。
- **选定下一小批次 = `claim.submit`（提交路径 · HITL 人工闸门 · 平台外写保持 HOLD）**：复用第一批的 `hitl-submission` 边界与审批指纹；执行端已知「提交闸门永不调用 `adapter.submitClaim()`，只返回 `NEEDS_MANUAL`」，故可在**不触发真实外写**的前提下完成接入与验收。范围与 6 项验收计划见 `ACTION-GUARD-CP2-STATUS-AND-INTEGRATION-CHECKLIST.md` §3.2。
- 未开工：本轮仅登记范围（PROGRESS），实现与送审在后续轮次；期间不得重开已通过的 ③，不得跳过 ② 剩余项进入 ⑤/⑥/⑦。

## 2026-10-01 — `claim.submit` 批次实施前置侦察（只读，PROGRESS）

- 结论：**当前没有 Claim 提交的 HTTP 路由**（`services/claims/*` 仅被测试引用），但跟踪写入原语（`recordSubmission` 等）与恒为人工卡口的外写闸门（`submitClaimThroughAdapter` → `NEEDS_MANUAL`，注册表拒绝写入面适配器）都已存在。
- 实现面：新增受保护路由 + 复用 `createHitlSubmissionBoundary`（`claim.submit`，humanApproval+platformEnablement+productionGate）→ 放行后写跟踪记录并返回 `NEEDS_MANUAL`（零平台外写）+ `action_guard.approval_decision` 审计 + 6 项 HTTP/PostgreSQL 验收。
- 已登记于 `ACTION-GUARD-CP2-STATUS-AND-INTEGRATION-CHECKLIST.md` §3.2；实现与送审留待后续轮次。生产 HOLD 全部保持。

## 2026-10-01 — claim.submit 实现落点复核（只读，PROGRESS）

- 结论：`/cases/:id/claim` 现为 **GET 草稿**（`getClaimDraft`），**不承载提交**；因此需新增提交路由 `POST /cases/:id/claim/submit`。
- 落点已精确登记（见 `ACTION-GUARD-CP2-STATUS-AND-INTEGRATION-CHECKLIST.md` §3.2「实现落点」表）：路由常量 + 匹配注册 + 处理分支（fail closed）+ 复用 `outlinePath → createHitlSubmissionBoundary` 范式 + 放行后仅 `recordSubmission()` 并返回 `NEEDS_MANUAL` + 新测试文件。
- 无需 Schema/迁移；capability 映射与静态清单已就绪。下一步即按该表编码。

## 2026-10-01 — Gate 7 / ② claim.submit 小批次 = READY_FOR_REVIEW（R19）

- 实现（HEAD `0745c33`）：`POST /cases/:id/claim/submit` —— 缺 guard/默认 READ_ONLY → fail closed；`createHitlSubmissionBoundary({action:'claim.submit'})` 审批+能力+Production Gate 校验与 `action_guard.approval_decision` 审计；放行后**仅** `recordSubmission()`，返回 `NEEDS_MANUAL`、`platformWriteExecuted=false`（零平台外写）。
- 配套：`server.ts` `WORKFLOW_PATH` 登记新路径（修 404 根因）；`recovery-review.ts` 审批载荷校验按动作类型判定（资金动作不变，`claim.submit` 仅要求 `basisReference`）。
- 验收：`action-guard-claim-submit-http-db.test.ts` 六项（真实 HTTP + PostgreSQL）——未配置 control plane/缺 approvalId/审批不存在/审批绑定他人/能力未满足/合法审批→恰一次提交+恰一次消费+零外写+NEEDS_MANUAL；**连续 3 次 6/6**，与 `action-guard-hitl-r3-race-db` 合跑 **15/15**；`tsc --noEmit` PASS、`prisma validate` valid。
- CI：run **36790488457** = **5/5 SUCCESS**；API 日志 **1341 tests PASS**（较 1335 增加 6 例，与新增套件一致）。
- 送审：Issue #2 comment **5921507920**（七段式）；ChatGPT 会话唤醒已投递并验证（tail 含 `0745c33`）。
- 边界：Production Enablement / 真实外写 / 资金 / 客户提交 / 生产凭据继续 HOLD；平台提交恒为 NEEDS_MANUAL。

## 2026-10-01 — R19 送审后的通道与本地证据补充（续接窗口执行）

- **唤醒投递更正**：首次填入右侧 ChatGPT 审计会话的 R19 唤醒经核对**未被注册**（发送键为禁用态、会话中未出现对应新轮次）。续接窗口按真实输入路径重写并回车发送，三要素验证通过：输入框清空、会话末轮为含 `0745c33` 的用户消息、页面 tail 出现唤醒全文。随后该轮返回 `cloudflare_challenge`，再重试两次均为 `Unknown error`（提示「重新生成回复未成功」）→ **属模型侧生成失败，不是投递失败；裁决待回**，下次巡检重试读取。
- **本地全量（隔离库）**：本机有并行会话共用同一 PostgreSQL，两次全量运行出现 `40P01` 死锁与 `Organization` 外键假失败（失败集合每次不同）。改用临时独立库（`prisma migrate deploy` 后运行）得到 **145 文件 / 1341 用例全部通过（0 跳过）**，与 CI 口径一致；该临时库已即时删除。此后本机全量证据以隔离库或 CI 为准。
- **未改动送审点**：以上仅为通道与证据记录，`REVIEWED_REF` 仍为 `0745c33`（Issue #2 comment `5921507920`）。
## 2026-10-01 — R19（claim.submit）裁决 = REVISE（MSG-20261001-02 / REVIEWED_REF 0745c33）

- 裁决全文（页面逐行规范化转录；本文件与 AI-ARCHITECT-INBOX.md 同名段落一致）：

```text
[CHATGPT → CODEX]

TYPE: FORMAL_VERDICT
MESSAGE: MSG-20261001-02（R19 裁决全文重发，非新裁决）
DECISION: REVISE
GATE: Gate 7 / 授权项② RUNTIME BUSINESS BLOCKING · claim.submit · R19
HEAD: 0745c33
REVIEWED_REF: 0745c33（完整 SHA：0745c331c1a6f3f41408b632f1676ba55096526b）

本裁决针对 R19，不沿用 R18 的 PASS。ecd8f50 不属于本次受审引用。

KEEP

已核对并接受：

- POST /cases/:id/claim/submit 的工作流路由与 server.ts 前缀门控已接通。
- Claim 查询限定租户、案件及 round=1。
- 缺 Action Guard 显式拒绝；默认控制面保持 READ_ONLY。
- 经 Action Guard、HITL 审批与能力检查后才能进入业务执行。
- 审批绑定 claim.submit、Case 目标及 basisReference=claim.id。
- 放行前写 action_guard.approval_decision。
- 当前分支不调用平台适配器写入面，返回 NEEDS_MANUAL 和 platformWriteExecuted=false。

CHANGE

A．提交、人工提交审计、审批消费必须同事务。

当前 recordSubmission() 先更新 Claim，再写业务审计；路由随后独立写审批消费。任何后续写入失败，都可能留下已提交但未完整审计或消费的 Claim。要求：

- 在提交服务中使用同一事务客户端完成 Claim CAS、claim.submitted_by_human、审批消费。
- 业务审计必须绑定事务客户端，不能使用绑定根 Prisma 客户端的审计写入器。
- 任一业务审计或消费失败，状态、提交时间、提交人、批准字段及相关记录全部回滚。
- 成功审计及消费记录关联 approvalId、operationId、Case 和 Claim；执行时间在取得必要锁后生成并统一使用。

B．取得锁后完整重验审批和主体。

wrapper 的事务外只读验证不能保护核验后发生的过期、撤销、新轮次或主体失效；Claim CAS 不能替代审批生命周期保护。要求：

- 与 submitRecoveryReview 共用案件锁协议 cc-recovery-case:${caseId}，再取得必要的 Claim 行锁并确认身份与租户。
- 全部必要锁取得后生成时间、重读 Claim，核验审批动作、目标、载荷、指纹版本、有效期、撤销、轮次、消费及审批人/执行人有效性。
- 执行角色必须满足 Claim 提交权限。
- 已消费审批只能返回明确既有结果或结构化拒绝，不能重新执行。
- 同审批及同 Claim 不同审批并发，最多一个提交成功、一次业务审计和一次消费。
- 锁内拒绝保留关联记录；拒绝审计失败不能覆盖原始拒绝。

C．载荷策略放宽只限定本批次动作。

recovery-review.ts 当前将所有非默认资金动作都归为“只需依据”的分支，范围过宽。要求：

- 默认及现有资金动作继续要求完整金额、币种、依据。
- 明确允许 claim.submit 使用本批次非资金载荷规则。
- 未知动作拒绝，不得自动视为非资金动作。
- 补默认资金动作缺字段拒绝、claim.submit 合法及未知动作拒绝的回归测试。

D．补齐失败、并发和等锁验收。

保留现有六项 HTTP + PostgreSQL 测试，新增：

- 同审批并发：一次状态推进、一次业务审计、一次消费。
- 业务审计失败与消费失败分别注入：整个提交事务回滚。
- 等锁期间审批撤销、过期、执行主体失效：锁后拒绝且零业务副作用。
- 错误 Claim 绑定：状态、业务审计、消费均不新增。
- 放行前审批决策审计失败：work=0。
- 成功落库记录的审批、操作、Case/Claim 关联一致。

按场景断言具体状态码及原因，避免统一宽泛允许集合。缺守卫与默认 READ_ONLY 是不同路径。现有用例仅证明默认 READ_ONLY；缺守卫可直接调用 handleWorkflowRequest，提供有效会话依赖但省略 actionGuard，验证拒绝及零业务调用。若声称动态证明零外写，应增加外写调用探针；响应字段 false 本身不构成调用次数证据。

RISKS

本轮阻塞项是内部提交原子性、锁内授权重验和过宽的审批载荷策略。暂停旧 runner、改用独立测试库属于有效的证据隔离改进，但不能修复上述代码缺口。当前零平台外写的边界接受，不因外写后置而判 BLOCK。

TEST

已读取的最终 CI：run 36790488457 对应受审 SHA，五作业 SUCCESS；API 145 files / 1341 tests PASS，claim.submit 6/6。本轮补充的独立库 crossclaim_r19_verify 六项全绿、tsc PASS、Prisma valid，登记为提交方申报证据。本次重发未再次取证，也未独立运行测试。六项通过证明当前覆盖场景成立，尚不能证明事务失败回滚及等锁期间授权失效保护。

NEXT

归档裁决后立即完成 CHANGE A–D，重跑类型检查、审批回归、Claim PostgreSQL 专项及新 HEAD CI，再提交七段式复核。无需宿主提供真实数据；不要求新增迁移、review 路由或开放适配器。授权项②整体继续 NOT COMPLETE。

授权 Codex 将本全文逐字归档至 Issue #2，执行 FULL_COPY_OK 校验，并按 CHANGE 实施，无需再次确认。同一 MESSAGE 为重发，应避免登记为第二份独立裁决。

PRODUCTION

Production Enablement / 真实外写 / 资金 / 客户提交 / 生产凭据：全部 HOLD。本裁决不包含合并、部署或真实平台提交授权。
```

## 2026-10-01 — R19 CHANGE A–D 实施完成（claim.submit 原子提交 / 锁内重验 / 载荷白名单 / 验收补齐）

- CHANGE A（原子提交）：新增 `apps/api/src/services/claims/claim-submission.ts` —— Claim CAS（DRAFT→SUBMITTED）、`claim.submitted_by_human`、`recovery.approval_consumed` 在**同一事务客户端**完成；业务审计改为事务内写入（不再用绑定根 Prisma 的 AuditWriter）；执行时间在取得锁后生成并统一用于状态字段与两条审计；成功记录带 approvalId / operationId / Case / Claim。
- CHANGE B（锁内重验）：先取与 `submitRecoveryReview` 同协议的 `cc-recovery-case:${caseId}` 案件锁，再取 Claim 行锁（FOR UPDATE）校验身份/租户/round=1；随后完整重验审批（动作/目标/载荷/指纹版本/有效期/撤销/轮次/消费/审批人与执行人有效性）与执行角色（`claimTrackingApprove`）；已消费 → 结构化 403 `APPROVAL_ALREADY_CONSUMED`；锁内拒绝在事务外留痕 `claim.submit_rejected`，拒绝审计失败不覆盖原始错误。
- CHANGE C（载荷白名单）：`recovery-review.ts` 的“仅依据”分支改为显式白名单 `NON_MONEY_APPROVAL_ACTIONS = [claim.submit]`；默认与资金动作仍要求金额/币种/依据；白名单之外的动作一律 `INVALID_INPUT`。受保护动作常量 `CLAIM_SUBMIT_ACTION` 归入 `action-guard/approval-verifier.ts`（有限静态约定检查通过）。
- CHANGE D（验收补齐）：`action-guard-claim-submit-http-db.test.ts` 6 → **18 项**：同审批并发恰一次（其余精确 403 已消费）；业务审计失败注入整笔回滚；审批消费失败注入回滚；放行前审批决策审计失败 work=0；等锁期间撤销/过期/主体停用（真实案件锁控制点）锁后精确拒绝且零副作用；错误 Claim 绑定零新增；成功记录关联一致性；缺 guard 装配路径（直接调用 handleWorkflowRequest）；零外写探针（路由源码无写入面引用 + 注册表拒绝实现 submitClaim 的适配器）；载荷策略白名单回归（默认缺字段拒绝 / claim.submit 合法 / 未知动作拒绝）。
- 验证（隔离库 `crossclaim_r19_verify`，无并行 runner）：目标 18/18；全量 **145 文件 / 1353 用例全绿（0 跳过）**；`tsc --noEmit` PASS；`prisma validate` valid。
- 口径披露：①「同 Claim 不同审批并发」无法构造两个同时有效的审批（新 REQUEST 取代旧审批 → APPROVAL_NOT_APPROVED），并发正确性由案件锁 + CAS 结构性保证；②零外写为「静态无写入面引用 + 注册表拒绝写入面适配器」探针口径，不宣称运行期调用计数。
- 待恢复动作：`HOST_ACTION_REQUIRED: gh auth login`（gh CLI 令牌失效 401，Issue #2 写回暂缓；`git push` 正常）。


## 2026-10-01T00:58:02.237Z — 真实 tick 记录（R20 送审后空转根因核实）

- **根因**：Codex 自动化 `crossclaim-ai-bridge-5min` 在核实瞬间为 **status = PAUSED**（rrule 仍为 `FREQ=MINUTELY;INTERVAL=5`）→ 定时循环并未在跑，故 R20 送出后既无新心跳也无新裁决轮次。已在核实后立即恢复为 **ACTIVE**（同一线程 `01a0e6b2-…`、同一 5 分钟周期），并顺带把「逐 surface 通道诊断」写进 prompt。
- 调度/进程证据：无 Windows 计划任务（`Get-ScheduledTask` 仅返回无关且 Disabled 的项）；唯一调度器即上述 Codex heartbeat；`.autopilot/HEARTBEAT.json` 最后动作时间 `2026-09-30T23:37:35Z`（runner `resume-from-state`）。
- R20 通道核实：Issue #2 请求 comment **5922360473** 已写回（STATUS=201）；ChatGPT 会话中 R20 消息确为最后一条、无 assistant 回复、无 generating、无错误横幅；按规程先 `reload()` 复读一次，再发送**轻量重试**「请处理刚才的 R20 复审请求：REVIEWED_HEAD=e8ba20e，Issue #2 comment 5922360473，请给出新的 PASS / REVISE / BLOCK。」，并验证其出现在会话底部（送达）。
- 重复实例：本轮未再观测到第二个活跃自动化实例；此前出现的并行提交（如 ecd8f50）来自另一执行实例，已通过保持单一 ACTIVE 自动化收敛。
- 边界：Production Enablement / 真实外写 / 资金 / 客户提交 / 生产凭据继续 HOLD。

## 2026-10-01T00:58:20.480Z — 真实 tick 记录（R20 送审后空转根因核实）

- **根因**：Codex 自动化 `crossclaim-ai-bridge-5min` 在核实瞬间为 **status = PAUSED**（rrule 仍为 `FREQ=MINUTELY;INTERVAL=5`）→ 定时循环并未在跑，故 R20 送出后既无新心跳也无新裁决轮次。已在核实后立即恢复为 **ACTIVE**（同一线程 `01a0e6b2-…`、同一 5 分钟周期），并顺带把「逐 surface 通道诊断」写进 prompt。
- 调度/进程证据：无 Windows 计划任务（`Get-ScheduledTask` 仅返回无关且 Disabled 的项）；唯一调度器即上述 Codex heartbeat；`.autopilot/HEARTBEAT.json` 最后动作时间 `2026-09-30T23:37:35Z`（runner `resume-from-state`）。
- R20 通道核实：Issue #2 请求 comment **5922360473** 已写回（STATUS=201）；ChatGPT 会话中 R20 消息确为最后一条、无 assistant 回复、无 generating、无错误横幅；按规程先 `reload()` 复读一次，再发送**轻量重试**「请处理刚才的 R20 复审请求：REVIEWED_HEAD=e8ba20e，Issue #2 comment 5922360473，请给出新的 PASS / REVISE / BLOCK。」，并验证其出现在会话底部（送达）。
- 重复实例：本轮未再观测到第二个活跃自动化实例；此前出现的并行提交（如 ecd8f50）来自另一执行实例，已通过保持单一 ACTIVE 自动化收敛。
- 边界：Production Enablement / 真实外写 / 资金 / 客户提交 / 生产凭据继续 HOLD。


## 2026-10-01 · R25 准备期：审批有效期「时间炸弹」（非本批次引入；已修复）

- 现象：本机全量运行出现 2 个失败 —— `action-guard-hitl-approval-verifier-db.test.ts > 03`（`{ valid: false }`）与 `action-guard-hitl-route-db.test.ts > 04`（期望 200/201，实际 403）。
- 归因验证：`git stash push -u` 回到基线 `cabdead`（CI 五作业 SUCCESS，本地此前全量 146 files/1369 tests 全绿）后，**同样两个用例仍失败**（2 failed | 15 passed），恢复工作区后重复运行仍失败；因此这两个失败与 MSG-20261001-08 CHANGE A/B **无因果**。
- 两个文件共同特征：固定时间常量 `NOW = 2026-09-30T03:00:00Z` + 真实时钟做审批有效期/绑定判定；随本地墙钟推进（今日为 2026-10-01）逐步进入失败窗口，属**时钟相关本地 flake**。
- 处置：不修改既有已验收文件的时间夹具（避免掩盖)；本批次证据以 **claim.prepare 专项 18/18 + 回归 29 files/260 PASS + CI（权威）** 为准，本地全量失败按上表登记并在 R25 七段式中披露。


- **根因更正（CI 复现后定论）**：这不是本地 flake —— 同一 2 个用例在 GitHub CI（run 36809566281 / job 110201374093，2026-10-01T03:16Z）同样失败。根因是这些用例用**固定** `NOW` 创建操作级审批，而审批有效期按**真实时钟**判定；当真实时间越过 `NOW + TTL(24h)` 后，审批一律 EXPIRED → 403 / `valid:false`。首个进入失败窗口的是 `NOW = 2026-09-30T03:00:00Z`（= 2026-10-01T03:00Z 到期），与 CI 在 03:16Z 变红完全吻合。
- **修复**：把全部「用固定 NOW 创建带有效期审批」的测试夹具改为**时钟相对基准** `const NOW = new Date(Date.now() - 60_000);`，所有相对偏移（+1s/+5s/+60s/+90s/+120s/3.6s）与断言语义保持不变；共 10 个文件（hitl-approval-verifier / hitl-route / hitl-concurrency / hitl-http-chain / hitl-r3-race / hitl-r4-ordering / claim-submit / payment-capture / payment-replay / payment-retry-due）。
- **验证**：本机全量 146 files / 1375 tests PASS；tsc PASS；prisma validate valid；CI 以新 HEAD 为准。

## 2026-10-01 JST — R32 送审重新投递（通道复核）

- 通道：in-app browser 会话 `c/6ab9ee1b-fd54-83ee-b363-b67750afcedd`（CrossClaim GitHub Audit Loop）。
- 观测：R32 送审后该会话返回 `No new actionable audit item since R32 ...`，属定时任务扫描摘要，**不是编号裁决**，未归档、未当裁决执行。
- 动作：在同一会话重新投递自包含 R32 复审请求（REVIEWED_HEAD 7d888cc / ISSUE #2 comment 5925427340 / CI run 36820104474 SUCCESS / 本机 专项 13-13、回归 32 files-307、tsc、prisma valid / CHANGE A+B+C 摘要）。
- 送达三要素（已验证）：输入框已清空（contenteditable 长度 1）、请求文本作为新用户消息出现在会话底部、出现「ChatGPT 正在回应」生成态。
- 下一步：等待 MSG-20261001-16 → 全文读取（DOM 最小包含节点）→ 逐字归档 AI-ARCHITECT-INBOX.md → compare.mjs FULL_COPY_OK → Issue #2 回写 → PASS 则 appeal.submit 收口，REVISE 则按新 CHANGE 收敛。
- 边界不变：Production Enablement / 真实外写 / 资金 / 客户提交 / 生产凭据 继续 HOLD；平台真实写入口 platform.write 仍 HOLD。

## 2026-10-01 JST — 裁决 MSG-20261001-16 = PASS（appeal.submit / R32 收口）

- 通道：in-app browser 会话 `c/6ab9ee1b-fd54-83ee-b363-b67750afcedd`；首次投递返回定时任务摘要（非裁决），重投自包含请求后取得编号裁决。
- REVIEWED_HEAD `7d888cc`；CI run 36820104474 SUCCESS；本机 appeal.submit 13/13、回归 32 files / 307 PASS、tsc PASS、prisma valid。
- 归档：`AI-ARCHITECT-INBOX.md` 的 `### [MSG-20261001-16]`（原文 37 行）→ `tools/verdict-diff/compare.mjs` 结果 **FULL_COPY_OK**（缺失 0 / 多出 0）。
- 回写：Issue #2 comment 5925593971。
- 裁定要点：CHANGE A/B/C 全部关闭；无阻塞 CHANGE；非阻塞边界两条（用例 06 仅证明消费侧拒绝、本 PASS 不授权真实平台写入）。
- NEXT：appeal.submit 批次收口 = PASS；② 剩余仅 `platform.write`（EXTERNAL_WRITE，HOLD）——先做接口/状态机/权限/幂等/审批绑定/模拟适配器与 fail-closed 测试。

## 2026-10-01 JST — platform.write 边界批次（PROGRESS，MSG-20261001-16 NEXT 授权）

- 新增 `apps/api/src/services/platform-write/{types,snapshot,state-machine,ledger,simulated-adapter,index}.ts`：版本化提交快照、幂等键派生、尝试状态机（上限 3）、审批绑定核验、模拟投递端口、fail-closed 编排。
- 动作名 `PLATFORM_WRITE_ACTION` 收敛到 `services/action-guard/approval-verifier.ts` 单一来源；有限静态约定检查（受保护动作字面量必须与守卫同文件）通过。
- 验收：`platform-write.test.ts` 17/17 PASS；`tsc --noEmit` PASS；`prisma validate` valid（未改 Schema）；action-guard 回归 22/22 PASS。
- 硬开关 `PLATFORM_WRITE_TRANSPORT_ENABLED=false`：默认路径 NEEDS_MANUAL，拒绝路径 `sinkCalls=0`；真实通道在类型（simulated 字面量）与运行时（SIMULATED_SINK_REQUIRED）双重拒绝。
- 设计稿：`docs/releases/ACTION-GUARD-PLATFORM-WRITE-DESIGN.md`（非目标 + 后续需架构方裁决 4 条）。
- 下一步（下一 tick）：接线对外 HTTP 入口 + 真实 HTTP + PostgreSQL fail-closed 验收 → R33 送审；真实平台外写、凭据、生产启用继续 HOLD。

## 2026-10-01 JST — 裁决 MSG-20261001-17 = PASS WITH REVISE（platform.write 安全骨架 / R33）

- 通道：`c/6ab9ee1b-fd54-83ee-b363-b67750afcedd`；R33 已送达（三要素验证通过）。
- 架构方首段回复在 CHANGE A 说明处被截断（结尾“……此时开放 HTTP 会让进程级状态承担外”）；已在同一会话请求补全并取得 `MSG-20261001-17 — CONTINUED`。
- 归档：两段原文按原样合并（`[CONTINUATION]` 分隔）写入 `AI-ARCHITECT-INBOX.md` 的 `### [MSG-20261001-17]`（94 非空行）→ compare.mjs **FULL_COPY_OK**；Issue #2 comment 5925786916。
- 裁定：KEEP 安全骨架；CHANGE A 暂不接 HTTP；CHANGE B 先提交 PlatformWriteAttempt 账本 Design/Schema Delta（不写 migration）；CHANGE C 审批消费与执行权原子边界 + UNKNOWN_PROVIDER_RESPONSE；CHANGE D `PLATFORM_WRITE_TRANSPORT_ENABLED=true` 不单独构成授权。
- 下一步：产出账本设计 + Schema Delta Request 后重新送审；期间不接 HTTP / 不接真实 adapter / 不开启 transport。

## 2026-10-01 JST — CHANGE B/C/D 设计交付（platform.write 账本与审批消费原子边界）

- 新增 `docs/releases/PLATFORM-WRITE-ATTEMPT-LEDGER-DESIGN.md`：三条并发不变量落地（I1 唯一幂等键 / I2 一审批一 snapshot / I3 成功不可重复）、T1 数据库事务边界（重验审批 → 唯一 attempt → CAS IN_FLIGHT → 同事务写 approval_consumed）、T2 事务外调用、T3 结果收敛、`UNKNOWN_PROVIDER_RESPONSE` 与崩溃恢复对账语义、安全最小化、索引与保留期、迁移回滚、验收清单。
- 新增 `docs/releases/PLATFORM-WRITE-SCHEMA-DELTA-REQUEST.md`：正式请求批准（新枚举 + 新表 + C1–C6 约束/索引，含 Postgres partial unique index 请求），明确不含 migration / HTTP / transport。
- 现状对齐要点：审批事实来源是 `AuditLog` 的 `recovery.review_approved` 事件 id，消费是追加 `recovery.approval_consumed`（`changes.approvalId`）——因此消费必须与 attempt 占位/CAS 同事务。
- 未改 Prisma Schema、未写 migration、未接线 HTTP、未开启 transport、未消费审批、未调用真实平台。
- 下一步：R34 送审两份设计稿。

## 2026-10-01 JST — 裁决 MSG-20261001-18 = PASS WITH REVISE（R34 账本/原子性设计）

- R34（7de5c60）送审 → 裁决 PASS WITH REVISE；逐字归档（131 行）→ compare.mjs **FULL_COPY_OK**；Issue #2 comment 5925860624。
- 五问裁决：① I1 = 选项 A；② partial unique index 批准；③ approvalId 不得无条件可空（服务层+测试锁死）；④ UNKNOWN → RECONCILING → SUCCEEDED/FAILED_CONFIRMED/MANUAL_REVIEW，1/5/15/60 分钟、24h 转人工，绝不重发写请求；⑤ 24 个月默认保留期 + append-only 加密归档，本阶段不实现清理。
- CHANGE A：区分逻辑执行链与执行/对账历史；CHANGE B：UNKNOWN 恢复所有权（SYSTEM 只读）；CHANGE C：消费不变量必须可并发验证（现状报告：AuditLog 无 approvalId 列、消费无 DB 唯一约束）。
- 交付：`docs/releases/C-PLATFORM-WRITE-LEDGER-IMPLEMENTATION-PLAN.md`（最终模型/索引 C1–C6/迁移 M1–M3/T1-T2-T3+R1 服务边界/PG1–PG10 验收矩阵）；设计文档 §12 已收入裁定。
- 边界：HTTP / 真实 adapter / transport / 生产凭据 / 客户提交 全部继续 HOLD。

## 2026-10-01 JST — 裁决 MSG-20261001-19 = PASS WITH REVISE（R35 Implementation Plan；批准进入实现）

- R35（61b95f1）→ 裁决 PASS WITH REVISE；逐字归档（111 行）→ FULL_COPY_OK；Issue #2 comment 5925918882。
- 批准：总体拆法、三态 `RECONCILING`/`FAILED_CONFIRMED`/`MANUAL_REVIEW`、M1/M2/M3 三步提交。
- CHANGE A：约束语义收紧（非空 approvalId 最多绑定一个能取得真实执行权的逻辑 attempt；禁止孤儿 attempt 吃掉审批；不要求改 AuditLog）。
- CHANGE B：T1 = 原子授权点（六项同时成立，任一步失败整笔回滚；消费必须是事务事实）。
- CHANGE C：`FAILED_CONFIRMED` 严格定义；timeout/404/次数耗尽/24h 到期 → `MANUAL_REVIEW`。
- NEXT：S1 Schema/M1 → S2 constraints/M2 → S3 service/M3 → S4 PG1–PG10+新增断言 → S5 回归/CI/送审 Implementation Checkpoint。
- 硬边界不变：NO HTTP WIRING · NO REAL ADAPTER · TRANSPORT=FALSE · NO PRODUCTION CREDENTIALS · NO REAL EXTERNAL WRITE · NO CUSTOMER SUBMISSION。

## 2026-10-01 JST — S1（Schema/M1）完成：PlatformWriteAttempt 表落地

- `apps/api/prisma/schema.prisma`：新增枚举 `PlatformWriteAttemptStatus`（11 值，含 `UNKNOWN_PROVIDER_RESPONSE` / `RECONCILING` / `FAILED_CONFIRMED` / `MANUAL_REVIEW`）与模型 `PlatformWriteAttempt`（快照摘要/幂等键/审批引用/对账字段；**无任何凭据或原始 payload 字段**）；Organization 增加反向关系。
- 迁移：`20261001062736_platform_write_attempt_ledger`（M1：枚举 + 表 + FK；唯一约束与索引留给 M2，partial unique index 留给 M3）。
- 验证：`prisma validate` valid；`prisma migrate deploy` 成功（21 migrations，schema up to date）；`prisma generate` OK；`tsc --noEmit` PASS；platform-write 17/17 + Action Guard 22/22（39 项）PASS。
- 边界不变：未接线 HTTP、未接真实 adapter、`PLATFORM_WRITE_TRANSPORT_ENABLED=false`、未消费审批、无真实外写。
- 下一步：S2 约束（C1/C2/C4–C6）→ M3 partial unique index → S3 服务层。

## 2026-10-01 JST — S2/S3 进展（约束 + 部分唯一索引）

- S2/M2（f0e3dd4）：C1 @@unique(organizationId,idempotencyKey)、C2 @@unique(organizationId,approvalId)、C4–C6 索引；migration 20261001064005 已应用。
- CI 修复：ee77970 失败两项 —— ①新表缺租户触发器（已补 cc_tenant_platform_write_attempt + cc_tenant_immutable__PlatformWriteAttempt 并同步 checklist，本地 29 baseline / 37 immutable 通过）；②architecture-contract 模型口径 38→39（36 core + 3 join），测试/DOMAIN_MODEL/README 已同步（b21f20f），本机 architecture-contract 109/109 PASS。
- S3/M3（d852d51）：platform_write_attempt_succeeded_unique（raw SQL partial unique index）落地并应用；24 migrations，schema up to date；tsc PASS。
- 下一步：S3 服务层（Prisma 账本端口 + T1/T2/T3/R1）与 PG1–PG10 验收。

## 2026-10-01 JST — S3 增量（对账策略 + 状态词表）

- 新增 apps/api/src/services/platform-write/reconcile-policy.ts：纯函数 decideReconciliation / reconcileBackoffMinutes / assertReconcilable；UNKNOWN→RECONCILING（1/5/15/60 分钟，24h → MANUAL_REVIEW），FAILED_CONFIRMED 仅由 CONFIRMED_NOT_APPLIED（可信证据）触发，INCONCLUSIVE 永不判失败。
- types.ts/state-machine.ts：新增 UNKNOWN_PROVIDER_RESPONSE / RECONCILING / FAILED_CONFIRMED / MANUAL_REVIEW 四态与迁移（IN_FLIGHT→UNKNOWN；UNKNOWN/RECONCILING→SUCCEEDED/FAILED_CONFIRMED/MANUAL_REVIEW；MANUAL_REVIEW 可由 OWNER/ADMIN 收敛）。
- 验证：tsc --noEmit PASS；platform-write 17/17 PASS。提交 5c0ae44 已推送。
- 下一步：Prisma 账本端口 + T1/T2/T3/R1 编排 + PG1–PG10（含并发/故障注入/重发禁止）验收。

## 2026-10-01 JST — S3 服务层核心完成（账本端口 + T1/T2/T3/R1）

- 新增 apps/api/src/services/platform-write/prisma-ledger.ts：acquireExecutionRight（T1 六项原子授权点：事务内锁后重验审批 → 组织内唯一幂等执行链 → approval 唯一绑定 → CAS PENDING→IN_FLIGHT → 同事务写 approval_consumed）、settleAttempt（T3 CAS 收敛）、markAttemptUnknown、reconcileOnce（R1 只读对账，绝不调用 write sink）、submitPlatformWrite（T1→T2→T3 编排，transport 关闭时 NEEDS_MANUAL 零投递）。
- 新增 apps/api/src/__tests__/platform-write-ledger-db.test.ts：真实 PostgreSQL 验收 PG1（同键并发恰一次）/PG2（同 approval 不同 snapshot 拒绝）/PG3（消费写入失败整笔回滚）/PG4（已消费拒绝）/PG5（UNKNOWN 对账只读，sink 调用 0）/PG8（SUCCEEDED 不可再收敛）/PG9（跨租户拒绝）/PG10（partial unique index 拦截）→ 8/8 PASS。
- platform-write 单测 19/19（新增 18/19 对账策略：FAILED_CONFIRMED 仅可信证据、INCONCLUSIVE 永不判失败、1/5/15/60 分钟退避、24h → MANUAL_REVIEW）。
- 回归：platform-write-ledger-db + platform-write + action-guard + tenant-isolation = 54 PASS；tsc PASS。提交 d2c82fa（账本）+ 随后提交（策略单测）。
- 下一步：S4/S5 全量回归 → Implementation Checkpoint（R36）送审。

## 2026-10-01 JST — 固化长期工程约束：跨模块回归 + Golden Path E2E（HOST DIRECTION）

- 写入 `docs/releases/ENGINEERING-REGRESSION-POLICY.md`（10 条硬性要求 + Golden Path 全链路定义 + 回归清单 R1–R8）；
- 同步 `AGENTS.md`（长期约束章节）与 `.autopilot/TASKS.md`（`GOLDEN-PATH-E2E` 排队 + 4 条长期回归任务）；
- 适用范围：核心领域模型 / Schema / 状态机 / Action Guard / Claim / Appeal / Settlement / RecoveryLedger / Billing / platform.write / Adapter / Import / Canonical Fact；
- 不改变 Gate 7 / ② 批次顺序；当前 S3/S4/S5 继续推进（R36 送审中）。

## 2026-10-01 JST — 裁决 MSG-20261001-20 = PASS WITH REVISE（R36 Implementation Checkpoint）

- 归档：AI-ARCHITECT-INBOX.md §MSG-20261001-20（59 非空行）→ compare.mjs FULL_COPY_OK；Issue #2 comment 5927130487。
- KEEP：S1–S5 主体实现接受（M1/M2/M3、唯一约束与 partial unique index、T1/T2/T3/R1 职责隔离、UNKNOWN→RECONCILING→MANUAL_REVIEW、FAILED_CONFIRMED 仅可信证据、transport 关闭）。
- CHANGE A：补 PG6 真实跨进程/重启恢复证据（销毁原 client，新 client 从数据库事实恢复；不依赖内存、不调 write sink、不重复消费 approval、不建第二条链、保持原 attemptId/idempotencyKey）。
- CHANGE B：补 PG7 真实双 worker 竞争（两独立 Prisma client 并发 R1；仅一个 CAS 收敛、无双重终态审计、无第二个 SUCCEEDED、loser 明确 no-op）。
- CHANGE C：补 PG1–PG10 → test name/evidence 映射表（不得只报 10/10）。
- NEXT：只补 A/B/C → 重跑专项+action-guard+tsc+prisma+fresh migration/trigger checklist+全量 → 直接提交 R36 RE-REVIEW（无需 Design/Plan）。

## 2026-10-01 JST — 裁决 MSG-20261001-21 = PASS（R36 RE-REVIEW，checkpoint 关闭）

- 归档：AI-ARCHITECT-INBOX.md §MSG-20261001-21 → compare.mjs FULL_COPY_OK；Issue #2 comment 5927328440。
- 结论：R36 CHANGE A/B/C 完整收口；PG6/PG7/PG1–PG10 全部 PASS；无变更、无生产代码 delta；checkpoint 正式关闭。
- 永久门槛：PG6/PG7 不得删除或弱化。
- NEXT：Integration Boundary Review（HTTP/Adapter/Transport 前置边界审计）——下一轮先提交设计/实施计划，不直接开放真实 transport；边界继续 HTTP HOLD · REAL ADAPTER HOLD · TRANSPORT=false · 生产凭据/真实外写/客户提交 HOLD。

## 2026-10-01 JST — Integration Boundary Review 设计/实施计划（R37 送审内容）

- 新增 `docs/releases/INTEGRATION-BOUNDARY-REVIEW-PLAN.md`：分层链路逐层不变量与失败模式；HTTP 身份/权限与跨租户 fail-closed；禁止客户端自证 digest；重放/并发收敛同一 chain；HTTP 失败不得绕过 T1；adapter capability contract 与缺失时的 NEEDS_MANUAL/BLOCK 规则；transport 独立 Gate；H1–H8 验收矩阵与 P1–P5 实施步骤。
- 边界：不接 HTTP、不接真实 adapter、transport 恒关、无生产凭据/真实外写/资金/客户提交。

## 2026-10-01 JST — 裁决 MSG-20261001-22 = PASS WITH REVISE（R37 Integration Boundary Review）

- 归档 §MSG-20261001-22（140 行）→ FULL_COPY_OK；Issue #2 comment 5927474749。
- KEEP：总体边界设计批准（分层链路、HTTP 不直接调 sink、客户端不得自证 digest、账本收敛并发、adapter 能力前置、transport 独立 Gate）。
- CHANGE A：v1 不拆 prepare/submit；CHANGE B：响应显式 platformWriteExecuted=false + executionDisposition；CHANGE C：adapter 三能力走代码注册表 typed descriptor（不新增 DB Schema）+ fail-closed validator；CHANGE D：transport 双重门控。
- NEXT：批准 P1–P5 实施（仅 HTTP 接线/boundary validation/capability registry/gate enforcement/H1–H8+补充断言）；不得实现真实 adapter/credential/provider write；HTTP 必须默认落 NEEDS_MANUAL。

## 2026-10-01 JST — P1 前置：adapter 能力注册表 + transport 双重门控（CHANGE C/D）

- 新增 apps/api/src/services/platform-write/adapter-capability.ts：AdapterCapabilityDescriptor（idempotentWrite / statusQuery / ambiguousResponseSemantics）+ 代码注册表 + evaluateAdapterEligibility（fail-closed：未注册/缺幂等写/ambiguous 未定义/缺 statusQuery）+ evaluateTransportGate（global gate + adapter 合格 + 授权有效，四项缺一 fail-closed）。
- 新增 apps/api/src/__tests__/platform-write-adapter-capability.test.ts：8/8 PASS（含「全局 gate 关闭时即使能力齐备也不得调用 transport」与「gate=true 但 adapter 不合格/授权无效同样 fail-closed」）。
- 未新增数据库 Schema（按 CHANGE C）；未接真实 adapter/凭据；transport 恒关。
- 下一步：P1 主体（路由 + 守卫接线，响应显式 platformWriteExecuted=false / executionDisposition=NEEDS_MANUAL）。

## 2026-10-01 JST — P1 增量：HTTP 响应契约（CHANGE B）

- 新增 apps/api/src/services/platform-write/response-contract.ts：buildPlatformWriteResponse（transport 关闭时 platformWriteExecuted=false、executionDisposition=NEEDS_MANUAL；字段白名单；transport 开启时抛 RESPONSE_CONTRACT_NOT_DEFINED_FOR_ENABLED_TRANSPORT）+ assertNoProviderSuccessFields（providerRef/providerStatus/externalRef/sinkCalls/providerSuccess 黑名单）。
- 新增单测 platform-write-response-contract.test.ts：5/5 PASS。
- 边界：未接线路由、未接真实 adapter、transport 恒关。
- 下一步：P1 主体（路由 + 守卫接线）。

## 2026-10-01 JST — R37 P1/P2：platform.write HTTP 入口接线（路由 + 守卫 + 服务端快照/审批绑定）

- 新增 `apps/api/src/services/platform-write/http-request.ts`：入口编排（HTTP → 守卫 → 服务端快照/审批绑定 → 执行）。
  · 拒绝客户端自证：organizationId / snapshotDigest / basisReference / payloadDigest / payload → 400 PLATFORM_WRITE_CLIENT_ASSERTION_REJECTED（服务端事实只能由服务端重算）。
  · 快照载荷只由 DB 事实构成（caseNo/domain/status/claimedAmount/recoveredAmount/currency/targetKind/targetId/targetStatus/targetRound/evidenceCount）；digest → `basisReference`，`pw1-<sha256(version|digest)>` → 幂等键。
  · 目标解析按 CLAIM（默认 round=1）/ APPEAL（默认最新轮次，同轮多行 → 409 TARGET_AMBIGUOUS）；跨租户与不存在一律 404。
  · 未注入 Action Guard → 403 ACTION_GUARD_NOT_CONFIGURED（fail closed）。
  · transport 恒关 → NEEDS_MANUAL，零投递、零账本写入、不消费审批；并断言 sinkCalls 必须为 0。
  · transport 若被打开：抛 PLATFORM_WRITE_TRANSPORT_NOT_WIRED（503），绝不静默降级（T1/T2/T3 属 P3）。
- 接线：`workflow/http-routes.ts` 新增 `POST /cases/:id/platform/write` 分支 + 结构化错误映射；`server.ts` WORKFLOW_PATH 放行该路径（此前在 server 层就是 404「纸面存在、实际不可达」）。
- 审批策略：`NON_MONEY_APPROVAL_ACTIONS += platform.write`（仅绑定 basisReference = 服务端快照摘要，复用 recovery.review_required/approved 事件族）。
- 新增 `apps/api/src/__tests__/platform-write-http-db.test.ts`：12/12 PASS（真实 HTTP + PostgreSQL）—— H1a 未认证 401 / H1b 跨租户 404 / H2 缺守卫装配 403 / H3a 缺审批 / H3b platform·tenant·gate·默认只读 / H3c 目标不存在 / H3d 非法 targetKind / H4a 客户端自证 400 / H4b 幂等键不一致 409 / H4c 回抄服务端幂等键 200 / H7 合法审批 → 200 NEEDS_MANUAL + 零账本零消费零 platform.write 审计 / H7b 审批绑定他摘要 403 APPROVAL_PAYLOAD_MISMATCH。
- 回归：跨模块 37 files / 470 tests PASS（platform-write + action-guard + tenant-isolation + architecture-contract）；全量 154 files / 1472 tests PASS；tsc PASS；prisma validate valid（未改 Schema）。
- 边界：未接真实 adapter、未开启 transport、无生产凭据/真实外写/资金/客户提交；HTTP 层不直接调用 sink。

## 2026-10-01 JST — R37 P3：T1/T2/T3 编排接线（执行权 + 同事务审批消费 + 门控投递 + 收敛）

- 新增 `services/platform-write/orchestrator.ts`：`runPlatformWriteAttempt` 强制顺序「门控 → T1 → T2 → T3」。
  · transport 双重门控（global gate + adapter 能力 + 守卫授权）任一不满足 → NEEDS_MANUAL，零账本写入、不消费审批、零投递（绝不把未放行写成一条已消费的执行链）。
  · 放行后才执行 T1（`acquireExecutionRight`）——同一事务内完成执行权 CAS、审批唯一绑定与 `recovery.approval_consumed` 消费事实。
  · T2 投递仅接受 `simulated: true` 端口；超时/异常 → 收敛为 MANUAL_REVIEW + UNKNOWN_PROVIDER_RESPONSE，禁止重发写请求。
  · T3 用 `settleAttempt` 的 CAS 收敛（仅 IN_FLIGHT 可收敛）；重放返回既有链状态（REPLAYED），不新增 attempt、不重复消费。
- 新增 `services/platform-write/approval-tx-port.ts`：事务内审批端口（核验复用 `verifyApprovalBoundary`；消费写审计 `recovery.approval_consumed`，含 approvalId / attemptId / boundAction）。
- `prisma-ledger.ts`：`PlatformWriteApprovalInTxPort.verifyInTransaction` 参数扩展为 `PlatformWriteApprovalVerifyArgs`（caseId / actorUserId / targetKind / targetId / now），两处调用点同步传入上下文。
- 新增 `apps/api/src/__tests__/platform-write-orchestrator-db.test.ts`：10/10 PASS（真实 PostgreSQL）—— 01 gate 关闭零副作用 / 02 adapter 未注册 / 03 授权无效 / 04 缺审批 / 05 正常链路（attempt SUCCEEDED + 消费恰 1 + sink 恰 1）/ 06 H5 重放同一链 / 07 H6 并发唯一链 / 08 审批绑定他摘要拒绝 / 09 跨动作冒用拒绝 / 10 H8 断连不重发。
- 回归：platform-write + action-guard 36 files / 352 tests PASS；tsc PASS。
- 边界：未接真实 adapter、未开启 transport、无生产凭据/真实外写/资金/客户提交。
- 待裁决（列入 Checkpoint）：transport 关闭时是否应登记 attempt 并消费审批（现行为为不登记、不消费）。

## 2026-10-01 JST — 裁决 MSG-20261001-23 = PASS WITH REVISE（R38 Integration Boundary Implementation Checkpoint）

- 送审：R38（REVIEWED_HEAD f2e1188；Issue #2 comment 5928265681；CI run 36839484499 SUCCESS）。
- 归档：AI-ARCHITECT-INBOX.md §MSG-20261001-23，逐字 92 行；`tools/verdict-diff/compare.mjs` = **FULL_COPY_OK**（缺失 0 / 多出 0）。
- KEEP：单入口路由、服务端掌握 snapshot/approval/idempotency、transport=false 响应显式未执行、adapter 能力代码注册表、transport 三层 fail-closed、T1/T2/T3 事务边界、ambiguous 不重发、HOLD 项不变；155 files / 1484 tests + CI 接受为回归基线。
- CHANGE A：transport=false 时维持零 attempt / 零审批消费（已批准现有实现）；请求历史不得写成 execution attempt。
- CHANGE B：接受 H5/H6/H8 编排层真实 PostgreSQL 证据；补 HTTP 边界证明（handler→orchestrator 唯一入口 + 五项「不」）。
- CHANGE C：transport=true 成功响应语义本轮不定义。
- CHANGE D：本 checkpoint 建立最小 Golden Path E2E 并纳入 CI。
- NEXT：CHANGE B/D → 全量回归 + CI → R38 RE-REVIEW；之后进入 Provider Adapter Readiness / First Provider Design Gate（非自动开启 transport）。

## 2026-10-01 JST — MSG-20261001-23 CHANGE B/D 实施（HTTP→orchestrator 唯一入口 + 最小 Golden Path E2E）

- CHANGE B：`services/platform-write/http-request.ts` 的安全终点改由编排器产出——`perform` → `runPlatformWriteAttempt`（approvals = 事务内审批端口，`sink: null`，authorizationValid=true）；门控拒绝时返回 NEEDS_MANUAL（`code=GLOBAL_GATE_DISABLED`），零账本、零消费、零投递。
- CHANGE B 契约：入口模块不得出现 acquireExecutionRight / settleAttempt / consumeInTransaction / PlatformWritePort；路由层不得越过入口引用编排或审批端口；T1/T2/T3 仅存在于 orchestrator。
- CHANGE B 兼容：transport=true 仍 503 `PLATFORM_WRITE_TRANSPORT_NOT_WIRED`；非 NEEDS_MANUAL 结果一律拒绝输出 200（响应语义未获批，MSG-23 CHANGE C）。
- CHANGE D：新增 `apps/api/src/__tests__/platform-write-golden-path-db.test.ts`（真实 HTTP + PostgreSQL）—— D1 合法链路安全终点且资金对象全不变、D2 跨租户 fail-closed、D3 缺审批 fail-closed、D4 重复提交同一安全终点。
- 既有断言同步：`platform-write-http-db` 的 H9 由「入口不得引用编排器」更新为「入口必须经编排器且 transport=true 仍失败关闭」（与 MSG-23 CHANGE B 一致）。
- 回归：platform-write 家族 71 tests PASS（7 files）；全量 156 files / 1489 tests PASS；tsc PASS。
- 边界：REAL ADAPTER HOLD · TRANSPORT=false · 生产凭据/真实外写/客户提交 HOLD；未合并 main。

## 2026-10-01 JST — 裁决 MSG-20261001-24 = PASS（R38 RE-REVIEW 收口；Integration Boundary CLOSED）

- 送审：R38 RE-REVIEW（REVIEWED_HEAD a23b8db；Issue #2 comment 5928529942；CI run 36841648944 SUCCESS）。
- 归档：AI-ARCHITECT-INBOX.md §MSG-20261001-24，逐字 56 行；`tools/verdict-diff/compare.mjs` = **FULL_COPY_OK**。
- 裁决要点：唯一执行入口成立（perform 统一进入 runPlatformWriteAttempt，handler 不持 sink/不执行 T1/不消费 approval/不自造 digest）；transport=false 语义正确（零 attempt/零消费/零 sink）；transport=true 未提前定义或开放（仍 503 NOT_WIRED）；Golden Path D1–D4 成为长期回归；156 files / 1489 tests + CI 接受。
- 永久回归基线登记：PG1–PG10、H1–H9、D1–D4、transport=false 零副作用、唯一入口、跨租户与缺审批 fail-closed。
- NEXT：Provider Adapter Readiness / First Provider Design Gate（先设计取证，选 1 个 provider，10 项能力档案；能力不足即 READ-ONLY/NEEDS_MANUAL）。
- 边界：REAL ADAPTER HOLD · TRANSPORT=false · 生产凭据/真实外写/客户提交 HOLD；禁止因「API 能调用」直接开启 global transport gate。

## 2026-10-01 JST — R39 Provider Adapter Readiness（首个样板 provider 取证）

- 选型：首个样板 provider = **Amazon SP-API**（单 provider，不同时做 Amazon/TikTok/Walmart）；理由：业务相关性、官方文档可逐项留证、只读即可产生价值、与现有 adapter 能力声明机制一致。
- 取证（只读）：`developer-docs.amazon.com/sp-api/llms.txt` 索引 + `docs/*.md` 页面（Connect to the SP-API / Authorize Applications / Usage Plans and Rate Limits / SP-API Endpoints / SP-API Sandbox / Application Management API 等）。
- 结论：①⑦⑧⑨ PROVEN；②④⑤ PARTIAL；③（平台级原生幂等写）⑥（不确定响应处置）⑩（最低能力矩阵）**NOT_PROVEN** → 结论 **READ-ONLY / NEEDS_MANUAL**，不降低安全门槛。
- 代码：新增 `services/platform-write/amazon-sp-api-readiness.ts`（只读描述符 + 档案 + `firstProviderWriteDecision()`）、测试 `platform-write-provider-readiness.test.ts`（6 项）；文档 `docs/releases/PROVIDER-ADAPTER-READINESS-AMAZON-SP-API.md`。
- 断言要点：三能力均 false → `eligibility.reason=IDEMPOTENT_WRITE_MISSING`、`eligibleForAutomaticWrite=false`；`globalTransportEnabled=true` 时仍 `ADAPTER_NOT_ELIGIBLE` / `transportAllowed=false`；重复注册幂等。
- 回归：platform-write 家族 + architecture-contract 9 files / 186 tests PASS；tsc PASS。
- 边界：未实现真实 adapter、未申请 provider 应用/角色、未配置凭据、未访问真实账号数据、TRANSPORT=false。

## 2026-10-01 JST — 裁决 MSG-20261001-25 = PASS WITH REVISE

- 送审：R39（REVIEWED_HEAD 79a7d36；Issue #2 comment 5928789033；CI run 36843292912 SUCCESS）。
- 归档：AI-ARCHITECT-INBOX.md §MSG-20261001-25，逐字 75 行；`tools/verdict-diff/compare.mjs` = **FULL_COPY_OK**。
- KEEP：首个样板 Amazon SP-API 批准；READ-ONLY / NEEDS_MANUAL 结论批准；PROVEN·PARTIAL·NOT_PROVEN 分级口径正确；三项未取证能力未落实到具体写操作前不得标 write-eligible。
- CHANGE A：下一批实现只读 adapter boundary（受限范围已列明）；CHANGE B：只读也必须 operation/resource 级 fail-closed，RDT 独立边界；CHANGE C：六项写回前置冻结为 transport 门槛（provider + operation + evidence）。
- 架构方说明：其检索 Amazon 文档未返回结果，故未独立复核我方引用的文档事实；后续涉及 write eligibility 的送审必须附具体官方文档页 / 版本 / 取证日期。
- NEXT：Amazon SP-API READ-ONLY Adapter Implementation Plan → Implementation Checkpoint（不同时开发 TikTok/Walmart）。

## 2026-10-01 JST — R40 Amazon SP-API READ-ONLY Adapter 实施

- CHANGE A：实现只读 adapter boundary 五段 —— descriptor → credential port abstraction → read fetch contract → pagination/rate-limit handling → normalization boundary（落点端口由既有 Runner/ingest 注入）。
- CHANGE B：只读也 fail-closed 到 operation/resource 级：descriptor 显式声明 resource/operation/requiredRoles/requiresRestrictedDataToken/pagination/rateLimit/path；未登记一律拒绝；WRITE 条目（createReport）永远拒绝；RDT 独立能力边界（无 RDT capability 时拒绝受限数据）。
- CHANGE C：六项写回前置代码化为 `AMAZON_WRITE_TRANSPORT_PREREQUISITES` + `isAmazonOperationWriteEligible()`（缺一即 NEEDS_MANUAL）。
- 端口：凭据端口未配置实现抛 `CREDENTIAL_PORT_UNCONFIGURED`（本阶段不接真实凭据）；只读传输端口只有 `get()`；落点端口以 fingerprint 幂等 upsert + quarantine。
- 抓取：分页 NextToken 透传（最多 50 页防失控）；429 退避重试（上限 2000ms，次数耗尽抛 AMAZON_READ_THROTTLED）；5xx/非 200 立即失败，不产生业务记录。
- TEST 十项：未登记 fail-closed / write 永远拒绝 / 无 RDT 拒绝 / 凭据未配置 fail-closed / 分页 token 透传 / 429 不重复 / retry 不绕过 fingerprint 幂等 / malformed·unknown → quarantine / 无 write sink（源码禁词 + GET-only）/ gate=true 仍 ADAPTER_NOT_ELIGIBLE。
- 回归：platform-write + action-guard + read-only = 39 files / 376 tests PASS（PG1–PG10 / H1–H9 / D1–D4 永久基线未受影响）；tsc PASS。
- 边界：未接真实凭据、未访问真实 seller 数据、未申请/扩大 scope、未实现写操作、无 Schema/migration/依赖变更。

## 2026-10-01 JST — 裁决 MSG-20261001-26 = PASS WITH REVISE（R40 CLOSED）

- 送审：R40（REVIEWED_HEAD d3f4722；Issue #2 comment 5929012663；CI run 36845421711 = SUCCESS 已确认）。
- 归档：AI-ARCHITECT-INBOX.md §MSG-20261001-26；`tools/verdict-diff/compare.mjs` = **FULL_COPY_OK**。
- 裁决：R40 只读边界可关闭（条件 CI SUCCESS 已满足）；只读边界的 8 项设计要点全部 KEEP。
- CHANGE B（R41）：fixture-only 贯通既有 Connector Runner / ClaimItem / Quarantine，复用 sourceFingerprint v1、ClaimItem 幂等、cursor 生命周期、quarantine 白名单、normalizerVersion、Runner 审计——目标是证明 Amazon adapter 没有形成平行数据链。
- CHANGE C：写操作仅 docs-only 取证（FBA reimbursement / inventory-loss recovery 优先）；不存在官方写 operation 即记录 NOT AVAILABLE / NOT PROVEN → NEEDS_MANUAL；禁止浏览器自动化绕过。
- 风险提示（架构方）：最大风险是「读取链打通后为闭环强行找写 API」；正确策略是「能安全自动发现和准备证据 ≠ 必须自动提交」，人工一键提交仍是有效产品路径。

## 2026-10-01 JST — R41 Amazon → 既有 Connector Runner 集成（fixture-only）

- 新增 `services/adapters/amazon-sp-connector.ts`：把只读 adapter 暴露为既有 `Fetcher`（单页；NextToken → nextCursor）与既有 `Normalizer`（复用 `sourceFingerprintV1`，只做形状归一化，不做金额判断）。
- `amazon-sp-read-only-adapter.ts` 增加 `fetchAmazonReadPage`（单页 GET + 429 退避）供 cursor 一页一推进；`fetchAmazonReadPages` 改为内部循环调用（原 10 项测试继续通过）。
- 新增 `amazon-sp-connector-runner-db.test.ts`（9 项，真实 PostgreSQL + mocked transport）：证明 Amazon adapter 复用既有 ClaimItem/幂等/cursor/quarantine/normalizerVersion/审计链路，没有平行数据链。
- 关键证据：重放 idempotent=1 且 ClaimItem 计数不变；金额更正（120→999）仍 1 条；quarantine 白名单通过且不含 raw/customer/token；cursor 失败不推进（5xx 后仍为 PAGE-2）；RuleEvaluation/Payment/Settlement/Billing/PlatformWriteAttempt/RecoveryLedgerEntry 全 0。
- 回归：connector + claim-item + amazon = 7 files / 57 tests PASS；tsc PASS。
- 边界：无真实凭据/账号/网络；无 Schema/migration/依赖变更；TRANSPORT=false。

## 2026-10-01 JST — 裁决 MSG-20261001-27 = PASS（R41 CLOSED → R42 计划）

- 送审：R41（REVIEWED_HEAD 9b399f7；Issue #2 comment 5929290849；CI run 36847028087 = SUCCESS）。
- 归档：AI-ARCHITECT-INBOX.md §MSG-20261001-27；`tools/verdict-diff/compare.mjs` = **FULL_COPY_OK**。
- 裁决要点：Amazon 只读 adapter 未形成第二套 ingest/data pipeline，正确复用 Connector Runner → ClaimItem / Quarantine / CursorStore / sourceFingerprint；13 项结果长期保留；R41 PASS_CLOSE。
- 组合根：暂不纳入生产；仅 test/fixture composition、disabled descriptor、无凭据开发装配。
- NEXT：R42 = Amazon FBA Recovery Write-Operation Capability Evidence（DOCS/EVIDENCE ONLY；12 项输出 + 三选一结论）；六项门槛未全达前不得进入 write adapter design，更不得实现。

## 2026-10-01 JST — R42 Amazon FBA 写操作官方能力取证（DOCS ONLY）

- 只读取证：官方 SP-API 文档索引 `llms.txt` 全量计数 + `api/reference` 分册抽样；无账号、无凭据、无写请求。
- 结果：`reimburse` / `claim` / `safe-t` / `a-to-z` / `dispute` 命中均为 **0**；相关域只有只读入口（Finances、FBA Inventory `getInventorySummaries`、Reports `createReport` 仅创建报表任务；inventory 写操作明确 sandbox-only）。
- 结论：**NOT_AVAILABLE / NOT_PROVEN → NEEDS_MANUAL**；六项 transport prerequisites 全部 NOT_PROVEN；Amazon 保持 READ-ONLY，组合根不纳入生产。
- 排除：createReport / reimbursement 查询 / inventory adjustment 查询 / Seller Central UI / Case·Support 泛化能力 / 浏览器自动化。
- 产品路径：自动发现 → 自动核算 → 自动证据包 → **人工一键提交**（不因追求闭环降低 transport 门槛）。

## 2026-10-01 JST — 裁决 MSG-20261001-28 = REVISE（R42 证据语言收紧）

- 送审：R42（REVIEWED_HEAD 5c0591d；Issue #2 comment 5929475487；CI 36848406692 SUCCESS）。
- 归档：AI-ARCHITECT-INBOX.md §MSG-20261001-28；`tools/verdict-diff/compare.mjs` = **FULL_COPY_OK**。
- CHANGE A：结论语言收紧为 PUBLIC WRITE OPERATION NOT FOUND / NOT_PROVEN（证据强度匹配结论强度；不使用无条件 NOT_AVAILABLE）。
- CHANGE B：新增 operation-level negative evidence matrix（7 类 domain/API → closest candidate → why NOT recovery submission），使 negative evidence 可复审。
- CHANGE C：三级状态（PROVEN_AVAILABLE / PROVEN_UNAVAILABLE / NOT_PROVEN）；本轮 NOT_PROVEN + executionDisposition=NEEDS_MANUAL。
- 后续：提交 R42 RE-REVIEW（docs-only）；通过后不再研究 Amazon 自动写入，转入 R43 — Amazon Manual Recovery Handoff Design（把已证明可做的只读能力连成可用闭环）。

## 2026-10-01 JST — 裁决 MSG-20261001-29 = PASS（R42 关闭 → R43 设计授权）

- 送审：R42 RE-REVIEW（REVIEWED_HEAD 419489b；Issue #2 comment 5929706917；CI 36849923746 SUCCESS）。
- 归档：AI-ARCHITECT-INBOX.md §MSG-20261001-29；`tools/verdict-diff/compare.mjs` = **FULL_COPY_OK**。
- 裁决：CHANGE 无；**R42 正式关闭**（不再继续 Amazon 自动写入能力搜索）；风险转为「未来 evidence revision」。
- NEXT：**R43 — Amazon Manual Recovery Handoff Design（仅 Design Proposal，不实现）**：ClaimItem → Evidence Completeness → Recovery Package → Human Approval → Submission Instructions/Export → SUBMITTED_MANUAL → Outcome Tracking → Reimbursement/Settlement Reconciliation；12 项重点 + 四事实分离（生成材料 ≠ 已提交 ≠ 已受理 ≠ 已赔付）。
- 边界冻结：AMAZON WRITE HOLD · REAL WRITE ADAPTER HOLD · TRANSPORT=false · 生产凭据/真实外写 HOLD。

## 2026-10-01 JST — 裁决 MSG-20261001-30 = PASS WITH REVISE（R43 设计）

- 送审：R43 Design Proposal（REVIEWED_HEAD 07b7009；Issue #2 comment 5929951886）。
- 裁决：方向批准；CHANGE A（SUBMITTED_MANUAL 走 ClaimItem 状态机，AuditLog 仅证据；新字段先提 Schema Delta）/ B（`recovery.manual_submit`；approval 绑定 claimItemId+caseId+packageDigest；原子消费；并发至多一次）/ C（PDF + JSON manifest；24 个月；时间桶不作幂等依据）/ D（Reconciliation 与 Settlement/Billing 分离）。
- NEXT：R43-A — Manual Recovery Persistence Schema Delta Request（docs-only，8 项持久化边界）；获批后再提交 R43 Implementation Plan。
- 风险提示（架构方）：最大风险是把 AuditLog 变成第二套业务数据库 —— 业务事实持久化与审计证据必须分离；人工提交虽无平台写 API，其审批绑定/并发/幂等/TOCTOU 必须达到 claim.submit / appeal.submit 同级。

## 2026-10-01 JST — 档案 MSG-20261001-30 = PASS WITH REVISE（R43 设计）

- 来源：R43 Design Proposal 送审（REVIEWED_HEAD 07b7009；Issue #2 comment 5929951886；CI 36851952191）。
- 归档：`AI-ARCHITECT-INBOX.md` → `MSG-20261001-30`；`tools/verdict-diff/compare.mjs` = **FULL_COPY_OK**。
- CHANGE A：SUBMITTED_MANUAL 不得只靠 AuditLog 推导，必須走既有 `ClaimItemStatus.SUBMITTED_MANUAL` 状态機；AuditLog = append-only 证據；providerCaseRef/submittedAt/submittedBy/submissionEvidence 先提 Schema Delta。
- CHANGE B：動作名批准 `recovery.manual_submit`；OWNER/ADMIN 可批准，執行者須當前 ACTIVE member 且執行時重驗；approval 绑定 `claimItemId + caseId + packageDigest`（不得裸 digest）；package 變化 → 舊批准失效；消费與確認原子。
- CHANGE C：第一版導出 = PDF + machine-readable JSON manifest（先定義 artifact）；证據只引用既有 EvidenceArtifact/FileAsset；默认 24 個月保留；時間桶不作為提交鏈核心幂等依據。
- CHANGE D：Reconciliation 與資金域繼續分離（只輸出 matched/unmatched/ambiguous）；後續單獨提交 Recovery Reconciliation → Settlement Boundary Design。
- TEST 清單（11 條）納入 R43-A 驗收要求。
- NEXT：**R43-A — Manual Recovery Persistence Schema Delta Request（docs-only，8 項持久化邊界）**；Schema Delta 獲批後才提 R43 Implementation Plan。
- 邊界：AMAZON WRITE HOLD · REAL WRITE ADAPTER HOLD · TRANSPORT=false · PRODUCTION CREDENTIALS HOLD · REAL EXTERNAL WRITE HOLD · SETTLEMENT/BILLING LINKAGE HOLD。

## 2026-10-01 JST — R43-A 送审 + MSG-20261001-31 = PASS WITH REVISE

- R43-A 送审：REVIEWED_HEAD f2a20b9；Issue #2 comment 5930157696；CI 36853926652；docs-only。
- 档案：`AI-ARCHITECT-INBOX.md` → `MSG-20261001-31`；`tools/verdict-diff/compare.mjs` = **FULL_COPY_OK**。
- 裁决：PASS WITH REVISE。4 表（RecoveryPackage / RecoveryPackageArtifact / RecoveryManualSubmission / RecoveryManualSubmissionEvidence）架架批准；8 問全部有結論。
- CHANGE A：區分不可變事實與生命週期狀態 —— artifact/submission/submission-evidence 全表 immutable；RecoveryPackage 僅核心字段 immutable，status 只能經受控 CAS；SUPERSEDED/WITHDRAWN 必須帶 reason + actor + audit；實現前定義可變字段白名單。
- CHANGE B：approvalId 必須進入單鏈不變量（同一 approval 不得授權兩條 submission；UNIQUE(organizationId, approvalId)；創建時必有則設 required）。
- CHANGE C：providerCaseRef 唯一性必須用 canonical value（trim → Unicode normalize → provider 特定歸一化）；不得擅自降小寫。
- TEST：M1–M11 接受作基礎矩陣，另增 9 項（雙向一致性、同 approval 並發、digest/binding 不可改、CAS 合法性、immutable UPDATE 被拒、canonical 重複被拒、ref 為空仍可確認、補錄不改變 accepted 事實、checker 只報告）；PG/H/D 基線保留。
- NEXT：**R43-B — Manual Recovery Persistence Implementation Plan（docs-only，10 項）**；不需再送一輪 Schema Request；經審後才編碼。
- 邊界：AMAZON WRITE HOLD · REAL WRITE ADAPTER HOLD · TRANSPORT=false · PRODUCTION CREDENTIALS HOLD · REAL EXTERNAL WRITE HOLD · SETTLEMENT/BILLING LINKAGE HOLD。

## 2026-10-01 JST — R43-B 送审 + MSG-20261001-32 = PASS WITH REVISE

- R43-B 送审：REVIEWED_HEAD 409dbd0；Issue #2 comment 5930209791；CI 36854327085；docs-only。
- 档案：`AI-ARCHITECT-INBOX.md` → `MSG-20261001-32`；`tools/verdict-diff/compare.mjs` = **FULL_COPY_OK**。
- 裁决：PASS WITH REVISE。Implementation Plan 主体批准；4 项实施细节（risk=INTERNAL_WRITE、append-only 清单、checker 只报告、PDF 依赖）均有结论。
- CHANGE A：providerCaseRef 补录与 Submission 整行 append-only 冲突 → 推荐新增第五张 append-only 表 `RecoveryManualSubmissionReference`；不批准在 append-only Submission 上直接 UPDATE。
- CHANGE B：`RecoveryPackage.EXPORTED` 不得为不可逆终态（终态仅 SUPERSEDED/WITHDRAWN）；export 应表达为 append-only export event/artifact。
- CHANGE C：approval basis 必须绑定 packageVersion + digestVersion，且审批创建与执行共用同一个服务端 canonical builder。
- TEST：新增 M21–M28（八项）；与 M1–M20、PG1–PG10 / H1–H9 / D1–D4 合并为长期基线。
- NEXT：无需再提交 docs-only 复审；可直接进入 **R43 Implementation S1**（Schema + migration + triggers + trigger inventories + fresh/upgrade tests）→ 单独 Implementation Checkpoint；S1 通过后才能进入 S2–S5。
- 边界：AMAZON WRITE HOLD · REAL WRITE ADAPTER HOLD · TRANSPORT=false · PRODUCTION CREDENTIALS HOLD · REAL EXTERNAL WRITE HOLD · SETTLEMENT/BILLING LINKAGE HOLD。

## 2026-10-01 JST — R43 Implementation S1（Schema / migration / triggers）实现 + Checkpoint 送审

- 依据：MSG-20261001-32 = PASS WITH REVISE NEXT（完成 CHANGE A/B/C 后可直接进入 R43 Implementation S1，S1 单独 Checkpoint）。
- Schema：5 表 + 2 枚举（RecoveryPackage / RecoveryPackageArtifact / RecoveryManualSubmission / RecoveryManualSubmissionReference / RecoveryManualSubmissionEvidence）；模型计数 39 → **44（40 core + 4 join）**。
- 迁移 5 支：M1 表结构（migrate diff 生成）→ M2 租户触发器（29→42 条）→ M3 package 受控变更（核心字段不可变 / EXPORTED 非终态 / 终态需 reason+actor）→ M4 四张 append-only（artifact/submission/reference/evidence）→ M5 完整性 CHECK（digest/sha hex64；canonical 非空+trim+NFKC+空白折叠，不做大小写折叠）。
- Trigger inventory：新增 `tools/tenant-triggers/append-only-triggers.json` + `emit-check-append-only-sql.mjs`（正向 + 反向）；CI 新增独立步骤（fresh）；`two-stage-upgrade.mjs` 新增同清单断言（upgrade）。
- 证据：prisma validate valid / generate OK / migrate deploy 5 支全部成功；**two-stage upgrade = TWO_STAGE_UPGRADE_OK**（两套清单 OK · immutability=42 · 二次 deploy 幂等）；**S1 DB 测试 10/10 PASS**；回归 **43 files / 523 tests PASS**；tsc PASS。
- 记录在案：计划中的 M6（第五张 reference 表）已合并进 M1，未新增第六支迁移。
- 送审：REVIEWED_HEAD d39c53e；Issue #2 comment 5930423157；CI 36855842245；唤醒已投递并验证。
- 边界：S1 未注册受保护动作、未实现服务层/HTTP、未接凭据、未开 transport、未触碰资金域；无新增依赖。

## 2026-10-01 JST — MSG-20261001-33 = PASS（R43 S1 关闭）→ 进入 R43 S2

- 裁决：**PASS**（REVIEWED_HEAD d39c53e）。S1（Schema / migration / triggers / trigger inventories / fresh·upgrade 取证）可关闭；M6 合并进 M1 获认可；append-only 独立清单方案满足 MSG-32 条件。
- 档案：`AI-ARCHITECT-INBOX.md` → `MSG-20261001-33`；`tools/verdict-diff/compare.mjs` = **FULL_COPY_OK**。
- NEXT：**R43 S2 — Recovery Package Implementation**（package generation → canonical JSON manifest → digest/version → artifact generation → package CAS lifecycle）。
- S2 禁止：不注册 recovery.manual_submit / 不消费 approval / 不改 ClaimItem 状态 / 不创建 RecoveryManualSubmission / 不接 HTTP submission confirmation / 不做 Amazon 外写 / 不联动 Settlement·Billing。
- S2 风险：材料包身份稳定性（key 顺序 / 时间格式 / Decimal 表达不得影响 digest；非业务 metadata 不得进入 identity；digest 与 packageVersion + digestVersion 共同绑定）。
- S2 验收 12 项（见 STATE.r43s1_verdict.s2_tests）。
- 边界：AMAZON WRITE HOLD · REAL WRITE ADAPTER HOLD · TRANSPORT=false · PRODUCTION CREDENTIALS HOLD · REAL EXTERNAL WRITE HOLD · SETTLEMENT/BILLING LINKAGE HOLD。

## 2026-10-01 JST — R43 S2（Recovery Package Implementation）实现 + Checkpoint 送审

- 交付：`apps/api/src/services/recovery/recovery-package.ts` —— canonical manifest（稳定序列化 + Decimal 固定 4 位 + UTC ISO 毫秒 + null 契约 + 数组字典序）、（ 64hex）、approval basis 唯一 builder、package CAS 生命周期（EXPORTED 非终态；终态需 reason+actor）、零依赖 PDF 派生、artifact 落库（只引用 FileAsset）。
- 测试：`recovery-manual-package.test.ts` 9 项 + `recovery-manual-package-db.test.ts` 6 项 = **15/15 PASS**（含 key 顺序无关、非业务 metadata 不进入 identity、CAS 并发至多一次真实跃迁、陈旧期望拒绝、artifact 幂等、边界：无 SUBMITTED_MANUAL / 无 submission / 无 approval 消费 / 资金域全 0）。
- 回归：43 files / 519 tests PASS（另一组合 43/523 亦全绿）；tsc PASS。
- PDF 依赖：仓库仅有 `@prisma/client` → 采用**零依赖最小 writer**，未新增依赖（无 dependency delta）。
- 送审：REVIEWED_HEAD 4ad4016（Issue #2 comment 5930531626 / CI 36856596781）；唤醒已投递并验证。
- 边界：S2 未注册 recovery.manual_submit、未消费 approval、未改 ClaimItem 状态、未创建 RecoveryManualSubmission、未接 HTTP confirmation、未外写、未联动 Settlement·Billing。

## 2026-10-01 JST — MSG-20261001-34 = PASS（R43 S2 关闭）→ 进入 R43 S3

- 裁决：**PASS**（REVIEWED_HEAD 4ad4016）。S2 可关闭；零依赖 PDF writer 认可；`buildRecoveryPackageBasisReference()` 认可为唯一 approval-binding builder 并冻结为长期不变量。
- 档案：`AI-ARCHITECT-INBOX.md` → `MSG-20261001-34`；`tools/verdict-diff/compare.mjs` = **FULL_COPY_OK**。
- NEXT：**R43 S3 — recovery.manual_submit**（注册 + 锁内重验 + 原子人工提交确认）。
- S3 严格顺序：advisory lock → ClaimItem FOR UPDATE → 锁后重读成员/角色 → READY_TO_APPEAL → 锁定目标 package（非终态）→ 服务端重构 versioned basis → verifyApprovalBoundary → CAS 跃迁 SUBMITTED_MANUAL → INSERT submission + evidence links → 写 recovery.manual_submitted + recovery.approval_consumed（同一事务）；失败则三者均不推进/创建/消费；拒绝审计回滚后写。
- S3 验收 14 项（见 STATE.r43s2_verdict.s3_acceptance）。
- 边界：S3 不得顺带 providerCaseRef 后补 / outcome tracking / reconciliation / Settlement linkage；AMAZON WRITE HOLD · REAL WRITE ADAPTER HOLD · TRANSPORT=false · SETTLEMENT/BILLING LINKAGE HOLD。

## 2026-10-01 JST — R43 S3（recovery.manual_submit）实现 + Checkpoint 送审

- 交付：`services/recovery/manual-submission.ts`（锁内重验 + 原子提交）+ Action Guard 注册（catalog / 常量 / scope / guard-enforcement）+ S3 数据库测试 13 项。
- 顺序：case advisory lock → ClaimItem FOR UPDATE → 锁后重读成员/角色 → READY_TO_APPEAL → 锁定 package（非终态）→ 服务端 versioned basis → verifyApprovalBoundary → CAS → submission + evidence → manual_submitted + approval_consumed（同事务）；拒绝留痕回滚后写。
- 证据：S3 13/13 PASS；回归 46 files / 551 tests PASS；tsc PASS；未改 Schema/migration/触发器清单；无新增依赖。
- 送审：REVIEWED_HEAD b6be095（Issue #2 comment 5930644528 / CI 36857439876）；唤醒已投递并验证。
- 边界：S3 未实现 providerCaseRef 后补 / outcome tracking / reconciliation / Settlement·Billing 联动 / 平台外写。

## 2026-10-01 JST — MSG-20261001-35 = REVISE（R43 S3）收口

- 裁决：**REVISE**（REVIEWED_HEAD b6be095）。主体 KEEP；执行人权限沿用 claimTrackingApprove 认可；审计动作名认可；计数口径注意事项（非阻塞）。
- CHANGE A：补“成功审计失败 → 整体回滚”故障注入（新增可注入审计端口，生产默认实现不变）。
- CHANGE B：补“approval_consumed 写入失败 → 整体回滚”（功能点在成功审计之后），并验证重试仍可提交。
- CHANGE C：补 digestVersion 与 packageDigest 不匹配 → 拒绝且零推进零消费。
- 证据：S3 测试 13 → **16/16 PASS**；tsc PASS。
- NEXT：R43 S3 RE-REVIEW（仅补 CHANGE A/B/C + S3-A…S3-R 映射）。

## 2026-10-01 JST — R43 S3 RE-REVIEW 送审（CHANGE A/B/C 收口）

- CHANGE A：新增可注入审计端口（生产默认实现不变），注入“成功审计写入失败”→ 整体回滚（ClaimItem 仍 READY_TO_APPEAL · Submission/Evidence/两条审计均 0 · approval 仍可合法使用）。
- CHANGE B：注入“approval_consumed 写入失败”→ 整体回滚（不进入 SUBMITTED_MANUAL · 成功审计不残留 · 重试后仍可提交）。
- CHANGE C：digestVersion 与 packageDigest 不匹配 → APPROVAL_PAYLOAD_MISMATCH + 零推进零消费（五元 basis 全部参与执行时绑定）。
- 验收映射：S3-A…S3-R 已在送审正文逐项映射；计数口径分开（16 测试用例 / 18 验收条目）。
- 证据：S3 16/16 PASS；受影响家族 34 files / 329 tests PASS；tsc PASS。
- 送审：REVIEWED_HEAD 4c6c865（Issue #2 comment 5930712620 / CI 36857749399）；唤醒已投递并验证。

## 2026-10-01 JST — MSG-20261001-36 = PASS（R43 S3 正式关闭）→ 进入 R43 S4

- 裁决：**PASS**（REVIEWED_HEAD 4c6c865）。CHANGE A/B/C 全部收口；ManualSubmissionAuditPort 可保留；五元 basis 防篡改边界完整；S3-A…S3-R 映射清晰。
- 永久基线：READY_TO_APPEAL → SUBMITTED_MANUAL + Submission + Evidence + manual_submitted + approval_consumed 全有或全无；两条故障注入测试不得删除。
- 档案：`AI-ARCHITECT-INBOX.md` → `MSG-20261001-36`；`tools/verdict-diff/compare.mjs` = **FULL_COPY_OK**。
- NEXT：**R43 S4 — providerCaseRef canonical 补录 + protected action**（12 项要求）；S4 不得进入 outcome/reconciliation。

## 2026-10-01 JST — R43 S4（providerCaseRef canonical 补录）实现 + Checkpoint 送审

- 交付：`services/recovery/manual-reference.ts` + Action Guard 注册（独立动作）+ S4 数据库测试 7 项。
- 动作：`recovery.manual_submit_reference_recorded`（INTERNAL_WRITE + humanApproval）；独立 binding `rmr1:<submissionId>:<claimItemId>:<canonical>`（不得复用 S3 approval）。
- canonical：trim → NFKC → 去零宽 → 折叠空白；**不 lower-case**；canonical duplicate 由 DB UNIQUE 兜底（PROVIDER_CASE_REF_CONFLICT）。
- 12 项要求：不 UPDATE Submission / raw+canonical 分开 / 空 ref 拒绝 / 跨租户·错 submission·非 ACTIVE 成员 fail-closed / 并发至多一次 / 不产生 accepted·reimbursed·recovered / 不改 ClaimItem 状态 / 不消费旧 approval / 独立 action+binding / 读取展示语义。
- 证据：S4 7/7 PASS；回归 35 files / 336 tests PASS；tsc PASS；未改 Schema/migration/触发器清单；无新增依赖。
- 送审：REVIEWED_HEAD 6b5ec65（Issue #2 comment 5930826355 / CI 36858596490）；唤醒已投递并验证。

## 2026-10-01 JST — MSG-20261001-37 = PASS（R43 S4 关闭）→ 进入 R43 S5

- 裁决：**PASS**（REVIEWED_HEAD 6b5ec65）。S4 关闭；动作名 + rmr1: independent binding 认可；canonical 不 lower-case + DB unique 认可。
- 非阻塞建议：未来新增动作优先“动作/命令”命名；报告口径 = 实际 test case 数 + acceptance 条目数。
- 档案：`AI-ARCHITECT-INBOX.md` → `MSG-20261001-37`；`tools/verdict-diff/compare.mjs` = **FULL_COPY_OK**。
- NEXT：**R43 S5 — Read-only Consistency Checker + CI**（12 项只读检查 + CI fresh/upgrade/clean/drift）；S5 不得实现 repair mode；完成后 S6 全量回归收口。

## 2026-10-01 JST — R43 S5（只读一致性 checker + CI 接线）实现 + Checkpoint 送审

- 交付：`tools/consistency/check-recovery-manual-submission.mjs`（12 项只读检查，`buildRecoveryManualConsistencySql()` 生成单个 DO 块，CLI 仅打印 SQL）+ `recovery-manual-consistency-checker-db.test.ts` 5 项 + CI 与 two-stage upgrade 双路径接线。
- 语义：clean → psql 退出码 0；人工漂移 → RAISE EXCEPTION → 非零；生成 SQL 不含任何写语句（INSERT/UPDATE/DELETE/ALTER/DROP/TRUNCATE）；**不实现 repair mode**。
- 证据：S5 5/5 PASS（真实 PostgreSQL）；本地 psql clean 实测退出码 0（NOTICE OK）；TWO_STAGE_UPGRADE_OK（含 checker upgrade path）；tsc PASS；未改 Schema/migration/触发器清单；无新增依赖。
- 送审：REVIEWED_HEAD a2c4306（Issue #2 comment 5930927792 / CI 36859106365）；唤醒已投递并验证。

## 2026-10-01 JST — MSG-20261001-38 = PASS WITH REVISE（R43 S5 关闭）→ 进入 R43 S6

- 裁决：**PASS WITH REVISE**（REVIEWED_HEAD a2c4306）。S5 主体关闭，**无需 S5 RE-REVIEW**，直接进入 S6 全量收口。
- 认可：纯只读 checker 无 repair mode；clean→0 / 漂移→非零；fresh deploy 与 two-stage upgrade 双路径接入；12 项检查 + DETECT ≠ REPAIR 为长期不变量；终态 package → NOTICE 语义认可（历史合法 submission 不因后续 supersede/withdraw 被判损坏）。
- CHANGE A（S6 补齐）：approval 语义强校验回归 —— organization / approvalId 一致、action = recovery.manual_submit、basisReference 与 submission 保存的 versioned basis 一致、且不是另一个 ClaimItem·package 的合法 approval（现有 SQL 已覆盖则给 test-name 映射，否则补 checker）。
- CHANGE B（S6 补齐）：真实可制造漂移覆盖 —— 至少一组 DB 允许存在但业务不一致的漂移，证明 DB accepts fixture → checker rejects → zero repair。
- S6 报告矩阵：M1–M20 / PG1–PG10 / H1–H9 / D1–D4 / S2–S5 基线 / fresh migration / two-stage upgrade / trigger inventories / architecture contract / tsc / prisma validate / 全量 suite；**不得 skip、放宽断言或删除历史安全测试收绿**。
- 档案：`AI-ARCHITECT-INBOX.md` → `MSG-20261001-38`；`tools/verdict-diff/compare.mjs` = **FULL_COPY_OK**。
- NEXT：**R43 S6 — Full Regression / Release Checkpoint**（不新增产品能力）；完成后提交最终 R43 Implementation Checkpoint，由架构方判定 R43 是否整体关闭。

## 2026-10-01 JST — R43 S6 Full Regression / Release Checkpoint 送审（CHANGE A/B 收口）

- 依据：MSG-20261001-38 = PASS WITH REVISE（S5 关闭，免 S5 RE-REVIEW，直接进入 S6）。
- CHANGE A（补齐 checker，而非仅映射）：新增第 5c 项 approval 语义强校验 —— approval 事件必须同租户、`action=recovery.review_approved`、目标为本单位 Case（entityType/entityId）、`boundAction=recovery.manual_submit`、`boundPayload.basisReference` 等于 submission 保存的 versioned basis（五元复合串天然排除他案/他包 approval）、`fingerprintVersion=v1`。
- CHANGE B（DB 接受 → checker 拒绝 → 零修复）：状态漂移 [2]、basis 漂移 [3]、approval binding 漂移 [5c]（S6-A1/A2/A3）、reference 租户漂移 [7]（S6-B2）；非 canonical 形状与同租户重复 canonical 由 DB CHECK/UNIQUE 直接 fail-closed（S6-B1/B3，不绕过约束），checker 8a/8b 为纵深防御。
- 证据：checker 测试 5 → 11 项全绿；全量 suite **165 files / 1574 tests PASS**（真实 PostgreSQL，无 skip/放宽/删除历史测试）；tsc PASS；prisma validate valid；tenant 触发器 42 baseline/42 immutable/2 scoped；append-only 5；checker clean 退出码 0；two-stage upgrade TWO_STAGE_UPGRADE_OK（含升级路径三套清单与非法写入拒绝）。
- 本地备注：migration-checksum 对 20260930100000 的本地误报由 CRLF 行尾造成（hash(CRLF)≠pinned；LF 归一后一致），CI 为权威。
- 送审：REVIEWED_HEAD f77da82（Issue #2 comment 5931572320 / CI 36861687249 success（5/5 jobs: API / Deploy smoke / Backup restore verify / Web typecheck+build / 许可证闸门））；唤醒已投递并验证。
- HOLD 保持：AMAZON WRITE HOLD · REAL WRITE ADAPTER HOLD · TRANSPORT=false · PRODUCTION CREDENTIALS HOLD · REAL EXTERNAL WRITE HOLD · SETTLEMENT/BILLING LINKAGE HOLD。

## 2026-10-01 JST — MSG-20261001-39 = PASS（R43 整体关闭）→ 进入 R44 Manual Recovery HTTP/API Boundary

- 裁决：**PASS — R43 CLOSED**（REVIEWED_HEAD f77da82；CI 36861687249 = SUCCESS 5/5）。S6 关闭；**R43 Manual Recovery Persistence（S1–S6）整体关闭**，不再创建 S7/S8。
- CHANGE A/B 收口：A 已从“存在 approval”提升为对当前 submission 的授权语义验证（tenant + approved event + Case target + recovery.manual_submit + exact versioned basis + fingerprintVersion=v1）；B 形成 DB accepts intentional drift → checker rejects → snapshot unchanged，且未绕过 CHECK/UNIQUE/FK。
- R43 完成定义（冻结）：ClaimItem → RecoveryPackage → Human Approval → atomic manual submission fact → optional provider reference → immutable evidence/audit trail → consistency verification。
- 永久基线（冻结）：M1–M28 + PG1–PG10 + H1–H9 + D1–D4 + canonical/digest determinism + approval semantic binding + transaction failure rollback + concurrency/exactly-once + reference canonicalization + checker intentional drift + fresh deploy + two-stage upgrade + tenant/immutable/append-only trigger inventories + architecture/audit contracts；后续不得删除/skip/弱化。
- 遗留被接受为范围之外（三个独立后续边界）：HTTP/API Exposure（R44）、Outcome & Reimbursement Reconciliation（R45）、Settlement/Billing Linkage（R46）。
- NEXT：**R44 — Manual Recovery HTTP/API Boundary**（仅入口边界；不得实现 outcome/reconciliation、不得联动 Settlement/Billing、不得开启任何 Amazon write transport）。
- 档案：`AI-ARCHITECT-INBOX.md` → `MSG-20261001-39`；`tools/verdict-diff/compare.mjs` = **FULL_COPY_OK**。
- HOLD 保持：AMAZON WRITE HOLD · REAL WRITE ADAPTER HOLD · TRANSPORT=false · PRODUCTION CREDENTIALS HOLD · REAL EXTERNAL WRITE HOLD · SETTLEMENT/BILLING LINKAGE HOLD。

## 2026-10-01 JST — HOST DIRECTIVE：冻结底座 + 加速交付（策略落库）

- 宿主指示：已 PASS 底座默认冻结；新能力复用 Recovery OS 内核 + Adapter + Connector + Rule Pack；仅 8 类边界触发架构级审计；开源/既有能力优先复用；编排工具仅限外围；节奏 IMPLEMENT → targeted tests → commit → CI → 风险分类；ChatGPT 审计改为增量风险审计。
- 落库：`docs/releases/DELIVERY-ACCELERATION-POLICY.md`（全文）+ `AGENTS.md` §三·五（协作规则）+ `.autopilot/STATE.json`（delivery_acceleration）+ 本任务清单。
- 状态口径：每轮回报须含 FOUNDATION_REUSED / NEW_RISK_BOUNDARY / ARCH_REVIEW_REQUIRED。
- 对账：宿主点名的 Prisma ledger port / T1–T3 / R1 / approval_consumed 同事务 / T2 事务外投递 / PG1–PG10 / reconcile 策略测试，已属 platform-write ledger 批次（MSG-20261001-21 PASS CLOSED），无需重复审计。
- NEXT：R44 — Manual Recovery HTTP/API Boundary（仅入口边界；复用 R43 S3/S4 服务，不复制事务逻辑）。
- 记录时 HEAD：0029d46。

## 2026-10-01 JST — R44 Manual Recovery HTTP/API Boundary 实现 + 增量风险审计送审

- 新增边界（唯一）：`POST /cases/:caseId/recovery/manual-submit` 与 `POST /cases/:caseId/recovery/manual-reference`（受保护动作入口；复用 R43 S3/S4 服务）。
- 入口不变量：租户/身份来自会话与路径；跨租户或错案件 404；服务端事实字段（digest / basis / version / canonical / status / submittedAt）出现在请求体一律 400；幂等键服务端派生 rms1-<claimItemId>，不一致 409；Action Guard 未注入 403、缺审批 409；入口层零事务（静态探针无 $transaction / FOR UPDATE / updateMany / pg_advisory）；响应恒 platformWriteExecuted=false。
- 证据：`recovery-manual-http-db.test.ts` 10/10 PASS（真实 HTTP + PostgreSQL）；recovery-manual-* 69/69；action-guard 家族 62/62；tsc PASS；api-contract OK；prisma validate valid（未改 Schema）。
- 风险分类：FOUNDATION_REUSED = R43 持久化底座 + platform.write 入口范式；NEW_RISK_BOUNDARY = YES（两个对外入口）；ARCH_REVIEW_REQUIRED = YES（增量）。
- Known gap：recovery.manual_submit 审批的创建入口尚未暴露（reviewRecovery 拒绝该 boundAction）→ 独立批次。
- 送审：REVIEWED_HEAD 219a67c（Issue #2 comment 5931742832 / CI 36863814805）；唤醒已投递并三要素验证。
- HOLD 保持：AMAZON WRITE HOLD · REAL WRITE ADAPTER HOLD · TRANSPORT=false · PRODUCTION CREDENTIALS HOLD · REAL EXTERNAL WRITE HOLD · SETTLEMENT/BILLING LINKAGE HOLD · Production Enablement HOLD。

## 2026-10-01 JST — MSG-20261001-40 = PASS WITH REVISE（R44 入口边界）

- 裁决：**PASS WITH REVISE**（REVIEWED_HEAD 219a67c）。R44 两个入口的原则、契约与零事务入口层获得认可；CI 送审时仍 in_progress。
- CHANGE A：两个 endpoint 必须各自有跨租户 / wrong-case 的 HTTP 404 证据，并断言失败后 ClaimItem / Submission·Reference / approval consumption / 资金域全部不变（防 confused-deputy 对象绑定漏洞）。
- CHANGE B：精确 HEAD 的 CI 必须最终 SUCCESS。
- 口径修正（架构方要求）：R44 = Manual Recovery **Execution** HTTP Boundary，**不是**完整用户可用 E2E；审批创建入口缺失属独立批次 **R44-A — Approval Creation Boundary**；文档不得写成「完整可用」。
- 档案：`AI-ARCHITECT-INBOX.md` → `MSG-20261001-40`；`compare.mjs` = **FULL_COPY_OK**。
- NEXT：补 CHANGE A + 等 CI SUCCESS → R44 RE-REVIEW。

## 2026-10-01 JST — R44 RE-REVIEW 送审（CHANGE A 收口 + CHANGE B CI SUCCESS）

- CHANGE A：`recovery-manual-http-db.test.ts` 10 → 14 用例 —— R44-11 manual-submit 跨租户案件 → 404；R44-12 同租户错案件 → 404；R44-13 manual-reference 跨租户 submission → 404；R44-14 同租户错案件 submission → 404（防 confused-deputy）；每条断言失败零副作用（ClaimItem / Submission·Reference / approval consumption / Settlement / Billing）。
- CHANGE B：09e9f6d CI = success 5/5；RE-REVIEW 头 eca4207 CI = success 5/5。
- 偶发失败修复（SELF_RESOLVE / CI 修复）：R43 夹具 review_required / review_approved 未显式写 createdAt，同毫秒触发 `APPROVAL_NOT_APPROVED`（bd6d330 API job 3 例）→ 显式有序 createdAt（required −2s / approved −1s）；**断言与生产代码零变化**，仅消除毫秒级不确定性。
- 口径修正：R44 = Manual Recovery **Execution** HTTP Boundary（非完整用户可用 E2E）；审批创建入口另立 **R44-A**。
- 送审：REVIEWED_HEAD eca4207（Issue #2 comment 5932108490 / CI 36865362444 success 5/5）；唤醒已投递并三要素验证。
- HOLD 保持：AMAZON WRITE HOLD · REAL WRITE ADAPTER HOLD · TRANSPORT=false · PRODUCTION CREDENTIALS HOLD · REAL EXTERNAL WRITE HOLD · SETTLEMENT/BILLING LINKAGE HOLD。

## 2026-10-01 JST — 持久规则 R10：开源优先复用 + 商用许可证统一机制

- 落盘：`.autopilot/RULES.md`（新增 R10 全节）+ `.autopilot/rules.json`（`open_source_reuse`）+ `docs/releases/OPEN_SOURCE_REUSE_MATRIX.md` + `tools/license-gate/oss-registry.json` + `tools/license-gate/check-oss-registry.mjs`（复用既有 license-gate，不新建第二套系统）+ `tools/license-gate/allowlist.json`（A/B/C 等级映射）+ CI license-gate job 新增校验步骤 + runner HEARTBEAT 增加 `reuse_policy`。
- 分类：EXISTING / LEGACY_REUSE / OSS_NOW / OSS_LATER / REJECT，五档必须在新模块开工前判定；登记字段 14 项（含 model_weight_license）。
- 边界：LLM 不得决定 金额 / Fee / Deadline / Ledger / Settlement / Billing / 状态推进 / 权限判断 / 审批消费；编排工具仅限外围；禁止大换底座（冻结 Recovery OS 等）。
- 校验：`node tools/license-gate/check-oss-registry.mjs --root .` = OSS_REUSE_LICENSE_OK；`tools/license-gate/check-licenses.mjs` = 通过；`tools/autopilot/check-autopilot-rules.mjs` = AUTOPILOT_RULES_OK。
- 队列不受影响：R43 S3→S4→S5 已按序关闭（MSG-36/37/38/39）；当前真实下一单元 = R44 RE-REVIEW 裁决 → R44-A Approval Creation Boundary。

## 2026-10-01 JST — MSG-20261001-41 = PASS（R44 CLOSED）→ 进入 R44-A Approval Creation Boundary

- 裁决：**PASS — R44 CLOSED**（REVIEWED_HEAD eca4207；CI 36865362444 SUCCESS 5/5）。CHANGE A/B 全部收口；confused-deputy / object-binding 四类场景零副作用获认可。
- 关闭边界：HTTP authn → tenant/path object binding → request anti-self-attestation → Action Guard → 既有 R43 S3/S4 service → atomic business execution。
- R44-A 冻结规则：creation/execution 共用同一 server-side package/basis builder；客户端不得传可信 digest/basis；不得只绑定裸 packageId；package 变更后 execution 必须拒绝；creator/executor 各自动作时重验 membership/role。
- R44-A 测试清单（14 项）：未认证 / 非法角色 / 跨租户 / 错绑定 / 伪造 digest·basis·version / terminal package 不得创建 / 重复创建幂等 / 过期·撤销 / creation 不改 ClaimItem / 不产生 Submission / 不消费 approval / 资金域零变化 / 创建的 approval 可被 R44 execution 消费 / 创建后 package 变化 → fail-closed。
- 档案：`AI-ARCHITECT-INBOX.md` → `MSG-20261001-41`；`compare.mjs` = **FULL_COPY_OK**。
- HOLD 保持：AMAZON WRITE HOLD · REAL WRITE ADAPTER HOLD · TRANSPORT=false · PRODUCTION CREDENTIALS HOLD · REAL EXTERNAL WRITE HOLD · SETTLEMENT/BILLING LINKAGE HOLD。

## 2026-10-01 JST — R44-A Approval Creation Boundary 实现 + 增量风险审计送审

- 新增入口：`POST /cases/:caseId/recovery/manual-submit-approval`（decision=REQUEST|APPROVE）—— 只创建审批事实，不执行提交。
- 复用而非另造：直接调用 R44 的 `resolveManualSubmissionTarget`（同一 `buildRecoveryPackageBasisReference`）；审批创建复用既有 `submitRecoveryReview`（新增：接受 `recovery.manual_submit` 为非资金动作 + 可选 `boundExtra` 服务端额外绑定键落库进 boundPayload）。
- 不变量：客户端不得自证 digest/basis/version；不得只绑裸 packageId（强制五元）；终态 package 不得创建（409）；同 basis 重复 APPROVE 幂等；creation 不改 ClaimItem / 不产生 Submission / 不消费 approval / 资金域 0；创建的 approval 可被 R44 execution 正常消费；创建后 package 变化 → execution fail-closed。
- 证据：`recovery-manual-approval-http-db.test.ts` 12/12（覆盖 MSG-41 的 14 项要求）；recovery-manual-* + admin-recovery-review 家族 102/102；tsc PASS；prisma validate valid（未改 Schema）；无新增依赖。
- 送审：REVIEWED_HEAD 4c43b41（Issue #2 comment 5932597311 / CI 36868784356 success 5/5）；唤醒已投递并三要素验证。
- 架构方连接器备注：其 GitHub 写回复 Issue #2 返回 403（integration 权限不足），本项目侧留档完整，无需等待。
- HOLD 保持：AMAZON WRITE HOLD · REAL WRITE ADAPTER HOLD · TRANSPORT=false · PRODUCTION CREDENTIALS HOLD · REAL EXTERNAL WRITE HOLD · SETTLEMENT/BILLING LINKAGE HOLD。

## 2026-10-01 JST — MSG-20261001-42 = PASS（R44-A CLOSED）→ 进入 R44-B Reference Approval Creation

- 裁决：**PASS**（REVIEWED_HEAD 4c43b41；CI 36868784356 SUCCESS 5/5）。R44-A 审批创建边界关闭；「零执行副作用」证据满足（12 用例覆盖 14 项语义）。
- NEXT：**R44-B — Manual Recovery Reference Approval Creation Boundary**（独立 approval creation for `recovery.manual_submit_reference_recorded`）。
- R44-B 必须：canonical 由服务端构造（客户端只交 raw）；approval extra 绑定 submissionId + claimItemId + providerCaseRefCanonical；与 S3/R44-A approval 严格 action isolation（双向）；同 canonical 重复创建幂等；canonical 变化后 execution fail-closed；creation 不创建 Reference / 不改 Submission·ClaimItem / 不消费 approval / 不产生 providerAccepted·reimbursed·recovered；资金域零变化；创建的 approval 可被 R44 reference execution 消费一次。
- 档案：`AI-ARCHITECT-INBOX.md` → `MSG-20261001-42`；`compare.mjs` = **FULL_COPY_OK**。
- HOLD 保持：AMAZON WRITE HOLD · REAL WRITE ADAPTER HOLD · TRANSPORT=false · PRODUCTION CREDENTIALS HOLD · REAL EXTERNAL WRITE HOLD · SETTLEMENT/BILLING LINKAGE HOLD。

## 2026-10-01 JST — R44-B Reference Approval Creation Boundary 实现 + 增量风险审计送审

- 新增入口：`POST /cases/:caseId/recovery/manual-reference-approval`（decision=REQUEST|APPROVE）—— 只创建 reference 补录审批。
- 冻结规则：客户端只交 raw，canonical 恒服务端构造（复用 S4 canonicalize）；extra 强制 submissionId + claimItemId + providerCaseRefCanonical；与 manual-submit 审批双向 action isolation；同 basis 幂等；creation 不创建 Reference / 不改 Submission·ClaimItem / 不消费 approval / 不产生 providerAccepted；资金域零变化。
- 证据：`recovery-manual-reference-approval-http-db.test.ts` 12/12（覆盖 MSG-42 的 17 项要求，含端到端消费一次、canonical 变化 fail-closed、双向 isolation）；家族回归 114/114；tsc PASS；prisma validate valid；无新增依赖。
- 送审：REVIEWED_HEAD f5c322e（Issue #2 comment 5932871096 / CI 36870628101 success 5/5）；唤醒已投递并三要素验证。
- HOLD 保持：AMAZON WRITE HOLD · REAL WRITE ADAPTER HOLD · TRANSPORT=false · PRODUCTION CREDENTIALS HOLD · REAL EXTERNAL WRITE HOLD · SETTLEMENT/BILLING LINKAGE HOLD。

## 2026-10-01 JST — MSG-20261001-43 = PASS（R44-B CLOSED / Manual Recovery HTTP 边界整体闭合）→ R45 Design

- 裁决：**PASS — R44-B CLOSED — MANUAL RECOVERY HTTP APPROVAL + EXECUTION BOUNDARY CLOSED**（REVIEWED_HEAD f5c322e；CI 36870628101 SUCCESS 5/5）。不再创建 R44-C/R44-D。
- 永久基线冻结：R43 + R44 + R44-A + R44-B 全量不变量（tenant/path binding、anti-self-attestation、五元 basis、三元 basis、action isolation、approval lifecycle、expiry/revocation、mutation invalidation、exactly-once、rollback、canonicalization、creation 零副作用、execution 原子性、providerAccepted=false、资金域零副作用、checker、fresh+upgrade、历史回归）。
- 风险口径（架构方）：**不得**把「Manual Recovery HTTP 闭环完成」扩大解释为「Recovery 商业闭环完成」；provider outcome → reimbursement observation → claim reconciliation、以及 recovered money → Settlement → Billing 仍为独立事实层。
- NEXT：**R45 — Outcome / Reimbursement Reconciliation**，第一批**只交 Design / Boundary Proposal（不实现）**；需定义四类事实与 12 项设计；R45 暂不得创建 Settlement/Billing/Fee、不得改写 RecoveryLedger、不得自动外写、不得开启 transport、不得把 observed reimbursement 等同于可收费 recovered amount。
- 档案：`AI-ARCHITECT-INBOX.md` → `MSG-20261001-43`；`compare.mjs` = **FULL_COPY_OK**。

## 2026-10-01 JST — R45 Design / Boundary Proposal 送审（Outcome / Reimbursement Reconciliation）

- 依据 MSG-20261001-43：R44-B CLOSED / Manual Recovery HTTP 边界整体闭合；R45 第一批只交 Design / Boundary Proposal（不实现）。
- 文档：`docs/releases/R45-OUTCOME-REIMBURSEMENT-RECONCILIATION-DESIGN.md`（四类事实分离、来源分级、匹配与歧义 fail-closed、partial/多对一/一对多、币种与容差、冲正更正、provenance、幂等、人工 override 权限·审批·审计、不确定必须 fail-closed；复用映射 + 边界禁止项 + 7 项待裁决问题）。
- docs-only：无实现、无 Schema/migration/触发器变更、无新增依赖（OSS_DECISION = EXISTING）。
- 送审：REVIEWED_HEAD 4d01a09（Issue #2 comment 5932927885）；唤醒已投递并三要素验证。
- HOLD 保持：AMAZON WRITE HOLD · REAL WRITE ADAPTER HOLD · TRANSPORT=false · PRODUCTION CREDENTIALS HOLD · REAL EXTERNAL WRITE HOLD · SETTLEMENT/BILLING LINKAGE HOLD。

## 2026-10-01 JST — MSG-20261001-44 = PASS WITH REVISE（R45 Design 裁决）→ R45-A Schema Delta Request

- 裁决：**PASS WITH REVISE**（REVIEWED_HEAD 4d01a09）。四类事实分离 / append-only / provenance / fail-closed / override 不改原事实 / 资金域隔离获认可。
- 7 项裁决：容差需版本化 policy（v1 exact，不冻结全局默认）；FULLY_RECONCILED 需更严格条件 + 明确 expected basis；AMBIGUOUS 禁止自动消歧；reversal 不改历史事实（新增 REVOKED/REVERSED 事实）；override v1 每笔单独审批；来源冲突一律 fail-closed；实现按 Schema Delta → Plan → S1…Sn。
- CHANGE A/B/C：Expected Recovery Basis（版本化）/ Fact 与 Projection 分离 / 外部事件身份与幂等（providerEventId 或版本化 fingerprint）。
- 首要风险：重复事实导致金额双计；其次 expected basis 漂移；再次把 projection 当 immutable fact。
- NEXT：**R45-A Schema Delta Request**（docs-only，仍不实现）。
- 档案：`AI-ARCHITECT-INBOX.md` → `MSG-20261001-44`；`compare.mjs` = **FULL_COPY_OK**。

## 2026-10-01 JST — R45-A Schema Delta Request 送审（Outcome / Reimbursement Reconciliation）

- 文档：`docs/releases/R45-A-RECONCILIATION-SCHEMA-DELTA-REQUEST.md`（docs-only；未改 Schema、未写 migration、未改代码、未加依赖）。
- 表集合：ProviderOutcomeFact / ReimbursementFact（含 providerEventId 或版本化 fingerprint）/ ExpectedRecoveryBasis（版本化）/ ReconciliationOverrideDecision（每笔单独审批）/ ClaimReconciliationProjection（derived）+ 待裁 ReconciliationTolerancePolicy。
- 关键不变量：UNIQUE(org, providerEventFingerprint) 防重复 ingest 双计；rr1: reconciliation 幂等；FULLY_RECONCILED 严格条件 + 明确 expected basis；CONFLICTING_EVIDENCE fail-closed；reversal 保留原事实并重算 projection；override 不改原事实。
- 索引/约束/触发器/迁移影响已列；required-triggers 与 append-only 清单、two-stage-upgrade、CI fresh 路径同批更新。
- 送审：REVIEWED_HEAD aa9225e（Issue #2 comment 5933085332）；唤醒已投递并三要素验证。

## 2026-10-01 JST — MSG-20261001-45 = PASS WITH REVISE（R45-A Schema Delta）→ R45-B Implementation Plan

- 裁决：**PASS WITH REVISE**（REVIEWED_HEAD aa9225e）。六表职责边界成立；projection 允许持久化但冻结为 derived cache（stored == deterministic rebuild 必须可验证）。
- 4 项裁决：①projection 持久化批准 ②tolerance policy v1 建表（默认 exact、版本化、旧 projection 不得被静默改写）③ExpectedRecoveryBasis 需 humanApproval，两个独立动作 basis_set / basis_supersede ④ProviderOutcomeFact 允许人工录入但须受保护路径（证据 + 审批 + sourceKind=MANUAL_WITH_EVIDENCE）。
- CHANGE A：reversal 不用负金额，必须引用 reversesFactId（同 tenant/provider/currency、不可自指、不可重复 full-reverse，v1 仅 full reversal）。CHANGE B：providerEventId + providerEventFingerprint 双概念。CHANGE C：basis effective 用 supersededAt IS NULL + partial unique，supersede 同事务并测并发。CHANGE D：新增 ClaimReconciliationProjectionFact 关系表。
- 4 项风险：重复 ingest 双计 / basis 并发双 effective / reversal 负金额 / projection 漂移成真值；必须 Facts → Basis·Policy·Override → deterministic projector → Projection。
- NEXT：**R45-B Implementation Plan**（docs-only；仍不实施）。
- 档案：`AI-ARCHITECT-INBOX.md` → MSG-20261001-45。

## 2026-10-01 JST — R45-B Implementation Plan 送审（最终七表 + CHANGE A–D + M1–M6）

- 文档：`docs/releases/R45-B-RECONCILIATION-IMPLEMENTATION-PLAN.md`（docs-only；未实施）。
- 七表：ProviderOutcomeFact / ReimbursementFact / ExpectedRecoveryBasis / ReconciliationOverrideDecision / ClaimReconciliationProjection（derived cache）/ ClaimReconciliationProjectionFact（关系表）/ ReconciliationTolerancePolicy（默认 exact）。
- CHANGE A–D 落实：reversal 非负金额 + reversesFactId 约束；providerEventId + fingerprint 双概念；supersededAt + partial unique 与 supersede 事务顺序；projection↔fact 关系化。
- 四个受保护动作：basis_set / basis_supersede / override / provider_outcome_record（均 INTERNAL_WRITE + humanApproval）。
- 送审：REVIEWED_HEAD 25389be（Issue #2 comment 5933149170）；唤醒已投递并三要素验证。

## 2026-10-01 JST — TRACK B 启动：PLATFORM_API_APPROVAL_READINESS（平台 API 准入准备体系）

- 落盘：`docs/platform-approval/`（PLATFORM_API_APPROVAL_READINESS / PLATFORM_SCOPE_MATRIX / DATA_FLOW_DIAGRAM / SECURITY_CONTROLS_EVIDENCE / PRIVACY_DATA_LIFECYCLE / OAUTH_TOKEN_LIFECYCLE / INCIDENT_RESPONSE_PLAN / HOST_ACTION_CHECKLIST + AMAZON·TIKTOK_SHOP·WALMART·SHOPIFY·WOOCOMMERCE 五份 scope 矩阵）。
- 持久规则：`.autopilot/RULES.md` R11 + `.autopilot/rules.json#platform_api_approval_readiness`；runner HEARTBEAT 增加 `platform_readiness_policy`；`check-autopilot-rules.mjs` 强制 8 份文档存在且五平台覆盖。
- 原则：READ-ONLY FIRST + LEAST PRIVILEGE + MINIMUM DATA；REAL EXTERNAL WRITE / Claim·Appeal 自动对外提交 继续 HOLD；平台接入必须成为 Adapter，不得改 Recovery OS 核心。
- TRACK A 未受影响：R45-B Implementation Plan 已送审，继续按裁决推进。

## 2026-10-01 JST — MSG-20261001-46 = PASS WITH REVISE（R45-B Implementation Plan）→ 授权进入 R45 S1

- 裁决：**PASS WITH REVISE**（REVIEWED_HEAD 25389be）；归档 FULL_COPY_OK；裁决全文见 `AI-ARCHITECT-INBOX.md` 的 `MSG-20261001-46`。
- 批准：七表模型 + Facts / Basis / Policy / Override / Projection 分层 + full reversal v1 + providerEventId/versioned fingerprint 双保险 + ProjectionFact 关系化 + tolerance policy v1 schema + 四个受保护动作 + deterministic rebuild + checker DETECT 不 REPAIR。
- 修正（Q1）：basis supersede 事务顺序 —— advisory/ClaimItem lock → SELECT current effective basis FOR UPDATE → 校验 approval/binding/provenance → UPDATE old SET supersededAt（受控 CAS）→ INSERT new effective basis → audit/approval consumption → commit；全部同一事务，partial unique 仅作最终防线；须实测 INSERT 失败/consumption 失败回滚、并发 supersede 恰一 effective。
- 授权（Q2）：进入 **R45 S1（Schema / Migration / Trigger / Inventory）**；S1 只做数据结构与数据库不变量，S1 完成后先送 Implementation Checkpoint 再进 S2。
- 策略（Q3）：ProjectionFact 重算 = 同事务整体替换（lock → 读 immutable inputs → deterministic rebuild → inputDigest → CAS version/digest → DELETE 当前 membership → INSERT 新 membership → commit）；DELETE 仅限 derived ProjectionFact，审计靠 projection rebuild audit。
- CHANGE A：ProjectionFact 绑定 projection 版本（projectionId + projectionVersion + reimbursementFactId / projectionGenerationId）。
- CHANGE B：reversal 自身具备 providerEventId / providerEventFingerprint / fingerprintVersion；同一 OBSERVED 至多一个有效 full reversal；重复 reversal event 幂等。
- CHANGE C：tolerance policy scope 优先级冻结；无 provider-specific policy 时使用显式系统 exact policy 记录，不得代码隐式 fallback。
- 边界：NO Settlement · NO Billing · NO Fee · NO RecoveryLedger mutation · NO platform write · TRANSPORT=false · NO production credentials。

## 2026-10-01 JST — R45 S1（Reconciliation Schema / Migration / Trigger / Inventory）实施 + Implementation Checkpoint 送审

- 交付：`apps/api/prisma/schema.prisma` 七表 + 七枚举（模型 44 → 51）；M1 表与枚举 / M2 租户触发器与 projection 受控更新 / M3 append-only 与 basis 受控 supersede / M4 partial unique 与显式系统 exact policy / M5 CHECK + reversal 同源性守卫 + projection generation 立即校验。
- 测试：`reconciliation-schema-s1-db.test.ts` 26/26；architecture-contract 119/119；全量 1648 tests PASS；tsc PASS；prisma validate valid。
- 清单：required-triggers 56（+14）；append-only/受控变更清单 12（新增 append-only 3 + 受控 supersede 1 + 受控 projection 1 + reversal 守卫 1 + generation 版本匹配 1）。
- 升级：two-stage upgrade OK（保数据 + 升级路径两清单 + checker 通过）；本地重建（drop → migrate deploy）无残留。
- 偏差回报：generation 一致性改为**立即判定**（DELETE 旧 membership → CAS 版本 → INSERT 新 membership），不使用 DEFERRABLE 约束触发器 —— 实测 Prisma 客户端会吞掉 COMMIT 阶段 deferred 约束错误（静默回滚、调用方无感）。请架构方裁决该顺序调整。
- 送审：REVIEWED_HEAD 8129998（Issue #2 comment 5933790490）；唤醒已投递并三要素验证。

## 2026-10-01 JST — MSG-20261001-47 = PASS WITH REVISE（R45 S1）→ 批准 S1 主体 + generation 顺序调整，进入 R45 S2（ingest）

- 裁决：**PASS WITH REVISE**（REVIEWED_HEAD 8129998）；归档 FULL_COPY_OK；全文见 `AI-ARCHITECT-INBOX.md` 的 `MSG-20261001-47`。
- Q1：S1 主体满足 MSG-46 授权范围，可关闭主体实现；两点保留约束（不 BLOCK）：弱引用 basis/policy 与 text[] evidence 必须在服务/checker 阶段补强验证。
- Q2：批准 generation 顺序 **DELETE → CAS → INSERT（立即判定）**，不要求 DEFERRABLE；新增永久验收「DELETE 后 CAS/INSERT 人为失败 → 回滚后旧 generation + 旧 membership 逐行保持」。
- Q3：批准进入 **R45 S2（ingest only）**：ProviderOutcomeFact / ReimbursementFact ingest + identity/fingerprint + replay 幂等 + reversal ingest；不实现 projector，不提前开放人工 outcome 受保护 HTTP。
- CHANGE A：basisId / tolerancePolicyId 弱引用 → S3 读取强校验 + S5 checker 判 dangling/cross-tenant/scope-version mismatch 为 inconsistency。
- CHANGE B：evidenceArtifactIds text[] = v1 有条件方案（写路径逐条验证存在/同租户/类型状态/不重复；checker 检测 dangling·cross-tenant；未来升级关系表）。
- CHANGE C：system exact policy 不得依赖 migration seed 永久存在（S3 确定性查询/受控幂等创建/unique scope 收敛/Projection 持久化真实 policyId+version；禁止隐式 0/0）。
- 边界：NO Settlement · NO Billing · NO Fee · NO RecoveryLedger mutation · NO platform write · TRANSPORT=false · NO production credentials。

## 2026-10-02 JST — R45 S2（Reconciliation ingest）实施 + Implementation Checkpoint 送审

- 交付：`services/reconciliation/fingerprint.ts`（v1 身份指纹：provider + sourceResource + eventKind + id/src 身份；两者皆缺失 fail-closed）、`ingest.ts`（ingestProviderOutcomeFact / ingestReimbursementFact；零 UPDATE）、`index.ts`（保留 C-0005 既有跨源对账导出并追加 S2 导出）。
- 语义：same external event → same existing fact（REUSED，不双计）；同 providerEventId 不同 resource → distinct facts；same reversal replay → REUSED；different reversal event 指向同一 OBSERVED → REVERSAL_ALREADY_APPLIED fail-closed；人工来源 → MANUAL_PATH_DEFERRED（留 S4）。
- 边界：未实现 projector、未开放人工 outcome 受保护 HTTP、未实现 basis set/supersede、零 Schema 变更。
- 证据：prisma validate valid · tsc PASS · 指纹纯函数 7/7 · ingest DB 12/12 · C-0005 回归 12/12 · 全量 171 files / 1668 tests PASS。
- 送审：REVIEWED_HEAD 8706b2d（Issue #2 comment 5934172241）；唤醒已投递并三要素验证（输入框清空 / 新消息在底部 / 生成中）。

## 2026-10-02 JST — HOST DIRECTIVE：R12 Success Fee / Billing 永久红线落盘

- 红线：**Reimbursement observed ≠ recovered ≠ billable** —— 只有 reconciliation 确认真实到账并形成合法 `Settlement = RECEIVED`（及对应 RecoveryLedger 事实）后，才允许计算 Success Fee 与生成 `BillingInvoice`。
- 链路（冻结）：Reconciliation → Confirmed Settlement → RecoveryLedger → FeeCalculation → BillingInvoice → Payment；`Payment` 自动扣款属**独立 Production / Payment Authorization Gate**，当前 **HOLD**。
- 可计费判定：`Settlement.status = RECEIVED`（PARTIAL 仅按已到账部分）· `confirmationStatus = CONFIRMED` · `reconciliationStatus ∈ { RECONCILED, PARTIAL }` · `evidenceId` 非空 · 未被冲回 · 计费基数只取自已确认到账的 Settlement/RecoveryLedger（不得取自 ReimbursementFact.amount、平台 approved、ClaimItem 金额）· 费率来自既有 FeeCalculation（`FeeBasis = NONE` 不得开票）· 沿用 `billing.draft` 锁后重读/依据唯一/`BILLING_BASIS_REQUIRED` 口径。
- 禁止：仅因 approved 收费 / 仅因 observed 收费 / 未确认到账收费 / partial 按 full 收费 / reversal·correction 后按旧金额收费 / AI 决定 recovered amount 或 fee / 未经客户明确预授权自动扣款。
- 落盘：`docs/releases/SUCCESS-FEE-BILLING-REDLINE.md` + `.autopilot/RULES.md` R12 + `.autopilot/rules.json#success_fee_billing_redline`；runner 每轮输出 `billing_redline_policy`；checker 在 CI 强制（规则段 + JSON 块 + 文档 + auto_debit_gate=HOLD）。
- 队列：不改变 R45（S1 CLOSED → S2 送审中 → S3 → S4 → S5）与 R46 排期；不重新规划、不重复审计已 PASS 底座。

## 2026-10-02 JST — MSG-20261002-48 = PASS（R45 S2 CLOSED）→ 批准进入 R45 S3 Deterministic Projector

- 裁决：**PASS**（REVIEWED_HEAD 8706b2d）；归档 FULL_COPY_OK；全文见 `AI-ARCHITECT-INBOX.md` 的 `MSG-20261002-48`。
- ① S2 范围与证据匹配 → **S2 CLOSED**；「幂等复用（同事件重放）」与「fail-closed（不同事件重复 full-reverse）」的区分被确认正确，不得把后者伪装成幂等成功。
- ② `MANUAL_PATH_DEFERRED` 获批准：不得为复用 ingest service 提前绕过 S4 的 humanApproval + evidence validation + membership/role recheck + action binding。
- ③ 批准进入 **R45 S3 — Deterministic Projector**：范围冻结为 immutable facts + effective basis + effective tolerance policy + 合法 override inputs（若空则为空）→ deterministic computation → persisted Projection + ProjectionFact membership；不得顺带实现 S4 受保护写动作。
- S3 事务顺序（冻结）：lock projection/claim scope → 固定输入集合 → 强校验 basis/policy 引用 → deterministic rebuild → inputDigest → DELETE old membership → CAS header → INSERT new membership → audit → commit；任何一步失败必须完整恢复旧 header + membership。
- S3 永久验收（16 项）已登记 STATE.r45_s2_verdict.s3_permanent_acceptance（含确定性、重建一致、CAS/INSERT rollback、stale generation、dangling/cross-tenant basis·policy、exact policy 幂等创建与并发唯一、Projection 保存实际 basisId+policyId/version、reversal 后 FULL→PARTIAL/UNMATCHED、currency mismatch、多候选 AMBIGUOUS、conflicting evidence fail-closed、membership generation 严格一致、projector 不写 Fact）。
- 风险：禁止把旧 Projection 当业务计算输入（仅可用于 CAS/version coordination）。
- 边界：NO Settlement · NO Billing · NO Fee · NO RecoveryLedger mutation · NO platform write · TRANSPORT=false · NO production credentials。

## 2026-10-02 JST — R45 S3（Deterministic Projector）实施 + Implementation Checkpoint 送审

- 交付：`projection-compute.ts`（纯计算层：4 位定点 BigInt、canonical inputDigest、状态判定）+ `projector.ts`（`rebuildClaimReconciliationProjection`：锁内固定输入 → 重建 → 整体替换 membership → audit）+ index 导出。
- 事务顺序：lock projection/claim scope → 固定输入 → 强校验 basis·policy → deterministic rebuild → inputDigest → DELETE old membership → CAS header → INSERT new membership → audit → commit；任何一步失败整体回滚（含 DELETE 后 CAS 故障、DELETE+CAS 后 INSERT 故障两例故障注入验收）。
- CHANGE A/C 落地：basis 强校验（同租户 + 同 claimItem + effective + 唯一）；policy 强校验（同租户 + provider + operation + effective，多匹配即 `POLICY_NOT_UNIQUE`）；system exact policy 缺失时受控幂等创建、并发唯一、Projection 持久化真实 policyId+version。
- 边界：未实现 S4 受保护写动作；零 Schema / migration / 触发器清单变更。
- 证据：prisma validate valid · tsc PASS · 纯计算层 13/13 · projector DB 14/14 · 全量 173 files / 1695 tests PASS。
- 送审：REVIEWED_HEAD 46074bd（Issue #2 comment 5934720171）；唤醒已投递并三要素验证（输入框清空 / 新消息在底部 / 正在生成）。

## 2026-10-02 JST — MSG-20261002-49 = PASS WITH REVISE（R45 S3 主体 CLOSED）→ 3 项语义修正 + 批准进入 R45 S4

- 裁决：**PASS WITH REVISE**（REVIEWED_HEAD 46074bd）；归档 FULL_COPY_OK；全文见 `AI-ARCHITECT-INBOX.md` 的 `MSG-20261002-49`。
- S3 主体：可标记 CLOSED（纯计算层与 IO 分离、定点金额、canonical inputDigest、旧 Projection 仅 CAS、DELETE → CAS → INSERT 同事务、rollback 有真库证据、generation 一致、policy 无隐式 fallback、system exact policy 并发唯一）。
- REVISE ①：over-recovery 不得一律归为匹配歧义 → 必须记录结构化异常 `AMOUNT_EXCEEDS_EXPECTED`（v1 可 status=AMBIGUOUS 但 reason 明确，且文档注明是 fail-closed exceptional state）。
- REVISE ②（CHANGE A）：cross-tenant / dangling basis·policy 不得降级为「无 basis」→ 必须 fail-closed / consistency error；只有真正不存在 effective basis 才是 MATCHED。
- REVISE ③（CHANGE B）：inputDigest 必须覆盖 fact identity/content、reversal、basis id/version/amount/currency、policy id/version/abs/rel、override、projection algorithm/version；顺序变化而语义相同 → digest 不变。
- MATCHED 语义冻结：仅表示「事实已唯一关联但缺有效 basis」，不得被描述为 recovered / fully recovered / reimbursement complete / billable。
- NEXT：**R45 S4 — Protected Reconciliation Actions**（四个动作；全部 INTERNAL_WRITE + humanApproval + 锁后 ACTIVE membership/role 重验；含人工 outcome 的 evidence 逐条校验与 supersede 顺序要求）。

## 2026-10-02 JST — HOST DIRECTIVE（补充二）：R13 Success Fee 支付授权分离与 Onboarding/自动收费契约落盘

- 两条授权链严格分离：Platform OAuth / Seller Authorization 只用于平台数据/API 能力，**不得**视为成功费扣款授权，不得依赖平台卖家余额直接扣取佣金，不得从 OAuth 推导支付授权；平台独立 App Billing 也须作为独立 Billing Authorization。
- Onboarding 收费体验冻结：注册 → 平台授权 → **免费扫描（不得强制绑卡）** → 点击「开始追回」→ 接受 Success Fee 条款 → 设置付款方式 / 签署有效 Payment Mandate → 正式追回执行。
- 自动收费唯一链路：`FULLY_RECONCILED → Settlement confirmed/received → RecoveryLedger → FeeCalculation → BillingInvoice → 有效 Payment Authorization/PaymentMethod/Mandate → Provider 自动收费`；**无有效支付授权时只生成 BillingInvoice / Payment Request，不得自动扣款**。
- 不保存 PAN / card number / CVV / 网银密码；只保存 provider 引用（Customer ID / PaymentMethod ID / Mandate ID / authorization status）。
- 落盘：`docs/releases/PAYMENT-AUTHORIZATION-AND-ONBOARDING-CONTRACT.md` + `.autopilot/RULES.md` R13 + `.autopilot/rules.json#payment_authorization_separation`；runner 每轮输出 `payment_authorization_policy`；checker 在 CI 强制（含 activation_gate=HOLD 与 irreversible_upgrade_forbidden=true）。
- 队列：R45 → R46 不变；PaymentMethod / Mandate / autopay enablement 在 R46 完成后由**独立 Payment Activation Gate** 实施、测试与审计（当前 HOLD）。

## 2026-10-02 JST — R45 S4（Protected Reconciliation Actions）实施 + Implementation Checkpoint 送审

- 交付：`action-guard` 四个 catalog 条目（INTERNAL_WRITE + humanApproval）+ 动作常量 + 审批创建必填绑定；`basis-actions.ts`（set / supersede）；`manual-actions.ts`（override / 人工 provider outcome）。
- supersede 顺序：lock current effective FOR UPDATE → 审批边界重验 → UPDATE old（受控 CAS）→ INSERT new → 业务审计 + approval 消费 → commit；后置失败整体回滚（旧 basis 仍 effective / 无新 basis / approval 未消费）。
- override：每笔独立审批（一票制）、不改原事实、错误绑定/跨租户 fail-closed、reason + ≥1 evidence。
- 人工 outcome：MANUAL_WITH_EVIDENCE + evidence 逐条校验（存在/同租户/不重复/可用来源）+ structured reason + approval binding；重复事件幂等 fail-closed；失败事实/审计/消费零推进；不推导 providerAccepted。
- 证据：prisma validate valid · tsc PASS · basis 9/9 · 人工 9/9 · R45 家族 68/68 · 全量 175 files / 1717 tests PASS。
- 送审：REVIEWED_HEAD e4dcee3（Issue #2 comment 5935348764）；唤醒已投递并三要素验证（输入框清空 / 新消息在底部 / 正在生成）。

## 2026-10-02 JST — HOST DIRECTIVE（补充三）：R14 Customs / Duty Drawback 与 BrokerConnector 长期契约落盘

- BrokerConnector 抽象：`Recovery Opportunity → Evidence/Claim Package → BrokerConnector → Licensed Customs Broker / ABI Service → CBP → Outcome/Reimbursement → Reconciliation`；支持 API/Webhook · ABI Vendor · EDI/SFTP · 必要时 Manual Broker Portal，不得绑定单一 Broker。
- 执业边界：CrossClaim 不自称 Customs Broker、不执行依法须由 licensed customs broker 承担的 customs business；V1 = Broker 负责 licensed review/filing/CBP communication，CrossClaim 负责数据接入/detection/matching/Evidence Package/workflow/tracking/reconciliation。
- 三授权域独立：Platform OAuth · Broker POA · Payment Authorization 完全独立、互不推导；CrossClaim 不得伪造/代替/从 Platform OAuth 推导 Broker POA。
- 费用独立：Broker Fee 与 CrossClaim Fee 在领域模型/合同主体/Invoice/Payment attribution 可独立表达；**禁止默认**「统一百分比 → 按笔给 Broker 分佣」（美国 Customs Broker compensation/fee-sharing 规则，实施前专门合规审查）；优先 fixed / per-file / volume / platform fee。
- 客户体验统一：客户仅用 CrossClaim 完成资料/授权/跟踪；Broker 可为独立法律与收费主体。
- 退款资金：优先直接进入 claimant/customer 合法账户；不得默认代收、形成资金池或截留佣金（否则另开 Funds Custody / Money Movement 合规审计）。CrossClaim 成功费仍按 R12/R13（无有效授权只出 Invoice）。
- 落盘：`docs/releases/CUSTOMS-BROKER-CONNECTOR-CONTRACT.md` + `.autopilot/RULES.md` R14 + `.autopilot/rules.json#customs_broker_connector`；runner 每轮输出 `customs_broker_policy`；checker 在 CI 强制（含 crossclaim_is_customs_broker=false、三授权域齐备、refund custody=NONE）。
- 队列：R45 → R46 不变；Customs/BrokerConnector 实施批次另行提交独立设计 / Schema Delta / 合规审计 / 测试。

## 2026-10-02 JST — MSG-20261002-50 = PASS WITH REVISE（R45 S4 主体 CLOSED）→ CHANGE A/B/C + 批准进入 R45 S5

- 裁决：**PASS WITH REVISE**（REVIEWED_HEAD e4dcee3）；归档 FULL_COPY_OK；全文见 `AI-ARCHITECT-INBOX.md` 的 `MSG-20261002-50`。
- S4 主体：**CLOSED**（四个动作注册/审批服务端绑定/锁后角色重验/set 与 supersede 分离/supersede 同事务保留旧 basis/override 独立审批且不改 fact/人工 outcome 强制 MANUAL_WITH_EVIDENCE + evidence 逐条校验 + 失败零推进）。
- CHANGE A：人工 outcome「重复」语义对齐 S2 —— 完全重放 → `REUSED`（非业务错误）；identity 相同但内容不同（kind/evidence/occurredAt）→ `EVENT_IDENTITY_CONFLICT` fail-closed；execution replay rejection 不得创建第二 fact/成功审计或再次消费 approval。
- CHANGE B：S5 checker 必须验证 S4 approval 语义（action/tenant/target/boundExtra/消费且仅一次/不得跨授权/manual outcome identity 对应 provider·kind·event）。
- CHANGE C：S5 必须落实 MSG-49 状态语义（无 basis → MATCHED；dangling·cross-tenant basis·policy → inconsistency；FULLY 必须有有效 basis；over-recovery 必须带 `AMOUNT_EXCEEDS_EXPECTED`；MATCHED 不得衍生 recovered/billable）。
- NEXT：**R45 S5 —— read-only consistency checker + permanent regression closure**（19 项最低检查面；DETECT ≠ REPAIR；执行前后 DB 快照一致；漂移 → 非零、clean → 零）；完成后提交 R45 Full Regression / Release Implementation Checkpoint。
- 边界：NO Settlement · NO Billing · NO Fee · NO RecoveryLedger mutation · NO platform write · TRANSPORT=false · NO production credentials。

## 2026-10-02 JST — R45 S5（read-only consistency checker）实施 + Full Regression / Release Checkpoint 送审

- 交付：`tools/consistency/check-reconciliation.mjs`（14 组只读检查：deterministic rebuild == stored projection / 弱引用 / membership generation / reversal linkage / evidence / S4 approval 语义 / identity 冲突 / 摘要一致；DETECT ≠ REPAIR）。
- 测试：`reconciliation-consistency-checker-db.test.ts` 12/12（clean → 通过且执行前后快照一致；9 类漂移 → 非零）。
- 接入：CI（fresh deploy 后执行）+ two-stage upgrade（stage 2 后执行）；本地 two-stage upgrade OK，全量 176 files / 1730 tests PASS。
- R45 全阶段：S1–S4 CLOSED（MSG-47/48/49/50），S5 本 Checkpoint；请裁决 R45 是否整体 CLOSED。
- 送审：REVIEWED_HEAD 6f725d1（Issue #2 comment 5935743965）；唤醒已投递并三要素验证（输入框清空 / 新消息在底部 / 生成中）。

## 2026-10-02 JST — MSG-20261002-51 = PASS：R45（S1–S5）整体 CLOSED → 批准进入 R46 Design Gate

- 裁决：**PASS — R45 CLOSED**（REVIEWED_HEAD 6f725d1）；归档 FULL_COPY_OK；全文见 AI-ARCHITECT-INBOX.md 的 MSG-20261002-51。
- S5 checker 与 DETECT ≠ REPAIR 获认可，MSG-50 的 CHANGE B/C 收口；R45 S1–S5 整体 CLOSED，不再创建 R45-S6/S7。
- NEXT：R46 — Settlement / Billing Linkage Design Gate；第一轮只提交 Design Proposal（回答 15 问），不得直接实现。
- 风险：不得把 RECONCILED / FULLY_RECONCILED 解释为 money received 或 billable revenue。
- 冻结回归：R45 基线（S1–S5 / fresh / upgrade / inventories / 176 files 1730 tests）永久保留。
- R46 初始红线：NO Settlement creation from R45 · NO FeeCalculation · NO BillingInvoice · NO Payment activation · NO autopay · NO platform write · TRANSPORT=false · NO production credentials；R13 Payment Activation Gate 继续 HOLD。

## 2026-10-02 JST — R46 Settlement / Billing Linkage Design Proposal 送审（docs-only，不实现）

- 文档：`docs/releases/R46-SETTLEMENT-BILLING-LINKAGE-DESIGN-PROPOSAL.md`（docs-only；未改 Schema / 未写 migration / 未改代码）。
- 事实分层：R45 derived（仅候选信号）≠ R46 financial facts；硬不变量 OBSERVED/RECONCILED ≠ Settlement RECEIVED ≠ Fee earned ≠ Billing payable ≠ Payment collected。
- 15 问答复：以外部到账证据 + 受保护动作作为 Settlement 入口；FULLY_RECONCILED 既非充分也非独立必要；v1 不允许 FX；override 不得触发资金域；重跑幂等四道防线；动作闸门建议（settlement.record / billing.fee_calculate / billing.invoice_issue = INTERNAL_WRITE + humanApproval；payment.capture = MONEY_MOVEMENT + productionGate）。
- 边界：NO Settlement creation from R45 · NO FeeCalculation · NO BillingInvoice · NO Payment activation · NO autopay · NO platform write；R13 Payment Activation Gate 继续 HOLD。
- 送审：REVIEWED_HEAD 51b27ff（Issue #2 comment 5935875894）；唤醒已投递并三要素验证（输入框清空 / 新消息在底部 / 生成中）。

## 2026-10-02 JST — MSG-20261002-52 = PASS WITH REVISE：R46 Design 原则批准 → 进入 R46-A Schema Delta Request

- 裁决：**PASS WITH REVISE**（REVIEWED_HEAD 51b27ff）；归档 FULL_COPY_OK；全文见 AI-ARCHITECT-INBOX.md 的 MSG-20261002-52。
- KEEP：事实分层与硬不变量（OBSERVED/RECONCILED ≠ Settlement RECEIVED ≠ Fee earned ≠ Invoice payable ≠ Payment collected）。
- 批准 Q2 / Q11：FULLY_RECONCILED 既非充分也非独立必要（但仍需可追溯 claim/linkage basis）；override 不得触发资金域。
- CHANGE A：Settlement 不可变外部资金身份（same receipt replay → reuse；different receipt → distinct）。
- CHANGE B：reversal 必须建为独立财务事实（引用原 Settlement / 幂等 / 禁重复 full reversal）。
- CHANGE C：Fee 必须经 FeeCalculationSettlement membership 从 Settlement 明细推导。
- CHANGE D：不得在 R46-A 顺便改 BillingInvoice 状态机；VOID / CREDIT / WRITTEN_OFF 需单列 semantics。
- CHANGE E：settlement.record 的 approval 必须绑定 receipt snapshot；审批后关键字段变化 → approval 失效。
- NEXT：R46-A Schema Delta Request（docs-only，一次完整定义），之后 R46-B Implementation Plan。
- 红线不变：NO Settlement creation from R45 · NO FeeCalculation · NO BillingInvoice issuance · NO Payment activation · NO autopay · NO platform write · TRANSPORT=false · NO production credentials；R13 Payment Activation Gate 继续 HOLD。

## 2026-10-02 JST — R46-A Settlement / Billing Linkage Schema Delta Request 送审（docs-only）

- 文档：`docs/releases/R46-A-SETTLEMENT-BILLING-LINKAGE-SCHEMA-DELTA-REQUEST.md`（docs-only；未改 Schema / 未写 migration / 未改代码）。
- 现状核对（CHANGE D 前置）：`BillingStatus` 有 `VOID`/`WRITTEN_OFF`、**无** `CREDIT`/`CREDIT_NOTE` → R46-A **不改** BillingInvoice 状态机；`Settlement` 缺外部资金身份 / claim linkage / receipt snapshot；`FeeCalculation` 仅单个可空 `settlementId`。
- Schema Delta：Settlement 纯增列（身份三元组 + versioned fingerprint + linkage + receiptSnapshotId）；新表 `SettlementAdjustment` / `FeeCalculationSettlement` / `SettlementReceiptSnapshot`；BillingInvoice / RecoveryLedgerEntry 不变。
- 两个待裁定项：§5.4 legacy `reversedBySettlementId` 选型；§6.6 FeeCalculation 作废语义。
- 边界：NO Settlement creation from R45 · NO FeeCalculation · NO BillingInvoice · NO Payment activation · NO autopay · NO platform write；R13 Payment Activation Gate 继续 HOLD。
- 送审：REVIEWED_HEAD 103865f（Issue #2 comment 5936029898）；唤醒已投递并三要素验证（输入框清空 / 新消息在底部 / ChatGPT 正在回应）。

## 2026-10-02 JST — MSG-20261002-53 = PASS WITH REVISE：R46-A 批准进入 Implementation Planning

- 裁决：**PASS WITH REVISE — R46-A APPROVED FOR IMPLEMENTATION PLANNING**（REVIEWED_HEAD 103865f）；归档 FULL_COPY_OK；全文见 AI-ARCHITECT-INBOX.md 的 MSG-20261002-53。
- CHANGE A1：唯一性以 identityKind + valueHash + identityVersion 为规范依据（externalIdentityValue 不作明文唯一依据）。
- §5.4 裁定：legacy `reversedBySettlementId` 保留可读、不回填、不再作为新业务写入路径；**不批准双写**；由 checker 检测矛盾表示。
- CHANGE B1：SettlementAdjustment 字段与 full-reversal 等额约束（服务层 + DB 双保险）；partial correction 未设计完整前 fail-closed。
- §6.6 裁定：独立 Fee 作废/调整事实（FeeCalculationAdjustment 或等价）；CHANGE C1：不得 UPDATE 旧 FeeCalculation 金额。
- CHANGE E1：receipt snapshot 不可变，变化时生成新 snapshot/version 并重新审批。
- CHANGE F：四个数据库级不变量（同租户归属 / adjustment currency / fee membership uniqueness / snapshot digest）。
- NEXT：R46-B — Implementation Plan（docs-only）；推荐 S1 Schema → S2 receipt snapshot + ingest → S3 SettlementAdjustment → S4 Fee membership → S5 Invoice linkage → S6 checker + full regression。
- 冻结不变：NO R45→Settlement automatic creation · NO automatic Fee · NO automatic Invoice · NO Payment activation · NO autopay · NO platform write；R13 Payment Activation Gate = HOLD。

## 2026-10-02 JST — R46-B Settlement / Billing Linkage Implementation Plan 送审（docs-only）

- 文档：`docs/releases/R46-B-SETTLEMENT-BILLING-LINKAGE-IMPLEMENTATION-PLAN.md`（docs-only；未改 Schema / 未写 migration / 未改代码）。
- 最终模型：4 新表（ReceiptSnapshot / SettlementAdjustment / FeeCalculationSettlement / FeeCalculationAdjustment）+ Settlement·FeeCalculation 纯增列；BillingInvoice / RecoveryLedgerEntry 不变；legacy `reversedBySettlementId` 只读兼容（不双写）。
- CHANGE A1：唯一键含 identityVersion；`externalIdentityValue` 退出唯一判定（仅受保护 provenance/display）。
- CHANGE B1：v1 仅 full reversal（等额 / 同币种 / 同租户 / 不超冲，触发器 + 服务层双保险）；CORRECTION fail-closed。
- CHANGE C1：不 UPDATE 历史 FeeCalculation → `FeeCalculationAdjustment`（VOID/REVERSAL/CORRECTION）+ netEarnedFee 重算。
- CHANGE E1：snapshot 不可变，新状态 → 新 snapshot/version + 重新审批。
- CHANGE F：四项数据库级不变量（复合外键同租户 / currency / membership uniqueness / snapshotDigest）。
- 实施顺序：S1 Schema+triggers+inventories → S2 receipt snapshot + ingest → S3 adjustment → S4 fee membership → S5 invoice 边界 → S6 checker + full regression；30 项永久验收映射。
- 送审：REVIEWED_HEAD 5d8786e（Issue #2 comment 5936110978）；唤醒已投递并三要素验证（输入框清空 / 新消息在底部 / ChatGPT 正在回应）。

## 2026-10-02 JST — MSG-20261002-54 = PASS WITH REVISE：R46-B 批准，S1 可先行（先收口 CHANGE A/B/C）

- 裁决：**PASS WITH REVISE**（REVIEWED_HEAD 5d8786e）；归档 FULL_COPY_OK；全文见 AI-ARCHITECT-INBOX.md 的 MSG-20261002-54。
- CHANGE A（本裁决）：**F3 修正** —— 不得用 `UNIQUE(org, settlementId)` 全局锁死；改为 `UNIQUE(org, feeCalculationId, settlementId)` / `UNIQUE(org, feeCalculationId, adjustmentId)`；需定义 fee chain identity；重复计费不变量 = 同一资金事实不得同时进入两个互不相关的 active fee chains。
- CHANGE B（本裁决）：Settlement ↔ Snapshot 唯一且不可漂移（receiptSnapshotId / digest / version 创建后不可改；更正走新 snapshot + 新路径）。
- CHANGE C（本裁决）：`FeeCalculation exists ≠ Invoice may automatically issue`；S5 先设计 eligibility / candidate / draft linkage / separate authorization。
- CHANGE B1 revise：v1 full reversal = 0 或恰好 1（amount == original）；不允许多个 reversal 累计；partial fail-closed。
- CHANGE C1 revise：adjustment 存正数 amount，kind 决定方向，projector/service 统一计算 effect。
- ① FeeCalculationAdjustment 三分类语义冻结（VOID / REVERSAL / CORRECTION 各有 reasonCode·evidence·sourceFact·amount 规则；不得改历史 FeeCalculation）。
- TEST：在既有 30 项上再新增 10 项永久验收（fee chain 双计费 / snapshot 漂移 / adjustment 符号 / invoice 自动产生）。
- NEXT：R46 S1（Schema + migrations + triggers + inventories，零资金业务行为），送审须报告 fee-chain uniqueness 最终方案、snapshot immutability、full-reversal unique 语义、FK/partial unique/CHECK/triggers、inventories、fresh deploy、two-stage upgrade、architecture contract、零资金行为证明。

## 2026-10-02 JST — R46 S1 Settlement / Billing Linkage Schema 实施并送审（零资金业务行为）

- 交付：4 新表（ReceiptSnapshot / SettlementAdjustment / FeeCalculationSettlement / FeeCalculationAdjustment）+ Settlement·FeeCalculation 纯增列 + 4 migration（tables / tenant_triggers / append_only / invariants）。
- CHANGE A / F3 修正：fee chain 维度唯一 + claimItem active 唯一 + chain 触发器；**不采用**全局 `UNIQUE(org, settlementId)`（加反向断言）。
- CHANGE B：snapshot append-only + `cc_settlement_receipt_basis_immutable`（到账依据不可漂移）。
- CHANGE B1：`UNIQUE(org, originalSettlementId)` + full-reversal 等额/同币种触发器；partial reversal / CORRECTION v1 fail-closed。
- CHANGE F：F1 租户守卫（4 表 + 11 FK）/ F2 currency / F3 membership 唯一 / F4 snapshotDigest 64hex CHECK。
- 清单：required-triggers 71；append-only 20（含 5 个不变量触发器）。架构契约 140/140；模型 55 = 49 core + 6 join；DOMAIN_MODEL 同步。
- 证据：prisma validate valid · tsc 0 error · fresh deploy（cc_s1_check，4 迁移全应用 + 两套清单 OK）· two-stage upgrade OK（immutable=53）· 全量 176 files / 1751 tests PASS。
- 零资金行为：未改任何 `apps/api/src` 业务代码；迁移无 `INSERT INTO` 资金表；未改 BillingInvoice / BillingStatus。
- 送审：REVIEWED_HEAD ab00cd9（Issue #2 comment 5936548245）；唤醒已投递并三要素验证。

## 2026-10-02 JST — MSG-20261002-55 = PASS WITH REVISE：R46 S1 CLOSED / S2 AUTHORIZED

- 裁决：**PASS WITH REVISE — R46 S1 CLOSED / S2 AUTHORIZED**（REVIEWED_HEAD ab00cd9）；归档 FULL_COPY_OK；全文见 AI-ARCHITECT-INBOX.md 的 MSG-20261002-55。
- CHANGE A：fee-chain uniqueness 需真实 PostgreSQL 并发竞争验收（同一 Settlement 进同一 feeChainId 的不同 FeeCalculation → 至多一个成功），**在 S4 前完成**，不阻塞 S2。
- CHANGE B（S2 硬验收）：canonical snapshot digest 必须证明 stored digest == sha256(server-side canonical snapshot)，并覆盖键序/金额/币种/UTC/evidence 排序/identity 版本/客户端 digest 拒绝等。
- 冻结服务语义：same reversal replay → REUSED；different reversal on already-reversed → REVERSAL_ALREADY_APPLIED；unique violation 不得裸 500。
- S1 证据充分 → CLOSED（fresh deploy / two-stage upgrade / 架构契约 140-140 / 全量 176 files 1751 tests / 零资金行为）。
- NEXT：R46 S2（receipt snapshot + Settlement record/ingest 受保护写边界）；S2 最低永久验收 17 项已登记。

## 2026-10-02 JST — CI 偶发失败诊断（c9f7e2b deploy smoke / P1001）

- 现象：run 36897686051（c9f7e2b，docs-only 归档提交）中 `Deploy smoke · fresh install + migration upgrade` 失败。
- 根因：`S-1 migrate deploy (fresh database)` → **P1001: Can't reach database server at 127.0.0.1:32768**（临时 postgres 容器已启动且 pg_isready 通过，但随后不可达）——CI 运行器环境偶发，与本批次 schema/migration 无关（同迁移在 ab00cd9 / ea66ae2 / f1e851d 三个 run 中 success）。
- 同 run 的 `API · migration + typecheck + tests` 为 success。
- 处置：SELF_RESOLVE —— 触发该 run 的 failed-jobs 重跑（API 201），不修改任何代码。
- 影响：无（本地 fresh deploy + two-stage upgrade + 全量 1751 tests 已通过；S1 证据不受影响）。
