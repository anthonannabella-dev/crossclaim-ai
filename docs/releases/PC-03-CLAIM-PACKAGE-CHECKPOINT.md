# PC-03 CUSTOMER CLAIM PACKAGE VIEW CHECKPOINT

状态：**READY_FOR_REVIEW / IMPLEMENTATION CHECKPOINT**（待架构方裁决）
IMPLEMENTATION_HEAD = ca26a9f
IMPLEMENTATION_HEAD_FULL = ca26a9ff34259005666f8436234725b1e3b8cbb9
CI = SUCCESS · RUN_ID = 37025273548 · CI_HEAD = ca26a9f
授权：MSG-20261002-83 ⑤⑥⑦（PC-03 CUSTOMER CLAIM PACKAGE VIEW；只做客户可见材料包，不扩底层架构）。
边界：NO platform write · Payment = 0 · autopay = OFF · collection = OFF · external payment write = OFF · R13 HOLD · TRANSPORT=false · 无生产凭据。

## 1. 范围逐项落地（MSG-83 ⑤ 1–10）

| 项 | 要求 | 实现 |
|---|---|---|
| 1 read projection | tenant-scoped 客户读取；聚合 package / artifact / claim item / submission / case·opportunity；**不**新增 package generation | 新增 `getCaseClaimPackage()`（纯读，无写入路径）；`GET /cases/:id/claim-package` |
| 2 Package summary | package/case id、claim status、package version、target/provider/channel、account context、recoverable amount、currency、deadline、readiness、generated/updated time | 响应 `case` / `package`（id / version / status / digest / generatedAt / target{platformType,claimType,channel,domain}）/ `account` / `readiness` |
| 3 Why this claim exists | safe projection：opportunity title·type、recovery basis summary、amount basis、rule·policy summary、evidence count、missing requirements；不得暴露 internal rule raw JSON / prompt / CoT / secret·audit | `why.basisSummary`（opportunity title + type）、`why.amountBasis`（claim item 可追回金额合计 + 币种）、`why.evidenceCount` / `why.linkedEvidenceCount`；**未**读取 RuleEvaluation raw / prompt / audit payload |
| 4 Evidence / artifact manifest | 只返回安全 artifact metadata；下载沿用既有受控机制；不返回 storageKey；不绕过 Evidence read permission | `evidence[] = { id, kind, title(=FileAsset.originalName), sourceType(=FileAsset.kind), capturedAt, downloadable, sha256 }`；整个端点要求 `viewClaimEvidence` 权限（FINANCE / VIEWER 403） |
| 5 Readiness state | READY_TO_SUBMIT / NEEDS_EVIDENCE / NEEDS_REVIEW / SUBMITTED / ACKNOWLEDGED / APPROVED / REJECTED / APPEAL_REQUIRED，全部由既有事实推导 | `deriveReadiness()`：APPEAL_REQUIRED（READY_TO_APPEAL 或 closedReason=REJECTED）→ APPROVED（RECOVERED）→ SUBMITTED（submission 事实或 SUBMITTED_MANUAL）→ NEEDS_REVIEW（无 active package）→ NEEDS_EVIDENCE（有 missing）→ READY_TO_SUBMIT；未新建第二套 state machine |
| 6 Missing-items projection | 保守、安全；来自既有 package validation / preparation 输出 | `missingItems`：`NO_CLAIM_ITEM` / `PACKAGE_NOT_GENERATED` / `PACKAGE_NOT_EXPORTED` / `ACCOUNT_NOT_ATTRIBUTED` + `completenessSnapshot.missing[]`（已有白名单投影快照）；无 LLM 参与 |
| 7 Submission boundary 显式 | PACKAGE READY ≠ CLAIM ACTUALLY SUBMITTED；真实 provider write HOLD / NEEDS_MANUAL | `readiness.packageReady`、`readiness.claimSubmitted`、`readiness.providerWrite = 'HOLD_NEEDS_MANUAL'` 三个独立字段；UI 明确分开展示 |
| 8 Account / tenant isolation | Package / Case / Claim / Evidence same tenant；package 与 account context 不一致 → fail-closed；legacy/ambiguous 不猜 | 全部查询带 `organizationId`；服务层多 account → `CLAIM_PACKAGE_ACCOUNT_MISMATCH`（HTTP 409），DB 侧另有 C2 account-consistency 同向守卫；`accountId=NULL` → `LEGACY_UNATTRIBUTED` 且不读取 connection |
| 9 Customer actions | prepare / download / manual submit entry / appeal；不得引入真实 external write；capability 由服务端决定 | `actions { canPrepare, canDownloadPackage, canRecordManualSubmission, canAppeal }` 全部由服务端 state 派生；本批**无**任何写入端点 |
| 10 UI | `/cases/[id]/claim-package`（或 case 页 section），不重写整个 case 页 | 新增 `/cases/[id]/claim-package` + 客户端视图组件；回答「多少钱 / 为什么 / 证据 / 缺什么 / 能否提交 / 下一步」 |

