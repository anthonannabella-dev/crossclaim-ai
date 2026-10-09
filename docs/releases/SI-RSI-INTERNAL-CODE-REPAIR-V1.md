# SI/RSI INTERNAL AUTONOMOUS CODE REPAIR V1 —— 实施记录

> 分支：`feat/si-rsi-internal-code-repair-v1`（基于已验证的 SI/RSI 基线 `7c8bdc77`：PHASE 1–3 已独立审计 CLOSED）
> 指令来源：HOST 粘贴的《CODEX → CROSSCLAIM AI · SI/RSI INTERNAL AUTONOMOUS CODE REPAIR V1》

## 0. 边界（全程遵守）

- **不修改**封板 `release/rc-20261008-linux-deploy-v1`（`ceb65ab7`，部署锚点 `04a93666`）、`main`（`444a246c`）与旧发布分支。
- **不新增**第二套产品 SI/RSI Runtime / Scheduler / Controller；复用 ONE SI Runtime、Model Gateway、Judge、Action Guard、Incident/Task/Lease、Outcome/Experience、成本台账。
- **系统自主修复 ≠ 生产自主改码**：生产部署、生产数据库迁移、真实 Provider 外写、支付、扣佣、海关申报仍受既有审批约束（`AUTO_PRODUCTION_CODE_MODIFICATION = FORBIDDEN`、`AUTO_PRODUCTION_DEPLOYMENT = FORBIDDEN`）。
- 修复平面**不得**获得客户业务执行权限；不得读取生产密钥；不得通过改代码绕过 Action Guard / Kill Switch / 权限 / 支付门禁。
- 不伪造测试与审计结论；无真实模型凭据时合同级 Mock 可用，但 `REAL_MODEL_INTEGRATION` 必须标 **HOLD**。

## 1. PHASE 0 —— 现有能力审计（本轮实测）

### 1.1 指令列出的能力（存在性已核实）

| # | 能力 | 真实路径（实测） | 存在 |
| --- | --- | --- | --- |
| 1 | ONE SI Runtime | `runtime/rsi-run.ts`（生产入口 `dist/src/runtime/rsi-run.js`，已实测启动） | ✅ |
| 2 | RSI Controller / Event Loop | `runtime/rsi-controller-continuation.ts`、`runtime/rsi-event-loop.ts` | ✅ |
| 3 | RSI Task Generator | `services/autonomy/rsi-task-generator.ts` | ✅ |
| 4 | Recovery SI Pack | `runtime/recovery-si-pack.ts`、`runtime/recovery-si-production-composition.ts`（生产已接线） | ✅ |
| 5 | Model Gateway / DeepSeek / Qwen Router | `runtime/rsi-si-model-gateway.ts`、`services/autonomy/rsi-model-router.ts` | ✅ |
| 6 | Judge / Verifier | `runtime/rsi-evidence-verifier.ts`（+ continuation engine 的 verdict 收口） | ✅ |
| 7 | Action Guard / Policy Core | `services/action-guard/`、`services/autonomy/rsi-policy-engine.ts` | ✅ |
| 8 | Incident / Task / Lease / Retry Ledger | `AutonomyIncident` / `AutonomyTask` / `AutonomyLease`（含 retry 迁移 `20261008140000_autonomy_task_retry_lifecycle`） | ✅ |
| 9 | Outcome / Experience Memory | `services/experience-memory/experience-memory.ts` | ✅ |
| 10 | Meta Learning | `services/meta-learning/meta-learning-orchestrator.ts` | ✅ |
| 11 | Controlled Config Proposal / Execution | `services/outcome-learning/controlled-config-execution.ts`、`services/config-execution-durability/*` | ✅ |
| 12 | Sandbox / Canary / Shadow | `services/outcome-learning/canary-shadow-evaluation.ts`、`services/connect/sandbox-provider.ts`（**provider 沙箱**，非代码沙箱） | ✅ |
| 13 | 测试执行器与 CI | vitest 全量 484 文件 / 4818 用例（PHASE 3 收官时 100% PASS）+ GitHub Actions 工作流 | ✅ |
| 14 | `tools/dev/si-rsi-continuous-check.mjs` | 存在，但**只是开发任务检查器**（不调用模型、不写代码） | ✅（**非**修复代理） |

