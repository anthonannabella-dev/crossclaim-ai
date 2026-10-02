# PC-05 FINAL Checkpoint（Recovered Money Visibility — REVISE 收口后）

状态：**READY_FOR_REVIEW / FINAL CHECKPOINT**（待架构方最终复审）
FINAL_IMPLEMENTATION_HEAD = 46e1105
FINAL_IMPLEMENTATION_HEAD_FULL = 46e1105431de7256433adad944b35d2de08b2be3
CI = SUCCESS · RUN_ID = 37032654286 · CI_HEAD = 46e1105
前序：首次 checkpoint HEAD 3cef009 / CI 37030847155 → MSG-20261003-87 = **REVISE**（唯一 CHANGE：跨币种污染）。
授权：MSG-20261003-86 ⑥⑦⑧；本次修订依据 MSG-20261003-87。
边界：MONEY VISIBILITY（非 MONEY MOVEMENT）· Payment = 0 · collection = OFF · TRANSPORT=false · 无生产凭据。

## 1. 唯一 CHANGE 的收口方式

**问题**：原实现按 `Case.currency` 建立单一 bucket，却把该 case 下所有 Settlement / SettlementAdjustment / BillingInvoice / ClaimItem 金额不区分币种地累加进去 —— 这正是 PC-05 授权明确禁止的跨币种污染。

**修正**：金额一律按其**自身事实的币种**分桶：

| 事实 | bucket 归属 |
|---|---|
| ClaimItem.recoverableAmount | `item.currency` |
| Settlement.amount（EXPECTED / DISPUTED / RECEIVED·PARTIAL） | `settlement.currency` |
| SettlementAdjustment.amount（REVERSAL） | `adjustment.currency` |
| BillingInvoice.total / paidAmount | `invoice.currency` |

case 维度改为返回 `byCurrency: CurrencyBucket[]`（按币种排序）+ `primaryBucket`（case 自身币种的 bucket，若无该币种事实则为 null）；组织维度按事实币种聚合，任何跨币种相加都被结构性排除。money status 由 primary bucket（缺失时取首个币种 bucket）推导，不再隐含跨币种求和。

UI `/money` 同步改为按币种渲染（`USD 50.0000 · EUR 70.0000` 形式），避免把不同币种并排误读为同一金额。

## 2. 验证证据

- 新增永久回归「跨币种污染回归：同一 case 的 USD / EUR 事实必须落在不同 bucket」：同一 case 内 USD 50 + EUR 70 → `organization.byCurrency` 分别 USD=50 / EUR=70，case 的 `byCurrency` 亦分别 50 / 70，`primaryBucket.recovered = 50`（只含 USD）。
- `recovery-money-view-http-db` **8/8 PASS**（原 7 项 + 跨币种 1 项）：401 / VIEWER 403 / FINANCE 200；same tenant visible、foreign invisible、无 secret 字段；EXPECTED≠RECEIVED、PARTIAL 计入、VOID 排除、DISPUTED 单独计数且状态 DISPUTED；reversal 冲减 net 至 0 且状态 REVERSED；multi-currency 分组；fee calculated≠collected 且 `payment=ZERO`·`collection=NOT_ENABLED`；跨租户 caseId 404。
- `tsc --noEmit`（apps/api / apps/web）0 error；本地 API contract `API_CONTRACT_OK`（本次未新增路由）。
- CI 全量回归（migration / typecheck / unit + DB / two-stage upgrade / web build）RUN_ID = 37032654286 全绿。

## 3. 未做 / 边界

未扩大范围：未 activate payment、未 collect、未 create payout、未 connect PSP、未 add FX engine、未 redesign R46、未 modify account lineage、未改 Schema、未加 migration、未新增写端点。

## 4. 下一执行单元（待裁决）

若 PASS：PC-05 = PASS / CLOSED → 解除 **PC-06 = PENDING PC-05 FINAL**，进入 PC-06 Account management。
边界保持：NO platform write · Payment = 0 · autopay = OFF · collection = OFF · external payment write = OFF · R13 HOLD · TRANSPORT=false · 无生产凭据。
