# TRACK B — ONBOARDING TRANSPORT CLOSURE Checkpoint（MSG-20261002-78 T1..T5）

状态：**READY_FOR_REVIEW / IMPLEMENTATION CHECKPOINT**（待架构方裁决）
IMPLEMENTATION_HEAD = 0753d72
IMPLEMENTATION_HEAD_FULL = 0753d721a271968f13150adea9e77d56323e2a34
CI = SUCCESS · RUN_ID = 37017626081 · CI_HEAD = 0753d72
授权：MSG-20261002-78 ⑤（TRACK B BATCH 3 = PASS/CLOSED；account-lineage hardening = CORE CLOSED → NEXT AUTHORIZED UNIT = TRACK B ONBOARDING TRANSPORT CLOSURE）。
边界：NO platform write · Payment = 0 · autopay = OFF · collection = OFF · external payment write = OFF · R13 HOLD · TRANSPORT=false · 无生产凭据。

## 1. T1 / T2 —— canonical identity 只能来自 server-verified transport

- 新增 `services/connectors/platform-identity-verifier.ts`：`PlatformIdentityVerifier` adapter contract + `PlatformIdentityVerification`（source / evidenceRef / verifiedAt / identity）+ `createMockPlatformIdentityVerifier`（**只用于 dev/test 的 mock transport**，不发起任何网络请求，未登记 platform 一律 fail-closed；真实 provider OAuth/API 与 Production Credentials 继续 HOLD）。
- `connection-onboarding` 新增 stable code `UNVERIFIED_PLATFORM_IDENTITY`：`createAccountScopedConnection` **只接受 `BIND_EXISTING`**；客户端直接提交 `CREATE_AND_BIND`（含 arbitrary `externalAccountId`）一律拒绝。
- 新增 `createVerifiedAccountScopedConnection`：唯一可铸造 canonical identity 的入口，绑定 `VERIFIED_CREATE_AND_BIND`，identity 只取自 verification（platform + externalAccountId + identityVersion），并校验 `source ∈ {PROVIDER_OAUTH, PROVIDER_API, ADAPTER_MOCK}`、非空 `evidenceRef`、`verifiedAt`。
- 审计：绑定事件新增 `verificationSource` / `verificationEvidenceRef` / `verifiedAt`（`platform_account.created` 仍只记 identity 三元组 + 展示字段，绝不落 token）。
- 流程与裁决一致：credential/OAuth authorization → server 调用身份接口 → server 得到 canonical externalAccountId → create/reuse PlatformAccount → bind SourceConnection。**不存在** client POST arbitrary externalAccountId → canonical PlatformAccount 的路径。

## 2. T3 —— explicit legacy rebind transport

`POST /connections/:id/rebind`（`http-routes.ts` + `server.ts` 路由白名单同步放行 `rebind`）→ `rebindLegacyConnection`：authenticated + `manageConnections` + connection same tenant + target account same tenant + **NULL-only** + audit + A→B reject；不要求 UI。

## 3. T4 —— connection read state / capability

`listConnections` 的 view 新增（GET /connections 同样返回）：

- `platformAccountId`；
- `accountState` ∈ { `BOUND_ACTIVE`, `BOUND_INACTIVE`, `UNBOUND` }；
- `canIngest` / `canSync`（仅 `BOUND_ACTIVE` 为 true）。

即 UI 不再可能把「已绑定但未启用」与「ACTIVE legacy NULL（不可运行）」误读为可拉取状态。

## 4. T5 —— permanent transport tests

| 验收项 | 证据 |
|---|---|
| unbound POST connection → NEEDS_AUTH | `workflow-connections`（单测）+ `workflow-connections-db`（HTTP/db 路径） |
| BIND_EXISTING same tenant → PASS | `connection-onboarding-db`「BIND_EXISTING 已存在账户 → PASS」 |
| BIND_EXISTING foreign tenant → reject | 同套件「跨租户 PlatformAccount → reject，且零连接」 |
| arbitrary account ID spoof → reject | 同套件「client 直接提交 CREATE_AND_BIND canonical identity → UNVERIFIED_PLATFORM_IDENTITY」 |
| CREATE_AND_BIND cannot trust arbitrary client externalAccountId | 同上 + 「缺少 / 空 evidenceRef 的 verification → UNVERIFIED_PLATFORM_IDENTITY」 |
| verified provider identity → create/reuse correct PlatformAccount | 「server-verified create-and-bind 新 PlatformAccount → PASS」+「同 identity 复用」 |
| explicit rebind NULL→A → PASS | `connection-onboarding-db`「rebind NULL → A → PASS」+ `workflow-http-db` rebind endpoint 200 |
| second rebind → reject | 「second rebind → ACCOUNT_BINDING_IMMUTABLE」+ HTTP 409 `ACCOUNT_BINDING_IMMUTABLE` |
| no historical backfill | 「历史 NULL SourceTransaction / CanonicalFact / Opportunity / ClaimItem 零改动」 |
| audit no secret | 「audit record 存在且不含 credential 值」 |
| B1/B2/B3 regressions green | account-lineage-gate-db 6/6、account-lineage-downstream-db 16/16、connection-lifecycle-db（含未绑定不可激活）3/3、c2-account-boundary-baseline 7/7 |
| full CI success | RUN_ID = 37017626081 · head = 0753d721a271968f13150adea9e77d56323e2a34 · 5 jobs 全绿 |

## 5. 本轮未做

未接真实 provider OAuth/API（真实凭据与真实外写继续 HOLD）；未做 onboarding UI；未改 Schema / migration（本轮无新增迁移）；未触碰 Payment / collection / R13；未放宽任何 BATCH 1/2/3 已冻结语义。

## 6. 下一执行单元（待裁决）

若 PASS：按 MSG-20261002-78 ⑥ 停止继续打磨 account lineage，执行 STATE / TASKS reconcile，并恢复 **TRACK A / PRODUCT COMPLETION ROADMAP** 主线（复核 R44 → R45 → R46 的真实完成度与所需补充 regression，再从第一个真正未完成的执行单元继续；不重做已完成项）。
边界保持：NO platform write · Payment = 0 · autopay = OFF · collection = OFF · external payment write = OFF · R13 HOLD · TRANSPORT=false · 无生产凭据。
