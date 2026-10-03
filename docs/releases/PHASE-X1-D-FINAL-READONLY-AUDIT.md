# PHASE X1-D — FINAL READ-ONLY AUDIT（R46/finance + tenant isolation + legacy read + source-of-truth 矩阵）

状态：**X1-D EVIDENCE SUBMITTED / PENDING ARCHITECT VERDICT**（只读审计；未改任何生产代码 / Schema / migration / test / workflow）
AUDIT_CODE_BASE = `9ae7354`（C2 closure baseline `7ce9b5a`）
AUDIT_DOCUMENT_HEAD = `0a3d82c`
授权来源：MSG-20261002-73 §⑥ / NEXT AUTHORIZED UNIT = X1-D FINAL READ-ONLY AUDIT；TRACK C2 = CLOSED，不重开。
边界：NO platform write · Payment = 0 · autopay = OFF · collection = OFF · external payment write = OFF · R13 HOLD · `TRANSPORT=false` · 无生产凭据。

## X1-D1 — R46 approval / finance lineage（是否存在 NULL / 跨账户绕过）

**结论：本轮只读审计未发现新的 NULL / 跨账户绕过路径进入 R46 财务链；证据以既有 DB trigger + 既有一致性测试为准。**

| R46 关注点 | 证据（源码 / DB 对象） | 判定 |
|---|---|---|
| approval boundary（缺 approvalId 即拒） | `services/action-guard/action-guard.ts:150-155` → `ACTION_GUARD_HUMAN_APPROVAL_REQUIRED`；受保护动作含 `settlement.record` / `recovery.manual_submit` / `recovery.reconciliation_*` / `claim.submit` / `platform.write` / `commission.charge` | PASS |
| approval consumption / 撤销 / 目标一致性 | `services/action-guard/approval-verifier.ts`（tenant / 主体 / 动作 / 目标对象 / 证据版本 / 有效期 / 撤销 / 消费状态）、`approval-tx-verify.ts`（`APPROVAL_NOT_VERIFIED`、`recovery.approval_consumed` 事件族） | PASS |
| approval 跨租户 | `APPROVAL_TENANT_MISMATCH`（`approval-verifier.ts:77`） | PASS |
| settlement lineage | `cc_account_consistency__Settlement`（`20261002090000` 建立、`20261002090500` 改名）；`c2-settlement-lineage-db` 正/负/legacy 3 例 | PASS |
| recovery ledger 写入 | `services/recovery/closure-service.ts:538`、`services/workflow/recovery-outcome.ts:421`（同事务；`cc_tenant_RecoveryLedgerEntry`） | PASS |
| fee calculation | `services/settlement/record-fee.ts` + `fee-eligibility.ts`（`REVERSED` 不可计费）；`cc_feecalculation_claimitemid` / `cc_feecalculation_invoice_link_guard`（`20261002030000`） | PASS |
| billing invoice | `services/billing/billing-draft.ts:162-250`（`FOR UPDATE` 锁后重读 + `BILLING_BASIS_REQUIRED`）；`cc_billinginvoice_issue_guard` | PASS |
| manual confirmation | `services/recovery/recovery-confirmation.ts`（不触 Fee/Billing/Payment/RecoveryLedger 写入）；`services/workflow/recovery-outcome.ts:380-421` | PASS |
| reconciliation read path | `services/reconciliation/projector.ts:19`「绝不作为业务计算输入」；`ingest.ts` / `basis-actions.ts` / `manual-actions.ts` 头部边界声明 | PASS |

**结构性事实**：R46 财务链（Settlement / FeeCalculation / BillingInvoice）无 accountId 列；C2 的 account 维度经 `Settlement → ClaimItem / EvidenceArtifact` lineage 与 `cc_account_consistency__Settlement` 生效，未在财务链内引入新的 NULL 语义入口，也未放宽任何 R46 边界。

## X1-D2 — tenant isolation

**结论：account lineage 的租户隔离由 DB 触发器 + 查询期 organizationId 双重保证；未发现跨租户 resolver 路径。**

