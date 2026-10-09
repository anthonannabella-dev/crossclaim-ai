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

---

### 2.15 PHASE 3-A · U1 FINAL-R3（CHANGE 24–25）实施与**独立证据包**

> 授权：MSG-20261009-16 → `NEXT_AUTHORIZED = PHASE3_A_U1_FINAL_R3_CHANGE24_25_ONLY`
> 代码 commit（REVIEWED_HEAD）= `612f687d`；证据包 = `tools/verification/self-repair/phase3a-u1-final-r3-evidence.json`
> （含该 commit 的源码 diff、逐项用例名称、退出码、测试文件对应关系、DB 探针原始错误、七张表前后状态）
> 范围：**仅** U1 只读代码 + 关联测试 + 审计文档；**不构成**队列 / Runtime / Prisma schema / 任何写路径的修改授权。

**CHANGE 24（P0）必需资源范围的可信导出**

- 新增**服务端动作策略** `TRUSTED_FACTS_ACTION_SCOPE_POLICY`：按 `actionType` 决定**必需 / 可选**范围维度
  （`recovery.read` 与 `internal.repair.propose` 的必需维度 = `platformAccountId` + `provider`；`domain` / `jurisdiction` 为可选）。
  未登记的动作类型 ⇒ `SCOPE_POLICY_NOT_DEFINED`（fail-closed，不猜测）。
- **资源范围值改为只来自可信执行上下文**（`executionContext.resourceScope`，服务端解析注入）；
  `resolve()` 入参**不再接受** `resourceScope` —— 调用者既不能决定必需维度，也不能通过省略维度放大匹配面。
- 必需维度缺失 / 空串 / 非字符串 ⇒ `REQUIRED_SCOPE_MISSING`（fail-closed）。
- 授权匹配覆盖 `provider` / `platformAccountId` / `domain` / `jurisdiction`（已提供的维度一律参与匹配，空串视为不匹配）。
- provenance 新增 `scopePolicy`（actionType、required、optional、providedDimensions），可审计「谁决定必需维度」。
- 单授权错误范围负向测试（审计明确要求）：**跨账户 / 跨 Provider / 跨 domain / 跨 jurisdiction** 均 ⇒ `AUTHORIZATION_NOT_FOUND`。

**CHANGE 25（P1）固定 HEAD 的独立证据包**

| 审计要求 | 交付 |
| --- | --- |
| 固定 `REVIEWED_HEAD` 的源码 diff、完整测试输出、退出码、测试文件对应关系 | `phase3a-u1-final-r3-evidence.json` 字段 `codeCommit` / `codeCommitSubject` / `u1FileSha256` / `u1DiffFromCommit` / `commands[].exitCode` / `testFileMapping`；另附原始输出 `phase3a-u1-final-r3-vitest-raw.txt`、`phase3a-u1-final-r3-tsc-raw.txt` |
| 48 项端口测试、7 项数据库测试的逐项名称与结果 | `tests[]`（file / name / status），共 55 项，全部 `passed` |
| 两条拒写探针**各自独立事务**及**原始 PostgreSQL 错误** | `dbProbeEvidence[]`：`DELETE_IN_READ_ONLY_TX` 与 `CREATE_TABLE_IN_READ_ONLY_TX` 各 `independentTransaction: true`，错误均为 `PrismaClientKnownRequestError` / PG `25006`，消息分别含 `cannot execute DELETE …` 与 `cannot execute CREATE TABLE …`（证明第二条不是「事务已中止」的连带错误） |
| 证明经**公共 U1 入口**进入只读事务 | `dbProbeEvidence[]` 的 `PUBLIC_ENTRY_PROBE`：在 `resolve()` → 端口 `withReadOnlyTransaction` **实际使用的同一事务**内读到 `transaction_read_only = on`，且同事务内写入被拒（`writeRejected: true`） |
| 七张表前后状态证据（计数 + 关键记录摘要） | `dbProbeEvidence[]` 的 `TABLE_SNAPSHOT`：七张表计数 + `Organization.updatedAt` + 授权行 `id:version:revocationState:scopeDigest` 摘要，前后 `identical: true` |

**验证结果（本机实测）**：端口级 **48/48 PASS**、真实 PostgreSQL **7/7 PASS**（隔离库 `crossclaim_p3r2_iso`）、`apps/api tsc --noEmit` **0 error**。
证据行共 5 条（1 条范围负向 + 2 条独立拒写探针 + 1 条公共入口探针 + 1 条表快照）。

**未验证项（如实标注）**：Linux / systemd 实机、真实浏览器端到端、真实 Provider / 模型调用（HOLD）、CI、生产环境 = **NOT VERIFIED**。

```text
PHASE3_U1_FINAL_R3_PROGRESS = CHANGE 24 OK / CHANGE 25 OK
PHASE3_U1_FINAL_R3_CODE_COMMIT = 612f687d
PHASE3_U1_FINAL_R3_EVIDENCE = tools/verification/self-repair/phase3a-u1-final-r3-evidence.json（+ vitest/tsc 原始输出）
PHASE3_U1_FINAL_R3_TESTS = 端口级 48/48 + 真实 PG 7/7 = 55/55 PASS；api tsc 0
PHASE3_U1_FINAL_R3_DB_PROBES = 两条独立事务拒写探针（PG 25006，各自 verb）+ 公共入口 transaction_read_only=on 且写入被拒 + 七张表计数与摘要一致
PHASE3_U1_SCOPE_VALUE_SOURCE = TRUSTED_EXECUTION_CONTEXT（请求入参已移除 resourceScope）
PHASE3_U1_REQUIRED_SCOPE = SERVER_ACTION_POLICY（platformAccountId + provider；未登记动作 ⇒ SCOPE_POLICY_NOT_DEFINED）
NEXT_UNIT = 送审 MSG-20261009-17（申请 PHASE3_U1_IMPLEMENTATION_CLOSED=YES；U2–U5 仍 NO）
NEXT_AUDIT = MSG-20261009-17
EXTERNAL_WRITE = HOLD
AUTO_MERGE / AUTO_DEPLOY = FORBIDDEN
PRODUCTION_READY = NO
```

---

### 2.16 MSG-20261009-17 裁决（U1 FINAL-R3 / CHANGE 24–25）= **REVISE**；**U1 仍未关闭**（新增 CHANGE 26–28）

> 归档：`AI-ARCHITECT-INBOX.md`（逐字，**FULL_COPY_OK**：原文 92 行 / 归档 92 行，缺失 0、多出 0）
> 源文件（页面提取）：`work/self-repair/verdict-msg-20261009-17.txt`，规范化指纹 FNV1A=1b776bf3
> REVIEWED_HEAD = `612f687d`；审计会话：https://chatgpt.com/c/6ac85bba-b45c-83ec-a026-3b43d0424652

**裁决理由（关键）**：本轮提交的是**证据包的文字摘要**，而非可直接检查的原始材料 ——
审计方未取得固定 HEAD 的实际源码 diff、证据 JSON 原文与原始 Vitest/TSC 输出，
因此 55/55 PASS 的声明不足以签署 U1 关闭。**这不否定 CHANGE 24–25 的设计方向。**

| 审计项 | 裁决 |
| --- | --- |
| CHANGE24_REQUIRED_SCOPE_TRUST_BOUNDARY | REVISE（机制合理，缺独立核验） |
| CHANGE25_INDEPENDENT_EVIDENCE_PACKAGE | REVISE（证据结构完整性未核验） |
| U1_READ_ONLY_BOUNDARY_PRESERVED | REVISE（未查源码前不提升为已核实事实） |
| SCOPE_HONESTY | PASS |
| PHASE3_U1_IMPLEMENTATION_CLOSED | NO |
| PHASE3_A_U2_TO_U5_AUTHORIZED | NO |

**新增必须执行的修订**（明确**不要求**重新实施 CHANGE 24–25，只处理证据可复核性）

- **CHANGE 26（P0）**：提供固定 `612f687d` 的**实际源码 diff、证据 JSON 原文、原始 Vitest/TSC 输出**
  或可读取的仓库文件引用，支持独立复核。
- **CHANGE 27（P0）**：从源码与用例验证 `executionContext.resourceScope` 的**可信构造链**、
  必需维度拒绝逻辑，以及 `optional` 维度（`domain` / `jurisdiction`）**不会因异常省略而错误放大授权范围**
  （「字段存在于可信对象中」不等于安全）。
- **CHANGE 28（P1）**：复核证据 JSON 的逐项测试状态、退出码、只读事务独立性、公共入口探针与七张表快照，
  并确认全部对应固定 HEAD。

审计并指出：下一轮若证据可独立核验且未发现实现缺陷，**可直接**签署 `PHASE3_U1_IMPLEMENTATION_CLOSED=YES`，
无需再增加一轮功能开发；关闭 U1 不等于授权 U2–U5、外部写入或上线。

**通道约束（下一轮必须先解决，否则会被再次判 REVISE）**：ChatGPT 网页侧评审**无法读取本仓库**，
因此 CHANGE 26 中「可读取的仓库文件引用」在本通道不可用。下一轮送审必须**在消息正文内内联**：
固定 HEAD 的源码 diff（至少 U1 三个文件的关键段落）、证据 JSON 的关键字段与取值、
原始 Vitest/TSC 输出的关键行（含逐项用例名称与退出码）。若超出单条消息长度，则给出**可复核的最小充分子集**
并附明确的行号 / 字段路径，而不是仅给仓库路径。

```text
MSG17_VERDICT = REVISE（逐字归档 FULL_COPY_OK 92/92；规范化 FNV1A 1b776bf3）
CHANGE24_REQUIRED_SCOPE_TRUST_BOUNDARY = REVISE
CHANGE25_INDEPENDENT_EVIDENCE_PACKAGE = REVISE
U1_READ_ONLY_BOUNDARY_PRESERVED = REVISE
SCOPE_HONESTY = PASS
PHASE3_U1_IMPLEMENTATION_CLOSED = NO
PHASE3_A_U2_TO_U5_AUTHORIZED = NO
REQUIRED_CHANGES = CHANGE26_P0 + CHANGE27_P0 + CHANGE28_P1
NEXT_UNIT = PHASE3_A_U1_FINAL_R4_EVIDENCE_VERIFICATION_ONLY（内联固定 HEAD 的原始材料 + 可信构造链验证）
NEXT_AUDIT = MSG-20261009-18
EXTERNAL_WRITE = HOLD
AUTO_MERGE / AUTO_DEPLOY = FORBIDDEN
PRODUCTION_READY = NO
```

---

### 2.17 PHASE 3-A · U1 FINAL-R4（CHANGE 26–28）—— 范围声明链闭合 + 可独立复核的原始材料

> 授权：MSG-20261009-17 → `NEXT_AUTHORIZED = PHASE3_A_U1_FINAL_R4_EVIDENCE_VERIFICATION_ONLY`
> 代码 commit（REVIEWED_HEAD）= `68f8f5a9`；证据包 = `tools/verification/self-repair/phase3a-u1-final-r4-evidence.json`
> （+ `phase3a-u1-final-r4-vitest-raw.txt` / `phase3a-u1-final-r4-tsc-raw.txt`；内联材料 `out/msg18-inline.txt`）
> 范围：**仅** U1 只读代码 + 关联测试 + 审计文档；不构成队列 / Runtime / Prisma schema / 写路径修改授权。

**CHANGE 27（P0）范围声明链闭合**（不改变已批准的动作策略，只消除「没传 = 放宽」这一隐式通道）

- 可选维度必须**二选一**：提供具体值，或由服务端在可信上下文显式声明不适用
  （`executionContext.notApplicableScopeDimensions`）；两者皆无 ⇒ `OPTIONAL_SCOPE_UNDECLARED`（fail-closed）。
- 必需维度缺失 / 空串 / 被声明不适用 ⇒ `REQUIRED_SCOPE_MISSING`；
  同一维度既提供又声明不适用 ⇒ `SCOPE_DECLARATION_CONFLICT`（自洽性检查）。
- `provenance.scopePolicy` 新增 `notApplicableDimensions`，与 `providedDimensions` 一起留痕：
  「哪些维度参与匹配、哪些被显式排除」可审计，省略成为**显式决定**而非静默放宽。
- 新增负向用例：请求侧夹带 `resourceScope`（如 provider=SHOPIFY / 攻击者账户）**不改变匹配结果**，
  也**不能**替代可信上下文满足必需维度（仍报 `REQUIRED_SCOPE_MISSING`）。
- 诚实边界：U1 尚未接线到任何生产调用点（U2–U5 未授权），因此「resourceScope 由可信服务端构造」的
  本轮证据形式为：源码只从 executionContext 取值 + 两条请求侧夹带无用例；端到端可信装配链属 U2 范围。

**CHANGE 26（P0）+ CHANGE 28（P1）**：证据包重建为 R4 版本（`crossclaim.si-rsi.u1-final-r4-evidence/1`），
绑定固定 HEAD `68f8f5a9`（`codeCommit` / `u1FileSha256` / `u1DiffFromCommit`）；
并新增 `inlineEvidenceForAuditChannel`（关键源码原文、61 项逐项用例名称、原始输出摘要、全部 6 条 `U1_EVIDENCE` 行），
用于**在审计会话正文内内联**（评审方无法读取本仓库）。送审 = MSG-20261009-18（两条消息：请求 + 内联原始材料）。

**验证结果（本机实测）**：端口级 **53/53 PASS**、真实 PostgreSQL **8/8 PASS**（隔离库 `crossclaim_p3r2_iso`）、
`apps/api tsc --noEmit` **0 error**；`VITEST_EXIT=0` / `TSC_EXIT=0`；证据行 6 条。

**未验证项（如实标注）**：Linux / systemd 实机、真实浏览器端到端、真实 Provider / 模型调用（HOLD）、CI、生产环境 = **NOT VERIFIED**。

```text
PHASE3_U1_FINAL_R4_PROGRESS = CHANGE 26 OK / CHANGE 27 OK / CHANGE 28 OK
PHASE3_U1_FINAL_R4_CODE_COMMIT = 68f8f5a9
PHASE3_U1_FINAL_R4_TESTS = 端口级 53/53 + 真实 PG 8/8 = 61/61 PASS；api tsc 0
PHASE3_U1_SCOPE_OPTIONAL_DIMENSION_RULE = 提供值 XOR 服务端显式声明不适用；两者皆无 ⇒ OPTIONAL_SCOPE_UNDECLARED
PHASE3_U1_REQUEST_SIDE_SCOPE = 无效（不能改变匹配，也不能满足必需维度）
PHASE3_U1_EVIDENCE_INLINE = out/msg18-inline.txt（13907 chars；随 MSG-20261009-18 第二条消息内联）
NEXT_UNIT = 送审 MSG-20261009-18（申请 PHASE3_U1_IMPLEMENTATION_CLOSED=YES；U2–U5 仍 NO）
NEXT_AUDIT = MSG-20261009-18
EXTERNAL_WRITE = HOLD
AUTO_MERGE / AUTO_DEPLOY = FORBIDDEN
PRODUCTION_READY = NO
```

---

### 2.18 MSG-20261009-18 裁决（U1 FINAL-R4）= **REVISE**；**U1 仍未关闭**（新增 CHANGE 29–31，均为证据核验）

> 归档：`AI-ARCHITECT-INBOX.md`（逐字，**FULL_COPY_OK**：原文 92 行 / 归档 92 行，缺失 0、多出 0）
> 源文件（页面提取）：`work/self-repair/verdict-msg-20261009-18.txt`，规范化指纹 FNV1A=d54ceeac
> REVIEWED_HEAD = `68f8f5a9`；审计会话：https://chatgpt.com/c/6ac85dd2-d924-83ec-8fc9-897018eb03bd

**进展**：内联证据「较上一轮有实质改进」；**CHANGE 27 范围声明链 = PASS_SCOPED**（机制获认可：
必需维度缺失/被声明不适用 ⇒ `REQUIRED_SCOPE_MISSING`、可选维度未提供也未声明 ⇒ `OPTIONAL_SCOPE_UNDECLARED`、
冲突 ⇒ `SCOPE_DECLARATION_CONFLICT`、`resolve()` 只从 `executionContext.resourceScope` 取值、
provenance 记录参与匹配与显式排除的维度）。`SCOPE_HONESTY = PASS`。
`U1_READ_ONLY_BOUNDARY_PRESERVED = PASS_WITH_REVISE`（25006 拒写证据支持所测路径的只读性质）。

**未关闭原因（全部是证据层，不是机制缺陷）**：

- `CHANGE26_RAW_EVIDENCE_INLINE = REVISE`：内联的是摘要式摘录（关键源码片段 + 用例名 + 探针字段），
  不是**完整原始文件内容**，评审方无法独立计算指纹、无法确认 `68f8f5a9` 确为材料来源。
- `CHANGE28_EVIDENCE_JSON_BINDING = REVISE`：无 `evidence.json` 原文、无完整测试执行记录，
  `[passed]` 标记不能替代实际运行记录。
- 七张表快照**大部分表只有计数**（仅授权行有摘要），计数相等无法排除记录内容变化。

**新增必须执行的最小修订**（明确「属于证据修订，不是重新授权代码修复」，如现有文件已含所需内容可直接提交原文）

- **CHANGE 29（P0）**：提供可独立核对的**固定 HEAD 文件内容或可访问的 Git blob**、文件指纹**计算过程/结果**与关键调用链。
- **CHANGE 30（P0）**：提供 `evidence.json` **实际内容**、**完整测试执行记录**与退出码，证明逐项状态与当前 HEAD 一致。
- **CHANGE 31（P1）**：补齐**七张表快照的实现与比较方式**，证明**内容级**一致性；并核对独立事务探针与公共入口探针的实际执行路径。

**通道结构性观察（下一轮必须正面处理）**：网页评审**读不到本仓库**（且远端为私有库，Git blob URL 亦不可读），
因此 CHANGE 29 的「可访问 Git blob」在本通道不可用。可行路径只有：在送审正文内**逐文件/分片内联完整文件内容或完整 diff**
（适配器约 25 KB + 端口测试约 18 KB + DB 测试约 16 KB，需拆分为多条消息），并附**指纹计算的可复核过程**。

```text
MSG18_VERDICT = REVISE（逐字归档 FULL_COPY_OK 92/92；规范化 FNV1A d54ceeac）
CHANGE26_RAW_EVIDENCE_INLINE = REVISE
CHANGE27_SCOPE_DECLARATION_CHAIN = PASS_SCOPED
CHANGE28_EVIDENCE_JSON_BINDING = REVISE
U1_READ_ONLY_BOUNDARY_PRESERVED = PASS_WITH_REVISE
SCOPE_HONESTY = PASS
PHASE3_U1_IMPLEMENTATION_CLOSED = NO
PHASE3_A_U2_TO_U5_AUTHORIZED = NO
REQUIRED_CHANGES = CHANGE29_P0 + CHANGE30_P0 + CHANGE31_P1（均为证据核验）
NEXT_UNIT = PHASE3_A_U1_FINAL_R5_EVIDENCE_VERIFICATION_ONLY（逐文件内联完整内容/完整 diff + 七张表内容级快照 + 范围维度未声明值处理）
NEXT_AUDIT = MSG-20261009-19
EXTERNAL_WRITE = HOLD
AUTO_MERGE / AUTO_DEPLOY = FORBIDDEN
PRODUCTION_READY = NO
```

---

### 2.19 PHASE 3-A · U1 FINAL-R5（CHANGE 29–31）—— 可独立核对的原始材料 + 内容级表快照

> 授权：MSG-20261009-18 → `NEXT_AUTHORIZED = PHASE3_A_U1_FINAL_R5_EVIDENCE_VERIFICATION_ONLY`
> 代码 commit（REVIEWED_HEAD）= `e4c2f27d`；证据包 = `tools/verification/self-repair/phase3a-u1-final-r5-evidence.json`（147,846 bytes）
> 分片材料 = `work/self-repair/u1-r5/out/msg19/`（13 片 + manifest.json）

**CHANGE 27 残留项闭合（上一轮要求「展示现有实现并证明不存在绕过路径」）**

- 策略未覆盖的维度：既不能提供取值、也不能声明不适用 ⇒ `SCOPE_DIMENSION_NOT_DECLARED`（fail-closed）。
- 重复声明按 Set 语义等价、返回值按固定维度顺序去重；维度取值只接受字符串（否则 `REQUIRED_SCOPE_MISSING` / `OPTIONAL_SCOPE_UNDECLARED`）。
- 授权匹配只使用通过校验的 `providedDimensions`（源码 + 用例双证）。

**CHANGE 29/30/31 交付**

- 证据包新增 `u1FileContents`（三个 U1 文件**完整内容**）与 `fingerprintMethod`（sha256 / raw bytes / node 与 PowerShell 两种算法说明 + `git show HEAD:<path>` 注意事项）。
- 证据包新增 `inlineEvidenceForAuditChannel` 与 13 个分片文件（每条消息只按行边界切分，标注 part i/N 与总字符数）。
- 七张相关表改为**内容级**摘要：对每张表执行 count + md5(string_agg(row_to_json 排序))，before/after 逐表 `count:digest` 一致
  （任何行任何字段变化都会改变 digest）。原始值见 `dbProbeEvidence[kind=TABLE_SNAPSHOT]`。
- 探针执行路径：两条拒写探针各自独立事务；公共入口探针与 `resolve()` 读取共用同一事务（`transaction_read_only=on` 且写入被拒）。

**验证结果（本机实测）**：端口级 **53/53 PASS**、真实 PostgreSQL **8/8 PASS**（隔离库 `crossclaim_p3r2_iso`）、
`apps/api tsc --noEmit` **0 error**；`VITEST_EXIT=0` / `TSC_EXIT=0`；`Tests 61 passed (61)` / `Test Files 2 passed (2)`；证据行 6 条。

**通道约束**：网页评审无法读取本仓库（私有远端），故本轮以 **7 条消息**（M1 说明 + M2/M3/M4 三个完整文件 + M5/M6 evidence.json 核心视图 + M7 原始 Vitest 输出）逐字内联原始材料。

**未验证项（如实标注）**：Linux / systemd 实机、真实浏览器端到端、真实 Provider / 模型调用（HOLD）、CI、生产环境 = **NOT VERIFIED**。

```text
PHASE3_U1_FINAL_R5_PROGRESS = CHANGE 29 OK / CHANGE 30 OK / CHANGE 31 OK / CHANGE 27 残留项 OK
PHASE3_U1_FINAL_R5_CODE_COMMIT = e4c2f27d
PHASE3_U1_FINAL_R5_EVIDENCE = tools/verification/self-repair/phase3a-u1-final-r5-evidence.json（含 u1FileContents + fingerprintMethod）
PHASE3_U1_FINAL_R5_TESTS = 端口级 53/53 + 真实 PG 8/8 = 61/61 PASS；api tsc 0
PHASE3_U1_TABLE_SNAPSHOT = 七张表内容级 count:md5 摘要一致（不再以计数代替内容）
PHASE3_U1_UNDECLARED_SCOPE_DIMENSION = SCOPE_DIMENSION_NOT_DECLARED（fail-closed）
NEXT_UNIT = 送审 MSG-20261009-19（M1–M7 内联原始材料；申请 PHASE3_U1_IMPLEMENTATION_CLOSED=YES）
NEXT_AUDIT = MSG-20261009-19
EXTERNAL_WRITE = HOLD
AUTO_MERGE / AUTO_DEPLOY = FORBIDDEN
PRODUCTION_READY = NO
```

---

### 2.19b MSG-20261009-19 投递状态（本 tick 未送达）+ 通道问题如实记录

**已完成并推送**：R5 代码 `e4c2f27d`（CHANGE 27 残留项 `SCOPE_DIMENSION_NOT_DECLARED`、CHANGE 31 七张表内容级 count:md5 快照）、
证据与送审包 `fac55b02`（`phase3a-u1-final-r5-evidence.json` 147,846 bytes，含 `u1FileContents` 与 `fingerprintMethod`；
13 个分片文件与 manifest）。本机实测：端口级 53/53 + 真实 PG 8/8 = 61/61、`api tsc` 0。

**MSG-20261009-19 尚未送达**。失败经过（如实记录，不掩饰）：

1. 为绕开「网页评审读不到私有仓库」，本轮改用「OS 剪贴板 → 浏览器 Ctrl+V」把完整文件内容送入输入框。
2. 实测发现：本机自动化下**浏览器剪贴板与 OS 剪贴板不是同一个**（`tab.clipboard` 只反映页面内复制/粘贴，
   PowerShell `Set-Clipboard` 的内容不会被页面 Ctrl+V 取到）。因此 Ctrl+V 粘入的是**上一条**内容。