### 1.2 指令要求明确区分的关键结论（实测）

| 分类 | 结论 |
| --- | --- |
| 已有代码 | 上表 1–13 全部存在 |
| 已接入生产运行时 | ONE SI Runtime / Recovery SI Pack / durable 任务源 / Action Guard / verdictWatcher / fenced settle（PHASE 1–3 已审计） |
| 仅测试可用 | `canary-shadow-evaluation`、`controlled-config-execution`、`config-execution-durability` 等（有测试，**未见生产接线证据**，下一单元逐项核实） |
| 仅有设计 | 无（本轮未发现"只有文档"的能力） |
| **需要新增** | **`internal code repair agent`（本任务主体）** —— 全仓 **无** `code-repair/` 目录、**无** `CODE_REPAIR_CANDIDATE` 引用（`rg` 实测为空） |

> **关键确认**：`INTERNAL_CODE_REPAIR_AGENT = NOT_IMPLEMENTED`。现有 `tools/dev/si-rsi-continuous-check.mjs` **不能**据此宣布修复代理已存在（与指令提示一致）。

**与进行中 SI/RSI 补强的关系**：SI/RSI 客户自治执行（PHASE 1–3）已独立审计 CLOSED，无在飞未审计改动；本分支基于其基线创建，**不打断、不并行修改同一批代码**。两者共享 Incident / Judge / Model Gateway / Evidence / Outcome / 成本与权限基础设施。

### 1.3 PHASE 1 实施与验收（本轮：确定性故障分类中心）

新增（**纯新增**，未修改任何既有运行时文件）：

| 文件 | 作用 |
| --- | --- |
| `apps/api/src/services/self-repair/fault-classification.ts` | 确定性分类（纯函数 / 零 IO / 零模型调用）+ 脱敏 + 去重键 + 可信 Incident 意图 |
| `apps/api/src/services/self-repair/fault-incident-intake.ts` | 复用既有 `AutonomyIncident` 持久化（kind = `INTERNAL_FAULT`）：原子聚合、容器不劫持、终态不复活 |
| `apps/api/src/__tests__/internal-code-repair-phase1-classification.test.ts` | 12 类逐类可达 + 确定性 + 模型无权 + 脱敏（29 用例） |
| `apps/api/src/__tests__/internal-code-repair-phase1-incident-db.test.ts` | 真实 PostgreSQL：聚合 / 6 路并发 / 容器隔离 / 终态 / 权限隔离 / 落库脱敏（6 用例） |

边界与判定口径（可复核）：

- **12 类**（指令顺序）：API_TIMEOUT / API_RATE_LIMIT / TOKEN_EXPIRED / PROVIDER_SCHEMA_CHANGED / PARSER_FAILURE / WORKFLOW_PLANNING_ERROR / DATA_CONFLICT / DATABASE_TRANSACTION_ERROR / RUNTIME_EXCEPTION / INTEGRATION_CONTRACT_MISMATCH / REGRESSION_FAILURE / UNKNOWN_ERROR；规则表**顺序即优先级**，同一证据必然同一结论（含去重键）。
- **不猜**：HTTP 403 等无确定证据的情形**不冒充** TOKEN_EXPIRED，落 UNKNOWN_ERROR + HUMAN_REVIEW（有专门用例）。
- **模型无权限**：`annotateUntrustedModelHint()` 只记录模型声称的类别与理由，`authority = 'NONE'`，不参与分类 / 风险 / 重试 / 权限；即使「猜对」也不构成授权。
- **单向升级**：触及安全 / 权限语义时只允许更保守（HIGH + HUMAN_REVIEW + 禁自动重试），原有 AUTO_RECOVER 会被收回。
- **AUTO_RECOVER 仅限确定性可重试类别**（API_TIMEOUT / API_RATE_LIMIT / DATABASE_TRANSACTION_ERROR）；其余一律 CODE_FIX_REQUIRED / 人工。
- **OWNER 动作来自既有清单**：TOKEN_EXPIRED ⇒ `ownerGatedAction = 'PRODUCTION_CREDENTIALS'`（`requiresOwnerApproval()` 为真，RSI 不能自我授权）。
- **脱敏**：Token / Bearer / JWT / API key / 邮箱 / 长数字 / 绝对路径在摘要、落库载荷与模型提示归档中一律打码；组织 / Provider 只以 `org-<sha16>` / `provider-<sha16>` 不可逆引用落库。
- **权限隔离（结构级）**：修复平面 Incident kind = `INTERNAL_FAULT` ≠ 客户执行面 `CUSTOMER_GOAL_QUEUE`；既有 `createAutonomyTaskSource().claim()` 对前者一律拒绝并持久化 BLOCKED。

