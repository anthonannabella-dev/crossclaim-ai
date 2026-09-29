# RECOVERY CONFIRMATION — IMPLEMENTATION CHECKPOINT

> TYPE: **IMPLEMENTATION CHECKPOINT**（按 MSG-20260929-26 = GO / READY_FOR_IMPLEMENTATION 执行）
> PREVIOUS: MSG-20260929-22（DESIGN GO）→ MSG-20260929-24（REVISE）→ **MSG-20260929-26（R2 GO）**
> 分支 `gate/7-commercial-validation` · Codex · 2026-09-29 · 不含任何资金动作（D5 HOLD）

---

## 1. 已执行的 Schema Delta（严格按 MSG-20260929-26 批准范围）

迁移文件：`apps/api/prisma/migrations/20260929080000_recovery_confirmation_delta/migration.sql`

| # | 变更 | 结果 |
|---|---|---|
| R1a | `Settlement.confirmationStatus`（枚举 `SettlementConfirmationStatus` = CONFIRMED / PENDING_CONFIRMATION / REJECTED_BY_REVIEW），默认 `CONFIRMED` | 已执行 |
| R1b | `Settlement.reconciliationStatus`（枚举 `SettlementReconciliationStatus` = NOT_STARTED / PARTIAL / RECONCILED / DISPUTED / REVERSED），默认 `NOT_STARTED` | 已执行 |
| R2a | `Settlement.confirmedByUserId String?`（业务确认留痕） | 已执行 |
| R2b | `Settlement.confirmedAt` | **未新增**：该列在既有 schema 中已存在（`confirmedAt DateTime?`，由 `confirmRecoveryOutcome` 写入）。新增会形成第二个时间事实源，故复用。 |
| R4 | `Settlement.reversedBySettlementId String?` + 自引用外键（`ON DELETE SET NULL`） | 已执行 |
| D1/R3 | 新表 `RecoveryPayout`（organizationId / settlementId / payoutRef / amount / currency / receivedAt / sourceType / createdBy / createdAt） | 已执行 |
| R5 | `Settlement(organizationId, confirmationStatus)`、`Settlement(organizationId, reconciliationStatus)`、`RecoveryPayout(organizationId, payoutRef) UNIQUE`、`RecoveryPayout(organizationId, receivedAt)`、`RecoveryPayout(organizationId, settlementId)` | 已执行 |
| 契约 | `RecoveryPayout @@unique([organizationId, id])` | **新增 1 个唯一索引**（见下「偏离说明」） |
| 触发器 | 不新增 / 不修改 | 已遵守：迁移后仍为 **27** 个 `cc_tenant%` |

### 偏离说明（两项，均为既有契约所要求，未改变任何被批准语义）

1. **R2b 不再新增列**：`confirmedAt` 已存在，重复新增会产生两个时间事实源（与 C3「不产生第二份事实来源」同理）。
2. **多发 1 个索引**（`RecoveryPayout @@unique([organizationId, id])`）：仓库既有 `C-0002 CHANGE #2` 契约要求**每个 tenant-owned 表**都具备 `(organizationId, id)` 复合唯一键，架构契约测试对此有硬断言。功能索引（5 个）与此前批准清单完全一致。

---

## 2. 服务层实现

`apps/api/src/services/recovery/recovery-confirmation.ts`（新增）

| 导出 | 作用 | 关键不变量 |
|---|---|---|
| `projectRecoveryState` / `reconciliationFromPayouts` | 纯函数投影：`received = Σ payouts`，`confirmed = Settlement.amount` | I2 / I3 / I4；`REVERSED` 为终局，不被后续到账静默覆盖（I7） |
| `normalizePayoutInput` | 录入归一化与校验（payoutRef、十进制金额、币种、receivedAt、sourceType 白名单） | 禁自由文本扩散 |
| `recordRecoveryPayout` | 登记到账事实（唯一来源） | I1 同租户、I6 `(organizationId, payoutRef)` 幂等、币种一致、`REJECTED_BY_REVIEW` / 已冲回拒绝 |
| `recordRecoveryConfirmation` | 业务确认轴迁移（CAS + 审计 + 留痕） | 与到账轴完全解耦 |
| `linkReversal` | R4 冲回链（只改状态与链路） | I7：**不改金额**；已绑定不可重复/不可回退 |
| `readProjection` | 读侧投影（含 payouts 明细） | `receivedAmount` 不落库 |

明确不做：不自动扣佣（D5 HOLD）、不自动改账单（D3）、不接支付通道、不修改 `FeeCalculation` / `RecoveryLedgerEntry` / `BillingInvoice`、不发起任何对外请求。

---

