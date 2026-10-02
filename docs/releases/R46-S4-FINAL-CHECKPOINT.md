# R46 S4 FINAL — Fee Membership + Fee Calculation / Adjustment（含 S4-A 并发边界）

> 依据：**MSG-20261002-59（S4 AUTHORIZED）** → **MSG-20261002-60 / 60A（REVISE，全部收口）** → **MSG-20261002-61（PASS WITH REVISE：S4-A 方案 A 授权为数据库 correctness boundary，方案 B 保留为纵深防御；直接进入 S4 FINAL）**。
> 边界：NO Invoice mutation · NO Payment activation · NO autopay · NO platform write · TRANSPORT=false · NO production credentials；R13 Payment Activation Gate = HOLD。

## 1. MSG-60 / 60A / 61 CHANGE 收口

| 裁决项 | 处置 | 证据 |
| --- | --- | --- |
| 60 CHANGE A：fee policy 服务端可信、版本化 | `fee-policy-source.ts` 只接受 `policyRef` + `feeBasisVersion`；`basis/rate/fixedAmount/currency/policyDigest` → `CLIENT_POLICY_FIELDS_NOT_TRUSTED`；approval digest 绑定解析后的 server policy + policyDigest | fee-record-db › 伪造 policy 字段不影响持久化；server policy 漂移 → `APPROVAL_REQUIRED` 且零写入 |
| 60 CHANGE B：真并发 membership 证明 | **S4-A 方案 A 落地**：`FeeCalculationSettlement.feeChainId`（服务端派生、immutable）+ 部分唯一索引 | 见 §2 / §3 |
| 60 CHANGE C：事务原子性 | 四个注入点（approval consumption / FeeCalculation / membership / success audit）任一失败 → 整体回滚 | fee-record-db › it.each 4 例（零残留、Invoice=0、Payment=0、Ledger 不变） |
| 60A ①：policy store/registry | 同 60 CHANGE A | 同上 |
| 60A ②：adjustment evidence provenance | 只接受 `evidenceArtifactId`；服务端派生 digest/kind；缺失 → `EVIDENCE_NOT_FOUND`；跨租户 → `CROSS_TENANT_REFERENCE`；客户端自证 → `CLIENT_EVIDENCE_NOT_TRUSTED` | fee-adjustment-db › provenance 用例 |
| 60A ③：adjustment approval 绑定点 | digest 绑定 `evidenceArtifactIds / reasonText / correctionDirection` | fee-adjustment-db › 四项漂移 → `APPROVAL_REQUIRED` 且零新增写入 |
| 60A ④：same-chain 并发证据强度 | exactly-one success + 稳定 loser 领域错误 + loser 零残留；合法不同 chain 与 superseded-chain 两条 positive control | fee-record-db › 「CHANGE B（R46 S4-A 已落地）」+ 两条 positive control |
| 60A ⑤：CI 可见 | HEAD 4a207d5 → run 36950211957 success | 见 GitHub Actions |
| 61 CHANGE A（REQUIRED） | 见 §2 | 见 §3 |
| 61 CHANGE B（纵深防御） | `recordFeeCalculation` 事务内 `pg_advisory_xact_lock(hashtext(org:feeChainId:settlementId)::bigint)`（不是 correctness source） | fee-record-db 全部用例 + §3 并发用例 |

## 2. Schema Delta（最小，且仅限 membership concurrency boundary）

- `FeeCalculationSettlement.feeChainId TEXT`（服务端派生、写入后 immutable）。
- 迁移 `20261002020000_fee_membership_chain_boundary`：
  1. `ADD COLUMN IF NOT EXISTS "feeChainId"`；
  2. server-side backfill（临时 `DISABLE TRIGGER USER` → 回填 → 重新启用）；
  3. 回填校验：存在 null / mismatch 即 `RAISE EXCEPTION FEE_CHAIN_BACKFILL_FAILED`（整个迁移回滚）；
  4. 派生守卫 `cc_feemembership_chain_derive`（BEFORE INSERT，tgtype=7）：`NEW.feeChainId := 父 FeeCalculation.feeChainId`；客户端提交不一致值 → `FEE_CHAIN_MISMATCH`；父不存在 → `FEE_CHAIN_NOT_FOUND`；
  5. 部分唯一索引 `FeeCalculationSettlement_org_chain_settlement_key`（`organizationId, feeChainId, settlementId` WHERE settlementId IS NOT NULL AND feeChainId IS NOT NULL）与 `..._org_chain_adjustment_key`（同形，adjustmentId）。
