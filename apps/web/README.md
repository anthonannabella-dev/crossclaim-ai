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

## i18n 开发规范（C-0009.2）

- 所有面向用户的文案必须走 `i18n/dictionaries/*`，**禁止在新页面/组件里硬编码中文或英文文案**。
- 新增文案时只需改 `zh-CN.ts` 与 `en-US.ts`；`de/ja/es` 由 `placeholder.ts` 自动派生（保持空值，UI 置灰）。
- 键一致性由构建期不变量强制：`next build` 会校验所有语言键集合一致，且预留语言必须保持占位。
- 服务端返回的业务错误码（如 `ILLEGAL_TRANSITION`、`REVIEW_REQUIRED`）保持英文原样，由前端映射为本地化文案，**不要翻译 API 契约**。
- 语言解析优先级：`cc_lang` cookie → `Accept-Language` → 默认 `zh-CN`。
