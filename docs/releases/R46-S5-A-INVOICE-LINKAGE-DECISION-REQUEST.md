# R46 S5-A —— Invoice Linkage Boundary · 最小 Schema Delta / 决策请求

状态：**DECISION REQUEST（未实施）** · 2026-10-02 · 提出方 CODEX · 待架构方裁决
依据：**MSG-20261002-62 = PASS**（R46 S4 CLOSED；R46 S5 Invoice Linkage AUTHORIZED）。
触发条件：MSG-62 NEXT 明确 —— 「若现有 BillingInvoice 模型不能满足 DB concurrency / identity boundary，**先提交最小 S5-A Schema Delta Decision Request，不得用 application-only check 代替数据库 correctness boundary**」。本文件即该请求。

## 1. 现状核查（HEAD 9287621 起）

### 1.1 已有的边界（不推翻、不复用）

| 事实 | 位置 | 说明 |
| --- | --- | --- |
| `billing.draft` 受保护内部入口 | `apps/api/src/services/billing/billing-draft.ts` | INTERNAL_WRITE；admin 审批 → 锁后重读 → 写 BillingInvoice(DRAFT) + `billing.drafted` 审计 |
| 锁与可见性 | 同上 | `pg_advisory_xact_lock(hashtext(caseId))` + `SELECT ... FOR UPDATE` 锁定该 case 的发票与 FeeCalculation |
| basis 有效性 | 同上 | `fee.billingInvoiceId !== null` 或金额/币种非法 → `BILLING_BASIS_REQUIRED`（409） |
| 票据号唯一 | `schema.prisma` | `invoiceNo = BILL-<caseNo>`，`@@unique([organizationId, invoiceNo])` → 事实上「同一 case 至多一张发票」 |
| fee → invoice 链接 | `FeeCalculation.billingInvoiceId` | 目前是唯一链接载体（v1：一张草稿发票挂一条 FeeCalculation） |

### 1.2 缺口（对照 MSG-62 六项要求）

| MSG-62 要求 | 现状 | 缺什么 |
| --- | --- | --- |
| ① canonical invoice basis + approval 绑定（org / customer·account identity / currency / feeCalculation membership / fee amount / invoice total / policy·basis version / invoice basis digest） | 无任何 digest 字段；`billing.draft` 的审批绑定是 case 级 | **缺 canonical invoice basis digest 与其持久化列** |
| ② currency fail-closed（v1 不做 FX） | 仅服务层校验单条 fee 的 currency 是否为 3 位大写 | **缺 DB 级「basis fee 币种 == invoice 币种」不变量** |
| ③ FeeCalculation historical immutability（issue 后不得改历史 calculation） | S4 已证 0 UPDATE（测试级）；无 DB 守卫；`billingInvoiceId` 可被重新指向 | **缺 linkage 写入即 immutable 的 DB 守卫** |
| ④ replay / identity（exact replay → REUSED；冲突 immutable facts → 稳定 conflict） | 无 basis 身份 → 只能靠 `invoiceNo` 撞唯一键，且未收敛为领域结果 | **缺按 basis 的确定性身份 + 唯一约束** |
| ⑤ atomicity（approval consumption / BillingInvoice / linkage / success audit 同事务） | 服务层可做 | 服务层即可，无需 Schema |
| ⑥ concurrency（同一 invoice basis 并发 issue → at most one invoice commits；不得仅依赖 application findFirst） | 目前只有 case 级 `invoiceNo` 唯一 + 应用锁；**没有** basis 级数据库边界 | **缺 basis 级唯一约束** |

结论：**现有模型无法提供 MSG-62 要求的 DB concurrency / identity boundary** → 按 NEXT 提交本最小 Schema Delta 请求，裁决前不写 migration、不实现 issue 路径。

## 2. 建议的最小 Schema Delta（方案 A，推荐）

1. **invoice basis 身份**
   - `BillingInvoice.invoiceBasisDigest TEXT NULL`（64hex，服务端 canonical 计算：organizationId / caseId / currency / basisFeeCalculationId(s) / fee amount / invoice total / policyRef / feeBasisVersion / basisKind）
   - `BillingInvoice.invoiceBasisVersion TEXT NULL`（算法版本，便于未来演进）
   - `BillingInvoice.customerAccountIdentity TEXT NULL`（basis 绑定所需，来源服务端，不接受客户端自证）
2. **basis 级唯一（真正的并发边界）**
   ```sql
   CREATE UNIQUE INDEX "BillingInvoice_org_basis_key"
     ON "BillingInvoice" ("organizationId", "invoiceBasisDigest")
     WHERE "invoiceBasisDigest" IS NOT NULL AND "status" <> 'VOID';
   ```
   → 两个真并发 issue 同一 basis：PostgreSQL 保证 at most one；loser 收敛为稳定领域结果（如 `INVOICE_ALREADY_ISSUED`），不得泄漏 raw P2002/23505。
