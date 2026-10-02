# R46 S4 — Fee Membership + Fee Calculation / Adjustment · Implementation Checkpoint

> 依据：**MSG-20261002-59 = PASS**（R46 S3 CLOSED；R46 S4 AUTHORIZED）。
> 边界：**NO Invoice mutation · NO Payment activation · NO autopay · NO platform write · NO production credentials**；R13 Payment Activation Gate = HOLD。

## 1. 交付

| 文件 | 内容 |
| --- | --- |
| `apps/api/src/services/settlement/fee-compute.ts` | 确定性 Fee 计算（纯函数）+ `feeAdjustmentEffect`（kind 决定方向） |
| `apps/api/src/services/settlement/fee-eligibility.ts` | Fee 资格判定（纯函数） |
| `apps/api/src/services/settlement/record-fee.ts` | membership + FeeCalculation 受保护写路径 |
| `apps/api/src/services/settlement/record-fee-adjustment.ts` | FeeCalculationAdjustment 受保护写路径（append-only） |
| 测试 | `fee-compute.test.ts`（6）· `fee-eligibility.test.ts`（3）· `fee-record-db.test.ts`（5）· `fee-adjustment-db.test.ts`（3） |

## 2. MSG-59 S4 核心不变量落地

1. **Fee basis**：只接受 confirmed + unreversed + eligible Settlement；`isSettlementFeeEligible` 对 STATEMENT/NOT_CONFIRMED/NOT_RECONCILED/MISSING_EVIDENCE/REVERSED/REVERSAL_ADJUSTMENT_PRESENT/INVALID_AMOUNT 逐项 fail-closed；禁用 Claim 金额 / ExpectedRecoveryBasis / R45 projection / override 等来源。
2. **Membership**：不做全局 `UNIQUE(org, settlementId)`；改为同 claimItem 单 active chain 守卫（跨 chain 冲突 → MEMBERSHIP_CHAIN_CONFLICT）+ DB 层 `UNIQUE(feeCalculationId, settlementId)` 与 chain 触发器（S1 落地），并发同 chain 最终 membership 恰 1。
3. **Reversal → Fee**：不修改历史 FeeCalculation；新增 `FeeCalculationAdjustment`（append-only），引用触发 reversal，历史 calculation `calculatedAt` 不推进（零 UPDATE 证据）。
4. **Adjustment semantics**：VOID / REVERSAL / CORRECTION 语义冻结；amount 只存正数、方向由 kind 统一解释（`feeAdjustmentEffect`，VOID 需等额）。
5. **Fee policy**：rate / policyRef / feeBasisVersion 全部服务端提供；客户端自报 → CLIENT_FEE_INPUT_NOT_TRUSTED。
6. **Human authorization**：`billing.fee_calculate` / `billing.fee_adjust` 均需 humanApproval，approval 绑定服务端 feeSnapshotDigest / feeAdjustmentSnapshotDigest；**Settlement approval ≠ Fee approval**。

## 3. 18 项永久验收映射

| # | 要求 | 证据 |
| --- | --- | --- |
| 1 | unreversed eligible Settlement → 正确 membership | fee-record-db › happy path |
| 2 | reversed Settlement 不进入新 active fee basis | fee-record-db › 非 eligible；fee-eligibility › REVERSED |
| 3 | same settlement + same feeChain 并发 → at most one | fee-record-db › 并发同 chain membership 恰 1（+ S1 chain 触发器） |
| 4 | same settlement + legitimate different feeChain → allowed | fee 写路径按 feeChainId 判定；跨 chain 冲突仅在**同 claimItem** 时拒绝（合法不同 claim 链不受阻） |
| 5 | duplicate calculation replay → deterministic/reused | approval 恰好一次 + membershipDigest 可重建 |
| 6 | client-supplied fee rate/policy rejected | fee-compute › CLIENT_FEE_INPUT_NOT_TRUSTED；fee-record-db |
| 7 | membership digest deterministic | fee-compute（顺序无关）+ fee-record-db › 重建一致 |
| 8 | Settlement/reversal after approval drift → old fee approval invalid | approval 绑定 feeSnapshotDigest（membership/policy/chain）；漂移 → APPROVAL_REQUIRED |
| 9 | historical FeeCalculation immutable | fee-adjustment-db › 字段与 calculatedAt 不变 |
| 10 | reversal → append-only FeeCalculationAdjustment | fee-adjustment-db › reversal 用例 |
| 11 | adjustment replay safe | fee-adjustment-db › ADJUSTMENT_REPLAYED |
| 12 | cross-tenant membership reject | fee-record-db › CROSS_TENANT_REFERENCE；fee-adjustment-db › CROSS_TENANT_REFERENCE |
| 13 | success audit/approval consumption/calculation atomic | 两条写路径：audit + approval 消费 + 业务写入同事务 |
| 14 | failure rollback | approval 重复消费 → 整体回滚（两条写路径） |
| 15 | BillingInvoice = 0 | fee-record-db / fee-adjustment-db 显式断言 |
| 16 | Payment = 0 | 同上 |
| 17 | 不触发 autopay | 无任何 payment 写路径；断言 Payment=0 |
| 18 | R13 Payment Activation Gate 继续 HOLD | 未触碰 Payment/Mandate/autopay |

## 4. 证据

- `fee-compute` 6/6 · `fee-eligibility` 3/3 · `fee-record-db` 5/5 · `fee-adjustment-db` 3/3（均真实 PostgreSQL 或纯函数）
- `tsc --noEmit` 0 error；S2/S3 永久基线未退化（settlement-record-db 15/15 · settlement-reversal-db 10/10 · canonical 12/12 · action-guard 15/15）
- CI：见 GitHub 运行记录（3fbb47b success 起算）

## 5. 请裁决（编号）

1. §2 六项核心不变量与 §3 十八项永久验收是否满足 MSG-20261002-59 的 S4 授权范围？
2. 是否批准 **R46 S4 CLOSED** 并进入 **R46 S5（Invoice linkage boundary）**？

> 边界（重申）：NO automatic Invoice mutation · NO Payment activation · NO autopay · NO platform write · TRANSPORT=false · NO production credentials；R13 Gate = HOLD。
