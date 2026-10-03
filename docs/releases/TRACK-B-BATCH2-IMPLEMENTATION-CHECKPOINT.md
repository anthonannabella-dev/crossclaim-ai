# TRACK B — BATCH 2 Implementation Checkpoint（Downstream Active Fact Lineage Hardening）

状态：**READY_FOR_REVIEW / IMPLEMENTATION CHECKPOINT**（待架构方裁决）
IMPLEMENTATION_HEAD = c5e6865
CI = SUCCESS · RUN_ID = 37005813504 · CI_HEAD = c5e6865
授权：MSG-20261002-75 ⑤（TRACK B BATCH 1 = PASS / CLOSED；BATCH 2 = PASS / AUTHORIZED → Downstream Active Fact Lineage Hardening）。
X1 closure record：FINAL_X1_DOCUMENT_HEAD = 5e973d0（PHASE X1 = CLOSED，未重开；MSG-20261002-74 判为 NON-BLOCKING 的文档头问题在此顺手收口）。
边界：NO platform write · Payment = 0 · autopay = OFF · collection = OFF · external payment write = OFF · R13 HOLD · TRANSPORT=false · 无生产凭据。

## 1. BATCH 2 交付内容（MSG-20261002-75 ⑤ B2-1 / B2-2 / B2-3 / B2-4）

| 项 | 内容 | 位置 |
|---|---|---|
| B2-1 CanonicalFact 新写入 fail-closed | 新增 `resolveCanonicalAccountForTransactions`：按事务 id 取全部 SourceTransaction，逐行 `accountId ?? connection.platformAccountId ?? null`，经 `requireUniqueAccount` 要求**唯一非空**；事务不属于该 org / 缺行 → fail-closed。`writeCanonicalFactsForTransactions` 在 `persistCanonicalFact` 前解析 `canonicalAccountId`，写入时以 `{ ...fact, accountId: canonicalAccountId }` 覆盖 —— 不再存在 `fact.accountId ?? null` 的 active-write 语义。legacy NULL CanonicalFact 仍可读；legacy partial-unique 分支不再承接新的 application-level NULL 写入；未引入 Schema NOT NULL。 | apps/api/src/services/canonical/writer.ts + apps/api/src/services/account-lineage/policy.ts |
| B2-2 RecoveryOpportunity fail-closed | 新增 `resolveOpportunityAccount`：canonical fact account 与 source transaction account 若都存在**必须相同**；缺失 / 不一致 / 跨租户 → `PLATFORM_ACCOUNT_REQUIRED`，**零 Opportunity**。detection repository 中原先的 `canonicalFact.accountId ?? transactionAccountId`（→ `?? null`）回落被替换为策略调用。 | apps/api/src/services/rules/prisma-detection-repository.ts + policy.ts |
| B2-3 ClaimItem active-new fail-closed | 新增 `resolveClaimItemAccount`：`opportunityId` 必须存在于同租户且 `accountId` 非空，否则 fail-closed。新增可信连接路径 `CreateClaimItemInput.trustedConnectionId`（server-derived，仅供内部调用方）；归属解析顺序 = opportunity 优先 → 否则 `resolveFromConnection(trustedConnectionId)`；两者皆无（manual staging / 未绑定连接）→ fail-closed（manual staging ≠ ClaimItem，作为后续产品设计 finding，本批不新增 staging 子系统）。connector 编排器把 `input.connectionRef` 作为 `trustedConnectionId` 传入。 | apps/api/src/services/claim/claim-items.ts + apps/api/src/services/connectors/runner.ts + policy.ts |
| B2-4 清理 permissive `?? null` 传播 | 上述三处 active write path 的 `?? null` account 回落已清理。`reconciliation projection` 属 read / shadow projection，按架构方 MSG-75 ⑤ B2-4 要求**未**自动收紧（待明确其业务属性后再处理，避免误改只读分析路径）。 | 同上 |

实现纪律：三处均复用 B1 已建立的共享 Account Lineage Policy（policy.ts），未各自复制 `if (!accountId) throw ...`；策略继续保持 tenant-scoped / exactly-one / missing reject / mismatch reject / no guessing（无 first-account fallback、无 label·channel 推断、无 client-trusted account）。

## 2. 验收标准对照（MSG-20261002-75 ⑤「BATCH 2 必须验收」）

