# TRACK B — BATCH 1 Implementation Checkpoint（Account Lineage Runtime Gate）

状态：**READY_FOR_REVIEW / IMPLEMENTATION CHECKPOINT**（等架构方裁决）
IMPLEMENTATION_HEAD = 4f3d0e3
CI = SUCCESS · RUN_ID = 37000895270 · CI_HEAD = 4f3d0e3
授权：MSG-20261002-74 ③（TRACK B AUTHORIZED → BATCH 1 = Account Lineage Runtime Gate）；PHASE X1 = CLOSED（FINAL_X1_DOCUMENT_HEAD = 5e973d0）。
边界：NO platform write · Payment = 0 · autopay = OFF · collection = OFF · external payment write = OFF · R13 HOLD · TRANSPORT=false · 无生产凭据。

## 1. BATCH 1 交付内容（架构方指定范围）

| 项 | 交付 | 位置 |
|---|---|---|
| B1-1 共享 Account Lineage Policy / Resolver Layer | 新增策略真相源：PLATFORM_ACCOUNT_REQUIRED 统一 code + AccountLineageError + requireUniqueAccount（NULL/空值一律 poison）+ 受控 resolver（resolveFromConnection / resolveFromTransaction / resolveFromCanonicalFact / resolveFromOpportunity / resolveFromCase / resolveConsistentAccount）；全部 organizationId scoped、exactly-one、missing/ambiguity/mismatch → fail-closed、无 first-account fallback、无 label/channel 推断、无 client-trusted account | apps/api/src/services/account-lineage/policy.ts |
| 兼容外观 | services/evidence/account-scope.ts 收敛为 facade（保留既有导出名与语义，C2 冻结口径不变） | apps/api/src/services/evidence/account-scope.ts |
| B1-2 ingest start fail-closed | 第一条 SourceTransaction 写入前解析连接作用域：unbound / 缺连接上下文 / 连接不属于该租户 → 一律 reject，且不再 platformAccountId ?? null 写入 | apps/api/src/services/ingest/prisma-repository.ts（resolveIngestAccountScope） |
| B1-3 bound 正路径 | bound connection ingest → PASS 且 SourceTransaction.accountId / CanonicalFact.accountId = 绑定账户 | apps/api/src/__tests__/account-lineage-gate-db.test.ts |
| B1-4 负路径 | 跨租户连接、client 伪装 account、缺连接上下文、legacy unbound 一律 fail-closed + 零写入（SourceTransaction/CanonicalFact/Opportunity/ClaimItem） | 同上 |

## 2. 验收标准逐条证据（MSG-20261002-74 BATCH 1 Acceptance）

| # | 验收项 | 证据 |
|---|---|---|
| 1 | unbound connection ingest → stable reject → 0 SourceTransaction | account-lineage-gate-db 例 1（rejects /PLATFORM_ACCOUNT_REQUIRED/ + counts 全 0） |
| 2 | bound connection ingest → PASS 且 SourceTransaction.accountId = bound account | account-lineage-gate-db 例 2（含 CanonicalFact.accountId 断言） |
| 3 | failed ingest → 0 CanonicalFact / 0 Opportunity / 0 ClaimItem | account-lineage-gate-db 例 1 / 3 / 4 的 counts() 断言 |
| 4 | cross-tenant account binding → reject | account-lineage-gate-db 例 4（外来 connectionId → PLATFORM_ACCOUNT_REQUIRED；ImportBatch 本身亦受 cc_tenant_ImportBatch 拒绝） |
| 5 | client spoofed account → ignored/rejected | account-lineage-gate-db 例 5（CLIENT_ACCOUNT_FIELD_NOT_TRUSTED） |
| 6 | legacy unbound connection → 可读但不可启动新 ingest | account-lineage-gate-db 例 6 + c2-account-scope-db legacy 用例（新增断言语义） |
| 7 | existing bound ingest regression → green | CI API job（acquisition / canonical / identity / ingest / reconciliation / sync-runner / upload-runtime 等 DB 套件） |
| 8 | C2 resolver / Evidence / Settlement regression → green | c2-dual-context-resolver-db 4/4 · evidence-account-scope-db 3/3 · c2-settlement-lineage-db 3/3 · c2-account-scope-db 8/8 |
| 9 | tenant isolation regression → green | tenant-isolation / c2-account-boundary-baseline / cc_tenant_* 触发器（CI 全量套件内） |
| 10 | tsc + full CI → SUCCESS | tsc --noEmit 0 error；CI run 见文档头 |

## 3. 夹具同步（产品契约收紧后的必要跟进，非绕过）

新增/收紧契约后，以下既有 DB 夹具改为 account-aware（绑定 PlatformAccount），未放宽任何 resolver 或写入规则：
canonical-parity-db、canonical-shadow-db、canonical-fact-db、identity-backfill-db、identity-step2-db、ingest-db、ingest-bulk-db、reconciliation-db、sync-runner-db、upload-runtime-db、acquisition-db、auth-http-db、c2-account-scope-db。

两处按语义显式调整：
- identity-*：事实现在是 account-scoped，CONFLICT 注入不再以 accountId: null 过滤（该过滤在新模型下匹配 0 行）。
- c2-account-scope-db legacy 用例：legacy NULL 事实改为直接落库模拟历史数据（unbound 连接已不能经 ingest 写入），保留 DB partial unique 拒绝第二条的断言。

## 4. 明确未做（架构方 BATCH 1 边界）

未实现 B-1 Connection onboarding API/UI、legacy rebind 界面、CanonicalFact/RecoveryOpportunity/ClaimItem 全量严格化、历史 NULL backfill、schema NOT NULL、批量数据迁移、R46 改造 —— 留待 BATCH 2 / BATCH 3。

## 5. 边界与下一单元

边界保持：NO platform write · Payment = 0 · autopay = OFF · collection = OFF · external payment write = OFF · R13 HOLD · TRANSPORT=false · 无生产凭据。
下一单元（待裁决）：BATCH 2 —— CanonicalFact 禁止新 NULL writes、RecoveryOpportunity fail-closed、ClaimItem active-new fail-closed、清理 permissive ?? null、legacy 仅 read-compatible。
