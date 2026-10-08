# DEPLOYMENT — CrossClaim AI（唯一正式部署入口）

> **状态：ACTIVE / 唯一正式流程**（建立于 2026-10-08，RC-LINUX-DEPLOY FINALIZATION 治理单元）。
> 本文件是 CrossClaim 唯一的部署入口。其它部署类文档（例如 docs/releases/RSI-DEPLOYMENT.md、
> P2-1-DEPLOYMENT-SMOKE-CHECKPOINT.md 等）一律为**历史归档**，不得与本文件竞争；
> 发生冲突时，以 **本文件 + deploy/release-manifest.json** 为准。
>
> 硬边界：**生产部署属 HOST APPROVAL REQUIRED**（AGENTS.md 第七节）。本文件只描述「如何做」，不代替宿主执行。

---

## 0. 权威来源与版本锁定（防混乱核心）

| 项 | 值 |
| --- | --- |
| **唯一部署来源分支** | `release/rc-20261008-linux-deploy-v1` |
| **锁定 Commit（唯一权威）** | 见 `deploy/release-manifest.json` → `releaseCommit` |
| 机器可读部署清单 | `deploy/release-manifest.json` |
| **部署前强制门禁** | `node deploy/verify-release.mjs --root .`（必须 PASS，否则**停止部署**） |
| 封板对照（**只读，不得用于部署**） | `release/integration-20261008` = `190d57a6` |

**禁止**：

1. 部署智能体自行选择 `main`、旧 `release/*`、`gate/*`、`feat/*`、`fix/*` 或任何开发分支；
2. 部署与 manifest 记录的 `releaseCommit` 不一致的 commit；
3. 绕过 `deploy/verify-release.mjs` 直接上线。

> 分支名仅供人读，**Commit SHA 是唯一权威**。历史分支保留（不删除），但不构成部署来源。

---

## 1. 前置条件

| 项 | 要求 | 说明 |
| --- | --- | --- |
| Node.js | **22.x** | CI 使用 NODE_VERSION: 22 |
| PostgreSQL | 16 | 迁移与集成测试均在真实 PG 上执行 |
| 进程守护 | systemd（Alibaba Cloud Linux / RHEL 系） | 三个 unit 见 `deploy/systemd/` |
| 部署路径 | `/opt/crossclaim` | unit 的 WorkingDirectory / ExecStart 硬编码该路径 |
| 端口 | API **3000**、Web **3001**、RSI health **4319**（仅回环） | 公网入口必须经反向代理 |
| 服务账户 | `crossclaim-api` / `crossclaim-web` / `crossclaim-rsi` | 由安装脚本创建（--system --no-create-home --shell nologin） |

---

## 2. 环境变量（**只列名称**；取值一律走密钥管理）

### 2.1 `/etc/crossclaim/api.env`（API）

| 变量 | 必需 | 默认 | 说明 |
| --- | --- | --- | --- |
| `DATABASE_URL` | **是** | — | PostgreSQL 连接串；**唯一必需变量**，缺失即启动失败并一次列全 |
| `STORAGE_URL_SECRET` | 生产必需 | — | 签名下载令牌密钥（>=16 位；缺失/过短 API 直接 fail-fast） |
| `AUDIT_IP_SALT` | 生产必需 | 回退 STORAGE_URL_SECRET | IP 只落加盐哈希（>=16 位） |
| `NODE_ENV` | — | `production`（unit 注入） | production 时启用生产语义 |
| `PORT` | — | `3000` | HTTP 端口 |
| `LOG_LEVEL` | — | `info` | debug / info / warn / error |
| `STORAGE_DRIVER` | — | `local` | local / s3 |
| `STORAGE_LOCAL_ROOT` | — | `/var/lib/crossclaim-api/storage`（unit 注入） | 必须在 StateDirectory 内 |
| `STORAGE_PUBLIC_BASE_URL` | — | `http://localhost:3000` | 签名下载对外基址 |
| `STORAGE_TOKEN_KEY` | — | 由 STORAGE_URL_SECRET 派生 | 下载令牌 AES-256-GCM 专用密钥 |
| `STORAGE_SIGNED_URL_TTL_SECONDS` | — | `300` | 签名下载有效期 |
| `S3_ENDPOINT` / `S3_BUCKET` / `S3_REGION` | s3 驱动必需 | — | 对象存储 |
| `S3_ACCESS_KEY_REF` / `S3_SECRET_KEY_REF` | s3 驱动必需 | — | **只写引用名** |
| `METRICS_ENABLED` | — | `false` | true 时暴露 GET /metrics |
| `TEMPORAL_ADDRESS` / `TEMPORAL_NAMESPACE` | — | localhost:7233 / default | 工作流（未启用） |
| `AI_SERVICE_URL` | — | http://localhost:8003 | 文档 AI 服务（当前未部署） |
| `PAYMENTS_ENABLED` | — | `false` | 支付域总开关，**默认关闭** |
| `PAYMENT_WEBHOOK_SECRET` | 支付启用时必需 | — | 只在启动 shell 内设置，**不入库 / 不回显** |
| `PAYMENT_REVIEW_THRESHOLD` | — | `1000.0000` | 高额人工卡口阈值 |

