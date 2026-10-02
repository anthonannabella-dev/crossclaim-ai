# R46 S6 — 只读金融链路一致性检查器 + 完整回归闭环 · Checkpoint

> 依据：**MSG-20261002-64 NEXT** —— 「如果 R46 既定范围还有 S6 checker / full financial-chain invariant regression，批准只进入这一类：**read-only consistency checker + complete regression closure**」。
> 边界：**只读**（全部 SELECT）· 无 Schema 变更 · 不触发 Payment / autopay / payment collection / external write · R13 Payment Activation = HOLD · `TRANSPORT=false` · 无生产凭据。

## 1. 交付

| 文件 | 内容 |
| --- | --- |
| `apps/api/src/services/consistency/financial-chain-checker.ts` | 只读一致性检查器（8 类检查，返回结构化 `ConsistencyReport`） |
| `apps/api/src/__tests__/financial-chain-consistency-db.test.ts` | 真实 PostgreSQL 验收 8/8（干净链路 + 每类违规注入） |

## 2. MSG-64 NEXT 清单 → 检查映射

| MSG-64 要求 | 检查代码 | 内容 |
| --- | --- | --- |
| Settlement/Adjustment 净额链 | `SETTLEMENT_NET_CHAIN` | 反向总额 ≤ 原 Settlement；同一 Settlement 至多一个 REVERSAL 调整；`reversedBySettlementId` 与 REVERSAL 事实必须一致 |
| FeeCalculation membership 一致性 | `FEE_MEMBERSHIP_CONSISTENCY` | membership.feeChainId == 父 calculation chain；无「零 membership 的 FeeCalculation」 |
| FeeAdjustment 一致性 | `FEE_ADJUSTMENT_CONSISTENCY` | amount 必须为正；REVERSAL 必须引用 ≥1 个 settlement adjustment（方向由 kind 表达） |
| Fee ↔ Invoice immutable linkage | `FEE_INVOICE_LINKAGE` | 链接发票存在且同租户；fee 币种 == 发票币种 |
| invoice basis digest 可重建 | `INVOICE_BASIS_REBUILD` | 由服务端 canonical builder 重建 `invoiceBasisDigest` 并与落库值比较（篡改/漂移即报错） |
| tenant boundaries | `TENANT_BOUNDARY` | membership/调整/费用/发票与父对象跨租户引用检测 |
| orphan/reference detection | `ORPHAN_REFERENCE` | 悬空引用：membership→Settlement/SettlementAdjustment、FeeAdjustment→trigger ids、Invoice→Case、Fee→Invoice |
| no hidden Payment side effects | `PAYMENT_SIDE_EFFECTS` | 存在任何 `Payment` 行，或发票携带 `paidAmount ≠ 0 / paidAt` → 报错（支付域关闭） |

## 3. 验收（真实 PostgreSQL）

`financial-chain-consistency-db` **8/8**：
1. 干净链路 → `ok = true`、`findings = []`、8 类检查计数齐全；
2. `SETTLEMENT_NET_CHAIN`：反向总额超原 Settlement → 报错；
3. `FEE_MEMBERSHIP_CONSISTENCY`：membership chain 与父 calculation 不一致 → 报错；
4. `FEE_ADJUSTMENT_CONSISTENCY` / `ORPHAN_REFERENCE`：REVERSAL 调整缺触发事实 + 悬空引用 → 报错；
5. `FEE_INVOICE_LINKAGE`：fee 与发票币种不一致 → 报错；
6. `INVOICE_BASIS_REBUILD`：发票 basis digest 被篡改 → 无法重建 → 报错；
7. `TENANT_BOUNDARY`：membership 与父 calculation 跨租户 → 报错；
8. `PAYMENT_SIDE_EFFECTS`：发票携带 `paidAmount` → 报错。

> 违规注入方式：对触发不变量保护的行使用**显式临时停用触发器**的对抗性夹具（`withDisabledTriggers`，与既有 payment 夹具同一范式），用于验证检查器确实能发现「绕过应用不变量的直接 DB 写入」；生产路径不经过该入口。

## 4. 完整回归闭环

- 全量 `npm test`：**186 files / 1839 tests PASS**（含新增 S6 套件）
- `tsc --noEmit` **0 error** · `prisma validate` **valid**（本批无 Schema 变更）
- fresh deploy **PASS**（临时库全量迁移：S4-A/S5-A 列、索引、触发器全部在位）
- tenant-trigger 与 append-only 两个清单门禁 **PASS**

## 5. 边界（全程不变）

`Payment = 0` · `RecoveryLedger` 无 payment 变动 · `autopay = OFF` · `payment collection = OFF` · `external payment write = OFF` · R13 Payment Activation = HOLD · `TRANSPORT=false` · 无生产凭据。
检查器为**只读**：不修改任何事实、不消费审批、不产生外写；可作为后续 CI / 运维巡检入口（当前仅以测试形式接入）。

## 6. 请裁决

1. S6 只读一致性检查器（8 类检查）与 8 项验收是否满足 MSG-20261002-64 的 NEXT 范围？
2. 是否批准 **R46 全链路 regression closure**（S1–S6 全部 CLOSED）？
3. 下一步方向请指定：Gate 7 ② 剩余业务入口小队列 / TRACK B 平台准备线 / 或此前登记的 TRACK C（Growth SEO）与 TRACK C2（Multi-Account，含跨账户合并缺陷待裁决）。