验收证据（本轮实测）：

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| 纯函数分类 | `vitest run src/__tests__/internal-code-repair-phase1-classification.test.ts` | **29/29 PASS** |
| 真实 PostgreSQL | 隔离库 `crossclaim_p3r2_iso`（本任务自建） | **6/6 PASS** |
| 定向回归 | classification + incident-db + rsi-schema-contract + si-rsi-phase1-authorization + si-rsi-phase1-durable-queue | **5 文件 / 58 tests 全绿** |
| 类型检查 | `tsc --noEmit -p apps/api/tsconfig.json` | **0 error** |

### 1.4 独立审计结果（MSG-20261009-07 = PASS WITH REVISE）

**裁决原文**：`AI-ARCHITECT-INBOX.md` → `### [MSG-20261009-07]`（逐字归档，FNV1A `69f7b353`，`FULL_COPY_OK`：143 行 / 缺失 0 / 多出 0）。
会话：`https://chatgpt.com/c/6ac8319c-7ef0-83ec-b863-4ca9fc23d96e`（右侧新会话）；投递三项校验全过（输入框清空 / 消息作为新用户轮出现 / 进入生成态）。

| 审计项 | 裁决 |
| --- | --- |
| PHASE0_CAPABILITY_AUDIT | **PASS** |
| PHASE1_DETERMINISTIC_CLASSIFICATION | **PASS** |
| PHASE1_MODEL_AUTHORITY_BOUNDARY | **PASS** |
| PHASE1_SANITIZATION | **REVISE** |
| PHASE1_INCIDENT_CONTAINER_ISOLATION | **REVISE** |
| PHASE1_VERIFICATION_EVIDENCE | **REVISE** |
| SCOPE_HONESTY | **PASS** |

结论：`PHASE0_CLOSED = YES`、`PHASE1_FUNCTIONAL_BASELINE = ACCEPTED`、`PHASE1_CLOSED = NO`、
`PHASE2_IMPLEMENTATION_AUTHORIZED = NO`、`AUTONOMOUS_CODE_WRITE_ENABLED = NO`。

**下一单元 = PHASE1-FINAL-R2**（审计指定，本轮只做这四项，不提前实施 PHASE 2–7、不新增修复代理）：