3. 后果：新建的一个会话（https://chatgpt.com/c/6ac85f9b-846c-83ec-a88c... 见会话列表）中
   被误发了一条 **MSG-20261009-18 内联材料副本**；该副本与原材料一致，无新增或伪造内容，
   但属于重复投递，**不能作为 MSG-19 的送审**。MSG-19 的主送审文本并未送出（输入框校验 `HAS_M1=false`）。

**下一 tick 的投递方案（不再使用 OS 剪贴板）**：

- 用 `tab.paste(index, text, {format:'text'})`（已知可靠：按 Playwright `insertText` 注入，不经剪贴板），
  JS 字面量中对两类字符做**可逆转义**而非替换：反引号 → `\``、`${` → `\${`，从而保持字节一致。
- 分 7 条消息投递（M1 说明；M2 适配器全文；M3 端口测试全文；M4 DB 测试全文；M5/M6 evidence.json 核心视图；M7 原始 vitest 输出）。
- 为控制每次工具调用的上下文开销与输入长度，必要时把 M2/M4 再按行分片（每片 ≤12k 字符，标注 part i/N）。

**需要用户决定（可选项，不阻塞）**：若希望大幅减少往返，可让评审方获得该分支的**只读访问**
（例如把分支推到可被其读取的位置或提供只读快照），否则将继续按上述「正文字节级内联」方式推进。

```text
MSG19_DELIVERY = NOT_SENT（本 tick）
MSG19_STRAY_DUPLICATE = 1 条（新会话，内容 = MSG-20261009-18 内联材料副本；已在会话列表中可辨认）
MSG19_TRANSPORT_FIX = tab.paste + 模板字面量可逆转义（反引号 / ${）
R5_CODE_COMMIT = e4c2f27d（已 push）
R5_DOCS_EVIDENCE_COMMIT = fac55b02（已 push）
NEXT_UNIT = 继续投递 MSG-20261009-19（M1–M7），随后等待裁决
```

---

### 2.20 停止心跳：审计通道无法承载字节级证据（HOST 阻断，需用户决定）

**结论**：MSG-20261009-19 在本机**无法以可核对的方式送达**，据此按心跳规则 8 停止本心跳。
本机代码与证据均已固化并推送；后续恢复取决于通道决策（见下）。

**已完成并推送（可继续复核）**

- `e4c2f27d`：R5 代码 —— `SCOPE_DIMENSION_NOT_DECLARED`（策略未覆盖维度 fail-closed、重复声明 Set 语义等价）、
  七张表内容级 `count:md5(string_agg(row_to_json ORDER BY …))` 快照。
- `fac55b02`：`tools/verification/self-repair/phase3a-u1-final-r5-evidence.json`（147,846 bytes，
  含三文件完整内容 `uFileContents`、`fingerprintMethod`、61 项用例、6 条 `U1_EVIDENCE`）+ 原始 vitest/tsc 输出 + checkpoint §2.19。
- `ddd46646`：§2.19b 通道问题与误发记录。
- 本机实测：端口级 53/53 + 真实 PG 8/8 = 61/61、`api tsc --noEmit` 0。

**阻断事实（三次投递尝试，均已实测）**

1. `tab.paste(index, text)` 可靠，但要求正文以 JS 字面量内联：本轮需内联 3 个 U1 文件 + 证据 JSON 核心 + 原始输出
   ≈ 105 KB，且含 56+ 反引号与模板插值符号，手工转义存在实体错误风险 —— 一旦出错即污染「固定 HEAD 内容」这一待证事实，
   与心跳规则 9「不得伪造证据」冲突。
2. OS 剪贴板 → 浏览器 `Ctrl+V`：实测本机自动化下**浏览器剪贴板与 OS 剪贴板不是同一个**，粘入的是上一条内容
   （因此产生 1 条 MSG-18 材料副本的误发，已在 §2.19b 记录）。
3. 评审侧要求「可访问的 Git blob」：远端为**私有库**，网页评审无读取路径；本地 REPL 亦无宿主文件服务
   （`nodeRepl.rpc` 返回 Trusted RPC service is not configured）。

**需要用户决定（三选一）**

- **A（推荐，最省往返）**：给评审方一个**只读访问入口**（例如把 `feat/si-rsi-internal-code-repair-v1` 推送到评审方可读的位置，
  或提供只读快照/附件）。此后 CHANGE 29–31 可在一轮内闭合。
- **B**：人工把 3 个 U1 文件与 `phase3a-u1-final-r5-evidence.json` 作为**附件**贴入审计会话（人机动作一次），随后我继续按裁决推进。
- **C**：调整证据口径 —— 改为「完整 diff + 每段源码摘要 digest（可复算）+ 工具生成的原始输出」，
  不再要求整文件哈希（需评审方明确同意此口径变更）。

**暂停期间的状态（不得误解为已完成）**

- U1 实施仍未关闭：`PHASE3_U1_IMPLEMENTATION_CLOSED = NO`（MSG-18 裁决）；U2–U5 未授权。
- MSG-20261009-19 **未送审**，因此不存在任何针对 R5 的裁决；`AI-ARCHITECT-INBOX.md` 未新增段。
- 未验证项照旧：Linux / systemd 实机、真实浏览器端到端、真实 Provider / 模型调用（HOLD）、CI、生产环境 = **NOT VERIFIED**。

```text
HEARTBEAT_STATUS = STOPPED_BY_RULE_8（HOST 阻断：审计通道无法承载字节级证据；无 automation 工具可自行删除，请用户在应用侧移除 crossclaim-si-rsi-dev-executor-180s）
OS_CHECKER = DISABLED（schtasks /change /tn CrossClaim-SI-RSI-ContinuousCheck /disable）
MSG19_DELIVERY = NOT_SENT
R5_CODE_COMMIT = e4c2f27d（已 push）
R5_DOCS_EVIDENCE_COMMIT = fac55b02（已 push）
R5_STATE_NOTE_COMMIT = ddd46646（已 push）
U1_IMPLEMENTATION_CLOSED = NO
PHASE3_A_U2_TO_U5_AUTHORIZED = NO
EXTERNAL_WRITE = HOLD
AUTO_MERGE / AUTO_DEPLOY = FORBIDDEN
PRODUCTION_READY = NO
PENDING_USER_DECISION = A（给评审方只读访问）/ B（人工附件投递）/ C（调整证据口径）
```

---

### 2.20b MSG-20261009-19 GitHub Issue 交接 = **无法执行**（按用户指令停止，不推测 PASS）

**用户指令**：从 GitHub 仓库 `anthonannabella-dev/crossclaim-ai` 读取 MSG-20261009-19 的独立审计 Issue，核对编号 /
REVIEWED_HEAD / 裁决 / REQUIRED_CHANGES / NEXT_AUTHORIZED，逐字归档并更新 checkpoint；
**找不到 Issue 或裁决不完整时必须停止，不得推测 PASS**。

**本机核查结果（只读）**

1. `gh` CLI 存在（v2.97.0）但**凭据无效**：`gh auth status` 报 “The token in default is invalid”，
   `gh issue list -R anthonannabella-dev/crossclaim-ai` 返回 `HTTP 401: Requires authentication`。
2. 环境变量中**不存在** `GITHUB_TOKEN` / `GH_TOKEN`；`GIT_CONFIG_KEY_0/1` 仅为 `safe.directory`（无凭据注入）。
   `git credential fill` 无可用 helper，调用会挂起等待交互（已终止该尝试）。
3. 仓库为**私有**，因此无法通过匿名 API/网页读取 Issue。
4. 用户已说明「审计 Issue 编号由 ChatGPT 发布后提供」——**当前尚未收到任何 Issue 编号**。

**结论**：MSG-20261009-19 的 GitHub Issue **无法读取**，故本轮**没有**任何经核对的裁决可归档；
checkpoint 不写 PASS、不写 CLOSED。按用户指令**停止**，等待 Issue 编号或读取途径。

**附带发现（事实记录，非 GitHub Issue，未经评审方再次确认，不得作为关闭依据）**

此前因剪贴板误操作而新建的会话（https://chatgpt.com/c/6ac85f9b-846c-83ec-ae8c-bf307292d33f，标题「审计裁决总结」）
中，评审方针对**同一批 MSG-20261009-18 材料**给出了一份与已归档裁决（REVISE / CHANGE 29–31）**不同**的结论。
其机器可读状态字段（逐字转录自该会话回复）：

```text
EVIDENCE_REVIEW = PASS
CHANGE_24 = PASS
CHANGE_25 = PASS
CHANGE_27 = PASS
U1_EVIDENCE_ACCEPTED = YES
U1_INDEPENDENT_REPRODUCED = NO
PHASE3_A_U1_CLOSED = PENDING_INDEPENDENT_VERIFICATION
NEXT_AUTHORIZED = U1_INDEPENDENT_VERIFICATION_READ_ONLY
U2_TO_U5_IMPLEMENTATION_AUTHORIZED = NO
AUTONOMOUS_CODE_REPAIR_AUTHORIZED = NO
EXTERNAL_WRITE = HOLD
PRODUCTION_READY = NO
NEXT_AUDIT = MSG-20261009-19
最终裁决：MSG-20261009-18 = PASS（提交证据验收通过；最终独立复现待完成）。
```

要点：该回复明确区分「提交证据审查 = PASS」与「仓库独立复现 = NOT VERIFIED」，
并把 U1 关闭状态标为 `PENDING_INDEPENDENT_VERIFICATION`（**仍未 CLOSED**）。
两处差异需用户/评审方裁定后再决定归档口径：

1. 同编号 MSG-20261009-18 出现两份结论（REVISE 与 PASS/EVIDENCE_ACCEPTED）——归档以哪一份为准？
2. 若以 PASS/EVIDENCE_ACCEPTED 为准，则 `NEXT_AUTHORIZED = U1_INDEPENDENT_VERIFICATION_READ_ONLY`，
   R5 的 CHANGE 29–31（字节级证据核验）是否仍需执行、执行到什么深度。

```text
MSG19_ISSUE_LOOKUP = FAILED（gh 401 / 无私钥 / 私有库 / 未收到 Issue 编号）
MSG19_VERDICT_ARCHIVED = NONE（不得推测 PASS）
U1_IMPLEMENTATION_CLOSED = NO（未获得任何 CLOSED 裁决）
PHASE3_A_U2_TO_U5_AUTHORIZED = NO
R5_CODE_COMMIT = e4c2f27d（已 push；未被任何 Issue 裁决引用）
SECOND_MSG18_VERDICT_OBSERVED = YES（会话 6ac85f9b；PASS/EVIDENCE_ACCEPTED；非 Issue、待裁定）
BLOCKED_ON = GitHub Issue 编号或可读途径；以及上述两份同编号裁决的裁定
EXTERNAL_WRITE = HOLD
AUTO_MERGE / AUTO_DEPLOY = FORBIDDEN
PRODUCTION_READY = NO
```

---

### 2.21 MSG-20261009-19 裁决归档（PASS WITH REVISE）+ CHANGE 32（并发事务隔离）实施

> 归档：`AI-ARCHITECT-INBOX.md`（逐字，**FULL_COPY_OK**：原文 29 行 / 归档 29 行，缺失 0、多出 0）
> 源文件：`work/self-repair/verdict-msg-20261009-19.txt`（来源＝HOST 在会话中粘贴的裁决正文）
> 裁决：`VERDICT = PASS WITH REVISE`；`REVIEWED_HEAD = e4c2f27d`、`EVIDENCE_HEAD = 16cf7747`；
> CHANGE 29 = **PASS**（三个完整 U1 文件可从 GitHub 固定提交读取、与 evidence.json 一致、SHA-256 独立复算一致）；
> CHANGE 30 = PASS_SCOPED、CHANGE 31 = PASS_SCOPED；`PHASE3_U1_IMPLEMENTATION_CLOSED = NO`。

**CHANGE 32（P0）并发事务隔离 —— 已完成**

- 缺陷：`createPrismaTrustedFactsReadPort` 用**实例级** `activeTransaction` 保存“当前事务句柄”，
  并发 `resolve()` 共用同一 `readPort` 实例时，后发请求可能复用先发请求的事务（并可能在其后被清空后回落裸 client）。
- 修复：改为 `AsyncLocalStorage` **按调用链**隔离事务句柄 —— 并发调用各自持有自己的只读事务；
  同一调用链内的嵌套调用复用同一事务；异常随调用链自动失效，不存在残留句柄复用路径。未新增 Runtime/Scheduler/Controller。
- 新增 `U1-DB9` 真实 PostgreSQL 并发回归：同一 `readPort` 实例 + 两个租户（版本 3 / 5），
  **A 先进入只读事务并停住，B 才启动**（强制交错），断言：
  ① 事务归属独立（两次并发调用的事务句柄序号互异）；② 每此调用 `transaction_read_only = on`；
  ③ 每次调用内的写入均被拒（PG 25006）；④ 无跨租户串扰（各自拿到本租户 authorizationId/version）；
  ⑤ 异常路径 fail-closed（不存在组织 ⇒ `ORGANIZATION_NOT_FOUND`），其后调用获得**全新**事务。
- **负向对照**：把端口还原为 CHANGE 32 之前的实现（实例级共享句柄）后运行同一套测试，
  `U1-DB9` **失败**：`expected 1 not to be 1`（两次并发调用拿到同一事务句柄）—— 证明该回归确实能捕获此缺陷。

**验证结果（本机实测）**：端口级 53 + 真实 PostgreSQL 9 = **62/62 PASS**；`apps/api tsc --noEmit` **0 error**；
证据包 `tools/verification/self-repair/phase3a-u1-final-r6-evidence.json`（62 项用例、7 条 `U1_EVIDENCE`、负向对照摘要），
另附原始输出 `…-r6-vitest-raw.txt`、`…-r6-tsc-raw.txt`、`…-r6-negative-control-vitest-raw.txt` 与对照实现 `…-r6-negative-control-adapter.ts`。

```text
MSG19_VERDICT = PASS_WITH_REVISE（逐字归档 FULL_COPY_OK 29/29）
CHANGE29 = PASS / CHANGE30 = PASS_SCOPED / CHANGE31 = PASS_SCOPED
CHANGE32 = IMPLEMENTED（AsyncLocalStorage 按调用链隔离 + U1-DB9 并发回归 + 负向对照）
PHASE3_U1_FINAL_R6_CODE_COMMIT = 23604dcb
PHASE3_U1_FINAL_R6_TESTS = 端口级 53 + 真实 PG 9 = 62/62 PASS；api tsc 0
PHASE3_U1_FINAL_R6_NEGATIVE_CONTROL = 旧实现下 U1-DB9 失败（expected 1 not to be 1）
PHASE3_U1_IMPLEMENTATION_CLOSED = NO（等待 MSG-20261009-20 裁决）
NEXT_UNIT = 送审 MSG-20261009-20（CHANGE 32 修复证据；申请 U1 CLOSED）
NEXT_AUDIT = MSG-20261009-20
PHASE3_A_U2_TO_U5_AUTHORIZED = NO
EXTERNAL_WRITE = HOLD
AUTO_MERGE / AUTO_DEPLOY = FORBIDDEN
PRODUCTION_READY = NO
```

---

### 2.22 MSG-20261009-20 裁决（U1 FINAL-R6 / CHANGE 32）= **REVISE — EVIDENCE NOT VERIFIED**；U1 仍未关闭（新增 CHANGE 33 P0）

> 归档：`AI-ARCHITECT-INBOX.md`（逐字，**FULL_COPY_OK**：原文 74 行 / 归档 74 行，缺失 0、多出 0）
> 源文件（页面提取）：`work/self-repair/verdict-msg-20261009-20.txt`，规范化指纹 FNV1A=7caa6f09
> 审计会话：https://chatgpt.com/c/6ac866ad-b654-83ec-bc91-4cb4a287294（REVIEWED_HEAD = 23604dcb）

**裁决要点**

- **方向被认可、未发现新缺陷**：CHANGE 32 用 `AsyncLocalStorage` 把事务上下文绑定到异步调用链「原则上可以解决」实例级共享问题；
  U1-DB9「针对了上轮最重要的并发缺陷」；负向对照「具有针对性」。
- **本轮未能完成核验**：评审方的 GitHub 连接器「搜索仓库、提交和证据文件，未检索到目标」，公开搜索也未找到，
  因此无法独立核对固定 HEAD 的代码、测试实现、原始日志、文件哈希与负向对照。
- 逐项：`CHANGE32_CONCURRENT_TRANSACTION_ISOLATION/REGRESSION_TEST/NEGATIVE_CONTROL = REVISE_EVIDENCE_NOT_VERIFIED`；
  `U1_READ_ONLY_BOUNDARY_PRESERVED = PASS_SCOPED_DECLARED_BOUNDARY_ONLY`；`SCOPE_HONESTY = PASS`；
  `PHASE3_U1_IMPLEMENTATION_CLOSED = NO`。

**CHANGE 33（P0）下一轮必须核验（在 23604dcb 下）**

1. `trusted-facts-adapter.ts` 中 `AsyncLocalStorage` 的**初始化 / 进入 / 退出 / 嵌套复用 / 异常处理路径**。
2. U1-DB9 是否确保 A、B 两个事务在**时间上真实重叠**（而非仅 `Promise.all` 的表面并发）。
3. A、B 的事务句柄是否不同，且句柄标识在**同一层级、同一机制**下取得。
4. `transaction_read_only=on`、PG `25006`、租户事实隔离、异常恢复是否均由**实际数据库断言**支持。
5. 负向对照是否**仅还原 CHANGE 32 相关实现**、其余条件保持一致。
6. 62 项测试、tsc、证据 JSON 与原始输出是否**都对应固定 HEAD**。
7. 特别关注：① `AsyncLocalStorage` 不自动保证事务生命周期安全（事务回调结束后若有脱离生命周期的异步任务访问已失效事务，必须 fail-closed）；
   ② 嵌套复用 ≠ 跨调用隔离（须同时证明同一调用链正确复用 + 不同调用链严格隔离 + 嵌套不绕过只读边界）。

**授权边界（裁决原文）**：不要求重新设计 CHANGE 32、不要求新增功能；下一轮**只允许**恢复证据可访问性、核验固定 HEAD，
并在核验发现真实缺陷时提交最小范围修复；U1 关闭前 `U2–U5` 不授权；`EXTERNAL_WRITE=HOLD`、`AUTO_MERGE/AUTO_DEPLOY=FORBIDDEN`、`PRODUCTION_READY=NO`。

**通道事实（本轮再次确认）**：GitHub 读取在本轮对评审方不可用（连接器检索不到 23604dcb 与 R6 证据文件）。
这意味着「评审方直读仓库」不足以稳定支撑核验；下一轮必须在**送审正文内**内联 CHANGE 33 所需的**最小充分原始材料**
（`AsyncLocalStorage` 三处关键源码片段、U1-DB9 交错编排与断言源码、负对照 diff 片段、PG 探针原始行、退出码），
并对每条核验要求给出**行号/字段路径**，使评审无需仓库访问即可逐条核对。

```text
MSG20_VERDICT = REVISE（逐字归档 FULL_COPY_OK 74/74；规范化 FNV1A 7caa6f09）
CHANGE32_CONCURRENT_TRANSACTION_ISOLATION = REVISE_EVIDENCE_NOT_VERIFIED
CHANGE32_CONCURRENCY_REGRESSION_TEST = REVISE_EVIDENCE_NOT_VERIFIED
CHANGE32_NEGATIVE_CONTROL = REVISE_EVIDENCE_NOT_VERIFIED
U1_READ_ONLY_BOUNDARY_PRESERVED = PASS_SCOPED_DECLARED_BOUNDARY_ONLY
SCOPE_HONESTY = PASS
PHASE3_U1_IMPLEMENTATION_CLOSED = NO
REQUIRED_CHANGES = CHANGE33_P0_FIXED_HEAD_SOURCE_TEST_RAW_EVIDENCE_AND_NEGATIVE_CONTROL_VERIFICATION
NEXT_UNIT = 在送审正文内内联 CHANGE 33 所需最小原始材料（含行号/字段路径）→ 送审 MSG-20261009-21
NEXT_AUDIT = MSG-20261009-21
PHASE3_A_U2_TO_U5_AUTHORIZED = NO
EXTERNAL_WRITE = HOLD
AUTO_MERGE / AUTO_DEPLOY = FORBIDDEN
PRODUCTION_READY = NO
```

---

### 2.23 MSG-20261009-21 送审（U1 FINAL-R6c：CHANGE 33 证据核验）已投递

> 会话：https://chatgpt.com/c/6ac868a8-46bc-83ec-9c9d-9698131ec0c5（新建）
> REVIEWED_HEAD = **e7c177a3**（上一轮 23604dcb）；NEXT_AUDIT = MSG-20261009-22
> 投递方式：M1 送审说明（逐条对应 CHANGE 33 六项与两个易遗漏问题）+ M2 **CHANGE 33 EVIDENCE PACK**（12,835 字符，含行号与 A–G 段；
> 因体积较大被 ChatGPT 作为「粘贴的文本附件」接收后发送）。原文反引号以 `<B>` 标记；diff 头部路径的双反斜杠粘贴后显示为单反斜杠。

**本轮代码变化（相对 23604dcb）**：仅 `apps/api/src/__tests__/phase3a-u1-trusted-facts-adapter-db.test.ts` +75 行，
新增两个真实 PostgreSQL 证据用例（产品代码未改）：

- **U1-DB10**：同一调用链内嵌套 `withReadOnlyTransaction` **复用同一事务**（`transactionsOpened=1`、`handleSequences=[1,1]`），
  且嵌套中经端口读取命中该事务（`readInsideNestedCall=true`）——回应「嵌套复用是否合法」。
- **U1-DB11**：事务结束后，**脱离事务生命周期**的异步任务访问已失效句柄必须**抛错**（`threw=true`、`returnedValue=null`、`failClosed=true`），
  不得静默回落裸 client ——回应「失效事务访问是否 fail-closed」。

**证据包 A–G 段内容**：A 固定 HEAD 指纹（adapter/db-test 的 sha256 与变更清单）；B `AsyncLocalStorage` 初始化/进入/退出/嵌套/异常路径（第 550–559、609–615 行）；
C U1-DB9 交错编排（第 523–528 行：先 A 后 B，双方都在事务内再 release）与断言（第 531–545 行）；
D U1-DB10 全文；E U1-DB11 全文；F 负向对照与固定实现的**完整 diff（仅 2 处：import 与端口内部实现）**；
G 原始输出摘要（`Tests 64 passed (64)`、`VITEST_EXIT=0`、`TSC_EXIT=0`、隔离库标记）与 3 条关键 `U1_EVIDENCE` 行
（CONCURRENT_TRANSACTION_ISOLATION / NESTED_TRANSACTION_REUSE / DEAD_TRANSACTION_ACCESS）。

**本轮验证（本机实测）**：端口级 53 + 真实 PostgreSQL 11 = **64/64 PASS**；`apps/api tsc --noEmit` 0 error。

```text
MSG21_DELIVERY = SENT（M1 说明 + M2 证据包附件；会话 6ac868a8）
MSG21_REVIEWED_HEAD = e7c177a3
MSG21_PREVIOUS_HEAD = 23604dcb
MSG21_NEXT_AUDIT = MSG-20261009-22
CHANGE33_EVIDENCE_PACK = work/self-repair/u1-r6/out/msg21-evidence.txt（12,835 chars；含行号 A–G 段）
PHASE3_U1_FINAL_R6_TESTS = 端口级 53 + 真实 PG 11 = 64/64 PASS；api tsc 0
PHASE3_U1_IMPLEMENTATION_CLOSED = NO（等待 MSG-20261009-22 裁决）
PHASE3_A_U2_TO_U5_AUTHORIZED = NO
EXTERNAL_WRITE = HOLD
AUTO_MERGE / AUTO_DEPLOY = FORBIDDEN
PRODUCTION_READY = NO
```

---

### 2.24 MSG-20261009-21 裁决（U1 FINAL-R6c / CHANGE 33）= **PASS WITH REVISE**；U1 仍未关闭（新增 CHANGE 34–37，均为最小证据修订）

