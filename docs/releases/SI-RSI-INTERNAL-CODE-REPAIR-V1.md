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
| 4 分类安全重试语义 | P1 | **本轮完成** | 见下 |

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

### 1.7 独立复审裁决（MSG-20261009-08 = PASS WITH REVISE；**PHASE 1 收口**）

**裁决原文**：`AI-ARCHITECT-INBOX.md` → `### [MSG-20261009-08]`（逐字归档，FNV1A `3ed6a0de`，`FULL_COPY_OK`：135 行 / 缺失 0 / 多出 0）。
会话：`https://chatgpt.com/c/6ac83622-e384-83ec-8938-eb6e13eea232`（右侧新会话）；三项投递校验全过。

| 审计项 | 裁决 |
| --- | --- |
| CHANGE1_INCIDENT_CONCURRENCY_ATOMICITY | **PASS** |
| CHANGE2_SANITIZATION_BOUNDARY | **PASS** |
| CHANGE3_LIFECYCLE_AND_TENANT_BOUNDARY | **PASS** |
| CHANGE4_REPLAY_SAFETY_SEMANTICS | **PASS** |
| PHASE1_EVIDENCE_SUFFICIENCY | **PASS WITH REVISE**（全量回归列为 PHASE 2 前置门禁） |
| SCOPE_HONESTY | **PASS** |

阶段状态：`PHASE0_CLOSED = YES`、**`PHASE1_CLOSED = YES`**、`PHASE2_IMPLEMENTATION_AUTHORIZED = YES_SAFE_SCOPE_ONLY`、
`PHASE2_CLOSED = NO`、`PHASE3_TO_7_AUTHORIZED = NO`；`EXTERNAL_WRITE = HOLD`、`REAL_PROVIDER_VALIDATION = NO`、
`REAL_MODEL_INTEGRATION = HOLD`、`PRODUCTION_READY = NO`。

**PHASE 2 授权边界（原文要点）**：复用 ONE SI Runtime（不得新增 Scheduler / Controller / 第二执行器）；
以**可信 Incident 与既有持久化事实**为输入完成确定性分流；把 `RECONCILE_FIRST` / `FORBIDDEN` / `NEEDS_CLASSIFICATION`
分别映射到明确的安全路径；**不得因 PHASE 1 的 `AUTO_RECOVER` 分类结果直接执行外部业务写入**；
不得修改封板 RC / main、生产数据库或生产授权策略；PHASE 2 完成后须**单独申请复审**。

**GATE-1..6（审计登记的后续门禁，非 PHASE 1 阻断项）**：

| 编号 | 级别 | 要求 |
| --- | --- | --- |
| GATE-1 | P1 | 运行全量 API 回归，区分历史债务与本轮引入回归 |
| GATE-2 | P0 | 验证 PHASE 2 每条分流路径都不能绕过既有租户认证、Incident kind、生命周期与可信事实来源 |
| GATE-3 | P0 | 验证外写相关故障不会因「被分类为可重试」而自动重放；实际外写继续 HOLD |
| GATE-4 | P0 | 真实运行时下验证异常重投 / 重复分流 / 断连 / 崩溃恢复 / 并发处理的幂等与 fencing |
| GATE-5 | P1 | 接线边界增加脱敏负向测试（原始异常、未知 sourceRefs、模型自由文本不得绕过白名单） |
| GATE-6 | P1 | 后续若确需 schema / migration 变更，须先提交独立 Schema Delta 审计 |

**RISKS（原文）**：`FULL_REGRESSION_NOT_VERIFIED` / `SANITIZATION_UNKNOWN_PATTERNS` / `TENANT_CONTEXT_TRUST_BOUNDARY` /
`INCIDENT_DELIVERY_DUPLICATION` / `REPLAY_RUNTIME_AUTHORIZATION_GAP` / `PRODUCTION_ENVIRONMENT_NOT_VERIFIED`。

**审计方附加约束（照录要点，PHASE 2 必须遵守）**：

1. `replaySafety.autoRecoverAuthorized = true` **只是分类结果，不是运行时授权凭证**；分流与执行阶段必须再次检查
   服务端可信事实、幂等状态、租约 fencing、授权时效与生产外写门禁。
2. `listForOrganization()` 必须**始终**使用经服务端认证与授权解析得到的 `organizationId`，
   不允许从请求参数、客户端输入或模型输出直接取得身份；未加 DB 级 RLS / 独立组织列不代表 DB 层已有完整租户隔离。
3. `occurrenceCount` 应解释为「**被数据库接受的 intake 次数**」，不必然是全局唯一故障事件数（客户端重试可能重复计数）。

## 2. 阶段计划与当前状态

| PHASE | 内容 | 状态 |
| --- | --- | --- |
| 0 | 现有能力审计（本文件 §1） | **本轮完成** |
| 1 | 内部故障诊断中心（API_TIMEOUT / RATE_LIMIT / TOKEN_EXPIRED / SCHEMA_CHANGED / PARSER_FAILURE / … / UNKNOWN_ERROR 的确定性分类 → Incident） | **CLOSED**（MSG-20261009-08；PHASE 0 + PHASE 1 全部收口） |
| 2 | 自动恢复 vs 代码修复分流（A 可恢复业务故障 → 既有 ONE SI Runtime；B 可复现 Bug → `CODE_REPAIR_CANDIDATE`；C 需外部权限 → BLOCK / HUMAN_REVIEW_REQUIRED） | **IN_PROGRESS**：确定性分流模块已完成并验收（见 §2.1）；HIGH_RISK 路径仍 HOLD |
| 3 | 内置 AI Code Repair Agent（复用 Model Gateway；隔离工作区；最小 Patch；受限命令白名单；成本/超时/文件范围限制；Prompt Injection 防护） | NOT_STARTED |
| 4 | 独立 Judge 与自动验证（Builder ≠ Judge；真实测试命令 + 退出码 + 输出证据；REVISE 有界重试） | NOT_STARTED |
| 5 | 受控发布准备（生成修复分支 / Patch / **可审计 PR**；**禁止**自动合并主线、自动改封板、自动生产迁移/发布） | NOT_STARTED |
| 6 | 故障与恢复学习（复用 Experience / Outcome；低样本/冲突/过期经验降权） | NOT_STARTED |
| 7 | 真实端到端验收 A–P（含恶意日志 Prompt Injection、越预算阻断、无凭据安全阻断、幂等去重、中断恢复、生成 PR 而非自动部署） | NOT_STARTED |

**安全隔离要点（PHASE 3 必须实现，先记录为设计约束）**：不在运行中的 API/RSI 目录直接改码；独立容器或等效隔离；低权限 + 受限文件系统 + 命令白名单；CPU/内存/磁盘/超时/模型成本上限；默认禁访问生产库与生产密钥、默认禁互联网外写；不得让模型读取生产 env 文件；不得为让测试通过而改封板或安全门禁；对客户内容 / Provider 响应 / 日志做 Prompt Injection 防护。

### 2.1 PHASE 2 进展（安全范围）：确定性故障分流

新增（**纯新增**）：`apps/api/src/services/self-repair/fault-triage.ts`（纯函数）
与 `src/__tests__/internal-code-repair-phase2-triage.test.ts`（20 用例）、
`src/__tests__/internal-code-repair-phase2-triage-db.test.ts`（真实 PostgreSQL 往返，5 用例）。

分流结论（5 种，均**不执行任何动作**）：

| 分流结论 | 触发条件（判定顺序即优先级） | 语义 |
| --- | --- | --- |
| `BLOCK_HUMAN_REVIEW` | kind ≠ `INTERNAL_FAULT`／状态 ≠ `DIAGNOSED`／载荷非白名单对象或非确定性来源／安全或权限信号／OWNER-gated 动作／`FORBIDDEN` 且非修复路径／可信事实复核未过／授权不活跃／租户身份未解析／**外部写** | BLOCK，必要时给出既有 OWNER-gated 待办动作 |
| `NEEDS_CLASSIFICATION` | 未分类故障 | 人工，默认禁止自动恢复 |
| `RECONCILE` | `RECONCILE_FIRST` 或 `requiresReconciliation` | **先对账，禁止直接重放**（给出对账要求文本） |
| `CODE_REPAIR_CANDIDATE` | `FORBIDDEN` 且 `requiredAction = CODE_REPAIR_CANDIDATE` | 交 PHASE 3 修复代理（**尚未实现**，本层只登记候选） |
| `AUTO_RECOVER_VIA_RUNTIME` | PHASE 1 显式重放授权 + 类别在确定性可重试白名单 + 非外写 + 可重放操作 + 租户身份可信 + 授权活跃 + **运行时复核确认** | **只把候选交回既有 ONE SI Runtime**（`runtimeHandoffAuthorized` 仅表示"可再校验"，不是执行授权） |

关键安全口径（对应 MSG-20261009-08 的 GATE-2/GATE-3 与附加约束）：

- **不新增第二套运行时**：本层 `executesNothing`、不建任务、不建租约、不调 Provider；一切执行仍由既有运行时路径承担。
- **不信落库声明**：A 路径必须由服务端**可信事实**复核通过（`organizationIdResolved` / `authorizationActive` /
  `operationRecheck`），不允许从请求参数、客户端输入或模型输出取得身份 —— 哈希引用不是授权。
- **外写恒 HOLD**：即便载荷被篡改为 `AUTO_RETRY_CANDIDATE`，`operationKind = EXTERNAL_WRITE` 也在分流层被拦下（纵深防御用例）。
- **fail-closed 解析**：载荷缺字段 / 类型不符 / `classificationAuthority ≠ DETERMINISTIC_RULES_ONLY` 一律 BLOCK。
- **模型无权**：载荷中即使存在模型"建议"（`untrustedModelHint`）也不改变分流结论（有专门用例）。

验收：纯函数 **20/20 PASS**（含 5 路径矩阵、篡改用例与边界声明断言）；真实 PostgreSQL **5/5 PASS**
（真实落库行的 A 路径、外部写对账、修复候选、未分类、终态行不可分流；全程零任务零租约）；
PHASE 1 + PHASE 2 合并定向回归 **7 文件 / 123 tests 全绿**；`apps/api tsc --noEmit` **0 error**。

**PHASE 2 第二单元 —— 分流扫描（只读 + 只登记，零执行）**：
`apps/api/src/services/self-repair/fault-triage-sweep.ts`（+ 真实 PG 套件 `internal-code-repair-phase2-triage-sweep-db.test.ts`）。

- 只读扫描 `kind = INTERNAL_FAULT` 且 `status = DIAGNOSED` 的行；
- **可信事实必须注入**（`resolveTrustedFacts`，服务端来源）；缺省即 **fail-closed**（无法确认 ⇒ BLOCK，拿不到 A 路径）；
- 只把**固定 3 个服务端字段**登记回 `sourceRefs`：`triageDecision` / `triageReason` / `triagedAt`（均非自由文本），
  登记语句带 `kind`/`status` 前置条件（并发中转终态的行不会被登记）；
- **绝不**建任务 / 租约、绝不调用 ONE SI Runtime、绝不做外部写：返回值恒为
  `tasksCreated = 0` / `leasesCreated = 0` / `runtimeInvocations = 0`（并有静态断言：模块不 import `../runtime/`、源码不含 `autonomyTask`/`autonomyLease`/`console.`）。

