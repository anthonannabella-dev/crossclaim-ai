# DEPLOYMENT — CrossClaim AI

> 适用范围：`apps/api`（Node + TypeScript + Prisma + PostgreSQL）与 `apps/web`（Next.js 15）。
> 硬约束：**生产部署属 HOST APPROVAL REQUIRED**；本文档只描述「如何做」，不代替宿主执行。

---

## 1. 前置条件

| 项 | 要求 | 说明 |
|---|---|---|
| Node.js | 22.x | CI 使用 `NODE_VERSION: 22` |
| PostgreSQL | 16 | 迁移与集成测试均在真实 PG 上执行 |
| 对象存储 | 可选 | `STORAGE_DRIVER=local`（默认，开发/CI）或 `s3`（生产） |
| 工作流引擎 | 可选 | Temporal，默认 `localhost:7233` |

---

## 2. 环境变量

最小启动集合（`apps/api`）：

| 变量 | 必需 | 默认 | 说明 |
|---|---|---|---|
| `DATABASE_URL` | 是 | — | PostgreSQL 连接串；**唯一必需变量**，缺失时启动即失败并一次列全 |
| `NODE_ENV` | — | `development` | `production` 时启用生产语义 |
| `PORT` | — | `3000` | HTTP 端口 |
| `LOG_LEVEL` | — | `info` | `debug|info|warn|error` |
| `STORAGE_DRIVER` | — | `local` | `local` / `s3` |
| `STORAGE_LOCAL_ROOT` | — | `./.storage` | local 驱动根目录 |
| `STORAGE_PUBLIC_BASE_URL` | — | `http://localhost:3000` | 签名下载对外基址 |
| `STORAGE_URL_SECRET` | 生产必需 | — | 签名令牌密钥（**只放密钥管理**） |
| `STORAGE_TOKEN_KEY` | — | 由 `STORAGE_URL_SECRET` 派生 | 下载令牌 AES-256-GCM 专用密钥 |
| `STORAGE_SIGNED_URL_TTL_SECONDS` | — | `300` | 签名下载有效期 |
| `AUDIT_IP_SALT` | 生产必需 | 回退 `STORAGE_URL_SECRET` | IP 只落加盐哈希 |
| `S3_ENDPOINT` / `S3_BUCKET` / `S3_REGION` | s3 驱动必需 | — | 对象存储 |
| `S3_ACCESS_KEY_REF` / `S3_SECRET_KEY_REF` | s3 驱动必需 | — | **只写引用名**，真实值由密钥管理注入 |
| `TEMPORAL_ADDRESS` / `TEMPORAL_NAMESPACE` | — | `localhost:7233` / `default` | 工作流 |
| `AI_SERVICE_URL` | — | `http://localhost:8003` | 文档 AI 服务 |
| `PAYMENTS_ENABLED` | — | `false` | 支付域总开关，**默认关闭** |
| `PAYMENT_WEBHOOK_SECRET` | 支付启用时必需 | — | 只在启动 shell 内设置，**不入库 / 不回显** |
| `PAYMENT_REVIEW_THRESHOLD` | — | `1000.0000` | 高额人工卡口阈值 |

> 敏感变量一律只接受「引用名」或真实值，系统**从不打印取值**；`envPresence()` 只报是否已设置。
> 完整模板见 `apps/api/.env.example`。

---

## 3. 部署步骤（API）

```bash
cd apps/api
npm ci
npx prisma validate
npx prisma migrate deploy     # 生产只用 deploy，不用 migrate dev
npx prisma generate
npx tsc --noEmit
npm run build
npm start                     # node dist/server.js
```

## 4. 部署步骤（Web）

```bash
cd apps/web
npm ci
npm run typecheck
npm run build
npm start                     # next start -p 3001
```

Web 通过 `CROSSCLAIM_API_URL` 指向 API（默认 `http://127.0.0.1:3000`），**不直连数据库**。

---

## 5. 首次初始化数据

```bash
cd apps/api
npm run db:seed               # 幂等；生产环境默认拒绝执行
```

Seed 会创建（已存在则跳过）：一个组织、一个 OWNER 用户与 Membership、一个 `FILE_UPLOAD` 采集连接。
口令来自 `SEED_OWNER_PASSWORD`（未设置时使用**仅开发用**的默认值），**不打印任何口令**。

---

## 6. 上线后自检

| 检查 | 期望 |
|---|---|
| `GET /health` | `200`，`status=ok`；依赖不可用时 `status=degraded`（不泄露连接串） |
| 迁移 | `npx prisma migrate status` 显示全部迁移已应用（**条数由 runtime/CI 检测，文档不写死**） |
| 租户触发器 | CI 断言 28 个触发器存在；生产可用同 SQL 核对 |
| 审计 | 登录、上传、建案、账单、支付等动作均落 `AuditLog` |
| 日志 | 每个请求一条 `http_request`；`/files/<token>` 路径已脱敏 |

---

## 7. 回滚

Prisma 迁移**不提供自动 down**。回滚策略：

1. **应用层回滚**：切回上一版本镜像/进程（迁移保持向后兼容，新增列均有默认值）。
2. **数据层回滚**：仅在确有必要时，用迁移前备份做**全库恢复**（`pg_restore`）。
3. 破坏性变更（删列/改类型）拆成「先加 → 后用 → 再删」两段发布，避免一次性不可回滚。

> 生产部署、域名与 TLS、Secret 轮换均属宿主动作，需 HOST APPROVAL。
