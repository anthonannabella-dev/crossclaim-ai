# RSI 控制面 —— 状态审计件（自动生成）

> 生成时间：2026-10-05T02:45:00.000Z；来源：`tools/autopilot/backlog.json`（RSI-* 条目 33 项）。
> 本文件由脚本生成，不手写状态；任何与 backlog 不一致之处以 backlog 为准。

## 1. 单元状态汇总

| 状态 | 数量 |
| --- | --- |
| IMPLEMENTED_PENDING_CI | 20 |
| READY | 8 |
| IMPLEMENTED_PENDING_HOST_VALIDATION | 1 |
| BLOCKED_ON_SCHEMA_DELTA_AUDIT | 1 |
| PARTIAL_IMPLEMENTED_PENDING_CI | 3 |

## 2. 单元明细

| ID | 状态 | 标题 |
| --- | --- | --- |
| `RSI-P1-01-lifecycle-contract` | IMPLEMENTED_PENDING_CI | RSI Phase-1：Incident/Task/Candidate/EvaluationRun/PromotionDecision 契约与状态机（纯函数 + fail-closed 非法跃迁） |
| `RSI-P1-02-readonly-observer` | IMPLEMENTED_PENDING_CI | RSI Phase-1：只读 Observer（CI/测试/backlog 信号 → 脱敏 signal），不读客户数据与凭据 |
| `RSI-P1-03-auto-task-generator` | READY | RSI Phase-1：signal → incident → task 自动生成 + 同 signal 去重 |
| `RSI-P1-04-builder-judge-separation` | READY | RSI Phase-1：Builder/Judge 隔离编排（确定性测试 + replay/benchmark → 独立 Judge） |
| `RSI-P1-05-immutable-evidence` | READY | RSI Phase-1：不可变 evaluation evidence 结构 + 追加式证据契约 |
| `RSI-P1-06-policy-engine` | READY | RSI Phase-1：Policy Engine（L0–L5 等级 + 永久 OWNER gate 硬编码禁止清单） |
| `RSI-P1-07-e2e-demo` | READY | RSI Phase-1 E2E：一条脱敏信号走完整闭环并以 commit/测试/CI 作为证据 |
| `RSI-RT-01-runtime-entry` | IMPLEMENTED_PENDING_CI | RSI Runtime 独立进程入口（start/stop/health/restart；不依赖聊天窗口） |
| `RSI-RT-02-supervisor-autostart` | IMPLEMENTED_PENDING_HOST_VALIDATION | 随系统自动启动与崩溃自动拉起（复用仓库现有部署标准；防 crash-loop） |
| `RSI-RT-03-health-state` | READY | RSI 自身 Watchdog 与健康状态暴露（STARTING/HEALTHY/DEGRADED/PAUSED/BLOCKED/FAILED） |
| `RSI-RT-04-admin-autonomy-page` | READY | OWNER/ADMIN 可见的 RSI 管理页（状态/等级/健康/incidents/开关） |
| `RSI-RT-05-kill-switch` | READY | RSI Kill Switch（暂停新 incident/candidate/patch/promotion；不删审计、不影响 baseline） |
| `RSI-RT-06-state-reconcile` | BLOCKED_ON_SCHEMA_DELTA_AUDIT | RSI 状态持久化与 reboot reconcile（不重复 incident/candidate/promotion） |
| `RSI-COST-01-policy-core` | IMPLEMENTED_PENDING_CI | RSI 成本控制：三级执行策略 + 预算 + Incident 熔断 + ModelRouterPort（已实现） |
| `RSI-COST-02-model-router-adapter` | IMPLEMENTED_PENDING_CI | Model Router 适配（DeepSeek/Qwen 低成本→强模型升级；凭据只在 Router 侧） |
| `RSI-COST-03-call-ledger` | IMPLEMENTED_PENDING_CI | AI 调用记录台账（incident/task/provider/model/tokens/cost/latency/result/retry；禁 secret） |
| `RSI-COST-04-admin-cost-panel` | PARTIAL_IMPLEMENTED_PENDING_CI | /admin/autonomy 成本面板（today/month：incidents、rule-resolved、low/strong 调用、tokens、cost、budget remaining） |
| `RSI-COST-05-cost-e2e` | IMPLEMENTED_PENDING_CI | 成本 E2E Test A–E（规则零 LLM / low-cost / 升级 strong / 预算熔断 / 熔断不递归） |
| `RSI-INSP-01-drift-detector` | IMPLEMENTED_PENDING_CI | RSI 巡检：功能漂移判定 + 业务不变量（已实现） |
| `RSI-INSP-02-daily-health-inspection` | IMPLEMENTED_PENDING_CI | Daily Health Inspection 任务（Runtime/API-Provider/Application 检查项；健康则静默） |
| `RSI-INSP-03-weekly-full-review` | IMPLEMENTED_PENDING_CI | Weekly Full-System Review（回归/集成/PG E2E/契约/golden/business invariants/AI benchmark/cost；机器可读结果） |
| `RSI-INSP-04-golden-fixtures` | PARTIAL_IMPLEMENTED_PENDING_CI | GoldenFixture 语料（Amazon/TikTok/Walmart/Shopify/carrier/POD/recovery/claim package/Customs 匹配与资格/授权/费用边界） |
| `RSI-INSP-05-production-to-fixture` | IMPLEMENTED_PENDING_CI | 生产问题 → 脱敏 → 新 GoldenFixture → 永久进入 Regression Corpus（需 Schema Delta 持久化） |
| `RSI-CONT-01-continuation-engine` | IMPLEMENTED_PENDING_CI | 事件驱动续跑引擎（E2E A–D 已过） |
| `RSI-CONT-02-controller-wiring` | IMPLEMENTED_PENDING_CI | 续跑引擎接入 RSI Controller（事件入口 + 60s tick） |
| `RSI-CONT-03-event-sources` | IMPLEMENTED_PENDING_CI | 事件源适配（CI/测试/verdict → 续跑事件 + 指纹去重） |
| `RSI-CONT-04-event-loop` | IMPLEMENTED_PENDING_CI | 宿主侧事件循环（只读源 → 指纹去重 → emit；60s 兜底 tick） |
| `RSI-CONT-05-local-sources` | IMPLEMENTED_PENDING_CI | 本地只读事件源（CI 结果 / verdict / 测试结果 artifact 解析） |
| `RSI-CONT-06-runtime-composition` | IMPLEMENTED_PENDING_CI | RSI Runtime 组装入口 rsi:run（本地源+事件循环+控制器+runner） |
| `RSI-RT-07-admin-health-panel` | PARTIAL_IMPLEMENTED_PENDING_CI | /admin/autonomy System Health 面板（展示层） |
| `RSI-RT-08-admin-autonomy-page` | IMPLEMENTED_PENDING_CI | /admin/autonomy 页面组装（健康 + 成本面板，只读快照） |
| `RSI-RT-09-admin-snapshot-generator` | IMPLEMENTED_PENDING_CI | Admin 快照生成器（健康 + 台账 → rsi-admin-snapshot-v1） |
| `RSI-RT-10-snapshot-publisher` | IMPLEMENTED_PENDING_CI | Admin 快照周期发布器（写 rsi-admin-snapshot-v1） |

