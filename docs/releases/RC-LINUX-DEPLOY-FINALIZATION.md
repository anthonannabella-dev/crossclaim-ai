# RC-LINUX-DEPLOY FINALIZATION —— CHANGE 1 + CHANGE 3 实施记录

> 授权：HOST（本指令）＝ APPROVED。依据：`MSG-20261008-14`（AUDIT-RC-1 = PASS WITH REVISE）。
> 分支：`release/rc-20261008-linux-deploy`｜起点 HEAD：`d362d5a3`。
> 硬边界不变：`SECOND_RUNTIME / SCHEDULER / GUARD / POLICY_ENGINE = 0`；
> `REAL_PROVIDER_WRITE / CUSTOMS_FILING / PAYMENT / AUTO_COMMISSION_CHARGE / PRODUCTION_CREDENTIALS /
> PRODUCTION_ENABLEMENT / EXTERNAL_WRITE / TRANSPORT = HOLD`；`PRODUCTION_READY = NO`。

---

## 1. PHASE A — CHANGE 1：Linux systemd 服务补齐

### 1.1 交付物

| 文件 | 作用 |
| --- | --- |
| `deploy/systemd/crossclaim-api.service` | 新增：API 服务（专用账户、启动依赖、env 加载、硬化、重启、优雅停止、journald） |
| `deploy/systemd/crossclaim-web.service` | 新增：Web 服务（Next.js，不直连数据库） |
| `deploy/systemd/crossclaim-rsi.service` | 复用并强化：新增 `RSI_RECONCILE_REQUIRED=true` 生产默认 + 单实例说明 |
| `deploy/install-services.sh` | 新增：api + web 幂等安装器（`--dry-run`、不覆盖已有 env、健康检查） |
| `deploy/install-rsi-service.sh` | 强化：环境模板加入 `RSI_RECONCILE_REQUIRED=true` |

### 1.2 三项真实编译产物入口（实测存在）

| 服务 | ExecStart | 对应 package.json |
| --- | --- | --- |
| API | `/usr/bin/node /opt/crossclaim/apps/api/dist/src/server.js` | `start = node dist/src/server.js` |
| Web | `/usr/bin/node /opt/crossclaim/apps/web/node_modules/next/dist/bin/next start -p 3001` | `start = next start -p 3001` |
| RSI | `/usr/bin/node /opt/crossclaim/apps/api/dist/src/runtime/rsi-run.js` | `rsi:run`（tsx）/ 产物同名 |

### 1.3 关键设计

- **专用账户**：`crossclaim-api` / `crossclaim-web` / `crossclaim-rsi`，均 `nologin`、无 sudo、无 docker 组。
- **启动依赖**：api ← `network-online.target postgresql.service`；web ← `network-online.target crossclaim-api.service`。
- **环境变量**：每服务独立 `EnvironmentFile`（`/etc/crossclaim/{api,web,rsi}.env`），unit 内**不内联任何凭据**。
- **文件权限**：`StateDirectory` + `install -d -m 0750 -o <user>`；env 文件 `0640 root:<user>`。
- **自动重启**：`Restart=on-failure` + `RestartSec=5` + `StartLimitIntervalSec=300` / `StartLimitBurst=5`（防 crash loop）。
- **优雅停止**：`KillSignal=SIGTERM` + `TimeoutStopSec=30`；RSI 侧 `SIGTERM` 会先 `$disconnect()` 再退出。
- **日志**：`StandardOutput/Error=journal` + 独立 `SyslogIdentifier`。
- **可写面最小化**：api 仅 `/var/lib/crossclaim-api`（`STORAGE_LOCAL_ROOT` 同步指向该目录）；web 仅 `/var/lib/crossclaim-web` + 自身 `.next`（Next.js build cache 需要）。

### 1.4 单实例约束（systemd 不会意外拉起多个 RSI 主实例）

1. **只有** `crossclaim-rsi.service` 引用 `rsi-run` 入口（由部署合同测试锁定）；
2. 无 `@` 模板实例、无任何 unit 去 `systemctl start` 另一个 RSI；
3. 跨实例互斥由 **durable lease** 承担：`ownerRef = rsi-runtime:<进程启动UUID>:<pid>`，只有租约到期才可被接管。

### 1.5 自动化静态检查

`apps/api/src/__tests__/deploy-systemd-contract.test.ts`（**19 条**）：入口路径 / 硬化集合 / 重启上限 / 取消与日志 / 可写路径 / 单实例 / env 文件隔离 / **禁止内联真实凭据** / 安装器幂等与双服务健康检查。

---

## 2. PHASE B — CHANGE 3：RSI Durable Reconcile 接线

### 2.1 变更

| 文件 | 变更 |
| --- | --- |
| `apps/api/src/runtime/rsi-run-bootstrap.ts`（新增） | 纯函数 `planReconcileBootstrap()` + 唯一副作用点 `openPrismaReconcile()` |
| `apps/api/src/runtime/rsi-run.ts` | 直跑入口按决策装配 `reconcile`；缺 DB 且要求 reconcile ⇒ **拒绝启动**；停止时收敛 DB 连接 |
| `deploy/systemd/crossclaim-rsi.service` / `install-rsi-service.sh` | 生产默认 `RSI_RECONCILE_REQUIRED=true` |

