# PHASE X1 — Architecture Audit（首轮：account binding 入口可信边界）

状态：**AUDIT FINDINGS / PENDING ARCHITECT VERDICT**（只读审计，未改任何生产代码 / Schema / migration / test / workflow）
审计基线：`FINAL_CLOSURE_HEAD = 7ce9b5a`（TRACK C2 = CLOSED，MSG-20261002-72）；本轮审计 HEAD = `9ae7354`
授权来源：MSG-20261002-72 §3/§4 —— X1 只做 READ / TRACE / AUDIT / FINDINGS，不得因发现 Connection API 缺口就立即扩 API。
边界：NO platform write · Payment = 0 · autopay = OFF · collection = OFF · external payment write = OFF · R13 HOLD · `TRANSPORT=false` · 无生产凭据。

## 1. Factual architecture map（真实写入链，含 file:line 证据）

| 阶段 | 写入点 | account 来源 | 无 account 时的行为 |
|---|---|---|---|
| 连接创建 | `apps/api/src/services/acquisition/connection-lifecycle-prisma.ts:32-46`（`sourceConnection.create`） | **无**：create 载荷仅 organizationId / domain / channel / kind / label / credentialRef / status | 连接以 `platformAccountId = NULL` 落库（无校验、无必填） |
| 文件导入落行 | `apps/api/src/services/ingest/prisma-repository.ts:151-157`（`sourceTransaction.createMany`） | `loadAccountScope()`（同文件 `62-77`）读 `SourceConnection.platformAccountId` | `accountId: connection.platformAccountId ?? null` → **静默 NULL**，不 fail-closed |
| Canonical 事实 | `apps/api/src/services/canonical/writer.ts:162-167`、`65` | `row.accountId ?? row.connection?.platformAccountId ?? null` | **静默 NULL**，落 legacy partial unique 分支（`writer.ts:150-155` 已声明该分支语义） |
| 对账投影 | `apps/api/src/services/reconciliation/prisma-repository.ts:41-49` | 同上（`accountId ?? connection.platformAccountId ?? null`） | **静默 NULL** |
| 规则检测 → Opportunity | `apps/api/src/services/rules/prisma-detection-repository.ts:243-290` | `opportunityAccountId`（来自 canonical identity / transaction accountId） | Opportunity 以 `accountId = NULL` 落库（无 fail-closed） |
| ClaimItem | `apps/api/src/services/claim/claim-items.ts:257-268` | `opportunityAccountId`（来自 opportunity） | ClaimItem `accountId = NULL` 可落库 |
| Evidence / Closure（C2 收口后） | `services/evidence/account-scope.ts:62-77`（`resolveAccountIdFromConnection`）→ `PLATFORM_ACCOUNT_REQUIRED` | 服务端从连接派生，缺失即抛错 | **fail-closed**（C2 CHANGE A 的唯一强制点） |

## 2. X1-A —— 是否存在 unbound SourceConnection 仍可产生新的 account-scoped business fact？

**答案：是（存在）。**证据链：

1. 连接创建入口不允许（也不要求）绑定 PlatformAccount：`connection-lifecycle-prisma.ts:32-46` 的 `create(draft)` 无 `platformAccountId` 字段；全仓库非测试代码中 `platformAccountId` 仅出现在**读取 select** 与 resolver 中，**没有任何写入点**。
2. 该 unbound 连接可继续导入：`ingest/prisma-repository.ts:151-157` 对 `accountId` 采用 `?? null`，无 fail-closed；`canonical/writer.ts:65`、`reconciliation/prisma-repository.ts:49` 同样 `?? null`。
3. 由此产生的新事实（SourceTransaction / CanonicalFact / 对账投影）以及 `RecoveryOpportunity`（`prisma-detection-repository.ts:276-290`）与 `ClaimItem`（`claim-items.ts:257-268`）都能以 `accountId = NULL` 落库。
4. C2 的 fail-closed 只覆盖 **Evidence 写入侧**：因此当前形态是「上游静默 NULL 事实持续累积，直到 Evidence/Closure 才报 `PLATFORM_ACCOUNT_REQUIRED`」——这正是 MSG-70 §5 预判的真实入口架构问题。

严重度（初判）：**HIGH**（数据面持续产生无法归因到 PlatformAccount 的 account-scoped business facts；C2 的 provenance 保证在下游才生效）。

## 3. X1-B —— 最早的 trusted boundary 应在哪里 fail-closed？

候选对比（不采用「任选 account / 按 label·channel 推断」补救）：