> 归档：`AI-ARCHITECT-INBOX.md`（逐字，**FULL_COPY_OK**：原文 120 行 / 归档 120 行，缺失 0、多出 0）
> 源文件：`work/self-repair/verdict-msg-20261009-21.txt`，规范化指纹 FNV1A=a4ed07c5
> 审计会话：https://chatgpt.com/c/6ac868a8-46bc-83ec-9c9d-9698131ec0c5（REVIEWED_HEAD = e7c177a3）

**本轮裁决**：`FINAL_VERDICT = PASS WITH REVISE`。评审方已审阅内联 A–G 证据，认为「CHANGE 32 的隔离修复设计合理，
CHANGE 33 的证据明显增强」，但仍差四项**最小核验证据**，**不要求重写实现**、不授权 U2–U5。
逐项：生命周期 PASS WITH REVISE；真实并发重叠 **REVISE**；句柄与获取层级 PASS_SCOPED；
PG 断言 PASS WITH REVISE；负对照最小还原 PASS_SCOPED；固定 HEAD 证据绑定 **REVISE**。
`U1_READ_ONLY_BOUNDARY_PRESERVED = PASS_SCOPED`、`SCOPE_HONESTY = PASS`、`PHASE3_U1_IMPLEMENTATION_CLOSED = NO`。

**新增必须执行的最小修订（下一轮授权：`PHASE3_A_U1_FINAL_R7_CHANGES34_TO37_ONLY`）**

- **CHANGE 34（P0）**：并发门闩必须证明**真实进入**而非超时继续 —— A/B 各自设置**不可伪造**的 `enteredTransaction` 标志；
  一旦超时必须**直接失败**；释放门闩前断言 A、B 均已进入事务；断言 A/B **事务活动区间确实重叠**；
  并在**同一重叠窗口内**完成句柄独立性检查。通过标准 `REAL_CONCURRENT_OVERLAP=PASS`。
- **CHANGE 35（P1）**：明确证明 **PostgreSQL SQLSTATE 25006** —— 展示四个写入探针各自捕获的 SQLSTATE、提取代码、
  「四项均 25006」的断言，并确认拒绝发生在被测只读事务内。通过标准 `PG_25006_ASSERTION=PASS`。
- **CHANGE 36（P1）**：异步生命周期确定性 —— `transactionsOpened` 不能只是外层回调进入次数（需真实 PG 事务计数/等效证据）；
  用**显式事务结束信号**替代 `setTimeout(60)`；并确定性区分「作用域中仍存在已失效句柄」与「使用失效句柄必须被拒绝（不回退裸 client）」。
  通过标准 `ASYNC_LIFECYCLE_DETERMINISTIC=PASS`。
- **CHANGE 37（P1）**：机器可核对的 HEAD 绑定最小清单 —— 完整 40 位 Git commit、实际被测源文件 SHA256、测试文件 SHA256、
  原始 Vitest/tsc 输出文件 SHA256、负向对照执行结果与预期失败断言、运行这些验证时的实际代码 HEAD（无需重贴整仓）。

```text
MSG21_VERDICT = PASS_WITH_REVISE（逐字归档 FULL_COPY_OK 120/120；规范化 FNV1A a4ed07c5）
CHANGE33_1_ALS_LIFECYCLE = PASS_WITH_REVISE
CHANGE33_2_REAL_CONCURRENT_OVERLAP = REVISE
CHANGE33_3_HANDLE_IDENTITY_AND_LAYER = PASS_SCOPED
CHANGE33_4_PG_ASSERTIONS = PASS_WITH_REVISE
CHANGE33_5_NEGATIVE_CONTROL_MINIMAL_REVERT = PASS_SCOPED
CHANGE33_6_FIXED_HEAD_EVIDENCE_BINDING = REVISE
U1_READ_ONLY_BOUNDARY_PRESERVED = PASS_SCOPED
SCOPE_HONESTY = PASS
PHASE3_U1_IMPLEMENTATION_CLOSED = NO
REQUIRED_CHANGES = CHANGE34_P0,CHANGE35_P1,CHANGE36_P1,CHANGE37_P1
NEXT_UNIT = PHASE3_A_U1_FINAL_R7_CHANGES34_TO37_ONLY（门闩确定性 + SQLSTATE 断言 + 生命周期确定性 + HEAD 绑定清单）→ 送审 MSG-20261009-22
NEXT_AUDIT = MSG-20261009-22
PHASE3_A_U2_TO_U5_AUTHORIZED = NO
RUNTIME_SOURCE_ISOLATION_IMPLEMENTED = NO
EXTERNAL_WRITE = HOLD
AUTO_MERGE / AUTO_DEPLOY = FORBIDDEN
PRODUCTION_READY = NO
```

---

### 2.25 U1 FINAL-R7（CHANGE 34–37）实施完成，待送审 MSG-20261009-22

> 授权：MSG-20261009-21 → `NEXT_AUTHORIZED = PHASE3_A_U1_FINAL_R7_CHANGES34_TO37_ONLY`
> 代码 commit（REVIEWED_HEAD）= **9ee36837**（`fullCommit = 9ee3683725ad694123092e5bafce9a32b75d3fd2`）
> 证据：`tools/verification/self-repair/phase3a-u1-final-r7-*` 与 `…-r7-change37-head-binding.json`

**CHANGE 34（P0）并发门闩确定性**（U1-DB9）

- 新增不可伪造的 `entered` 标志与 `enteredAt/leftAt` 区间记录；门闩等待改为 `waitOrFail`：**超时即抛错使测试失败**（不再「超时后继续跑」）；
  包装内另有 `releaseGuard`（15s 未释放即抛错）。
- **释放门闩前**断言 `entered.A && entered.B`，并在**同一重叠窗口内**断言 A/B 句柄序号互异（`new Set(...).size === 2`）；
  完成后断言两事务活动区间确实重叠（`realConcurrentOverlap=true`，证据行内含 A/B 的 enteredAt/leftAt 时间戳）。

**CHANGE 35（P1）PostgreSQL SQLSTATE 25006**（新增 U1-DB12）

- 四个写入探针各在**独立只读事务**内执行，先读 `transaction_read_only` 再写入并捕获错误：
  DELETE / CREATE TABLE / UPDATE / INSERT(SELECT … WHERE false) ⇒ 四个 `sqlstate` 均为 **`25006`**，
  且四个探针的 `readOnly` 均为 `on`（证明拒绝发生在被测只读事务内）。
- SQLSTATE 提取方式：优先 Prisma `error.meta.code`，回退到错误消息正则 `Code: (\d{5})`（代码与证据行均落盘）。

**CHANGE 36（P1）异步生命周期确定性**

- U1-DB10：改为断言**真实事务开启次数** `transactionsOpenedAtDb === 1`（统计 `$transaction` 调用次数，每次 = 一次真实 BEGIN/COMMIT）；
  `pg_stat_database` 计数仅作补充记录（其刷新有延迟，故不作断言，已在证据行注明）。
- U1-DB11：用**显式事务结束信号**（`transactionEnded` Promise，在 `withReadOnlyTransaction` 返回后才释放）取代 `setTimeout(60)`。

**CHANGE 37（P1）HEAD 绑定清单**（机器可核对）

- `change37-head-binding.json` 含：`fullCommit`（40 位）、`branch`、源/测试/原始 vitest/tsc/负对照原始输出与负对照实现的 **SHA256**、
  本次运行的退出码与摘要（`65 passed (65)` / `2 passed (2)` / vitest 0 / tsc 0）、负对照执行结果与预期失败断言、指纹复算说明。

**负向对照（本轮更强）**：把端口还原为 CHANGE 32 之前的实例级共享实现后，**两个**用例失败：
`U1-DB9`（句柄被复用）与 **`U1-DB11`（失效句柄静默回落裸 client、未抛错）** ⇒
新实现的「拒绝而非回落」安全目标得到可执行证明。

```text
PHASE3_U1_FINAL_R7_CODE_COMMIT = 9ee36837（full 9ee3683725ad694123092e5bafce9a32b75d3fd2）
PHASE3_U1_FINAL_R7_TESTS = 端口级 53 + 真实 PG 12 = 65/65 PASS；api tsc 0
CHANGE34_REAL_CONCURRENT_OVERLAP = PASS（entered 断言 + 超时即失败 + 重叠窗口内句柄互异 + 区间重叠）
CHANGE35_PG_25006_ASSERTION = PASS（四探针 SQLSTATE 均 25006，且均在只读事务内）
CHANGE36_ASYNC_LIFECYCLE_DETERMINISTIC = PASS（$transaction 计数=1；显式事务结束信号）
CHANGE37_HEAD_BINDING = tools/verification/self-repair/phase3a-u1-final-r7-change37-head-binding.json
PHASE3_U1_IMPLEMENTATION_CLOSED = NO（等待 MSG-20261009-22）
NEXT_UNIT = 送审 MSG-20261009-22（内联 CHANGE 34–37 关键片段与清单）
NEXT_AUDIT = MSG-20261009-22
PHASE3_A_U2_TO_U5_AUTHORIZED = NO
EXTERNAL_WRITE = HOLD
AUTO_MERGE / AUTO_DEPLOY = FORBIDDEN
PRODUCTION_READY = NO
```

---

### 2.26 MSG-20261009-22 裁决归档 = **PASS WITH REVISE**（CHANGE 34–36 通过，CHANGE 37 → CHANGE 38）

> 裁决来源：右侧独立审计会话（MSG-20261009-22 送审 → 本轮裁决）
> 逐字归档：`AI-ARCHITECT-INBOX.md`（段落 `### [MSG-20261009-22] …`），
> `tools/verdict-diff/compare.mjs` = **FULL_COPY_OK（151/151，缺失 0，多出 0）**；
> 规范化指纹（去 CRLF、逐行 trim、去空行、FNV1A over UTF-8）= `NORM_CHARS=4241 / NORM_LINES=151 / FNV=ecca2518`。
> `REVIEWED_HEAD = 9ee36837`（full `9ee3683725ad694123092e5bafce9a32b75d3fd2`）。

**七项门禁裁决**

| 门禁 | 裁决 |
| --- | --- |
| CHANGE34_REAL_CONCURRENT_OVERLAP | PASS_SCOPED |
| CHANGE35_PG_25006_ASSERTION | PASS_SCOPED |
| CHANGE36_ASYNC_LIFECYCLE_DETERMINISTIC | PASS_SCOPED |
| CHANGE37_HEAD_BINDING | REVISE |
| U1_READ_ONLY_BOUNDARY_PRESERVED | PASS_SCOPED |
| SCOPE_HONESTY | PASS |
| PHASE3_U1_IMPLEMENTATION_CLOSED | NO |

- 评审方明确指出：**CHANGE 34、35、36 不再要求技术修改**（本轮证据已形成较完整技术闭环）；
  关闭阻断已从「核心测试逻辑」转移到「证据来源与 HEAD 绑定」层面。
- `PASS_SCOPED` 的定义（原文）：所提交的内联材料满足该项具体技术断言，但不等同于对
  GitHub 源文件与测试执行环境的独立认证。评审方本轮尝试用 GitHub 连接器检索仓库，
  返回的可访问仓库列表为空 —— 因此**不能**声称已独立读取固定 commit 或独立重跑测试。

**评审方提出的两处技术限定（须如实保留）**

1. CHANGE 34 的时间戳证明的是「应用侧记录的事务活动区间重叠」，不是独立 PostgreSQL 会话日志
   证明的物理执行重叠；对 CHANGE 34 设定的门闩目标足够，但不得外推。
2. CHANGE 36 的 `transactionsOpenedAtDb` 应准确表述为「真实 Prisma 事务入口调用次数」，
   **不是**数据库服务器独立测量的 BEGIN 次数。

**唯一后续事项：CHANGE 38（P1）HEAD 绑定与原始输出的独立可核验性**

在 MSG-20261009-23 中提供以下最小材料（不要求改产品代码、不要求重做 U1）：

1. 固定 `9ee36837` 的 `git rev-parse HEAD` 与 `git status --porcelain` 原始输出；
2. 七份文件的 `git show 9ee36837:<path>` 字节哈希复算结果，逐项 `MATCH=true`；
3. `git diff 23604dcb 9ee36837 -- apps/api/src/services/self-repair/trusted-facts-adapter.ts`，
   证明产品代码未变化；
4. 正向测试、负向对照、TypeScript 检查的实际命令、退出码与原始输出摘要，并标明与固定 HEAD 的关联。

评审方并指出：`tsc-raw.txt` 的 SHA-256 是标准空文件摘要，只能说明该文件为空，
需附**对应执行记录**才能与 `TSC_EXIT=0` 关联。若 GitHub 可访问性仍未解决，可继续完整内联交付，
但必须明确「内联证据审查」与「独立仓库核验」是不同级别的认证。

```text
MSG-20261009-22_FINAL_VERDICT = PASS_WITH_REVISE
MSG-20261009-22_ARCHIVED = AI-ARCHITECT-INBOX.md（FULL_COPY_OK 151/151；FNV1A ecca2518）
REVIEWED_HEAD = 9ee36837（full 9ee3683725ad694123092e5bafce9a32b75d3fd2）
CHANGE34_REAL_CONCURRENT_OVERLAP = PASS_SCOPED（无需技术修改）
CHANGE35_PG_25006_ASSERTION = PASS_SCOPED（无需技术修改）
CHANGE36_ASYNC_LIFECYCLE_DETERMINISTIC = PASS_SCOPED（无需技术修改）
CHANGE37_HEAD_BINDING = REVISE
U1_READ_ONLY_BOUNDARY_PRESERVED = PASS_SCOPED
SCOPE_HONESTY = PASS
PHASE3_U1_IMPLEMENTATION_CLOSED = NO
PHASE3_A_U2_TO_U5_AUTHORIZED = NO
REQUIRED_CHANGES = CHANGE_38_P1_HEAD_BINDING_INDEPENDENT_VERIFICATION
NEXT_AUTHORIZED = PHASE3_A_U1_FINAL_R8_CHANGE38_EVIDENCE_ONLY
NEXT_AUDIT = MSG-20261009-23
REPOSITORY_INDEPENDENTLY_VERIFIED = NO
TEST_OUTPUT_INDEPENDENTLY_VERIFIED = NO
PRODUCT_CODE_CHANGE_AUTHORIZED = NO
EXTERNAL_WRITE = HOLD
AUTO_MERGE / AUTO_DEPLOY = FORBIDDEN
PRODUCTION_READY = NO
```

---

### 2.27 MSG-20261009-23 裁决归档 = **PASS WITH REVISE**（CHANGE 38 内联层面通过；独立核验仍未取得）

> 逐字归档：`AI-ARCHITECT-INBOX.md`（段落 `### [MSG-20261009-23] …`），
> `tools/verdict-diff/compare.mjs` = **FULL_COPY_OK（102/102，缺失 0，多出 0）**；
> 规范化指纹 = `NORM_CHARS=3162 / NORM_LINES=102 / FNV=7be03090`。
> 审计锚点：`REVIEWED_HEAD=9ee36837`、`EVIDENCE_HEAD=aa730476`、`HEAD_AFTER_EVIDENCE=23584224`。

**本轮正式裁决**

```text
CHANGE38_INLINE_EVIDENCE_ACCEPTED = YES
CHANGE38_INDEPENDENT_REPOSITORY_VERIFIED = NO
PHASE3_U1_IMPLEMENTATION_CLOSED = NO
PHASE3_A_U2_TO_U5_AUTHORIZED = NO
本轮不要求修改产品代码。
```

**八项逐项**：`HEAD_BINDING_RAW_OUTPUTS / FILE_SHA256_MATCH_ALL / PRODUCT_CODE_UNCHANGED_DIFF /
RUN_COMMANDS_EXITCODES / U1_READ_ONLY_BOUNDARY_PRESERVED` = PASS_SCOPED；
`SELF_CORRECTION_R7_LABELLING` = PASS；`SCOPE_HONESTY` = PASS；`PHASE3_U1_IMPLEMENTATION_CLOSED` = NO。
`PASS_SCOPED` 表示「依据当前内联材料审查通过，不表示独立复现通过」。

**评审方接受的两点**

1. 双 HEAD 绑定修正合理：产品/测试文件绑定 `9ee36837`、证据产物绑定 `aa730476`，
   解决了 R7 中「部分文件并不存在于指定提交」的问题，且不构成产品代码变更；
2. R7 自我更正被接受（此前四个证据路径不存在于 `9ee36837` 的结论不得再作为有效证据）。

**评审方提出的两点限定**

- 正负对照（65/65 PASS；负向 63/65、DB9 与 DB11 失败；tsc 退出码 0；恢复后指纹一致）
  「如果从固定提交与原始输出中独立核实，将为 U1 提供有力的回归证据。目前仅确认其报告内容逻辑一致。」
- 送审 A 节以「6 个新证据文件」概括 Git 文件列表，「不是完整逐字原始输出；正式核验必须使用完整文件路径」。
  ⇒ 下一轮必须逐条列出 9 个文件的完整路径，不再使用概括写法。

**唯一剩余门禁：CHANGE 39（P1）独立复核证据闭环**

- 提供**可被审计方读取**的 Git 仓库地址（owner/repo）及固定提交访问权限，
  或提供**包含 Git 对象的可核验离线归档**；
- 独立确认三个 HEAD 实际存在，核实九个文件的提交归属、字节长度与 SHA-256；
- 独立核对 `9ee36837..23584224` 的代码差异，以及 `23604dcb..9ee36837` 的指定产品文件差异；
- 核对运行记录中的完整命令、退出码、原始输出、负向对照及恢复后文件指纹；
- 如全部通过，**下一轮允许直接申请 U1 FINAL CLOSURE**，无需重复 CHANGE 34–38，也无需重做已通过的功能测试。

**通道事实（本机观测）**：审计侧 GitHub 连接器仍无法列出/读取该私有仓库；
此前 `MSG-20261009-20` 的「REVISE — EVIDENCE NOT VERIFIED」与本轮 `INDEPENDENT_REPOSITORY_VERIFIED=NO`
同源。审计方在裁决中明确「本次未修改、提交或写入任何仓库文件」。

```text
MSG-20261009-23_FINAL_VERDICT = PASS_WITH_REVISE（AUDIT_LEVEL=INLINE_EVIDENCE_REVIEW）
MSG-20261009-23_ARCHIVED = AI-ARCHITECT-INBOX.md（FULL_COPY_OK 102/102；FNV1A 7be03090）
REVIEWED_HEAD = 9ee36837
EVIDENCE_HEAD = aa730476
HEAD_AFTER_EVIDENCE = 23584224
CHANGE38_SELF_CORRECTION_R7_LABELLING = PASS
SCOPE_HONESTY = PASS
CHANGE38_INDEPENDENT_REPOSITORY_VERIFIED = NO
PHASE3_U1_IMPLEMENTATION_CLOSED = NO
PHASE3_A_U2_TO_U5_AUTHORIZED = NO
REQUIRED_CHANGES = CHANGE39_P1_INDEPENDENT_EVIDENCE_VERIFICATION
PRODUCT_CODE_CHANGES_REQUIRED = NO
U1_REIMPLEMENTATION_REQUIRED = NO
NEXT_AUTHORIZED = PHASE3_A_U1_CHANGE39_EVIDENCE_VERIFICATION_ONLY
NEXT_AUDIT = MSG-20261009-24
EXTERNAL_WRITE = HOLD
AUTO_MERGE / AUTO_DEPLOY = FORBIDDEN
PRODUCTION_READY = NO
```

**待用户决定（HOST_ACTION_REQUIRED）**：CHANGE 39 要求「审计方可读取的仓库地址 + 固定提交访问权限」。
该私有仓库若保持私有，审计侧连接器无法读取；把它改为公开属于仓库可见性变更（超出当前授权边界，需用户决定）。
备选：把包含 Git 对象的可核验离线归档（对象字节 + `git hash-object` 复算）作为会话附件交付给审计方复核。

---

### 2.28 MSG-20261009-24 裁决归档 = **PASS — CHANGE 39 CLOSED**（首次独立仓库核验通过）

> 逐字归档：`AI-ARCHITECT-INBOX.md`（段落 `### [MSG-20261009-24] …`），
> `tools/verdict-diff/compare.mjs` = **FULL_COPY_OK（155/155，缺失 0，多出 0）**；
> 规范化指纹 = `NORM_CHARS=3512 / NORM_LINES=155 / FNV=7e261bb0`。
> 本轮送审 HEAD（未改动产品代码）：`7dc317eb`。

**通道变化**：审计侧的 GitHub 连接器已可直接读取 `anthonannabella-dev/crossclaim-ai`。
因此 CHANGE 39 的「独立仓库访问」障碍解除，本轮**未**传输源码字节（不需要离线归档）。

**审计方独立完成的核验（非照抄送审值）**

| 项目 | 结果 |
| --- | --- |
| 五个指定提交是否实际存在（BASE/REVIEWED/EVIDENCE/MANIFEST/CURRENT） | 全部存在 |
| `23604dcb → 9ee36837` | 前进 6 个提交 |
| `9ee36837 → 23584224` | 前进 4 个提交 |
| `9ee36837 → 23584224` 差异是否含 `apps/api` | 不含（符合产品代码未变） |
| `23604dcb → 9ee36837` 差异是否含 `trusted-facts-adapter.ts` | 不含（符合适配器未变） |
| 九个文件的提交归属 / git blob SHA-1 / 字节长度 / SHA-256 | **9/9 PASS**（用 GitHub 返回的 Base64 原文自行解码并独立计算 SHA-256） |

**运行证据核验（基于仓库内已归档原始日志）**：正向 `65 passed / 2 files passed`（PASS）；
负向 `2 failed / 63 passed`，失败用例正是 `U1-DB9`（事务句柄隔离断言）与 `U1-DB11`
（事务结束后 fail-closed 断言）（PASS）；tsc 0 字节输出、exit 0 有记录；隔离库
`127.0.0.1:55432/crossclaim_p3r2_iso`；原字节恢复与工作树 clean 均有记录。

**审计方明确写下的证据边界**：「我独立验证了已归档日志的字节指纹与内容，但没有在自己的
PostgreSQL 环境中重新运行测试，也不能由 GitHub 历史文件证明当前本机工作树仍然 clean。
因此这里的 RUN_RECORD_VERIFIED 指原始记录的真实性和内部一致性，不等同于重新执行验收。」
（`INDEPENDENT_TEST_RERUN=NO`）

**八项正式裁决**：`CHANGE39_REPOSITORY_ACCESS_AVAILABLE=YES`、
`CHANGE39_HEAD_EXISTENCE_VERIFIED=YES`、`CHANGE39_FILE_ATTRIBUTION_SIZE_SHA256_VERIFIED=YES`
（`CHANGE39_FILE_COUNT_VERIFIED=9/9`）、`CHANGE39_DIFF_VERIFIED=YES`、
`CHANGE39_RUN_RECORD_VERIFIED=YES_ARCHIVED_RECORD`、`U1_READ_ONLY_BOUNDARY_PRESERVED=PASS_SCOPED`、
`SCOPE_HONESTY=PASS`、`PHASE3_U1_IMPLEMENTATION_CLOSED=NO · FINAL_CLOSURE_PENDING`。

**最终结论**：`FINAL_VERDICT=PASS`、`CHANGE39_CLOSED=YES`、
`INDEPENDENT_REPOSITORY_VERIFIED=YES`、`U1_FINAL_CLOSURE_REVIEW_AUTHORIZED=YES`、
`REQUIRED_CHANGES=NONE_FOR_CHANGE39`。按上一轮约定，下一轮**直接提交 MSG-20261009-25 申请
U1 FINAL CLOSURE**，无需重复上传九个大文件（除非 HEAD 或证据变化）。

```text
MSG-20261009-24_FINAL_VERDICT = PASS
MSG-20261009-24_ARCHIVED = AI-ARCHITECT-INBOX.md（FULL_COPY_OK 155/155；FNV1A 7e261bb0）
CHANGE39_CLOSED = YES
REQUIRED_CHANGES = NONE_FOR_CHANGE39
INDEPENDENT_REPOSITORY_VERIFIED = YES
INDEPENDENT_TEST_RERUN = NO
U1_FINAL_CLOSURE_REVIEW_AUTHORIZED = YES
PHASE3_U1_IMPLEMENTATION_CLOSED = NO（FINAL_CLOSURE_PENDING）
PHASE3_A_U2_TO_U5_AUTHORIZED = NO
NEXT_AUTHORIZED = PHASE3_A_U1_FINAL_CLOSURE_REQUEST_ONLY
NEXT_AUDIT = MSG-20261009-25
EXTERNAL_WRITE = HOLD
AUTO_MERGE / AUTO_DEPLOY = FORBIDDEN
PRODUCTION_READY = NO
```

