# SI/RSI INTERNAL AUTONOMOUS CODE REPAIR V1 —— PHASE 2（安全范围）独立复审请求

审计编号（请在回复标题中沿用）：MSG-20261009-09
REVIEWED_HEAD = ad1bfd5b（分支 feat/si-rsi-internal-code-repair-v1）
上一轮裁决：MSG-20261009-08 = PASS WITH REVISE（PHASE1_CLOSED=YES；PHASE2_IMPLEMENTATION_AUTHORIZED=YES_SAFE_SCOPE_ONLY；PHASE3_TO_7_AUTHORIZED=NO）
durable 记录：本文件 与 docs/releases/SI-RSI-INTERNAL-CODE-REPAIR-V1.md（§2.1 分流、§2.2 GATE-1、§2.3 GATE-4 分流层）

一、本轮送审范围
仅审 PHASE 2 的**安全范围**实现：确定性故障分流的纯函数模块、其真实持久化往返、以及只读扫描登记。
不审范围：PHASE 3–7 未实施（未建代码修复代理、未接独立 Judge、未做受控发布准备、未做学习、未做端到端 A–P）；
未新增任何执行能力。

二、自上一轮以来的改动（REVIEWED_HEAD ad1bfd5b）
- 新增（纯新增，未修改既有文件）：apps/api/src/services/self-repair/fault-triage.ts（纯函数分流）、
  apps/api/src/services/self-repair/fault-triage-sweep.ts（只读扫描 + 只登记）、
  以及三个测试文件（纯函数 / 真实 PG 往返 / 真实 PG 扫描）与一份门禁证据 tools/verification/self-repair/phase2-gate1-full-regression.json。
- 提交：6e723c1c（分流）→ 3acfb195（扫描）→ 108ff0f4（GATE-1 证据）→ ad1bfd5b（GATE-4 分流层）。
- **未改 Prisma schema、未新增 migration**；未新增第二套 Runtime / Scheduler / Controller / 执行器；
  未接真实 Provider；未修改封板 RC / main；未做生产部署或迁移；未写真实密钥。

三、分流模块口径（fault-triage.ts，纯函数，零 IO）
输入 = 已持久化的 INTERNAL_FAULT 载荷（PHASE 1 白名单对象）+ **服务端可信事实复核结果**；
输出 = 5 条封闭结论之一 + 原因码 + 待办动作 + 对账要求 + 逐项检查清单。判定顺序即优先级：
1. BLOCK_HUMAN_REVIEW：kind ≠ INTERNAL_FAULT / 状态 ≠ DIAGNOSED / 载荷非白名单对象或缺字段 /
   classificationAuthority ≠ DETERMINISTIC_RULES_ONLY / 安全或权限信号 / OWNER-gated 动作 /
   FORBIDDEN 且非修复路径 / 可信事实复核未过 / 授权不活跃 / 租户身份未由可信库解析 / operationKind = EXTERNAL_WRITE。
2. NEEDS_CLASSIFICATION：未分类故障（默认禁止自动恢复）。
3. RECONCILE：replayDisposition = RECONCILE_FIRST 或 requiresReconciliation —— **先对账，禁止直接重放**（给出对账要求文本）。
4. CODE_REPAIR_CANDIDATE：FORBIDDEN 且 requiredAction = CODE_REPAIR_CANDIDATE（交 PHASE 3 修复代理；**该代理尚未实现**，本层只登记候选）。
5. AUTO_RECOVER_VIA_RUNTIME：仅当 PHASE 1 显式重放授权 + 类别在确定性可重试白名单 +
   operationKind ∈ {READ_ONLY, MUTATING}（**绝不含 EXTERNAL_WRITE**）+ 租户身份可信 + 授权活跃 + **运行时复核确认**
   —— 且其语义**只是把候选交回既有 ONE SI Runtime**（runtimeHandoffAuthorized 仅表示"可再校验"，不是执行授权；本层不执行任何动作）。

可信事实（**必须由调用方注入，且不得来自请求参数 / 客户端输入 / 模型输出**）：
organizationIdResolved（租户身份是否已由可信库解析）、authorizationActive（服务端重新解析的授权状态）、
operationRecheck（运行时对"只读 / 幂等未生效 / 未确认"的再次确认）。缺省 = 全部 fail-closed。

四、扫描模块口径（fault-triage-sweep.ts，只读 + 只登记，零执行）
- 只读扫描 kind = INTERNAL_FAULT 且 status = DIAGNOSED 的行（LIMIT 有界）；
- 逐行调用分流；`resolveTrustedFacts` 缺省即 fail-closed（无法确认 ⇒ BLOCK，拿不到 A 路径）；
- 只把**固定三个服务端字段**登记回 sourceRefs：triageDecision / triageReason / triagedAt（均非自由文本），
  且登记语句带 kind/status 前置条件（并发中转终态的行不会被登记）；
- 返回值恒为 tasksCreated = 0 / leasesCreated = 0 / runtimeInvocations = 0；
  静态断言：该模块不 import '../runtime/'、源码不含 autonomyTask / autonomyLease / console.。