验收（真实 PostgreSQL）：DB-S1 注入可信事实 ⇒ A 路径候选与修复候选各得其所且**只登记不执行**（零任务零租约）；
DB-S2 未注入 ⇒ 全部 BLOCK（`TENANT_CONTEXT_NOT_TRUSTED`）；DB-S3 只扫 `DIAGNOSED`（`OPEN`/`CLOSED` 不进入）；
DB-S4 登记仅固定三项且值为稳定码 / ISO 时间；DB-S5 静态证据。PHASE 2 三套件 **30/30 PASS**。

### 2.2 GATE-1（MSG-20261009-08 指定门禁）：全量 API 回归 = **PASS**

| 项目 | 结果 |
| --- | --- |
| `REVIEWED_HEAD` | `3acfb195`（本轮 PHASE 2 扫描提交） |
| 环境 | 隔离库 `crossclaim_p3r2_iso`（本任务自建；未触碰共享开发库） |
| 命令 | `vitest run`（apps/api 全量） |
| 结果 | **490 / 490 测试文件通过、4926 / 4926 用例通过、exit 0**，耗时 1582.53s |
| 证据文件 | `tools/verification/self-repair/phase2-gate1-full-regression.json`（含日志 SHA256 前 16 位 `ca7ea00c76aa66cc`、字节数 171834） |

- 汇总脚本按关键字统计出的 4 条 “FAIL” 命中**全部是测试名称**中含 `FAILED` / `fail-closed` 的正常通过用例（行首均为 ✓），**真实失败数为 0**。
- 历史登记的 P2E-DB5 隔离债与 broker authorization hook 超时债在本轮全量运行中**未复现**；仍不视为关闭（单次通过不足以关闭历史测试债）。
- 如实声明未验证项：Linux/systemd 实机、真实 Provider/模型联调（`REAL_MODEL_INTEGRATION = HOLD`）、生产环境、GitHub Actions（本记录仅代表**本机隔离库**证据）。

### 2.3 GATE-4（P0）在 PHASE 2 层可覆盖的部分：**幂等与并发已验收**

GATE-4 原文要求「真实运行时测试异常重投、重复分流、断连、崩溃恢复和并发处理时的幂等与 fencing」。
其中**分流层**可自验的部分已补测（真实 PostgreSQL，DB-S6/S7/S8）：

| 用例 | 结论 |
| --- | --- |
| DB-S6 **重复分流幂等** | 连跑两次扫描：结论一致（`AUTO_RECOVER_VIA_RUNTIME`）、登记字段逐字稳定（`sourceRefs` 深比较相等）、键数量不变、零任务零租约 |
| DB-S7 **并发扫描（4 路同时）** | 四路结论一致、登记字段不重复（每个 triage 键恰好出现一次）、零任务零租约 |
| DB-S8 **扫描 vs 状态变更竞争** | 分流过程中被置为 `CLOSED` ⇒ 登记被 `kind`/`status` 前置条件挡住（`registered = 0`），该行仍是 `CLOSED` 且**无** triage 字段，流程不抛错 |

**仍不覆盖的部分（如实登记，不由本层自证）**：运行时的租约 fencing、数据库断连、进程崩溃恢复与异常重投 ——
这些属于既有 ONE SI Runtime 路径，已由既有 SI/RSI 门禁（PHASE 3 收官 / `FAILURE_RECOVERY` 门禁 MSG-20261009-06）覆盖；
PHASE 2 本层不执行任何动作，故不重复实现第二套恢复机制。

### 2.4 独立复审裁决（MSG-20261009-09 = PASS WITH REVISE；PHASE 2 安全范围获认可）

**裁决原文**：`AI-ARCHITECT-INBOX.md` → `### [MSG-20261009-09]`（逐字归档，FNV1A `1d735f7f`，`FULL_COPY_OK`：167 行 / 缺失 0 / 多出 0）。
会话：`https://chatgpt.com/c/6ac8403a-f6a4-83ec-9507-72d05dba4f0f`。

| 审计项 | 裁决 |
| --- | --- |
| 1 TRIAGE_DETERMINISM_AND_SAFETY_PATHS | **PASS** |
| 2 TRUSTED_FACTS_BOUNDARY | **PASS**（真实来源仍需接线验证） |
| 3 READ_ONLY_SWEEP_AND_REGISTRATION | **PASS** |
| 4 GATE1_FULL_REGRESSION_EVIDENCE | **PASS** |
| 5 GATE2_GATE3_COVERAGE | **PASS** |
| 6 GATE4_LAYERING | **REVISE**（登记并发的严格语义需补证） |
| 7 SCOPE_HONESTY | **PASS** |
| GATE-5 单独裁决 | **REVISE** |
| GATE-6 | PASS / NOT APPLICABLE（本轮无 Schema 变更） |

机器裁决：`PHASE2_SAFE_SCOPE_ACCEPTED = YES`、**`PHASE2_CLOSED = NO`**、
`PHASE3_DESIGN_AUTHORIZED = YES_READ_ONLY`、`PHASE3_IMPLEMENTATION_AUTHORIZED = NO`、`PHASE4_TO_7_AUTHORIZED = NO`、
`EXTERNAL_WRITE = HOLD`、`PRODUCTION_READY = NO`。`NEXT = PHASE2_FINAL_R2_FIXES_AND_PHASE3_READ_ONLY_DESIGN`、`NEXT_AUDIT = MSG-20261009-10`。

审计方特别认可：`runtimeHandoffAuthorized` 被限定为**再次校验的资格**而非任务提交/执行权限；
`FORBIDDEN + CODE_REPAIR_CANDIDATE` 只能进入未来修复审查路径，不得升级为自动改码或运行时重放；
GATE-4 允许「PHASE 2 证明分流纯度/登记幂等/状态竞争安全 + 既有 ONE SI Runtime 负责 lease/fencing/crash/reconcile」的分层证明。

**必须执行的 CHANGES（三项，均为 P1）**：

| CHANGE | 内容（审计原文要点） | 验收 |
| --- | --- | --- |
| 1 GATE-5 脱敏负向验收 | 针对**实际登记写入路径**与未来可读取该登记结果的既有接口：构造含 token / API key / 邮箱 / 攻击文本的故障载荷；检查 `triageDecision` / `triageReason` / `triagedAt` 是否**只接受规范值**；检查扫描返回、现有审计日志与可读投影是否意外泄露；证明恶意自由文本不会经 triage 新增的三个字段写入。**不要**擅自修改历史故障载荷的保留策略 | `GATE5_NEGATIVE = PASS` |
| 2 并发登记与时间戳语义 | 明确：重复扫描是否更新 `triagedAt`？4 路并发是否只有一次有效登记？旧决策是否会覆盖新决策？`DIAGNOSED → CLOSED` 后是否绝对禁止登记？可信事实在计算与写入之间变化时登记是否仍被当作有效资格？建议采用**首次写入、后续无变化即不更新**的幂等语义（或等效版本化机制）。**并特别指出：`sourceRefs` 的 JSON 更新必须避免并发丢失其它引用 —— 仅凭 kind/status 条件不足以证明无关字段不被覆盖** | `GATE4_TRIAGE_REGISTRATION = PASS` |
| 3 可信事实来源契约 | 将契约写入文档与测试：`organizationIdResolved` 必须由可信持久化身份关系解析；`authorizationActive` 必须由服务端当前授权状态得出；`operationRecheck` 必须来自可信执行上下文而非调用方自报；`resolveTrustedFacts` 实现不得把请求参数 / 客户端字段 / 模型输出直接映射为可信事实。并明确：**当前分流结果是快照，未来运行时不得无条件信任** | 契约与来源边界审查 |

**明确暂不允许（照录）**：实施自动代码修复代理；赋予修复代理仓库写入 / shell 执行 / 生产部署能力；
自动提交 PR / 自动合并 / 自动部署；把 `CODE_REPAIR_CANDIDATE` 直接作为代码修改授权；
把 `AUTO_RECOVER_VIA_RUNTIME` 候选直接派发到执行队列；实施 PHASE 4–7。
PHASE 3 的实现授权须在 PHASE 2 FINAL-R2 关闭并通过独立设计审计后单独给出。

**RISKS（原文）**：新增登记字段潜在脱敏遗漏（P1，CHANGE 1）/ 并发 JSON 更新及时间戳漂移（P1，CHANGE 2）/
可信事实调用方未来错误接线（P1，CHANGE 3）/ 历史隔离测试债与 broker hook 超时债（P2，保留观察）/
未验证 CI·Linux·systemd（P2）/ PHASE 3 代理越权修复代码（P0 未来）/
生产真实 Provider 与外写未验证（P0 上线，继续 HOLD）。

### 2.5 PHASE 2 FINAL-R2 进度（MSG-20261009-09 指定的三项修订）

| CHANGE | 级别 | 状态 | 证据 |
| --- | --- | --- | --- |
| 1 GATE-5 脱敏负向验收 | P1 | **本轮完成** | 见下 |
| 2 并发登记与时间戳幂等语义 | P1 | **本轮完成** | 见下 |
| 3 可信事实来源契约（文档 + 测试） | P1 | **本轮完成** | 见下 |

**CHANGE 1 实现口径**（`fault-triage.ts`）：

- 新增**值域校验**（`validatesPayloadValueDomains`）：`faultClass` / `requiredAction` / `replayDisposition` /
  `operationKind` / `idempotencyGuarantee` / `ownerGatedAction` 必须落在既有封闭值域内，否则整条载荷 fail-closed
  （`PAYLOAD_VALUE_NOT_CANONICAL`）。
- 由此**结构性**保证：被篡改成携带任意文本的字段既不会被当作语义使用，也**不可能**经由分流返回值外泄 ——
  例如对账要求文本原会拼接 `faultClass:operationKind`，值域校验后该串只可能由规范枚举拼接而成。
- 登记的三项仍为服务端固定字段（`triageDecision` / `triageReason` / `triagedAt`），只写枚举码与 ISO 时间。
- **未改动历史故障载荷的保留策略**（审计明确要求）：测试只观察登记边界，不重写既有字段。

**CHANGE 1 验收（真实 PostgreSQL + 纯函数）**：

| 用例 | 结论 |
| --- | --- |
| 纯函数 DB-等价负向矩阵（6 个字段逐一被塞入 `sk-DUMMYKEY-…` / 邮箱 / `<script>` / `/etc/passwd`） | 一律 `BLOCK_HUMAN_REVIEW` + `PAYLOAD_VALUE_NOT_CANONICAL`，且 `JSON.stringify(decision)` 不含任何注入文本 |
| 对账路径文本规范性 | `reconciliationRequirement` 形如 `^[A-Z_]+:[A-Z_]+ `，**不可能**夹带自由文本 |
| DB-S9 真实登记路径 | 恶意载荷（含未知键 `attackerExtraKey`）⇒ 结论与返回值零泄露；登记的三个字段均为规范值；**历史字段与未知键保持原样**；零任务零租约 |
| DB-S10 历史残留摘要 | 历史 `summary` 含敏感残留时，**扫描返回值仍不夹带**（登记边界不外泄） |
| 回归 | 正常载荷行为不变（A 路径 / 修复候选各自如常） |

