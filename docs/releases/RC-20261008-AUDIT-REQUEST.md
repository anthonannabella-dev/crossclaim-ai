# RC-20261008-LINUX-DEPLOY-PREP —— 审计送审包（AUDIT-RC-1）

> 用途：本文件是**持久审计记录**；右侧 ChatGPT 会话只作唤醒通道，裁决必须落回 `AI-ARCHITECT-INBOX.md`。
> 送审锚点：**RC 代码树 `32e28e94`**（分支 `release/rc-20261008-linux-deploy`）。
> 说明：本文件本身的回填 commit 只改文档，不改代码树；代码树锚点仍为 `32e28e94`。

---

```
[CODEX → CHATGPT]

ID: C-RC20261008-01

TYPE:
DEPLOYMENT_READINESS / SECURITY / INTEGRATION

PR:
（无 PR；分支 release/rc-20261008-linux-deploy，来源 feat/historical-recovery-scan-v1）

MODULE:
部署准备（systemd / Linux）+ apps/api 启动与就绪路径 + 模型 provider 就绪度

STATUS:
READY_FOR_REVIEW（本机 staging 已通过；Linux 实机项未执行）

QUESTION:
1. 三个部署硬缺陷（D1/D2/D3）的修复是否正确、充分、不越界？
2. 「部署准备」这一单元是否允许在**不新增 api/web systemd unit、不新增 TLS 资产**的前提下收口，
   把它们登记为 GAP 交给后续独立单元？
3. `readiness.ts` 的双布局路径解析是否引入任何安全隐患（例如可用性探测被伪造为 ready）？
4. 六项生产启用债的登记是否完整、未被本次 PASS 稀释？

CODEX_RECOMMENDATION:
1. D1/D2/D3 均按最小改动修复，并新增布局回归断言；建议 PASS。
2. 建议允许收口：api/web unit 与 TLS 属**新增部署面**，按 AGENTS.md §三·五应独立送审，
   不应塞进「部署准备」变更里扩大攻击面。
3. 解析仅在两个候选路径中择优，找不到仍返回 -1（fail-closed → MIGRATION_MISMATCH），
   未放宽任何就绪条件；`/readyz` 仍只回原因码。
4. 六项债原样保留，见 §4。

NEED:
PASS / REVISE / BLOCK
```

---

## 1. 送审改动摘要（exact diff scope）

| # | 文件 | 性质 |
| --- | --- | --- |
| 1 | `apps/api/package.json` | `start` / `rsi:start` 产物路径修正 |
| 2 | `deploy/systemd/crossclaim-rsi.service` | `ExecStart` 产物路径修正（+ 注释） |
| 3 | `apps/api/src/services/readiness.ts` | 迁移目录双布局解析（新增两个导出函数） |
| 4 | `apps/api/src/__tests__/readiness.test.ts` | 新增 3 条布局回归断言（09/10/11） |
| 5 | `DEPLOYMENT.md` | 启动命令注释同步 |
| 6 | `apps/api/.env.example` | 保留 DeepSeek/Qwen **引用名字段**（无取值） |
| 7 | `docs/releases/LINUX-DEPLOY-READINESS-AUDIT.md` | 新增：部署就绪审计 |
| 8 | `docs/releases/MODEL-PROVIDER-REAL-CALL-READINESS.md` | 新增：模型链就绪审计 |
| 9 | `docs/releases/RC-20261008-LINUX-DEPLOY-PREP.md` | 新增：RC 单元记录 |

**未改动**：`release/integration-20261008`（`190d57a6`）、`main`、任何 Prisma schema/migration、任何 runtime/guard/policy 实现。

---

## 2. 三个硬缺陷：证据与修复

### D1 / D1b —— 启动入口指向不存在的产物

`apps/api/tsconfig.json`：`"outDir": "dist"` + `"rootDir": "."` + `"include": ["src/**/*.ts", "vitest.config.ts"]`
⇒ 实际产物为 `dist/src/server.js`、`dist/src/runtime/rsi-run.js`，而**不存在** `dist/server.js`。

修复前实测：

```
node dist/server.js        → Error: Cannot find module 'D:\crossclaim-ai\apps\api\dist\server.js'
node dist/runtime/rsi-run.js → Error: Cannot find module 'D:\crossclaim-ai\apps\api\dist\runtime\rsi-run.js'
```

修复后：`npm start` → `node dist/src/server.js`，服务成功监听。

### D2 —— systemd 单元同样指向不存在产物

`deploy/systemd/crossclaim-rsi.service` 的 `ExecStart=/usr/bin/node /opt/crossclaim/apps/api/dist/runtime/rsi-run.js`
→ 改为 `/opt/crossclaim/apps/api/dist/src/runtime/rsi-run.js`。

### D3 —— 编译产物下 `/readyz` 恒 503

`countLocalMigrations()` 原实现：`path.join(__dirname, '..', '..', 'prisma', 'migrations')`。

