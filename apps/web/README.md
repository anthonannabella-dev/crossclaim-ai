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
