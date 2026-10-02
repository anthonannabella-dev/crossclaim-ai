# TRACK B — BATCH 2 FINAL Checkpoint（Downstream Active Fact Lineage Hardening · R1 窄修后）

状态：**READY_FOR_REVIEW / FINAL CHECKPOINT**（待架构方裁决）
FINAL_IMPLEMENTATION_HEAD = 2d5969e
FINAL_IMPLEMENTATION_HEAD_FULL = 2d5969e70cb5f041d8cb31020fcdcb52c557d2c3
CI = SUCCESS · RUN_ID = 37010291014 · CI_HEAD = 2d5969e
前序：BATCH 2 Implementation Checkpoint HEAD = 3c4cf05（原始 IMPLEMENTATION_HEAD = c5e6865，CI run 37005813504）。
裁决来源：MSG-20261002-76（TRACK B BATCH 2 = REVISE；BATCH 2 NOT CLOSED；BATCH 3 NOT YET AUTHORIZED；NEXT AUTHORIZED UNIT = BATCH 2 最终窄修 B2-A / B2-B / B2-C + permanent negative tests + full CI）。
边界：NO platform write · Payment = 0 · autopay = OFF · collection = OFF · external payment write = OFF · R13 HOLD · TRANSPORT=false · 无生产凭据。

## 1. MSG-20261002-76 三项 CHANGE 的执行结果

| CHANGE | 裁决要点 | 本轮实现 |
|---|---|---|
| B2-A（CanonicalFact） | `resolveCanonicalAccountForTransactions` 不得以 `row.connection?.platformAccountId` 作为 `SourceTransaction.accountId=NULL` 的回落；SourceTransaction.accountId 是 authoritative stored provenance；NULL → fail-closed；多条事务的 stored accountId 必须全部唯一一致；transaction 缺失 / 跨租户 → fail-closed。 | 已移除 `connection` select 与 `?? connection?.platformAccountId ?? null` 回落；改为 `rows.map((row) => row.accountId)` 经 `requireUniqueAccount`。文档注释显式写入「Connection binding 只决定未来 ingest 新建的 SourceTransaction，不追溯历史行（禁止 implicit backfill）」。 |
| B2-B（RecoveryOpportunity） | SourceTransaction 一侧同样不得回落 connection 当前 binding；canonical=A + transaction=NULL → FAIL；canonical=A + transaction=B → FAIL；transaction=NULL（即使 connection 当前为 A）→ FAIL。 | 已把该分支 select 收窄为 `{ accountId: true }` 并 `candidates.push(row.accountId)`；组合语义保持 `requireUniqueAccount([canonicalFactAccount, transactionAccount])`。 |
| B2-C（ClaimItem） | 禁止 priority winner：opportunityId 与 trustedConnectionId 同时存在时必须各自独立解析并一致；A + B → `PLATFORM_ACCOUNT_REQUIRED` + 0 ClaimItem；`trustedConnectionId` 概念保留（内部 / server-derived orchestration）。 | `resolveClaimItemAccount` 改为收集候选（opportunity.accountId、`resolveFromConnection(trustedConnectionId)`），两者皆无 → fail-closed，其余经 `requireUniqueAccount` 收敛；`claim-items.ts` 去掉三元 priority 分支，改为一次调用并同时传入两个上下文。 |

## 2. 新增永久负路径 + 正路径（`apps/api/src/__tests__/account-lineage-downstream-db.test.ts`）

| 用例 | 构造 | 断言 |
|---|---|---|
| TEST B2-A1 | SourceTransaction.accountId = NULL + connection.platformAccountId = A | CanonicalFact active writer → `PLATFORM_ACCOUNT_REQUIRED`；CanonicalFact = 0 |
| TEST B2-B1 | 同构造 | `resolveOpportunityAccount` → reject；RecoveryOpportunity = 0 |
| TEST B2-C1 | Opportunity.accountId = A + trustedConnection.platformAccountId = B | `createClaimItem()` → `PLATFORM_ACCOUNT_REQUIRED`；ClaimItem = 0 |
| B2-C2（正路径） | Opportunity A + trustedConnection A | ClaimItem 创建成功且 `accountId = A`（一致性校验不误伤合法路径） |
| B2-C3（connector 路径） | 仅 trustedConnectionId（已绑定 A），无 opportunity | ClaimItem 创建成功且 `accountId = A` |

该套件现有 **16 / 16 PASS**（MSG-75 原 11 例 + 本轮 5 例）。

## 3. 必须披露的一处既有用例改写（`c2-account-scope-db.test.ts`）

MSG-20261002-76 判定「历史 NULL transaction 按 connection 当前 binding 追溯归属」属于被禁止的 implicit backfill 后，C2 时代有一例用例正是断言该行为：
`历史行 accountId 为空但连接已有 account → 服务端回退派生，事实仍归属该 account`（原断言 `fact.accountId = ACCOUNT_A1`）。
该用例在语义上与新冻结口径直接冲突，本轮把它改写为冻结语义断言（**不是**放宽校验，也不是 fixture 回避）：

- 写入仍 reject：`PLATFORM_ACCOUNT_REQUIRED`；
- LEGACY READ = ALLOWED：历史 SourceTransaction 行仍可读且 `accountId` 保持 NULL（不被重新归属）；
- LEGACY NEW WRITE CONTINUATION = FORBIDDEN：不产生该 factKey 的 CanonicalFact（计数 0）。

JSON 级 fixture（seed 数据 / TRUNCATE 列表 / account-aware 连接绑定）本轮**未做任何调整**；改动仅限上述「断言旧回退语义」的用例本身。

## 4. 验证证据

- `tsc --noEmit`（apps/api）：0 error。
- 定向套件：account-lineage-downstream-db 16/16、account-lineage-gate-db 6/6、detection-db、claim-items-db、connectors-db、canonical-fact-db —— 6 suites / 48 tests PASS。
- 本地全量：**196 test files / 1898 tests 全 PASS**（上一版 1893；+5 即本轮新增 R1 用例）。
- CI：RUN_ID = 37010291014 · head_sha = 2d5969e70cb5f041d8cb31020fcdcb52c557d2c3 · completed / success（License gate / Backup restore verify / Deploy smoke / API / Web 5 jobs 全绿）。

## 5. 明确未做（遵守 MSG-76 限定范围）

未开始 BATCH 3 onboarding；未改 rebind UI；未做 backfill；未引入 schema NOT NULL；未加 migration；未改 R46；未触碰 Payment / production credentials；未重新放宽任何 resolver；未新增 NULL 豁免；未新增 test/demo provenance 旁路。

## 6. 边界与下一执行单元

边界保持：NO platform write · Payment = 0 · autopay = OFF · collection = OFF · external payment write = OFF · R13 HOLD · TRANSPORT=false · 无生产凭据。
下一执行单元（待裁决）：BATCH 3 —— Connection Onboarding / Rebind（B-1：新 connection 必须显式 bind/create PlatformAccount；legacy unbound → READ-ONLY FROZEN → explicit rebind window → audit trail；禁止猜测式 backfill）。
