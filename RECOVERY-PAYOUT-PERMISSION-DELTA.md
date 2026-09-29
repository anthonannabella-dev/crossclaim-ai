# RECOVERY PAYOUT — PERMISSION DELTA

> 类型：**Permission Delta**（按 MSG-20260929-27 F2 = B 执行）
> PREVIOUS: MSG-20260929-26（Recovery Confirmation Delta GO）→ MSG-20260929-27（实现 PASS_CLOSE；F2 裁决 B）
> 分支 `gate/7-commercial-validation` · Codex · 2026-09-29

---

## 1. 新权限

| 键 | 含义 |
|---|---|
| `recoveryPayoutRecord` | 录入**到账事实**（`RecoveryPayout`）。这是资金事实登记，不是业务确认，也不是扣款授权 |

## 2. RBAC 映射

| 角色 | `recoveryPayoutRecord` | 理由 |
|---|---|---|
| OWNER | ✅ | 组织负责人 |
| ADMIN | ✅ | 运营管理 |
| FINANCE | ✅ | **到账登记属于财务事实录入**（MSG-20260929-27：FINANCE 无法登记会造成运营断层） |
| OPS | ❌ | 运营负责回执与平台反馈，不录入资金事实 |
| VIEWER | ❌ | 只读 |
| 未知角色 / 空值 | ❌ | **fail-closed**（`permissionsFor` 返回 `DENY_ALL`） |

## 3. 不改变的权限（明确边界）

| 动作 | 权限 | 角色 |
|---|---|---|
| 记录 Claim 提交 / 判定终局 | `claimTrackingApprove` | OWNER / ADMIN |
| 录入平台回执 / 平台案件号 | `claimTrackingReceive` | OWNER / ADMIN / OPS |
| **业务确认 Settlement** | `claimTrackingApprove`（不变） | OWNER / ADMIN |
| **建立冲回链** | `claimTrackingApprove`（不变） | OWNER / ADMIN |
| **录入 RecoveryPayout** | `recoveryPayoutRecord`（**本次新增**） | OWNER / ADMIN / FINANCE |

> 语义分离理由（MSG-20260929-27）：`Claim Tracking` 登记的是**外部事件**；
> `Recovery Confirmation` 登记的是**资金到账事实**。两者不再复用一个权限键。

## 4. 审计动作（未新增动作名，沿用已登记项）

| 动作 | 触发 |
|---|---|
| `recovery_payout.recorded` | 首次登记到账 |
| `recovery_payout.duplicate_ignored` | 命中 `(organizationId, payoutRef)` 幂等 |
| `settlement.reconciliation_changed` | 对账状态由事实推导后发生迁移 |

权限拒绝在**任何数据库访问之前**发生（`assertPermission` 先于 `loadSettlement`），
因此无权角色既不能写入，也无法通过错误码推断其他租户是否存在该 Settlement。

## 5. 明确不做

* 不改任何 API 端点、不改 Prisma Schema、不改迁移
* 不改金额口径（`FeeCalculation` / `RecoveryLedgerEntry` / `BillingInvoice` 零改动）
* 不启用自动扣佣 / 支付自动化（仍 HOLD）
* 不放开自动提交（仍 FORBIDDEN）

## 6. 验收

1. 权限矩阵单测：OWNER / ADMIN / FINANCE 为 true；OPS / VIEWER / 未知角色为 false（fail-closed）
2. fail-closed 用例：无权角色在触库前即被拒（断言未发生任何 `prisma` 调用）
3. 既有 Recovery Confirmation 数据库用例（10 项）全部继续通过
4. `prisma validate` / `tsc --noEmit` / 全量测试 / CI 三作业全绿
