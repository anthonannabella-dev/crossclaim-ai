# RSI 自治控制层 —— Phase-1 计划与复用清单

> 依据：OWNER 任务「正式加入 RSI（Bounded Recursive Self-Improvement）自治控制层」。
> 原则：**先审计现有代码，能复用则复用，不重复建设**；RSI 属于仓库本身，不绑定本地 Codex 会话。

## 1. 终局闭环（固定生命周期）

OBSERVE → DETECT → DIAGNOSE → CREATE INCIDENT → GENERATE TASK → CREATE CANDIDATE → PATCH → SANDBOX → REPLAY → TEST → BENCHMARK → SECURITY/POLICY CHECK → INDEPENDENT JUDGE → PROMOTE/REJECT → MONITOR → ROLLBACK IF REGRESSION

要求：问题本身能自动生成下一项任务；不得依赖 OWNER 反复发「继续」。

## 2. 自治等级（Phase-1 实际启用）

| 等级 | 含义 | Phase-1 |
| --- | --- | --- |
| L0 OBSERVE | 只读 logs/metrics/CI/benchmark/outcome/API contract | ENABLED |
| L1 PROPOSE | 自动创建 Incident / Task / Improvement Proposal | ENABLED |
| L2 PATCH | 受控 workspace/branch 内改代码、prompt、parser、adapter、fixtures、tests | ENABLED（受控分支） |
| L3 VALIDATE | unit/integration/PG regression/replay/benchmark/typecheck/security/policy/judge | ENABLED |
| L4 AUTO_PROMOTE_LOW_RISK | 低风险白名单自动 promote | **OFF（默认关闭）** |
| L5 PRIVILEGED | 特权动作 | **永不由 RSI 自主开启** |

## 3. 永久 OWNER / Policy Gate（RSI 永远不得自我授权）

External Write、Production Credentials、Payment、Commission Capture、Real Claim Submit、Real Appeal Submit、Customs Filing、Broker Privileged Execution、Production Provider Credential、Security Policy Downgrade、Permission Expansion、Destructive Migration、Customer Data Deletion、Kill Switch Disable。

固定路径：RSI Proposal → Validation → Independent Audit → OWNER / Policy Approval → Unlock。**禁止**「自己测试通过就给自己更高权限」。

## 4. 事件驱动（替代空转心跳）

触发器：CI_FAIL / RUNTIME_ANOMALY / API_SCHEMA_DRIFT / UNKNOWN_PROVIDER_ERROR / AUTH_FAILURE_SPIKE / BENCHMARK_REGRESSION / OUTCOME_MISMATCH / COST_SPIKE / MODEL_REGRESSION / HUMAN_INTERVENTION_SPIKE / RECOVERY_PRECISION_DROP。无问题时保持安静；保留 Daily Health Scan 与 Weekly Optimization Review，但同样「有变化才产生有效任务」。

## 5. 复用清单（先审计，再动手）

**已存在、必须复用（不得重建）**：

- 审计/裁决通道：`AI-ARCHITECT-INBOX.md` + `tools/verdict-diff/compare.mjs` + `tools/verification/archive-verdict.mjs`（Builder/Judge 隔离的现成载体）。
- 执行证据通道：`tools/autopilot/*`（backlog / dispatcher / runner / watchdog / record-ci-status / record-evidence）。
- 门禁：`tools/api-contract`、`tools/audit-coverage`、`tools/autopilot/check-autopilot-rules`、`tools/i18n/check-i18n`、`tools/tenant-triggers/*`。
- 真实 PG 验证：`tools/verification/run-db-test-on-ephemeral.mjs`、`c18-exact-order-replay.mjs`（一次性库 + DROP）。
- 业务侧告警素材：C18 生命周期/binding store、Carrier/Broker 会话、SEO indexability gate 与投影契约。

**Phase-1 需要新建（最小面）**：Incident/Task/Candidate/EvaluationRun 的**契约与状态机**（纯函数 + 测试），以及只读 Observer（CI/日志/测试结果）与 Candidate→Replay→Benchmark→Judge 的编排骨架。

## 6. 数据模型：先契约，后 schema

需要能表达：AutonomyIncident / AutonomyTask / Experiment / CandidateVersion / EvaluationRun / MetricResult / PromotionDecision / RollbackRecord / OutcomeReference / RegressionFixtureReference，并满足 tenant isolation、baseline→candidate lineage、immutable evaluation evidence、model/prompt/commit/corpus 版本、promotion/rejection reason、rollback target、时间与 actor 身份。

**边界**：新增表 = Schema Delta = 高风险边界。Phase-1 先落**纯契约 + 不可变证据结构**（不建表、不改 schema.prisma、不写 migration）；确需持久化时单独送审 Schema Delta，并按仓库规范使用 append-only / immutable evidence 触发器。

## 7. Phase-1 E2E 的完成定义（CLOSED 条件）

1. 契约与状态机：Incident → Task → Candidate → EvaluationRun → PromotionDecision → (RollbackRecord) 全链路纯函数可测，非法跃迁 fail-closed。
2. 只读 Observer：能从现有产物（CI 结果、测试输出、backlog/STATE）生成**脱敏**信号，不读客户数据、不读凭据。
3. 自动任务生成：信号 → Incident → Task（含 risk_class 与是否需要审计），重复信号去重（同一 signal 不重复建任务）。
4. Builder/Judge 隔离：Candidate 必须经过确定性测试 + replay/benchmark，再进入独立 Judge；**同一执行单元不得自评自批**。
5. 证据不可变：evaluation evidence 一旦写入不可改写（UPSERT 只允许新增）。
6. 无外部写：Phase-1 全程 External Write = HOLD、Payment = HOLD、TRANSPORT = false、Production Credentials = ABSENT。
7. 端到端演示：一条真实（脱敏）信号走完整闭环，并以 commit + 测试结果 + CI run 作为证据。

## 8. Watchdog 终止条件

当 RSI_CONTROL_PLANE = CLOSED、RSI_PHASE1_E2E = PASS/CLOSED、SAFE_CONTINUATION_QUEUE = EMPTY、WAITING_FOR_VERDICT = NO 时，停止开发期 5 分钟 Watchdog，改由 RSI Controller 事件驱动接管。
