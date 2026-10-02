# TRACK B — BATCH 3 Implementation Checkpoint（Connection Onboarding / Explicit Rebind）

状态：**READY_FOR_REVIEW / IMPLEMENTATION CHECKPOINT**（待架构方裁决）
IMPLEMENTATION_HEAD = 33aa2ba（R2：含前一次 CI 失败项的既有夹具/单测适配）
IMPLEMENTATION_HEAD_FULL = 33aa2bac936f49c5c78460872ebdb182fea92577
CI = SUCCESS · RUN_ID = 37015312728 · CI_HEAD = 33aa2ba
过程记录：R1 = c1cdf0d（CI run 37013838935 = failure，两个既有夹具/单测未适配新不变量）→ R2 = 33aa2ba（修复后 5 jobs 全绿）。
授权：MSG-20261002-77 ③（TRACK B BATCH 2 = PASS / CLOSED；BATCH 3 = PASS / AUTHORIZED → Connection Onboarding / Explicit Rebind）。
边界：NO platform write · Payment = 0 · autopay = OFF · collection = OFF · external payment write = OFF · R13 HOLD · TRANSPORT=false · 无生产凭据。

## 1. B3-1 .. B3-6 落地

| 项 | 裁决要求 | 实现 |
|---|---|---|
| B3-1 新连接必须绑定/创建账户 | 创建时必须 bind existing 或 server-verified create + bind；禁止 ACTIVE + platformAccountId=NULL | 新增 `services/workflow/connection-onboarding.ts::createAccountScopedConnection`（唯一正规 onboarding 入口）：`BIND_EXISTING`（同租户复核）或 `CREATE_AND_BIND`（identity = organizationId + platform + externalAccountId + identityVersion）；两者皆缺 → `PLATFORM_ACCOUNT_REQUIRED`，零连接。既有创建路径（acquisition `createConnection` / workflow `createManagedConnection`）同步收紧：未绑定账户时状态只能是 `NEEDS_AUTH`。 |
| B3-2 legacy unbound 显式 rebind | READ-ONLY FROZEN；显式 rebind：同租户 + 明确 target + 已认证 actor + 授权 + audit；不得改历史；只影响未来行为 | 新增 `rebindLegacyConnection`：连接必须存在且 `platformAccountId IS NULL`；target 必须同租户存在；CAS 到「仍然 NULL」；写 `source_connection.bound_to_platform_account` 审计；**不写任何** SourceTransaction / CanonicalFact / RecoveryOpportunity / ClaimItem。 |
| B3-3 server-verified create-and-bind | identity 只能来自可信平台数据；禁止 displayName / label / channel 推断 | `CREATE_AND_BIND` 只接受 platform + externalAccountId + identityVersion（displayName 仅展示名）；client 提交的 `platformAccountId` 被忽略（永久测试在案）；相同 identity 已存在则复用既有 PlatformAccount（exact match、same tenant、exactly one）。 |
| B3-4 connection state gate | 复用现有 status；未绑定不得 ingest / sync | 新增 `connectionAccountState()`（BOUND_ACTIVE / BOUND_INACTIVE / UNBOUND）与 `assertConnectionUsableForActiveFacts()`（UNBOUND → PLATFORM_ACCOUNT_REQUIRED；非 ACTIVE → CONNECTION_NOT_ACTIVE）；DB 层：未绑定连接不得被创建或首次转换为 ACTIVE。 |
| B3-5 audit trail | `source_connection.bound_to_platform_account`；create-and-bind 另记 identity 创建；不得含 secret | 创建/追认均写该 action（organizationId / connectionId / platformAccountId / actorUserId / actorType / previousBinding=null / newBinding / reason / bindingSource / historicalFactsTouched=false / timestamp）；create-and-bind 额外写 `platform_account.created`；credentialRef 只以布尔形状进入审计。 |
| B3-6 immutable binding 保持 | ACCOUNT_BINDING_IMMUTABLE 保留；legacy rebind 是唯一受控例外；不得删 trigger | 既有 DB trigger `cc_account_binding_immutable__SourceConnection` 未改动；rebind 仅允许 NULL → concrete account；任何已绑定连接的再绑定（含 A → B）在 service 与 DB 双层被拒。 |

## 2. DB safety（新迁移 20261002100000_connection_binding_required）

`cc_sourceconnection_active_requires_account` 为 BEFORE INSERT OR UPDATE 触发器：

- INSERT：`status = ACTIVE AND platformAccountId IS NULL` → `PLATFORM_ACCOUNT_REQUIRED`（ERRCODE 23514）；
- UPDATE：仅当该行首次从非 ACTIVE 转为 ACTIVE 且未绑定时拒绝（阻断「先建未绑定连接、事后再激活」）；
- **不追溯**既有 legacy `ACTIVE + NULL` 行（由 BATCH 1/2 的 runtime gate 与 READ-ONLY FROZEN 策略治理，本次不做批量改写）；
- 迁移不使用任何 DISABLE TRIGGER。

## 3. 验收对照（MSG-20261002-77 ③ 列表）

