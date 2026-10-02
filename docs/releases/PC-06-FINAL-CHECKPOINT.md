# PC-06 FINAL Checkpoint（Account Management — REVISE 收口后）

状态：**READY_FOR_REVIEW / FINAL CHECKPOINT**（待架构方复审）
FINAL_IMPLEMENTATION_HEAD = 4f68e8e
FINAL_IMPLEMENTATION_HEAD_FULL = 4f68e8ee11237e632c577b3b0303e49934ca8fff
CI = SUCCESS · RUN_ID = 37037511847 · CI_HEAD = 4f68e8e
前序：首次 checkpoint HEAD ac65f32 / CI 37035849172 → MSG-20261003-90 = REVISE-MINOR（两个 CHANGE：A account-scoped navigation；B server-derived connection actions）。
边界：只读投影 · NO platform write · Payment = 0 · collection = OFF · TRANSPORT=false · 无生产凭据。

## 1. 两个 CHANGE 的收口方式

### CHANGE A — ACCOUNT-SCOPED NAVIGATION

`ManagedAccountView` 新增 server-derived `navigation`，并对每个入口诚实声明可执行性：

| 入口 | available | entry | reason | 依据 |
|---|---|---|---|---|
| opportunities | **true** | `/opportunities?accountId=<id>` | `SUPPORTED_ACCOUNT_FILTER` | PC-02 的 `GET /opportunities` 真实支持 `accountId` 过滤 |
| recoveryMoney | false | `/money` | `NO_ACCOUNT_FILTER` | `/recovery-money` 当前只支持 `caseId` 过滤 → **不伪造** account 入口 |
| cases | false | `/cases` | `NO_ACCOUNT_FILTER` | 案件列表当前无 accountId 过滤 |
| connections | false | `/connections` | `NO_ACCOUNT_FILTER` | 连接列表当前无 accountId 过滤（账户下的连接已在账户块内联展示） |

### CHANGE B — SERVER-DERIVED CONNECTION ACTIONS

`ManagedConnectionView` 新增统一的 server-derived `actions`（保留 `rebind` 作为兼容别名）：

| 动作 | available 规则 | reason |
|---|---|---|
| reconnect | `status ∈ {NEEDS_AUTH, ERROR, REVOKED}` | `CONNECTION_REQUIRES_REAUTH`；否则 `NO_REAUTH_REQUIRED` |
| rebind | `accountState === UNBOUND_LEGACY` | `LEGACY_UNBOUND_EXPLICIT_REBIND`；已绑定 → `ALREADY_BOUND_IMMUTABLE` |

两者都带 `entry: /connections`（指向既有安全入口），前端不再自行按文本判断是否显示按钮。

## 2. 验证证据

- `accounts-http-db` **7/7 PASS**（真实 HTTP + PostgreSQL）：
  - 既有 5 项（401 / OPS·FINANCE·VIEWER 403 / ADMIN 200；多账户分组；connection 安全字段；UNBOUND_LEGACY 单列与重绑语义；tenant isolation）保持 green；
  - 新增「CHANGE A」用例：`opportunities.available=true` 且 entry = `/opportunities?accountId=<id>`、reason = `SUPPORTED_ACCOUNT_FILTER`；`recoveryMoney/cases/connections` 均为 `available=false` + `NO_ACCOUNT_FILTER`（未伪造）；
  - 新增「CHANGE B」用例：ACTIVE → reconnect `available=false`；NEEDS_AUTH → reconnect `{available:true, reason:'CONNECTION_REQUIRES_REAUTH', entry:'/connections'}`；REVOKED → reconnect 可用；已绑定 → rebind `{available:false, reason:'ALREADY_BOUND_IMMUTABLE'}`；legacy unbound → rebind `{available:true, reason:'LEGACY_UNBOUND_EXPLICIT_REBIND'}` 且 reconnect 亦可用。
- UI `/accounts` 同步：账户块展示可用的下游入口（不可用的入口以原因文字说明，不渲染假链接）；连接表格新增「重新连接」按钮，仅在服务端 `actions.reconnect.available` 为 true 时渲染。
- `tsc --noEmit`（apps/api / apps/web）0 error；本地 API contract `API_CONTRACT_OK`（本次未新增路由）。
- CI 全量回归（migration / typecheck / unit + DB / two-stage upgrade / web build）RUN_ID = 37037511847 全绿。

## 3. 未做 / 边界

未接真实 provider OAuth/API（EXTERNAL INTEGRATION GATE 保持）；未新增写端点、本批未执行 bind/rebind（仅暴露既有安全入口）；未给 `/money`、`/cases`、`/connections` 伪造 account filter；未改 Schema、未加 migration；未把 PlatformAccount 与 SourceConnection 合并成单一模型；未触碰 payment / external write / production credentials。

## 4. 下一执行单元（待裁决）

若 PASS：PC-06 = PASS / CLOSED → 按队列进入 **PC-07 Entitlement + package unlock（不含真实扣款）**。
边界保持：NO platform write · Payment = 0 · autopay = OFF · collection = OFF · external payment write = OFF · R13 HOLD · TRANSPORT=false · 无生产凭据。
