# P2-1 DEPLOYMENT SMOKE CHECKPOINT

> ⚠️ **SUPERSEDED（历史归档）** —— 自 2026-10-08 起，CrossClaim 唯一正式部署入口为仓库根目录 `DEPLOYMENT.md`
> （配合 `deploy/release-manifest.json` 与 `node deploy/verify-release.mjs` 门禁）。
> 本文仅作历史记录保留，**不得作为部署流程依据**；内容冲突时以 `DEPLOYMENT.md` + manifest 为准。
> 归档索引：`docs/archive/DEPLOYMENT-HISTORY.md`


> 类型：**IMPLEMENTATION CHECKPOINT**（P2-1 Deployment Smoke）
> 依据：**MSG-20260929-70**（`GO_WITH_MINOR_REVISE`：D1 /readyz、D2 合成数据 CI 边界、D3 secret.rotated、D4 docker smoke、D5 验证门槛、D6 逐项交付）
> 分支：`gate/7-commercial-validation` @ **35fc56b**（实现 `40a3f60` / 修复 `35fc56b`）；main = `9f6461e`
> 边界：**未部署任何生产环境、未配置 DNS/TLS、未执行任何 Secret 轮换**；smoke 只用测试 secret

---

## 1. 文件清单

| 文件 | 变更 | 内容 |
|---|---|---|
| `apps/api/src/services/readiness.ts` | 新增 | `checkReadiness`（DB 可用 / migration 完整 / resolver 可解析）、`readinessHttpStatus`、`countLocalMigrations`；**只返回原因码** |
| `apps/api/src/server.ts` | 修改 | `GET /readyz` 路由（独立于 liveness）；`createRuntime` 增加取值层校验（fail fast，只报变量名与原因码） |
| `apps/api/src/config/env.ts` | 修改 | 新增 `validateEnvValues` + `EnvValuesError`（URL 形态 / 盐值长度 / 白名单枚举 / 数字端口；**绝不回显取值**） |
| `apps/api/src/__tests__/readiness.test.ts` | 新增（8 例） | readiness 单元 + HTTP + 不泄漏断言 |
| `apps/api/src/__tests__/config.test.ts` | 扩展（+3 例） | env 取值校验（含「只报原因码、不回显取值」断言） |
| `apps/api/src/__tests__/runtime.test.ts` | 同步（1 例） | 盐值过短改为断言原因码 `AUDIT_IP_SALT_TOO_SHORT` |
| `tools/smoke/deploy-smoke.mjs` | 新增 | docker smoke：S-1 fresh install + S-2 upgrade；随机容器/端口/库 + 测试 secret + 结束销毁 |
| `.github/workflows/ci.yml` | 修改 | 新增作业 `Deploy smoke · fresh install + migration upgrade`（D4：CI 可重复执行） |
| `API.md` | 修改 | 登记 `/readyz` 契约（修复 API contract 闸门） |
| `P2-PRODUCTION-HARDENING-DESIGN.md` | 修改 | 新增 §7 R2：把 MSG-70 的 D1–D6 裁决折入设计 |

## 2. `/readyz` 语义（MSG-20260929-70 D1）

| 端点 | 语义 | 降级时 |
|---|---|---|
| `/health`、`/healthz` | **liveness**：进程是否活着 | 仍 200（resolver 降级 ≠ 服务 down） |
| `/readyz` | **readiness**：DB 可用 + migration 完整 + resolver 可解析 | **503** `{ ready: false, reasons: [...] }` |

允许的原因码（只此三项）：`DATABASE_UNAVAILABLE` / `MIGRATION_MISMATCH` / `KILL_SWITCH_RESOLVER_FAIL_CLOSED`。
**禁止**返回 SQL 错误 / 连接串 / 堆栈 / secret —— 实现中连错误消息都不带出（异常被吞掉后只映射为原因码）。

| 用例 | 覆盖 |
|---|---|
| `readiness.test.ts :: 01` | DB 可用 + 迁移一致 + resolver 可解析 → `ready: true`、HTTP 200 |
| `:: 02` | DB 不可用（注入含连接串的错误）→ 仅 `DATABASE_UNAVAILABLE`，且**不再继续**判定迁移/resolver |
| `:: 03` | 迁移数不一致 / 迁移查询抛错 / 期望值未知 → `MIGRATION_MISMATCH` |
| `:: 04` | resolver 返回 false 或抛错 → `KILL_SWITCH_RESOLVER_FAIL_CLOSED` |
| `:: 05` | 注入 `password=... host=db.internal stack: ...` 与 `token=...` → 结果 JSON 不含这些字符串 |
| `:: 06/07` | 真实库：`/readyz` 200 `{ready:true,reasons:[]}`；`/health` 与 `/readyz` 语义分离 |
| `:: 08` | `/readyz` 响应不含 `postgresql://` / `password` / `stack` / `prisma` |