| # | 验收项 | 证据（connection-onboarding-db.test.ts 等） |
|---|---|---|
| 1 | new active connection without account → reject | 「未提供 account 绑定 → PLATFORM_ACCOUNT_REQUIRED，且零连接」+「DB 层拒绝 ACTIVE + platformAccountId = NULL」 |
| 2 | new connection bind existing Account A → PASS | 「BIND_EXISTING 已存在账户 → PASS，连接绑定该账户」 |
| 3 | create-and-bind new PlatformAccount → PASS | 「CREATE_AND_BIND 新 PlatformAccount → PASS」 |
| 4 | foreign tenant PlatformAccount → reject | 「跨租户 PlatformAccount → reject，且零连接」（DB 侧另有 cc_tenant_sourceconnection_platformaccountid） |
| 5 | legacy unbound connection remains readable | 「legacy unbound 仍可读；rebind 前 ingest reject」+ connectionAccountState = UNBOUND |
| 6 | legacy unbound before rebind → ingest reject | 同上（真实 ingest `insertTransactions` → PLATFORM_ACCOUNT_REQUIRED，0 SourceTransaction） |
| 7 | explicit rebind NULL → A → PASS | 「rebind NULL → A → PASS；新 ingest 使用 A；历史 NULL 事实零改动」 |
| 8 | rebind 后新 ingest → SourceTransaction.accountId = A | 同上（rebind 后 insertTransactions → accountId = ACCOUNT_A） |
| 9 | rebind 不修改历史 NULL SourceTransaction | 同上断言 |
| 10 | rebind 不修改历史 NULL CanonicalFact | 同上断言 |
| 11 | rebind 不修改历史 NULL Opportunity / ClaimItem | 同上断言 |
| 12 | second rebind A → B → reject | 「second rebind → ACCOUNT_BINDING_IMMUTABLE」 |
| 13 | credential rotation 后 identityVersion 不变 | 「credential rotation 不改变 PlatformAccount identityVersion」 |
| 14 | audit record 存在且不含 secret | 「audit record 存在（bound_to_platform_account）且不含 credential 值」 |
| 15 | client spoofed account binding → reject | 「client 提供的 platformAccountId 不能冒充 CREATE_AND_BIND 的 identity」+ 跨租户 BIND_EXISTING 拒绝 |
| 16 | BATCH 1 gate regression green | account-lineage-gate-db 6/6 |
| 17 | BATCH 2 downstream lineage regression green | account-lineage-downstream-db 16/16 |
| 18 | C2 + Settlement + tenant isolation green | c2-* / settlement / tenant 套件（CI API job 全绿） |
| 19 | tsc 0 error | `tsc --noEmit`（apps/api）0 error |
| 20 | full CI SUCCESS | RUN_ID = 37015312728 · head = 33aa2bac936f49c5c78460872ebdb182fea92577 · 5 jobs 全绿 |

## 4. 必须披露的两处契约收紧（请架构方确认）

1. **既有创建路径的状态语义变化**：`acquisition.createConnection` 与 `workflow.createManagedConnection` 在**未绑定账户**时不再返回 `ACTIVE`，而是 `NEEDS_AUTH`（FILE_UPLOAD 亦然）。这是 B3-1「不得创建 ACTIVE + platformAccountId=NULL」的直接后果，属对 C-0007 / C-0008-B1 既有初始状态行为的收紧；绑定账户时行为不变（FILE_UPLOAD → ACTIVE）。
2. **HTTP 契约扩展**：`POST /connections` 新增可选 `account: { mode: "BIND_EXISTING", platformAccountId }`（服务端复核同租户存在性）。不传 account 时按上一条规则返回 `NEEDS_AUTH`；传入并绑定成功时返回 `ACTIVE` + audited binding。`create-and-bind`（B3-3）本轮只在服务层提供，HTTP/UI 入口留给后续产品设计单元。

同批修复的既有夹具/单测（只适配新不变量，未改变产品断言）：`account-lineage-gate-db`、`account-lineage-downstream-db`、`c2-account-scope-db`、`evidence-account-scope-db`、`connection-lifecycle-db`（新增「未绑定连接不得被激活」永久负路径）、`workflow-connections-db`、`workflow-connections`（单测）、`workflow-http-db`、`c2-account-boundary-baseline`。首次 CI（37013838935）因其中两处未适配而失败，R2 修复后全绿。

## 5. 明确未做（遵守 MSG-20261002-77 ③ 界限）

未做 mass historical backfill；未做 automatic historical account inference；未触碰 Payment / collection / external platform write / R13 / production credentials；未做大型 onboarding UI 重构；未删除或放宽 ACCOUNT_BINDING_IMMUTABLE；未回写 C2 / BATCH 1 / BATCH 2 已冻结语义。

## 6. 边界与下一执行单元

边界保持：NO platform write · Payment = 0 · autopay = OFF · collection = OFF · external payment write = OFF · R13 HOLD · TRANSPORT=false · 无生产凭据。
下一执行单元（待裁决）：本轮完成后不自行扩围；等待架构方对 BATCH 3 的裁决（PASS / REVISE / BLOCK）与后续授权。
