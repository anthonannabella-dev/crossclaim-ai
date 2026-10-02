# PC-06 FINAL-2 Checkpoint（Account Management — reconnect capability truthfulness）

状态：**READY_FOR_REVIEW / FINAL-2 CHECKPOINT**（待架构方复审）
FINAL_IMPLEMENTATION_HEAD = 82f1e4c
FINAL_IMPLEMENTATION_HEAD_FULL = 82f1e4cc156637f142e35872564fe73338b12328
CI = SUCCESS · RUN_ID = 37038977586 · CI_HEAD = 82f1e4c
前序：MSG-20261003-91 判 PC-06 = REVISE-MINOR —— CHANGE A（account-scoped navigation）= PASS、CHANGE B（rebind capability）= PASS，**唯一剩余**为 CHANGE B2（reconnect capability truthfulness）。
边界：只读投影 · NO platform write · Payment = 0 · collection = OFF · TRANSPORT=false · 无生产凭据。

## 1. 唯一剩余 CHANGE（B2）的收口方式

**问题**：原实现按「连接状态需要重新授权」就返回 `reconnect.available = true` 并给 `CONNECTION_REQUIRES_REAUTH`；但仓库里并没有真正完成 reauth/reconnect 的 capability —— 真实 provider OAuth/API 仍被 EXTERNAL INTEGRATION GATE 阻塞。因此这属于「把状态需要重连」误当作「系统已经能重连」的 capability truth 问题。

**修正**：

| 状态 | reconnect capability 现在返回 |
|---|---|
| NEEDS_AUTH / ERROR / REVOKED | `{ available: false, reason: 'REAL_OAUTH_EXTERNAL_GATE', entry: '/connections' }` |
| 其他（ACTIVE / PAUSED） | `{ available: false, reason: 'NO_REAUTH_REQUIRED', entry: '/connections' }` |

代码注释显式冻结：**只有真实 reauth/reconnect capability 落地后**，才可按真实能力返回 `available: true`；当前一律不得声明可执行。rebind capability 未改动（legacy unbound → `LEGACY_UNBOUND_EXPLICIT_REBIND`；已绑定 → `ALREADY_BOUND_IMMUTABLE`），CHANGE A 导航定义未改动。

**UI 规则**：只有 `actions.reconnect.available === true` 才渲染可点击「重新连接」；当前 gate 状态下改为展示说明文字「需重新授权（真实 OAuth/API 尚未启用）」，不渲染 executable link。

## 2. 验证证据

- `accounts-http-db` **7/7 PASS**（真实 HTTP + PostgreSQL），其中 CHANGE B 用例已按 B2 改写：
  - `needs-auth-conn` → `{ available: false, reason: 'REAL_OAUTH_EXTERNAL_GATE', entry: '/connections' }`；
  - `revoked-conn` → reason = `REAL_OAUTH_EXTERNAL_GATE`；
  - `active-conn` → `available: false` + `NO_REAUTH_REQUIRED`；
  - legacy unbound → `actions.reconnect.available === false`；`actions.rebind = { available: true, reason: 'LEGACY_UNBOUND_EXPLICIT_REBIND' }`；
  - 已绑定 → `actions.rebind = { available: false, reason: 'ALREADY_BOUND_IMMUTABLE' }`；
  - CHANGE A 用例保持 green（`/opportunities?accountId=...` executable；money / cases / connections = `NO_ACCOUNT_FILTER`，未伪造）；既有 5 项（401/403、多账户分组、安全字段、UNBOUND_LEGACY 单列、tenant isolation）保持 green。
- `tsc --noEmit`（apps/api / apps/web）0 error；本地 API contract `API_CONTRACT_OK`（本次未新增路由）。
- CI 全量回归（migration / typecheck / unit + DB / two-stage upgrade / web build）RUN_ID = 37038977586 全绿。

## 3. 未做 / 边界

未实现真实 OAuth/reconnect capability（EXTERNAL INTEGRATION GATE 保持；本批只做 capability 真实性口径）；未新增写端点、未执行 bind/rebind；未给 `/money`、`/cases`、`/connections` 伪造 account filter；未改 Schema、未加 migration；未触碰 payment / external write / production credentials。

## 4. 下一执行单元（待裁决）

若 PASS：PC-06 = PASS / CLOSED → 按队列进入 **PC-07 Entitlement + package unlock（不含真实扣款）**。
边界保持：NO platform write · Payment = 0 · autopay = OFF · collection = OFF · external payment write = OFF · R13 HOLD · TRANSPORT=false · 无生产凭据。