| # | 验收项 | 证据 |
|---|---|---|
| 1 | CanonicalFact：account-scoped transaction → 同 account PASS | account-lineage-downstream-db.test.ts「account-scoped transaction → CanonicalFact 同账户 PASS」 |
| 2 | CanonicalFact：transaction account NULL → reject | 同套件「transaction 未归因（accountId NULL + 未绑定连接）→ reject 且零 CanonicalFact」 |
| 3 | CanonicalFact：多来源账户 A / B → reject | 同套件「多来源账户不一致（A / B）→ reject 且零 CanonicalFact」 |
| 4 | CanonicalFact：legacy NULL 仍可读 | 同套件「legacy NULL CanonicalFact 仍可读（不参与新写入）」 |
| 5 | application active writer 不能产生新 NULL CanonicalFact | #2 / #3 失败路径断言 CanonicalFact count = 0（写入被拒而非落 NULL） |
| 6 | RecoveryOpportunity：canonical/source lineage Account A → Opportunity A PASS | 「source lineage Account A → Opportunity A PASS」 |
| 7 | RecoveryOpportunity：缺失归因 → reject | 「缺失归因 → reject 且零 Opportunity」 |
| 8 | RecoveryOpportunity：canonical A + transaction B → reject | 「canonical A + transaction B → reject 且零 Opportunity」（永久负路径） |
| 9 | RecoveryOpportunity：reject 路径 → 零 Opportunity | #7 / #8 计数断言 |
| 10 | ClaimItem：Opportunity A → ClaimItem A PASS | 「opportunity 已归因 → ClaimItem 同账户 PASS」 |
| 11 | ClaimItem：Opportunity NULL → reject | 「Opportunity 未归因（accountId NULL）→ reject 且零 ClaimItem」 |
| 12 | ClaimItem：foreign tenant Opportunity → reject | 「跨租户 Opportunity → reject 且零 ClaimItem」 |
| 13 | ClaimItem：caller 不能伪装 account | 「opportunity 已归因 → ClaimItem 同账户 PASS；caller 不能伪装 account」（caller 传 ACCOUNT_B，落库为 ACCOUNT_A） |
| 14 | ClaimItem：legacy NULL 可读 | 「缺少 opportunity 上下文（manual staging）→ reject；legacy NULL ClaimItem 仍可读」 |
| 15 | ClaimItem：active new 不能持久化 NULL | #11 / #12 失败路径断言 ClaimItem count = 0 |
| 16 | BATCH 1 ingest gate regression green | account-lineage-gate-db（6/6）+ CI API job |
| 17 | C2 Evidence resolver regression green | c2-dual-context-resolver-db / evidence-account-scope-db / c2-settlement-lineage-db / c2-account-scope-db（CI 全绿） |
| 18 | Settlement lineage regression green | c2-settlement-lineage-db / c2-cross-account-guards-db（CI 全绿） |
| 19 | tenant isolation regression green | tenant-isolation / c2-account-boundary-baseline / cc_tenant_* trigger 套件（CI 全绿） |
| 20 | HITL / workflow regressions green | workflow-http-db / workflow-case-db / workflow-hitl-db / workflow-outcome-db / action-guard-hitl-*（CI 全绿） |
| 21 | tsc 0 error | `tsc --noEmit`（apps/api）0 error |
| 22 | full CI SUCCESS | RUN_ID = 37005813504 · head = c5e6865 · completed / success（5 jobs 全绿） |

## 3. 新增验收套件（真实 PostgreSQL）

`apps/api/src/__tests__/account-lineage-downstream-db.test.ts` — **11 / 11 PASS**：

- B2-1（4）：account-scoped → 同账户 PASS；未归因 → reject + 零 CanonicalFact；A / B 多来源不一致 → reject + 零 CanonicalFact；legacy NULL 仍可读。
- B2-2（3）：source lineage A → Opportunity A PASS；缺失归因 → reject + 零 Opportunity；canonical A + transaction B → reject + 零 Opportunity。
- B2-3（4）：opportunity 已归因 → ClaimItem 同账户 PASS（caller 传入的 accountId 被忽略）；opportunity NULL → reject + 零 ClaimItem；跨租户 opportunity → reject + 零 ClaimItem；缺 opportunity 上下文（manual staging）→ reject，且 legacy NULL ClaimItem 仍可读。

## 4. 夹具同步（契约收紧后的正当修复，非规避规则）

BATCH 2 收紧 active-write 契约后，下列既有 DB / 单测套件的夹具改为提供可信 account 上下文；未放宽任何 resolver、未新增 NULL 豁免、未新增 test/demo provenance 旁路：

- detection-db：seed 绑定 PlatformAccount 的连接，事务补 `accountId` / `connectionId`，TRUNCATE 增加 CanonicalFact* / SourceConnection / PlatformAccount。
- claim-items-db：seed 本租户已归因 RecoveryOpportunity，`create()` 传 `opportunityId`。
- connectors-db / amazon-sp-connector-runner-db：使用真实存在且已绑定的 SourceConnection（id 由 create 返回，`connectionRef` 与之对齐）。
- source-fingerprint-db / rule-engine-audit-db：夹具提供 `trustedConnectionId`。
- claim-items.test.ts（fake prisma 单测）：fake tx 增加 `sourceConnection.findFirst` 返回已绑定 account，`base` 增加 `trustedConnectionId`。

## 5. 明确未做（遵守 BATCH 2 边界）

未实施 Connection onboarding API/UI；未实施 explicit legacy rebind UI；未引入 Schema NOT NULL；未做 mass historical backfill；未做自动 account 推断；未改造 R46；未触碰 Payment / collection；未使用生产凭据。这些属于 BATCH 3 或之后。

## 6. 本地 / CI 证据

- `tsc --noEmit`（apps/api）：0 error。
- 本地全量测试：**196 test files / 1893 tests 全 PASS**。
- 定向：account-lineage-downstream-db 11/11；account-lineage-gate-db 6/6；detection-db / claim-items-db / connectors-db / amazon-sp-connector-runner-db / source-fingerprint-db / rule-engine-audit-db / canonical-fact-db / c2-* 全绿。
- CI：RUN_ID = 37005813504 · head_sha = c5e6865 · completed / success（License gate / Backup restore verify / Deploy smoke / API / Web 5 jobs 全绿）。
- 相关 commit 链（新→旧）：c5e6865（claim-items 单测夹具补可信连接上下文）→ e529846（BATCH 2 实现 + 夹具）→ d421120（归档 MSG-75）→ 438613a（BATCH 1 checkpoint 文档）→ 4f3d0e3（BATCH 1 夹具修复）。

## 7. 边界与下一执行单元

边界保持：NO platform write · Payment = 0 · autopay = OFF · collection = OFF · external payment write = OFF · R13 HOLD · TRANSPORT=false · 无生产凭据。
下一执行单元（待裁决）：BATCH 3 —— Connection Onboarding / Rebind（B-1：新 connection 必须显式 bind/create PlatformAccount；legacy unbound → READ-ONLY FROZEN → explicit rebind window → audit trail；禁止猜测式 backfill）。