| 布局 | `__dirname` | 解析结果 | 是否存在 |
| --- | --- | --- | --- |
| 源码 `src/services/` | `.../apps/api/src/services` | `.../apps/api/prisma/migrations` | 存在（94） |
| 编译 `dist/src/services/` | `.../apps/api/dist/src/services` | `.../apps/api/dist/prisma/migrations` | **不存在** → `-1` |

`-1` ⇒ `expectedMigrations < 0` ⇒ `MIGRATION_MISMATCH` ⇒ `/readyz` **503**（DB 实际已迁移完整）。

修复前 / 修复后实测（同一编译产物、同一数据库）：

```
修复前: GET /readyz → 503
修复后: GET /readyz → 200 {"ready":true,"reasons":[],"checkedAt":"…","version":"0.1.0"}
        GET /health → 200 {"status":"ok",…,"checks":{"database":{"ok":true,…}}}
```

修复语义：`migrationDirCandidates()` 给出两个候选，`resolveMigrationsDir()` 取第一个**存在且含子目录**的；
全部不可用仍返回 `null` → `-1` → 仍然 `MIGRATION_MISMATCH`（fail-closed **未被放宽**）。

---

## 3. 验证证据（本机 staging，编译产物）

| 项 | 结果 |
| --- | --- |
| `prisma validate` | valid |
| `prisma migrate status` | 94 migrations，`up to date` |
| api `tsc --noEmit` | exit 0 |
| api `npm run build` | exit 0 |
| 编译产物真实 HTTP | `/health` 200、`/readyz` 200 |
| web `tsc --noEmit` / `next build` | exit 0 / exit 0 |
| Web 真实 HTTP | `/` `/login` `/recoveries` = 200 / 200 / 200 |
| 定向（RSI + 历史扫描 + 架构契约） | 65 文件 / 576/576 |
| 架构契约 / readiness / config / rsi-deployment-contract | 173 / 11 / 15 / 4 = **203/203** |
| i18n | 5 locales / 904 keys / 硬编码 0 |
| API 契约 / 审计覆盖 / autopilot / 许可证 / OSS | 全部 OK |
| **api 全量回归（RC 代码树 32e28e94）** | **4670/4672**（2 失败均为满负载 flake：P2E-DB5 隔离 + broker hook 超时；两个文件单跑 **30/30**） |
| 迁移校验和门禁 | 本地 CRLF 假失败（LF 归一化 sha256 == pinned `2acbd87a…`；`git hash-object` == pinned blob） |
| deploy-smoke / backup-verify / 触发器 SQL 门禁 | **NOT EXECUTED**（本机无 Docker / 无 psql） |
| systemd A–F（kill -9 恢复 / reboot reconcile） | **NOT EXECUTED**（需 Linux 实机） |
| GitHub Actions | **NOT_OBSERVED**（本地证据；不得表述为 CI green） |

> 凭据口径：staging 启动仅使用本机随机生成的**合成密钥**（`STORAGE_URL_SECRET` / `AUDIT_IP_SALT`），
> 未使用任何生产凭据；真实 DeepSeek/Qwen key 未参与任何调用。

---

## 4. 六项生产启用债（请确认未被稀释）

1. `REAL_EXTERNAL_EXECUTION = NOT_EXECUTED`、`REAL_VALIDATION_COMPLETE = NO`、`PRODUCTION_READY = NO`；
2. `PRODUCTION_DURABLE_QUEUE_REQUIRED`（`createJsonTaskQueuePort()` 未用于 scan durability）；
3. scan fencing 无独立 `leaseEpoch / fencingVersion` 列；
4. acceptance seeder 与 legacy 内部测试仍可走 unfenced `runHistoricalBackfill`（仅 test/internal）；
5. 单个 `fetchPage()` 超过 `leaseMs` 的窗口；
6. P2E-DB5 隔离 flake。

---

## 5. 本单元**未**做的事（防越界声明）

- 未新增 `crossclaim-api.service` / `crossclaim-web.service`（GAP-01）；
- 未新增 TLS / 反向代理 / 域名资产（GAP-02）；
- 未连接 RSI 生产入口的 durable reconcile store（GAP-05）；
- 未修改任何 Prisma schema / migration；
- 未做任何真实 provider 调用、外部写、支付、报关、运输；
- 未执行生产部署、生产数据库迁移、生产密钥写入、公开流量切换。

---

## 6. 待判问题（请逐条裁决）

1. D1/D2/D3 修复是否 PASS？
2. 「部署准备」在本单元收口、把 api/web unit 与 TLS 交给后续独立单元，是否被认可？
3. `readiness.ts` 的双布局解析是否引入安全/可用性风险（是否可能被用于伪造 ready）？
4. 六项生产启用债登记是否完整？
5. 是否需要补充 `crossclaim-api.service` / `crossclaim-web.service` 才能算「部署准备完成」？
