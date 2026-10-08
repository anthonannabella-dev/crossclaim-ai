# Linux（阿里云）部署就绪审计 —— systemd 方案，不引入 Docker 架构

> 单元：`RC-20261008-LINUX-DEPLOY-PREP`
> 范围：**部署准备 + 审计**。本文件不申请生产部署授权；生产部署 / 生产密钥 / 域名 TLS / 公开流量切换仍属 `HOST APPROVAL REQUIRED`。
> 授权边界：不新增第二套 SI/RSI Runtime；不新增容器化架构；复用 `DEPLOYMENT.md` + `deploy/` 既有 systemd 资产。

---

## 0. 结论摘要

1. **发现并修复了 3 个会导致部署直接失败的硬缺陷**（详见 §6.1）：
   - `npm start` 指向不存在的 `dist/server.js`；
   - systemd `ExecStart` 指向不存在的 `dist/runtime/rsi-run.js`；
   - 编译产物下 `/readyz` 恒返回 503（`MIGRATION_MISMATCH` 误判）。
2. 修复后，本机（staging）从**编译产物**启动 API：`/health` = 200、`/readyz` = 200；
   Web 前端 `/`、`/login`、`/recoveries` 均 200。
3. **仍不可对公网部署**：仓库只有 `crossclaim-rsi` 一个 unit，**没有** `crossclaim-api` / `crossclaim-web` 的 systemd 单元，也没有任何 TLS / 反向代理资产。
   → 这是当前最大的部署阻断项（§11 GAP-01 / GAP-02）。
4. `PRODUCTION_READY = NO` 不变；六项生产启用债继续跟踪（§13）。

---

## 1. 部署目标

| 项 | 值 |
| --- | --- |
| 分支 | `release/rc-20261008-linux-deploy` |
| 基线 commit | `77b584e2`（`feat/historical-recovery-scan-v1`，AUDIT-1..4 全 PASS） |
| 封板对照 | `release/integration-20261008` = `190d57a6`（**未修改**）；`main` **未使用**（本地 `444a246c` 已过时） |
| 目标 OS | Alibaba Cloud Linux（systemd） |
| 部署方式 | systemd + Node 进程（无 Docker） |

---

## 2. 环境前置条件审计

| 项 | 要求（来源） | 本机实测 | 结论 |
| --- | --- | --- | --- |
| Node.js | **22.x**（`DEPLOYMENT.md` §1，CI `NODE_VERSION: 22`） | `v24.16.0` | 本机非等值环境（GAP-08） |
| PostgreSQL | 16（`DEPLOYMENT.md` §1） | 已连通（`127.0.0.1:55432`） | 本机可用 |
| 进程守护 | systemd | Windows，无 systemd | B/D 类 systemd 验证只能在 Linux 实机做 |
| 包管理 | `npm ci`（有 `package-lock.json`） | 依赖已安装 | 可用 |
| 专用用户 | `crossclaim-rsi`（脚本创建，`--no-create-home` / `nologin`） | 未创建（非 Linux） | 待实机 |
| 工作目录 | unit 硬编码 `/opt/crossclaim` | 本机在 `D:\crossclaim-ai` | 见 GAP-03 |

**目录契约**：unit 假设仓库位于 `/opt/crossclaim`，且构建产物位于 `/opt/crossclaim/apps/api/dist/src/**`。
`deploy/install-rsi-service.sh` 只按 `REPO_ROOT` 原地构建，**不会**把仓库搬到 `/opt/crossclaim`。
→ 部署前必须把仓库放到 `/opt/crossclaim`（或以 drop-in 覆盖 `WorkingDirectory` / `ExecStart`）。

---

## 3. 数据库迁移审计

| 检查 | 结果 |
| --- | --- |
| 迁移目录数 | **94**（`apps/api/prisma/migrations`） |
| `npx prisma validate` | `valid` |
| `npx prisma migrate status` | `Database schema is up to date!`（94 applied） |
| 迁移幂等 | `prisma migrate deploy` 为生产唯一入口（`DEPLOYMENT.md` §3） |
| 触发器清单校验 | `tools/tenant-triggers/emit-check-sql.mjs`（需 `psql`） |
| 迁移字节一致性 | `tools/migration-checksum/check-migration-checksums.mjs` → 见下 |

**迁移校验和门禁（本地假失败，已定性）**：本机 `core.autocrlf=true`，迁移文件以 CRLF 检出，
门禁按原始字节算 sha256 因此报 `MIGRATION_CHECKSUM_MISMATCH`。证据：

