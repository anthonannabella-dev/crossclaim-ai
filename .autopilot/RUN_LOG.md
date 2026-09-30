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
