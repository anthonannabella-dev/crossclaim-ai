# PC-08 FINAL-2 — OVERALL READINESS AGGREGATION CHECKPOINT

状态：**READY_FOR_REVIEW / REVISE-MINOR 收口**（待架构方裁决）
前序：PC-08 FINAL IMPLEMENTATION_HEAD = b5935a5 / CI RUN 37045424813 → **MSG-20261003-95 = REVISE-MINOR**（唯一剩余：overall readiness aggregation）。
FINAL_IMPLEMENTATION_HEAD = 8ce71ef
FINAL_IMPLEMENTATION_HEAD_FULL = 8ce71efcd8f64a424b154169deee95b2704d32f0
CI = SUCCESS · RUN_ID = 37046804532 · CI_VERIFIED_HEAD = 8ce71ef（与 FINAL_IMPLEMENTATION_HEAD 同一提交）
授权：MSG-20261003-95 ⑨（REQUIRED FINAL FIX — OVERALL READINESS AGGREGATION）。
边界：**TRANSPORT 不打开（恒 DISABLED）** · NO platform write · Payment = 0 · collection = OFF · R13 HOLD · 无生产凭据。

## 1. 唯一改动：overall readiness aggregation

`getOpsReadiness()` 不再以 `databaseUp` 作为唯一判据，改为由**关键内部依赖**聚合：

```text
internalReady =
  facts.database.ok
  && facts.migration.status === CURRENT
  && facts.configuration.status === READY
  && facts.storage.status === READY
  && resolverReachable             // kill switch resolver
  && actionGuardConfigured         // Action Guard 已装配
```

返回值（`OpsReadiness.readiness`）：

- `ready: boolean`（= internalReady）
- `posture: READY | BLOCKED | DEGRADED`（READY = internalReady；BLOCKED = 任一关键内部依赖硬失败；DEGRADED = 非硬失败但未就绪，例如 storage NOT_CONFIGURED / migration UNKNOWN）
- `checks: { database, migration, configuration, storage, killSwitch, actionGuard }`（逐项稳定枚举）

**外部 gate 不进 internal readiness**：`facts.integrations`（amazon / tiktok / walmart / carriers / customs 恒 `EXTERNAL_GATE`）、`facts.payment`（`billingModel=EXISTS` / `activation=HOLD` / `payment=ZERO` / `collection=OFF`）与 `transport=DISABLED` 属 production enablement status，**不**把内部 runtime readiness 拉成 false —— INTERNAL_RUNTIME_READY 与 EXTERNAL_ENABLEMENT_NOT_READY 可同时真实表达。

**冻结原则**：不再出现 `readiness.ready = true` 与 `facts.configuration.status = BLOCKED`（或 `storage = BLOCKED` / `migration = MIGRATION_MISMATCH`）并存。

## 2. 验证证据（MSG-95 Required targeted tests）

| MSG-95 要求 | 用例 / 断言 |
|---|---|
| DB UP + migration CURRENT + config READY + storage READY → ready=true | `pc08-readiness-facts`：`ready=true`、`posture=READY`、`checks = { database:UP, migration:CURRENT, configuration:READY, storage:READY, killSwitch:UP, actionGuard:UP }`；HTTP `ops-readiness-http-db` 同步断言 posture / checks |
| migration mismatch → ready=false | 单元：count=45 → `ready=false` / `posture=BLOCKED` / `checks.migration=MIGRATION_MISMATCH` |
| config BLOCKED → ready=false | 单元（env 为空）+ HTTP（`DATABASE_URL` 置空）：`facts.configuration=BLOCKED` 时 `readiness.ready=false` / `posture=BLOCKED` / `checks.configuration=BLOCKED` |
| storage BLOCKED → ready=false | 单元：storageProbe=false → `ready=false` / `BLOCKED` / `checks.storage=BLOCKED` |
| storage 未配置（非硬失败）→ DEGRADED | 单元：未注入探针 → `facts.storage=NOT_CONFIGURED`、`ready=false`、`posture=DEGRADED` |
| kill switch resolver fail → ready=false | 单元：resolverReachable=false → `ready=false` / `BLOCKED` / `checks.killSwitch=DOWN` |
| Action Guard unavailable → fail-closed / non-ready | 单元：actionGuardConfigured=false → `ready=false` / `BLOCKED` / `checks.actionGuard=DOWN` |
| DB DOWN → ready=false | 单元：DB 探针抛错 → `facts.database.ok=false`、`ready=false`、`BLOCKED`、`checks.database=DOWN` |
| provider EXTERNAL_GATE 不强制 internal ready=false | 单元：全绿 + integrations 全 `EXTERNAL_GATE` → `ready=true` / `READY` |
| Payment HOLD 可见且不影响内部 readiness | 单元：`payment=ZERO` / `activation=HOLD` / `collection=OFF`、`transport=DISABLED` 同时 `ready=true` |
| tsc api / web 0 | `apps/api` 与 `apps/web` `tsc --noEmit` = 0 error |
| full CI SUCCESS | RUN_ID = 37046804532（head 8ce71ef）5 jobs 全绿 |

### 套件结果

- `pc08-readiness-facts`（纯内存）：**17/17 PASS**（含新增 8 项聚合用例）
- `ops-readiness-http-db`（真实 HTTP + PostgreSQL）：**6/6 PASS**
- health / admin 既有回归：**66/66 PASS**（health 11、admin-console 12、admin-imports 9、admin-membership 8、admin-recovery-review 11、admin-console-db 8、admin-http-smoke-db 7）
- 本地 API contract：`API_CONTRACT_OK`（implemented=77 / documented=64，无漂移）

## 3. 明确未做（遵守边界）

未重做 MSG-95 已判 PASS 的 CHANGE A–F（real readiness path / migration projection / required config / storage probe / integration gates / payment gate）；未打开 transport（`TRANSPORT=false`）；未启用真实平台写入；未改 Schema、未加 migration；未触碰 payment / external write / production credentials。

## 4. 下一执行单元（待裁决）

若 PASS：PC-08 = PASS / CLOSED → 可授权 **PC-09 Commercial / legal 内容层**（或架构方指定的下一单元）。
边界保持：NO platform write · Payment = 0 · autopay = OFF · collection = OFF · external payment write = OFF · R13 HOLD · TRANSPORT=false · 无生产凭据。
