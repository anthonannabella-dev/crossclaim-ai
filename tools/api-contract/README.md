# tools/api-contract — API 契约闸门

零依赖、只读，双向比对 `API.md` 与**实际实现**的路由：

```bash
node tools/api-contract/check-routes.mjs --root .
```

## 覆盖的实现位置

| 位置 | 形式 | 说明 |
|---|---|---|
| `apps/api/src/services/workflow/http-routes.ts` | 正则常量 `const X_PATH = /^\/.../` | 业务路由（含可选段与选择组，会展开比对） |
| `apps/api/src/services/auth/http-routes.ts` | `path === '/auth/...'` | 认证路由 |
| `apps/api/src/server.ts` | `url === '/health'` | 健康检查等顶层路由 |

## 判定

- **未文档化的实现** → 报错（实现先于文档 = 契约漂移）
- **文档化但未实现** → 报错（文档承诺了不存在的端点）
- 允许清单只接受「由通用处理器实现、不存在字面量路由」的条目，且必须写明原因（当前仅 `/files/<token>` 签名下载）

退出码：`0` 一致 · `1` 有漂移 · `2` 读文件失败。CI 的 api 作业会执行本闸门。