门禁：PHASE 2 三套件 **43/43 PASS**；`apps/api tsc --noEmit` **0 error**。审计要求的验收名 `GATE5_NEGATIVE = PASS` 已达成。

**CHANGE 2 实现口径**（`fault-triage-sweep.ts`）：

- 登记语义改为 **first-write-wins**：更新语句追加 `AND NOT ("sourceRefs" ? 'triageDecision')`。
  · 重复扫描 ⇒ **不写**、`triagedAt` 不漂移、既有决策不被覆盖；
  · 并发扫描 ⇒ 行锁 + 条件重判下**只有一次**真正写入（其余进入幂等跳过计数）；
  · 任何非 `DIAGNOSED` 状态（含并发转为 `CLOSED`）⇒ **绝对禁止登记**（前置条件挡下）。
- `sourceRefs` 更新一律使用 jsonb **合并**（只增不改），**个别字段不被整对象覆盖** ⇒ 并发下不会丢失其它引用
  （包括 PHASE 1 既有键、以及历史遗留的未知键）。
- 返回值新增可审计计数：`registered`（首次写入）/ `alreadyRegistered`（幂等跳过）/ `skipped`（被 kind/status 挡下）；
  0 行时只做**只读**定位，保证计数语义不猜、不吞。
- 明确登记是**快照**（`registrationIsSnapshotNotAuthorization`）：可信事实若在「计算 → 写入」之间变化，
  已登记内容**不被改写**；运行时**不得**把该快照当作授权凭证（仍须自行复核，见 CHANGE 3 契约）。

**CHANGE 2 验收（真实 PostgreSQL）**：

| 用例 | 结论 |
| --- | --- |
| DB-S6 重复扫描 | 第二次 `registered = 0` / `alreadyRegistered = 1`；`sourceRefs` 深比较**逐字不变**（`triagedAt` 不漂移） |
| DB-S7 四路并发扫描 | 合计 `registered = 1` / `alreadyRegistered = 3`；三个 triage 键各出现一次 |
| DB-S8 并发中转为 `CLOSED` | `registered = 0` / `alreadyRegistered = 0` / `skipped = 1`；该行无 triage 字段且不抛错 |
| DB-S11 可信事实变化后重扫 | 当前计算结论变为 `BLOCK`（保留在 decisions 中），但**已登记快照不被覆盖**：`triageDecision` 仍为 A 路径、`triagedAt` 仍为首次值 |
| DB-S12 jsonb 合并不丢字段 | 并发扫描后 `unrelatedRefA` / `nested` / PHASE 1 的 `faultClass` 全部完整，`triageDecision` 正确 |

门禁：PHASE 2 三套件 **45/45 PASS**；`apps/api tsc --noEmit` **0 error**。审计要求的验收名 `GATE4_TRIAGE_REGISTRATION = PASS` 已达成。

**CHANGE 3 实现口径（契约 + 文档 + 测试）**：

- 契约正文：`docs/releases/SI-RSI-INTERNAL-CODE-REPAIR-V1-PHASE2-TRUSTED-FACTS-CONTRACT.md`。
- 可执行契约（`fault-triage.ts`）：
  · `TRUSTED_FACT_SOURCE_REQUIREMENTS`：`organizationIdResolved → TRUSTED_PERSISTED_IDENTITY`、
    `authorizationActive → SERVER_AUTHORIZATION_STATE`、`operationRecheck → TRUSTED_EXECUTION_CONTEXT`；
  · `FORBIDDEN_TRUSTED_FACT_SOURCES`：`REQUEST_PARAM` / `CLIENT_INPUT` / `MODEL_OUTPUT` / `UNKNOWN`（未声明即不可信）；
  · `assertTrustedFactSources()`：返回违规字段清单（禁止来源 / 配对错位 / 未声明）；
  · `defineTrustedFactsResolver()`：**唯一推荐**的解析器构造方式，违规声明在**创建期**抛
    `TrustedFactSourceContractError`；
  · `createPrismaFaultTriageSweep({ trustedFactSources })`：接线期再次校验，违规即抛错。
- **快照语义**：分流结论只是某一时刻的快照（`snapshotNotAuthorization`）；first-write-wins 保证「计算 → 写入」之间的
  可信事实变化**不改写**已登记内容，因此运行时**不得**把该快照当授权凭证，必须自行复核。

**CHANGE 3 验收**：契约负向矩阵（三个事实 × 禁止来源）、配对错位、未声明事实、构造期抛错、合法声明可解析、
源码级边界（不出现 `req./request.` 取值形态与 `modelOutput`、零日志）—— 共 **11 用例 PASS**；
PHASE 2 四套件合计 **56/56 PASS**（含真实 PostgreSQL 17 用例）；`apps/api tsc --noEmit` **0 error**。
审计验收名 `TRUSTED_FACTS_SOURCE_CONTRACT` 已达成。

### 2.6 复审裁决（MSG-20261009-10 = PASS WITH REVISE；PHASE 2 仍未 CLOSED）

**裁决原文**：`AI-ARCHITECT-INBOX.md` → `### [MSG-20261009-10]`（逐字归档，FNV1A `83707404`，`FULL_COPY_OK`：127 行 / 缺失 0 / 多出 0）。
会话：`https://chatgpt.com/c/6ac843b6-15a8-83ec-ae74-9899af07b3ba`。

| 审计项 | 裁决 |
| --- | --- |
| CHANGE1_GATE5_NEGATIVE_REDACTION | **PASS** |
| CHANGE2_REGISTRATION_CONCURRENCY_AND_IDEMPOTENCY | **PASS** |
| CHANGE3_TRUSTED_FACTS_SOURCE_CONTRACT | **PASS WITH REVISE**（声明约束成立，但声明本身不能证明数据真实来源） |
| PHASE2_EVIDENCE_SUFFICIENCY | **REVISE**（当前 HEAD 缺少同版本 GATE-1 全量回归证据） |
| SCOPE_HONESTY | **PASS** |

机器裁决：`PHASE2_CLOSED = NO`、`PHASE3_DESIGN_AUTHORIZED = YES_READ_ONLY`、`PHASE3_IMPLEMENTATION_AUTHORIZED = NO`、
`NEXT_AUDIT = MSG-20261009-11`。

**新增 CHANGES（三项，均 P1）**：

| CHANGE | 内容（审计原文要点） | 备注 |
| --- | --- | --- |
| 4 当前 HEAD 全量回归 | 在 `58c71cc1` 或**最终候选 HEAD** 上运行完整 API 回归，保存提交 SHA、命令、退出码、测试统计、失败详情与证据文件摘要；**不得以旧 HEAD 结果替代** | 旧 HEAD（3acfb195）结果仅作基线证据 |
| 5 声明不是运行时授权 | 在可信事实契约中增加**强制条款**：来源声明只约束解析器配置；PHASE 3 必须通过受信服务端适配器取得事实，并在执行前**重新读取与校验**；禁止以声明对象、登记快照或模型输出代替授权 | 无需改变执行架构 |
| 6 来源伪装负向断言 | 验证客户端输入或模型结果**不能仅凭附加合法 `trustedFactSources` 标签**成为可信事实（可用契约测试或静态边界审计） | 若当前无可验证的运行时来源隔离，须**如实登记为 `PHASE3_IMPLEMENTATION_PREREQUISITE`**，不得虚报 |

**审计意见（照录要点，必须保留的约束）**：

1. `triageDecision = A` **仅代表历史时点的候选判断，不构成未来执行授权**；执行时仍必须重新验证组织身份、授权有效性、操作上下文与当前故障状态。
2. JSONB「合并不丢字段」的结论**仅覆盖送审证明的数据库写入路径**，不得推定其它并发写入路径具备相同性质。
3. 本轮 CHANGE 1 的 PASS **仅**代表分流决策与登记返回边界的脱敏合格，**不代表**历史持久化字段已完成清洗，也不代表所有后续日志、导出接口天然安全。
4. 可信来源的三种类别目前仍是**来源声明**而非**来源真实性证明**；若未来适配器把客户端值包装成合法声明，字符串级检查未必能阻止信任提升 —— 因此本轮**不批准 PHASE 3 自动执行**。

**RISKS（原文）**：可信来源声明被伪装（P1）/ 登记后授权或组织事实变化（P1：执行时重新取事实，不能消费旧快照作为权限）/
全量回归未覆盖当前 HEAD（P1：CHANGE 4 关闭前不得宣布 PHASE2 CLOSED）/ 历史载荷含敏感信息（P2：保留取证数据但限制后续读取、日志与导出）/
PHASE 3 自动代码修复的错误传播（P0 未来）。

**下一阶段授权**：`NEXT_AUTHORIZED = PHASE2_FINAL_CLOSURE_FIXES + PHASE3_READ_ONLY_DESIGN`。
允许：补齐 CHANGE 4–6 与最终证据；设计 PHASE 3 裁决/权限边界/隔离工作区/补丁候选/独立 Judge/回滚与 Kill Switch；
只读分析现有 ONE SI Runtime、故障登记与可信事实读取接口；形成 PHASE 3 设计审计材料并提交独立复审。
**暂不授权**：创建或启动实际修复代理；自动修改源码 / 提交 / 合并 / 部署；自动执行 A 路径登记候选；
自动调用真实 Provider / 支付 / 报关或其他外部写；扩展第二套 Runtime / Scheduler / Controller；修改封板 RC / main。

**FINAL CLOSURE 进度（本轮）**：

| CHANGE | 状态 | 证据 |
| --- | --- | --- |
| 5 声明不是运行时授权（强制条款） | **本轮完成** | 契约常量 `declarationIsNotAuthorization = true`；契约文档 §6.1 写入强制条款（**来源声明只约束解析器**配置；PHASE 3 必须经**受信服务端适配器**取事实并在**执行前重新读取与校验**；禁止以声明对象、登记快照或模型输出代替授权）；测试断言文档含该条款原文 |
| 6 来源伪装负向断言 | **本轮完成（含如实登记前置条件）** | 形态变体（大小写 / 首尾空白 / 前后缀伪装）一律判违规；静态边界断言：扫描模块中三个事实键**各只出现一次**（仅 fail-closed 默认值），**绝不存在**从载荷 / sourceRefs 反推事实的代码路径；并**如实登记** `runtimeSourceIsolationImplemented = false`、`PHASE3_IMPLEMENTATION_PREREQUISITE = TRUSTED_ADAPTER_SOURCE_PROVENANCE_EXECUTION_TIME_RECHECK`（字符串级声明不能证明来源真实性，故本层不虚报已具备运行时隔离） |
| 4 当前 HEAD 全量回归 | **本轮完成** | 在**最终候选 HEAD `c5d05fd4`**（含 CHANGE 5/6）上运行一次完整 API 回归：**491 / 491 测试文件、4956 / 4956 用例全部通过、exit 0**，耗时 1534.67s；证据文件 `tools/verification/self-repair/phase2-final-closure-gate1-full-regression.json`（含日志 SHA256 前 16 位 `03255d36e99450f9`、字节数 173492、运行前工作树 clean） |

门禁：PHASE 2 四套件 **60/60 PASS**；`apps/api tsc --noEmit` **0 error**。

