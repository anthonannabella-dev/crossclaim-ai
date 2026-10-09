# SI-RSI V2-09 — 验收矩阵 v3（第二轮修复后 · 待第三轮复审）

> 依据：`MSG-20261010-54`（第二轮 `PASS_WITH_REVISE`，`NEXT_AUTHORIZED=V2_R2_SCOPED_TRUST_BOUNDARY_REPAIR`）。
> 本版覆盖 CHANGE 10–13 的处置，并附 CHANGE 06 的数据库执行方案。

## 0. 锚点（四分离，延续 v2 约定）

| 锚点 | 取值 |
| --- | --- |
| `REVIEW_HEAD`（第一轮送审） | `1caad401` |
| `ARCHIVE_HEAD`（两轮裁决归档） | `bfa109ca` / `e7adfe08` |
| `CODE_HEAD` / `EVIDENCE_HEAD` | `6bfa9b18` |

## 1. 第二轮 REQUIRED_CHANGES 处置

| 编号 | 严重度 | 状态 | 证据 |
| --- | --- | --- | --- |
| 10 收款事实"自我认证" | P0 | **FIXED** | 删除 `verifyFeeCollectionFact`（来源由调用方自述）；新增 `authenticateCollectionFact`：HMAC-SHA256(ts.body) 验签 + 时间戳窗口 + 载荷结构校验**之后**才做绑定；商户/应收/币种预期**必填**，为空即拒（不再跳过校验）；绑定交易号+金额+币种+来源 |
| 11 包装复制非函数属性 | P1 | **FIXED** | 删除自动复制；只读**自有数据属性**的 `providerId`/`displayName`；`capabilities` 仅保留显式 `true` 并复制为冻结新对象；getter 既不复制也不触发（测试用计数 getter 断言 0 次调用） |
| 12 Pack 归属未知未 fail-closed | P1 | **FIXED** | `ownerOrganizationId` 为 `null`/`''`/纯空白 → `OPPORTUNITY_OWNERSHIP_UNKNOWN` 并停止；与"归属是别人"(`..._MISMATCH`) 分成两个独立原因码 |
| 13 策略与历史账目收紧 | P1 | **FIXED** | 新增 `asOfDate` 与四项策略校验（id/version 非空、判定日落在生效窗口、`rateBps ∈ (0,10000]` 整数、币种一致）；历史金额改为只采信 `LEDGER`/`PROVIDER_RECONCILIATION_LEDGER`，其余来源不采信并给 `HISTORY_SOURCE_UNTRUSTED` |

### 对 03 / 04 的说明（**不自行宣布 CLOSED**）

- 03（`COLLECTED` 缺可信支付事实绑定）的短板随 CHANGE 10 的独立认证边界实质补齐；
- 04（出口覆盖非结构性封闭）的残留短板随 CHANGE 11 的白名单元数据实质补齐。

以上为**我方判断**，须由审计方复审确认，本文件不代其宣告 CLOSED。

## 2. CHANGE 06 数据库执行方案（保持 BLOCKED，仅备执行）

**触发条件**：宿主提供隔离 PostgreSQL 16 实例（`SCHEMA_MIGRATION` 需单独授权）。

需要的数据结构（最小集）：

| 表 | 关键约束 | 目的 |
| --- | --- | --- |
| `customs_payment_event` | `UNIQUE(event_id)` | 支付事件幂等（替换进程内 `processedEventIds`） |
| `customs_unlock_entitlement` | `UNIQUE(quote_id)`、`quota_remaining >= 0` CHECK | 报价→权益一一对应（替换确定性 id 约定） |
| `customs_fee_receivable` | `UNIQUE(settlement_id)` | 同一结算不重复计费（替换 `billedSettlementIds`） |
| `customs_fee_collection_txn` | `UNIQUE(transaction_id)`、`UNIQUE(receivable_id, transaction_id)` | 收款交易唯一入账（替换 `collectionFact` 判定） |

原子写入方式：每个事件在**单个事务**内 `INSERT ... ON CONFLICT DO NOTHING` + 影响行数判定；
影响 0 行 = 重复投递 → 返回幂等结果，不重复发放/计费。

必须跑的并发重放验证（四类，各含"同键并发"与"交错"两种调度）：

1. 同一支付事件 `event_id` 并发投递 → 期望：恰好 1 次权益发放；
2. 同一报价 `quote_id` 并发下单 → 期望：恰好 1 份权益；
3. 同一结算 `settlement_id` 并发入账 → 期望：恰好 1 条应收；
4. 同一收款交易 `transaction_id` 并发回调 → 期望：恰好 1 条 `PAYMENT_COLLECTED`。

外加：并发领取（租约 CAS）、部分到账+退款交错、冲正后余额一致性。

**纪律**：以上在 PG16 就位前一律保持 `BLOCKED`；不得用进程内 Set 或纯函数测试替代。

## 3. 证据（`EVIDENCE_HEAD=6bfa9b18`，本机真实执行）

```powershell
cd D:/crossclaim-ai/apps/api
npx vitest run src/__tests__/customs-paid-api-gate.test.ts src/__tests__/customs-paid-provider-composition.test.ts `
  src/__tests__/customs-opportunity-unlock-state.test.ts src/__tests__/customs-profit-gate.test.ts `
  src/__tests__/customs-unlock-payment.test.ts src/__tests__/customs-execution-chain.test.ts `
  src/__tests__/customs-unlock-si-pack.test.ts src/__tests__/customs-success-fee-collection.test.ts `
  src/__tests__/customs-success-fee-guard.test.ts
# → Test Files 9 passed (9) · Tests 195 passed (195)
npx tsc --noEmit   # apps/api → 0 error
```

各套件：gate 36 · composition 17 · projection 20 · profit-gate 21 · unlock-payment 26 · chain 19 ·
pack 11 · fee-collection 27 · success-fee-guard 18。

## 4. 仍然 HOLD 的边界

```text
REAL_PAYMENT_WEBHOOK_E2E=NOT_VERIFIED · POSTGRESQL_IT=NOT_RUN · REAL_PROVIDER=NOT_VERIFIED
BROWSER_E2E=NOT_VERIFIED · MULTI_DEVICE_VISUAL=NOT_VERIFIED · PACK_REGISTRATION=NOT_WIRED
ENTITLEMENT_AWARE_CTA=NOT_IMPLEMENTED · CHECKOUT_REDIRECT=NOT_IMPLEMENTED
AUTO_COLLECTION=HOLD · REAL_PROVIDER_WRITE=HOLD · PRODUCTION_READY=NO
U1_REOPEN=NO · U2_DESIGN_R21=NOT_REOPENED · SECOND_RUNTIME=NO
```
