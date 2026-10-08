# RC-LINUX-DEPLOY FINALIZATION —— 审计送审包（AUDIT-RC-2）

> 依据：`MSG-20261008-14`（AUDIT-RC-1 = PASS WITH REVISE）＋ HOST 授权「实施 CHANGE 1 + CHANGE 3」。
> 送审锚点：**`40ea2b4d`**（分支 `release/rc-20261008-linux-deploy`）。
> 上一轮锚点 `32e28e94` 已通过（D1/D2/D3）；本包**不含**对 D1/D2/D3 的改动。

---

```
[CODEX → CHATGPT]

ID: C-RC20261008-02

TYPE:
DEPLOYMENT / RUNTIME_READINESS / SECURITY

MODULE:
systemd 服务补齐（api/web/rsi）＋ RSI durable reconcile 接线

STATUS:
READY_FOR_REVIEW（本机可验证项已完成；Linux 实机项如实标 NOT VERIFIED）

QUESTION:
1. CHANGE 1 是否 PASS？（unit 齐全、入口正确、单实例、硬化、重启/停止/日志、安装器幂等、无内联凭据）
2. CHANGE 3 是否 PASS？（durable reconcile 已接入 rsi-run；fail-closed；不新增运行时；不用内存队列兜底）
3. 未完成的 Linux 实机项与其余 P0/P1 债的登记是否完整、未被稀释？

CODEX_RECOMMENDATION:
CHANGE_1 = PASS；CHANGE_3 = PASS（本机证据）；Linux 实机部分建议记为 NOT VERIFIED 而非 FAIL。

NEED:
PASS / PASS WITH REVISE / REVISE / BLOCK
```

---

## 1. CHANGE 1 —— Linux systemd 服务补齐

### 1.1 交付物

| 文件 | 状态 |
| --- | --- |
| `deploy/systemd/crossclaim-api.service` | 新增 |
| `deploy/systemd/crossclaim-web.service` | 新增 |
| `deploy/systemd/crossclaim-rsi.service` | 复用 + 强化（新增 `RSI_RECONCILE_REQUIRED=true` 默认、单实例说明） |
| `deploy/install-services.sh` | 新增（api + web 幂等安装器） |
| `deploy/install-rsi-service.sh` | 强化（env 模板加入 `RSI_RECONCILE_REQUIRED=true`） |

### 1.2 三项编译产物入口（本机实测存在）

```
apps/api/dist/src/server.js                      = present
apps/api/dist/src/runtime/rsi-run.js             = present
apps/api/dist/src/runtime/rsi-controller.js      = present
apps/web/.next/BUILD_ID                          = present
```

| 服务 | ExecStart |
| --- | --- |
| API | `/usr/bin/node /opt/crossclaim/apps/api/dist/src/server.js` |
| Web | `/usr/bin/node /opt/crossclaim/apps/web/node_modules/next/dist/bin/next start -p 3001` |
| RSI | `/usr/bin/node /opt/crossclaim/apps/api/dist/src/runtime/rsi-run.js` |

### 1.3 配置要素对照（对应 CHANGE 1 的七项要求）

| 要求 | 落点 |
| --- | --- |
| 启动依赖 | api ← `postgresql.service`；web ← `crossclaim-api.service`；均 `After/Wants network-online.target` |
| 环境变量加载 | 每服务独立 `EnvironmentFile=/etc/crossclaim/{api,web,rsi}.env`；unit 内不内联凭据 |
| 专用服务账户 | `crossclaim-api` / `crossclaim-web` / `crossclaim-rsi`（`useradd --system --no-create-home --shell /usr/sbin/nologin`） |
| 文件权限 | `StateDirectory` + `install -d -m 0750 -o <user>`；env 文件 `0640 root:<user>` |
| 自动重启 | `Restart=on-failure` + `RestartSec=5` + `StartLimitIntervalSec=300` / `StartLimitBurst=5` |
| 优雅停止 | `KillSignal=SIGTERM` + `TimeoutStopSec=30`；RSI 停止时先 `$disconnect()` 再退出 |
| 日志管理 | `StandardOutput/Error=journal` + 独立 `SyslogIdentifier` |
| 单 RSI 主实例 | 仅 `crossclaim-rsi.service` 引用 `rsi-run`；无 `@` 模板；跨实例互斥由 durable lease（`ownerRef`）承担 |
| 静态配置检查 + 自动化回归 | `deploy-systemd-contract.test.ts` **19 条** |
| 不嵌入真实凭据 | 合同测试断言：无 `DATABASE_URL=postgres*`、无 `sk-*`、无 `STORAGE_URL_SECRET=` / `AUDIT_IP_SALT=` 取值 |