**CHANGE 4 细节（如实登记）**：

- 与基线（`3acfb195`：490 文件 / 4926 用例）相比，本 HEAD 多出 1 个文件 / 30 个用例，**全部是 PHASE 2 期间新增的 self-repair 测试**，
  无删除、无失败；旧 HEAD 结果不再作为关闭依据（按审计要求）。
- 汇总脚本按关键字命中的 4 条 “FAIL” 经逐条核对**全部是测试名称**含 `FAILED` / `fail-closed` 的正常通过用例，真实失败数为 0。
- 历史登记的 P2E-DB5 隔离债与 broker hook 超时债本轮**未复现**；仍**不视为关闭**。
- 未验证（如实声明）：Linux/systemd 实机、真实 Provider/模型联调（HOLD）、生产环境、GitHub Actions（本记录仅代表本机隔离库证据）。

### 2.7 最终关闭裁决（MSG-20261009-11 = PASS；**PHASE 2 CLOSED = YES**）

**裁决原文**：`AI-ARCHITECT-INBOX.md` → `### [MSG-20261009-11]`（逐字归档，FNV1A `5fcdf8e3`，`FULL_COPY_OK`：134 行 / 缺失 0 / 多出 0）。
会话：`https://chatgpt.com/c/6ac84c23-b340-83ec-95d5-a76fc12f270d`。

| 审计项 | 裁决 |
| --- | --- |
| CHANGE4_GATE1_AT_FINAL_HEAD | **PASS** |
| CHANGE5_DECLARATION_IS_NOT_AUTHORIZATION | **PASS** |
| CHANGE6_SOURCE_SPOOFING_NEGATIVE_ASSERTIONS | **PASS** |
| PHASE2_FINAL_EVIDENCE_SUFFICIENCY | **PASS** |
| SCOPE_HONESTY | **PASS** |

机器裁决：**`FINAL VERDICT = PASS`**、**`PHASE2_CLOSED = YES`**、`PHASE3_DESIGN_AUTHORIZED = YES · READ ONLY`、
`PHASE3_IMPLEMENTATION_AUTHORIZED = NO`、`AUTONOMOUS_CODE_REPAIR_AUTHORIZED = NO`；**PHASE 2 关闭修订：NONE**。

**归档 SHA 口径（审计明确要求，必须严格遵守）**：`REVIEWED_HEAD = 841b9c54`（文档/证据提交）与
**代码与回归证据 HEAD = `c5d05fd4`** 必须作为**两枚不同 SHA** 保留，**禁止**把 `841b9c54` 写成实际执行测试的代码 HEAD。
（审计同时明确：因 841b9c54 相对 c5d05fd4 仅含文档与证据更新，**不要求**仅为此重跑 4956 个测试。）

**PHASE 3 强制前置条件（P3-01..06，不追溯阻断本次关闭）**：

| 编号 | 级别 | 条件 |
| --- | --- | --- |
| P3-01 | **P0** | 可信事实只能通过**经审查的服务端适配器**取得，禁止模型或客户载荷伪装 |
| P3-02 | **P0** | 每次执行前重新读取授权、组织身份、操作上下文及故障状态 |
| P3-03 | **P0** | 授权撤销、租户切换、过期快照、事实不一致必须 **fail-closed** |
| P3-04 | **P0** | 候选**不得直接触发执行**，必须进入既有 runtime 的受控检查路径 |
| P3-05 | **P0** | 代码修复必须具备隔离工作区、受控变更范围、测试、独立 Judge 与失败回退设计 |
| P3-06 | P1 | 建立**真实服务端来源**的负向测试（而非仅检查来源声明字符串） |

**NEXT_AUTHORIZED = PHASE3_DESIGN_READ_ONLY**：允许（仅阅读现有实现 / 设计契约 / 编写测试计划 / 形成审计材料）
① 可信服务端适配器设计（来源证明、可信事实读取入口、租户隔离、不可信载荷边界）；
② 执行前重验设计（组织身份、授权有效期、撤销状态、操作上下文、故障状态的重新检查时序）；
③ 候选消费路径设计（A 路径候选如何由既有 ONE SI Runtime 安全消费；**禁止新增第二运行时**）；
④ 代码修复权限模型设计（允许/禁止修改范围、审批、Judge、回滚、隔离测试、外部写阻断）；
⑤ 失败矩阵与门禁设计（伪装来源、过期授权、跨租户、竞态撤销、重放、错误修复、重复执行、Judge 拒绝）。
`NEXT_AUDIT = MSG-20261009-12 · PHASE 3 DESIGN REVIEW`。

**暂不授权（照录）**：直接实施或运行自主代码修复；生产接线；创建自动修复执行器或开放执行权限。

**RISKS（原文）**：可信适配器包装客户端伪造值（**P0**，PHASE 3 实施前必须解决）/ 授权在候选登记后撤销（**P0**，执行时强制重新验证）/
A 路径接入导致绕过运行时门禁（**P0**，尚未授权接线）/ AI 代码修复产生错误变更（**P0**，尚未授权创建或执行代理）/
历史故障载荷残留敏感字段（P1，另行开展保留策略与泄漏面审计）/ P2E-DB5 与 broker hook 历史测试债（P1，**保留未关闭状态**）/
Linux·CI·真实模型·Provider 未验证（发布门禁，不计入本轮关闭；**生产状态保持 NO**）。

### 2.8 PHASE 3 只读设计（本轮完成；**仅设计，未实施**）

授权依据：MSG-20261009-11（`PHASE3_DESIGN_AUTHORIZED = YES · READ ONLY`、`PHASE3_IMPLEMENTATION_AUTHORIZED = NO`、
`AUTONOMOUS_CODE_REPAIR_AUTHORIZED = NO`）。设计正文：`docs/releases/SI-RSI-INTERNAL-CODE-REPAIR-V1-PHASE3-DESIGN.md`。

设计覆盖审计指定的五项（逐项对应 P3 前置条件）：

| 设计项 | 对应前置条件 | 要点 |
| --- | --- | --- |
| 可信服务端适配器 | **P3-01** | 唯一读取入口 + **来源证明（provenance）** + 租户谓词；请求体/客户端/模型输出只作「待核验线索」，绝不直接映射为事实 |
| 执行前重验时序 | **P3-02 / P3-03** | 固定八步：候选读取 → **快照时效/版本作废判定** → 身份重解析 → 授权重验 → 上下文重验 → 故障状态重验 → Action Guard → 租约与 fencing；任一环失败 fail-closed |
| A 路径候选消费路径 | **P3-04** | 复用既有 `createPrismaTaskQueuePort().admit()` 与 `createAutonomyTaskSource().claim()`；**不新增** Scheduler/Controller/Runtime/队列；外写恒 HOLD |
| 代码修复权限模型 | **P3-05** | 修改范围白名单、禁止范围（封板 RC/main/迁移/门禁代码/密钥）、候选补丁不落地、Builder≠Judge、隔离执行、回滚、外写阻断、退出即人工 |
| 失败矩阵与门禁 | **P3-06** | 伪装来源 / 过期·撤销授权 / 跨租户 / 竞态撤销 / 过期快照 / 重放 / 错误修复 / Judge 拒绝 / 断连崩溃 逐场景预期行为与门禁；每场景至少 1 条负向用例 |

**现状盘点（只读）**：ONE SI Runtime（`runtime/rsi-run.ts`）、durable 任务源与授权重解析（`runtime/rsi-durable-task-source.ts`）、
`RsiSafeTask`（`services/autonomy/rsi-continuation-engine.ts`）、Action Guard / 审批 / Kill Switch（`services/action-guard/*`）、
生命周期契约（`services/autonomy/rsi-lifecycle.ts`）、本任务成果（`services/self-repair/*`）、客户队列锚点（`services/agent-goal/prisma-task-queue-port.ts`）。

**本轮未实施、未接线、未开放权限**（如实登记）：可信适配器、执行前重验、候选消费通道、修复代理、隔离沙箱、独立 Judge 接线、回滚机制
**均未实现**；`runtimeSourceIsolationImplemented = false` 仍成立；`EXTERNAL_WRITE = HOLD`、`PRODUCTION_READY = NO`。

### 2.9 PHASE 3 设计复审裁决（MSG-20261009-12 = PASS WITH REVISE；**实施仍未授权**）

**裁决原文**：`AI-ARCHITECT-INBOX.md` → `### [MSG-20261009-12]`（逐字归档，FNV1A `d95eeb78`，`FULL_COPY_OK`：195 行 / 缺失 0 / 多出 0）。
会话：`https://chatgpt.com/c/6ac84e46-6240-83ec-bddc-0163b19a7e56`。

| 审计项 | 裁决 |
| --- | --- |
| 1 TRUSTED_ADAPTER_PROVENANCE_DESIGN | **PASS WITH REVISE**（需补不可伪造的主体绑定与证明生命周期） |
| 2 PRE_EXECUTION_REVALIDATION_SEQUENCE | **REVISE**（撤销竞态与最终副作用提交边界未闭合） |
| 3 CANDIDATE_CONSUMPTION_PATH | **REVISE**（客户队列隔离与认领前重验契约不完整） |
| 4 REPAIR_PERMISSION_MODEL | **PASS WITH REVISE**（需补补丁来源、Judge 独立性、落地权限边界） |
| 5 FAILURE_MATRIX_AND_GATES | **PASS WITH REVISE**（需增 TOCTOU、路径逃逸、崩溃恢复负向用例） |
| 6 DESIGN_SCOPE_HONESTY | **PASS** |

机器裁决：`PHASE2_CLOSED = YES`（继承）、`PHASE3_DESIGN_ACCEPTED = YES_WITH_CONDITIONS`、
**`PHASE3_IMPLEMENTATION_AUTHORIZED = NO`**、`AUTONOMOUS_CODE_REPAIR_AUTHORIZED = NO`、`EXTERNAL_WRITE = HOLD`、`PRODUCTION_READY = NO`；
`NEXT_AUTHORIZED = PHASE3_DESIGN_FINAL_R2_READ_ONLY`、`NEXT_AUDIT = MSG-20261009-13`。

**必须修订（三项 P0）**：

1. **CHANGE 1（P0）封闭「授权撤销 ↔ 执行副作用」竞态**：仅靠 fenced settle **不能**推出零副作用
   （存在「claim 成功 → 授权被撤销 → worker 已获任务 → 调用副作用 → settle 被拒」的窗口）。
   必须补：① 实际执行动作**前的最终授权重验门**；② 执行期间**持续**校验租约与 fencing token；
   ③ 为所有可见副作用定义**最终提交边界**；④ 撤销与副作用提交之间具备**可证明的线性化顺序**（或等效串行化 / 防重 / 取消协议）；
   ⑤ 无法证明执行安全的动作 ⇒ `BLOCK` / `HUMAN_REVIEW`；⑥ **已发生的副作用不得因事后 settle 失败而被标记为「零副作用」**。
   不可逆外部动作本阶段继续禁止。验收须分别覆盖撤销发生在 **claim 前 / claim 后 / 执行前 / 执行中 / 提交边界** 五种情形。