| 度量 | 值 |
| --- | --- |
| 磁盘字节 / CR 数 / LF 数 | 2332 / 63 / 63 |
| 原始 sha256 | `f6211b492c81dc40b13dd1ea24dcf3fc6a04a195a1970e1ca4d934431160c2a7` |
| **LF 归一化后 sha256** | **`2acbd87a731283c6e90f8121d49c3f55fc937eac8014a89a0b7d60929b87a884` = pinned** |
| `git hash-object` | `3304c9b98f25be0a5871f7c5b3c65ea8b07e611f` = pinned `gitBlobId` |

→ 内容与提交版本**字节一致**；门禁在 LF 检出的 CI/Linux 上通过。**建议**：门禁脚本对 CRLF 归一化或改比对 `git hash-object`（GAP-09，属工具健壮性，不在本单元修改以免弱化门禁语义）。

---

## 4. 端口与网络暴露审计

| 服务 | 端口 | 绑定 | 备注 |
| --- | --- | --- | --- |
| API | `PORT`（默认 **3000**） | 未显式限制（Node 默认全网卡） | 生产应由反向代理前置，或绑定 `127.0.0.1` |
| Web | **3001**（`next start -p 3001`） | 同上 | 同上 |
| RSI health | **4319**（`RSI_HEALTH_PORT`） | 代码内**仅回环** `127.0.0.1:4319/health` | 已限定回环 |
| PostgreSQL | 5432 | 仅内网 | 生产需 VPC/安全组限制 |
| Temporal | 7233（默认） | 可选 | 未启用 |

**实测**：本机 `3000`（API）与 `55432`（PG）在验证期间监听；`3001` 为既有 Next dev server。

---

## 5. TLS / 反向代理 / 域名审计

| 资产 | 仓库中是否存在 |
| --- | --- |
| nginx / Caddy / Apache 配置 | 不存在（全仓库 0 个 `*.conf` / `Caddyfile`） |
| 证书签发自动化（certbot / acme） | 不存在 |
| 域名 / DNS 配置 | 不存在（`DEPLOYMENT.md` §7 明确「域名与 TLS 属宿主动作」） |
| HSTS / 安全响应头基线 | 未在部署层固化 |

→ **TLS 终止与公网入口完全缺失**，属 GAP-02。生产前必须由 HOST 决定：
入口形态（SLB/ECS 直接暴露）、证书来源（阿里云证书服务 / ACME）、以及反向代理选型。

---

## 6. 进程守护审计（systemd）

### 6.1 本次发现并修复的缺陷

| ID | 缺陷 | 证据（修复前实测） | 修复 |
| --- | --- | --- | --- |
| **D1** | `apps/api` 的 `npm start` = `node dist/server.js`，但实际产物是 `dist/src/server.js`（tsconfig `outDir=dist` + `rootDir="."`） | `Error: Cannot find module '…\apps\api\dist\server.js'` | 改为 `node dist/src/server.js` |
| **D2** | `deploy/systemd/crossclaim-rsi.service` 的 `ExecStart` 指向 `…/dist/runtime/rsi-run.js`（同因缺 `src/`） | `Error: Cannot find module '…\dist\runtime\rsi-run.js'` | 改为 `…/dist/src/runtime/rsi-run.js` |
| **D3** | `countLocalMigrations()` 只按源码布局拼 `__dirname/../../prisma/migrations`；编译后解析为 `dist/prisma/migrations`（不存在）→ 返回 `-1` → `/readyz` **恒 503 `MIGRATION_MISMATCH`** | 编译产物实测 `/readyz` = **503** | 改为在两种布局中择优解析（`resolveMigrationsDir`）；修复后 `/readyz` = **200 `{"ready":true,"reasons":[]}`** |

> D1/D2 会让服务**根本无法启动**；D3 会让**任何反代/负载均衡的 readiness 探测永久摘流**。
> 三者都不是风格问题，且**源码级测试与 dev 模式都不会暴露**（这正是它们能长期存在的原因）。

### 6.2 unit 现状评估（`crossclaim-rsi.service`）