> 敏感变量系统**从不打印取值**；`envPresence()` 只报是否已设置。完整模板见 `apps/api/.env.example`。

### 2.2 `/etc/crossclaim/web.env`（Web）

| 变量 | 必需 | 默认 | 说明 |
| --- | --- | --- | --- |
| `CROSSCLAIM_API_URL` | **是** | `http://127.0.0.1:3000` | Web **不直连数据库**，只经此地址访问 API |
| `NODE_ENV` / `PORT` / `NEXT_TELEMETRY_DISABLED` | — | unit 注入 | — |

### 2.3 `/etc/crossclaim/rsi.env`（RSI）

| 变量 | 必需 | 默认 | 说明 |
| --- | --- | --- | --- |
| `RSI_RECONCILE_REQUIRED` | **生产必需** | unit 注入 `true` | true 且缺 DATABASE_URL ⇒ **拒绝启动**（fail-closed） |
| `DATABASE_URL` | 生产必需（随上一项） | — | durable reconcile 的数据库连接（密钥管理注入） |
| `RSI_ENABLED` / `RSI_PAUSED` | — | true / false | Kill Switch；false ⇒ 存活但空转 |
| `RSI_HEALTH_PORT` | — | `4319` | 健康端口（仅回环） |
| `RSI_TASKS_PATH` / `RSI_CI_RESULTS_PATH` / `RSI_VERDICT_PATH` / `RSI_TEST_RESULTS_PATH` / `RSI_SIGNALS_PATH` | — | 未设=静默 | 只读 artifact 事件源 |
| `RSI_WATCHDOG_INTERVAL_MS` | — | `60000` | Watchdog **兜底**间隔（不驱动推进） |
| `RSI_STATE_FILE` / `RSI_ADMIN_SNAPSHOT_PATH` | — | unit 注入到 /var/lib/crossclaim-rsi/ | 运行期自用文件 |
| `RSI_RUNTIME_OWNER_REF` | — | `rsi-runtime:<bootUuid>:<pid>` | durable 执行身份（多实例/多主机建议显式注入） |

> 已知观察项：`@prisma/client` 在 import 时会从 **schema 目录**自动加载 .env（dotenv 不覆盖已存在变量）。
> 生产**不得**存在 `apps/api/.env`；一切取值只经 EnvironmentFile / 密钥管理注入。（后续 RC-C8 计划显式化。）

---

## 3. 数据库迁移

```bash
cd /opt/crossclaim/apps/api
npx prisma validate
npx prisma migrate deploy      # 生产只用 deploy，不用 migrate dev
npx prisma generate
```

- 迁移数量由 runtime/CI 检测，**文档不写死**；
- Prisma **不提供自动 down**；破坏性变更必须拆成「先加 -> 后用 -> 再删」两段发布（见第 7 节）；
- **生产数据库迁移属 HOST APPROVAL REQUIRED**。

---

## 4. 构建

```bash
cd /opt/crossclaim/apps/api
npm ci --no-audit --no-fund
npx tsc --noEmit
npm run build                  # tsc ⇒ dist/src/**

cd /opt/crossclaim/apps/web
npm ci --no-audit --no-fund
npm run typecheck
npm run build                  # next build ⇒ .next/
```

> 注意：`apps/api` 的 tsconfig 为 outDir=dist + rootDir="."，**产物在 `dist/src/**`**
> （例如 `dist/src/server.js`、`dist/src/runtime/rsi-run.js`）—— 不存在 `dist/server.js`。

---

## 5. 服务安装与启动

```bash
# 一键（幂等、支持 --dry-run）：API + Web
sudo deploy/install-services.sh [--dry-run]

# 一键（幂等、支持 --dry-run）：RSI Controller
sudo deploy/install-rsi-service.sh [--dry-run]
```

| 服务 | unit | ExecStart | 账户 |
| --- | --- | --- | --- |
| API | `crossclaim-api.service` | `/usr/bin/node /opt/crossclaim/apps/api/dist/src/server.js` | crossclaim-api |
| Web | `crossclaim-web.service` | `/usr/bin/node /opt/crossclaim/apps/web/node_modules/next/dist/bin/next start -p 3001` | crossclaim-web |
| RSI | `crossclaim-rsi.service` | `/usr/bin/node /opt/crossclaim/apps/api/dist/src/runtime/rsi-run.js` | crossclaim-rsi |