3. **linkage 不可变（写一次）**
   - `FeeCalculation.billingInvoiceId` 一经非空即 immutable：BEFORE UPDATE 守卫，试图改指向 → `FEE_INVOICE_LINK_IMMUTABLE`。
   - 关联发票状态 ≠ DRAFT 时，禁止修改该 FeeCalculation 的 `feeAmount` / `currency` / `basis` / `baseAmount` / `rate`（`FEE_CALCULATION_IMMUTABLE_AFTER_ISSUE`）。
4. **已发行发票内容不可变**
   - BillingInvoice BEFORE UPDATE：`OLD.status <> 'DRAFT'` 时拒绝修改 `invoiceNo` / `currency` / `subtotal` / `taxAmount` / `total` / `invoiceBasisDigest` / `caseId`（`INVOICE_CONTENT_IMMUTABLE_AFTER_ISSUE`）；状态迁移只允许 DRAFT→ISSUED→{PAID, PARTIALLY_PAID} / →VOID / →WRITTEN_OFF。
5. **currency fail-closed**
   - 链接（`billingInvoiceId` 置位）时校验 basis fee 币种 == invoice 币种，否则 `INVOICE_CURRENCY_MISMATCH`；v1 单币种、不做 FX，也**不允许**多币种聚合到同一发票。
6. **不新增业务表、不改其他领域**
   - 不触碰 Settlement / SettlementAdjustment / FeeCalculationAdjustment / RecoveryLedger / Payment / R13；不引入 credit-note 表（MSG-62 ③ 明确：无正式能力时先 fail-closed，留给后续独立 gate）。

### 方案 B（备选，仅在架构方希望显式 membership 时）

新增 linkage 表 `BillingInvoiceFee`（organizationId / billingInvoiceId / feeCalculationId / amount / currency / createdAt）+ `UNIQUE(org, feeCalculationId)` + append-only 触发器 + 租户触发器（需同步 required-triggers / append-only 两份清单）。
优点：membership 显式、可扩展一张发票多笔 fee；缺点：与现有 `FeeCalculation.billingInvoiceId` 产生双写一致性负担。**v1 建议采用方案 A**，等出现「一票多费」需求再演进。

## 3. 服务层契约（Schema 之外，裁决通过后实现）

- 新受保护入口 `billing.invoice_issue`（Action Guard / humanApproval，独立于 `billing.draft` 与 `billing.fee_calculate`）：
  - `targetRef = invoiceBasisDigest`；approval payload 至少绑定 organizationId / caseId / currency / basisFeeCalculationIds / fee amount / invoice total / policyRef·feeBasisVersion / basisKind；
  - **fee approval 不得复用为 invoice approval**（Settlement approval ≠ Fee approval ≠ Invoice approval）；
  - 锁后重建 basis digest 并比较：漂移 → `APPROVAL_REQUIRED`。
- exact replay（同一 basis，合法重复请求）→ `REUSED` 返回既有发票；冲突的 immutable facts → 稳定 `INVOICE_BASIS_CONFLICT`。
- 同事务：approval consumption → 链接校验 → ISSUED 写入 → success audit；任一步失败全部 rollback。
- 边界：Invoice issue 之后 **不** 触发 Payment/autopay/RecoveryLedger；`Payment = 0`、`autopay = OFF`、R13 HOLD 不变。

## 4. 请裁决

1. 是否批准 **方案 A**（`invoiceBasisDigest` + `invoiceBasisVersion` + `customerAccountIdentity` + basis 级部分唯一索引 + linkage/内容不可变守卫 + currency 不变量）作为 S5 的最小 Schema Delta？
2. 是否采纳 `billing.invoice_issue` 作为独立 Action Guard 入口，且 `targetRef = invoiceBasisDigest`？
3. v1 是否维持「一张发票 = 一笔 FeeCalculation / 单币种」并拒绝多币种聚合（方案 B 留待未来演进）？
4. 已发行发票的 reversal/correction 是否按 MSG-62 ③ 处理为 fail-closed + 留待独立 gate（本批不发明 credit-note）？

## 5. 边界（全程不变）

`BillingInvoice = 0`（本批未实现 issue，仍为 0）· `Payment = 0` · `RecoveryLedger financial mutation = 0` · `autopay = OFF` · `external payment write = OFF` · R13 Payment Activation = HOLD · `TRANSPORT = false` · 无生产凭据。
