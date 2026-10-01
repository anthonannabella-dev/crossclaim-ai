# R46 S3 — SettlementAdjustment / Full Reversal · Implementation Checkpoint

> 依据：**MSG-20261002-56 = PASS WITH REVISE**（S2 主体可关闭；授权进入 S3，范围冻结为 Settlement → verified reversal evidence → SettlementAdjustment(kind=REVERSAL)，v1 仅 full reversal）。
> 边界：**NO Fee 重算 · NO Invoice VOID · NO Payment/refund · NO autopay · NO platform write · TRANSPORT=false · NO production credentials**；R13 Payment Activation Gate = HOLD。

## 1. 交付

| 文件 | 内容 |
| --- | --- |
| `apps/api/src/services/settlement/record-reversal.ts` | `recordSettlementReversal`（受保护写路径）+ `createReversalDeps`（生产装配：action-guard verifier + ACTIVE membership 复验） |
| `apps/api/src/__tests__/settlement-reversal-db.test.ts` | 7 项真实 PostgreSQL 验收 |

## 2. 冻结不变量的落地

| 裁决要求 | 落地 |
| --- | --- |
| 原 Settlement 永久保留、不可修改 | 写路径只 INSERT `SettlementAdjustment`；测试断言金额 / `receiptSnapshotId` / `reconciliationStatus` 逐项不变 |
| amount == 原 Settlement.amount | `REVERSAL_AMOUNT_MISMATCH` fail-closed |
| currency == 原 currency | `REVERSAL_CURRENCY_MISMATCH` fail-closed |
| same reversal event replay → REUSED | 按自身 external identity / fingerprint 读回既有 adjustment 并断言事实一致 |
| 第二个不同 reversal event → REVERSAL_ALREADY_APPLIED | `UNIQUE(org, originalSettlementId)` + 显式领域错误 |
| 跨租户 fail-closed | 原 Settlement / evidence 均校验同租户（DB 复合守卫为第二道） |
| 并发只形成一个有效 full reversal | 并发用例断言最终仅 1 条 adjustment |
| 事务失败零残留 | approval 重复消费 → `APPROVAL_ALREADY_CONSUMED` → 整体回滚 |
| 资金下游零副作用 | 断言 Fee / Invoice / Payment / RecoveryLedger 全部为 0 |

## 3. 证据

- `settlement-reversal-db` **7/7 PASS**（真实 PostgreSQL）
- `settlement-record-db` 15/15 · `settlement-receipt-snapshot` 12/12 · `action-guard` 15/15（既有基线未退化）
- `tsc --noEmit` **0 error**

## 4. 请裁决（编号）

1. §2 的 8 项不变量落地是否满足 MSG-20261002-56 的 S3 冻结范围？
2. 是否批准 **R46 S3 CLOSED** 并进入 **R46 S4（Fee membership + fee calculation / adjustment）**？

> 边界（重申）：NO automatic Fee · NO automatic Invoice mutation · NO Payment activation · NO autopay · NO platform write · TRANSPORT=false · NO production credentials。
