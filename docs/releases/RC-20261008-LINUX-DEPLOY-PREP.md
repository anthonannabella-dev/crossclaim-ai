# RC-20261008-LINUX-DEPLOY-PREP —— 发布候选单元记录

> 授权：HOST 批准「进入 Linux 服务器部署准备阶段，采用现有 systemd 方案，不新增 Docker 架构」。
> 性质：**部署准备 + 集成/回归/安全审计**。**不是**生产部署授权。
> 硬边界不变：`SECOND_RUNTIME / SECOND_SCHEDULER / SECOND_GUARD / SECOND_POLICY_ENGINE / SECOND_CONTROL_PLANE / SECOND_FACT_SOURCE = 0`；
> `REAL_PROVIDER_WRITE / CUSTOMS_FILING / PAYMENT / AUTO_COMMISSION_CHARGE / PRODUCTION_CREDENTIALS / PRODUCTION_ENABLEMENT / EXTERNAL_WRITE / TRANSPORT = HOLD`。

---

## 1. 发布候选身份

| 项 | 值 |
| --- | --- |
| 分支 | `release/rc-20261008-linux-deploy` |
| 来源分支 | `feat/historical-recovery-scan-v1`（AUDIT-1/2/3/4 全 PASS，`HISTORICAL_RECOVERY_SCAN_V1 = PASS / CLOSED`） |
| 基线 commit | `77b584e2` |
| RC 代码树锚点 | _（见 §9 回填）_ |
| 封板对照（**未修改**） | `release/integration-20261008` = `190d57a6` |
| `main` | **未使用**（本地 `444a246c` 已过时，落后 `origin/main` 1320 个提交） |
| 部署方式 | systemd（Alibaba Cloud Linux），无 Docker |

---

## 2. 本单元交付物

### 2.1 代码 / 配置修复（3 个部署硬缺陷）

| ID | 文件 | 变更 | 证据 |
| --- | --- | --- | --- |
| D1 | `apps/api/package.json` | `start`: `dist/server.js` → `dist/src/server.js` | 修复前 `Cannot find module '…\dist\server.js'` |
| D1b | `apps/api/package.json` | `rsi:start`: `dist/runtime/rsi-controller.js` → `dist/src/runtime/rsi-controller.js` | 同因（tsconfig `outDir=dist` + `rootDir="."`） |
| D2 | `deploy/systemd/crossclaim-rsi.service` | `ExecStart` → `/opt/crossclaim/apps/api/dist/src/runtime/rsi-run.js` | 修复前 `Cannot find module '…\dist\runtime\rsi-run.js'` |
| D3 | `apps/api/src/services/readiness.ts` | 迁移目录解析改为双布局择优（`migrationDirCandidates` / `resolveMigrationsDir`） | 修复前编译产物 `/readyz` = **503 MIGRATION_MISMATCH**；修复后 **200 {"ready":true,"reasons":[]}** |
| D3t | `apps/api/src/__tests__/readiness.test.ts` | 新增 3 条布局回归断言（09/10/11） | `readiness` 套件 **11/11** |
| — | `DEPLOYMENT.md` | 启动命令注释同步为 `dist/src/server.js` | — |

### 2.2 配置卫生（DeepSeek / Qwen）

- 保留 `apps/api/.env.example` 中的合理字段：`DEEPSEEK_API_KEY_REF` / `DEEPSEEK_BASE_URL` /
  `QWEN_API_KEY_REF` / `QWEN_BASE_URL` / `MODEL_PRIMARY` / `MODEL_FALLBACK`。
- **只含引用名，无任何真实取值**。全仓库已跟踪文件对真实 key 前缀 grep 命中 **0**；
  `apps/api/.env`（含真实取值）已被 `.gitignore` 覆盖，未被提交。

### 2.3 审计文档（本单元产出）

| 文档 | 内容 |
| --- | --- |
| `docs/releases/LINUX-DEPLOY-READINESS-AUDIT.md` | 环境条件 / 数据库迁移 / 端口 / TLS / 进程守护 / 日志 / 监控 / 备份 / 回滚 全量审计 + 10 项 GAP + staging 结果 |
| `docs/releases/MODEL-PROVIDER-REAL-CALL-READINESS.md` | 模型链=本地仿真的证据 + 接通真实 DeepSeek/Qwen 的配置与代码改动清单 |

---

## 3. 验证结果（本机 staging）

| 项 | 结果 |
| --- | --- |
| `prisma validate` | valid |
| `prisma migrate status` | 94 migrations，up to date |
| api `tsc --noEmit` | exit 0 |
| api `npm run build` | exit 0 |
| **编译产物启动 API + 真实 HTTP** | `/health` **200**、`/readyz` **200** |
| web `tsc --noEmit` | exit 0 |
| web `next build` | exit 0 |
| Web 真实 HTTP | `/` `/login` `/recoveries` = 200 / 200 / 200 |
| api 全量回归 | **4668/4669**（唯一失败 = 既存 P2E-DB5 隔离 flake；单跑 **20/20**） |
| 定向（RSI + 历史扫描 + 架构契约） | 65 文件 / **576/576** |
| readiness（含新增回归） | **11/11** |
| i18n / API 契约 / 审计覆盖 / autopilot / 许可证 / OSS | 全部 OK |
| 迁移校验和门禁 | 本地 CRLF 假失败（LF 归一化 sha256 == pinned） |
| deploy-smoke / backup-verify / 触发器 SQL / systemd A–F | **NOT EXECUTED**（需 Docker 或 Linux 实机） |
| GitHub Actions | **NOT_OBSERVED**（本地证据） |

