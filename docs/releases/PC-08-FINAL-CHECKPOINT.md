# PC-08 FINAL — PRODUCTION READINESS TRUTH CHECKPOINT

状态：**READY_FOR_REVIEW / REVISE 收口**（待架构方裁决）
前序：PC-08 首版 IMPLEMENTATION_HEAD = 7078d22 / CI RUN 37042838449 → **MSG-20261003-94 = REVISE**（CHANGE A–F）。
IMPLEMENTATION_HEAD = b5935a5
IMPLEMENTATION_HEAD_FULL = b5935a565057e1c460fca2b37274caa43c874c83
CI = SUCCESS · RUN_ID = 37045424813 · CI_VERIFIED_HEAD = 2c0b295
（`2c0b295` = `b5935a5` + `.autopilot` 状态同步提交；两者除 `.autopilot/` 外文件完全一致。）
授权：MSG-20261003-94 ⑯（PC-08 FINAL — PRODUCTION READINESS TRUTH）。
边界：**TRANSPORT 不打开（恒 DISABLED）** · NO platform write · Payment = 0 · collection = OFF · R13 HOLD · 无生产凭据。

## 1. CHANGE A–F 逐项落地（MSG-94 ⑯）

| CHANGE | 要求 | 实现 |
|---|---|---|
| A USE REAL READINESS PATH | `/health/ready` 复用既有真实 readiness path | `server.ts` 中 `/readyz` 与 `/health/ready` 走同一分支，调用既有 `services/readiness.ts::checkReadiness`（databaseProbe + appliedMigrations vs expectedMigrations + resolverProbe）；ready=true → 200，否则 503；响应只有 `{ ready, reasons, checkedAt, version }` —— 稳定 reason code（`DATABASE_UNAVAILABLE` / `MIGRATION_MISMATCH` / `KILL_SWITCH_RESOLVER_FAIL_CLOSED`），不含 SQL 错误 / 连接串 / 堆栈 / secret |
| B MIGRATION STATUS PROJECTION | migration 状态机器可判定、只读 | `services/ops/readiness-facts.ts::projectMigration`：读 `_prisma_migrations`（`finished_at IS NOT NULL` 计数）与仓库 `migrations/` 目录数比较 → `CURRENT` / `MIGRATION_MISMATCH` / `UNKNOWN`（表不可读或期望值未知 → UNKNOWN）；**GET 不触发任何 migrate** |
| C REQUIRED CONFIG READINESS | 必需配置缺失 → BLOCKED | `projectConfiguration`：`REQUIRED_CONFIG_KEYS = [DATABASE_URL]`，缺失/空白 → `{ status: BLOCKED, missing: [安全 key 名] }`；**只回 key 名，绝不回取值** |
| D STORAGE PROBE | storage 安全探针 | 组合根注入只读 `storage.head(probeKey, SENTINEL_ORG)` 探针 → `READY` / `BLOCKED`（false 或抛错）/ `NOT_CONFIGURED`（未注入）；不暴露 storageKey / secret / path |
| E EXTERNAL INTEGRATION GATES | provider 未配置不得 READY | `EXTERNAL_INTEGRATION_GATES`：amazon / tiktok / walmart / carriers / customs **恒 `EXTERNAL_GATE`**（不读取 credential value） |
| F PAYMENT GATE VISIBILITY | payment gate 进入机器可读视图 | `facts.payment`：`billingModel=EXISTS`、`activation=HOLD`、`payment=ZERO`、`collection=OFF`、`activationReason=PAYMENT_NOT_ENABLED`（复用既有 `PAYMENT_STATE` 单源） |

上述 facts 由 `getOpsReadiness()` 注入 `OpsReadiness.facts`，经只读 `GET /ops-readiness`（OWNER / ADMIN）暴露。

## 2. 验证证据（MSG-94 ⑰ required tests → 断言）