| CHANGE | 级别 | 要求（审计原文要点） |
| --- | --- | --- |
| 1 | P0 | Incident 首次并发创建 / 唯一冲突 / 计数累加 / 终态保护的数据库原子性；含 **≥20 路并发**创建与混合创建-更新；证明不同 kind 冲突恒定拒绝、CLOSED/REJECTED 不被竞争请求复活 |
| 2 | P0 | 脱敏对抗测试（URL query / HTTP header / 嵌套 JSON / Bearer·JWT·API key 变体 / 多行堆栈与 cause 链 / DB 错误文本 / 编码转义）；结构化字段采用**白名单**持久化 + 文本长度上限；无法可靠识别的自由文本宁可丢弃 |
| 3 | P0 | 真实 PostgreSQL 生命周期与租户边界（OPEN/DIAGNOSED/CLOSED/REJECTED 重复接纳行为；跨组织不得合并；同组织不同 Provider 的身份规则；`INTERNAL_FAULT` 不可被 `CUSTOMER_GOAL_QUEUE` 执行器认领；**哈希化组织引用 ≠ 租户授权**） |
| 4 | P1 | 分类结果的安全重试语义：**故障可重试 ≠ 业务动作可重放**；外部写结果不明先对账不重放；403 不自动等同 TOKEN_EXPIRED；安全/权限信号优先升级；UNKNOWN_ERROR 默认禁自动恢复 |

**审计登记的新增风险**：并发首次创建计数不一致（P0，CHANGE 1）／非结构化错误文本泄漏凭据（P0，CHANGE 2）／
Incident 跨租户访问或误合并（P0，CHANGE 3）／可重试故障被误认为可重放业务动作（P0，CHANGE 4）／
全量回归未运行（P1）／真实模型·Provider·Linux 未验证（HOLD）。

> 归档限制说明：`tools/verification/archive-verdict.mjs` 校验的是**归档文本 = 抽取源文件**（机械一致），
> 抽取本身的正确性由 DOM 容器选择与 FNV1A 指纹共同固定（本次为 `69f7b353`）。

### 1.5 PHASE1-FINAL-R2 进度（MSG-20261009-07 指定的四项修订）

| CHANGE | 级别 | 状态 | 证据（本轮实测） |
| --- | --- | --- | --- |
| 1 Incident 并发创建 / 去重原子性 | P0 | **本轮完成** | 见下 |
| 2 脱敏边界补强（对抗测试 + 结构化白名单） | P0 | **本轮完成** | 见下 |
| 3 Incident 生命周期与租户边界 | P0 | **本轮完成** | 见下 |
| 4 分类安全重试语义 | P1 | NOT_STARTED | — |

**CHANGE 1 实现口径**（`apps/api/src/services/self-repair/fault-incident-intake.ts`）：

- 并发路径不再「先 `findUnique` 再 `create`」；把**创建 / 聚合 / 终态保护 / 容器隔离**压进**一条**
  `INSERT ... ON CONFLICT ("dedupeKey") DO UPDATE ... WHERE kind/status` 语句（数据库级原子 upsert）。
- 冲突分支带前置条件 ⇒ **终态行与外来容器在 SQL 层就不可写**；返回 0 行时只做**只读**定位
  （`KIND_MISMATCH` / `INCIDENT_NOT_OPEN`）或重试，不盲目重放。
- 「本次是否新建」由「返回行 id == 本请求预生成 id」判定（不依赖 `xmax` 等实现细节）。
- 生命周期契约（`OPEN → DIAGNOSED`）在**接线时** fail-fast 校验，不在并发路径上悄悄写坏数据。

**CHANGE 1 验收（真实 PostgreSQL，隔离库 `crossclaim_p3r2_iso`）**：

| 用例 | 结果 |
| --- | --- |
| DB-P2 **20 路并发**同一故障 | **1 行 / 计数=20 / 恰好一次新建**，20 路全部被接纳（无丢接纳、无重复行） |
| DB-P7 混合创建-更新并发（12 路旧键 + 8 路新键） | 旧键计数 13（1 种子+12）**无一次判新建**；新键 8 且恰好一次新建；共 2 行、诊断载荷未串写 |
| DB-P8 **CLOSED 后 10 路并发** | 全部 `INCIDENT_NOT_OPEN`；状态仍 `CLOSED`、计数仍 1、未另建新行 |
| DB-P9 **外来容器（`CUSTOMER_GOAL_QUEUE`）占位 + 10 路并发** | 全部 `KIND_MISMATCH`；该行 id/kind/status/riskClass/sourceRefs **零改动** |