---

### 2.29 MSG-20261009-25 裁决归档 = **U1 FINAL CLOSURE = YES —— PHASE 3-A U1 正式 CLOSED**

> 逐字归档：`AI-ARCHITECT-INBOX.md`（段落 `### [MSG-20261009-25] …`，外层用 4 反引号围栏以容纳裁决内的 ```ini 块），
> `tools/verdict-diff/compare.mjs` = **FULL_COPY_OK（137/137，缺失 0，多出 0）**；
> 规范化指纹 = `NORM_CHARS=3548 / NORM_LINES=137 / FNV=5bcb6f32`。
> 关闭锚点：`U1_CODE_HEAD = 9ee36837`、`CURRENT_HEAD = c9437e0d`。

**正式裁决**

```text
FINAL_VERDICT = PASS
U1_FINAL_CLOSURE = YES（PHASE 3-A U1 只读可信事实适配器正式关闭）
REQUIRED_CHANGES = NONE_FOR_U1（CHANGE 17–39 不再构成关闭阻断项）
INDEPENDENT_REPOSITORY_VERIFIED = YES
INDEPENDENT_TEST_RERUN = NO
U1_READ_ONLY_BOUNDARY_FINAL = PASS_SCOPED
U1_TEST_EVIDENCE_FINAL = PASS_ARCHIVED_EVIDENCE
U1_ARCHIVE_COMPLETENESS_FINAL = PASS_SCOPED
SCOPE_HONESTY = PASS
PHASE3_A_U2_TO_U5_AUTHORIZED = NO
U2_IMPLEMENTATION_AUTHORIZED = NO
U3_TO_U5_IMPLEMENTATION_AUTHORIZED = NO
NEXT_AUTHORIZED = PHASE3_A_U2_DESIGN_READ_ONLY_AND_IMPLEMENTATION_PREPARATION_ONLY
NEXT_AUDIT = MSG-20261009-26
```

**审计方独立复核（GitHub 直读）**：`U1_CODE_HEAD`/`CURRENT_HEAD` 均存在；
`9ee36837 → c9437e0d` 前进 7 个提交、涉及 16 个文件；**`apps/api` 变化 0 个**
⇒ 「U1 产品代码自 `9ee36837` 后保持不变」成立，本轮关闭申请未引入新的产品/测试改动。

**评审方保留的三点限定（不得外推）**

1. 这是「基于固定代码版本与既有测试证据的最终关闭裁决」，**不是**独立重新执行 PostgreSQL 测试，
   也**不是**整个 SI/RSI 自主代码修复系统的完成验收；
2. `PASS_SCOPED` 的只读边界「不构成对所有数据库访问路径的全局只读保证」；
3. `FULL_COPY_OK 155/155` 与 `FNV1A 7e261bb0` 属仓库记录，评审方本轮**未再次独立执行** `compare.mjs`，
   因此「归档完整性在本次指定范围内通过，不声明全部历史裁决已逐字重新计算」。

**U2 启动条件（评审方原文要点）**：仅授权 PHASE 3-A U2 的**只读设计与实施准备**——
固定 U1 关闭锚点且不得隐式修改 U1 可信事实契约；提交 U2 功能定义、输入输出契约、调用关系与
数据权限矩阵；明确是否新增持久化/数据库写入/Runtime 接线/模型调用（无证据不得声称具备）；
列出确定性验收用例、失败关闭路径、负向对照与证据归档方案；如涉及代码写入/自动生成补丁/执行测试，
必须限定隔离环境、受控候选分支与人类审批边界。**U2 设计通过独立评审后**才允许授权其最小安全实施单元，
且不得据此自动启动 U3–U5。

```text
MSG-20261009-25_FINAL_VERDICT = PASS
MSG-20261009-25_ARCHIVED = AI-ARCHITECT-INBOX.md（FULL_COPY_OK 137/137；FNV1A 5bcb6f32）
U1_STATUS = CLOSED（PHASE 3-A U1，封板于 U1_CODE_HEAD=9ee36837）
NEXT_AUTHORIZED = PHASE3_A_U2_DESIGN_READ_ONLY_AND_IMPLEMENTATION_PREPARATION_ONLY
U2_IMPLEMENTATION_AUTHORIZED = NO
U3_TO_U5_IMPLEMENTATION_AUTHORIZED = NO
NEXT_AUDIT = MSG-20261009-26（须提交 U2 设计与最小实施边界审计，而非 U2 实施验收）
EXTERNAL_WRITE = HOLD
AUTO_MERGE / AUTO_DEPLOY = FORBIDDEN
PRODUCTION_READY = NO
```

---

### 2.30 MSG-20261009-26 裁决归档 = **REVISE**（U2 设计 4 项契约缺口，未批准实施）

> 逐字归档：`AI-ARCHITECT-INBOX.md`（段落 `### [MSG-20261009-26] …`），
> `tools/verdict-diff/compare.mjs` = **FULL_COPY_OK（138/138，缺失 0，多出 0）**；
> 规范化指纹 = `NORM_CHARS=4313 / NORM_LINES=138 / FNV=c6e0ab64`。
> 送审锚点：`U1_CODE_HEAD=9ee36837`、`U2_DESIGN_COMMIT=065f950e`。

**九项裁决**：`U2_DESIGN_SCOPE_AND_NON_GOALS=PASS`、`U2_CALL_GRAPH_AND_NO_RUNTIME_WIRING=PASS`、
`SCOPE_HONESTY=PASS`、`U2_FOUR_DECLARATIONS_HONESTY=PASS_WITH_REVISE`；
`U2_INPUT_OUTPUT_CONTRACT=REVISE`、`U2_DEDUPE_AND_IDENTITY_VERSION_RULES=REVISE`、
`U2_ACCEPTANCE_MATRIX_AND_FAIL_CLOSED=REVISE`、`U2_IMPLEMENTATION_BOUNDARY=REVISE`；
`U2_DESIGN_APPROVED=NO`。

**审计方独立核对的两点**

1. `9ee36837 → 065f950e` 的 9 个提交**不含 `apps/api` 产品代码变更** ⇒ 未修改 U1（与送审一致）；
2. 文档自报的 sha256 `739cb312…2792` 本轮**未获独立原始字节复算** ⇒ `U2_DESIGN_DOC_SHA256_VERIFIED=NO`
   （不影响上述设计缺口的判断）。

**REQUIRED_CHANGES = CHANGE 1–4（下一轮 MSG-20261009-27 只接受这四项的设计修订）**

- **CHANGE 1（P0）identityVersion 来源与可信性**：实际模型是 `PlatformAccount`（默认 `v1`），**不是**
  `Account`；且 `identityVersion` 是「外部账户身份规范版本」，**不是**凭据版本、**不能**证明授权仍有效。
  要求：身份版本须来自已验证的 `PlatformAccount`；明确
  `organizationId + platform + externalAccountId + identityVersion` 的解析规则；
  **禁止信任调用方字符串**；身份未解析/版本缺失/身份冲突 ⇒ fail-closed。
- **CHANGE 2（P0）候选失效契约自洽**：原设计「旧候选置 `INVALIDATED`」与「禁止 UPDATE 既有候选」冲突，
  且 `AutonomyCandidate` 只有 `status`、没有独立失效事件模型。评审方建议唯一机制 = **逻辑失效**：
  保留旧候选原始记录不变，**重用或消费前重新校验身份版本**，不匹配则返回 `CANDIDATE_INVALIDATED`；
  必须表述为「实时有效性判定」而非「数据库旧候选状态已被更新」；若要持久化失效事件，须**另行设计并审批**。
- **CHANGE 3（P1）关联原子性与回滚**：不得改写既有 `AutonomyTask.incidentId`；缺失 Task 时**建议 `REJECTED`**
  （不新建可执行 Task）；固定 `candidateDigest` 的字段来源/序列化/哈希算法（**证据摘要，不虚构 DB 字段**）；
  采用**事务原子写入** + 唯一约束冲突后的校验复用；回滚改为**停用 U2 服务入口并保留历史**，
  **禁止批量删除已关联候选**。
- **CHANGE 4（P1）并发与负向验收**：新增 U2-7..U2-10，覆盖并发创建同 `dedupeKey`（须安全复用）、
  同 key 但 Task/baseline/身份版本不同（须拒绝而非复用）、事务失败不留半成品关联、
  身份版本切换与候选创建并发（须重验或 fail-closed）；并明确 `factsSnapshotRef` 的可信来源/有效期/过期判断，
  以及 `baselineRef` 必须来自**可信基线**而非调用方任意指定。

**评审方给出的未来最小实施边界（仅在 CHANGE 1–4 通过后申请）**：单一 U2 候选记录服务、使用现有数据模型、
只读取已验证的内部 Incident/Task/身份版本/可信事实、只向 `AutonomyCandidate` 插入新候选（允许按唯一键校验后复用）、
不更改既有 Incident/Task/Candidate/Lease 的状态或关联、仅用隔离 PostgreSQL 验证、**不接入运行时/队列/模型/Provider/执行器/部署**、
**不新增 schema/migration、不做生产迁移**；即使 U2 实施获准，也**不代表**候选可自动进入执行队列。

```text
MSG-20261009-26_FINAL_VERDICT = REVISE
MSG-20261009-26_ARCHIVED = AI-ARCHITECT-INBOX.md（FULL_COPY_OK 138/138；FNV1A c6e0ab64）
U1_FINAL_CLOSURE = YES（保持；封板 9ee36837 未被改动）
U2_DESIGN_APPROVED = NO
U2_IMPLEMENTATION_AUTHORIZED = NO
PHASE3_A_U3_TO_U5_AUTHORIZED = NO
REQUIRED_CHANGES = CHANGE_1_P0_IDENTITY_SOURCE_AND_TRUST ; CHANGE_2_P0_INVALIDATION_CONTRACT ;
                   CHANGE_3_P1_ASSOCIATION_ATOMICITY_AND_ROLLBACK ; CHANGE_4_P1_CONCURRENCY_AND_NEGATIVE_TESTS
NEXT_AUTHORIZED = PHASE3_A_U2_DESIGN_R2_READ_ONLY_CHANGES_1_TO_4
NEXT_AUDIT = MSG-20261009-27
SCHEMA_MIGRATION = HOLD
RUNTIME_WIRING / MODEL_CALL = FORBIDDEN
EXTERNAL_WRITE = HOLD
AUTO_MERGE / AUTO_DEPLOY = FORBIDDEN
PRODUCTION_READY = NO
```

---

### 2.31 MSG-20261009-27 裁决归档 = **REVISE**（U2 设计 R2 方向获认可，新增 CHANGE 5–8）

> 逐字归档：`AI-ARCHITECT-INBOX.md`（段落 `### [MSG-20261009-27] …`），
> `tools/verdict-diff/compare.mjs` = **FULL_COPY_OK（158/158，缺失 0，多出 0）**；
> 规范化指纹 = `NORM_CHARS=4700 / NORM_LINES=158 / FNV=75156997`。
> 锚点：`U1_CODE_HEAD=9ee36837`、`U2_DESIGN_COMMIT_R1=065f950e`、`U2_DESIGN_COMMIT_R2=5ae09e37`。

**审计方独立核验**：R2 文档可读且路径/锚点一致；`065f950e→5ae09e37` 共 2 个提交、3 个文件（全部在文档与审计记录范围）；
`9ee36837→R2` 比较显示 **apps/api 0 变更** ⇒ `PRODUCT_CODE_UNCHANGED_IN_COMPARED_RANGE=YES`。
保留项：`RUNTIME_TESTS_VERIFIED=NO`；`U2_DESIGN_DOC_SHA256_VERIFIED=NO`（GitHub 返回的是 Git blob SHA，
要按原始 UTF-8 字节单独复算）。

**逐项**：`CHANGE1/2/3/4_..._FIXED = PASS_WITH_REVISE`、`U2_IMPLEMENTATION_BOUNDARY=PASS`、`SCOPE_HONESTY=PASS`、
`U2_INPUT_OUTPUT_CONTRACT=REVISE`、`U2_ACCEPTANCE_MATRIX_AND_FAIL_CLOSED=REVISE`、
`U2_DESIGN_APPROVED=NO`、`U2_IMPLEMENTATION_AUTHORIZED=NO`、`PHASE3_A_U3_TO_U5_AUTHORIZED=NO`。

**新增 REQUIRED_CHANGES（下一轮 MSG-20261009-28 仅关闭这四项）**

- **CHANGE 5（P0）当前有效身份版本与并发**：`@@unique([organizationId, platform, externalAccountId, identityVersion])`
  **允许同一账户同时存在 v1 与 v2**，故不能凭该约束证明「哪个版本当前有效」。须定义：① 当前有效版本的
  **可信选择规则**（不得采用调用方传入的版本）；② 多版本并存的处理方式（**无法唯一确定当前版本必须拒绝**）；
  ③ 版本选择与候选 INSERT 之间的**并发一致性边界**；④ U2-10 须证明**旧版本在身份切换完成后不会被重新确认为有效**，
  而不只是证明两个候选没有重复。
- **CHANGE 6（P0）可信事实引用的不可伪造性**：`factsSnapshotRef.source='U1_TRUSTED_FACTS_ADAPTER'` 只是**声明**，
  任意调用者可构造同结构伪造。须补：服务端内部**不可伪造的签发与解析路径**（或可信持久化引用）；
  引用与 `Incident` / `Task` / 租户 / 事实范围的**绑定**；**有效期与防重放**判定；对**伪造 / 跨租户 / 已过期**引用的
  负向验收。**不得通过修改 U1 封板契约解决**，应在 U2 侧复用既有可信能力或单独设计。
- **CHANGE 7（P0）租户隔离与关联完整性**：`Incident → Candidate → Task` 是**间接关系**
  （`AutonomyCandidate.taskId → AutonomyTask.incidentId → AutonomyIncident.id`），候选键
  `candidate:<signalKey>#<identityVersion>#<baselineRef>` 需证明：`signalKey` 是否已含**可信租户与账户作用域**；
  跨租户相同 `signalKey` 是否可能 dedupe 冲突；`Task`/`Incident`/`PlatformAccount` 是否确属**同一可信作用域**；
  复用候选时是否比对 `taskId`、`baselineRef`、解析身份与关联链；冲突校验失败是否**严格 `REJECTED`**
  而非返回其他租户的 `candidateId`。**不得默认 signalKey 全局唯一就等于租户隔离**。
- **CHANGE 8（P1）验收矩阵与摘要规范化**：① U2-5 与 U2-7 语义冲突须区分「U2 **自身允许的独立原子数据库事务** /
  **不得跨越 U1 只读事务边界写入** / 不得未授权外部副作用」；② U2-8 因键内已含 `baselineRef`+`identityVersion`，
  须重定义为「**输入键与可信解析字段不一致**或**恶意冲突**」并补断言；③ `candidateDigest` 须固定
  **字段顺序、时间精度、Unicode 序列化规则与固定测试向量**，保证跨环境可独立复算。

**审计方认可的设计成果（保持）**：使用既有 `AutonomyCandidate` 不扩展 schema；仅 INSERT 候选、不改写既有 Task/Incident；
失效语义限定为实时逻辑判定；唯一冲突必须经关联校验才复用；保留旧记录、禁止批量删除回滚；
不新增第二套 Runtime/Scheduler/Controller；不开放模型调用/外写/自动合并/部署。

```text
MSG-20261009-27_FINAL_VERDICT = REVISE
MSG-20261009-27_ARCHIVED = AI-ARCHITECT-INBOX.md（FULL_COPY_OK 158/158；FNV1A 75156997）
U1_FINAL_CLOSURE = YES（保持；9ee36837 未被改动）
U2_DESIGN_APPROVED = NO
U2_IMPLEMENTATION_AUTHORIZED = NO
PHASE3_A_U3_TO_U5_AUTHORIZED = NO
REQUIRED_CHANGES = CHANGE_5_P0_CURRENT_IDENTITY_VERSION_AND_CONCURRENCY ;
                   CHANGE_6_P0_TRUSTED_FACT_REFERENCE_PROVENANCE ;
                   CHANGE_7_P0_TENANT_SCOPE_AND_ASSOCIATION_INTEGRITY ;
                   CHANGE_8_P1_ACCEPTANCE_MATRIX_AND_DIGEST_CANONICALIZATION
NEXT_AUTHORIZED = PHASE3_A_U2_DESIGN_R3_READ_ONLY_CHANGES_5_TO_8
NEXT_AUDIT = MSG-20261009-28
RUNTIME_TESTS_VERIFIED = NO
SCHEMA_MIGRATION = HOLD
RUNTIME_WIRING / MODEL_CALL = FORBIDDEN
EXTERNAL_WRITE = HOLD
AUTO_MERGE / AUTO_DEPLOY = FORBIDDEN
PRODUCTION_READY = NO
```

---

### 2.32 MSG-20261009-28 裁决归档 = **REVISE**（U2 设计 R3 方向正确，新增 CHANGE 9–12）

> 逐字归档：`AI-ARCHITECT-INBOX.md`（段落 `### [MSG-20261009-28] …`），
> `tools/verdict-diff/compare.mjs` = **FULL_COPY_OK（172/172，缺失 0，多出 0）**；
> 规范化指纹 = `NORM_CHARS=5088 / NORM_LINES=172 / FNV=de5c9133`。
> 锚点：`U1_CODE_HEAD=9ee36837`（继续封板）、`U2_DESIGN_COMMIT_R2=5ae09e37`、`U2_DESIGN_COMMIT_R3=ac94ef8e`。

**十项**：`CHANGE5/6/7/8 = REVISE`、`U2_INPUT_OUTPUT_CONTRACT=REVISE`、
`U2_ACCEPTANCE_MATRIX_AND_FAIL_CLOSED=PASS_WITH_REVISE`、`U2_IMPLEMENTATION_BOUNDARY=PASS`、
`SCOPE_HONESTY=PASS_WITH_NOTE`、`U2_DESIGN_APPROVED=NO`、`U2_IMPLEMENTATION_AUTHORIZED=NO`、`U3–U5=NO`。

**REQUIRED_CHANGES（下一轮 MSG-20261009-29 仅关闭这四项）**

- **CHANGE 9（P0）候选去重键缺少故障身份**：R3 §11.4 的
  `candidate:<scopeKind>:<scopeRef>#<identityVersion|NONE>#<baselineRef>` 在「两个不同 Incident、同 PLATFORM、
  同 `baselineRef`」下**必然碰撞**（例：`CI_FAIL:abc:100` 与 `CI_FAIL:abc:200` 得到同一 `candidateDedupeKey`），
  在 `dedupeKey` 唯一约束下会导致第二个故障无法建候选或错误复用。修复：键改为
  `candidate:v2:<scopeKind>:<encodedScopeRef>:<encodedSignalKey>:<identityVersion|NONE>:<encodedBaselineRef>`；
  **signalKey 必须从已读取且验证的 Incident 派生**（不信任调用方字符串）；所有可变长字段用**无歧义编码/长度前缀**
  防分隔符碰撞；新增「不同 Incident 不碰撞」与「同 Incident 重放只留一个」测试。
- **CHANGE 10（P0）U1 契约与 PLATFORM 事实不匹配**：U1 的 `internal.repair.propose` 策略要求
  `platformAccountId`+`provider`（组织/账户授权语义），**不能**自动解释为 PLATFORM 内部故障事实；
  U1 现有输出也未证明含 U2 可校验的 Incident/Task 关联事实。修复：给出 U1 实际输入/输出与 U2 消费字段的
  **逐字段映射**；为 PLATFORM 内部故障明确**独立可信事实来源**；做不到时必须返回
  `REJECTED / TRUSTED_FACTS_CONTRACT_UNSUPPORTED`；**禁止**用虚构 `issuedAt`/`factsSnapshotRef`/组织身份补齐；
  **禁止**绕过 U1 调用方白名单与作用域策略；如需扩展 U1 契约须**单独送审**。
- **CHANGE 11（P0）当前身份版本仍缺可信裁决状态**：`VerifiedPlatformIdentity.identityVersion` 是**可选**字段，
  该结构只证明「一次验证结果」，不证明① 哪个版本当前有效 ② 旧版本是否撤销 ③ 两次验证谁优先 ④ 是否版本回退；
  且 PostgreSQL `READ COMMITTED` 下同事务二次读**不能**阻止之后提交的版本变更。修复：明确当前性裁决的
  可信来源/优先级/冲突拒绝规则；明确版本切换与候选 INSERT 的**锁或串行化机制**；覆盖「第二次读取之后、
  INSERT 提交之前」的竞争；无法保证串行化时**拒绝创建或复用 ACCOUNT 候选**；缺失/过期/冲突一律 fail-closed；
  **本项不授权新增身份管理表或迁移**。R4 可将 ACCOUNT 明确标为 `NOT_AUTHORIZED`，只保留 PLATFORM 设计。
- **CHANGE 12（P1）digest 与验收规范尚未成为可复算契约**：① 测试向量仍是占位符
  （`SEAL_COMMIT`/`factsDigest`/`candidateDigest` 待填）；② **U2-13 断言与规范相反**——键序/无意义空白/
  等价时间表示经正确规范化后应得到**相同** digest，只有规范化后的**语义字段**变化才应不同；
  ③ `factsDigest` 计算规范缺失（白名单字段、字段类型、数组排序、空值处理、时间规范、脱敏规则、摘要版本）。
  修复：R4 给出**完整十六进制 SHA-256 测试向量**，并用**至少两种独立实现交叉复算**。

**审计方附带更正**：`R2 5ae09e37 → R3 ac94ef8e` 实际包含 **2 个提交、3 个文档文件**
（不是「仅 1 个设计文件」）；变更清单未列 `apps/api`，但审计方注明这不等于本地完整代码树的独立一致性检查。

```text
MSG-20261009-28_FINAL_VERDICT = REVISE
MSG-20261009-28_ARCHIVED = AI-ARCHITECT-INBOX.md（FULL_COPY_OK 172/172；FNV1A de5c9133）
U1_FINAL_CLOSURE = YES（保持；9ee36837 继续封板）
U2_DESIGN_APPROVED = NO
U2_IMPLEMENTATION_AUTHORIZED = NO
PHASE3_A_U3_TO_U5_AUTHORIZED = NO
REQUIRED_CHANGES = CHANGE_9_P0_CANDIDATE_KEY_COLLISION ; CHANGE_10_P0_U1_PLATFORM_FACT_CONTRACT ;
                   CHANGE_11_P0_IDENTITY_VERSION_CURRENTNESS_AND_SERIALIZATION ;
                   CHANGE_12_P1_DIGEST_VECTOR_AND_EQUIVALENCE
NEXT_AUTHORIZED = PHASE3_A_U2_DESIGN_R4_READ_ONLY_CHANGES_9_TO_12
NEXT_AUDIT = MSG-20261009-29
（四项关闭后）可复审 U2_PLATFORM_ONLY_INSERT_SUBSET 最小实施单元
SCHEMA_MIGRATION = HOLD · RUNTIME_WIRING / MODEL_CALL = FORBIDDEN
EXTERNAL_WRITE = HOLD · AUTO_MERGE / AUTO_DEPLOY = FORBIDDEN · PRODUCTION_READY = NO
```

---

### 2.33 MSG-20261009-29 裁决归档 = **PASS WITH REVISE —— U2 设计（PLATFORM-only）首获条件性认可**

> 逐字归档：`AI-ARCHITECT-INBOX.md`（段落 `### [MSG-20261009-29] …`），
> `tools/verdict-diff/compare.mjs` = **FULL_COPY_OK（139/139，缺失 0，多出 0）**；
> 规范化指纹 = `NORM_CHARS=4819 / NORM_LINES=139 / FNV=e4ab17ad`。
> 锚点：`U1_CODE_HEAD=9ee36837`、`U2_DESIGN_COMMIT_R3=ac94ef8e`、`REVIEWED_HEAD=378bfb2a`。

**里程碑**：`U2_DESIGN_APPROVED = YES_SCOPED_WITH_CONDITIONS`（PLATFORM-only 核心设计获得条件性认可），
`CHANGE 9–11 = PASS`、`CHANGE 12 = PASS WITH CONDITION`；但 `U2_IMPLEMENTATION_AUTHORIZED = NO`。