| 边界 | 优点 | 缺点 |
|---|---|---|
| B-1 connection onboarding 必须绑定/创建 PlatformAccount | 从源头消除 unbound 连接；与 C2 的 `resolveAccountIdFromConnection` 语义一致 | 需要对既有 unbound 连接给出迁移/只读策略；影响连接创建契约与 UI 流程 |
| B-2 ingest start 拒绝 unbound connection | 直接阻断「静默 NULL 事实」；改动面小、可单独测试 | 存量 unbound 连接仍可在其它入口（对账投影等）被使用 |
| B-1 + B-2 组合（推荐） | 源头 + 入口双重；符合「trusted boundary 只能有一个真相源」 | 需要一次明确的 Schema/契约裁决（属 TRACK B 实现候选，不在 X1 内实施） |

初判：推荐 **B-1 + B-2**；`ingest start` 只接受已绑定连接（`platformAccountId != NULL`），未绑定连接一律 rejected；同时连接创建必须显式绑定/创建 PlatformAccount，legacy 未绑定连接降级为**只读**、不得开启新的 account-scoped ingest。

## 4. X1-C —— account identity 是否只有一个 canonical source of truth？

**初判：否（当前存在多处派生点）。**同一个「account 归属」概念在至少 6 处被独立计算：

- `services/evidence/account-scope.ts:62-110`（fail-closed，C2 的唯一强制口径）
- `services/ingest/prisma-repository.ts:62-77`（connection → platformAccountId，允许 NULL）
- `services/canonical/writer.ts:65 / 162`（row.accountId ?? connection.platformAccountId ?? null）
- `services/reconciliation/prisma-repository.ts:41-49`（同上 `?? null`）
- `services/rules/prisma-detection-repository.ts:243-252`（canonical identity 优先，回落 transaction accountId）
- `services/claim/claim-items.ts:257-268`（由 opportunity 派生，允许 NULL）

风险：只有 1 处 fail-closed，其余 5 处为「静默 NULL 回落」，因此「account identity 真相源」目前不是单一实现，而是**一个严格 resolver + 多条宽松回落**并存。X1-C 建议在 TRACK B 中收敛为一个共享 resolver（严格模式复用 C2 口径），其余调用点改为委托调用，禁止各自保留 `?? null` 回落。

## 5. X1-D —— C2 收口是否对既有链产生非预期断链？（初判，待补全量回归证据）

- HITL / manual recovery / recovery outcome / closure：C2 CHANGE A/C 后已 account-aware（fixtures + 永久负路径），现存负面为**预期的 fail-closed**（unscoped opportunity 建案 → 0 Case/Evidence/Claim/Settlement）。
- settlement：`c2-settlement-lineage-db` 正/负/legacy 三类验收在案（CI 36993735092 全绿）。
- R46 approval / finance lineage、tenant isolation、legacy read paths：本轮未改动；X1-D 需要单独的只读回归证据（读路径 + 既有 C2/R46 套件）才能给出结论，目前标记 **OPEN**。

## 6. Invariant matrix（当前冻结不变量 vs 实际可达性）

| 不变量 | 现状 | 证据 |
|---|---|---|
| active new **Evidence** 不得写入无法归因的 NULL provenance | **成立** | `account-scope.ts` fail-closed；C2 专项 + 永久负路径 |
| active new **SourceTransaction / CanonicalFact / Opportunity / ClaimItem** 不得写入 NULL account | **不成立** | `?? null` 回落（§1 表） |
| 客户端不得提交可信 account | **成立** | `CLIENT_ACCOUNT_FIELD_NOT_TRUSTED`（`ingest/prisma-repository.ts:146-150`） |
| dual-context（connection/case）必须同一 account | **成立** | `resolveEvidenceAccountId` + `c2-dual-context-resolver-db` |
| legacy NULL 只读、不被解释为任意 account | **成立（读路径）** | `c2-settlement-lineage-db` 第 3 类 · C2 KEEP |

## 7. TRACK B implementation candidates（候选，不在 X1 实施）

- **B-1** Connection onboarding 强制绑定/创建 PlatformAccount（Schema/契约变更 → 需架构方与宿主书面裁决）。
- **B-2** ingest start 对 unbound connection fail-closed（`UNBOUND_CONNECTION_INGEST_REJECTED` 或复用 `PLATFORM_ACCOUNT_REQUIRED`）。
- **B-3** 收敛为单一 account resolver（严格），清理 4 处 `?? null` 回落为委托调用。
- **B-4** legacy unbound 连接降级为只读 + 明确追认（backfill）策略；不得自动推断 account。

## 8. Open questions（请架构方在 X1 裁决中明确）

1. B-1 与 B-2 是二选一还是组合（我方推荐组合）？
2. 存量 unbound `SourceConnection` 的处置：只读冻结 / 强制绑定迁移 / 追认窗口？
3. `CanonicalFact` legacy partial unique 分支是否允许继续承接**新** NULL 事实（当前允许）？
4. ClaimItem 侧是否同样需要 fail-closed（当前由 opportunity 派生、允许 NULL）？

（本轮仅审计与取证；未修任何代码。等 X1 裁决后再进入 TRACK B 编码。）
