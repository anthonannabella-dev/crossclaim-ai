# RSI Controller —— 服务器部署与自动启动（Alibaba Cloud Linux / systemd）

> ⚠️ **SUPERSEDED（历史归档）** —— 自 2026-10-08 起，CrossClaim 唯一正式部署入口为仓库根目录 `DEPLOYMENT.md`
> （配合 `deploy/release-manifest.json` 与 `node deploy/verify-release.mjs` 门禁）。
> 本文仅作历史记录保留，**不得作为部署流程依据**；内容冲突时以 `DEPLOYMENT.md` + manifest 为准。
> 归档索引：`docs/archive/DEPLOYMENT-HISTORY.md`


> 依据 OWNER 任务《补齐 RSI Controller 的服务器部署与自动启动能力》。
> 硬约束不变：External Write / Payment / Customs Filing / Broker 特权执行 / 生产凭据全部 **HOLD**，只能由 OWNER gate 放行。

## 1. 服务拆分

| 服务 | 说明 |
| --- | --- |
| `crossclaim-web` | Next.js 前端 |
| `crossclaim-api` | Node API |
| `crossclaim-worker` | 后台任务 |
| `crossclaim-rsi` | **本服务**：RSI Controller（signal → incident → task → candidate 编排） |
| `crossclaim-agent-runner` | 未来：服务器侧 Builder/Judge 执行器（当前 Builder 仍可用本地 Codex，但**生产 RSI 不依赖本地 Codex**） |

RSI 与 web/api/worker 进程隔离：RSI 崩溃不影响主业务。

## 2. 启动命令

| 目的 | 命令 |
| --- | --- |
| 开发运行 | `npm --prefix apps/api run rsi:dev` |
| 生产运行（编译产物） | `npm --prefix apps/api run rsi:start` |
| 健康检查 | `npm --prefix apps/api run rsi:health` |
| systemd | `systemctl {start,stop,restart,status} crossclaim-rsi` |
| 日志 | `journalctl -u crossclaim-rsi -f` |

### 2.1 事件驱动运行的环境变量（`/etc/crossclaim/rsi.env`）

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `RSI_TASKS_PATH` | 安全队列 artifact（只读 JSON：`[{id,priority,dedupeKey}]`） | 未设=空队列（静默） |
| `RSI_CI_RESULTS_PATH` | CI 结果 artifact（`[{runId,head,status,conclusion}]`） | 未设=不触发 |
| `RSI_VERDICT_PATH` | 裁决 artifact（`{messageId,verdict:PASS/REVISE/BLOCK}`） | 未设=不触发 |
| `RSI_TEST_RESULTS_PATH` | 测试结果 artifact（`{fingerprint,passed}`） | 未设=不触发 |
| `RSI_WATCHDOG_INTERVAL_MS` | Watchdog 兜底间隔（**只兜底**，不驱动推进） | `60000` |
| `RSI_STATE_FILE` | 进程自用日志（记录被领取任务；不含凭据/客户数据） | `rsi-run.log` |

> 运行入口是 `rsi-run`（事件驱动）：**无事件时不产生任何输出**；只有事件丢失 / worker idle 且队列非空 / lease 超时，才由 60s Watchdog 兜底。`rsi:dev` / `rsi:start` 保留为纯控制器骨架入口。


入口是真实 Runtime：`apps/api/src/runtime/rsi-controller.ts`（只读扫描 + 仅回环 `127.0.0.1:4319/health`）。

## 3. 首次启用（OWNER 只做一次）

```bash
sudo deploy/install-rsi-service.sh        # build → 用户 → unit → daemon-reload → enable → restart → health 校验
sudo systemctl enable crossclaim-rsi
sudo systemctl start crossclaim-rsi
```

此后 reboot 无需人工干预。

## 4. 安全边界

- 专用最小权限用户 `crossclaim-rsi`（无 login shell / 无 sudo / 无 docker 组）；
- `NoNewPrivileges`、`ProtectSystem=strict`、`ProtectHome`、`PrivateTmp`、空 `CapabilityBoundingSet`；
- 仅可写 `/var/lib/crossclaim-rsi`；
- `EnvironmentFile=/etc/crossclaim/rsi.env` 不放明文生产凭据（`DATABASE_URL` 由密钥管理注入）；
- Kill Switch：`RSI_ENABLED=false` / `RSI_PAUSED=1` → RSI 存活但空转，不影响 API/Web，不删历史、不改 baseline；不可由 RSI 自关。

## 5. 验收测试映射（Test A–F）

| 测试 | 判据 | 本仓库现状 |
| --- | --- | --- |
| A 正常启动 | `systemctl status` active；`rsi:health` → `HEALTHY` | 健康载荷/状态推导已有单测（`rsi-controller.test.ts`） |
| B 进程被杀自动恢复 | `kill -9` → systemd 自动拉起 | 需 Linux+systemd；Windows 开发机**不可执行**（unit 已配 `Restart=on-failure`/`RestartSec=5`） |
| C 重启后恢复且不重复 | reboot → reconcile，不重复 incident/candidate/promotion | **未实现**，需 DB 持久化 + lease reconcile（见第 6 节） |
| D 连续失败不 crash loop | 阈值后 `DEGRADED` + OWNER 通知 | 策略已实现 + 单测（`rsi-supervisor-policy.test.ts`：窗口 5 次 → `DEGRADED_STOP` + `notifyOwner`） |
| E `RSI_ENABLED=false` | RSI 停自治、API/Web 正常 | 已实现 + 单测（`rsi-runtime-config.test.ts`、`rsi-controller.test.ts` 空转断言） |
| F 重新启用后 reconcile | 恢复消费安全队列 | **未实现**（同 C） |

## 6. 未完成项与阻塞原因（诚实记录）

1. **状态持久化与 reconcile（Test C/F）**：需要 Postgres 表（Incident/Task/Candidate/EvaluationRun/lease）与 append-only 证据；新增表属 **Schema Delta**，须单独送审后再落 migration。在此之前 RSI 只做只读扫描，不创建任务、不触碰外部系统。
2. **结构化日志字段**：incidentId/taskId/candidateId/transition 等字段需随持久化统一落地。
3. **Admin UI `/admin/autonomy`**：依赖第 1 项的数据面。
4. **B/D 的 systemd 侧验证**：需要 Alibaba Cloud Linux 主机；本机无 systemd，无法伪造证据。
