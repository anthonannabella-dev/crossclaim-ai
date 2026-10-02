# PC-08 OPS READINESS CHECKPOINT

状态：**READY_FOR_REVIEW / IMPLEMENTATION CHECKPOINT**（待架构方裁决）
IMPLEMENTATION_HEAD = 7078d22
IMPLEMENTATION_HEAD_FULL = 7078d22ded00c2e4be8318b41986d58a644bc412
CI = SUCCESS · RUN_ID = 37042838449 · CI_HEAD = 7078d22
授权：MSG-20261003-93 ⑨（PC-08 OPS READINESS）。
边界：**TRANSPORT 不打开（恒 DISABLED）** · NO platform write · Payment = 0 · collection = OFF · 无生产凭据。

## 1. 范围逐项落地（MSG-93 PC-08 1–10）

| 项 | 要求 | 实现 |
|---|---|---|
| 1 监控 / 可观测性最小面 | 最小只读运维视图 | `GET /ops-readiness`（只读）：liveness / readiness / kill switch / Action Guard / 失败任务积压 / rate limit 策略 / transport / runbook 引用 / checkedAt；未引入新 observability 平台 |
| 2 rate limit 基线 | 最敏感匿名入口的基线限流 | `services/ops/rate-limit.ts` 进程内固定窗口；作用于 `POST /auth/login` 与 `POST /auth/signup`；超出 → `429 RATE_LIMITED` + `retry-after`；策略可用 `RATE_LIMIT_ENABLED` / `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX` 覆盖（默认 60s / 60 次） |
| 3 统一 failed-job / dead-letter 恢复入口 | 只读入口 + 明确指引 | `/ops-readiness.failedJobs` 暴露真实计数（importFailed / importPartial / claimItemReviewRequired）与平台写入账本引用；客户侧失败指引已由 PC-04 `/recovery-states` 提供（不重复实现） |
| 4 最小 operational runbook | 10 类场景 + 明确 operator steps | 新增 `docs/releases/PC-08-OPERATIONAL-RUNBOOK.md`：DB failure / migration failure / storage failure / login·session issue / import failure / provider auth failure / reconciliation issue / settlement mismatch / kill switch procedure / rollback procedure |
| 5 structured logging sanity | 复用既有 logging framework，不重造 | 复用既有 `createLogger` 与 `http-logging` 契约（request 级日志已存在）；PC-08 未新增日志框架，并确认 ops 视图不包含任何 secret |
| 6 health endpoints | 区分 liveness 与 readiness | 新增 `GET /health/live`（仅进程存活，不依赖下游）与 `GET /health/ready`（数据库连通性 + kill switch resolver 探针，降级 503）；既有 `/health`、`/healthz` 保持兼容 |
| 7 Action Guard / kill switch 状态可见 | 只读可见，不改变开关 | `/ops-readiness` 返回 `killSwitch.resolverReachable` + `posture`、`actionGuard.configured` + `posture`（缺省装配即 READ_ONLY 姿态）；**不提供**任何开关注入/变更能力 |
| 8 transport 边界 | PC-08 不打开 transport | `/ops-readiness.transport = 'DISABLED'`（常量，非配置项）；代码中未新增任何 transport 开关 |
| 9 UI / 客户可见面 | — | 本批为运维面：`/ops-readiness` 为内部只读端点（OWNER / ADMIN），未新增客户 UI；客户面失败指引继续走 PC-04 `/recovery-states` |
| 10 不重造平台 | 不实现分布式调度 / 监控后端 | 限流为进程内基线（已在代码注释中说明多实例需网关/共享存储，属后续运维事项）；未新增调度器、未新增监控后端 |

## 2. 验证证据

| 验收项 | 证据 |
|---|---|
| liveness 与 readiness 分离 | 「health：liveness 恒 200（不依赖下游）；readiness 反映数据库连通性」 |
| ops 视图权限 | 「未认证 401；OPS / VIEWER 403；OWNER 200」 |
| kill switch / Action Guard 可见 | 「ops-readiness 内容」断言 `killSwitch.resolverReachable` 为布尔、posture ∈ {READ_ONLY_DEFAULT, CONFIGURED}；`actionGuard.configured = true` 且 posture = ENFORCING |
| 失败任务计数真实 | 同上：FAILED=1、PARTIAL=1 与 fixture 一致 |
| transport 不打开 | 同上：`transport = 'DISABLED'` |
| 无 secret | 同上：响应文本不含 passwordHash / credentialRef / token / secret / storageKey |
| rate limit 基线生效 | 「匿名入口 rate limit 基线」：RATE_LIMIT_MAX=2 时第 3 次登录 → 429 + retry-after |
| runbook 存在 | `docs/releases/PC-08-OPERATIONAL-RUNBOOK.md`（10 场景，含明确步骤与 HOST APPROVAL REQUIRED 标注） |
| tsc api·web | 0 error |
| API contract | `API_CONTRACT_OK`（新增 `/health/live`、`/health/ready`、`/ops-readiness` 已登记） |
| full CI | RUN_ID = 37042838449 · 5 jobs 全绿 |

套件：`ops-readiness-http-db` **4/4 PASS**（真实 HTTP + PostgreSQL）。

## 3. 明确未做（遵守 PC-08 边界）

未打开 transport（`TRANSPORT=false` 保持）；未启用真实平台写入；未实现分布式调度或监控后端；未改动 R13 / 付款 / collection；未新增生产凭据；未改 Schema、未加 migration（rate limit 为进程内实现，无需持久化）。

## 4. 下一执行单元（待裁决）

若 PASS：PC-08 = PASS / CLOSED → 回到 PC 队列剩余项（PC-09 Commercial/legal 内容层，或架构方指定的下一单元）。
边界保持：NO platform write · Payment = 0 · autopay = OFF · collection = OFF · external payment write = OFF · R13 HOLD · TRANSPORT=false · 无生产凭据。
