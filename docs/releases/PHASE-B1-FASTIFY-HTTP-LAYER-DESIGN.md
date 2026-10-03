# PHASE B1 — HTTP LAYER 迁移设计（Node HTTP → Fastify，/api/v1）

来源：`docs/releases/BACKEND-ARCHITECTURE-DIRECTIVE.md` §2（HTTP 层）与 §32 PHASE B1。
状态：**DESIGN ONLY / PROGRESS**（本文件不含任何代码改动；实施需在架构方 Queue 线让路后另行送审）。
边界：**NO platform write · Payment = 0 · autopay/collection/external write OFF · R13 HOLD · TRANSPORT=false · 无生产凭据**。

## 1. 范围（只换 HTTP Adapter / Routing Layer）

- 允许：请求解析、路由注册、中间件（auth/session 解析、tenant/actor 解析、限流、日志、错误映射、CORS 与 body 限制）、响应序列化。
- **禁止**：重写 service layer、domain rules、Prisma 模型、Action Guard、权限模型、Settlement / Recovery / Billing 逻辑；不得改变任何既有 API contract。
- 路径策略：现有实现路由（`implemented=84`，见 `tools/api-contract/check-routes.mjs`）**保持不变**；`/api/v1` 作为**并列别名前缀**逐步引入（同一 handler，双注册），待客户侧切换完成后由架构方决定是否把别名转正。

## 2. 现状与目标拓扑

```text
现状：Node http.createServer → server.ts 顶层 allowlist 正则 → services/workflow/http-routes.ts 分发（route 常量 + handler）
目标：Fastify instance → 同构路由注册（逐条映射既有 route 常量）→ 复用同一 handler / service 调用 → 同一 JSON 序列化与错误体
```

关键约束：`server.ts` 的顶层 allowlist 正则（安全边界）与 `http-routes.ts` 的 `*_PATH` 常量是**唯一路由事实源**，迁移时由脚本从这两处生成 Fastify 路由清单，禁止手写第二份清单。

## 3. 中间件等价清单

| 现有能力 | Fastify 对应 | 验收 |
|---|---|---|
| Cookie session 解析 / 401 | onRequest hook + 同 session 服务 | 现 auth-http-db 用例全绿 |
| tenant/actor 解析（RP） | preHandler hook 注入同 actor | 现 tenant-isolation 用例全绿 |
| 请求体大小与 JSON 解析 | Fastify bodyLimit + 同一 content-type 规则 | 现 upload / webhook 用例全绿 |
| 错误体与状态码映射 | setErrorHandler 复用既有错误映射函数 | 现 http 用例逐条等价 |
| 访问日志（脱敏） | onResponse + 既有 logger | 日志字段与脱敏规则不变 |
| 限流 | 保留现有 rate-limit 实现（不引入新依赖） | 现 rate-limit 用例全绿 |
| webhook 原始 body（签名验证） | addContentTypeParser 保留 rawBody | webhook-verification 用例全绿 |

## 4. 迁移步骤（每步独立可回滚）

1. 引入 Fastify 依赖（**依赖新增需架构方/许可证审核**：License Gate + OSS registry 登记）。
2. 建立 `apps/api/src/http/` 适配层：由脚本从既有 route 常量生成注册表（不手写）。
3. 双栈运行：同一进程内 Fastify 处理 `/api/v1/*` 别名，Node HTTP 继续处理原路径；对比两者响应（状态码/头部/JSON 逐字节）。
4. 合约测试：以现有 HTTP 测试为基线跑双栈，差异为零后才允许切换入口。
5. 切换默认入口为 Fastify，保留 Node HTTP 入口一个发布周期用于回滚。

## 5. 非目标（明确不做）

不做 domain 重写；不做 Prisma / Schema 变更；不改变认证与权限语义；不引入 Redis / 队列 / 新框架中间件生态；不修改任何既有路由路径或响应结构；不在本阶段启用 `/api/v1` 以外的路径改动。

## 6. 验收标准（实施批次）

prisma validate PASS；tsc api/web 0；targeted + 全量 DB 测试 PASS；双栈差异为零（第 4 步）；API contract = `API_CONTRACT_OK`（双注册后 implemented 计数变化需同步 `API.md`）；CI 5 jobs 全绿；既有不变量（tenant isolation / account provenance / evidence lineage / idempotency / masking / audit / Action Guard / HITL / settlement·payout truth / fee·billing 分离）全部保持。

## 7. 待架构方裁决点

① Fastify 依赖是否放行（含版本与许可证等级）；② `/api/v1` 双注册策略是否接受；③ 入口切换的判据（差异为零 + 观察期）；④ B1 实施批次是否在 Queue #6/#7 之后排队。
