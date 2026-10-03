# R46 S5 FINAL — Invoice Linkage Boundary（Fee → Invoice）

> 依据：**MSG-20261002-62（R46 S4 CLOSED；R46 S5 AUTHORIZED）** → **MSG-20261002-63（PASS WITH REVISE：方案 A 获准；CHANGE A 要求 basis identity 不可复用；`billing.invoice_issue` 独立入口批准；未经再次设计请求，直接实施 → S5 FINAL）**。
> 边界：Payment / autopay / payment collection / external payment write 全部 OFF；R13 Payment Activation = HOLD；TRANSPORT=false；无生产凭据。

## 1. 交付

| 文件 | 内容 |
| --- | --- |
| `apps/api/prisma/schema.prisma` | `BillingInvoice.invoiceBasisDigest` / `invoiceBasisVersion` / `customerAccountIdentity` |
| `apps/api/prisma/migrations/20261002030000_invoice_basis_identity/migration.sql` | 三列 + 重复审计 + basis 唯一索引 + 一票一费索引 + 发票/费用链接守卫 |
| `apps/api/src/services/billing/invoice-basis.ts` | 唯一服务端 canonical builder（`invoiceBasisDigest = sha256(canonicalInvoiceBasis)`）+ 客户端可信字段拒绝 |
| `apps/api/src/services/billing/invoice-issue.ts` | `billing.invoice_issue` 受保护写路径（独立 approval / 锁后重建 basis / exact replay REUSED / 原子提交） |
| `apps/api/src/__tests__/invoice-issue-db.test.ts` | 真实 PostgreSQL 验收 10 例（覆盖 MSG-63 24 项 TEST） |

## 2. CHANGE A（MSG-63 修订）落地

- 唯一索引为 **`UNIQUE(organizationId, invoiceBasisDigest) WHERE invoiceBasisDigest IS NOT NULL`**，**未**使用 `status <> VOID`。
- **VOID 不释放 basis identity**：`TEST 9/10` 证明发票 VOID 后 exact replay 仍返回**同一 invoice identity**（`REUSED`），且该 basis 只有一张发票。
- 无历史数据冲突（本项目 `BillingInvoice = 0`）；迁移内置重复审计，若出现重复 digest 直接 `RAISE EXCEPTION INVOICE_BASIS_DUPLICATE_FOUND`（fail-closed，不静默删除/覆盖）。

## 3. Canonical Invoice Basis

绑定字段（冻结）：`organizationId` · `feeCalculationId` · `feeChainId` · `customerAccountIdentity` · `currency` · `feeAmount` · `policyRef` · `feeBasisVersion` · `membershipDigest` · `invoiceBasisVersion`。
- `customerAccountIdentity` 由服务端从 Case 事实派生（v1 取 `caseNo`，项目尚无独立 customer/account 模型）。
- 客户端提交 `invoiceBasisDigest / invoiceAmount / invoiceTotal / currency / customerAccountIdentity / policyRef / feeBasisVersion` 任一 → `CLIENT_INVOICE_FIELDS_NOT_TRUSTED`。
- `feeAmount` 规范化为 4 位小数、currency 大写，保证 digest 可复现。

## 4. DB 不变量（迁移内）

| 不变量 | 触发器/索引 | 错误码 |
| --- | --- | --- |
| basis identity 写一次 | `cc_billinginvoice_issue_guard` | `INVOICE_BASIS_IDENTITY_IMMUTABLE` |
| 已发行发票内容不可变 | `cc_billinginvoice_issue_guard` | `INVOICE_CONTENT_IMMUTABLE_AFTER_ISSUE` |
| 状态迁移白名单（DRAFT→ISSUED→{PAID,PARTIALLY_PAID}→{VOID,WRITTEN_OFF}） | `cc_billinginvoice_issue_guard` | `INVALID_INVOICE_STATUS_TRANSITION` |
| `FeeCalculation.billingInvoiceId` 一经非空即 immutable | `cc_feecalculation_invoice_link_guard` | `FEE_INVOICE_LINK_IMMUTABLE` |
| 关联发票非 DRAFT 时 fee 财务字段不可变 | `cc_feecalculation_invoice_link_guard` | `FEE_CALCULATION_IMMUTABLE_AFTER_ISSUE` |
| invoice 币种 == fee 币种 | `cc_feecalculation_invoice_link_guard` | `INVOICE_CURRENCY_MISMATCH` |
| v1 一票一费 | `FeeCalculation_org_invoice_key` | unique violation |
| basis 唯一（VOID 不释放） | `BillingInvoice_org_basis_key` | unique violation |

