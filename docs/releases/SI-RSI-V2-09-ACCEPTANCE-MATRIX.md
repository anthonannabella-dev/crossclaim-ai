# SI-RSI V2-09 — 验收矩阵 v2（修复后重述，锚点分离）

> 授权：审计 `MSG-20261010-53`（`PASS_WITH_REVISE`，`NEXT_AUTHORIZED=V2_R1_SCOPED_SECURITY_AND_CONTRACT_REPAIR`）。
> 本版替代 v1；**v1 的问题正是"把测试级 PASS 写成总体 PASS、且只有一个 HEAD 锚点"**，本版逐条改正。

## 0. 三个锚点必须分开（CHANGE 09）

| 锚点 | 含义 | 取值 |
| --- | --- | --- |
| `REVIEW_HEAD` | 第一轮送审、被审计方核验过的版本 | `1caad401` |
| `ARCHIVE_HEAD` | 裁决逐字归档（`FULL_COPY_OK` 235/235） | `bfa109ca` |
| `CODE_HEAD` | 本轮 CHANGE 01–08 修复后的代码版本 | `acd05d16` |
| `EVIDENCE_HEAD` | 本矩阵与测试证据采集时的版本（= 文档提交父提交） | `acd05d16` |

**注意**：`REVIEW_HEAD ≠ CODE_HEAD`。第二轮送审应以 `CODE_HEAD` 之后的固定提交为准，且必须重新采集证据，不得沿用第一轮的测试数字。

## 1. CHANGE 01–09 修复状态

| 编号 | 严重度 | 状态 | 证据 |
| --- | --- | --- | --- |
| 01 C4 非 ELIGIBLE 时金额泄露 | P0 | **FIXED** | 披露条件改为 `C4=ELIGIBLE && C5=ESTIMATED`；`AMOUNT_WITHHELD_PENDING_ELIGIBILITY`；C4 三态 × C5 全状态组合矩阵 9 组 |
| 02 权益发放未绑定验签证据 | P0 | **FIXED** | 新增 `VerifiedPaymentEvidence`（私有 Symbol 品牌 + 运行时兜底）；发放拒绝裸对象；发放前复核报价有效期 |
| 03 COLLECTED 缺可信交易事实 | P0 | **FIXED** | 新增 `VerifiedFeeCollectionFact`（交易号+应收归属+商户+可信来源四项核验）；`historicalCollectedAmount` / `collectionAuthorizedForFuture` 分离历史与未来授权 |
| 04 全出口覆盖非结构性封闭 | P1 | **FIXED** | 包装弃用 `Object.create(provider)`（原型逃逸），改最小权限对象；`collectProviderFunctionExits` 遍历实例/原型/符号出口；未声明出口抛 `CustomsProviderUndeclaredExitError`；静态扫描补方括号动态访问 |
| 05 Gate 空值放行 | P1 | **FIXED** | `quoteValidUntil` 缺失 → `PROVIDER_QUOTE_VALIDITY_REQUIRED`；`opportunityId` 缺失 → `OPPORTUNITY_REFERENCE_REQUIRED`；归属未知 → `OPPORTUNITY_OWNERSHIP_UNKNOWN` |
| 06 幂等无事务级保证 | P1 | **BLOCKED** | 见 §3：需 PostgreSQL 实例；**不假装完成** |
| 07 部分到账语义 + 费率可覆盖 | P1 | **FIXED** | 部分到账改用 `PARTIAL_COLLECTION`（不再冒充冲正）；移除 `rateBps` 输入，改为注入版本化 `FeePolicy`，缺失/无费率/币种不符一律不产生应收 |
| 08 Pack 租户与身份未交叉验证 | P1 | **FIXED** | 强制四重一致：事实租户=任务租户、机会归属=事实租户、案件身份=任务声明（`TASK_OPPORTUNITY_REF_MISSING` / `CASE_IDENTITY_MISMATCH` 等独立原因码） |
| 09 矩阵与完成状态未对齐 | P1 | **FIXED** | 本文件即修复产物：三锚点分离 + 测试级/系统级分行 + BLOCKED 单列 |

## 2. 验收矩阵 v2（测试级 / 系统级分列）

**测试级 PASS = 在本机对纯函数与断言执行的单元测试通过。它不等于系统集成级通过。**