| 维度 | 评估 |
| --- | --- |
| 崩溃恢复 | `Restart=on-failure` + `RestartSec=5` |
| 防 crash loop | `StartLimitIntervalSec=300` / `StartLimitBurst=5` |
| 停止语义 | `KillSignal=SIGTERM` + `TimeoutStopSec=30`（与 `rsi-run` 的 SIGTERM 处理匹配） |
| 最小权限 | 专用用户、`NoNewPrivileges`、`ProtectSystem=strict`、`ProtectHome`、`PrivateTmp`、空 `CapabilityBoundingSet` |
| 可写范围 | 仅 `ReadWritePaths=/var/lib/crossclaim-rsi` + `StateDirectory` |
| 日志 | `journal` + `SyslogIdentifier=crossclaim-rsi` |
| 网络 | `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX` |
| 凭据 | `EnvironmentFile=/etc/crossclaim/rsi.env`，脚本明示不写明文凭据 |
| 路径正确性 | 依赖 `/opt/crossclaim`（GAP-03） |

### 6.3 守护层缺口

- **GAP-01**：无 `crossclaim-api.service` / `crossclaim-web.service`。`RSI-DEPLOYMENT.md` §1 把 web/api/worker 列为服务，
  但仓库只有 RSI 一个 unit → **主业务进程没有任何守护**。
- **GAP-04**：`RSI-DEPLOYMENT.md` §1 提到 `crossclaim-worker`，但 `apps/api/package.json` 中**不存在** worker 入口 →
  该服务实际不存在（文档超前于实现，不得凭空造一个 worker）。
- **GAP-05**：`/etc/crossclaim/rsi.env` 模板**不含 `DATABASE_URL`**，unit 也只有这一个 `EnvironmentFile`。
  实测：`rsi-run` 主入口调用 `composeRsiRuntime()` 时**未注入 `reconcile.store`**，
  因此启动日志为 `RSI_RECONCILE=NOT_CONFIGURED` —— 即 **`createPrismaRsiReconcileStore()` 已实现但未接入生产入口**，
  重启后的租约 reconcile（Test C/F）在部署形态下**不生效**。
- **GAP-06**：`RSI-DEPLOYMENT.md` 存在文档漂移：§6 仍写「状态持久化与 reconcile（Test C/F）**未实现**」，
  而仓库已有 `rsi-restart-reconcile.test.ts`（10/10）与 `rsi-reboot-reconcile-db.test.ts`；
  另外该文 §2.1 的环境变量表**漏列**代码实际读取的 `RSI_SIGNALS_PATH`。

---

## 7. 日志与可观测性审计

| 能力 | 现状 |
| --- | --- |
| 应用日志 | 结构化 JSON，每请求一条 `http_request`；敏感字段脱敏名单在 `src/config/logger.ts` |
| 日志落盘 | systemd → journald（`journalctl -u <svc>`） |
| 日志保留/轮转 | 依赖 journald 默认（未在仓库固化 `SystemMaxUse` / 保留策略） |
| 健康/就绪 | `/health`（liveness）、`/readyz`（readiness，只回原因码不泄漏内部信息） |
| 指标 | `GET /metrics`（Prometheus 文本）**默认关闭**（`METRICS_ENABLED=false`）；实测 404 |
| 审计日志 | `AuditLog` + `tools/audit-coverage/check-audit-actions.mjs` 门禁 |

---

## 8. 监控审计

| 项 | 现状 |
| --- | --- |
| 指标端点 | 有（需显式开启 `METRICS_ENABLED=true`） |
| 采集器（Prometheus/阿里云 ARMS） | 仓库无任何配置 |
| 告警规则 | 无 |
| 大盘 | 无 |
| 探活编排 | 无（K8s/SLB 健康检查配置未固化） |

→ **GAP-07**：监控栈需 HOST 选型（阿里云 ARMS / 自建 Prometheus）。仓库侧可提供的最小接口已具备（`/health`、`/readyz`、`/metrics`）。

---

## 9. 备份审计

| 项 | 现状 |
| --- | --- |
| 备份验证工具 | `tools/backup-verify/run-synthetic-backup-verify.mjs`（合成数据 + 临时容器，B1–B7 不变量，含「还原失败必须判 FAIL」的反例） |
| 生产备份脚本 / 定时任务 | 无（脚本明示「真实备份 = HOST APPROVAL REQUIRED」） |
| dump 产物留存 | 设计上禁止落宿主文件 / 禁止 upload artifact |
| 恢复演练 | 仅合成数据路径可复现 |
| 保留期 / PITR | 未定义（阿里云 RDS 侧需 HOST 配置） |

→ 另见 `docs/releases/P2-2-BACKUP-RESTORE-CHECKPOINT.md`。

---

## 10. 回滚审计

来源：`DEPLOYMENT.md` §7（Prisma 无自动 down）。