2. **CHANGE 2（P0）A 路径候选与客户任务的强身份隔离**：内部故障候选**不是**客户请求，
   不得通过更换 `kind` 获得客户授权；候选必须保留 `incidentId`、可信租户关系、任务类型与来源身份；
   **不得**把候选载荷里的 `organizationId` 当作可信组织身份；入队前**与**认领后必须**分别**重解析授权与身份；
   现有客户授权**不得**自动扩大到内部代码修改；`INTERNAL_FAULT` 不得经队列转换绕过 Action Guard；
   必须定义 incident ↔ task 的持久化关联、去重键、状态转移与崩溃恢复规则。**本轮不授权修改队列代码。**
3. **CHANGE 3（P0）修复权限分离覆盖「补丁生成 → 发布」全过程**：工作区绑定（基线 commit + 允许文件清单 + 内容哈希）；
   路径限制（符号链接 / 路径穿越 / Git hooks / 子模块 / 间接配置与脚本逃逸）；命令限制（不得继承生产凭据、Docker socket、宿主敏感挂载、发布权限）；
   Judge 独立性（不得由 Builder 构造或覆盖评审依据，必须核验**真实可复现**测试输出）；结果不可变性（Judge 审核的补丁哈希必须等于最终候选）；
   提交边界（即使 Judge PASS 也只能生成已验证候选，禁止自动合并 / 部署 / 修改封板分支）；回滚边界（必须实际可行；不可逆副作用不得承诺自动回滚）；
   并把 `services/**` 白名单**缩小为逐路径允许清单**。

**建议补充（五项 P1）**：CHANGE 4 provenance 绑定执行主体 / 租户 / 会话 / 事实版本 / 读取时间（旧证明与跨主体证明不得复用）；
CHANGE 5 明确快照 TTL、授权版本、状态变更与重新分流规则（过期快照不得进入执行）；
CHANGE 6 补丁重试与成本上限（REVISE 有界，超限 BLOCK）；CHANGE 7 补真实 PostgreSQL 与运行时负向测试（**不允许**仅用 mock 证明安全边界）；
CHANGE 8 崩溃后状态收敛与不可重复提交契约（恢复后不得重复副作用或身份漂移）。

**额外强制失败场景**：`JUDGE_PASS_PATCH_CHANGED_AFTER_REVIEW` ⇒ 预期 `BLOCK` / `PATCH_DIGEST_MISMATCH` / `NO_APPLY`
（防止 Judge 批准后补丁被替换）。

**RISKS（原文）**：授权撤销后产生副作用（**P0 未闭合**）/ 内部任务借用客户队列权限（**P0 未闭合**）/
修复补丁越权修改或执行（**P0 未闭合**）/ provenance 被跨会话重放（P1 待补强）/ Judge 结果与实际补丁不一致（P1 待补强）/
崩溃后任务重复消费（P1 待实施验证）/ 历史测试债与敏感载荷残留（P1 继续登记）/ Linux·Provider·生产端到端（P1 未执行）。

**NEXT_AUTHORIZED = PHASE3_DESIGN_FINAL_R2_READ_ONLY**：仅允许修订设计文档、状态机契约、权限矩阵、时序图与测试验收规范；
关闭 CHANGE 1–3、补充 CHANGE 4–8、输出「候选入队 / 认领 / 执行 / 终止」状态转移表，并提交 MSG-20261009-13。
**FORBIDDEN**：实现 `FaultTrustedFactsAdapter` 或执行接线；修改生产 Runtime / 队列 / Action Guard；
实施 Builder/Judge；创建自动修复代理或开放自动提交；修改 Prisma / migration / 封板 RC·main；开启真实 Provider / 支付 / 报关或其他外写。
审计明确：**不得**把本轮 PASS WITH REVISE 解释为实施许可。

### 2.10 PHASE 3 设计 FINAL-R2 裁决（MSG-20261009-13 = PASS WITH REVISE；**实施仍未授权**）

**裁决原文**：`AI-ARCHITECT-INBOX.md` → `### [MSG-20261009-13]`（逐字归档，FNV1A `e7b0fa2e`，`FULL_COPY_OK`：158 行 / 缺失 0 / 多出 0）。
会话：`https://chatgpt.com/c/6ac8505c-f7cc-83ec-8faa-8cf55a75c15a`。

| 审计项 | 裁决 |
| --- | --- |
| CHANGE 1 撤销与副作用竞态 | **PASS WITH REVISE** |
| CHANGE 2 候选身份隔离 | **PASS WITH REVISE** |
| CHANGE 3 修复权限端到端隔离 | **PASS WITH REVISE** |
| CHANGE 4–8 P1 条款 | **PASS** |
| 失败矩阵与状态转移表 | **PASS WITH REVISE** |
| DESIGN_ONLY_SCOPE_HONESTY | **PASS** |

机器裁决：`PHASE3_DESIGN_FINAL_ACCEPTED = YES_WITH_CONDITIONS`、**`PHASE3_IMPLEMENTATION_AUTHORIZED = NO`**、
`AUTONOMOUS_CODE_REPAIR_AUTHORIZED = NO`、`EXTERNAL_WRITE = HOLD`、`REAL_PROVIDER_EXECUTION = NOT_AUTHORIZED`、
`AUTO_MERGE = FORBIDDEN`、`AUTO_DEPLOY = FORBIDDEN`、`PRODUCTION_READY = NO`；
`REVIEW_BASIS = USER_SUPPLIED_DESIGN_ONLY`、`REPOSITORY_VERIFIED = NO`、`RUNTIME_TESTS_EXECUTED = NO`。
`NEXT_AUTHORIZED = PHASE3_DESIGN_FINAL_R3_READ_ONLY`、`NEXT_AUDIT = MSG-20261009-14`。

**新增四项必修（本轮之后按此收口）**：

1. **CHANGE 9（P0）副作用提交协议与线性化实现**：允许进入 PHASE 3 的动作逐一分类为
   `PURE_READ` / `ISOLATED_WRITE` / `REVERSIBLE_INTERNAL_COMMIT` / `IRREVERSIBLE_OR_EXTERNAL`；
   每个允许写入的动作必须指定**唯一提交点 + 授权版本校验点 + 幂等标识 + 持久化副作用登记**；
   同事务内部写入须以行锁 / 条件更新（或等效机制）建立可证明提交顺序；撤销与提交并发时**必须产生唯一胜者**，
   且提交成功后的撤销**不得追溯宣称提交未发生**；跨事务 / 外部系统副作用**不得**仅凭本地 CAS 宣称原子性（缺协调协议继续 BLOCK）；
   `SETTLE_REJECTED_BUT_EFFECT_POSSIBLE` 必须进入持久化对账或人工处置，**不得自动重复执行**。
   关闭标准：动作分类表 + 每类提交协议；无法证明安全性的动作标记 `NOT_AUTHORIZED`。
2. **CHANGE 10（P0）候选消费的权威身份与幂等契约**：`incidentId` 必须关联**权威持久化 Incident**（非载荷声明）；
   持久化关联至少含 `incidentId` / `taskId` / `sourceKind` / 可信主体引用 / 身份解析版本 / 状态 / 去重键；
   明确「单 Incident 产生多候选」的规则，去重键须覆盖任务种类与修复目标（避免误合并不同故障）；
   身份解析变化 ⇒ **原任务失效并重新分流**（不允许自动迁移租户或扩大权限）；
   入队与认领的独立解析**不能替代**提交时的最终授权检查；明确租约 / fencing token / 重复消息 / 崩溃恢复的持久化关系。
   关闭标准：给出 `Incident → Candidate → Task → Attempt` 的权威关系契约，以及重复、并发与身份漂移的拒绝规则。
3. **CHANGE 11（P1）沙箱隔离与可信验证边界**：Builder / 测试执行器 / Judge 使用**相互隔离**的执行上下文与权限；
   候选工作区固定基线 commit、允许路径与内容摘要；测试输入、实际执行命令、环境约束、退出码与原始日志摘要
   必须形成**不可由 Builder 单独伪造**的验证记录；**禁止** Builder 修改 Judge 策略、测试入口、权限策略或验证结果存储；
   路径检查必须覆盖**解析后的真实目标**并防止检查后替换（TOCTOU）；明确隔离失败 / 资源耗尽 / 超时 / 恶意补丁 / 结果不确定时的 fail-closed。
   `Judge PASS` 仅意味着候选满足**当前验证策略**，不等于补丁安全或可发布 / 可自动合并。
4. **CHANGE 12（P1）状态转移的提交语义**：撤销**不得**统一描述为 `BLOCKED` / `CANCELED`（已发生的提交必须保留不可变事实）；
   `COMMITTED` 必须带**可信提交凭证**。状态语义拆分：`CANCELED_BEFORE_COMMIT`（有取消证据且未跨提交点）/
   `REJECTED_AT_COMMIT`（提交被权威机制拒绝）/ `COMMITTED`（存在可信提交凭证）/ `COMMIT_OUTCOME_UNKNOWN`（结果不确定，禁止盲重试）/
   `SETTLED`（结果已持久化收敛）/ `SETTLE_REJECTED_BUT_EFFECT_POSSIBLE` / `RECOVERING`（依据权威事实恢复，不直接重放副作用）；
   并定义合法状态迁移、终态不可逆条件、恢复后的对账入口与并发恢复时的 fencing 约束。

**失败矩阵追加四项验收情景**：① 授权撤销与 DB COMMIT 同时竞争 ⇒ 唯一线性化胜者且提交事实与授权顺序一致；
② 提交成功后进程崩溃、确认丢失 ⇒ `UNKNOWN` → 权威对账、不重复提交；③ Judge PASS 后工作区发生变化 ⇒ 摘要不一致、拒绝应用；
④ 身份版本变化后旧任务恢复 ⇒ 旧身份禁止继续执行并重新分流。

**CHANGE 4–8 三条红线（保留）**：快照过期或授权版本变化必须**重新获取**可信事实（不得简单延长 TTL）；
REVISE / 重试 / 模型调用 / 测试执行必须有**持久化预算**（崩溃恢复不得重置计数）；
真实 PostgreSQL 测试必须覆盖**实际装配路径**（不能只证明独立纯函数或模拟适配器行为）。

**授权边界**：`NEXT_AUTHORIZED = PHASE3_DESIGN_FINAL_R3_READ_ONLY` —— 仅允许完成 CHANGE 9–12 契约修订、
补齐可执行验收矩阵、形成 PHASE 3 **最小安全实施单元划分**并提交下一轮审计（MSG-20261009-14）。
**不授权**：实现或接线（适配器、候选消费通道、Builder/Judge、隔离沙箱、自动修复执行器）、
修改 Runtime / 队列 / Action Guard / Prisma schema·migration、自动合并 / 发布 / 部署 / 生产库写入、
Provider / 支付 / 报关 / 物流及其他外部副作用。
下一轮若全部设计门禁通过，可**单独**申请 PHASE 3-A 最小安全范围实施授权，**不得**由本轮裁决自动推导。

### 2.11 PHASE 3 设计 FINAL-R3 裁决（MSG-20261009-14 = PASS WITH REVISE；**PHASE 3-A 仅 U1 只读子集获授权**）

