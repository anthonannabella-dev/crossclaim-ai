# R46 S2 — Receipt Snapshot + Settlement Record/Ingest · Implementation Checkpoint

> 依据：**MSG-20261002-55 = PASS WITH REVISE — R46 S1 CLOSED / S2 AUTHORIZED**（S2 只做到：可信到账证据 → immutable server-side receipt snapshot → human approval → Settlement 财务事实）。
> 边界：**NO SettlementAdjustment · NO FeeCalculation · NO BillingInvoice · NO Payment activation · NO autopay · NO platform write · TRANSPORT=false · NO production credentials**；R13 Payment Activation Gate = HOLD。

## 1. 交付物

| 文件 | 内容 |
| --- | --- |
| `apps/api/src/services/settlement/receipt-snapshot.ts` | 唯一 server-side canonical builder + digest（`sha256(canonicalJson(business fields))`） |
| `apps/api/src/services/settlement/record-settlement.ts` | `recordSettlement`（受保护写路径）+ `createSettlementRecordDeps`（生产装配工厂） |
| `apps/api/src/services/action-guard/action-guard.ts` | 新条目 `settlement.record` = `INTERNAL_WRITE` + `['humanApproval']` |
| `apps/api/src/__tests__/settlement-receipt-snapshot.test.ts` | 12 项 canonical digest 向量 |
| `apps/api/src/__tests__/settlement-record-db.test.ts` | 12 项真实 PostgreSQL 验收 |

## 2. MSG-55 CHANGE 落实

- **CHANGE B（canonical digest 等价证明）**：digest 只能由 `receipt-snapshot.ts` 计算；测试覆盖 key 顺序不变、amount 表达规范化（1.5 / 1.500000 → 1.5000）、currency canonical（usd→USD）、UTC 时间规范化、evidence 稳定排序、identity+version 纳入 digest、**客户端 digest / 派生字段 → 拒绝**、可信字段变化 → 新 digest、非业务 metadata（`createdByUserId` / 原始 `externalIdentityValue`）→ digest 不变。
- **S2 最低永久验收（20 项）**：server-side snapshot+digest ✅ · 客户端自证 fail-closed ✅ · `settlement.record` INTERNAL_WRITE+humanApproval ✅ · approval 绑定完整 snapshot（`boundExtra.receiptSnapshotDigest`）✅ · 锁内 ACTIVE membership 复验 ✅ · 同租户 claimItem/case/evidence ✅ · 无可信 evidence → 零写入 ✅ · exact replay → REUSED ✅ · same identity + 冲突事实 → EVENT_IDENTITY_CONFLICT ✅ · different receipt → distinct ✅ · approval 漂移 → 拒绝 ✅ · 原子提交（Settlement+snapshot+audit+approval 消费）✅ · 审计/消费失败 → 整体回滚 ✅ · 并发同 receipt → 至多一条 ✅ · 不产生 FeeCalculation ✅ · 不产生 BillingInvoice ✅ · 不产生 Payment ✅ · 不改 RecoveryLedger ✅ · R45 projection/override 不得成为入口 ✅。

## 3. 关键设计

1. **审批恰好消费一次**：`AuditLog.id = 'settlement-approval-' + approvalId`（确定性主键，重复插入 → P2002 → `APPROVAL_ALREADY_CONSUMED` → 整体回滚），不新增 Schema。
2. **并发同 receipt**：唯一约束竞争，失败侧读回既有 Settlement，按幂等规则返回 `REUSED`（内部信号 `ReusedAfterRace` 回滚本事务写入）。
3. **零资金外溢**：写路径只触碰 `Settlement` / `SettlementReceiptSnapshot` / `AuditLog`，并有断言守护。

## 4. 证据

- `settlement-receipt-snapshot.test.ts` **12/12 PASS**（纯函数）
- `settlement-record-db.test.ts` **12/12 PASS**（真实 PostgreSQL）
- `action-guard` + catalog integrity **15/15 PASS**
- `tsc --noEmit` **0 error**
- CI：`cb6de0e` **success**；`9b8fbdc` / `784bef5` / `bf3419e` 已触发（结果见下一轮记录）

## 5. 边界与风险

- 本批次未实现 SettlementAdjustment / Fee / Invoice / Payment / Ledger 写入；未启用任何平台外写或生产凭据。
- 待办（S4 前）：MSG-55 CHANGE A —— fee-chain 真实并发竞争验收（独立连接，loser fail-closed，最终 membership 恰一）。
- 生产接线剩余一步：把 action-guard 的审批校验器注入 `createSettlementRecordDeps`（装配点）。

## 6. 请裁决（编号）

1. §2 的 CHANGE B 等价证明与 S2 最低永久验收 20 项是否满足 MSG-20261002-55？
2. §3 的「audit 主键确定性派生实现 approval 恰好一次」是否接受（未新增 Schema）？
3. 是否批准关闭 **R46 S2** 并进入 **R46 S3（SettlementAdjustment / reversal）**？

> 边界（重申）：NO automatic Settlement from R45 · NO automatic Fee · NO automatic Invoice issuance · NO Payment activation · NO autopay · NO platform write · TRANSPORT=false · NO production credentials；R13 Payment Activation Gate = HOLD。