| 层 | 方案 | 可执行性 |
| --- | --- | --- |
| 应用层 | 切回上一版本目录/进程（回滚 = `git checkout <上一个 RC tag>` + 重建 + restart） | 可复现（前提：RC 打 tag） |
| 数据层 | 迁移全部为向后兼容（新增列有默认值），**破坏性变更拆「先加→后用→再删」两段发布** | 设计约束 |
| 全库恢复 | 仅在必要时用迁移前备份 `pg_restore` | 需备份可用 |
| 回滚演练 | `tools/upgrade-verify/two-stage-upgrade.mjs`（两阶段升级取证） | 需 `psql` |

→ **GAP-10**：缺「RC tag 即发布单位」的正式命名约定（本 RC 建议打 `rc-20261008-linux-deploy`）。

---

## 11. 缺口清单（GAP）与处置建议

| ID | 缺口 | 影响 | 建议处置 | 本单元可否解决 |
| --- | --- | --- | --- | --- |
| GAP-01 | 缺 `crossclaim-api` / `crossclaim-web` 的 systemd unit | **无法守护主业务** | 新增两个 unit（最小权限、`Restart=on-failure`、`EnvironmentFile` 分离机密），需一次窄审计 | 需独立单元（新增部署面） |
| GAP-02 | 无 TLS / 反向代理 / 域名资产 | **不可公网发布** | HOST 选型（阿里云证书 + SLB 或 nginx），仓库补一份参考配置 | HOST 决策 |
| GAP-03 | unit 硬编码 `/opt/crossclaim` 与仓库实际位置不一致 | 部署即失败 | 部署前把仓库置于 `/opt/crossclaim`，或用 drop-in 覆盖 | 已文档化 |
| GAP-04 | `crossclaim-worker` 服务在文档中存在、代码中不存在 | 文档误导 | 修正 `RSI-DEPLOYMENT.md` §1 | 后续修 |
| GAP-05 | RSI 生产入口未接 `reconcile.store`（`RSI_RECONCILE=NOT_CONFIGURED`），且 env 模板无 `DATABASE_URL` | 重启后租约 reconcile 不生效 | 接线 Prisma store + 由密钥管理注入 `DATABASE_URL`（第二 `EnvironmentFile` 或 drop-in） | 需独立审计 |
| GAP-06 | `RSI-DEPLOYMENT.md` 文档漂移（Test C/F、`RSI_SIGNALS_PATH`） | 审计误导 | 修正文档 | 后续修 |
| GAP-07 | 无监控/告警/大盘 | 生产不可运维 | HOST 选型 | HOST |
| GAP-08 | 本机 Node 24 与文档要求 22.x 不一致 | 本地验证非等值 | 本地用 22.x 复验（或升文档并过 CI） | 部分 |
| GAP-09 | 迁移校验和门禁对 CRLF 敏感 | 本地假失败 | 门禁按 LF/`git hash-object` 比对 | 需评审（避免弱化语义） |
| GAP-10 | 无 RC tag 约定 | 回滚锚点不明确 | 本 RC 打 tag | 可做 |

> **本单元刻意不新建 api/web unit / TLS 配置**：它们属新增部署面，按 `AGENTS.md` §三·五应作为独立单元连同一次窄审计落地，
> 而不是塞进一个「部署准备」变更里暗中扩大攻击面。

---

## 12. Staging 验证结果（本机，非生产）

环境：Windows + Node 24.16.0 + 本地 PostgreSQL（`127.0.0.1:55432`，开发库）。
凭据：**仅使用本机随机生成的合成密钥**（`STORAGE_URL_SECRET` / `AUDIT_IP_SALT`），未使用任何生产凭据。