| 门禁 | 结果 |
| --- | --- |
| 纯函数分类 | 29/29 PASS |
| 真实 PostgreSQL 套件 | **9/9 PASS** |
| 定向回归（新增 2 + schema-contract + phase1-authorization + phase1-durable-queue） | **5 文件 / 61 tests 全绿** |
| `apps/api tsc --noEmit` | **0 error** |

**CHANGE 2 实现口径**（`fault-classification.ts`）：

- **掩码面扩展**：PEM 私钥块、JWT、`Bearer/Basic`（大小写与形态变体）、键值赋值形态（含 JSON 引号包裹如 `"apiKey":"…"`、
  `X-Api-Key:`、`Cookie:`、`private_key` 等）、云厂商与常见前缀密钥（`AKIA/ASIA`、`sk_/pk_/rk_/ghp_/github_pat`）、
  URL query 密钥（`access_token/api_key/signature`）、32+ 位长 hex、邮箱、POSIX 与 Windows 绝对路径。
- **编码绕过**：对含 `%XX` 的文本最多**解码两轮后重新掩码**（URL 编码是常见绕过手法）。
- **丢弃优先于猜测**：掩码后若仍残留「值形态」证据或无法识别的长 token（UUID 形状除外）⇒
  整段替换为 `[dropped-unverifiable-text]`，**不推测其安全**。
- **结构化白名单**：新增 `FAULT_SOURCE_REF_FIELDS`（24 键）并由 `whitelistSourceRefs()` 在装配时**运行时过滤**，
  任何未列出的键都不落库；代码 / 阶段等短字段一旦无法判定安全则**置空**而非留存。
- **可持久化长度上限**：`FAULT_TEXT_LIMITS`（summary 300 / ref 200 / code 80 / module 120 / stage 60 / modelHint 200）。
- **引用收紧（本轮由对抗测试驱动发现并修复）**：refs 是**结构化标识符**，不是自由文本 ——
  凡含任何「需要掩码的内容」（密钥 / 邮箱 / 路径 / 长 hex）或不符合 `prefix:value` 保守字符集者**整条丢弃**。
  该收紧修掉了一个真实夹带面：旧实现会把整段错误报文（含空格与掩码片段）当 `evidenceRef` 落库。
  代价（**故意选定**）：含 40 位 SHA 的 `head:` 类引用会被一并丢弃 —— 已登记为调用方契约（只传 id）。
- **无日志**：两个模块**零日志输出**（源码级用例断言无 `console.` / `process.stdout`），敏感原文不进可读日志。
- **夹具卫生（本轮实际发生并已修正）**：对抗夹具初版含 `sk_live_…` 形态字面量，**被 GitHub Push Protection 判定为 Stripe 密钥并拒绝推送**；
  已全部替换为明显合成值（`sk-DUMMYKEY-…`，不含任何真实 provider 前缀形态）后重推。测试夹具**不含任何真实密钥**。

**CHANGE 2 验收**：对抗矩阵 11 例（URL query / header 形态 / 嵌套 JSON / PEM / 大小写变体 / URL 编码 / 多行堆栈+cause+DB 文本 /
Linux 路径 / Windows 路径 / 邮箱 / 长数字）逐例断言**密钥原文在摘要与落库载荷中均不可见**；
白名单键集合逐字等于 24 键；全部可持久化字符串 ≤ 字段上限；自由文本引用被丢弃（`task: recovery with spaces`、
`evidence:Error: insert failed…`、`{"raw":"payload"}` 全部不落库）。门禁：纯函数套件 **48/48 PASS**、
定向回归 **5 文件 / 80 tests 全绿**、`tsc --noEmit` **0 error**。

## 2. 阶段计划与当前状态