**审计方独立核验**：R3→R4 为**两次提交、三个文档文件**、**无产品代码变更**；
`9ee36837 → R4` 比较**未发现 `apps/api` 修改**；ACCOUNT 被明确排除，U1 客户授权事实不再被误用为平台内部故障事实。

**审计方保留的两点（不得外推）**

1. `candidateDigest` **不能代替**候选身份键——digest 是证据摘要，候选唯一性仍须由数据库 `dedupeKey` 约束保证；
2. 文档声称的「Node.js / .NET 双实现一致」属**提交方证据**，审计方确认该声明存在于仓库但**未记为独立复算通过**；
   `U2_DESIGN_DOC_SHA256_INDEPENDENTLY_VERIFIED=NO`。

**REQUIRED_CHANGES（下一轮 MSG-20261009-30 只做这三项最小收口；不重做 U2、不改 U1）**

- **CHANGE 13（P1）统一最终输入输出契约**：§2 仍留有 R2 的强制 `identity`/`factsSnapshotRef`/`incidentDedupeKey`，
  与 §12 冲突；须在 **§13** 明确 R4 **唯一有效**的 `U2PlatformCandidateInput` 与 `U2CandidateDecision`：
  PLATFORM 作用域由**服务端确认**（不接受 ACCOUNT 身份混入）；`signalKey`/`baselineRef`/`faultClass`/时间的
  **权威读取路径**；ACCOUNT 与 U1 事实字段同时出现或其他错误时的**拒绝优先级**；错误时
  `candidateId=null`、`executionAuthorized=false`，**不暴露其他候选信息**。
  并按 Prisma 核对结果明确 `AutonomyCandidate` 必填字段（`builderRef`/`taskId`/`baselineRef`/`dedupeKey`）都必须提供，
  其中 **`builderRef` 必须有固定可信取值与来源，不得由调用方或模型任意填写**。
- **CHANGE 14（P1）统一验收矩阵**：§7 旧用例（ACCOUNT 身份版本切换、U1 快照过期等）与 R4 冲突；
  须新增最终矩阵，对 **U2-1…U2-17 逐一标注 `ACTIVE` / `SUPERSEDED` / `NOT_AUTHORIZED`**；
  并明确：Task 必须与 Incident 建立**真实外键链**（不只是比较 `taskDedupeKey` 字符串）；
  读取到不一致的 Task/Incident/候选关联必须**拒绝**且**不得返回其他作用域的候选 ID**；
  同键唯一冲突**只能在完整验证既有行后复用**，不得把任何数据库异常解释为成功重放。
- **CHANGE 15（P1）固定 PLATFORM 基线可信性**：须给出 `baselineRef` 的**可信解析接口与来源**、
  固定审核基线与当前 `HEAD` 的**比较规则**、HEAD 不一致/无法解析/基线变化时的**稳定拒绝原因**、
  **基线检查失败不得降级为接受旧候选**，以及对应**负向验收测试**。

```text
MSG-20261009-29_FINAL_VERDICT = PASS_WITH_REVISE
MSG-20261009-29_ARCHIVED = AI-ARCHITECT-INBOX.md（FULL_COPY_OK 139/139；FNV1A e4ab17ad）
U2_DESIGN_APPROVED = YES_SCOPED_WITH_CONDITIONS（PLATFORM-only）
U2_IMPLEMENTATION_AUTHORIZED = NO（待 CHANGE 13–15 收口）
PHASE3_A_U3_TO_U5_AUTHORIZED = NO
REQUIRED_CHANGES = CHANGE_13_P1_FINAL_IO_CONTRACT ; CHANGE_14_P1_FINAL_ACCEPTANCE_MATRIX ;
                   CHANGE_15_P1_PLATFORM_BASELINE_TRUST
NEXT_AUTHORIZED = PHASE3_A_U2_DESIGN_R5_READ_ONLY_CHANGES_13_TO_15
NEXT_AUDIT = MSG-20261009-30
（R5 通过后）建议首个实施范围 = U2_PLATFORM_ONLY_INSERT_SUBSET
SCHEMA_MIGRATION = HOLD · RUNTIME_WIRING / MODEL_CALL = FORBIDDEN
EXTERNAL_WRITE = HOLD · AUTO_MERGE / AUTO_DEPLOY = FORBIDDEN · PRODUCTION_READY = NO
```

---

### 2.34 MSG-20261009-30 裁决归档 = **PASS WITH REVISE**（CHANGE 13–15 收敛；新增 CHANGE 16–18）

> 逐字归档：`AI-ARCHITECT-INBOX.md`（段落 `### [MSG-20261009-30] …`），
> `tools/verdict-diff/compare.mjs` = **FULL_COPY_OK（126/126，缺失 0，多出 0）**；
> 规范化指纹 = `NORM_CHARS=4097 / NORM_LINES=126 / FNV=a24ace4b`。
> 锚点：`U1_CODE_HEAD=9ee36837`、`U2_DESIGN_COMMIT_R4=378bfb2a`、`REVIEWED_HEAD=f115f881`。

**九项**：`CHANGE13 = PASS WITH REVISE`、`CHANGE14 = PASS`、`CHANGE15 = REVISE`、
`U2_INPUT_OUTPUT_CONTRACT = PASS WITH REVISE`、`U2_ACCEPTANCE_MATRIX_AND_FAIL_CLOSED = PASS WITH REVISE`、
`U2_IMPLEMENTATION_BOUNDARY = PASS`、`SCOPE_HONESTY = PASS`、
`U2_DESIGN_APPROVED = YES_SCOPED_WITH_CONDITIONS`、`U2_IMPLEMENTATION_AUTHORIZED = NO`。

**审计方独立核验**：R5 §13 已定义最终接口、CHANGE 13–15 已入库；`R4→R5` 涉及 3 个文件
（设计文档、checkpoint、`AI-ARCHITECT-INBOX.md`）；**未见 `apps/api` 产品代码变更**；
文档 SHA-256 未独立复算（`U2_DESIGN_DOC_SHA256_INDEPENDENTLY_VERIFIED=NO`）。

**REQUIRED_CHANGES（下一轮 MSG-20261009-31 只做这三项；`R6`）**

- **CHANGE 16（P0）封板基线与当前 HEAD 冲突**：§13.3 同时要求「固定基线 = `9ee36837`」与
  「基线 = 候选写入时的当前 HEAD」，但本分支 HEAD 为 `f115f881` ⇒ 照现有文字实现，
  **所有候选都会被 `BASELINE_INVALID` 拒绝**（fail-closed 成立，但正常 INSERT 路径不可用）。
  须明确：① U1 封板提交是**审计锚点**还是**运行基线**，**不得混用**；② 若采用冻结工作树，
  须定义**独立、不可变的候选构建基线**及其 HEAD 解析语义；③ 若允许候选分支，须明确候选基线的
  **授权来源与独立审批条件**；④ 无可靠授权基线时一律 `BASELINE_INVALID`，**不得**以当前 HEAD
  或历史候选自动代替；⑤ §13.3 的 `PENDING` 动态表述**不得**解释为已开放新的基线选择权限。
- **CHANGE 17（P1）输入契约与拒绝优先级不一致**：接口只声明 `incidentId`/`requestRef`，
  而拒绝优先级含调用方 `signalKey`、ACCOUNT 字段、U1 事实字段。须把输入定义为**运行时严格白名单**
  （不能只靠 TypeScript 静态类型）；额外字段按既定优先级拒绝，**禁止静默忽略后继续 INSERT**；
  明确 `incidentId` 的可信调用方类别与引用权限；规定无效 `incidentId`、缺失 `requestRef`、
  字段类型非法时的**确定性失败行为**；补「多种违规字段同时出现」的拒绝优先级测试。
  **不扩大对外 API、不新增 schema**。
- **CHANGE 18（P1）Git 基线与数据库写入的 TOCTOU 边界**：同一只读解析调用**不足以**保证
  「Git 检查结束 → 事务提交」之间 HEAD 不变。须定义基线解析 / 候选读取 / INSERT / 提交的**执行顺序**；
  一旦验证窗口内 HEAD 变化 ⇒ 拒绝且**零写入**；无法保证仓库状态稳定 ⇒ 拒绝写入，
  不得把一次历史读取当成持续授权；U2-18 增加「Git 验证完成后、DB 写入前 HEAD 变化」负向用例；
  **不得**通过新增第二套 Runtime / Scheduler / Controller 解决。

**审计方附注**：本轮**未执行**真实 PostgreSQL / Vitest / TypeScript / Linux-systemd / CI；
GitHub 只读检查不能替代后续实施验收。`U2_PLATFORM_ONLY_INSERT_SUBSET` **仅表示后续可申请的实施范围**，
本轮**未**开放产品代码实施。

```text
MSG-20261009-30_FINAL_VERDICT = PASS_WITH_REVISE
MSG-20261009-30_ARCHIVED = AI-ARCHITECT-INBOX.md（FULL_COPY_OK 126/126；FNV1A a24ace4b）
U2_DESIGN_APPROVED = YES_SCOPED_WITH_CONDITIONS（保持）
U2_IMPLEMENTATION_AUTHORIZED = NO
PHASE3_A_U3_TO_U5_AUTHORIZED = NO
REQUIRED_CHANGES = CHANGE_16_P0_BASELINE_HEAD_CONSISTENCY ;
                   CHANGE_17_P1_RUNTIME_INPUT_VALIDATION ;
                   CHANGE_18_P1_GIT_DB_TOCTOU_BOUNDARY
NEXT_AUTHORIZED = PHASE3_A_U2_DESIGN_R6_READ_ONLY_CHANGES_16_TO_18
NEXT_AUDIT = MSG-20261009-31
SCHEMA_MIGRATION = HOLD · RUNTIME_WIRING / MODEL_CALL = FORBIDDEN
EXTERNAL_WRITE = HOLD · AUTO_MERGE / AUTO_DEPLOY = FORBIDDEN · PRODUCTION_READY = NO
```

---

### 2.35 MSG-20261009-31 裁决归档 = **REVISE**（CHANGE 16 关闭；CHANGE 18 未收口，新增 CHANGE 19–21）

> 逐字归档：`AI-ARCHITECT-INBOX.md`（段落 `### [MSG-20261009-31] …`），
> `tools/verdict-diff/compare.mjs` = **FULL_COPY_OK（155/155，缺失 0，多出 0）**；
> 规范化指纹 = `NORM_CHARS=4777 / NORM_LINES=155 / FNV=ccd6834c`。
> 锚点：`U1_CODE_HEAD=9ee36837`、`U2_DESIGN_COMMIT_R5=f115f881`、`REVIEWED_HEAD=a12a9f36`
> （审计方另记 `U2_DESIGN_GIT_BLOB_SHA=ff775d8bc94149db780d209e880836e7dab1388a`）。

**九项**：`CHANGE16 = PASS`（**正式关闭，无须重做**）、`CHANGE17 = PASS WITH REVISE`、
`CHANGE18 = REVISE`、`U2_INPUT_OUTPUT_CONTRACT = PASS WITH REVISE`、
`U2_ACCEPTANCE_MATRIX_AND_FAIL_CLOSED = REVISE`、`U2_IMPLEMENTATION_BOUNDARY = PASS`、
`SCOPE_HONESTY = PASS WITH NOTE`、`U2_DESIGN_APPROVED = NO`、`U2_IMPLEMENTATION_AUTHORIZED = NO`。

**审计方更正（须在 R7 修正声明）**：`f115f881 → a12a9f36` 跨越**两个提交、三个文件**，
并非「仅一个设计文档文件」——「产品代码零变更」与「仓库仅一个文件变更」是两项不同声明。

**REQUIRED_CHANGES（下一轮 MSG-20261009-32 只做这三项；`R7`）**

- **CHANGE 19（P0）Git 写入窗口排他保证**：三次 Git 检查**不等于** COMMIT 时基线不变——
  检查③与 COMMIT 之间仍有竞态；「存在并发写入者时必须拒绝」目前只是运维约定，**不能等同技术门禁**。
  须：① 限定 U2 为**受控、固定提交的隔离工作树**运行模式，**不得**自动跟随可变远程分支；
  ② 证明工作目录处于受控环境，禁止其他主体在事务期间修改工作树 / HEAD / 相关 ref；
  ③ 排他保证须自**首次 Git 校验之前**持续到**数据库提交完成**；④ 无法建立排他 ⇒ 直接拒绝、零写入；
  ⑤ 三次检查保留但**不能替代**排他保证；⑥ 新增 **U2-20**：在检查③之后、COMMIT 之前尝试修改 HEAD
  ⇒ 修改被阻止，或事务拒绝且零写入；⑦ **不得**为此新增第二套 Runtime/Scheduler/Controller。
- **CHANGE 20（P1）拒绝原因码与校验顺序收口**：明确 `MISSING_REQUEST_REF` / `INVALID_FIELD_TYPE` /
  `INPUT_KEY_MISMATCH` 的精确定义；缺 `incidentId`、缺 `requestRef`、字段为 `null`、类型错误、空字符串
  **各有确定裁决**；多违规并存**只返回一个最高优先级原因**；非法顶层输入类型**不得**产生运行时异常或写入；
  唯一冲突复用必须检查候选键、关联 `Task`/`Incident`、`baselineRef`、`builderRef` 等**权威数据**，
  任何不匹配**不得返回已有候选 ID**；保留 §13.1 的接口结构。
  （并更正 `INPUT_KEY_MISMATCH` 语义：调用方已不能合法提供 `signalKey`，该码应表示
  **数据库中现有候选与本次计算的权威身份/关联/摘要不一致**。）
- **CHANGE 21（P1）提交证据与变更声明修订**：更正 R5→R6 的仓库变更记录（GitHub 返回 2 提交 3 文件）；
  明确 `u1SealRef` 写入**何种既有合法证据位置**（**不准为此新增 schema**）；
  定义三次 Git 检查的**最小审计记录**与不一致时的**回滚证据**；
  文档 SHA-256 继续标 `NOT_INDEPENDENTLY_VERIFIED` 直到真正独立字节复算；
  R6 文件 **blob SHA**（`ff775d8b…`）与**文档 SHA-256** 必须分别记录，不得混用。

**审计方列出的未验证项**：`POSTGRESQL_INTEGRATION_TEST / VITEST / TSC / LINUX_SYSTEMD / CI / PRODUCTION = NOT_VERIFIED`。

```text
MSG-20261009-31_FINAL_VERDICT = REVISE
MSG-20261009-31_ARCHIVED = AI-ARCHITECT-INBOX.md（FULL_COPY_OK 155/155；FNV1A ccd6834c）
CHANGE_16 = CLOSED（无须重做）
U2_DESIGN_APPROVED = NO
U2_IMPLEMENTATION_AUTHORIZED = NO
PHASE3_A_U3_TO_U5_AUTHORIZED = NO
REQUIRED_CHANGES = CHANGE_19_P0_GIT_DB_EXCLUSIVE_WRITE_WINDOW ;
                   CHANGE_20_P1_DETERMINISTIC_REJECTION_AND_REUSE_CONTRACT ;
                   CHANGE_21_P1_EVIDENCE_AND_CHANGE_SCOPE_CORRECTION
NEXT_AUTHORIZED = PHASE3_A_U2_DESIGN_R7_READ_ONLY_CHANGES_19_TO_21
NEXT_AUDIT = MSG-20261009-32
ACCOUNT_SCOPE = NOT_AUTHORIZED · SCHEMA_MIGRATION = HOLD
RUNTIME_WIRING / MODEL_CALL / PROVIDER_CALL = FORBIDDEN
EXTERNAL_WRITE = HOLD · AUTO_MERGE / AUTO_DEPLOY = FORBIDDEN · PRODUCTION_READY = NO
```

---

### 2.36 MSG-20261009-32 裁决归档 = **REVISE**（CHANGE 21 关闭；CHANGE 19 仍 P0，新增 CHANGE 22–25）

> 逐字归档：`AI-ARCHITECT-INBOX.md`（段落 `### [MSG-20261009-32] …`），
> `tools/verdict-diff/compare.mjs` = **FULL_COPY_OK（151/151，缺失 0，多出 0）**；
> 规范化指纹 = `NORM_CHARS=5280 / NORM_LINES=151 / FNV=576300bf`。
> 锚点：`U1_CODE_HEAD=9ee36837`、`U2_DESIGN_COMMIT_R6=a12a9f36`、`REVIEWED_HEAD=f6c6d677`。

**审计方独立核实的 Git 证据（本次被接受）**：R6→R7 = **2 提交 / 3 文件**
（`AI-ARCHITECT-INBOX.md`、U2 设计文档、checkpoint 文档）、**产品代码零变更**；
文档 **Git blob SHA = `37fdd4704c14bfbf3c1248584f962e28b25a3700`**，
与文档 SHA-256（`56cd7930…1d2f`，仍 `NOT_INDEPENDENTLY_VERIFIED`）分别记录。
`CHANGE 21 = PASS`（**已关闭**）。

**九项**：`CHANGE19 = REVISE · P0`、`CHANGE20 = PASS WITH REVISE · P1`、`CHANGE21 = PASS`、
`U2_INPUT_OUTPUT_CONTRACT = PASS WITH REVISE`、`U2_ACCEPTANCE_MATRIX_AND_FAIL_CLOSED = REVISE`、
`U2_IMPLEMENTATION_BOUNDARY = PASS · DESIGN ONLY`、`SCOPE_HONESTY = PASS`、
`U2_DESIGN_APPROVED = NO`、`U2_IMPLEMENTATION_AUTHORIZED = NO`。

**核心裁决**：`.u2-exclusive.lock` 只能排除**遵守同一锁协议的协作进程**，
**不能**阻止其他进程 `git reset` / 改 refs / 直接写工作树 ⇒ CHANGE 19 的 P0 缺口**仍未关闭**。

**REQUIRED_CHANGES（下一轮 MSG-20261009-33 只做这四项；`R8`）**

- **CHANGE 22（P0）排他锁不等于不可绕过的写入排他**：必须区分
  **协作式锁互斥** 与 **操作系统级写入隔离**；执行环境须能**证明**外部写入者无法修改受保护的 Git 基线
  （可用受限权限隔离工作树 / 文件系统权限边界等**既有**基础设施，**不新增 Runtime**）；
  隔离能力不可证明 ⇒ 直接 `EXCLUSIVE_WINDOW_UNAVAILABLE`，**不得 INSERT**；
  U2-20 必须**真实覆盖检查③之后至 COMMIT 完成**的竞争窗口（**不得**以对抗进程主动遵守锁代替证明），
  并同时验证**候选行零新增**与**无 candidate ID 泄露**。
- **CHANGE 23（P0）锁文件生命周期 vs 工作树洁净性冲突**：在工作树内创建 `.u2-exclusive.lock` 会使
  `git status --porcelain` 变脏 ⇒ **可能拒绝全部正常 INSERT**；且 `ttlMs` 到期**不能**作为安全接管依据
  （旧持有者可能仍在事务中）。须明确：锁不影响产品代码洁净性检查的实现方式；
  **不得**用忽略整个目录/扩大 `.gitignore` 掩盖产品文件变更；创建/持有/释放/崩溃恢复规则；
  **禁止**仅因 TTL 到期删除可能仍被活跃持有的锁；释放须校验 `ownerToken`；
  进程异常/锁损坏/归属不明/旧持有者状态不可判定 ⇒ **一律 fail-closed**；新增 **U2-21**
  （锁生命周期、过期竞争与工作树洁净性联合负向验收）。
- **CHANGE 24（P1）拒绝优先级须与实际 DB 读取顺序一致**：L10 `INPUT_KEY_MISMATCH` 依赖
  **已解析的候选与可信 Task/Incident 身份**，必须排在**可信身份构造之后**（L11–L15 之前）；
  所有拒绝只返回**一个稳定 reason**；已有候选仅在**完整身份与 digest 一致**时才可复用；
  补 **symbol 键 / 访问器属性 / 代理对象**等非普通输入的拒绝或安全处理口径（避免运行时异常或
  校验期间执行非预期行为）；R8 须给出新的「**执行顺序—reason—数据库副作用**」对应表。
- **CHANGE 25（P1）运行模式唯一化**：`CONTROLLED_FIXED_WORKTREE` 是**唯一允许**的 U2 执行环境；
  §14.1 的历史基线概念只能作为**受控工作树内部的基线校验策略**，**不构成独立运行模式或自动授权**；
  `auditAnchor=9ee36837` 仅溯源、`baselineRef` 为受控运行时权威基线；
  **任何可选冻结基线策略不得因 R8 通过而自动启用**。

**R8 最小送审证据**：R8 固定提交 + 完整变更文件清单 + 修订后的 **§16** +
U2-20/U2-21 验收规格 + **锁持有与释放状态表** + **拒绝原因执行顺序表**（产品代码零变更）。

```text
MSG-20261009-32_FINAL_VERDICT = REVISE
MSG-20261009-32_ARCHIVED = AI-ARCHITECT-INBOX.md（FULL_COPY_OK 151/151；FNV1A 576300bf）
CHANGE_21 = CLOSED（证据与变更范围纠正通过，blob SHA 独立核实）
CHANGE_19 = P0 未关闭（协作锁 ≠ OS 级写入隔离）
U2_DESIGN_APPROVED = NO · U2_IMPLEMENTATION_AUTHORIZED = NO · U3–U5 = NO
REQUIRED_CHANGES = CHANGE_22_P0_OS_LEVEL_WRITE_ISOLATION ; CHANGE_23_P0_LOCK_LIFECYCLE_VS_CLEANLINESS ;
                   CHANGE_24_P1_REJECTION_ORDER_VS_DB_READ_ORDER ; CHANGE_25_P1_SINGLE_RUNTIME_MODE
NEXT_AUTHORIZED = PHASE3_A_U2_DESIGN_R8_READ_ONLY_CHANGES_22_TO_25
NEXT_AUDIT = MSG-20261009-33
POSTGRESQL_INTEGRATION_TEST / VITEST / TSC / LINUX_SYSTEMD / CI / PRODUCTION = NOT_VERIFIED
SCHEMA_MIGRATION = HOLD · RUNTIME_WIRING / MODEL_CALL / PROVIDER_CALL = FORBIDDEN
EXTERNAL_WRITE = HOLD · AUTO_MERGE / AUTO_DEPLOY = FORBIDDEN · PRODUCTION_READY = NO
```

---

### 2.37 MSG-20261009-33 裁决归档 = **REVISE**（CHANGE 25 通过；新增 CHANGE 26–31，含 3 个 P0）

> 逐字归档：`AI-ARCHITECT-INBOX.md`（段落 `### [MSG-20261009-33] …`），
> `tools/verdict-diff/compare.mjs` = **FULL_COPY_OK（168/168，缺失 0，多出 0）**；
> 规范化指纹 = `NORM_CHARS=5125 / NORM_LINES=168 / FNV=ae50ce56`。
> 锚点：`U1_CODE_HEAD=9ee36837`、`U2_DESIGN_COMMIT_R7=f6c6d677`、`REVIEWED_HEAD=7a5d8058`。

**审计方独立核验**：R7→R8 = **2 提交 / 3 文件**、`apps/api` **0 变更**；
R8 文件的 **Git blob SHA `df417b9eef11ae10408a277d7722336292580ea0` 与送审值一致**
（`GIT_COMPARE_VERIFICATION=PASS`、`GIT_BLOB_SHA_VERIFICATION=PASS`）；§16.1–§16.5 确实存在；
但文档 SHA-256 仍未独立复算，且 PostgreSQL/Vitest/tsc/Linux-systemd/CI/生产 全 `NOT_VERIFIED`。

**十项**：`CHANGE25 = PASS`、`CHANGE23 = PASS WITH REVISE · P1`、`CHANGE24 = PASS WITH REVISE · P1`、
`CHANGE22 = REVISE · P0`、`U2_INPUT_OUTPUT_CONTRACT = PASS WITH REVISE`、
`U2_ACCEPTANCE_MATRIX_AND_FAIL_CLOSED = REVISE · P0`、`U2_IMPLEMENTATION_BOUNDARY = PASS`、
`SCOPE_HONESTY = PASS`、`U2_DESIGN_APPROVED = NO`、`U2_IMPLEMENTATION_AUTHORIZED = NO`。

**REQUIRED_CHANGES（下一轮 MSG-20261009-34 只做这六项；`R9`）**