| 验证 | 结果 |
| --- | --- |
| `npm ci` 依赖已就位 | 可用 |
| `npx prisma validate` | valid |
| `npx prisma migrate status` | 94 migrations，up to date |
| `npm run build`（api） | exit 0 |
| `npx tsc --noEmit`（api） | exit 0 |
| **编译产物启动 API** | `node --env-file=.env dist/src/server.js` |
| `GET /health` | **200**（DB check ok） |
| `GET /readyz` | **200** `{"ready":true,"reasons":[]}`（修复前 503） |
| `GET /metrics` | 404（`METRICS_ENABLED=false`，符合默认） |
| Web `GET /` `/login` `/recoveries` | 200 / 200 / 200（`/` 首次请求 500 为 Next dev 首编译抖动，复测稳定 200） |
| Web `npm run typecheck` | exit 0 |
| Next.js `npm run build` | exit 0 |
| api 全量回归 | **4668/4669**（唯一失败 = 已登记 P2E-DB5 隔离 flake，单跑 20/20 全绿） |
| 定向：RSI + 历史扫描 + 架构契约 | 65 文件 / **576/576** |
| `readiness` 套件（含新增布局回归） | **11/11** |
| i18n 门禁 | 5 locales / 904 keys / 硬编码 0 |
| API 契约门禁 | `API_CONTRACT_OK`（implemented=100 / documented=87） |
| 审计覆盖门禁 | `AUDIT_COVERAGE_OK` |
| autopilot 规则门禁 | `AUTOPILOT_RULES_OK` |
| 许可证闸门 / OSS 登记 | PASS / OK |
| 迁移校验和门禁 | 本地假失败（CRLF，§3 已定性） |
| `tools/smoke/deploy-smoke.mjs` | **NOT EXECUTED**（需 Docker，本机 Docker 守护进程无响应） |
| `tools/backup-verify/*` | **NOT EXECUTED**（同上） |
| 触发器 / 一致性 SQL 门禁 | **NOT EXECUTED**（本机无 `psql`） |
| systemd A–F（含 kill -9 恢复、reboot reconcile） | **NOT EXECUTED**（需 Linux 实机） |
| GitHub Actions | **NOT_OBSERVED**（本地证据，不得表述为 CI green） |

---

## 13. 生产阻断项（当前）

1. **GAP-01** 主业务进程无 systemd 守护 → 不可上线。
2. **GAP-02** 无 TLS / 反向代理 → 不可公网暴露。
3. **GAP-05** RSI 生产入口未接 durable reconcile；`PRODUCTION_DURABLE_QUEUE_REQUIRED` 未解。
4. 六项生产启用债（`REAL_EXTERNAL_EXECUTION=NOT_EXECUTED`、`REAL_VALIDATION_COMPLETE=NO`、`PRODUCTION_READY=NO`、
   `PRODUCTION_DURABLE_QUEUE_REQUIRED`、scan fencing 无独立 `leaseEpoch`、unfenced `runHistoricalBackfill` 仅 test 路径、P2E-DB5 隔离债）**继续跟踪，不因本 RC 关闭**。
5. 真实模型调用未接通（见 `MODEL-PROVIDER-REAL-CALL-READINESS.md`）。
6. 生产密钥 / 生产数据库迁移 / 公开流量切换 / 外部自动提交 / 支付扣佣：全部 `HOST APPROVAL REQUIRED`。

---

## 14. 需要 HOST 提供的最小配置清单

| # | 项 | 用途 | 备注 |
| --- | --- | --- | --- |
| H1 | ECS 实例（Alibaba Cloud Linux）+ 规格 | 运行 api/web/rsi | 建议与数据库同 VPC |
| H2 | 仓库部署路径确认（`/opt/crossclaim`）+ 部署用户 | 满足 unit 契约 | 或批准 drop-in 覆盖路径 |
| H3 | PostgreSQL 16 连接串（**非生产先用 staging 库**） | `DATABASE_URL`，仅经密钥管理注入 | 不得写入仓库/unit |
| H4 | `STORAGE_URL_SECRET`（≥16 位）、`AUDIT_IP_SALT`（≥16 位） | API 启动必需（缺失即 fail-fast） | 密钥管理生成 |
| H5 | 域名 + 证书 + 入口形态（SLB/nginx） | TLS 终止 | GAP-02 |
| H6 | 监控选型（ARMS / Prometheus）与告警接收人 | 可运维 | GAP-07 |
| H7 | staging 环境批准 + 一次真实浏览器验收窗口 | 生产前最终验收 | 本单元只能做本机 staging |
| H8 | 六项生产启用债的放行顺序与责任人 | 生产 enablement | 不因本 RC 自动关闭 |

---

## 15. 不得宣称

- 不得写「已部署到阿里云」——本单元只做本机 staging 验证；
- 不得把 systemd A–F 标为通过——需要 Linux 实机；
- 不得把 `tools/smoke` / `backup-verify` / 触发器 SQL 门禁标为通过——本机未执行；
- 不得把本次结果表述为 CI green（GitHub Actions = NOT_OBSERVED）；
- 不得在未获授权时执行生产数据库迁移 / 生产密钥写入 / 公开流量切换 / 外部自动提交 / 支付扣佣。