- DB 层：`20260928060000_tenant_integrity`（16 个 `cc_tenant_*`）、`20260928070000_tenant_integrity_fixes`、`20261001160500/1610/1615`（结算·账务链）、`20261002040000_platform_account_identity`（`cc_tenant_platformaccount`、`cc_tenant_sourceconnection_platformaccountid`、`cc_tenant_immutable__PlatformAccount`）、`20261002060000_account_scope_downstream`（`cc_account_binding_immutable__{SourceConnection,SourceTransaction,CanonicalFact,RecoveryOpportunity,ClaimItem,EvidenceArtifact}` + `cc_tenant_{sourcetransaction,canonicalfact,recoveryopportunity,claimitem,evidenceartifact}_accountid`）、`20261002090000` / `20261002090500`（`cc_account_consistency__{ClaimItem,ClaimItemEvidence,Settlement}`）。合计 60+ 个 `cc_tenant_*` / `cc_account_*` 触发器。
- 应用层：`services/evidence/account-scope.ts:62-110` 的 resolver 查询一律带 `organizationId`。
- 既有测试证据：`c2-account-boundary-baseline` 7/7、`c2-cross-account-guards-db` 4/4、`tenant-isolation`、`c2-account-scope-db`（`CLIENT_ACCOUNT_FIELD_NOT_TRUSTED`）。
- 跨租户错误码：`CONNECTION_TENANT_MISMATCH`（`acquisition/types.ts:22`）、`APPROVAL_TENANT_MISMATCH`。

## X1-D3 — legacy read compatibility

**结论：legacy NULL 可读且不被解释为某 account；严格 resolver 只出现在写路径，不会让合法历史读取崩溃；但 legacy 仍可进入部分上游新写入（= X1-A 已认定 HIGH，属 TRACK B 待修）。**

- 严格 resolver 全部调用点（非测试代码共 7 处）：`services/evidence/prisma-ports.ts:43`、`services/recovery/closure-service.ts:399,507`、`services/workflow/recovery-outcome.ts:381` —— 全部是写入前的 account 派生；读路径（insights / projection / shadow / reconciliation read）不调用该 resolver。
- legacy 读取证据：`c2-settlement-lineage-db:130`「legacy（两端 accountId 均为 NULL）仍可读，且 lineage 不被解释为任意 account」；`c2-account-scope-db:333`「legacy（accountId IS NULL）仍按 (org, factKey) 唯一」。
- legacy 不得进入新 active write progression：Evidence/Closure 侧已 fail-closed（永久负路径）；上游 ingest / CanonicalFact / Opportunity / ClaimItem 仍为 `?? null` 回落 —— 该缺口按 MSG-73 ③④⑤ 由 TRACK B 修复（legacy 只读冻结 + 新 NULL CanonicalFact 写入禁止 + active 新 ClaimItem 必须 account-scoped）。

## X1-D4 — canonical source-of-truth map（按 MSG-73 指定）

| Fact | Authoritative account source | Missing behavior |
|---|---|---|
| SourceConnection | PlatformAccount binding（onboarding invariant，B-1） | reject activation / ingest |
| SourceTransaction | bound SourceConnection（runtime invariant，B-2） | fail-closed |
| CanonicalFact | upstream resolved account | fail-closed（legacy NULL 分支仅历史读） |
| RecoveryOpportunity | canonical / source transaction account | fail-closed |
| ClaimItem | Opportunity / trusted account context | fail-closed（MANUAL_IMPORT staging ≠ ClaimItem） |
| Evidence | shared strict resolver（`account-scope.ts`） | fail-closed（已实现） |
| Settlement | Claim / Evidence lineage（`cc_account_consistency__Settlement`） | cross-account reject（已实现） |

## 残留风险（诚实登记）

- R1（LOW）：X1-D1 采用既有 trigger + 既有测试证据口径，未对 R46 每条读路径逐行复核。
- R2（HIGH，已知）：上游 permissive 仍在（X1-A）；X1-D 不改变该事实，修复属 TRACK B。
- R3（LOW）：`cc_reconciliationprojection_controlled_mutation` 等「受控变更」触发器的允许矩阵未逐条展开。

（本轮为只读审计；未改代码。等 X1-D 裁决后再决定 `PHASE X1 = CLOSED → TRACK B`。）