- **CHANGE 26（P0）`ISOLATION_ATTESTED` 缺可信证明链**：证明只能由**可信运行环境**生成、经**受信配置/通道**
  获取（普通业务输入不得提供）；**服务端固定有效期上限**；须验证工作树 **canonical path**、`.git` 实际指向目录、
  `refs`、`packed-refs` 等保护范围；明确**同 UID 写入者 / 特权进程 / 权限变更**的信任边界；
  **禁止**把一次历史 ACL 检查解释为运行期持续不可变；验收须区分 `ATTESTATION_VALID` 与
  真正的 `WRITE_ISOLATION_ENFORCED`。
- **CHANGE 27（P0）U2-20 断言自相矛盾**：若外部越权写入**被 OS 拒绝**，则 Git/工作树不变、
  **合法候选可以提交**，不能无条件要求候选零新增。拆为 **U2-20A**（外部非授权写入被拒：Git 不变、
  合法候选可提交、无越权写入）/ **U2-20B**（真实检测到基线变化：回滚、零新增、不泄露 candidate ID）/
  **U2-20C**（隔离证明缺失或无效：拒绝进入写入流程、零新增）。
- **CHANGE 28（P0）唯一键冲突与并发复用未闭环**：A/B 双事务都查不到候选、A 插入成功后 B 撞唯一键，
  而「仅在已比对一致时复用」无法覆盖该路径。须：核实现有唯一约束确实覆盖候选去重键；冲突后经
  **明确的恢复/重试路径**重新读取并**逐项比对权威身份**；完全一致才 `CANDIDATE_REUSED`；
  任何不一致 ⇒ `INPUT_KEY_MISMATCH` 且 `candidateId=null`；**不得**把所有数据库异常当去重冲突；
  **新增真实 PostgreSQL 双连接竞争测试**。
- **CHANGE 29（P1）读取与事务边界不一致**：第 11–13 步的权威读取在事务外（可能基于旧状态）⇒
  关键读取须纳入写入事务或在事务内等价强度复验，并证明 Incident/Task 变化与 INSERT 并发时**不提交失效候选**；
  第 19 步 `COMMIT` 异常**不得**一律声称已回滚（连接中断可能结果未知）⇒ 只读对账 + 安全的未确认结果，
  **不得**未经验证重试。
- **CHANGE 30（P1）锁释放原子性**：「先读 `ownerToken` 再删除」之间存在竞态，须给出锁句柄/身份的稳定验证
  或环境权限与独占管理；并补：创建后写入/同步失败处理、释放失败告警与**下次调用拒绝**、
  人工解除陈旧锁的**权限/证据/审计**、以及「DB 提交成功但释放失败**不得**误报为零写入」。
- **CHANGE 31（P1）拒绝码与最终副作用状态一致**：`null` 与缺失的确定性优先级、非普通对象/Proxy 边界、
  Git 检查执行失败 vs 真实基线变化、INSERT 普通数据库错误的稳定契约、COMMIT 成功 + 释放失败时的真实候选状态；
  原则：**不得**因返回 `REJECTED` 就声称数据库一定未提交。

```text
MSG-20261009-33_FINAL_VERDICT = REVISE
MSG-20261009-33_ARCHIVED = AI-ARCHITECT-INBOX.md（FULL_COPY_OK 168/168；FNV1A ae50ce56）
CHANGE_25 = PASS（唯一运行模式）
U2_DESIGN_APPROVED = NO · U2_IMPLEMENTATION_AUTHORIZED = NO · U3–U5 = NO
REQUIRED_CHANGES = CHANGE_26_P0_ATTESTATION_TRUST_CHAIN ; CHANGE_27_P0_U2_20_SPLIT ;
                   CHANGE_28_P0_UNIQUE_CONFLICT_REUSE_PATH ; CHANGE_29_P1_TX_BOUNDARY ;
                   CHANGE_30_P1_LOCK_RELEASE_ATOMICITY ; CHANGE_31_P1_REASON_VS_SIDE_EFFECT
NEXT_AUTHORIZED = PHASE3_A_U2_DESIGN_R9_READ_ONLY_CHANGES_26_TO_31
NEXT_AUDIT = MSG-20261009-34
SCHEMA_MIGRATION = HOLD · RUNTIME_WIRING / MODEL_CALL / PROVIDER_CALL = FORBIDDEN
EXTERNAL_WRITE = HOLD · AUTO_MERGE / AUTO_DEPLOY = FORBIDDEN · PRODUCTION_READY = NO
POSTGRESQL_INTEGRATION_TEST / VITEST / TSC / LINUX_SYSTEMD / CI / PRODUCTION = NOT_VERIFIED
```

---

### 2.38 MSG-20261009-34 裁决归档 = **REVISE**（CHANGE 27 关闭、26/28 条件通过；新增 CHANGE 32–35，含 3 个 P0）

> 逐字归档：`AI-ARCHITECT-INBOX.md`（段落 `### [MSG-20261009-34] …`），
> `tools/verdict-diff/compare.mjs` = **FULL_COPY_OK（204/204，缺失 0，多出 0）**；
> 规范化指纹 = `NORM_CHARS=6234 / NORM_LINES=204 / FNV=d85473d1`。
> 锚点：`U1_CODE_HEAD=9ee36837`、`U2_DESIGN_COMMIT_R8=7a5d8058`、`REVIEWED_HEAD=d9172daa`。

**审计方独立核验**：`R8→R9` = **2 提交 / 3 文件**，GitHub 比较状态 **ahead** 与送审一致，
无 `apps/api` 变更（`R8_TO_R9_COMPARE_VERIFICATION=VERIFIED_VIA_GITHUB`）；
但文档 SHA-256 **与** blob SHA 本轮均标 `NOT_INDEPENDENTLY_VERIFIED`；
PostgreSQL/Vitest/tsc/Linux-systemd/CI/生产 全 `NOT_VERIFIED`。

**十二项**：`CHANGE27 = PASS`（U2-20A/B/C 正确区分，不再要求互相矛盾的结果）、
`CHANGE26 = PASS WITH REVISE`、`CHANGE28 = PASS WITH REVISE`、
`CHANGE29/30/31 = REVISE`、`U2_INPUT_OUTPUT_CONTRACT = PASS WITH REVISE`、
`U2_ACCEPTANCE_MATRIX_AND_FAIL_CLOSED = REVISE`、`U2_IMPLEMENTATION_BOUNDARY = PASS`、
`SCOPE_HONESTY = PASS`、`U2_DESIGN_APPROVED = NO`、`U2_IMPLEMENTATION_AUTHORIZED = NO`。

**REQUIRED_CHANGES（下一轮 MSG-20261009-35 只做这四项；`R10`）**

- **CHANGE 32（P0）锁释放仍非可证明原子**：POSIX `rename()` **可能覆盖已存在目标**，
  且**源路径可能被其他进程替换**（验证旧 fd 的 inode ≠ 随后按路径 rename 的同一对象）。须：
  ① Linux 使用 `renameat2(RENAME_NOREPLACE)` 或等效**不可覆盖**机制；② 把**锁文件父目录纳入隔离保护范围**
  （禁止非受信主体替换/重命名锁路径）；③ 释放前后校验 `(dev,inode)` 与所有权证据，任一不一致**不得 `unlink`**；
  ④ rename 失败/目标冲突/源路径异常**必须保留人工调查证据**；⑤ 新增 **U2-31**（并发锁路径替换、目标冲突、
  进程异常中断）。**并强调**：`RENAME_NOREPLACE` 只解决目标覆盖，**目录权限约束仍是必要条件**。
- **CHANGE 33（P0）PostgreSQL 并发失效防护不足**：事务内读取 **≠** 状态稳定
  （A 读 `DIAGNOSED` → B 改为不合格并提交 → A 仍 `INSERT`+`COMMIT`）。须明确：
  ① Incident/关联 Task 的**行锁或隔离策略**（可用 `SELECT ... FOR UPDATE`，但须证明所有相关状态写入均受锁协调）；
  ② 并发关联修改防护；③ 死锁/序列化失败/锁等待超时处理；④ 重试安全边界与「必须拒绝而非重试」的时刻；
  ⑤ **U2-30 须为可控交错的真实 PostgreSQL 双连接测试**，断言最终已提交状态与候选资格一致。
- **CHANGE 34（P0）未知 COMMIT 对账语义漏洞**：**查不到记录 ≠ 已回滚**（结果未定/数据库切换/副本延迟）。
  须定义对账的**权威数据源与一致性前提**、事务结束且结果**可确定**的条件；
  未达确定性时 `COMMIT_NOT_CONFIRMED` 对应 **`commitState=UNKNOWN`**；
  **只有拿到明确的未提交证据才允许 `NOT_COMMITTED`**；对账期间**禁止盲目重复 INSERT**。
- **CHANGE 35（P1）副作用报告无法表达未知提交**：`candidateRowsWritten` 语义须明确
  （已尝试 / 事务内成功 / 最终已提交新行数），无法判定时允许 **`UNKNOWN`** 或拆分
  「事务内写入事实」与「最终提交事实」；并给出完整状态表：
  新候选确认提交 → `COMMITTED` + 新 ID；合法既有候选复用 → `NOT_COMMITTED（本次无新提交）` + 既有 ID；
  输入校验拒绝 → `NOT_COMMITTED` + `null`；插入失败且事务确认回滚 → `NOT_COMMITTED` + `null`；
  **结果未知且对账无定论 → `UNKNOWN` + `null`**；提交成功但释放失败 → `COMMITTED` + 已确认 ID。
  另须明确 `COMMIT_CONFIRMED_BY_RECONCILE` 是 **outcome、reason 还是附加状态**，避免与 §13.1 的 `outcome` 枚举冲突。

```text
MSG-20261009-34_FINAL_VERDICT = REVISE
MSG-20261009-34_ARCHIVED = AI-ARCHITECT-INBOX.md（FULL_COPY_OK 204/204；FNV1A d85473d1）
CHANGE_27 = CLOSED（U2-20A/B/C）
U2_DESIGN_APPROVED = NO · U2_IMPLEMENTATION_AUTHORIZED = NO · U3–U5 = NOT AUTHORIZED
REQUIRED_CHANGES = CHANGE_32_P0_LOCK_RELEASE_PATH_RACE ; CHANGE_33_P0_POSTGRES_CONCURRENT_INVALIDATION ;
                   CHANGE_34_P0_UNKNOWN_COMMIT_RECONCILE_SEMANTICS ; CHANGE_35_P1_SIDE_EFFECT_REPORT_CONSISTENCY
NEXT_AUTHORIZED = PHASE3_A_U2_DESIGN_R10_READ_ONLY_CHANGES_32_TO_35
NEXT_AUDIT = MSG-20261009-35
SCHEMA_MIGRATION = HOLD · RUNTIME_WIRING / MODEL_CALL / PROVIDER_CALL = FORBIDDEN
EXTERNAL_WRITE = HOLD · AUTO_MERGE / AUTO_DEPLOY = FORBIDDEN · PRODUCTION_READY = NO
POSTGRESQL_INTEGRATION_TEST / VITEST / TSC / LINUX_SYSTEMD / CI / PRODUCTION = NOT_VERIFIED
```

---

### 2.39 MSG-20261009-35 裁决归档 = **REVISE**（CHANGE 33 首个 PASS_SCOPED；新增 CHANGE 36–39，含 2 个 P0）

> 逐字归档：`AI-ARCHITECT-INBOX.md`（段落 `### [MSG-20261009-35] …`），
> `tools/verdict-diff/compare.mjs` = **FULL_COPY_OK（163/163，缺失 0，多出 0）**；
> 规范化指纹 = `NORM_CHARS=5408 / NORM_LINES=163 / FNV=0d8abefe`。
> 锚点：`U1_CODE_HEAD=9ee36837`、`U2_DESIGN_COMMIT_R9=d9172daa`、`REVIEWED_HEAD=35a50c63`。

**审计方独立核验**：`R9→R10` = **2 提交 / 3 文件**（提交数与文件数**均匹配**）、
**Git blob SHA `7a86e43c…f11ac3ca1` 匹配**、`apps/api` 0 变更；
R10 文档 SHA-256 **未独立复算**；PostgreSQL/Linux/Vitest/CI **未进行运行验证**。

**十项**：`CHANGE33 = PASS_SCOPED`（**本轮唯一通过项**：`SELECT ... FOR UPDATE` 同事务锁 Incident/Task 后再判资格，
可防止被锁行在提交前被改；固定锁序、限制重试、未知 COMMIT 禁重插均合理——但**仅限设计机制**）、
`CHANGE32 = REVISE`、`CHANGE34 = REVISE`、`CHANGE35 = REVISE`、
`U2_INPUT_OUTPUT_CONTRACT = REVISE`、`U2_ACCEPTANCE_MATRIX_AND_FAIL_CLOSED = REVISE`、
`U2_IMPLEMENTATION_BOUNDARY = PASS`、`SCOPE_HONESTY = PASS`、
`U2_DESIGN_APPROVED = NO`、`U2_IMPLEMENTATION_AUTHORIZED = NO`。

**REQUIRED_CHANGES（下一轮 MSG-20261009-36 只做这四项；`R11`）**

- **CHANGE 36（P0）锁释放缺同 UID 并发防护**：`RENAME_NOREPLACE` 只防**目标覆盖**、`O_NOFOLLOW` 只防最终路径
  符号链接、目录权限只挡**其他用户**；**同一服务账户的第二个进程**仍可在「A 检查与改名之间」替换**源目录项**。须：
  ① 明确锁目录安全假设（单进程独占 / 不同 UID 隔离 / 同 UID 多进程）；② 若允许同 UID 并发，须给出
  **可验证的路径互斥机制**（不得仅凭目录属主权限）；③ 释放前后检查须覆盖**持锁实际对象与源目录项**，
  异常 **fail-closed**；④ 明确「取锁 → 候选事务结束 → 释放」的生命周期关系；
  ⑤ **U2-31 增加同 UID 双进程竞争**与「释放验证后、删除前」的对抗性路径替换测试。
  **验收原则**：不得删除不属于本次持锁者的锁对象；无法证明所有权必须**保留现场、不得自动清理**。
- **CHANGE 37（P0）COMMIT 对账须证明记录属于本次事务**：**查到完全匹配记录 ≠ 本次 INSERT 已提交**
  （同 `dedupeKey` 的候选可能**先前已存在**）。须：① 区分 `RECORD_EXISTS` 与 `THIS_INSERT_COMMITTED`；
  ② 对账必须匹配**本次 INSERT 可验证的唯一候选 ID 或等价事务归因凭据**（仅靠 dedupeKey/digest/关联字段不足）；
  ③ 无法排除既有记录或竞争事务影响时 `commitState=UNKNOWN`，**不得输出 `newRowsCommitted=1`**；
  ④ `ON CONFLICT DO NOTHING` **零行路径**与**未知 COMMIT 路径**严格分开；
  ⑤ 新增对抗用例：预先存在完全匹配候选 + 本次 COMMIT 返回未知 ⇒ **禁止误报 `CANDIDATE_INSERTED`**；
  ⑥ 说明现有标识是否足以构建可证明的提交归因，不能则保持 `UNKNOWN`（无需新增 schema）。
- **CHANGE 38（P1）统一事务状态与新增行数语义**：`commitState` 目前**混用**「数据库事务结果」与
  「本次是否提交新候选」（合法复用场景会出现 `commitState=NOT_COMMITTED` 而事务其实已提交）。须：
  ① 限定为本次候选 INSERT 的提交状态，或重命名为 `candidateInsertCommitState`；
  ② `newRowsCommitted` 明确为「本次调用新插入并确认持久化的行数」；③ 为**未尝试 INSERT 的合法复用**
  规定确定性映射（避免与「已尝试但回滚」混同）；④ 补全 `insertAttempted`/`insertSucceededInTx`/`reconciled`/
  `lockReleaseFailed` 在各结果中的**组合约束**；⑤ **COMMIT 未知与锁释放同时失败时，不得由 `LOCK_RELEASE_FAILED`
  覆盖更重要的提交不确定性**；⑥ 保持三个 outcome、不扩枚举，用报告字段区分状态。
- **CHANGE 39（P1）隔离证明与 refs digest 精确定义**：① `utf8("u2refs:v1" + "\n" + 字节)` **混用字符串与原始字节**
  ⇒ 必须先编码固定前缀再 **Buffer 拼接**，不得把 `packed-refs` 隐式转字符串；② 明确 **common git dir /
  worktree gitdir** 的相对路径解析、顺序与**域分隔**，避免不同文件组合产生相同拼接结果；
  ③ **区分传输通道与签发者身份认证**（环境变量/启动挂载不天然证明签发者可信，同 UID 可伪造注入值）；
  ④ 无法建立可信进程或签发者身份时**维持 `NOT_ATTESTED`**（不要求新增密钥系统，无法满足则直接拒绝）。

```text
MSG-20261009-35_FINAL_VERDICT = REVISE
MSG-20261009-35_ARCHIVED = AI-ARCHITECT-INBOX.md（FULL_COPY_OK 163/163；FNV1A 0d8abefe）
CHANGE_33 = PASS_SCOPED（设计机制通过；实施须确认全部可变资格状态纳入事务内重验）
U2_DESIGN_APPROVED = NO · U2_IMPLEMENTATION_AUTHORIZED = NO · U3–U5 = NO
REQUIRED_CHANGES = CHANGE_36_P0_SAME_UID_LOCK_RELEASE_RACE ; CHANGE_37_P0_COMMIT_ATTRIBUTION ;
                   CHANGE_38_P1_TX_STATE_AND_NEWROWS_SEMANTICS ; CHANGE_39_P1_ATTESTATION_AND_REFS_DIGEST
NEXT_AUTHORIZED = PHASE3_A_U2_DESIGN_R11_READ_ONLY_CHANGES_36_TO_39
NEXT_AUDIT = MSG-20261009-36（须附 R10→R11 差异、完整状态组合表、锁并发时序与提交对账正负例判定表）
SCHEMA_MIGRATION = HOLD · RUNTIME_WIRING / MODEL_CALL / PROVIDER_CALL = FORBIDDEN
EXTERNAL_WRITE = HOLD · AUTO_MERGE / AUTO_DEPLOY = FORBIDDEN · PRODUCTION_READY = NO
POSTGRESQL_INTEGRATION_TEST / VITEST / TSC / LINUX_SYSTEMD / CI / PRODUCTION = NOT_VERIFIED
```

---

### 2.40 MSG-20261009-36 裁决归档 = **REVISE**（CHANGE 38/39 条件通过；两个 P0 未关，新增 CHANGE 40–43）

> 逐字归档：`AI-ARCHITECT-INBOX.md`（段落 `### [MSG-20261009-36] …`），
> `tools/verdict-diff/compare.mjs` = **FULL_COPY_OK（189/189，缺失 0，多出 0）**；
> 规范化指纹 = `NORM_CHARS=5604 / NORM_LINES=189 / FNV=90c85cab`
> （注：本轮首次复算不匹配 2 字符，原因是裁决正文中 `\\n`/`\\u0000` 为**两个反斜杠**的字面序列，
> 已按页面 innerText 原样修正后一致）。
> 锚点：`U1_CODE_HEAD=9ee36837`、`U2_DESIGN_COMMIT_R10=35a50c63`、`REVIEWED_HEAD=b02a92de`。

**审计方独立核验**：`R10→R11 = 2 提交 / 3 文件`、`apps/api` 0 变更、§19.1–§19.5 已从 diff 读取；
**R11 文档 Git blob SHA `8b53b3f19920e11e62147516c4a863cf076027f7` 本轮独立核验通过**；
SHA-256 仍 `NOT_INDEPENDENTLY_VERIFIED`；真实 PostgreSQL/Linux 未执行。

**逐项**：`CHANGE38 = PASS WITH REVISE · P1`、`CHANGE39 = PASS WITH REVISE · P1`、
`CHANGE36 = REVISE · P0`、`CHANGE37 = REVISE · P0`、
`U2_INPUT_OUTPUT_CONTRACT = PASS WITH REVISE`、`U2_ACCEPTANCE_MATRIX_AND_FAIL_CLOSED = REVISE`、
`U2_IMPLEMENTATION_BOUNDARY = PASS`、`SCOPE_HONESTY = PASS`、
`U2_DESIGN_APPROVED = NO`、`U2_IMPLEMENTATION_AUTHORIZED = NO`。

**两个 P0 的否决理由（原文要点）**

1. **CHANGE 36**：`singleInstanceGuaranteeRef + Digest` 只证明**某份配置/证据存在**，
   不证明**运行中的进程持有排他权**——`RuntimeDirectory` ≠ 单实例锁；systemd 单元单实例**不代表**
   同 UID 用户不能直接启动第二个进程；`flock` 只有被**所有**相关实例遵守才具协作互斥意义；
   锁持有进程被强制终止后必须定义遗留文件处理规则。
2. **CHANGE 37**：`READ COMMITTED` 下「读时未发现某个 key」**不排除**其他事务随后成功插入该 key；
   行锁只保护**实际锁定的行**，锁不住**不存在**的候选记录；`createdAt` 是**时间**而非**事务身份**，
   即便落在窗口内也不能排除其他写入者 ⇒ 我的三条件**不足**以证明 `THIS_INSERT_COMMITTED`。

**REQUIRED_CHANGES（下一轮 MSG-20261009-37 只做这四项；`R12`）**

- **CHANGE 40（P0）同 UID 锁安全的「活体排他」**：定义允许执行 U2 的**唯一受控入口**，
  说明其他同 UID 进程的启动与文件修改能力如何被限制；**区分 `CONFIG_VERIFIED` 与
  `LIVE_EXCLUSIVITY_VERIFIED`**；若采用 `flock`，须明确**锁文件/锁 FD/持有进程/完整事务窗口**
  （避免锁意外提前释放）；定义**进程中断后的锁恢复规则**（**不得仅凭时间戳自动抢占或清除**）；
  **U2-31 必须覆盖**「同 UID 绕过正常入口直接启动」与「释放锁期间路径对象被替换」。
  若无法在现有环境保证同 UID 文件系统操作隔离 ⇒ 明列为**可信运行账户安全假设**并由**可信启动边界**保证，
  否则拒绝写入；**不得**声称普通 `flock` 能阻止不合作的同 UID 进程修改目录项。
- **CHANGE 41（P0）精确事务归因**：优先采用**不新增 schema** 的方案 ——
  明确 `INSERT ... ON CONFLICT DO NOTHING RETURNING` 的**实际返回行数与主键**；
  返回一行时**在 `COMMIT` 前记录真实返回 ID**；未知 `COMMIT` 时凭**该 ID + dedupeKey + 必要不变字段**
  在**权威主库**对账；须明确**候选主键不可复用、记录不能被其他路径替换、唯一约束的实际行为**；
  上述前提无法证明 ⇒ 只能 `UNKNOWN`，**不得**宣称已确认本次事务提交；
  `createdAt` 仅作辅助诊断字段。**扩展 U2-32**：加入两个事务**交错写入同一 dedupeKey** 的情况。
- **CHANGE 42（P1）状态报告语义收口**：**零行冲突复用**（执行了 `ON CONFLICT DO NOTHING`
  返回零行后再复用）必须记 `insertAttempted=true`（不是 `false`）；`reconciled` 须区分
  「**执行过**对账」与「**对账有结论**」（或规定以 `candidateInsertCommitState` 为唯一确定性依据）；
  明确 **COMMIT UNKNOWN 与锁释放失败并存**时的 **outcome/reason 优先级**。
- **CHANGE 43（P1）digest 规范测试向量**：给出最终拼接字节的**十六进制表示**与**预期 SHA-256**，
  覆盖**空 packed-refs、linked worktree、特殊路径与异常输入**；并明确
  `\n`/`\u0000` 必须表示**实际 LF/NUL 字节**（不是文本反斜杠序列）、可变长字段需**长度前缀**
  或严格证明分隔符不可能出现、`realpath` 的**解析基准/符号链接策略/归一化**须可重复计算、
  `signerAuthRef` 须**绑定签发者+运行实例+证明内容**以防跨环境重放。
  （不需引入新的密钥管理系统。）

**审计方明确**：`U2_PLATFORM_ONLY_INSERT_SUBSET` **目前也不宜放行**——该子集本身依赖
CHANGE 36 的执行互斥与 CHANGE 37 的事务归因，不能绕过 P0 门禁。