**裁决原文**：`AI-ARCHITECT-INBOX.md` → `### [MSG-20261009-14]`（逐字归档，FNV1A `35241c23`，`FULL_COPY_OK`：228 行 / 缺失 0 / 多出 0）。
会话：`https://chatgpt.com/c/6ac8527c-69ec-83ec-b891-51b1fb07cc71`。

| 审计项 | 裁决 |
| --- | --- |
| CHANGE 9–12 | **PASS WITH REVISE**（各自仍有需收口的语义） |
| 验收矩阵 A1–A10 | **PASS WITH REVISE** |
| 最小实施单元 U1–U5 | **PASS WITH REVISE** |
| DESIGN_ONLY_SCOPE_HONESTY | **PASS** |

机器裁决：`PHASE3_DESIGN_R3_ACCEPTED = YES`、`PHASE3_IMPLEMENTATION_AUTHORIZED = NO`（**完整实施仍不授权**）、
**`PHASE3_A_MINIMAL_SCOPE_AUTHORIZED = YES`，授权单元 = `U1_READ_ONLY_SUBSET`**、
`PHASE3_U1_IMPLEMENTATION_CLOSED = NO`、`PHASE3_U2_TO_U5_AUTHORIZED = NO`、
`AUTONOMOUS_CODE_REPAIR / BUILDER_EXECUTION / JUDGE_EXECUTION / PATCH_APPLY = NO`、
`EXTERNAL_WRITE = HOLD`、`REAL_PROVIDER_EXECUTION = NOT_AUTHORIZED`、`AUTO_MERGE / AUTO_DEPLOY = FORBIDDEN`、`PRODUCTION_READY = NO`。

**PHASE 3-A · U1 授权范围**：权威可信事实**读取**适配器、服务端来源解析、租户隔离校验、provenance 只读链路、失败关闭判断及对应**只读**测试。
**明确禁止**：写业务表、创建实际候选执行任务、接入 runtime 自动执行、修改队列认领语义、提交补丁、生成可执行修复动作、触发外部副作用。

**U1 开始实施的前置条件（必须逐条满足）**：
1. 固定 `46e9cd9d` 作为本轮设计评审锚点，实施采用**独立可追溯提交**；
2. 给出 U1 **文件白名单、接口签名、可信数据来源与非目标**；
3. `runtimeSourceIsolationImplemented = false` **继续作为阻断执行接线的硬门**，不得通过本轮 U1 绕过；
4. 验证所有外部输入**不能伪造**租户、Incident 来源、可信主体与 provenance；
5. **不修改** Prisma schema / migration、既有任务队列、runtime 控制流或封板分支；
6. 实施后提供**测试命令、退出码、真实数据库适用范围与证据摘要**，再申请 U1 实现审计。

**新增必需修订（本轮之后收口）**：

| CHANGE | 级别 | 要点 |
| --- | --- | --- |
| 13 分离「DB 提交」与「隔离文件提交」的线性化 | **P0** | `ISOLATED_WRITE` 须定义 staging / 原子发布 / 不可变摘要 / 清理；撤销检查与文件发布**无法建立统一顺序**时不得宣称"撤销后绝无写入" ⇒ BLOCK 或限制为不外露的临时产物；`PURE_READ` 不构成副作用提交但仍须检查租户/授权/数据范围；`REVERSIBLE_INTERNAL_COMMIT` 与 `IRREVERSIBLE_OR_EXTERNAL` 继续 NOT_AUTHORIZED。关闭标准：每种允许写入动作各自独立的提交点、授权时效模型与失败恢复定义；**不得把 DB CAS 的保证外推到文件系统或外部系统** |
| 14 消除终态与 `RECOVERING` 的语义冲突 | **P0** | 已有可信终态凭证的状态**不得**进入会覆盖业务事实的 `RECOVERING`（应建模为独立恢复作业/恢复控制状态）；仅权威机制明确确认未提交才允许 `REJECTED_AT_COMMIT`；已确认 `COMMITTED` 后即使 settle 失败也**不得**回退为取消/拒绝；`COMMIT_OUTCOME_UNKNOWN` 不得因超时自动转 `REJECTED_AT_COMMIT`；`SETTLED` 必须携带明确最终结果类型；须证明「提交事实 / 任务执行状态 / 恢复控制状态」三者可独立表达且不相互覆盖 |
| 15 收紧 Candidate/Task/Attempt 身份与幂等 | P1 | 每次实际认领生成可追踪 `attemptId`；`leaseId` / `fencingToken` / `attemptId` 关系明确；续约不得生成新业务 Attempt；同一任务重新认领须增加 **fencing 世代**；Candidate 去重键以服务端解析的权威目标 + 任务类型 + 事实版本为输入并含租户隔离维度；去重冲突不得静默丢弃事实不同的候选；`identityVersion` 失效后旧 Attempt 不得提交，但历史审计事实保留 |
| 16 强化验证产物绑定与沙箱失效条件 | P1 | Judge 可信输入绑定 `baselineCommit + candidateDigest + verificationPolicyVersion + testEnvironmentDigest + testResultDigest`；Builder 不能控制 TestRunner 的执行程序/策略/结果存储；禁止未授权网络、凭据读取、宿主挂载、特权容器；不允许从不可信工作区直接执行 hooks 或测试入口；路径验证须处理符号链接/硬链接/目录替换/子模块；**realpath 本身不足以消除 TOCTOU** ⇒ 实际打开与写入须用安全文件句柄与目录约束；隔离失败/超时/结果缺失/摘要不一致一律 `NO_PASS`；Judge 输出须显式记录 `VERIFICATION_PASS ≠ SECURITY_APPROVAL ≠ MERGE_AUTHORIZATION ≠ DEPLOY_AUTHORIZATION` |

**追加验收（实施阶段）**：`A11 Terminal State Integrity`（已权威确认的终态不得被崩溃恢复或旧 fencing owner 改写）；
`A12 Workspace Publication Boundary`（文件发布与撤销竞争时须能证明允许顺序；无法证明必须拒绝公开候选产物）。
**A1–A12 均为实施阶段验收要求，本轮不宣称已通过。**

**NEXT_AUTHORIZED = `PHASE3_A_U1_READ_ONLY_IMPLEMENTATION` + `DESIGN_ONLY_CHANGES_13_TO_16`**；
`NEXT_AUDIT = MSG-20261009-15`（仅接收两类内容：① U1 只读实现及验证证据；② CHANGE 13–16 只读设计修订并补齐 A11/A12；
两部分须**分别**呈现证据与结果，**不得**用 U1 实现通过代替 U2–U5 的设计或实施验收）。
审计最终边界：**可以开始构建可信的只读事实基础，但不得开始自主代码修复、补丁应用、自动合并或生产部署。**

### 2.12 U1 + CHANGE 13–16 裁决（MSG-20261009-15 = PASS WITH REVISE；**U1 未关闭**）

**裁决原文**：`AI-ARCHITECT-INBOX.md` → `### [MSG-20261009-15]`（逐字归档，FNV1A `fa1509df`，`FULL_COPY_OK`：214 行 / 缺失 0 / 多出 0）。
会话：`https://chatgpt.com/c/6ac8556a-d50c-83ec-83e9-c0cc27fc5e7f`。

| 审计项 | 裁决 |
| --- | --- |
| U1_READ_ONLY_IMPLEMENTATION | **PASS WITH REVISE** |
| U1_EVIDENCE_SUFFICIENCY | **REVISE** |
| U1_SCOPE_COMPLIANCE | PASS（依据送审申报范围） |
| CHANGE 13 文件提交线性化 | **PASS WITH REVISE** |
| CHANGE 14 终态恢复语义 | **PASS**（本轮最明确改进） |
| CHANGE 15 身份与幂等 | **PASS WITH REVISE** |
| CHANGE 16 沙箱验证绑定 | **PASS WITH REVISE** |
| A11 / A12 | **PASS WITH REVISE** |
| SCOPE_HONESTY | **PASS** |

机器裁决：**`PHASE3_U1_IMPLEMENTATION_CLOSED = NO`**、`PHASE3_A_U2_TO_U5_AUTHORIZED = NO`、
`CHANGE_13_TO_16_ACCEPTED = YES_WITH_CONDITIONS`、`AUTONOMOUS_CODE_REPAIR = NO`、`EXTERNAL_WRITE = HOLD`、
`AUTO_MERGE / AUTO_DEPLOY = FORBIDDEN`、`PRODUCTION_READY = NO`；
`NEXT_AUTHORIZED = PHASE3_A_U1_FINAL_R2_REPAIR_AND_EVIDENCE + DESIGN_ONLY_CHANGES_21_TO_23`、`NEXT_AUDIT = MSG-20261009-16`。

**必需修订 · CHANGE 17–20（仅限 U1 代码与设计文档允许范围；P0/P0/P0/P1）**：

| # | 级别 | 要求 | 验收 |
| --- | --- | --- | --- |
| 17 | **P0** | **授权选择唯一性**：绑定组织 + 主体 + 动作 + 资源范围 + 授权对象；多条有效或相互冲突的授权无法确定唯一权威记录 ⇒ fail-closed | 冲突、跨主体及越权记录均不能取得可信授权 |
| 18 | **P0** | 金额**显式规则**：缺失 / 负数 / 非有限数 / 超精度 / 币种未确认的判定；不明确金额一律拒绝，**合法非金额动作单独验证** | 所有不明确金额输入拒绝 |
| 19 | **P0** | **U1 来源边界与版本失效契约**：伪造调用上下文（organizationId / executionContext / actionType）必须被阻断；旧事实不得获得新的提交权限 | 伪造上下文被阻断；旧事实无新权限 |
| 20 | P1 | **补强证据**：数据库只读权限或等效强验证；覆盖关键异常路径；增加伪造上下文、异常授权记录、并发授权变更等负向验证 | 强只读证据 + 异常路径覆盖 |

审计同时指出（本轮未达标的证据短板，须在 CHANGE 20 中补齐）：正则检查不含写方法**不能**证明整条调用链无写入；
三张 Autonomy 表计数不变**不能**证明其余业务表未变；只看最高授权版本**不能**覆盖多授权冲突；
`updatedAt` 作为组织行修订信号**不应**未经验证就当作身份/授权变更的完整单调版本。
建议采用：**数据库只读事务 / 写入权限受限的测试身份 / 全相关业务表前后状态比较**。

**必需修订 · CHANGE 21–23（仅设计修订，不是实施许可）**：

| # | 级别 | 要求 |
| --- | --- | --- |
| 21 | **P0·设计** | CHANGE 13 补「撤销 ↔ 文件发布」的**共同排序权威或拒绝公开**协议：无法证明顺序 ⇒ 仅 `staging-only`；摘要路径已存在须采用**无覆盖发布语义**（并发冲突不得覆盖原候选）；发布后须**校验实际内容与摘要一致**（目录只读不能证明内容不可篡改）。**在这些问题关闭前 `ISOLATED_WRITE` 不得授权实施。** |
| 22 | P1·设计 | CHANGE 15–16 补齐：`fencingGeneration` 必须由**持久化原子机制**递增（不得依赖进程内计数）；`candidateDigest` / 租户 / 事实版本 / 目标身份的**规范化编码**必须确定（避免不同输入序列化为同一业务身份）；`identityVersion` 读取与提交检查之间须定义**事务或 fencing 边界**；TestRunner 必须位于 **Builder 无法修改的可信执行边界**；运行镜像 / 依赖 / 测试入口 / 环境变量 / 策略版本须参与**环境摘要**或等效不可变约束；**不得**把工作区内不可信 hook / 构建脚本 / 测试脚本直接当作可信执行入口；结果摘要必须绑定**完整测试执行身份与产物** |
| 23 | P1·设计 | A11 / A12 增加**崩溃、重试、并发、文件系统持久化失败**的故障矩阵；每类失败均有明确成功/拒绝判定（A12：并发撤销与发布须有可验证线性化顺序，无法证明时**无候选进入公开可消费位置**） |