五、门禁覆盖（对应 MSG-20261009-08 的 GATE-1..6）
- GATE-1（P1，全量 API 回归）：**PASS** —— 隔离库 crossclaim_p3r2_iso 上全量 vitest run：
  **490/490 测试文件、4926/4926 用例通过、exit 0**，耗时 1582.53s；证据文件含日志 SHA256 前 16 位 ca7ea00c76aa66cc。
  汇总脚本关键字命中的 4 条 "FAIL" 经逐条核对**全部是测试名称**含 FAILED / fail-closed 的正常通过用例，真实失败数为 0。
  历史登记的 P2E-DB5 隔离债与 broker hook 超时债本轮未复现；**不视为关闭**（单次通过不足以关闭历史测试债）。
- GATE-2（P0，分流不得绕过租户认证 / kind / 生命周期 / 可信事实）：覆盖 —— 非 INTERNAL_FAULT ⇒ BLOCK；
  OPEN/TASKED/CLOSED/REJECTED ⇒ BLOCK；载荷非白名单对象或来源非确定性 ⇒ fail-closed；
  租户身份未解析 / 授权不活跃 / 运行时复核未确认 ⇒ BLOCK。
- GATE-3（P0，外写不得因"可重试"而自动重放）：覆盖 —— 外部写恒 HOLD（含"载荷被篡改为 AUTO_RETRY_CANDIDATE"的纵深防御用例）；
  扫描模块静态断言不引用运行时/任务/租约写入面；每次验收均断言零任务零租约。
- GATE-4（P0，幂等与 fencing）：**分流层 PASS** —— 重复分流幂等（连跑两次结论与登记逐字稳定）、
  4 路并发扫描（登记不重复、零任务零租约）、分流过程中被置 CLOSED ⇒ 登记被前置条件挡住且不抛错；
  **运行时层**（租约 fencing / 断连 / 崩溃恢复 / 异常重投）不由本层自证，已由既有 SI/RSI 门禁
  （PHASE 3 收官 + FAILURE_RECOVERY 门禁 MSG-20261009-06）覆盖，本层不重复实现第二套恢复机制。
- GATE-5（P1，接线边界脱敏负向）：**部分覆盖** —— 登记仅固定三项、无自由文本；载荷解析 fail-closed。
  尚未在"真实接线边界"上追加脱敏负向用例（如实登记）。
- GATE-6（P1，schema/migration）：**本轮无 schema 变更**，故无待办；未来如需变更将先提交独立 Schema Delta 审计。

六、本机验收证据（本轮实测）
- 纯函数分流：20 用例 PASS（5 路径矩阵 + 篡改用例 + 边界声明）。
- 真实 PostgreSQL 分流往返：5 用例 PASS（真实落库行走完 A 路径 / 对账 / 修复候选 / 未分类 / 终态不可分流；零任务零租约）。
- 真实 PostgreSQL 扫描：8 用例 PASS（含 DB-S6 幂等、DB-S7 并发、DB-S8 状态竞争、DB-S5 静态证据）。
- PHASE 2 三套件合计 **33/33 PASS**；PHASE 1 + PHASE 2 合并定向回归曾达 7 文件 / 123 tests 全绿；
  `apps/api tsc --noEmit` **0 error**。

七、如实声明的 NOT VERIFIED / 遗留
- Linux/systemd 实机、真实浏览器验收、真实 Provider 与真实模型联调：**未验证**（REAL_MODEL_INTEGRATION = HOLD、EXTERNAL_WRITE = HOLD、PRODUCTION_READY = NO）。
- GitHub Actions：本记录仅代表**本机隔离库**证据，未观测 CI 结果。
- GATE-5 的真实接线边界脱敏负向用例尚未补充；GATE-4 的运行时层依赖既有门禁证据（未在本轮重跑）。
- A 路径目前**只登记候选**，尚未与既有运行时入口建立消费通道；若需建立，属于需要单独设计与复审的单元。

八、请求裁决
请逐项判 PASS | REVISE | FAIL：
1. PHASE2_TRIAGE_DETERMINISM_AND_SAFETY_PATHS
2. PHASE2_TRUSTED_FACTS_BOUNDARY（不得使用请求/客户端/模型来源）
3. PHASE2_READ_ONLY_SWEEP_AND_REGISTRATION
4. PHASE2_GATE1_FULL_REGRESSION_EVIDENCE
5. PHASE2_GATE2_GATE3_COVERAGE
6. PHASE2_GATE4_LAYERING（分流层自证 / 运行时层引用既有门禁是否可接受）
7. SCOPE_HONESTY
并给出：
FINAL VERDICT: PASS | PASS WITH REVISE | REVISE | BLOCK
REVIEWED_HEAD: <sha>
PHASE2_CLOSED: YES | NO
NEXT_AUTHORIZED: <你方明确授权的下一步范围（例如仅 PHASE 3 内部实现 / 仍 HOLD）>
CHANGES: <必须执行的修订>
RISKS: <剩余风险>
请在本会话直接回复（不要写入我的仓库，也不要尝试访问外部系统）。若上文不可读，回复「需要重发」。