```text
MSG-20261009-36_FINAL_VERDICT = REVISE
MSG-20261009-36_ARCHIVED = AI-ARCHITECT-INBOX.md（FULL_COPY_OK 189/189；FNV1A 90c85cab）
U2_DESIGN_GIT_BLOB_VERIFICATION = INDEPENDENTLY_VERIFIED（8b53b3f1…76027f7）
U2_DESIGN_APPROVED = NO · U2_IMPLEMENTATION_AUTHORIZED = NO · U3–U5 = NO
U2_PLATFORM_ONLY_INSERT_SUBSET = NOT AUTHORIZED（本轮明确）
REQUIRED_CHANGES = CHANGE_40_P0_LIVE_EXCLUSIVITY ; CHANGE_41_P0_PRECISE_COMMIT_ATTRIBUTION ;
                   CHANGE_42_P1_STATE_REPORT_SEMANTICS ; CHANGE_43_P1_DIGEST_TEST_VECTOR
NEXT_AUTHORIZED = PHASE3_A_U2_DESIGN_R12_READ_ONLY_CHANGES_40_TO_43
NEXT_AUDIT = MSG-20261009-37
SCHEMA_MIGRATION = HOLD · RUNTIME_WIRING / MODEL_CALL / PROVIDER_CALL = FORBIDDEN
EXTERNAL_WRITE = HOLD · AUTO_MERGE / AUTO_DEPLOY = FORBIDDEN · PRODUCTION_READY = NO
POSTGRESQL_INTEGRATION_TEST / VITEST / TSC / LINUX_SYSTEMD / CI / PRODUCTION = NOT_VERIFIED
```

---

### 2.41 MSG-20261009-37 裁决归档 = **REVISE**（CHANGE 42 首次 PASS；两个 P0 未关，新增 CHANGE 44–46）

> 逐字归档：`AI-ARCHITECT-INBOX.md`（段落 `### [MSG-20261009-37] …`），
> `tools/verdict-diff/compare.mjs` = **FULL_COPY_OK（138/138，缺失 0，多出 0）**；
> 规范化指纹 = `NORM_CHARS=4944 / NORM_LINES=138 / FNV=84d0e54b`。
> 锚点：`U1_CODE_HEAD=9ee36837`、`U2_DESIGN_COMMIT_R11=b02a92de`、`REVIEWED_HEAD=c9b167c7`。

**审计方独立核验**：`R11→R12 = 2 提交 / 3 文件`、R12 文档 Git blob SHA
`fadd6878022da70fc48bf991e3893c88d3001d68` **与送审一致**、无 `apps/api` 变更、§20 四项修订均已入库。

**十项**：`CHANGE42 = PASS`（**首次无条件通过**）、`CHANGE43 = PASS WITH REVISE · P1`、
`CHANGE40 = REVISE · P0`、`CHANGE41 = REVISE · P0`、
`U2_INPUT_OUTPUT_CONTRACT = PASS WITH REVISE`、`U2_ACCEPTANCE_MATRIX_AND_FAIL_CLOSED = REVISE`、
`U2_IMPLEMENTATION_BOUNDARY = PASS`、`SCOPE_HONESTY = PASS`、
`U2_DESIGN_APPROVED = NO`、`U2_IMPLEMENTATION_AUTHORIZED = NO`。

**两个 P0 的否决理由（原文要点）**

1. **CHANGE 40 锁验证时序矛盾**：T0 让外部探针尝试同一把锁并失败，只证明「探测时有其他主体持锁」，
   **不能**证明「U2 在 T1 已持锁」；T1 复用时是否复用同一已持锁 FD 亦未定义；还缺 flock 的
   **FD 继承/复制/关闭**语义（子进程继承会导致锁意外持续存在）。
2. **CHANGE 41 归因前提不是全局保证**：「U2 路径不 UPDATE/DELETE」只约束本模块，
   **其他模块 / 管理员 / 数据库作业**仍可删除、替换或修改必要字段 ⇒ 未知 COMMIT 后仅凭返回过的 id
   重读到匹配行仍需**全局不可变性**前提；另须覆盖 `RETURNING` 得一行但事务**明确 ROLLBACK** 的场景。

**REQUIRED_CHANGES（下一轮 MSG-20261009-38 只做这三项；`R13`，须附 §21 + 正反例验收矩阵 + R12→R13 diff）**

- **CHANGE 44（P0）LIVE_EXCLUSIVITY 时序与锁所有权证明**：
  `T0`（受控启动身份 / 隔离前提 / 配置证明）→ `T1`（当前 U2 实例取锁，记录**持锁 FD、实例身份、锁对象标识**）
  → **`T1A`（独立探针用独立打开的 FD 非阻塞获取同一把锁并确认失败，且必须验证锁对象身份与
  U2 当前持锁事实一致）** → `T2`（**仅 T1 与 T1A 均成功且证明仍有效**才进入数据库事务）
  → `T3`（事务 + 必要对账 + 释放；**释放失败必须保留异常事实，不得声称正常释放**）。
  另须明确 flock 的 **FD 继承/复制/关闭**行为。
  **负例**：探针失败但 U2 实际未持锁 / 探针与 U2 锁定**不同 inode** / 验证后锁被**提前释放** ⇒ 均不得进入写入阶段。
- **CHANGE 45（P0）把 COMMIT 归因前提升级为全局不可变性保证**：给出**全局写入者清单**
  （不得仅限制 U2 模块）；核对 `AutonomyCandidate.id` 的生成与**不复用机制**（对照实际 Schema、数据库约束与写入路径）；
  `returnedCandidateId` 必须在 `COMMIT` 前**可靠保存到事务外执行上下文**（其本身**不等于**已提交证明）；
  未知 COMMIT 对账必须在**权威主库**且满足上述前提后进行；**无法证明全局不可变性 ⇒ 只允许 `UNKNOWN`**；
  并覆盖「`RETURNING` 得一行但随后事务明确 `ROLLBACK`」的场景。
- **CHANGE 46（P1）refs 摘要字节规范歧义**：`git rev-parse` 原始输出只去除**命令产生的行尾换行**
  （不得损伤路径名中的有效字符）；非 ASCII refname 的「码点排序」与「原始字节排序」可能不同，
  必须**固定排序算法**并明确**区域设置不影响输出**；`git for-each-ref` 输出、Git 退出码与路径解析失败
  须定义**统一 fail-closed** 行为；`signerAuthRef` 除绑定签发者/实例/证明摘要外，还需明确
  **验证时机、有效期与防重放**规则。现有 34 字节向量可保留为基准，但文档 SHA-256 与该向量的双实现复算
  **仍属送审方报告**，本轮不记为独立哈希验证通过。

```text
MSG-20261009-37_FINAL_VERDICT = REVISE
MSG-20261009-37_ARCHIVED = AI-ARCHITECT-INBOX.md（FULL_COPY_OK 138/138；FNV1A 84d0e54b）
CHANGE_42 = PASS（状态报告语义）
U2_DESIGN_APPROVED = NO · U2_IMPLEMENTATION_AUTHORIZED = NO · U3–U5 = NO
REQUIRED_CHANGES = CHANGE_44_P0_LIVE_EXCLUSIVITY_TIMING ; CHANGE_45_P0_GLOBAL_IMMUTABILITY ;
                   CHANGE_46_P1_REFS_DIGEST_BYTE_SPEC
NEXT_AUTHORIZED = PHASE3_A_U2_DESIGN_R13_READ_ONLY_CHANGES_44_TO_46
NEXT_AUDIT = MSG-20261009-38
SCHEMA_MIGRATION = HOLD · RUNTIME_WIRING / MODEL_CALL / PROVIDER_CALL = FORBIDDEN
EXTERNAL_WRITE = HOLD · AUTO_MERGE / AUTO_DEPLOY = FORBIDDEN · PRODUCTION_READY = NO
POSTGRESQL_INTEGRATION_TEST / VITEST / TSC / LINUX_SYSTEMD / CI / PRODUCTION = NOT_VERIFIED
```

---

### 2.42 MSG-20261009-38 裁决归档 = **REVISE**（CHANGE 45/46 升为 PASS WITH REVISE；CHANGE 44 维持 OPEN，新增 CHANGE 47–53，其中 47/48/53 为 P0）

> 逐字归档：`AI-ARCHITECT-INBOX.md`（段落 `### [MSG-20261009-38] …`），
> `tools/verdict-diff/compare.mjs` = **FULL_COPY_OK（142/142，缺失 0，多出 0）**；
> 规范化指纹 = `NORM_CHARS=4576 / NORM_LINES=142 / FNV=3b338338`。
> 锚点：`U1_CODE_HEAD=9ee36837`、`U2_DESIGN_COMMIT_R12=c9b167c7`、`REVIEWED_HEAD=8c42cfc2`。

**审计方独立核验**：`R12→R13 = 2 提交 / 3 文件`、变更文件均为 Markdown（**无 `apps/api` 产品代码、无 Prisma Schema/Migration**）、
R13 设计文档 Git blob SHA `a32103858ef1f5ecca11ae19f825a252a79cbdeb` **与送审一致**、§21.1–§21.5 修订与 **U2-33～U2-40** 矩阵确存在。
**未独立复核**：文档 SHA-256、U1 锚点不变性、真实运行测试。

**六项**：`CHANGE44 = REVISE`、`CHANGE45 = PASS WITH REVISE`、`CHANGE46 = PASS WITH REVISE`、
`R13 文档与提交差异 = PASS（限定 GitHub 核查范围）`、`U2 设计最终关闭 = NO`、`U2_PLATFORM_ONLY_INSERT_SUBSET 实施 = NOT AUTHORIZED`。

**三个新增 P0 的否决理由（原文要点）**

1. **CHANGE 47（P0）探针失败不能证明持锁者是当前实例**：独立探针取锁失败最多证明该锁对象当前**存在冲突锁**；
   `ownerToken`/`instanceId`/`(dev,inode)` 只是**身份关联**，**不是内核锁所有权证明**。R14 须规定
   `T1` 由当前实例在指定 FD 上成功取得 `LOCK_EX | LOCK_NB` 并**保留系统调用结果**，`T1A` 用独立打开的
   文件描述证明互斥，**两者组合**构成证据链（而非让 T1A 单独证明身份）；`T2` 前必须验证该**打开文件描述仍持续持有排他锁**
   —— 仅 `fstat(fd)` 与路径一致性检查**不足以**证明；无法持续证明时须依靠**可信 FD 生命周期控制**或更强内核级机制，
   而非反复读取元数据。
2. **CHANGE 48（P0）修正 flock 的释放与继承语义**：R13 §21.1.4 关于 `close()` 的表述不准确。Linux 上 `flock`
   关联的是 **open file description**：显式 `LOCK_UN` 可解除锁（即便仍存在引用同一描述的复制 FD），
   而**只关闭其中一个 FD 不保证解锁**。因此：不得声明 `close(fd)` 一定是最终释放依据；必须验证**不存在未受控的复制 FD**；
   `O_CLOEXEC` 只防 `exec` 继承、**不阻止 `fork` 继承**；`SIGKILL` 结束持锁进程**不代表**其他仍持有共享描述的进程也结束
   （锁可能继续存在）；释放异常**必须保留状态与证据**，不以时间戳推断已释放。
3. **CHANGE 53（P0）`signerAuthRef` 防重放必须具有原子消费语义**：一次性 nonce 仅被签名覆盖**不能**阻止两个实例并发使用。
   R14 须定义可信的消费状态与**原子校验 + 占用**：`T0` 原子占用一次性挑战、`T2` **复验同一次执行的授权状态**（而非再次消费）、
   其他实例使用相同 nonce 必须失败、进程崩溃后不得使 nonce 重新可用、授权过期或实例不匹配必须拒绝；
   若现有可信控制面不支持这些能力 ⇒ 保持 `EXCLUSIVE_WINDOW_UNAVAILABLE`，不得默认允许。

**REQUIRED_CHANGES（下一轮 MSG-20261009-39 只做这七项；`R14` 纯设计修订 + 只读证据核验）**

- **CHANGE 47（P0）** 锁所有权证据链（T1 系统调用结果 + T1A 独立 FD 互斥 + T2 前持续持锁验证；不足则用可信 FD 生命周期控制/更强内核机制）。
- **CHANGE 48（P0）** flock 释放与继承语义修正（`LOCK_UN` vs `close`、未受控复制 FD、`fork` 继承、`SIGKILL` 共享描述、异常保留证据）。
- **CHANGE 49（P1）** U2-33～U2-36 补真实 **Linux 多进程**测试（误归因 / 复制 FD 后 `LOCK_UN` 可检测 / `fork` 继承且父进程退出不得误判已释放 / 证明后至提交期间锁释放或路径替换须拒绝或安全中止）。
- **CHANGE 50（P1）** COMMIT 归因证据有效性（低碰撞 ≠ 绝对不复用；限定数据库实例/恢复历史/ID 写入权限/观察窗口；显式 ROLLBACK 须可靠确认回滚完成；跨进程对账只能用可持久化可重读的事务外记录）。
- **CHANGE 51（P1）** 清单完整性是**准入条件**而非代码假设（全写入者列举 / 权限与触发器核验 / 全观察窗口无未记录 UPDATE-DELETE / ID 不复用前提在实际环境成立）。
- **CHANGE 52（P1）** 统一字节级输入契约（**R13 优先于 R12**；明确用原始路径输出字节或受控转换后的路径字节；完整调用参数与环境；按原始字节排序；不以未校验的 Git 输出顺序替代规范排序；拒绝不能无损表示的路径/引用名；双实现核对非 ASCII/空格/换行/异常输入）。
- **CHANGE 53（P0）** `signerAuthRef` 原子消费语义（见上）。

```text
MSG-20261009-38_FINAL_VERDICT = REVISE
MSG-20261009-38_ARCHIVED = AI-ARCHITECT-INBOX.md（规范化指纹 4576/142；FNV1A 3b338338）
CHANGE_44 = REVISE（仍 OPEN）· CHANGE_45 = PASS_WITH_REVISE · CHANGE_46 = PASS_WITH_REVISE
U2_DESIGN_CLOSED = NO · U2_IMPLEMENTATION_AUTHORIZED = NO · U2_PLATFORM_ONLY_INSERT_SUBSET = NOT AUTHORIZED
REQUIRED_CHANGES = CHANGE_47_P0 ; CHANGE_48_P0 ; CHANGE_49_P1 ; CHANGE_50_P1 ; CHANGE_51_P1 ;
                   CHANGE_52_P1 ; CHANGE_53_P0
NEXT_AUTHORIZED = PHASE3_A_U2_DESIGN_R14_READ_ONLY_CHANGES_47_TO_53
NEXT_AUDIT = MSG-20261009-39
SCHEMA_MIGRATION = HOLD · RUNTIME_WIRING / MODEL_CALL / PROVIDER_CALL = FORBIDDEN
EXTERNAL_WRITE = HOLD · AUTO_MERGE / AUTO_DEPLOY = FORBIDDEN · PRODUCTION_READY = NO
POSTGRESQL_INTEGRATION_TEST / VITEST / TSC / LINUX_SYSTEMD / CI / PRODUCTION = NOT_VERIFIED
```

---

### 2.43 MSG-20261009-39 裁决归档 = **REVISE**（七项：CHANGE 49 PASS、48/50/51/52/53 PASS WITH REVISE、47 仍 OPEN；新增 CHANGE 54–60，其中 54/55/60 为 P0）

> 逐字归档：`AI-ARCHITECT-INBOX.md`（段落 `### [MSG-20261009-39] …`），
> `tools/verdict-diff/compare.mjs` = **FULL_COPY_OK（187/187，缺失 0，多出 0）**；
> 规范化指纹 = `NORM_CHARS=4676 / NORM_LINES=187 / FNV=6db509f7`。
> 锚点：`U1_CODE_HEAD=9ee36837`、`U2_DESIGN_COMMIT_R13=8c42cfc2`、`REVIEWED_HEAD=b57e5cb8`。

#### 2.43.0 送审范围声明不一致 —— **已承认并更正（诚信修正）**

本轮送审材料写「R13 → R14：提交数 1；文件数 1」，并把这写成 `git diff --name-only 8c42cfc2 b57e5cb8` 的结果。
**审计方独立比对 GitHub 后指出：`8c42cfc2...b57e5cb8` 为 `ahead_by=2 / total_commits=2`，变更 3 个文件**
（`AI-ARCHITECT-INBOX.md`、U2 设计文档、`docs/releases/SI-RSI-INTERNAL-CODE-REPAIR-V1.md`）。
**审计方判断正确，送审方声明有误**：被误当作 R13→R14 范围的，其实是 **R14 设计提交自身** 的范围
（`1c7d51ac..b57e5cb8` = **1 提交 / 1 文件**）。

更正后的准确口径（本仓库实测）：

```text
R13_TO_R14_AUDIT_SCOPE   = 8c42cfc2..b57e5cb8 = 2 commits / 3 files
  1) 1c7d51ac  MSG-20261009-38 裁决逐字归档 + checkpoint §2.42（AI-ARCHITECT-INBOX.md、SI-RSI-INTERNAL-CODE-REPAIR-V1.md）
  2) b57e5cb8  U2 设计 R14（SI-RSI-INTERNAL-CODE-REPAIR-V1-PHASE3A-U2-DESIGN.md）
R14_DESIGN_COMMIT_ONLY    = 1c7d51ac..b57e5cb8 = 1 commit / 1 file
PRODUCT_CODE_CHANGES      = 0（git diff b57e5cb8 -- apps/api 无输出；全历史至 HEAD 亦为零）
```

后续送审**必须**同时给出「审计范围」与「单提交范围」两个口径，避免再次混淆。

**审计方独立核验（属实项）**：Git blob SHA `66549c714a7c43316bacb3608bfc758462e64e9e` **匹配**、
`AutonomyCandidate` 模型字段匹配、候选状态 CHECK 已确认、**所查迁移未为 `AutonomyCandidate` 建 append-only 触发器**。
**未验证**：数据库运行时权限、数据库实际部署状态、U2 实施测试。

**七项裁决**：`CHANGE 47（P0）= REVISE`（E1/E2 合理，**E3 持续持锁证明仍不充分**）、
`CHANGE 48（P0）= PASS WITH REVISE`（核心 Linux 语义已纠正；生命周期控制仍有缺口）、
`CHANGE 49（P1）= PASS（设计清单）`（测试场景覆盖主要失效模式，**执行仍未验证**）、
`CHANGE 50（P1）= PASS WITH REVISE`、`CHANGE 51（P1）= PASS WITH REVISE`（准入门禁成立；仓库级事实大体得到支持，
但**不得扩大为运行库证明**）、`CHANGE 52（P1）= PASS WITH REVISE`（规范基本统一，解析边界仍需明确）、
`CHANGE 53（P0）= PASS WITH REVISE`（原子消费方向正确，须明确实际消费存储与副作用边界）。
`U2_DESIGN_R14_ACCEPTED = NO`、`U2_PLATFORM_ONLY_INSERT_SUBSET = NOT_AUTHORIZED`。

**新增 REQUIRED_CHANGES（下一轮 MSG-20261009-40 只做这七项；`R15` 纯设计修订 + 只读证据收集）**

- **CHANGE 54（P0）`T0` 扫描与 `T1` 取锁的时序矛盾**：`T0` 尚未取得锁，**不能**要求此刻「恰好一个命中＝当前实例的持锁 FD」；
  须按 `T0`（不得要求本实例已持锁）/`T1`（创建并持有锁 FD、取得 `E1`）/`T2`（验证受控 FD 生命周期与持续互斥）分阶段定义：
  检查对象、**合法 FD 集合**、失败码与检测证据的**局限**；并区分「**同一 inode 的其他 FD**」与「**同一 OFD 的复制 FD**」
  （仅凭 `(dev,inode)` 相同**不能**判定是否引用同一打开文件描述）。
- **CHANGE 55（P0）`E3` 持续持锁证明未闭环**：`E1`/`E2` 是**历史观察**，FD 扫描**不能**证明锁仍有效
  （T1 取锁 → 程序错误 `LOCK_UN` → FD 仍开、inode 未变 → `T2` 扫描仍可能通过）。**须在 `T2` 门禁加入新的、独立打开 FD 的排他冲突探针**并记录结果；
  同时写明**探针是时点证明**：从最终探针到 `COMMIT` 之间须由**可信生命周期控制**维持原 OFD 的锁状态；无法证明该控制边界 ⇒ **拒绝写入**，不得仅依赖重复探测。
- **CHANGE 56（P1）进程派生与 FD 扫描须区分「检测」与「保证」**：`/proc` 扫描有竞态；inode 相同 ≠ OFD 相同；
  同 UID 进程可在两次扫描之间打开/关闭 FD；`fork` 后子进程关闭复制 FD 也会影响生命周期假设
  ⇒ 锁生命周期由**受控执行环境与 FD 操作约束**负责，扫描**只负责发现异常**、不承担完整性证明；不可控派生继续 fail-closed。
- **CHANGE 57（P1）COMMIT 归因不能仅凭主库记录存在性**：**仅「数据库确认完成显式 ROLLBACK」可直接推出 `NOT_COMMITTED`**；
  「COMMIT 请求失败但事务终态未知」「查询时主库无匹配记录」「查询时存在其他写入者创建的同键记录」三类
  均须满足**严格归因前提**才可升级结论，否则保持 `UNKNOWN`。
- **CHANGE 58（P1）全局不可变性证据不得超出仓库范围**：认可仓库核验方向，结论严格限定为
  `REPOSITORY_SCHEMA_EVIDENCE_PARTIALLY_VERIFIED`；实际数据库的权限、触发器、角色、写入者全集与观察窗口不可变性仍 `NOT_VERIFIED`。
- **CHANGE 59（P1）字节编码与 Git 命令边界三项断言**：①字段/记录分隔须**字节级无歧义**（不得把 Git 文本输出当一般字符串表格解析）；
  ②规范排序须基于原始字节，**不允许**解码后重新编码改变非 ASCII 字节；③原始字节的保存、长度前缀计算与摘要生成须使用**同一字节序列**；
  任何解析异常 ⇒ `BASELINE_PARSE_FAILED` 且**不产生部分 digest**。
- **CHANGE 60（P0）`signerAuthRef` 原子消费的持久化边界**：须落实到**现有可核验的存储对象**——
  ①`T0` 占用成功后 `T1`/`T2` 失败时 nonce 是否永久保持已消费；②崩溃时消费记录是否**已持久提交**；③消费记录**未提交**时能否宣称该 nonce 已消费；
  ④若使用数据库，该写入是否与「U2 仅 INSERT 候选记录」的实施范围**冲突**。
  规范语义：**一经成功且持久确认的消费不得恢复为可用**；后续失败只能**重新签发授权**，不得抢占旧 nonce；
  且须明确区分「**已成功消费的授权状态**」与「**尚未发生的候选业务写入**」；在权威存储、唯一约束与事务边界无证据前**不得开放实施**。

```text
MSG-20261009-39_FINAL_VERDICT = REVISE
MSG-20261009-39_ARCHIVED = AI-ARCHITECT-INBOX.md（FULL_COPY_OK 187/187；FNV1A 6db509f7）
R13_TO_R14_AUDIT_SCOPE = 2 commits / 3 files（送审误写为 1/1，已按 2.43.0 更正）
U2_DESIGN_R14_ACCEPTED = NO · U2_IMPLEMENTATION_AUTHORIZED = NO · U2_PLATFORM_ONLY_INSERT_SUBSET = NOT AUTHORIZED
REQUIRED_CHANGES = CHANGE_54_P0 ; CHANGE_55_P0 ; CHANGE_56_P1 ; CHANGE_57_P1 ; CHANGE_58_P1 ;
                   CHANGE_59_P1 ; CHANGE_60_P0
NEXT_AUTHORIZED = PHASE3_A_U2_DESIGN_R15_READ_ONLY_CHANGES_54_TO_60
NEXT_AUDIT = MSG-20261009-40
SCHEMA_MIGRATION = HOLD · RUNTIME_WIRING / MODEL_CALL / PROVIDER_CALL = FORBIDDEN
EXTERNAL_WRITE = HOLD · AUTO_MERGE / AUTO_DEPLOY = FORBIDDEN · PRODUCTION_READY = NO
POSTGRESQL_INTEGRATION_TEST / VITEST / TSC / LINUX_SYSTEMD / CI / PRODUCTION = NOT_VERIFIED
DB_RUNTIME_PRIVILEGE_VERIFICATION / GLOBAL_IMMUTABILITY_PROOF = NOT_VERIFIED
```

---

