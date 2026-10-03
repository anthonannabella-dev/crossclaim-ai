# apps/web — CrossClaim Customer Operation Layer (C-0008)

独立 Next.js 应用，通过 HTTP 调用 `apps/api`。

## 硬边界（C-0008-A 裁定）

- **不得**直接导入 Prisma、数据库客户端或存储适配器；所有业务数据都经 API 层。
- 不做公网部署、不接真实 OAuth；认证由 `apps/api` 负责（邀请制为默认路径，`/signup` 存在但仅在 `PUBLIC_SIGNUP_ENABLED=true` 时可用）。
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
| `/login` | Email/密码登录（HttpOnly 会话 Cookie；未验证邮箱返回 EMAIL_NOT_VERIFIED） | — |
| `/` | 工作台：导入批次 + 机会复核（确认 / 拒绝，拒绝必须选原因） | 全部已登录成员 |
| `/upload` | CSV 账单上传（字节级扫描 → 存储 → 导入） | 全部已登录成员 |
| `/connections` | 采集连接管理：创建 / 暂停 / 恢复 / 吊销 / 凭据引用轮换 | OWNER / ADMIN |

- 授权判定只在 `apps/api`（`services/workflow` 角色矩阵）；Web 仅按 HTTP 状态码提示（401 未登录 / 403 越权 / 409 非法迁移 / 400 输入非法），不做本地授权。
- 角色矩阵：OWNER/ADMIN 可写连接并可复核；OPS 只能复核；FINANCE 只能查看与推进 Billing；VIEWER 只读。
- 连接表单里的 `credentialRef` 只接受引用名（例如 `vault:ups-2026`），服务端会拒绝真实密钥或令牌。

## i18n 开发规范（C-0009.2）

- 所有面向用户的文案必须走 `i18n/dictionaries/*`，**禁止在新页面/组件里硬编码中文或英文文案**。
- 已发布五种语言：`zh-CN`（默认）/ `en-US` / `de` / `ja` / `es`，各自一个独立字典文件。新增文案必须同时补齐五种语言（缺键 → typecheck 失败；空值 → `next build` 断言失败）。
- 键一致性由构建期不变量强制：`next build` 会校验五种语言的键集合与 `zh-CN` 完全一致，且不允许留下空值（半成品翻译）。`placeholder.ts` 保留给未来的第六种语言先占位、后翻译。
- 范围边界（架构方 MSG-20260929-05 / C-0015-I18N-LAYER）：i18n 只做「字典结构 + locale 识别 + UI 文案切换」；**LLM 多语言业务输出、索赔信自动多语言生成、站点语言策略暂不做**。
- 服务端返回的业务错误码（如 `ILLEGAL_TRANSITION`、`REVIEW_REQUIRED`）保持英文原样，由前端映射为本地化文案，**不要翻译 API 契约**。
- 语言解析优先级：`cc_lang` cookie → `Accept-Language` → 默认 `zh-CN`。
