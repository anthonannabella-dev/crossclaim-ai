# AUTHORIZATION 管理 UI（P7）—— 交付与证据

授权：HOST 2026-10-07「AGENT EXPERIENCE LAYER + DURABLE AUTHORIZATION + GOAL ORCHESTRATION」P7。
`EXACT_HEAD = AGENT-EXPERIENCE-P7-HEAD`（基线 `68d225c4`）

结论：**P7 = CLOSED**。`/authorizations` 的状态**全部**来自后端 durable Standing Authorization（P0 表）；
前端不生成 `scopeDigest`、不提交任何 server-only 字段；本单元提供**只读 + 撤销**。

---

## 1. 交付内容

| 层 | 文件 | 说明 |
|---|---|---|
| API | `apps/api/src/services/standing-authorization/http-request.ts` | `GET /standing-authorizations`（列表 + 边界声明）；`POST /standing-authorizations/:id/revoke`（只接受 `reason`） |
| API | `apps/api/src/server.ts` | 新增分派（会话由 `resolveSession` 解析；位于其他分派之前） |
| Web | `apps/web/app/authorizations/page.tsx` | 页面（读取后端；失败给诚实提示） |
| Web | `apps/web/app/authorizations/authorization-list.tsx` | 列表：状态 / 自动处理开关语义 / 金额上限 / 有效期 / 允许动作（客户语言）/ 版本；高级区折叠展示范围指纹与原始动作标识 |
| Web | `apps/web/app/authorizations/revoke-authorization-button.tsx` | 撤销按钮（客户端**只提交 reason**） |
| i18n | `apps/web/i18n/dictionaries/*.ts` ×5 | 新增 `authorizationPage` 段（42 键 × 5 语言） |
| 检查 | `apps/web/scripts/ui-check-entry.tsx` | 新增 13 条断言 |

## 2. 硬要求逐条落实

| HOST P7 要求 | 落实 |
|---|---|
| 状态全部来自后端 Standing Authorization | 页面直接渲染 `GET /standing-authorizations` 的字段（`revocationState` / 上限 / 允许动作 / 有效期 / 版本 / 撤销留痕），前端不做任何推导 |
| 前端不得生成 `scopeDigest` | 撤销请求体**只有** `reason`；断言 `auth.page.no.scope.editing` 确认页面没有 `allowedActionTypes` / `monetaryLimitUsd` 输入项 |
| 不得指定 server-only 权限字段 | 服务端只读 `reason`，其余字段一律忽略；HTTP 回归用伪造 `organizationId` / `scopeDigest` / `allowedActionTypes` / `monetaryLimitUsd` 证明落库值未被改写 |
| 允许用户主动管理授权 | 撤销可用且**留痕**（reason + 操作者 + 时间）；重复撤销幂等；已撤销条目不再显示撤销按钮 |
| 修改授权 | **刻意不提供静默改范围**：改范围必须先重新取得条款同意（consent evidence）。高级区如实说明，而不是给一个会悄悄改 scope 的按钮 |
| 技术 code 不上主文案 | 允许动作以客户语言展示；原始动作标识与范围指纹只出现在折叠的「高级信息」中（断言 `auth.page.no.code.as.main.copy`） |
| 边界如实表达 | 页面固定展示：授权只替代一次性人工审批、不授予外部写、不等同于报关委托书；且真实平台提交仍未开启 |

## 3. 安全 / 隔离

* 跨租户：列表恒只回本租户；跨租户撤销 → **404**（不泄漏存在性）；
* 未认证 → 401；集合路径不接受写方法 → 405；
* 撤销只改授权状态，响应恒 `externalActionPerformed=false`（零外部动作）。

## 4. 测试证据

| 门禁 | 结果 |
|---|---|
| `standing-authorization-http-db` | **4/4**（列表边界声明 / 撤销留痕 + 幂等 + 缺 reason 400 / 伪造 scope 被忽略 / 跨租户 404 + 未认证 401 + 集合 405） |
| SA 相关回归 | **14/14**（`standing-authorization-persistence-db` 10 + `standing-authorization-http-db` 4） |
| `api tsc --noEmit` | exit 0 |
| `tools/i18n/check-i18n.mjs` | **OK** — locales=5 keys=**783** statusCodes=13 customerHardcodes=**0** |
| UI render check | **OK checks=126**（原 113 + 新增 13：上限 / 动作客户语言 / 状态 / 自动处理语义 / 撤销 CTA / 指纹仅高级区 / 边界与 HOLD 文案 / 主文案无原始 code / 无范围编辑项 / 撤销留痕 / 已撤销无 CTA / 空状态诚实） |
| `web tsc --noEmit` | exit 0 |
| `next build` | exit 0（`/authorizations` 路由构建成功，30/30 静态页） |

## 5. 边界（未解锁）

授权面**不开启**任何 HOLD 项：`REAL_PROVIDER_WRITE` / `CUSTOMS_FILING` / `PAYMENT` /
`PRODUCTION_CREDENTIALS` / `PRODUCTION_ENABLEMENT` / `EXTERNAL_WRITE` = **HOLD**；
高金额 HITL **KEEP**；Standing Authorization ≠ Broker POA（页面与 API 双处声明）。

## 6. 下一步

P8 —— Navigation Progressive Disclosure（一级：Home / Recoveries / Money / Needs Attention / Connections；
其余进 More/Advanced；**不删任何 route**、不破坏 API contract）。