**限制（照录）**：CHANGE 17–20 **不构成**对既有队列、Runtime、Prisma schema 或任何写路径的修改授权；CHANGE 21–23 仍为设计修订。

**RISKS（原文）**：P0 授权时效竞态（事实解析成功 ≠ 后续操作仍有授权）/ P0 文件系统发布竞态（DB CAS 不能代替文件系统原子性与权限时序证明）/
P0 调用来源可信性（不接收模型字段 ≠ 服务端上下文不可伪造）/ P1 版本与身份失效 / P1 测试证据覆盖 / P1 沙箱可信边界。

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
PHASE1_CLOSED = YES（MSG-20261009-08 阶段性收口；全量回归列为 PHASE 2 前置门禁）
PHASE2_IMPLEMENTATION_AUTHORIZED = YES_SAFE_SCOPE_ONLY（复用 ONE SI Runtime；不得把 AUTO_RECOVER 当外写授权）
PHASE3_TO_7_AUTHORIZED = NO
PHASE1_REVIEW_VERDICT = MSG-20261009-08 = PASS WITH REVISE（逐字归档 FULL_COPY_OK / FNV1A 3ed6a0de）
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

**CHANGE 4 实现口径**（`fault-classification.ts`，规则登记于 `FAULT_REPLAY_SAFETY_RULE`）：

核心理念：**故障可重试 ≠ 业务动作可安全重放**。分类结果新增 `replaySafety`，并由它**推导** `requiredAction`：

| 重放语义 | 触发条件（判定顺序即优先级） | 下一步动作 |
| --- | --- | --- |
| `FORBIDDEN` | 安全 / 权限信号（最优先）／需代码修复／明确不可重试／**副作用已确认生效** | 保留类别自身修复路径（`CODE_REPAIR_CANDIDATE` / `OWNER_ACTION` / 人工），**绝不** AUTO_RECOVER |
| `RECONCILE_FIRST` | **外部写（结果不明）**／操作类型未知／副作用状态未确认 | `INVESTIGATE`（**先对账，不得直接重放**） |
| `AUTO_RETRY_CANDIDATE` | **只读操作**，或「确认未生效 + 可信幂等」的可变操作 | `AUTO_RECOVER` |
| `NEEDS_CLASSIFICATION` | 未分类故障（如 `UNKNOWN_ERROR`） | 人工，默认禁止自动恢复 |

- **不变量**：`requiredAction === 'AUTO_RECOVER'` ⟺ `replaySafety.autoRecoverAuthorized === true`（双向断言，含反向：无授权则必不出现 AUTO_RECOVER）。
- 新增**操作维度**输入（由调用方基于可信事实声明，模型声明无效）：`operationKind`、`idempotencyGuarantee`、`effectConfirmed`；
  随 Incident 一并落库（`operationKind` / `replayDisposition` / `requiresReconciliation` / `autoRecoverAuthorized` / `escalatedBySecuritySignal` 等 7 字段），下游分流无需二次推断。
- **安全 / 权限信号优先于超时等规则**：`escalatedBySecuritySignal` 显式登记，超时的「可重试」不得覆盖它。
- 403 **不**自动等同 `TOKEN_EXPIRED`（仍落 `UNKNOWN_ERROR`），因此也**不会**获得任何自动恢复许可。

**CHANGE 4 验收（纯函数，61 用例）**：只读超时 ⇒ 自动重试候选；**外部写超时 ⇒ 先对账（审计举的例子）**；
副作用已生效 ⇒ 禁止重放；可变操作仅「确认未生效 + 可信幂等」可重试；操作未知 ⇒ 先对账；
权限信号 ⇒ 强制升级并禁止重放；`UNKNOWN_ERROR`/403 ⇒ 禁止自动恢复；重放语义随意图落库；规则登记逐条断言。
门禁：定向回归 **5 文件 / 98 tests 全绿**、`tsc --noEmit` **0 error**。

### 1.6 PHASE1-FINAL-R2 汇总（四项修订全部完成，待复审）

| CHANGE | 级别 | 状态 | 关键证据 |
| --- | --- | --- | --- |
| 1 并发创建 / 去重原子性 | P0 | ✅ | 单语句原子 upsert；20 路并发 1 行计数=20、恰好一次新建；混合创建/更新；终态与外来容器并发零改动 |
| 2 脱敏边界（对抗 + 白名单） | P0 | ✅ | 11 例对抗矩阵；24→31 键运行时白名单；字段长度上限；引用收紧为结构化标识符；零日志 |
| 3 生命周期与租户边界 | P0 | ✅ | 身份规则（租户/Provider 参与）；生命周期矩阵；跨租户隔离；哈希非授权；伪造容器零权限 |
| 4 安全重试语义 | P1 | ✅ | 重放语义推导 requiredAction；外部写先对账；安全信号优先；双向不变量 |

**全过程门禁**：纯函数 61 用例 + 真实 PostgreSQL 14 用例（隔离库 `crossclaim_p3r2_iso`）；
定向回归 5 文件 / **98 tests 全绿**；`apps/api tsc --noEmit` **0 error**；未跑全量回归（如实登记）。

