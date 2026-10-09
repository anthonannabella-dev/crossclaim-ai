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

## 2. 阶段计划与当前状态

| PHASE | 内容 | 状态 |
| --- | --- | --- |
| 0 | 现有能力审计（本文件 §1） | **本轮完成** |
| 1 | 内部故障诊断中心（API_TIMEOUT / RATE_LIMIT / TOKEN_EXPIRED / SCHEMA_CHANGED / PARSER_FAILURE / … / UNKNOWN_ERROR 的确定性分类 → Incident） | NOT_STARTED |
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
INTERNAL_DIAGNOSIS = NOT_STARTED
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
FULL_REGRESSION = 基线 100% PASS（PHASE 3 收官）；本任务改动尚未开始
NEW_RELEASE_CANDIDATE = NOT_STARTED
INDEPENDENT_AUDIT = PENDING（PHASE 0 审计待送审）
PRODUCTION_READY = NO
HOST_ACTION_REQUIRED = 真实模型凭据（用于 PHASE 3/7 真实联调）；Linux 隔离执行环境（用于真实沙箱补丁验证）
```