> 端口：API 3000、Web 3001、RSI health 4319（仅回环）。
> 可写面最小化：api 仅 `/var/lib/crossclaim-api`（`STORAGE_LOCAL_ROOT` 同步指向该目录）；
> web 仅 `/var/lib/crossclaim-web` + 自身 `/opt/crossclaim/apps/web/.next`（Next.js build cache）。

---

## 2. CHANGE 3 —— RSI Durable Reconcile

### 2.1 变更

| 文件 | 变更 |
| --- | --- |
| `apps/api/src/runtime/rsi-run-bootstrap.ts` | 新增：纯函数 `planReconcileBootstrap()` + 唯一副作用点 `openPrismaReconcile()` |
| `apps/api/src/runtime/rsi-run.ts` | 直跑入口按决策装配既有 `createPrismaRsiReconcileStore`；缺 DB 且要求 reconcile ⇒ 拒绝启动；停止时收敛连接 |
| `deploy/systemd/crossclaim-rsi.service` / `install-rsi-service.sh` | 生产默认 `RSI_RECONCILE_REQUIRED=true` |

### 2.2 语义（三态）

```
DATABASE_URL 存在                                ⇒ RSI_RECONCILE_SOURCE=PRISMA（复用既有 store）
DATABASE_URL 缺失 + RSI_RECONCILE_REQUIRED=true  ⇒ 拒绝启动（exit 1，fail-closed）
DATABASE_URL 缺失 + 未要求                        ⇒ RSI_RECONCILE=NOT_CONFIGURED（显式，不伪造）
```

- **不新建** scheduler / controller / runner；复用 ONE SI Runtime 与既有 reconcile store（`createsSecondReconcileStore=false`）；
- **不用内存队列兜底**（`inMemoryQueueAsFallback=false`，并有断言「入口不得引用 `createRsiInMemoryReconcileStore`」）；
- **未关闭任何安全校验**、未伪造状态、未降低 fail-closed 语义。

### 2.3 真实运行取证（本机，编译产物）

| 场景 | 观察到的输出 |
| --- | --- |
| A · 有 DATABASE_URL | `RSI_RECONCILE_SOURCE=PRISMA reason=DATABASE_URL_PRESENT`<br>`RSI_RECONCILE=expiredLeases=0 recoveredTasks=0 heldActiveLeases=0 idempotentNoop=true` |
| B · `DATABASE_URL=''` + `RSI_RECONCILE_REQUIRED=true` | **exit code = 1**；stderr `RSI_RECONCILE=REQUIRED_BUT_NO_DATABASE_URL reason=RSI_RECONCILE_REQUIRED_WITHOUT_DATABASE_URL` |
| C · 决策矩阵（真实进程内调用） | PRISMA / REQUIRED_BUT_MISSING_DATABASE_URL / NOT_CONFIGURED 三态正确 |
| D · 真实 PostgreSQL 收敛（与生产同源 `openPrismaReconcile`） | 过期租约 → `EXPIRED` + 任务回 `READY`；重复运行 `idempotentNoop=true`（0 行额外变化）；未过期租约 → 不动（`heldActiveLeases=1`） |

### 2.4 观察项（如实登记，非阻断）