| PHASE | 内容 | 状态 |
| --- | --- | --- |
| 0 | 现有能力审计（本文件 §1） | **本轮完成** |
| 1 | 内部故障诊断中心（API_TIMEOUT / RATE_LIMIT / TOKEN_EXPIRED / SCHEMA_CHANGED / PARSER_FAILURE / … / UNKNOWN_ERROR 的确定性分类 → Incident） | **PASS WITH REVISE**（功能基线已接受；收口 4 项 CHANGE 见 §1.4） |
| 2 | 自动恢复 vs 代码修复分流（A 可恢复业务故障 → 既有 ONE SI Runtime；B 可复现 Bug → `CODE_REPAIR_CANDIDATE`；C 需外部权限 → BLOCK / HUMAN_REVIEW_REQUIRED） | NOT_STARTED |
| 3 | 内置 AI Code Repair Agent（复用 Model Gateway；隔离工作区；最小 Patch；受限命令白名单；成本/超时/文件范围限制；Prompt Injection 防护） | NOT_STARTED |
| 4 | 独立 Judge 与自动验证（Builder ≠ Judge；真实测试命令 + 退出码 + 输出证据；REVISE 有界重试） | NOT_STARTED |
| 5 | 受控发布准备（生成修复分支 / Patch / **可审计 PR**；**禁止**自动合并主线、自动改封板、自动生产迁移/发布） | NOT_STARTED |
| 6 | 故障与恢复学习（复用 Experience / Outcome；低样本/冲突/过期经验降权） | NOT_STARTED |
| 7 | 真实端到端验收 A–P（含恶意日志 Prompt Injection、越预算阻断、无凭据安全阻断、幂等去重、中断恢复、生成 PR 而非自动部署） | NOT_STARTED |

**安全隔离要点（PHASE 3 必须实现，先记录为设计约束）**：不在运行中的 API/RSI 目录直接改码；独立容器或等效隔离；低权限 + 受限文件系统 + 命令白名单；CPU/内存/磁盘/超时/模型成本上限；默认禁访问生产库与生产密钥、默认禁互联网外写；不得让模型读取生产 env 文件；不得为让测试通过而改封板或安全门禁；对客户内容 / Provider 响应 / 日志做 Prompt Injection 防护。

## 3. 状态（截至本文件提交）