- 启动依赖：API <- postgresql.service；Web <- crossclaim-api.service；RSI <- postgresql.service；
- 单 RSI 主实例：仅 `crossclaim-rsi.service` 引用 `rsi-run`；跨实例互斥由 durable lease（ownerRef + 租约有效期）承担；
- 重启策略：`Restart=on-failure` + `RestartSec=5` + `StartLimitIntervalSec=300` / `StartLimitBurst=5`；
- 优雅停止：`KillSignal=SIGTERM` + `TimeoutStopSec=30`。

---

## 6. 健康检查

| 检查 | 期望 |
| --- | --- |
| `GET http://127.0.0.1:3000/health` | 200，status=ok；依赖不可用时 status=degraded（不泄露连接串） |
| `GET http://127.0.0.1:3000/readyz` | 200 `{"ready":true,"reasons":[]}`（DB 可用 + 迁移完整 + resolver 可解析） |
| `GET http://127.0.0.1:3001/` | 200（Web 首页渲染成功） |
| `curl http://127.0.0.1:4319/health` | RSI Controller 健康 |
| `npx prisma migrate status` | 全部迁移已应用 |
| 日志 | `journalctl -u crossclaim-api -f`（每请求一条 http_request；/files/<token> 已脱敏） |

> 安装脚本会自动做 API_HEALTH 与 WEB_ROOT 校验（各 60s 超时）。

---

## 7. 回滚

| 层 | 动作 |
| --- | --- |
| 应用层 | 切回上一版本：`git checkout <上一 RC 的 releaseCommit>` -> `npm ci` -> `npm run build` -> `systemctl restart crossclaim-api crossclaim-web crossclaim-rsi` |
| 数据层 | 迁移保持向后兼容（新增列有默认值）；破坏性变更按「先加 -> 后用 -> 再删」两段发布 |
| 全库恢复 | 仅在确有必要时，用迁移前备份 `pg_restore`（**需 HOST 授权**） |
| 回滚演练 | `node tools/upgrade-verify/two-stage-upgrade.mjs`（需 psql） |

`deploy/release-manifest.json` 的 `rollback` 字段记录「上一个已知可用 releaseCommit」；回滚同样受第 8 节门禁约束。

---

## 8. 部署前强制门禁

```bash
node deploy/verify-release.mjs --root .
```

必须**全部**通过，任一失败即**停止部署**：

1. `git rev-parse HEAD` 与 manifest `releaseCommit` 一致（允许 manifest 自身的封装提交：见 manifest 的 sealingCommitPolicy）；
2. 工作树 **clean**（含未跟踪文件）；
3. 当前分支不在 manifest `forbiddenDeploymentBranches` 中；
4. API 构建与类型检查通过（`npm run build` + `tsc --noEmit`）；
5. 部署合同 / 恢复类定向测试通过（deploy-systemd-contract、rsi-deployment-contract、rsi-reconcile-bootstrap、rsi-restart-reconcile）。

---

## 9. 不在本文件范围（HOST APPROVAL REQUIRED）

生产部署、域名与 TLS、反向代理、Secret 轮换、生产数据库迁移、公开流量切换、
真实平台外写 / 报关 / 支付扣佣、外部自动提交 —— 全部需宿主单独授权与执行。

---

## 10. 历史部署文档（归档，**不得作为流程依据**）

索引见 `docs/archive/DEPLOYMENT-HISTORY.md`。要点：

| 文档 | 状态 |
| --- | --- |
| `docs/releases/RSI-DEPLOYMENT.md` | SUPERSEDED（RSI 部署细节并入本文件 2.3 / 5 / 6 节） |
| `P2-1-DEPLOYMENT-SMOKE-CHECKPOINT.md` | SUPERSEDED（CI 自动化 smoke 记录） |
| `P2-PRODUCTION-HARDENING-DESIGN.md` | 历史设计（部分条款已被本文件取代） |
| `PRODUCTION-READINESS-CHECKLIST.md` | 历史清单（当前口径见 docs/releases/LINUX-DEPLOY-READINESS-AUDIT.md） |
| `PHASE1-VALIDATION-RUNBOOK.md` | 历史 runbook |
| `EXTERNAL-DATASET-SMOKE.md` | 历史（外部数据集 smoke） |
| `OPERATIONS.md` | **仍然有效**：运维（非部署）手册，与本文件互补 |

> 归档文档**只读保留**，不得删除；如与其内容冲突，一律以本文件 + manifest 为准。
