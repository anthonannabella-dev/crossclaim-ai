# OPERATIONS-CONSOLE-V1-DESIGN — 只读运营/管理控制台（Web）

> 依据架构方 **MSG-20260929-49**：A) Operations Web Console v1 = **GO（P0）**，要求先交付本设计，再实现，并以 E2E 浏览器测试验收。
> 定位：**只读可观测控制台**。API 是最终安全防线；前端只负责「渲染 + 按权限呈现」，不引入任何新写路径。

## 1. 范围（允许）

| 页面 | 路由（Web） | 数据来源（API，全部已审） |
|---|---|---|
| Operations Dashboard | `/operations` | `GET /operations/dashboard`（`?window=`） |
| Admin 首页 | `/admin` | 模块可用性探测（见 §3） |
| Tenant Overview | `/admin/tenant-overview` | `GET /admin/tenant-overview` |
| Audit Explorer | `/admin/audit` | `GET /admin/audit`、`GET /admin/audit/:id` |
| Import Validation | `/admin/imports` | `GET /admin/imports`、`/quality-summary`、`/:batchId`、`/:batchId/errors` |
| Recovery Review | `/admin/recovery-review` | `GET /admin/recovery-review`、`/:caseId` |
| Membership View | `/admin/members` | `GET /admin/members`、`/:userId`、`/admin/permission-matrix` |
| System Health | `/admin/system-health` | `GET /admin/system-health` |

## 2. 明确禁止（硬边界，与冻结项一致）

❌ 任何写操作（POST/PATCH/PUT/DELETE）　❌ 导出　❌ 下载（含错误 CSV / 原始文件）
❌ 金额越权展示（金额裁剪以 API 返回为准，前端**不得**自行聚合、推算、补算）
❌ 权限修改　❌ 审批按钮（Approve/Reject）　❌ Claim/Appeal 提交按钮
❌ 证据内容预览（仅展示 API 已给的引用与元数据）　❌ 任何外链到第三方平台

页面中**不得出现**上述能力的控件；也不得用「置灰按钮 + 前端校验」伪装——前端不实现该能力即不渲染。

## 3. 权限与渲染规则

1. **API 为唯一裁决者**：页面只依据 API 返回渲染（HTTP 状态 → UI 状态）。
2. 未登录（401）→ 显示「需要登录 + 前往登录」。
3. 无权限（403 `FORBIDDEN`）→ 显示「当前角色无权查看该内容」，**不渲染**任何数据表格与计数。
4. `/admin` 首页以**探测式**生成模块列表：仅当对应模块端点返回 200 时显示入口；403/404 一律不显示（避免"看得到点不进"）。
5. 角色差异（OWNER/ADMIN/OPS/FINANCE/VIEWER）**不写死在前端**：一律由 API 返回的字段决定；前端不做金额/字段的二次推断。
6. 跨租户/不存在资源（404）→ 显示「未找到」，与 403 明确区分。
7. 不缓存敏感响应：所有请求 `cache: 'no-store'`；不在客户端持久化响应。

## 4. 交互与实现约束

- 全部页面为 **Server Component**（沿用 `apps/web` 既有模式：`cookies()` + `apiGet` + i18n `t.*`），不引入新的状态管理库。
- 语言：沿用既有 i18n 字典（zh-CN 为类型源；de/ja/es 为占位字典），新增键需五语同步。
- 分页：沿用 API 游标（`cursor`/`limit`），页面只做「上一页/下一页」链接，不实现前端全量拉取。
- 时间窗口：Dashboard 支持 `window=1d|7d|14d|30d`，越界由 API 返回 `INVALID_WINDOW` 并原样提示。
- 表格仅渲染 API 白名单字段（如 A4 错误明细只含 errorCode/rowNumber/field/sourceColumnName/action）。
- 无客户端脚本处理业务逻辑；唯一的客户端组件是既有的语言切换（保持现状）。

## 5. 验收（架构方指定）

1. **前端不得隐藏权限后误展示按钮**：代码层扫描——本控制台范围内不存在任何写操作控件与写请求（fetch 方法仅 GET）。
2. **API 权限仍是最终防线**：E2E 用四种角色（OWNER / OPS / FINANCE / VIEWER）访问全部页面；除授权组合外必须得到 403 空态或 404，而**不是**数据。
3. **裁剪正确性**：VIEWER / FINANCE / OPS 看到的内容与 API 返回一致（金额与字段按权限裁剪；不得出现"裁剪被前端补齐"）。
4. **只读证明**：页面加载前后，`User / Membership / Session / UserInvitation / AuditLog / Case / Claim / Settlement` 行数不变。
5. **无泄露**：渲染结果不含 `tokenHash` / `storageKey` / 完整邮箱 / IP / UA / 金额（在授权范围外时）。

## 6. 测试计划（实现阶段交付）

- **单测（组件级）**：401/403/404 三种空态；`/admin` 探测式列表；游标分页链接生成；金额缺失时按 API 原样呈现（不补 0）。
- **E2E（Playwright，真实 HTTP + 真实 PostgreSQL）**：启动真实 server + 真实 Next.js（或对本地 API 直连渲染），四角色逐页断言状态与关键字段；附只读快照断言。
- **静态断言**：控制台目录下不存在 `method: 'POST'` 等写请求；不存在 `<a download>`/`export` 控件。

## 7. 交付节奏

1. 本设计 → 架构方 GO/REVISE
2. 实现（Dashboard + Admin 六页）→ 提交 **IMPLEMENTATION CHECKPOINT**（含 E2E 结果与只读快照）
3. 按架构方裁决收口，然后进入 **P1 Kill Switch Design**

## 8. 与冻结项的关系

本设计不触碰：Submission Adapter（HOLD）、Kill Switch 实现（另行设计）、自动扣佣/资金动作（HOLD）、平台 API 接入（HOLD）、规则引擎（HOLD）、Schema 变更（无）。