```
ONE_SI_RUNTIME_UNCHANGED = YES（未新增第二套运行时/调度器/控制器）
CUSTOMER_AUTONOMOUS_RECOVERY = CLOSED（PHASE 1–3 已审计；本任务基线）
INTERNAL_DIAGNOSIS = PHASE_1_IMPLEMENTED（确定性分类；12 类逐类可达；29 纯函数用例 + 6 真实 PG 用例 PASS）
INTERNAL_CODE_REPAIR_AGENT = NOT_IMPLEMENTED（PHASE 0 实测：无 code-repair 模块）
CODEX_RUNTIME_DEPENDENCY = STILL_PRESENT（本次建设期间由 Codex 完成；建成后须自证可脱离 Codex）
MODEL_GATEWAY_REUSED = 计划复用（未接线）
REAL_MODEL_INTEGRATION = HOLD（未取得真实模型凭据前不得宣称联通）
AUTONOMOUS_PATCH_GENERATION = NOT_STARTED
SANDBOX_PATCH_EXECUTION = NOT_STARTED
AUTOMATED_TEST_VERIFICATION = NOT_STARTED
INDEPENDENT_JUDGE = 复用既有 Verifier/verdict 机制（未接入修复流）
PROMPT_INJECTION_RESISTANCE = NOT_STARTED（现有 goal-compiler 已有 injection 检测，可复用）
PRODUCTION_SECRET_ISOLATION = 设计约束已登记（未实现）
DURABLE_REPAIR_TASK = 复用既有 durable task/lease（未接线）
EXPERIENCE_LEARNING = 复用既有 Experience/Meta（未接线）
AUTO_PRODUCTION_CODE_MODIFICATION = FORBIDDEN
AUTO_PRODUCTION_DEPLOYMENT = FORBIDDEN
FULL_REGRESSION = 本单元定向回归 5 文件 / 58 tests 全绿（真实 PG 隔离库）；全量回归待 PHASE 7
NEW_RELEASE_CANDIDATE = NOT_STARTED
INDEPENDENT_AUDIT = MSG-20261009-07 = PASS WITH REVISE（逐字归档 FULL_COPY_OK / FNV1A 69f7b353）
PHASE0_CLOSED = YES
PHASE1_CLOSED = NO（待 PHASE1-FINAL-R2：CHANGE 1–4 后复审）
PHASE2_IMPLEMENTATION_AUTHORIZED = NO
**CHANGE 3 实现口径**：

- **显式身份规则**（`FAULT_INCIDENT_IDENTITY_RULE` + 键结构）：
  `INTERNAL_FAULT:<faultClass>:<sourceModule>:<tenantScope>:<providerScope>:<证据指纹>`。
  · **租户参与身份** ⇒ 不同组织的同一错误签名**绝不合并**（避免跨租户信息混合）；无租户上下文记为 `global`。
  · **Provider 参与身份** ⇒ 同组织跨 Provider **不合并**（契约漂移/凭据过期/解析差异的根因与责任方不同）；无 Provider 记为 `noprovider`。
  · 落库/入键只用**不可逆引用**（`org-<sha16>` / `provider-<sha16>`），原始 id 永不入键、不落库。
- **租户范围读取** `listForOrganization({ organizationId })`：必须由**服务端可信租户上下文**提供原始组织 id，
  内部推导引用后只返回该组织的故障 Incident；空上下文 **fail-closed 返回空**（不是"返回全部"）。
  导出 `faultOrganizationRef()` 供读取路径推导同一引用 —— 并明确登记：**哈希引用不是授权凭证**。
- 生命周期：`OPEN` 聚合时按既有 `rsi-lifecycle` 合法跃迁转为 `DIAGNOSED`；`CLOSED` / `REJECTED` / `TASKED`
  一律**拒绝且不复活、不加计数**。

**CHANGE 3 验收（真实 PostgreSQL，隔离库 `crossclaim_p3r2_iso`）**：

| 用例 | 结果 |
| --- | --- |
| DB-P10 生命周期矩阵 | `OPEN`（计数 5）⇒ 聚合为 6 且转 `DIAGNOSED`；`CLOSED`/`REJECTED`/`TASKED` 三态各判 `INCIDENT_NOT_OPEN` 且状态/计数不变；回到 `DIAGNOSED` 继续聚合为 7 |
| DB-P11 跨租户隔离 | 同签名不同组织 ⇒ **2 行不同键**；租户视图只含本租户；`global` 故障不进入任何租户视图；视图内**不含原始组织 id** |
| DB-P12 哈希不是授权 | 用不可逆引用冒充租户 id ⇒ 查询 0 行；空/空白租户上下文 ⇒ fail-closed 0 行 |
| DB-P13 Provider 身份 | 同组织跨 Provider ⇒ 2 行、各带自己的 provider 引用、组织引用一致 |
| DB-P14 伪造无权限 | 即便伪造「客户任务前缀形状的 dedupeKey + 客户容器形状的 sourceRefs（含 ACTIVE 长期授权）」仍被既有 `claim()` 以 kind 拒绝：领取 0 条、任务持久化 `BLOCKED`、零租约；修复平面读取也不认该形状 |
| 纯函数身份规则 | 跨组织/跨 Provider 键分离、大小写归一、`global`/`noprovider` 作用域、规则登记项逐条断言 |

NEXT_UNIT = PHASE1-FINAL-R2（CHANGE 1 ✅ / CHANGE 2 ✅ / CHANGE 3 ✅ → NEXT = CHANGE 4 P1 安全重试语义 → 复审）
PRODUCTION_READY = NO
HOST_ACTION_REQUIRED = 真实模型凭据（用于 PHASE 3/7 真实联调）；Linux 隔离执行环境（用于真实沙箱补丁验证）
```