| # | 验收项 | 测试级 | 系统集成级 | 证据 |
| --- | --- | --- | --- | --- |
| 1 | 免费发现与六态投影 | PASS | NOT_VERIFIED | `customs-opportunity-unlock-state.test.ts` 20 项（含组合矩阵） |
| 2 | 无真实金额时付费入口不可见 | PASS | NOT_VERIFIED | 同上：`unlockEntryVisible=false` 且金额为空 |
| 3 | 五语言文案一致性 | PASS（类型级） | NOT_VERIFIED | `Record<Locale,…>`；`apps/web tsc --noEmit` 0 error |
| 4 | 报价/付款/权益/授权状态 | PASS | BLOCKED（真实 webhook） | `customs-unlock-payment.test.ts` 26 项（全部走真实验签路径构造证据） |
| 5 | 账户隔离与越权访问 | PASS | NOT_RUN（DB 级） | Gate/投影/Pack 跨租户拒绝；DB 租户隔离套件需 PostgreSQL |
| 6 | Profit Gate 正确阻断 | PASS | NOT_VERIFIED | `customs-profit-gate.test.ts` 21 项 |
| 7 | ONE SI Runtime 唯一路径 | PASS | NOT_WIRED | Pack 复用既有合同；`createsRuntime=false` |
| 8 | 任务幂等 / 并发领取 | PASS（幂等判定） | **BLOCKED**（并发） | 见 §3 |
| 9 | Provider 失败/超时/重试/对账 | PASS（判定层） | NOT_VERIFIED | 执行链 19 项 |
| 10 | 证据可信性与结算事实 | PASS（判定层） | NOT_VERIFIED | 执行链 + 成功费 22 项 |
| 11 | 15% 准确性与重复计费保护 | PASS | NOT_VERIFIED | 成功费 22 项 + 既有 guard 18 项 |
| 12 | Kill Switch / 审批门禁 / 外写 HOLD | PASS | NOT_VERIFIED | 四处独立分支 + 双门禁 |
| 13 | 前后端集成与浏览器断点 | **BLOCKED** | BLOCKED | 无 PostgreSQL / 未起链路 |
| 14 | 迁移兼容与回滚 | **NOT_APPLICABLE** | NOT_APPLICABLE | `git diff --name-only c6e03c51..CODE_HEAD` 中 prisma/migration 命中 0 |

## 3. BLOCKED 项与解锁条件（CHANGE 06 / 08 并发 / 13）

| BLOCKED 项 | 为什么不能在本机完成 | 解锁条件 |
| --- | --- | --- |
| CHANGE 06 事务级幂等 | 现有实现用集合判定重复,无法证明"两个并发请求同时读到旧集合后分别通过" | 提供 PostgreSQL 16 实例 → 用唯一约束/原子事务实现并以并发重放测试验证(相同支付事件/报价/结算/交易各一组) |
| 并发领取 | 租约 CAS 需要真实数据库事务 | 同上 |
| 浏览器 E2E / 多设备视觉 | 无 DB、未起前后端链路 | 隔离环境 + PostgreSQL + 允许启动本地服务 |

**纪律**：以上三项在解锁前一律保持 `BLOCKED`,不得以内存集合模拟或截图缺失代替。

## 4. 证据采集（`EVIDENCE_HEAD=acd05d16`，本机真实执行）

```powershell
cd D:/crossclaim-ai/apps/api
npx vitest run src/__tests__/customs-paid-api-gate.test.ts src/__tests__/customs-paid-provider-composition.test.ts `
  src/__tests__/customs-opportunity-unlock-state.test.ts src/__tests__/customs-profit-gate.test.ts `
  src/__tests__/customs-unlock-payment.test.ts src/__tests__/customs-execution-chain.test.ts `
  src/__tests__/customs-unlock-si-pack.test.ts src/__tests__/customs-success-fee-collection.test.ts `
  src/__tests__/customs-success-fee-guard.test.ts
# → Test Files 9 passed (9) · Tests 186 passed (186)
npx tsc --noEmit          # apps/api → 0 error
cd ../web; npx tsc --noEmit   # apps/web → 0 error
```

## 5. 仍需 HOLD 的边界（不得因修复而松动）

```text
AUTO_COLLECTION=HOLD · REAL_PROVIDER_WRITE=HOLD · PACK_REGISTRATION=NOT_AUTHORIZED
ENTITLEMENT_AWARE_CTA=NOT_IMPLEMENTED · CHECKOUT_REDIRECT=NOT_IMPLEMENTED
PRODUCTION_READY=NO · U1_REOPEN=NO · U2_DESIGN_R21=NOT_REOPENED · SECOND_RUNTIME=NO
```