| MSG-94 ⑰ 要求 | 用例 / 断言 |
|---|---|
| DB 不可用 → `/health/ready` 503 | `ops-readiness-http-db`「DB 不可用 → /health/ready 503」：broken prisma → 503 + `reasons = [DATABASE_UNAVAILABLE]`（且无 ECONNREFUSED / 端口 / SQLSTATE / secret 透出）；单元 `checkReadiness` DB 抛错同断言 |
| migration mismatch → 503 | `pc08-readiness-facts`：`checkReadiness` applied=45 / expected=46 → `MIGRATION_MISMATCH` + 503 |
| migration current → ready | `pc08-readiness-facts`：applied=46 / expected=46 → `ready=true` + 200 |
| required config missing → BLOCKED | `pc08-readiness-facts` + `ops-readiness-http-db`：`DATABASE_URL` 空 → `configuration.status=BLOCKED`、`missing=[DATABASE_URL]`，响应不含取值（`postgresql://` 不出现） |
| storage probe failure → BLOCKED | `pc08-readiness-facts`：storageProbe=false / 抛错 → `BLOCKED`（抛错信息不进入响应） |
| provider not configured → NOT_CONFIGURED / EXTERNAL_GATE | `pc08-readiness-facts`：amazon/tiktok/walmart/carriers/customs 全部 `EXTERNAL_GATE` 且 `!== READY` |
| provider absence does not crash liveness | `ops-readiness-http-db`：`DATABASE_URL` 置空时 `/health/live` 仍 200 |
| payment = ZERO / collection = OFF / R13 = HOLD visible | `facts.payment`：`payment=ZERO`、`collection=OFF`、`activation=HOLD`（R13 由 activation gate 表达） |
| transport = DISABLED | `ops-readiness-http-db`：`transport === DISABLED` |
| no env value leaked | `ops-readiness-http-db`：配置存在时响应不含占位 DSN；配置缺失时不出现 `postgresql://` |
| no provider credential leaked | `ops-readiness-http-db`：响应文本不含 passwordHash / credentialRef / token / secret / storageKey / SQLSTATE |
| unknown readiness check → fail-closed | `pc08-readiness-facts`：迁移表不可读 / expected<0 → `MIGRATION_MISMATCH`（fail-closed）；`projectMigration` 不可读 → `UNKNOWN`（不猜 CURRENT） |
| existing admin/system-health regressions green | `health.test.ts` 11/11、`admin-console` 12/12、`admin-imports` 9/9、`admin-membership` 8/8、`admin-recovery-review` 11/11（共 51/51 PASS） |
| current rate-limit tests green | `ops-readiness-http-db`「匿名入口 rate limit 基线」：RATE_LIMIT_MAX=2 → 第 3 次登录 429 + retry-after |
| tsc api / web 0 | `apps/api` `tsc --noEmit` = 0 error；`apps/web` `tsc --noEmit` = 0 error |
| full CI SUCCESS | RUN_ID = 37045424813（head 2c0b295）5 jobs 全绿 |

### 套件结果

- `ops-readiness-http-db`（真实 HTTP + PostgreSQL）：**6/6 PASS**
- `pc08-readiness-facts`（纯内存 readiness truth 单元）：**10/10 PASS**
- health / admin 回归：**51/51 PASS**
- 本地 API contract：`API_CONTRACT_OK`（implemented=77 / documented=64；`/health/ready` 由既有 `/readyz` 文档覆盖，无漂移）

## 3. 明确未做（遵守 PC-08 边界）

未重做 rate limiter / runbook / failedJobs / transport / logging / liveness（MSG-94 ⑯ 明确保留）；未打开 transport（`TRANSPORT=false`）；未启用真实平台写入；未实现分布式调度或监控后端；未改动 R13 / 付款 / collection；未新增生产凭据；未改 Schema、未加 migration（限流仍为进程内基线，runbook 已标注多实例需网关 / 共享存储）。

## 4. 下一执行单元（待裁决）

若 PASS：PC-08 = PASS / CLOSED → 可授权 **PC-09 Commercial / legal 内容层**（或架构方指定的下一单元）。
边界保持：NO platform write · Payment = 0 · autopay = OFF · collection = OFF · external payment write = OFF · R13 HOLD · TRANSPORT=false · 无生产凭据。