### 2.44 MSG-20261009-40 裁决归档 = **REVISE**（R15：4 项 PASS / 2 项 PASS WITH REVISE / 1 项 REVISE；只新增 CHANGE 61–63）

> 逐字归档：`AI-ARCHITECT-INBOX.md`（段落 `### [MSG-20261009-40] …`），
> `tools/verdict-diff/compare.mjs` = **FULL_COPY_OK（166/166，缺失 0，多出 0）**；
> 规范化指纹 = `NORM_CHARS=4039 / NORM_LINES=166 / FNV=d1af5162`。
> 锚点：`U1_CODE_HEAD=9ee36837`、`U2_DESIGN_COMMIT_R14=b57e5cb8`、`REVIEWED_HEAD=52308673`。

**审计方独立核验（本轮全部 PASS）**：固定提交存在、比较区间 `54e14e66..52308673`、**提交数 1 / 文件数 1**（仅 U2 设计文档）、
`+204 / −9`、`apps/api` 产品代码变更 **0**、**Git blob SHA `4039241295d5a3e3a03a9d53473bbdf7564342ba` 匹配**、
`U2 已实施 = NO`、`U2 实施授权 = NO`；并强调**三个状态不可互相推出**：
`U2_DESIGN_ACCEPTED` / `U2_IMPLEMENTATION_AUTHORIZED` / `PRODUCTION_READY`。
（**上一轮的送审范围误述已不再出现**：本轮双口径 `AUDIT_SCOPE` 与 `SINGLE_COMMIT_SCOPE` 一致，均为 1 提交 / 1 文件。）

**逐项裁决**：`CHANGE 54 = PASS`（T0/T1/T2 时序矛盾已消除；L0/L1、inode 与 OFD 的区别及失败码已明确）、
`CHANGE 55 = REVISE`、`CHANGE 56 = PASS`（检测与保证的职责已区分，扫描竞态与局限已承认）、
`CHANGE 57 = PASS WITH REVISE`（四类结果分流合理，但 `COMMITTED` 归因仍需防止其他写入者造成假阳性）、
`CHANGE 58 = PASS`（仓库证据与运行库事实分离，未越界声称生产数据库已验证）、
`CHANGE 59 = PASS`（原始字节、排序与摘要使用规则已明确；**此项为设计通过，不是解析器测试通过**）、
`CHANGE 60 = PASS WITH REVISE`（持久化与实施范围边界已写明，但未确认提交后的授权状态还需进一步明确）。
`U2_DESIGN_R15_ACCEPTED = NO`、`U2_PLATFORM_ONLY_INSERT_SUBSET = NOT_AUTHORIZED`。

**CHANGE 55 为何仍 REVISE（本轮最重要新增问题）**：`P2` 收到 `EWOULDBLOCK` **只证明存在冲突锁，不证明该锁由本实例持有**。
反例：本实例 `T1` 取锁 → 本实例**误释放锁但未关闭 FD** → **另一进程取得同一锁对象的排他锁** →
本实例执行 `P2` 得到 `EWOULDBLOCK`，且 FD 扫描未及时发现另一进程 ⇒ `P2` 通过，但本实例**已失去锁所有权**。
因此 R15 §23.2.5 的「误释放后 `P2` 必然成功取锁」**不能作为无条件结论**（仅在确认不存在其他冲突持有者时才成立）。

**新增 REQUIRED_CHANGES（下一轮 MSG-20261009-41 只做这三项；不重复已闭合的 CHANGE 54/56/58/59）**

- **CHANGE 61（P0）`P2` 不能直接证明锁归本实例所有**：①`P2_EWOULDBLOCK` 定义为**必要但非充分**证据；
  ②锁所有权须由**可信 FD/OFD 生命周期保证**与**持锁状态证据**共同支持；③`P2` 的失败原因必须区分 `EWOULDBLOCK` 与权限错误、无效 FD 等其他错误；
  ④`P2` **意外取得锁**时，必须确保探针 FD 及其获得的锁**安全释放**，并**拒绝本次业务写入**；
  ⑤新增「**本实例提前释放、第三方随后取锁**」的多进程反例测试，要求**零候选写入**；
  ⑥建议错误码 `LOCK_OWNERSHIP_UNPROVEN` 或既有 `EXCLUSIVE_WINDOW_UNAVAILABLE`；
  ⑦跨进程 FD 扫描只能在**明确支持并可验证的 Linux 隔离环境**内作为**辅助检测**，**不能**作为锁所有权的**权威来源**。
- **CHANGE 62（P1）`COMMITTED` 归因需证明执行身份**：相同主键、相同候选内容、相同时间窗口**不必然**等于同一次执行提交
  ⇒ 须补充**独立执行身份关联**（受信任、不可变的 `executionRef` 或等价事务关联证据），并说明其来源与**可否被其他写入者伪造**；
  若现有 schema **不支持**该归因，**不得**因重读到匹配行就宣称当前事务 `COMMITTED`；
  且必须区分 `CANDIDATE_EXISTS` 与 `THIS_EXECUTION_COMMITTED`（两者不是同一结论）。
- **CHANGE 63（P1）nonce 消费状态必须具有 UNKNOWN 分支**：①数据库明确确认消费事务**回滚** ⇒ 可报告没有成功消费；
  ②消费事务**提交结果不可知** ⇒ 必须报告 `CONSUMPTION_UNKNOWN`，**不得**报告 `UNCONSUMED`，也**不得**擅自报告 `CONSUMED`；
  ③`CONSUMPTION_UNKNOWN` 下当前执行应**终止**、旧 `nonce` **不可重试**，后续只能**重新签发授权**；
  ④若消费事务**实际已提交**，旧 `nonce` **必须仍保持已消费**——**即使业务候选记录尚未写入，也不得释放旧授权**。

**审计方对上一轮两处询问的回应**：已读取固定提交下 Prisma schema 相关片段，确认其中声明了相应唯一键与消费者交付幂等结构；
**接受**「模式先例不代表可复用」的表述，但**不**由此推导 U2 `nonce` 消费存储已存在、可直接复用或已获写入授权。

```text
MSG-20261009-40_FINAL_VERDICT = REVISE
MSG-20261009-40_ARCHIVED = AI-ARCHITECT-INBOX.md（FULL_COPY_OK 166/166；FNV1A d1af5162）
CHANGE_54=PASS · CHANGE_55=REVISE · CHANGE_56=PASS · CHANGE_57=PASS_WITH_REVISE · CHANGE_58=PASS ·
CHANGE_59=PASS · CHANGE_60=PASS_WITH_REVISE
U1_FINAL_CLOSURE = YES（沿用封板）· U2_DESIGN_R15_ACCEPTED = NO
U2_IMPLEMENTATION_AUTHORIZED = NO · U2_PLATFORM_ONLY_INSERT_SUBSET = NOT_AUTHORIZED
U2_NONCE_CONSUMPTION_STORE = NOT_VERIFIED
REQUIRED_CHANGES = CHANGE_61_P0 ; CHANGE_62_P1 ; CHANGE_63_P1
NEXT_AUTHORIZED = PHASE3_A_U2_DESIGN_R16_READ_ONLY_CHANGES_61_TO_63
NEXT_AUDIT = MSG-20261009-41
SCHEMA_MIGRATION = HOLD · RUNTIME_WIRING / MODEL_CALL / PROVIDER_CALL = FORBIDDEN
EXTERNAL_WRITE = HOLD · AUTO_MERGE / AUTO_DEPLOY = FORBIDDEN · PRODUCTION_READY = NO
POSTGRESQL_INTEGRATION_TEST / VITEST / TSC / LINUX_SYSTEMD / CI / PRODUCTION = NOT_VERIFIED
```

---

### 2.45 MSG-20261009-41 裁决归档 = **REVISE**（R16：`CHANGE 63 = PASS（DESIGN ONLY）`；61/62 继续修订；只新增 CHANGE 64–66）

> 逐字归档：`AI-ARCHITECT-INBOX.md`（段落 `### [MSG-20261009-41] …`），
> `tools/verdict-diff/compare.mjs` = **FULL_COPY_OK（132/132，缺失 0，多出 0）**；
> 规范化指纹 = `NORM_CHARS=3940 / NORM_LINES=132 / FNV=89c9d657`。
> 锚点：`U1_CODE_HEAD=9ee36837`、`U2_DESIGN_COMMIT_R15=52308673`、`REVIEWED_HEAD=97dee91e`。

**审计方独立核验（全部 PASS）**：`a43d1b8a..97dee91e` 恰好 **1 提交 / 1 变更文件**、唯一变更文件为 U2 设计文档、`+190 / −9`、
**无 `apps/api` 产品代码变更**、**Git blob SHA `ba849c495b567fe04a9dce98d3d7186a6f0ec548` 与送审值一致**、
已读取固定 HEAD 下 `AutonomyCandidate` Prisma 模型并**确认现有模型没有 `executionRef` 字段**、
`DOC_SHA256_INDEPENDENTLY_VERIFIED = NO`；并重申「**仓库证据核验 ≠ 目标 Linux 内核 / 真实 PostgreSQL / 运行时安全性验证**」。
（**送审范围口径连续两轮通过**：本轮 `AUDIT_SCOPE` 与 `SINGLE_COMMIT_SCOPE` 一致，均为 1 提交 / 1 文件。）

**逐项裁决**：`CHANGE 61（P0）= REVISE`（**核心纠错通过**：R16 §24.1 已正确撤回「`P2` 返回 `EWOULDBLOCK` 即证明本实例持锁」；
O1/O2/O3 职责分离、`P2` 错误分类、异常探针释放、跨进程 FD 扫描降级为辅助证据**均可接受**；仍有两项边界见 CHANGE 64/65）、
`CHANGE 62（P1）= REVISE`（**存在性与提交归因的区分通过**；归因证据链仍不充分，见 CHANGE 66）、
`CHANGE 63（P1）= PASS（DESIGN ONLY）`。`U2_DESIGN_R16_ACCEPTED = NO`、`U2_PLATFORM_ONLY_INSERT_SUBSET = NOT_AUTHORIZED`。

**新增 REQUIRED_CHANGES（下一轮 MSG-20261009-42 只做这三项；不重复已通过项）**

- **CHANGE 64（P0）`O3` 查询机制不能预设具备所有权证明能力**：`F_OFD_GETLK` 是**冲突查询**接口，
  **不是**「查询本 OFD 是否持锁」的接口 ⇒ **不得**单独视为自身持锁的肯定证明；
  `/proc/self/fdinfo` 的锁信息须验证**锁类型、目标对象、锁范围与 OFD 归属**，而不仅是「存在锁条目」；
  若查询只能证明「存在冲突锁」而不能证明「属于目标 OFD」⇒ **`O3 = INCONCLUSIVE`**；
  `O3` 不可用时**仅**可在 `O2` 的持续持锁结构保证**确实成立**的条件下继续，否则**拒绝写入**。
  新增 **U2-47a**：本实例释放锁、另一进程接管 ⇒ `O3` **不得**错误报告本实例仍持有。
- **CHANGE 65（P1）`O2` 必须覆盖无法通过计数器观测的释放路径**：`releaseCounter == 0` **不能替代**真实的结构保证
  （例如某个**未通过锁管理模块**的原生调用执行了 `close(fd)`，计数器可能仍为零）。R17 须明确：
  ①锁 FD 的**创建、持有、传递与释放接口必须统一封装**；②纳入 **native addon、FFI、子进程继承、异常退出**等适用运行环境边界；
  ③对**不能证明受统一管理**的代码路径，**禁止进入排他写入窗口**；④持锁证明应覆盖**整个实际写入窗口**，
  **不得**仅在 `T2` 瞬间成立。
- **CHANGE 66（P0）执行身份必须与数据库提交事件建立可信因果绑定**：反例（审计方给出）：
  E1 生成 `executionRef=A` → E1 提交候选记录时**连接中断、提交结果未知** → 另一具备写入权限的执行者 E2
  **获得或使用相同候选 ID** 并插入**内容一致**的候选行 → E1 的事务外持久记录仍含 `{A, candidateId, dedupeKey, attemptNo}` →
  E1 事后查询主库发现候选行与记录一致 ⇒ **仍无法证明该行由 E1 提交**（随机身份能证明「执行记录的身份」，不能自动证明「数据库行的创建者」）。
  R17 必须补充**至少一种可审计的因果绑定机制**（设计候选，**不代表**当前 schema 或运行环境已支持）：
  ①可信的**同事务数据库审计记录**，能够关联执行身份与候选插入；②可证明**只有本次事务**有能力使用该特定写入凭证的**隔离机制**；
  ③由受信数据库写入边界提供、**可持久验证的事务回执**。在 `SCHEMA_MIGRATION=HOLD` 且缺少可信因果绑定机制的情况下，
  应**明确允许** `candidateExists=YES` 而 **`thisExecutionCommitted=UNKNOWN`**，**不得**强行升级为 `YES`。
  新增 **U2-47b**：E1 结果未知、其他写入者 E2 插入内容一致的行、E1 外部记录仍存在 ⇒ **必须拒绝**将该行归因于 E1。

**CHANGE 63 的通过要点（不再修订）**：三分支（`CONSUMED`/`UNCONSUMED`/`CONSUMPTION_UNKNOWN`）；
未知终态不得误报已消费或未消费；未知消费状态**按不可复用执行安全策略但不改变事实报告**；
授权消费状态与候选写入状态**独立报告**；消费记录不得因候选写入失败被清理或复位；`U2-46a`~`U2-46d` 均有对应断言。
**但**通过的是**文档设计审查**——实际消费存储、事务状态确认与并发测试仍为 `NOT_VERIFIED`。

```text
MSG-20261009-41_FINAL_VERDICT = REVISE
MSG-20261009-41_ARCHIVED = AI-ARCHITECT-INBOX.md（FULL_COPY_OK 132/132；FNV1A 89c9d657）
CHANGE_61=REVISE · CHANGE_62=REVISE · CHANGE_63=PASS_DESIGN_ONLY
U2_DESIGN_R16_ACCEPTED = NO · U2_IMPLEMENTATION_AUTHORIZED = NO · U2_PLATFORM_ONLY_INSERT_SUBSET = NOT_AUTHORIZED
REQUIRED_CHANGES = CHANGE_64_P0 ; CHANGE_65_P1 ; CHANGE_66_P0
NEXT_AUTHORIZED = PHASE3_A_U2_DESIGN_R17_READ_ONLY_CHANGES_64_TO_66
NEXT_AUDIT = MSG-20261009-42
GIT_BLOB_VERIFIED = YES · DOC_SHA256_INDEPENDENTLY_VERIFIED = NO
SCHEMA_MIGRATION = HOLD · RUNTIME_WIRING / MODEL_CALL / PROVIDER_CALL = FORBIDDEN
EXTERNAL_WRITE = HOLD · AUTO_MERGE / AUTO_DEPLOY = FORBIDDEN · PRODUCTION_READY = NO
POSTGRESQL_INTEGRATION_TEST / VITEST / TSC / LINUX_SYSTEMD / CI / PRODUCTION = NOT_VERIFIED
```

---

### 2.46 MSG-20261009-42 裁决归档 = **REVISE**（R17：`CHANGE 64/65 = PASS WITH REVISE`、`CHANGE 66 = REVISE`；只新增 CHANGE 67–72，其中 68/70/71 为 P0）

> 逐字归档：`AI-ARCHITECT-INBOX.md`（段落 `### [MSG-20261009-42] …`），
> `tools/verdict-diff/compare.mjs` = **FULL_COPY_OK（177/177，缺失 0，多出 0）**；
> 规范化指纹 = `NORM_CHARS=5549 / NORM_LINES=177 / FNV=4c3ca834`。
> 锚点：`U1_CODE_HEAD=9ee36837`、`U2_DESIGN_COMMIT_R16=97dee91e`、`REVIEWED_HEAD=c9ec3eca`。
> **取证过程备注**：该裁决因 Codex 浏览器自动化会话令牌失效（`Codex auth token is unavailable`）而延迟取回；
> 通道恢复后由**单个** markdown 容器 `innerText` 取得，并在归档前做**稳定性复核**（25 秒内两次采样长度均为 5848、
> 无「停止生成」控件、尾句为完整结论句）⇒ 视为生成完成后再归档（未采用中断时的 3729 字符采样）。

**审计方独立核验（全部 PASS）**：审计范围 `613ecfc2..c9ec3eca` = **1 commit / 1 file**、唯一变更文件为 U2 设计文档、
差异 `+168 / −9`、范围内**无 `apps/api` 产品代码变更**、diff 确实包含 **§25.1–§25.4**。
审计方并确认两项关键修正成立：**承认 `F_OFD_GETLK` 不能单独证明自身持锁**、**`candidateExists=YES` 不代表 `thisExecutionCommitted=YES`**。

**逐项裁决**：`CHANGE 64（P0）= PASS WITH REVISE`（三值分级方向正确；否定证据语义须收紧）、
`CHANGE 65（P1）= PASS WITH REVISE`（`releaseCounter=0 ≠ 锁仍被持有` 已解决；统一边界/唯一释放点/全窗口覆盖正确）、
`CHANGE 66（P0）= REVISE`（M1–M4 为设计候选，M1 优先在目标 PostgreSQL 验证，但前提与升级风险须明确）。
`U2_DESIGN_R17_ACCEPTED = NO`、`U2_PLATFORM_ONLY_INSERT_SUBSET = NOT_AUTHORIZED`、`U1_REOPEN = NO`。

**新增 REQUIRED_CHANGES（下一轮 MSG-20261009-43 只做这六项；已通过项不重复提交）**

- **CHANGE 67（P1）明确 `O3-CONTRADICTED` 的证据边界**：他方 OFD 持有冲突锁**只证明存在外部冲突**，
  **不必然**证明「本 OFD 曾持有的锁已提前释放」；须结合**锁类型、锁范围、查询身份与锁生命周期**；
  `O3-CONTRADICTED` = **已有充分证据推翻持锁不变量**，而非一般性查询异常；
  「不能证明已释放、也不能证明仍有效」⇒ `INCONCLUSIVE`；任何不满足锁族/锁范围/OFD 身份匹配的查询**不得升级为 `PROVEN`**；
  一旦无法确认排他性，**无论错误标签如何，写入门禁仍必须 fail-closed**。
- **CHANGE 68（P0）统一实际锁协议，禁止混用不兼容锁族**：Linux 上 `flock(2)` 与 `fcntl` OFD 记录锁**通常是相互独立的锁体系**，
  **不能假定彼此互斥** ⇒ 必须明确**唯一选定的生产锁协议**（统一 `flock(LOCK_EX)`，或统一 `F_OFD_SETLK/F_OFD_SETLKW`）；
  所有参与排他写入的进程使用**相同协议、相同规范化锁对象、兼容锁范围**；
  **不允许**进程 A 用 `flock`、进程 B 用 OFD 记录锁却视为同一互斥域；
  测试须含**混合锁协议负面用例**——出现两个进程**同时认为自己持有排他锁**即**验收失败**。
  **这是授权前的 P0 条件**（关系到排他窗口是否真实存在）。
- **CHANGE 69（P1）静态约束必须覆盖可执行调用路径**：将 `fcntl` 解锁、`dup2/dup3`、`F_DUPFD`、FD 传递、运行时原生依赖纳入**威胁模型**；
  明确经 `fork/spawn/exec`、线程共享或库调用**传递 FD 的边界**；对不能静态证明安全的依赖，须给出**目标环境隔离证据**，否则**禁止进入写入窗口**；
  测试中**故意绕过 `LockFdBoundary`**，必须确认系统**不会继续报告排他条件成立**；
  明确 **`O_CLOEXEC` 不是阻止 `fork` 后短暂继承 FD 的完整机制**，子进程继承与复制**必须单独验证**。
- **CHANGE 70（P0）M1 必须区分「事务归属」与「提交事件的持久证明」**：
  ①捕获 XID 的查询与候选 INSERT 必须位于**同一个真实数据库事务、同一事务上下文**；
  ②外部记录中的 XID、`executionRef`、`returnedCandidateId` 必须建立**受信绑定**（**单纯可修改的外部 JSON 文件不够**）；
  ③事务外持久记录**必须在 `COMMIT` 前完成持久化确认**；**该记录持久化失败 ⇒ 不得启动 `COMMIT`**；
  ④**不得**因外部记录存在而认定 `COMMIT` 成功，仍须在**权威主库**确认目标行存在且系统列匹配；
  ⑤外部记录丢失/损坏/身份无法认证/事务 ID 不匹配 ⇒ 一律 **`UNKNOWN`**，**不得凭内容相似补全归因**；
  ⑥明确：若 `COMMIT` 已成功而外部对账记录不可恢复 ⇒ 系统**可能永久无法确认本次执行**，
  此时选择 `UNKNOWN` **是正确安全行为**，**而不是让另一执行重新创建相同候选**。
- **CHANGE 71（P0）修订 `xmin` 的时间与行版本语义**：`xmin` 表示**当前可见行版本**的插入事务标识，
  **不天然代表逻辑业务记录一生中唯一的创建事务**；官方亦警告**不应长期依赖 32 位事务 ID 的唯一性** ⇒ 还须规定：
  从事务标识捕获到提交结果确认的**有效时间与事务 ID 生命周期边界**；明确处理 **`VACUUM FREEZE`、表重写**
  及其他可能影响**行版本来源判断**的数据库维护场景；**不得**以「`xmin` = xid8 低 32 位」作为**唯一**判断条件，
  还须能证明其属于**同一个 XID epoch**；无法证明版本来源连续性 ⇒ **`UNKNOWN`**；
  测试须包含「**低 32 位 XID 重复但完整事务身份不同**」的情形。
- **CHANGE 72（P1）补足 M1 的反例验收（U2-50a ~ U2-50f）**：
  `U2-50a` 外部记录落盘成功但事务回滚 ⇒ `UNKNOWN` 或明确未提交，**不得 YES**；
  `U2-50b` `COMMIT` 成功但外部因果记录不可验证 ⇒ `UNKNOWN`；
  `U2-50c` E2 创建内容相同但事务 XID 不同的行 ⇒ **不得归因 E1**；
  `U2-50d` 行版本经过冻结/重写或生命周期无法确认 ⇒ `UNKNOWN`；
  `U2-50e` 同一逻辑 `candidateId` 的行被删除重插 ⇒ **不得**据相同 ID 与 digest 判 YES；
  `U2-50f` XID 与行版本匹配但外部记录的 execution 身份不可认证 ⇒ `UNKNOWN`。
  **通过上述测试**才能把 M1 从「合理候选」推进为「可独立验证的因果绑定」。

**审计方指出的三个实施前提（缺一不得授权）**：①**排他性证明**（统一锁协议确定 + `O2` 全窗口结构保证可落地并验证）；
②**提交归因证明**（M1–M4 至少一种具有明确因果证据契约，且能安全处理 `UNKNOWN`）；③**环境证据**（Linux 多进程测试、`LockFdBoundary` 规则、PostgreSQL 事务绑定、数据库实际权限）。
设计阶段不要求先完成全部生产测试，但**不得把尚未明确的核心安全契约留给实施时临时决定**。

```text
MSG-20261009-42_FINAL_VERDICT = REVISE
MSG-20261009-42_ARCHIVED = AI-ARCHITECT-INBOX.md（FULL_COPY_OK 177/177；FNV1A 4c3ca834）
CHANGE_64=PASS_WITH_REVISE · CHANGE_65=PASS_WITH_REVISE · CHANGE_66=REVISE
U2_DESIGN_R17_ACCEPTED = NO · U2_PLATFORM_ONLY_INSERT_SUBSET = NOT_AUTHORIZED · U1_REOPEN = NO
REQUIRED_CHANGES = CHANGE_67_P1 ; CHANGE_68_P0 ; CHANGE_69_P1 ; CHANGE_70_P0 ; CHANGE_71_P0 ; CHANGE_72_P1
NEXT_AUTHORIZED = PHASE3_A_U2_DESIGN_R18_READ_ONLY_CHANGES_67_TO_72
NEXT_AUDIT = MSG-20261009-43
SCHEMA_MIGRATION = HOLD · RUNTIME_WIRING / MODEL_CALL / PROVIDER_CALL = FORBIDDEN
EXTERNAL_WRITE = HOLD · AUTO_MERGE / AUTO_DEPLOY = FORBIDDEN · PRODUCTION_READY = NO
POSTGRESQL_INTEGRATION_TEST / VITEST / TSC / LINUX_SYSTEMD / CI / PRODUCTION = NOT_VERIFIED
```
