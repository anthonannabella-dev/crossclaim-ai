# FRONTEND PRODUCTIZATION — 增量审计（FE-1）

授权：HOST 2026-10-06「前端 + 后端结合产品能力最终增量审计」。审计方式：**不重构已 CLOSED 能力**，
只做门禁复跑 + 接线漂移检查 + 边界核对。
审计基线：`gate/7-commercial-validation`，本程序 SA 收口后 HEAD（见文末；durable state 记录 exact HEAD）。

---

## 1. UI-1…UI-8 现状：仍 CLOSED（沿用既有收口件，不重复审计）

引用 `docs/releases/CUSTOMER-PRODUCT-BASELINE.md`（UI-1…UI-8 收口，HEAD `17fda50`）：
Customer App Shell / Dashboard / Opportunity 客户视图 / Account·Connection 客户视图 /
Case 详情（8 阶段追回管线 + 人工提交 HOLD）/ Claim Package（材料就绪 vs 需人工提交）/
Money·Billing·Plan（预计≠已到账、已计算≠已扣款、Payment HOLD）/ Customs 客户视图（预计 vs 确认、未向海关提交）/
全局 404·error·loading + a11y 语义 —— 均已交付。

本次**未修改任何前端代码**，仅复跑门禁与检查漂移。

## 2. 门禁复跑（本次 tick 实测）

| 门禁 | 结果 |
|---|---|
| i18n 检查（`node tools/i18n/check-i18n.mjs`） | **OK** — `locales=5 keys=644 statusCodes=13 customerHardcodes=0`（`CUSTOMER_UI_HARDCODED_STRING_COUNT = 0`，棘轮基线保持；键数由收口时的 562 增至 644，**5 语言 parity 未回退**） |
| UI 渲染验收（`node apps/web/scripts/ui-render-check.mjs`） | **OK — 81/81 checks**（与 UI-1…UI-8 收口时同口径） |
| Web typecheck（`npm run typecheck`） | **exit 0** |
| Web build（`npm run build`） | **exit 0**（Next.js 15 生产构建成功，路由含 `/customs`、`/money`、`/opportunities`、`/connections`、`/plan` 等） |
| 后端 API 无漂移 | 见 §3 |

### 2.1 关键 UI 语义断言仍在（渲染验收中实测通过的检查项摘录）

* `pipeline.no.fake.autosubmit`（管线不得伪造自动提交）
* `claim.package.loading.skeleton` / `claim.package.hold.wording.dictionary`（**人工提交 HOLD 文案**仍在字典中）
* `money.loading.skeleton` / `money.reality.wording.dictionary`（**预计 ≠ 已到账**、Payment HOLD 文案）
* `customs.estimated.vs.confirmed` / `customs.confirmed.per.currency` / `customs.submit.hold.wording` / `customs.refund.no.custody`（Customs：预计 vs 确认、按币种确认、**未向海关提交**、平台不代持退款）
* `case.status.localized`（Case 状态本地化，不暴露内部状态码）
* `states.404.keys` / `states.error.retry.key` / `a11y.danger.role.alert` / `a11y.info.role.status` / `a11y.notice.tone.classes`（Loading/Error/Empty + a11y）
* `customs.no.blocker.code.as.primary`（不把 blocker code 当作主文案）

> 即：`submitted ≠ won ≠ settled ≠ recovered ≠ billable` 与 External Write / Payment / Production HOLD
> 在 UI 层**仍由既有断言强制**，本次复跑未出现回退。

## 3. 前后端接线漂移检查（web → API）

方法：扫描 `apps/web` 中引用的 `/api/*` 路径，按 `next.config.mjs` 的 rewrite
（`/api/:path*` → API 根 `/:path*`）折算后，与 `apps/api/src` 中的路由字面量比对。

| 指标 | 结果 |
|---|---|
| Web 引用的 API 路径数 | 15 |
| API 侧路由字面量数 | 141 |
| **未匹配（漂移）** | **1 —— 仅为 `next.config.mjs` 自身的 rewrite 源模式 `/api/**`（非真实调用）** |

逐一匹配证据（web → API）：

```
/api/accounts                 -> /accounts
/api/cases                    -> /cases
/api/billing/*/status         -> /billing/*/status
/api/opportunities/*/*        -> /opportunities
/api/recovery-states          -> /recovery-states
/api/carrier-claim-packages   -> /carrier-claim-packages
/api/customs-opportunities    -> /customs-opportunities
/api/auth/login               -> /auth/login
/api/auth/signup              -> /auth/signup
/api/recovery-money           -> /recovery-money
/api/opportunities            -> /opportunities
/api/opportunities/insights.csv -> /opportunities
/api/entitlements             -> /entitlements
/api/uploads                  -> /uploads
```

结论：**无真实接线漂移**；最近 SI/RSI / Customs / Standing Authorization 改动均发生在 API 服务层，
未改动 web 侧调用契约（web 仅通过 HTTP 访问 `apps/api`，不 import Prisma / DB / storage）。

## 4. 边界与结论

* 前端**未伪造业务状态**：页面状态全部来自 persisted / server-derived API 响应（本次未改前端代码，既有 81 项渲染断言覆盖此要求）。
* External Write / Payment / Production HOLD 在 UI 中**如实表达**（上述 HOLD 文案断言仍在）。
* 硬编码字符串计数 **0**；5 语言 parity **未回退**；`web tsc` / `web build` / UI render checks **全绿**。

**FRONTEND_PRODUCTIZATION = PASS**（本轮无 REVISE 项）。

### 4.1 仍未完成 / 与前端相关的 HOLD（如实记录）

* 生产启用相关（Payment / External Write / Customs filing）在 UI 中保持 HOLD 文案；**未开启**任何真实能力。
* 授权持久化（Standing Authorization 表）尚未实施 → 「一次授权后长期自动执行」的 UI 状态仍以后端能力为准，
  当前不会被前端提前宣称（`pipeline.no.fake.autosubmit` 断言保证）。