## 3. 验证证据（本地真实 PostgreSQL 16 + 全新库）

```
$ npx prisma validate              → The schema at prisma\schema.prisma is valid 🚀
$ npx prisma migrate deploy（全新库） → All migrations have been successfully applied.（18 条）
$ select count(*) ... cc_tenant%    → 27            ← 触发器数量未变
$ npx tsc --noEmit                  → 通过（无输出）
$ npx vitest run                    → 92 files / 838 tests passed
$ node tools/api-contract/check-routes.mjs     → API_CONTRACT_OK（implemented=36 documented=37）
$ node tools/audit-coverage/check-audit-actions.mjs → AUDIT_COVERAGE_OK（code=72 documented=64）
```

新增用例：

* 离线 `src/__tests__/recovery-confirmation.test.ts` — **16/16**（语义拆分、投影、录入校验、权限 fail-closed）
* 数据库 `src/__tests__/recovery-confirmation-db.test.ts` — **10/10**（真实 PostgreSQL）
  1. 历史 Settlement 默认 `CONFIRMED + NOT_STARTED`
  2. 跨租户登记被拒（I1）
  3. 部分到账 → `PARTIAL`，`Settlement.amount` 不变
  4. 重复 `payoutRef` 不重复累加（I6）
  5. 多期到账至全额 → `RECONCILED`
  6. 超额到账 → `DISPUTED`，金额不自动放大（D3）
  7. 冲回链可追溯、原金额不可改、冲回后禁再登记到账（I7）
  8. 确认轴与到账轴互不覆盖
  9. 投影读侧明细可追溯、`receivedAmount` 不落库
  10. 审计留痕（登记 / 幂等 / 对账变化）

> 过程中发现并修复的真实缺陷：`recordRecoveryPayout` 首次实现返回了**落库值**而非**投影值**，
> 导致超额场景对外返回 `RECONCILED`、正常场景返回 `NOT_STARTED`。由数据库级用例捕获，
> 现已改为返回 `derivedReconciliationStatus`（事实优先，落库值可能滞后）。

---

## 4. 待架构方裁决的两项（已按现行批准范围实现，未擅自扩权）

### F1（安全 / 租户完整性）—— 建议追加 Delta

`RecoveryPayout` 属 tenant-owned 且跨表引用 `Settlement`，按既有 `C-0002 CHANGE #3` 的规则
（「每个有跨表引用的 tenant-owned 表都必须挂租户校验触发器」）本应新增 `cc_tenant_RecoveryPayout`。
但 MSG-20260929-26 明确批准「**不新增触发器 / 仍 27**」，故本次**未**新增，租户一致性由服务层
（`loadSettlement` 按 organizationId 过滤 + 写入只用该 Settlement 的 id）保证，并有 I1 用例覆盖。

**请裁决**：

* (A) 追加一次小 Delta：新增 `cc_tenant_RecoveryPayout`（触发器数 27 → 28，并同步 CI 断言）；或
* (B) 接受服务层保证，并在 `ARCHITECTURE_CONTRACT.md` 明示该例外。

> 现状风险：应用层之外的直接写库（如运维手写 SQL）可绕过同租户校验；应用路径已封住。

### F2（授权语义）—— 希望明确到账登记的权限归属

本 Delta 被批准为「不改权限矩阵」，因此到账登记的权限从既有键中选取：

* `recordRecoveryPayout` → `claimTrackingReceive`（MSG-20260929-25 定义为「登记到账相关事件（非财务确认）」，OWNER/ADMIN/OPS）
* `recordRecoveryConfirmation` / `linkReversal` → `claimTrackingApprove`（OWNER/ADMIN）

**注意**：按该映射，`FINANCE` 无法登记到账（`claimTrackingReceive` 对 FINANCE 为 false）。

**请裁决**：

* (A) 维持现状（到账登记属运营动作）；或
* (B) 允许新增专用键（如 `recoveryPayoutRecord` = OWNER/ADMIN/FINANCE）并保持 fail-closed；或
* (C) 指定复用既有键（例如 `advanceBilling`）。

---

## 5. 边界确认（未变）

* 自动提交 Claim/Appeal：**FORBIDDEN**（本次未改任何提交路径）
* 自动扣佣 / 支付自动化：**HOLD**（D5）
* 冲回自动改账单：**禁止**（D3；只留审计与对账状态）
* 平台轮询 / 规则引擎：**HOLD**
* 金额口径：`FeeCalculation` / `RecoveryLedgerEntry` / `BillingInvoice` **零改动**
* 真实平台/真实数据：`REAL_DATA_VALIDATION_PENDING`（见 `REAL-DATA-VALIDATION-BACKLOG.md`）