## 5. MSG-63 TEST 映射（真实 PostgreSQL）

| # | 要求 | 证据 |
| --- | --- | --- |
| 1 | canonical basis deterministic | `invoice-issue-db` › TEST 1（digest 64hex / version / customer identity 落库） |
| 2 | client digest/amount/currency/customer spoof rejected | › TEST 2 |
| 3 | `billing.invoice_issue` 独立 approval | › TEST 1/2（未授权 → `APPROVAL_REQUIRED`） |
| 4 | fee approval 无法执行 invoice issue | › TEST 2（fee approval 白名单 ≠ invoice 白名单） |
| 5–8 | fee amount / currency / customer identity / membership·policy·basis drift → reject | › TEST 5/6/7/8（TOFU verifier：digest 漂移 → `APPROVAL_REQUIRED`，不新增 identity） |
| 9 | exact replay → same Invoice / REUSED | › TEST 9 |
| 10 | VOID 后同 basis 不得创建第二 identity | › TEST 10 |
| 11 | conflicting immutable basis → `INVOICE_BASIS_CONFLICT` | › TEST 11/12 |
| 12 | same basis concurrent issue → at most one | › TEST 11 |
| 13 | same approval + distinct execution → exactly once | › TEST 13（loser `APPROVAL_ALREADY_CONSUMED`，零残留） |
| 14 | `billingInvoiceId` post-link mutation → DB reject | › TEST 14 |
| 15 | issued invoice content mutation → DB reject | › TEST 15 |
| 16 | invalid status transition → DB reject | › TEST 16 |
| 17 | invoice currency != fee currency → `INVOICE_CURRENCY_MISMATCH` | › TEST 17（DB 层拒绝链接） |
| 18 | multi-fee aggregation → fail-closed | › TEST 18（`FeeCalculation_org_invoice_key`） |
| 19 | multi-currency / FX → fail-closed | › TEST 17 + v1 单币种口径 |
| 20 | approval/linkage/ISSUED/audit 任一步失败 → full rollback | › TEST 20（`INVOICE_UPDATE` / `SUCCESS_AUDIT` 注入点；DRAFT 未被改写、approval consumption = 0） |
| 21 | FeeAdjustment after issued Invoice 不静默修改 Invoice | › TEST 14/15（fee 财务字段 + 发票内容在 ISSUED 后均不可变） |
| 22 | Payment = 0 | › TEST 1 |
| 23 | RecoveryLedger payment mutation = 0 | › TEST 1 |
| 24 | autopay = OFF | 无任何 payment/autopay 写路径；`Payment = 0` 断言 |

## 6. 证据汇总

- `prisma validate` valid · `tsc --noEmit` 0 error · tenant-trigger 与 append-only 两个清单门禁本地 PASS
- fresh deploy PASS（临时库全量迁移：3 列 / 3 索引 / 3 触发器在位）
- `invoice-issue-db` 10/10 · 全量回归 **19 files / 330 tests PASS**（fee-record-db 17 · fee-adjustment-db 5 · settlement-record-db 15 · settlement-reversal-db 10 · receipt-snapshot 12 · workflow-billing-db 5 · action-guard 32 · schema/tenant/architecture 全绿）
- 既有 `billing.draft` 用例夹具按 v1 口径更新（单费发票 + 合法状态顺序），未改动 draft 服务语义

## 7. 请裁决

1. CHANGE A（basis identity 不可复用）与 24 项 TEST 是否满足 MSG-20261002-63？
2. `billing.invoice_issue` 的独立 approval / 锁后重建 / 原子性实现是否被接受？
3. 是否批准 **R46 S5 CLOSED**？后续 Invoice Adjustment/Credit Note 是否按裁决留给独立 gate？