### 2.2 语义

```
DATABASE_URL 存在                     ⇒ RSI_RECONCILE_SOURCE=PRISMA（复用既有 createPrismaRsiReconcileStore）
DATABASE_URL 缺失 + RSI_RECONCILE_REQUIRED=true  ⇒ 拒绝启动（exit 1，fail-closed）
DATABASE_URL 缺失 + 未要求                        ⇒ RSI_RECONCILE=NOT_CONFIGURED（显式、不伪造）
```

- **不新建** scheduler / controller / runner；复用 ONE SI Runtime 与既有 reconcile store；
- **不用内存队列兜底**（`inMemoryQueueAsFallback = false`，且有测试断言入口不引用内存 store）；
- 未关闭任何安全校验，未伪造状态。

### 2.3 真实运行取证（本机）

| 场景 | 命令 | 结果 |
| --- | --- | --- |
| A · 有 DATABASE_URL | `node --env-file=.env dist/src/runtime/rsi-run.js` | `RSI_RECONCILE_SOURCE=PRISMA reason=DATABASE_URL_PRESENT`；`RSI_RECONCILE=expiredLeases=0 recoveredTasks=0 heldActiveLeases=0 idempotentNoop=true` |
| B · 无 DATABASE_URL + REQUIRED | `DATABASE_URL='' RSI_RECONCILE_REQUIRED=true node dist/src/runtime/rsi-run.js` | **exit code = 1**；stderr `RSI_RECONCILE=REQUIRED_BUT_NO_DATABASE_URL`（拒绝启动） |
| C · 决策矩阵（真实进程） | 直接调用 `planReconcileBootstrap()` | PRISMA / REQUIRED_BUT_MISSING_DATABASE_URL / NOT_CONFIGURED 三态均正确 |

### 2.4 观察项（非阻断，如实登记）

`@prisma/client` 在 import 时会从 schema 目录自动加载 `.env`（dotenv 不覆盖已存在变量）。
因此本机 dev 环境**总是**能看到 `DATABASE_URL`；要复现 fail-closed 必须显式把 `DATABASE_URL` 设为空串。
生产不应存在 `apps/api/.env`（密钥经 `EnvironmentFile` 注入），故该行为不影响生产语义；
但**「环境变量来源」不应依赖隐式 dotenv** —— 建议后续单元显式化（已登记）。

---

## 3. PHASE C — 回归结果（local/Codex evidence）

| 项 | 结果 |
| --- | --- |
| api `tsc --noEmit` | exit 0 |
| api `npm run build` | exit 0 |
| `prisma validate` | valid |
| **定向回归（RSI + 历史扫描 + 架构契约 + config + 部署合同）** | **66 文件 / 601 tests 全绿** |
| 其中新增 | `deploy-systemd-contract` 19/19、`rsi-reconcile-bootstrap` 11/11 |
| 真实 PG 收敛（与生产同源 `openPrismaReconcile`） | 过期租约 → EXPIRED + 任务回 READY；重复运行幂等；未过期租约不动 |
| 全量回归 | 见 §6（本轮结束前执行） |
| GitHub Actions | **NOT_OBSERVED**（记为 local/Codex evidence） |

---

## 4. 仍未关闭（不得默认为已解决）

| 项 | 状态 | 说明 |
| --- | --- | --- |
| Linux 实机 systemd A–F（含 `kill -9` 恢复、reboot） | **NOT VERIFIED** | 需 Alibaba Cloud Linux 实机 |
| deploy-smoke / backup-verify / 触发器与一致性 SQL | **NOT EXECUTED** | 本机无 Docker 守护进程 / 无 `psql` |
| TLS / 反向代理 / 域名 | **未实施** | 属 CHANGE 2，需 HOST 选型 |
| durable queue（`createJsonTaskQueuePort`） | **未解** | `PRODUCTION_DURABLE_QUEUE_REQUIRED` 继续跟踪 |
| scan fencing 无独立 `leaseEpoch` | **未解** | 继续跟踪 |
| unfenced `runHistoricalBackfill` | **未解** | 仅 test/internal 路径 |
| 单页 `fetchPage()` 超 `leaseMs` 窗口 | **未解** | 接真实 provider 前需处理 |
| P2E-DB5 / broker hook 超时测试债 | **未关闭** | 独立测试隔离债 |
| 真实模型调用（DeepSeek/Qwen） | **未接通** | 仍 local-sim，需 sidecar + 窄审计 |

---

## 5. 变更清单（本单元）

新增：`deploy/systemd/crossclaim-api.service`、`deploy/systemd/crossclaim-web.service`、`deploy/install-services.sh`、
`apps/api/src/runtime/rsi-run-bootstrap.ts`、`apps/api/src/__tests__/deploy-systemd-contract.test.ts`、
`apps/api/src/__tests__/rsi-reconcile-bootstrap.test.ts`、本文件。

修改：`deploy/systemd/crossclaim-rsi.service`、`deploy/install-rsi-service.sh`、`apps/api/src/runtime/rsi-run.ts`。