## 3. env 取值校验（D4/§1.3，fail fast 且不泄漏）

- 新增 `validateEnvValues`：`DATABASE_URL` 形态、`AUDIT_IP_SALT`/`STORAGE_URL_SECRET` 长度、`STORAGE_DRIVER` 白名单、`METRICS_ENABLED` 布尔、`PORT` 数字、`NODE_ENV` 白名单。
- 违规 → `EnvValuesError`，消息**只含变量名与原因码**（例如 `AUDIT_IP_SALT_TOO_SHORT`），绝不包含取值（含长度/前后缀）。
- 缺少 `DATABASE_URL` 的处理保持既有分工：**启动路径**由 `loadEnv` fail fast；`createRuntime` 只给 warning（`DATABASE_URL_MISSING`）。
- 证据：`config.test.ts`（合法取值 / 非法取值逐项 / 缺 DATABASE_URL 只 warning）+ `runtime.test.ts`（盐值过短 → 原因码）。

## 4. Deployment Smoke（S-1/S-2，D4）

本地执行 `node tools/smoke/deploy-smoke.mjs`：**DEPLOY_SMOKE_OK**（12 步全绿）

```text
✓ docker available
✓ start postgres (S-1: empty database)          # 随机容器名 / 随机端口 / 随机库名
✓ wait for postgres ready
✓ S-1 migrate deploy (fresh database)           # All migrations have been successfully applied.
✓ count migrations on disk :: 19
✓ S-2 migrate deploy (upgrade path, idempotent)
✓ applied migrations == expected :: 19 migrations
✓ tenant triggers = 28
✓ boot API
✓ GET /health = 200 (liveness)
✓ GET /readyz = 200 (readiness)
✓ /readyz does not leak internal details
```

安全约束落实：只用随机生成的测试 secret；容器名为随机；主机端口随机；脚本结束 `docker rm -f` 销毁；不写任何 dump/备份产物。

## 5. 测试与 CI

| 项 | 结果 |
|---|---|
| 本地全量 | **113 files / 1075 tests**（修复一次断言：盐值过短改为原因码） |
| 新增用例 | readiness 8 + env 3（并同步 runtime 1） |
| `prisma validate` | PASS（本阶段未改 Schema） |
| API contract | `implemented=54 documented=55` / `API_CONTRACT_OK`（补齐 `/readyz` 契约后） |
| Audit coverage | `AUDIT_COVERAGE_OK` |
| **CI（HEAD `35fc56b`，run `36607868385`）** | **四作业全部 SUCCESS**：API（113 files / 1075 tests、`OK: 28 tenant triggers present`）/ Web（Compiled successfully）/ 许可证闸门 / **Deploy smoke（DEPLOY_SMOKE_OK，12 步）** |
| 首轮失败与修复 | `40a3f60` 的 API 作业因 `/readyz` 未登记 API.md 触发契约漂移 → `35fc56b` 登记契约后转绿（记录在案，非绕过） |

## 6. 边界确认（MSG-20260929-70 的禁止项）

| 禁止项 | 状态 |
|---|---|
| 生产部署 | ❌ 未执行（smoke 只在本地/CI 临时容器） |
| DNS / TLS | ❌ 未触碰 |
| Secret 实际轮换 | ❌ 未执行（仅在设计 R2 §7.3 定义流程与审计字段） |
| 真实数据 | ❌ 未使用（smoke 用合成数据/空库） |
| 保存 dump artifact | ❌ 未产生 |
| Action Guard / 业务阻断 | ❌ 未实现（继续 HOLD） |

## 7. 待裁决

- **Q1**：`0e4f4cc` / `40a3f60` / `35fc56b`（含本报告提交）是否批准 fast-forward 合并到 `main`？
- **Q2**：是否批准进入 **P2-2 Backup / Restore Verification**（按 MSG-70 D2 范围：**CI 用合成数据 + 临时库**做 dump/restore 比对；真实备份验证仍只在宿主环境）？实现将包含：比对脚本（行数/按租户分组/金额聚合/审计分布/触发器与索引）+ CI 作业 + 报告模板。
