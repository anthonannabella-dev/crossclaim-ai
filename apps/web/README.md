# apps/web — CrossClaim Customer Operation Layer (C-0008)

独立 Next.js 应用，通过 HTTP 调用 `apps/api`。

## 硬边界（C-0008-A 裁定）

- **不得**直接导入 Prisma、数据库客户端或存储适配器；所有业务数据都经 API 层。
- 不做公网部署、不做自助注册、不接 OAuth；邀请制 + Email/密码由 `apps/api` 负责。
- 浏览器只持有 HttpOnly 会话 Cookie（由 API 签发），不得在前端存储令牌。

## 本地命令

```bash
npm install
npm run dev      # http://127.0.0.1:3001
npm run build
npm run typecheck
```

`CROSSCLAIM_API_URL` 指向 API（默认 `http://127.0.0.1:3000`）。

## 页面（C-0008-B1）

| 路由 | 说明 | 允许角色 |
| --- | --- | --- |
| `/login` | 邀请制 Email/密码登录（HttpOnly 会话 Cookie） | — |
| `/` | 工作台：导入批次 + 机会复核（确认 / 拒绝，拒绝必须选原因） | 全部已登录成员 |
| `/upload` | CSV 账单上传（字节级扫描 → 存储 → 导入） | 全部已登录成员 |
| `/connections` | 采集连接管理：创建 / 暂停 / 恢复 / 吊销 / 凭据引用轮换 | OWNER / ADMIN |

- 授权判定只在 `apps/api`（`services/workflow` 角色矩阵）；Web 仅按 HTTP 状态码提示（401 未登录 / 403 越权 / 409 非法迁移 / 400 输入非法），不做本地授权。
- 角色矩阵：OWNER/ADMIN 可写连接并可复核；OPS 只能复核；FINANCE 只能查看与推进 Billing；VIEWER 只读。
- 连接表单里的 `credentialRef` 只接受引用名（例如 `vault:ups-2026`），服务端会拒绝真实密钥或令牌。