GATE1_FULL_REGRESSION = PASS（490/490 文件、4926/4926 用例、exit 0；隔离库；证据 tools/verification/self-repair/phase2-gate1-full-regression.json）
GATE4_PHASE2_LAYER = PASS（重复分流幂等 / 并发扫描 / 状态竞争登记保护；运行时层 fencing 与断连由既有运行时门禁覆盖）
PHASE2_REVIEW_VERDICT = MSG-20261009-09 = PASS WITH REVISE（逐字归档 FULL_COPY_OK / FNV1A 1d735f7f）
PHASE2_SAFE_SCOPE_ACCEPTED = YES
PHASE2_STATUS = CLOSED（MSG-20261009-11 = PASS；关闭修订 NONE）
PHASE2_CLOSE_VERDICT = MSG-20261009-11 = PASS（逐字归档 FULL_COPY_OK / FNV1A 5fcdf8e3）
SHA_POLICY = REVIEWED_HEAD 841b9c54（文档/证据）与代码/回归 HEAD c5d05fd4 必须分列，禁止混写
PHASE3_DESIGN_AUTHORIZED = YES_READ_ONLY（仅只读方案设计；实现授权 NO）
PHASE2_FINAL_R2_PROGRESS = CHANGE 1 ✅ + CHANGE 2 ✅ + CHANGE 3 ✅（三项 P1 修订全部完成）
PHASE2_REVIEW_VERDICT = MSG-20261009-10 = PASS WITH REVISE（逐字归档 FULL_COPY_OK / FNV1A 83707404）
PHASE2_FINAL_CLOSURE_PROGRESS = CHANGE 4 ✅ / CHANGE 5 ✅ / CHANGE 6 ✅（三项 P1 全部完成）
GATE1_AT_FINAL_HEAD = PASS（c5d05fd4：491/491 文件、4956/4956 用例、exit 0；证据 tools/verification/self-repair/phase2-final-closure-gate1-full-regression.json）
PHASE3_IMPLEMENTATION_PREREQUISITE = TRUSTED_ADAPTER_SOURCE_PROVENANCE_EXECUTION_TIME_RECHECK（如实登记，未实现）
PHASE3_DESIGN_REVIEW_VERDICT = MSG-20261009-12 = PASS WITH REVISE（逐字归档 FULL_COPY_OK / FNV1A d95eeb78）
PHASE3_DESIGN_ACCEPTED = YES_WITH_CONDITIONS
PHASE3_IMPLEMENTATION_AUTHORIZED = NO（禁止实施适配器/接线/Builder/Judge/自动修复）
PHASE3_DESIGN_FINAL_R2_VERDICT = MSG-20261009-13 = PASS WITH REVISE（逐字归档 FULL_COPY_OK / FNV1A e7b0fa2e）
PHASE3_DESIGN_FINAL_ACCEPTED = YES_WITH_CONDITIONS
PHASE3_IMPLEMENTATION_AUTHORIZED = NO（AUTONOMOUS_CODE_REPAIR / AUTO_MERGE / AUTO_DEPLOY 一律禁止）
PHASE3_DESIGN_FINAL_R3_VERDICT = MSG-20261009-14 = PASS WITH REVISE（逐字归档 FULL_COPY_OK / FNV1A 35241c23）
PHASE3_A_MINIMAL_SCOPE_AUTHORIZED = YES（**仅 U1 只读子集**；U2–U5 = NO；完整实施 = NO）
PHASE3_U1_IMPLEMENTATION_CLOSED = NO（**本轮完成 U1 实施与自验，待独立实施审计**；规格见设计文档 §15）
PHASE3_U1_ARTIFACTS = trusted-facts-adapter.ts + phase3a-u1-* 两个测试文件 + 设计文档 §15 规格（仅新增，未改既有文件）
PHASE3_A_U1_EVIDENCE = 端口级 12/12 PASS、真实 PG 4/4 PASS（隔离库）、api tsc 0；只读副作用断言（零任务/零租约/零 Incident 变化）
PHASE3_CHANGES_13_TO_16 = DESIGN_COMPLETED（设计文档 §16：文件提交四段协议与顺序不可证回退、CommitFact/TaskState/RecoveryControl 三维独立表达、attemptId/fencing 世代与去重冲突证据、验证产物五元绑定与安全句柄路径约束、A11/A12 定义；仍为只读设计）
PHASE3_U1_MSG15_VERDICT = MSG-20261009-15 = PASS WITH REVISE（逐字归档 FULL_COPY_OK / FNV1A fa1509df；U1 未关闭）
PHASE3_A_U1_FINAL_R2 = NOT_STARTED（需完成 CHANGE 17–20 代码/证据 + CHANGE 21–23 设计）
NEXT_UNIT = ① CHANGE 17–20（U1 授权唯一性 / 金额显式规则 / 来源边界与版本失效 / 强只读与负向证据）② CHANGE 21–23（设计收口）→ 送 MSG-20261009-16
PRODUCTION_READY = NO
HOST_ACTION_REQUIRED = 真实模型凭据（用于 PHASE 3/7 真实联调）；Linux 隔离执行环境（用于真实沙箱补丁验证）
```

---

### 2.13 PHASE 3-A · U1 FINAL-R2 修复（CHANGE 17–20）实施与验证证据

> 授权口径（MSG-20261009-15）：`NEXT_AUTHORIZED = PHASE3_A_U1_FINAL_R2_REPAIR_AND_EVIDENCE + DESIGN_ONLY_CHANGES_21_TO_23`。
> 范围：**仅** U1 代码 + 设计文档；**不构成**任务队列 / Runtime / Prisma schema / 任何写路径的修改授权。

**变更内容**

- **CHANGE 17（P0）授权唯一性**：读取端由 `findStandingAuthorization`（`findFirst` 取最高版本）改为
  `listStandingAuthorizations`（`findMany` 取该组织**全部**行）；适配器做
  `ACTIVE` ∧ 有效期 ∧ 动作 ∧ 资源范围（`provider` / `platformAccountId` / `domain` / `jurisdiction`，
  **未提供的维度不构成约束**，提供空串 = 不匹配）匹配；0 条按原因细分
  （`AUTHORIZATION_NOT_FOUND` / `AUTHORIZATION_REVOKED` / `AUTHORIZATION_NOT_EFFECTIVE` / `ACTION_TYPE_NOT_ALLOWED`）；
  **同一请求下 ≥2 条有效记录 ⇒ `AUTHORIZATION_AMBIGUOUS`（fail-closed，不取「最高版本」）**；
  provenance 记录唯一命中的 `authorizationId`（可追溯到具体行，而不仅是版本号）。
- **CHANGE 18（P0）金额与币种显式规则**：请求**必须显式**声明 `monetaryAction: boolean`；为 `true` 时必须提供
  `amountUsd` + `currency`，金额须为 ≤4 位小数的**非负十进制**（禁科学计数法 / 负号 / 空串），请求币种须为
  `USD` 且**授权行 currency 亦须为 `USD`**；为 `false` 时**不得**携带金额 / 币种；任何不明确 ⇒
  `MONETARY_INPUT_INVALID`；超限或授权上限不可解析 ⇒ `MONETARY_LIMIT_EXCEEDED`（十进制按字符串 / 整数位长度比较，无浮点）。
- **CHANGE 19（P0）来源边界与版本失效**：`caller ∈ { SERVER_REQUEST_GATE, RUNTIME_MEMBER }`，
  由**可信执行上下文注入**（不是请求字段），其余（`BUILDER` / `MODEL` / `CLIENT` / 空串）⇒ `CALLER_NOT_TRUSTED`；
  新增 `expectedFactVersion`，与本次读取得到的 `factVersion = org:<identityVersion>|auth:<authorizationVersion>`
  比对，不一致 ⇒ `STALE_FACT_VERSION`（不得以旧事实取得新的提交权限）。
- **CHANGE 20（P1）证据补强**：**全部读取置于只读事务**（`SET TRANSACTION READ ONLY` 为事务内首条语句）；
  只读事务内任何写语句被 PostgreSQL **直接拒绝** —— 这是可执行的「无写」证据，而非「源码里没有写方法」；
  解析前后对 **Organization / StandingAuthorization / AuditLog / RecoveryOpportunity / AutonomyTask /
  AutonomyLease / AutonomyIncident** 做前后状态比较，并核对 `Organization.updatedAt` 未变。

**验证证据（本机可实测）**

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| 端口级单元测试 | `vitest run src/__tests__/phase3a-u1-trusted-facts-adapter.test.ts` | **38 / 38 PASS** |
| 真实 PostgreSQL 只读端口 | `vitest run src/__tests__/phase3a-u1-trusted-facts-adapter-db.test.ts`（隔离库 `crossclaim_p3r2_iso`） | **6 / 6 PASS** |
| 类型检查 | `apps/api tsc --noEmit` | **0 error** |

覆盖的负向用例（全部 fail-closed）：缺租户上下文 / 伪造调用方（MODEL、BUILDER、CLIENT、空）/
组织不存在 / 无授权行 / 资源范围无匹配 / 授权已撤销 / 未生效 / 已过期 / **多授权冲突** /
动作类型不在授权范围 / 缺 `monetaryAction` 声明 / 金额或币种缺失 / 金额形态非法（科学计数法、负号、>4 位小数、空串）/
请求币种非 USD / 授权行币种非 USD / 非金额动作携带金额或币种 / 超限 / 上限不可解析 / 期望事实版本不一致 / 运行时复核未确认。

**CHANGE 21–23（设计）**：已按 MSG-20261009-15 收口写入设计文档 **§17**：撤销 ↔ 文件发布的**共同排序权威**
（无证排序 ⇒ 仅 staging-only、摘要路径存在须**无覆盖发布**、发布后校验内容与摘要一致、`ISOLATED_WRITE` 在关闭前不得实施）、
`fencingGeneration` 持久化原子递增与**规范化身份编码** / identityVersion 的事务与 fencing 边界 /
TestRunner 须位于 Builder 不可修改的可信边界 / 环境摘要（镜像、依赖、入口、环境变量、策略版本）、
A11/A12 扩展**崩溃·重试·并发·持久化故障矩阵**。**均为设计文本，未实施、未授权实施。**

**未验证项（如实标注）**：Linux / systemd 实机、真实浏览器验收、真实 Provider / 模型调用（HOLD）、CI、生产环境 = **NOT VERIFIED**。

```text
PHASE3_U1_FINAL_R2_PROGRESS = CHANGE 17 OK / CHANGE 18 OK / CHANGE 19 OK / CHANGE 20 OK（U1 代码修订 + 证据补强）
PHASE3_U1_MSG15_VERDICT = MSG-20261009-15 = PASS WITH REVISE（逐字归档 FULL_COPY_OK / FNV1A fa1509df）
PHASE3_A_U1_EVIDENCE = 端口级 38/38 PASS + 真实 PG 6/6 PASS（隔离库 crossclaim_p3r2_iso）+ api tsc 0
PHASE3_U1_READ_ONLY_EVIDENCE = 只读事务内 DELETE / CREATE 被数据库拒绝（read-only transaction）+ 全相关表前后一致 + Organization.updatedAt 未变
PHASE3_CHANGES_21_TO_23 = DESIGN_ONLY_COMPLETED（设计文档 §17；未实施）
PHASE3_U1_IMPLEMENTATION_CLOSED = PENDING_AUDIT（待 MSG-20261009-16）
NEXT_UNIT = 送审 MSG-20261009-16（① CHANGE 17–20 修复证据 ② CHANGE 21–23 设计修订）
NEXT_AUDIT = MSG-20261009-16
EXTERNAL_WRITE = HOLD
AUTO_MERGE / AUTO_DEPLOY = FORBIDDEN
PRODUCTION_READY = NO
```

---

### 2.14 MSG-20261009-16 裁决（U1 FINAL-R2 + CHANGE 21–23 设计）= PASS WITH REVISE；**U1 仍未关闭**（新增 CHANGE 24–25）

> 归档：`AI-ARCHITECT-INBOX.md`（逐字，**FULL_COPY_OK**：原文行数 239 / 归档行数 239，缺失 0、多出 0）
> 源文件（页面提取）：`work/self-repair/verdict-msg-20261009-16.txt`，规范化指纹 FNV1A=5333e456（与页面提取一致）
> REVIEWED_HEAD = `28ea8fdc`；审计会话：https://chatgpt.com/c/6ac85873-4bc0-83ec-91bb-6782bec55081

**A 部分（U1 FINAL-R2 修复与证据）**

| 审计项 | 裁决 | 关键意见 |
| --- | --- | --- |
| CHANGE 17 授权唯一性 | PASS WITH REVISE | 多授权冲突拒绝正确，但**缺省资源范围需要安全约束**（→ CHANGE 24） |
| CHANGE 18 金额与币种 | PASS | 显式货币标记、USD 校验、定点十进制比较符合要求 |
| CHANGE 19 调用方与事实版本 | PASS WITH REVISE | 边界设计正确，可信上下文与版本来源仍需端到端证据 |
| CHANGE 20 只读证据 | PASS WITH REVISE | 数据库拒写探针充分支持只读事务性质，**原始执行证据待复核**（→ CHANGE 25） |
| U1_EVIDENCE_SUFFICIENCY | REVISE | 测试覆盖良好，独立可复核证据与授权范围负向矩阵尚未完全满足 |
| U1_SCOPE_COMPLIANCE | PASS（按声明范围） | 未发现主动申请执行 / 写入 / 生产权限 |

**B 部分（CHANGE 21–23，设计）**：`CHANGE21 = PASS_DESIGN_ONLY`、`CHANGE22 = PASS_DESIGN_ONLY`、
`CHANGE23 = PASS_DESIGN_ONLY`（**仅评审设计，均不构成 U2–U5 实施授权**）。

**本轮新增必须执行的修订**

- **CHANGE 24（P0）必需资源范围的可信导出**：按 `actionType` 由**服务端动作策略**决定必需范围维度；
  必需维度缺失 / 空串 / 非可信来源一律 fail-closed；真正可选的维度才允许缺省（且由服务端策略定义，不由调用者决定）；
  并增补**单授权情况下**跨账户 / 跨 Provider / 跨司法辖区的负向测试。
  （审计指出：多条有效授权会被拒绝，但**仅存在一条错误范围的授权时，唯一性本身不能阻止误授权**。）
- **CHANGE 25（P1）固定 HEAD 的独立证据包**：① 固定 `REVIEWED_HEAD` 的源码 diff + 完整测试输出 + 退出码 + 测试文件对应关系；
  ② 38 项端口测试与 6 项数据库测试的逐项名称与结果；③ 两条拒写探针**各自独立的 PostgreSQL 原始错误与事务边界**；
  ④ 证明经**公共 U1 入口**进入只读事务（而非仅测试手工构造的端口）；⑤ 七张相关表的前后状态证据
  （计数之外增加关键记录摘要）。

**审计特别指出的执行细节（下一轮必须处理）**：两条拒写探针必须分别在**独立事务**中执行 ——
同一事务在第一条 SQL 报错后通常已进入失败状态，第二条报错可能只是「事务已中止」，不构成对只读机制的独立证明。

```text
MSG16_VERDICT = PASS_WITH_REVISE（逐字归档 FULL_COPY_OK 239/239；FNV1A 5333e456）
U1_CHANGE17_AUTHORIZATION_UNIQUENESS = PASS_WITH_REVISE
U1_CHANGE18_MONETARY_EXPLICITNESS = PASS
U1_CHANGE19_CALLER_AND_VERSION_BOUNDARY = PASS_WITH_REVISE
U1_CHANGE20_READ_ONLY_EVIDENCE = PASS_WITH_REVISE
U1_EVIDENCE_SUFFICIENCY = REVISE
U1_SCOPE_COMPLIANCE = PASS（按声明范围）
CHANGE21 / CHANGE22 / CHANGE23 = PASS_DESIGN_ONLY（仅设计，未实施）
PHASE3_U1_IMPLEMENTATION_CLOSED = NO
PHASE3_A_U2_TO_U5_AUTHORIZED = NO
REQUIRED_CHANGES = CHANGE_24_P0_REQUIRED_SCOPE_TRUST_BOUNDARY;CHANGE_25_P1_INDEPENDENT_EVIDENCE_PACKAGE
NEXT_UNIT = PHASE3_A_U1_FINAL_R3_CHANGE24_25_ONLY（仅 U1 只读代码 + 关联测试 + 必要审计文档）
NEXT_AUDIT = MSG-20261009-17
EXTERNAL_WRITE = HOLD
AUTO_MERGE / AUTO_DEPLOY = FORBIDDEN
PRODUCTION_READY = NO
```