## 3. 本机可复现证据（测试）

| 套件 | 用例 | 结果 |
| --- | --- | --- |
| `rsi-lifecycle` | 5 | PASS |
| `rsi-observer` | 5 | PASS |
| `rsi-runtime-config` | 5 | PASS |
| `rsi-controller` | 3 | PASS |
| `rsi-supervisor-policy` | 4 | PASS |
| `rsi-drift-detector` | 5 | PASS |
| `rsi-daily-inspection` | 4 | PASS |
| `rsi-weekly-review` | 3 | PASS |
| `rsi-golden-fixtures` | 3 | PASS |
| `rsi-cost-policy` | 5 | PASS |
| `rsi-model-router` | 4 | PASS |
| `rsi-cost-ledger` | 3 | PASS |
| `rsi-cost-e2e`（A–E） | 5 | PASS |
| `rsi-continuation-engine`（E2E A–D） | 4 | PASS |
| `rsi-controller-continuation` | 3 | PASS |
| `rsi-event-sources` | 3 | PASS |
| `rsi-event-loop` | 3 | PASS |
| `rsi-local-sources` | 3 | PASS |
| `rsi-run` | 4 | PASS |
| `rsi-admin-snapshot` | 3 | PASS |
| `rsi-admin-snapshot-publisher` | 3 | PASS |
| `rsi-fixture-pipeline` | 4 | PASS |

## 4. 机制状态

| 指标 | 值 |
| --- | --- |
| `EVENT_DRIVEN_CONTINUATION` | TRUE（事件驱动 + 指纹去重 + lease exactly-once） |
| `WATCHDOG_INTERVAL` | 60s（仅兜底） |
| `HEARTBEAT_DRIVES_EXECUTION` | FALSE |
| `NO_CHANGE_OUTPUT` | SILENT |
| `RSI_ENABLED` 默认 | true（AUTO_PROMOTE_LOW_RISK = false） |
| 永久 OWNER gate | 14 项，RSI 不可自我授权 |
| 部署入口 | `rsi:dev` / `rsi:start` / `rsi:run`；systemd 模板 `deploy/systemd/crossclaim-rsi.service` |

## 5. 未完成 / 阻塞（逐条）

1. **`RSI-RT-06` 状态持久化 Schema Delta**：等待建筑师裁决（GitHub issue #2 comment 5981902447）。
   受影响：reboot reconcile、lease 持久化、成本台账落库、GoldenFixture 归档。当前以「契约 + 内存实现 + 可注入 sink」推进。
2. **systemd 侧实测（Test A/B/D）**：需要 Alibaba Cloud Linux 主机；本机为 Windows 开发机，**不伪造证据**。
3. **非生产 staging `DATABASE_URL`**：C18 staging smoke 的前置（不阻塞 RSI 开发）。
4. **真实只读事件源接入生产路径**：`RSI_TASKS_PATH` / `RSI_CI_RESULTS_PATH` / `RSI_VERDICT_PATH` 需由宿主/流水线写入。