- **未触碰**：FeeCalculation 历史语义、Settlement、SettlementAdjustment、BillingInvoice、Payment、RecoveryLedger、R13。
- **未使用**全局 `UNIQUE(org, settlementId)`（MSG-55 明确禁止）。
- 服务层：membership / FeeCalculation 的唯一约束冲突统一收敛为稳定领域错误
  `FEE_MEMBERSHIP_ALREADY_EXISTS` / `MEMBERSHIP_CHAIN_CONFLICT`，不泄漏 raw P2002/23505。

## 3. S4-A TEST 12 项映射（真实 PostgreSQL）

| # | 要求 | 证据 |
| --- | --- | --- |
| 1 | same org + same Settlement + same feeChain + 独立事务 → exactly one commit | fee-record-db › 「CHANGE B（R46 S4-A 已落地）：两个并发 membership → 数据库层最多一个成功」 |
| 2 | loser → 稳定领域错误 | 同上（loser 断言 `FEE_CHAIN_SETTLEMENT_ALREADY_CONSUMED`/unique 归一）+ 受保护写路径并发用例（`FEE_MEMBERSHIP_ALREADY_EXISTS` 或 `MEMBERSHIP_CHAIN_CONFLICT`，无 raw P2002） |
| 3 | loser 零 membership / 零 FeeCalculation / 零 success audit | fee-record-db › 并发用例 loser 迭代断言（membership=0、audit=0、fees=+1、memberships=+1） |
| 4 | same Settlement + different legitimate feeChain → allowed | fee-record-db › positive control（不同 chain 2/2 允许） |
| 5 | superseded-chain 合法路径 → allowed | fee-record-db › superseded 后继 chain positive control |
| 6 | client supplied feeChainId → reject/ignore as untrusted | fee-record-db › `FEE_CHAIN_MISMATCH`（伪造 chain）+ 派生用例（不提供 chain → 落库为父 chain） |
| 7 | membership feeChainId 与父 FeeCalculation 不一致 → DB fail | 同 #6 |
| 8 | membership feeChainId 写入后 mutation → DB fail | fee-record-db › `APPEND_ONLY_TABLE`（append-only 触发器） |
| 9 | advisory-lock path 正常 | fee-record-db 全量 17 用例（写路径均在锁内）+ tsc 0 |
| 10 | 绕过 advisory lock 仍被 unique constraint 拦截 | fee-record-db › DB 层并发直插用例（不经服务层/不加锁） |
| 11 | fresh deploy PASS | 临时库 `cc_s4a_check`：全部迁移应用 → 列 / 派生触发器 / 两个部分唯一索引均在位（已清理临时库） |
| 12 | existing/upgrade migration PASS | 本地升级库：`prisma migrate deploy` 应用 `20261002020000`（含 backfill + 校验） |
| 13 | S2/S3/S4 regression 全绿 | 15 files / 288 tests PASS（含 settlement-record-db 15、settlement-reversal-db 10、receipt-snapshot 12、tenant-isolation、architecture-contract、action-guard 32、S4 fee 全套） |

### 缺陷取证（修复前）

CHANGE B 的 `it.fails` 缺证用例在本地测试库中**真并发写入了 7 组重复 (organizationId, feeChainId, settlementId) membership**；
该批残留使 S4-A 迁移的唯一索引创建失败（`E23505`），反向证明「触发器先查后插」不是并发边界。清理仅限合成测试组织（`Organization.name LIKE 'R46%'`），保留每组最早一行，共删除 7 行，处理后重复组 = 0。

## 4. 证据汇总

- `prisma validate` valid · `tsc --noEmit` 0 error · tenant-trigger / append-only 两个清单门禁本地 PASS
- fee-record-db 17/17 · fee-adjustment-db 5/5 · fee-compute 6/6 · fee-eligibility 3/3 · fee-policy-source 2/2
- S2/S3 基线：settlement-record-db 15/15 · settlement-reversal-db 10/10 · settlement-receipt-snapshot 12/12 · action-guard 32/32
- 全量回归：15 files / 288 tests PASS

## 5. 边界（全程不变）

`BillingInvoice = 0` · `Payment = 0` · `RecoveryLedger financial mutation = 0` · `autopay = OFF` · R13 Payment Activation = HOLD · `TRANSPORT=false` · 无生产凭据。
S5（Invoice linkage）在 S4 FINAL 通过前不得开启。

## 6. 请裁决

1. S4-A Schema Delta（`feeChainId` + 部分唯一索引 + 派生守卫 + backfill/校验）与 12 项真实 PostgreSQL 验收是否满足 MSG-20261002-61 CHANGE A？
2. 纵深防御 advisory lock（CHANGE B）实现是否被接受？
3. 是否批准 **R46 S4 CLOSED** 并进入 **R46 S5（Invoice linkage boundary）**？