## 2. 验证证据（对照 MSG-83 ⑥）

| # | 验收项 | 证据 |
|---|---|---|
| 1 | same tenant package visible | `claim-package-view-http-db`「same tenant visible / foreign tenant invisible / package summary 正确」 |
| 2 | foreign tenant package invisible | 同上（跨租户 → 404） |
| 3 | wrong case/package binding reject | 「wrong case/package binding → 拒绝」：DB 不变量（R43 S1 caseId↔claimItem 一致性）直接拒绝错绑；服务层 `caseId + claimItemId` 双条件过滤为同向兜底 |
| 4 | cross-account evidence/package mismatch reject | 「cross-account mismatch → 拒绝」：C2 account-consistency 守卫在 DB 层拒绝；服务层 `CLAIM_PACKAGE_ACCOUNT_MISMATCH`（409）为同向兜底 |
| 5 | package summary correct | 「same tenant visible…」断言 case.recoverableAmount / currency / deadline / package.version / status / account |
| 6 | evidence manifest only safe fields | 同上断言 manifest 字段（title / sourceType / downloadable / sha256） |
| 7 | storageKey / credential / secret absent | 同上逐项断言响应文本不含 `storageKey` 与 fixture 的存储键字面量、`credentialRef` / `passwordHash` / `token` |
| 8 | missing items correctly projected | 「missing items 与不就绪状态」+「package 未导出」 |
| 9 | ready package state correct | EXPORTED + artifact + 无 missing → `READY_TO_SUBMIT`，`canRecordManualSubmission=true` |
| 10 | not-ready package state correct | 无包 → `NEEDS_REVIEW` + `PACKAGE_NOT_GENERATED`；未导出 → `NEEDS_EVIDENCE` + `PACKAGE_NOT_EXPORTED` |
| 11 | submitted vs package-ready distinguished | 「submitted 与 package-ready 正确区分」：`packageReady=true` + `claimSubmitted=true` + `state=SUBMITTED` + `providerWrite=HOLD_NEEDS_MANUAL` |
| 12 | legacy/ambiguous account does not get guessed | 「legacy / ambiguous account 不被猜测」，即使存在已绑定 connection 也 `LEGACY_UNATTRIBUTED` |
| 13 | FINANCE/VIEWER evidence restrictions remain intact | 「unauthorized → 401；FINANCE / VIEWER → 403」（`viewClaimEvidence`） |
| 14 | unauthorized → 401 | 同上 |
| 15 | case/claim existing regressions green | `workflow-http-db` 7/7（CI 全量） |
| 16 | evidence read regressions green | `action-guard-evidence-read-http-db` 等（CI 全量） |
| 17 | tsc api/web 0 | 本地 `tsc --noEmit`（api / web）0 error |
| 18 | full CI SUCCESS | RUN_ID = 37025273548 · head = ca26a9ff34259005666f8436234725b1e3b8cbb9 · 5 jobs 全绿 |

补充：本地 API contract `API_CONTRACT_OK`（新增 `GET /cases/:caseId/claim-package` 已登记）。

## 3. 明确未做（遵守 MSG-83 ⑦）

未做 real provider claim submission；未做 X4；未做 AI-generated legal conclusions；未触碰 payment / entitlement / package unlock / billing redesign / external write；未新增 account lineage 规则；未改 Schema、未加 migration；未新增任何写入端点。

## 4. 下一执行单元（待裁决）

若 PASS：按 PC 队列进入 **PC-04 Error / recovery states**（断连、失败重试、需人工处理的客户可见状态与恢复路径）。
边界保持：NO platform write · Payment = 0 · autopay = OFF · collection = OFF · external payment write = OFF · R13 HOLD · TRANSPORT=false · 无生产凭据。