`@prisma/client` 在 import 时会从 schema 目录自动加载 `.env`（dotenv 不覆盖已存在变量）。
因此本机 dev 环境总能看到 `DATABASE_URL`；复现 fail-closed 必须显式设 `DATABASE_URL=''`。
生产不应存在 `apps/api/.env`（凭据经 `EnvironmentFile` 注入），故不影响生产语义；
但「环境变量来源不应依赖隐式 dotenv」建议后续显式化。

---

## 3. 测试证据（local/Codex evidence）

| 项 | 结果 |
| --- | --- |
| api `tsc --noEmit` | exit 0 |
| api `npm run build` | exit 0 |
| `prisma validate` | valid |
| 定向回归（RSI + 历史扫描 + 架构契约 + config + 部署合同） | 66 文件 / **601 tests 全绿** |
| `deploy-systemd-contract.test.ts`（新增） | 19/19 |
| `rsi-reconcile-bootstrap.test.ts`（新增） | 11/11 |
| api 全量回归（本 RC 树） | **见 §5 回填** |
| GitHub Actions | **NOT_OBSERVED** |

---

## 4. 仍未关闭（不得默认为已解决）

| 项 | 状态 |
| --- | --- |
| Linux 实机 systemd A–F（`kill -9` 恢复 / reboot reconcile） | **NOT VERIFIED**（需 Alibaba Cloud Linux 实机） |
| deploy-smoke / backup-verify / 触发器与一致性 SQL | **NOT EXECUTED**（本机无 Docker 守护进程 / 无 `psql`） |
| TLS / 反向代理 / 域名（CHANGE 2） | **未实施**（需 HOST 选型） |
| `PRODUCTION_DURABLE_QUEUE_REQUIRED`（`createJsonTaskQueuePort`） | **未解** |
| scan fencing 无独立 `leaseEpoch / fencingVersion` | **未解** |
| unfenced `runHistoricalBackfill`（test/internal 路径） | **未解** |
| 单页 `fetchPage()` 超 `leaseMs` 窗口 | **未解** |
| P2E-DB5 / broker hook 超时 | **测试债未关闭** |
| 真实 DeepSeek/Qwen 调用 | **未接通**（仍 local-sim；需 sidecar + 窄审计） |

---

## 5. 全量回归结果（回填）

**本 RC 树（`40ea2b4d`）连续两次全量回归，结果不一致 —— 如实登记两次。**

| 轮次 | 结果 | 失败明细 |
| --- | --- | --- |
| 第 1 次 | **4702 tests → 5 failed / 4697 passed**（3 个文件） | 可见：`payment-activation-readiness-http-db`（setup 阶段 `TRUNCATE` 后 `Organization.id` 唯一约束冲突）、`recovery-si-phase2-e-db`（P2E-DB5）；其余失败项因终端输出截断未逐条捕获 |
| 第 2 次 | **4702 tests → 1 failed / 4701 passed** | 仅 `recovery-si-phase2-e-db` P2E-DB5 |
| P2E-DB5 单跑 | **20/20 PASS** | 隔离运行通过 |

**判读（不美化）**：

- 两次运行唯一共同的失败是**已登记**的 P2E-DB5 隔离债；
- 第 1 次的另外 4 个失败在第二次运行中**未复现**，且失败形态是 setup 期共享表 `TRUNCATE` 后的唯一约束冲突
  ⇒ 与「全量串行下的跨套件 DB 状态/顺序耦合」一致，属**测试隔离债**，不是本单元改动的确定性回归；
- 但**不得**据此写「全量全绿」。准确表述：`FULL REGRESSION ≠ 100% GREEN`，
  两次分别为 4697/4702 与 4701/4702，均在 local/Codex evidence 口径下。
- 本单元改动面为 `runtime/rsi-run*.ts`、`__tests__/*`、`deploy/**`、`docs/**`，
  **未触碰** Payment / Recovery-SI / Organization 领域实现或 Schema。

> 该债已作为 AUDIT-RC-1 CHANGE 5 的要求继续跟踪；本单元未关闭它。