> 凭据口径：staging 启动仅使用**本机随机生成的合成密钥**，未使用任何生产凭据。

---

## 4. 生产阻断项

1. **GAP-01**：缺 `crossclaim-api` / `crossclaim-web` systemd unit → 主业务进程无守护，**不可上线**。
2. **GAP-02**：无 TLS / 反向代理 / 域名资产 → **不可公网暴露**。
3. **GAP-05**：RSI 生产入口未接 durable reconcile（`RSI_RECONCILE=NOT_CONFIGURED`）；
   `PRODUCTION_DURABLE_QUEUE_REQUIRED` 未解。
4. 真实模型调用未接通（`REAL_PROVIDER_ADAPTER = NOT_IMPLEMENTED`）。
5. 其余 GAP-03/04/06/07/08/09/10 详见 `LINUX-DEPLOY-READINESS-AUDIT.md` §11。

---

## 5. 回滚方案

来源：`DEPLOYMENT.md` §7；本 RC 补充「RC tag 即发布单位」。

| 层 | 动作 |
| --- | --- |
| 应用层 | `git checkout <上一 RC tag>` → `npm ci` → `npm run build` → `systemctl restart crossclaim-*` |
| 数据层 | 迁移全为向后兼容（新增列有默认值）；破坏性变更按「先加 → 后用 → 再删」两段发布 |
| 全库恢复 | 仅在必要时用迁移前备份 `pg_restore`（需 HOST 授权） |
| 锚点 | RC 打 tag `rc-20261008-linux-deploy`（建议；见 §10 待办） |

---

## 6. 六项生产启用债（继续跟踪，**不因本 RC 关闭**）

1. `REAL_EXTERNAL_EXECUTION = NOT_EXECUTED`、`REAL_VALIDATION_COMPLETE = NO`、`PRODUCTION_READY = NO`；
2. `PRODUCTION_DURABLE_QUEUE_REQUIRED`（`createJsonTaskQueuePort()` 未用于 scan durability）；
3. scan fencing 暂无独立 `leaseEpoch / fencingVersion` 列；
4. acceptance seeder 与 legacy 内部测试仍可走 unfenced `runHistoricalBackfill`（仅 test/internal 路径）；
5. 单个 `fetchPage()` 超过 `leaseMs` 的窗口（接真实 provider 前需处理）；
6. 全量回归中的 P2E-DB5 隔离 flake（独立测试隔离债）。

---

## 7. HOST 最小配置清单

见 `LINUX-DEPLOY-READINESS-AUDIT.md` §14（H1–H8）。摘要：

ECS 实例与规格 · 部署路径 `/opt/crossclaim` 确认 · staging `DATABASE_URL`（密钥管理注入）·
`STORAGE_URL_SECRET` / `AUDIT_IP_SALT`（≥16 位）· 域名 + 证书 + 入口形态 · 监控选型 ·
staging 验收窗口 · 六项生产启用债放行顺序。

---

## 8. 状态登记

```
RC_BRANCH                     = release/rc-20261008-linux-deploy
RC_BASE_COMMIT                = 77b584e2
SEALED_RELEASE_UNTOUCHED      = release/integration-20261008 (190d57a6)
MAIN_USED                     = NO
DEPLOY_HARD_DEFECTS_FOUND     = 3 (D1 / D2 / D3) — 全部已修
LOCAL_STAGING_HTTP_VERIFIED   = YES (/health 200, /readyz 200, web 200)
LINUX_SYSTEMD_VERIFIED        = NO（需实机）
PRODUCTION_DEPLOY_PERFORMED   = NO
REAL_PROVIDER_CALLS           = 0（本地仿真）
SECOND_RUNTIME                = 0
SECOND_SCHEDULER              = 0
SECOND_GUARD                  = 0
PRODUCTION_READY              = NO
HOST_APPROVAL_REQUIRED        = 生产部署 / 生产迁移 / 生产密钥 / 公开流量 / 外部自动提交 / 支付扣佣
```

---

## 9. RC 代码树锚点（回填）

_（本文件所在提交的 commit SHA 在此回填，作为部署目标锚点。）_

---

## 10. 待办（下一步，需新授权或新单元）

1. 新增 `crossclaim-api.service` / `crossclaim-web.service`（GAP-01）+ 一次窄审计；
2. TLS / 反向代理参考配置（GAP-02）；
3. RSI 生产入口接线 durable reconcile（GAP-05）；
4. 修正 `RSI-DEPLOYMENT.md` 漂移（GAP-04 / GAP-06）；
5. RC tag `rc-20261008-linux-deploy`（GAP-10）；
6. 真实 provider sidecar + 窄审计（见 `MODEL-PROVIDER-REAL-CALL-READINESS.md` §3.4）。