**未改动**：`main`、`release/integration-20261008`、任何 Prisma schema / migration、`SECOND_*` 相关实现。

---

## 6. 独立复审结果（AUDIT-RC-2 = `MSG-20261008-15`）

**VERDICT = PASS WITH REVISE**（reviewed ref `40ea2b4d`）

| 审计项 | 裁决 |
| --- | --- |
| CHANGE_1_SYSTEMD | **PASS** |
| CHANGE_3_RECONCILE | **PASS** |
| INCOMPLETE_ITEMS_HONESTY | **PASS** |
| FULL_REGRESSION_HONESTY | **PASS** |

机器可读口径（原文节选）：

```
CHANGE_1_STATIC_CONTRACT=PASS
CHANGE_3_RECONCILE_WIRING=PASS
TARGETED_REGRESSION=PASS
FULL_REGRESSION_100_PERCENT_GREEN=NO
LINUX_SYSTEMD_REAL_HOST_VERIFIED=NO
PRODUCTION_DURABLE_QUEUE_VERIFIED=NO
HISTORICAL_SCAN_FENCING_VERIFIED=NO
TLS_REVERSE_PROXY_READY=NO
DEPLOY_SMOKE_VERIFIED=NO
BACKUP_RESTORE_VERIFIED=NO
GITHUB_ACTIONS_VERIFIED=NO
REAL_PROVIDER_VALIDATION_COMPLETE=NO
RC_CHANGE_1_3_CODE_SCOPE=ACCEPTED_WITH_HOST_VALIDATION_PENDING
RC_LINUX_DEPLOY_FINALIZATION=CLOSED_NO
PRODUCTION_READY=NO
NEXT_ACTION=COMPLETE_RC_RELEASE_BLOCKERS_AND_REAL_LINUX_ACCEPTANCE
```

**复审给出的 9 项后续必须收敛事项**

| 编号 | 要求 | 优先级 |
| --- | --- | --- |
| RC-C1 | 阿里云 Linux 实机 systemd A–F（`kill -9`、reboot、reconcile） | P0 |
| RC-C2 | 完成 TLS / 反向代理（AUDIT-RC-1 CHANGE 2），需 HOST 确认方案 | P0 |
| RC-C3 | 明确生产 Durable Queue 强制条件，缺失时 fail-closed | P0 |
| RC-C4 | 历史扫描写入增加 fencing 或等价严格并发防护 | P0 |
| RC-C5 | 消除或证明单页 `fetchPage` 超 `leaseMs` 不会产生重复/陈旧写入 | P0 |
| RC-C6 | 清理 P2E-DB5 与共享测试数据隔离债，取得稳定全量回归 | P1 |
| RC-C7 | 执行 deploy-smoke / backup-verify / 触发器与一致性 SQL | P0 |
| RC-C8 | 显式化 Prisma 环境变量来源，核验生产环境文件权限 | P1 |
| RC-C9 | 真实模型 / Provider 沙箱验证 + GitHub Actions 取证 | P0（功能开放前） |

**复审风险**：R1 生产队列未强制持久化（HIGH）；R2 Historical Scan 缺独立 fencing（HIGH）；
R3 Linux 实机未验收（MEDIUM–HIGH）；R4 全量测试仍非绿色（MEDIUM）；R5 外部 Provider 未启用（MEDIUM–HIGH）。

**复审明确的两点保留意见（本轮不豁免）**：
1. 「只有一个 unit」≠「跨机器只有一个有效执行者」——后者依赖 DB 租约与 fencing 的真实正确性；
2. 过期租约恢复正确 ≠ 旧执行者复活后无法写入——缺 `leaseEpoch` / `fencingVersion` 仍有陈旧写入风险。

> 归档：`AI-ARCHITECT-INBOX.md` → **`MSG-20261008-15`**，逐字比对 **`FULL_COPY_OK`**（159 行，缺失 0 / 多出 0）。

---

## 7. 状态登记（本单元收口）

```
RC_BRANCH                        = release/rc-20261008-linux-deploy
CHANGE_1_SYSTEMD                 = PASS（静态实现 + 合同测试；实机待验证）
CHANGE_3_RECONCILE               = PASS（接线 / 三态 / fail-closed；实机待验证）
AUDIT_RC_2                       = PASS WITH REVISE（MSG-20261008-15）
RSI_RECONCILE_STATUS             = 已接线；有 DB ⇒ PRISMA；无 DB+REQUIRED ⇒ 拒绝启动；无 DB+未要求 ⇒ NOT_CONFIGURED
LINUX_SYSTEMD_REAL_HOST_VERIFIED = NO
RC_LINUX_DEPLOY_FINALIZATION     = CLOSED_NO
FULL_REGRESSION_100_PERCENT_GREEN= NO（两次 4697/4702、4701/4702）
SECOND_RUNTIME / SCHEDULER / GUARD = 0
PRODUCTION_READY                 = NO
HOST_APPROVAL_REQUIRED           = Linux 实机 / TLS 方案 / 生产迁移 / 生产密钥 / 公开流量 / 外部写 / 支付
```
