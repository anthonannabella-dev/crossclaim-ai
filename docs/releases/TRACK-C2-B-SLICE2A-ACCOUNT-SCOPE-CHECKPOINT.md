# TRACK C2-B — slice 2a：account scope 下推 + 事实身份账户作用域（checkpoint）

状态：**PROGRESS（已实现 + 已验证；等待 C2 FINAL 一并送审）**
依据：MSG-20261002-66（TRACK C2 PASS WITH REVISE —— M1–M6 批准实施；M4 要求 account scope 下推到 SourceTransaction / CanonicalFact / RecoveryOpportunity / ClaimItem / EvidenceArtifact；M5 唯一性使用结构化字段 `(organizationId, platformAccountId, factKey)`，不得拼进 factKey；M6 回填 fail-closed；CHANGE A：account 绑定写一次；CHANGE B：禁用触发器仅限版本化迁移/隔离夹具 → 本次迁移**未使用任何 DISABLE TRIGGER**）
边界：NO platform write · Payment = 0 · collection / autopay / external payment write OFF · R13 HOLD · `TRANSPORT=false` · 无生产凭据。

## 1. 交付

### 1.1 Schema（`apps/api/prisma/schema.prisma`）

- `SourceTransaction.accountId?` / `CanonicalFact.accountId?` / `RecoveryOpportunity.accountId?` / `ClaimItem.accountId?` / `EvidenceArtifact.accountId?`（全部可空、向后兼容，FK → `PlatformAccount` `ON DELETE SET NULL`）。
- `CanonicalFact` 身份改为 `@@unique([organizationId, accountId, factKey])`（原 `(organizationId, factKey)` 唯一键由迁移替换为 legacy partial unique）。
- 每张表新增 `@@index([organizationId, accountId])`；`PlatformAccount` 增加五张表反向关系。

### 1.2 迁移（`20261002060000_account_scope_downstream`）

顺序即不变量（CHANGE B：不依赖禁用触发器）：

1. 加列 + FK + `(organizationId, accountId)` 索引；
2. `SourceTransaction.accountId ← SourceConnection.platformAccountId`（服务端连接上下文，唯一可信来源）；
3. `CanonicalFact.accountId ← 其来源行 accountId`（**唯一且完全一致**才推断；含 NULL 来源或跨账户来源 → 保持 NULL）；
4. blocker report：`RAISE NOTICE ACCOUNT_SCOPE_BACKFILL_BLOCKER count=… ids=…`（不猜测身份）；
5. fail-closed 重复审计：`ACCOUNT_SCOPE_DUPLICATE_FOUND` / `LEGACY_FACT_DUPLICATE_FOUND` → 迁移失败；
6. `DROP INDEX CanonicalFact_organizationId_factKey_key` → 新建 `CanonicalFact_organizationId_accountId_factKey_key` + legacy partial unique `CanonicalFact_org_factkey_legacy_key … WHERE accountId IS NULL`；
7. `cc_forbid_account_binding_change()` + 6 条 `cc_account_binding_immutable__*`（SourceConnection.platformAccountId、五张表的 accountId）：绑定后改写 → `ACCOUNT_BINDING_IMMUTABLE`；
8. 5 条 `cc_tenant_*_accountid` 跨租户守卫（`crossclaim_assert_tenant_integrity`）。

### 1.3 服务层

- `services/ingest/prisma-repository.ts`：`loadAccountScope()` 只从**当前 organization 的连接**读取 account 并写入 `SourceTransaction.accountId`；draft 中出现 `accountId` → `CLIENT_ACCOUNT_FIELD_NOT_TRUSTED`。
- `services/reconciliation/reconcile.ts`：`accountScopedKeyOf()` —— 分组/冲突检测在 account 作用域内进行（不同 account 的同一 externalId 是两条事实，既不合并也不互判冲突）；`factKey` 语义不变。
- `services/canonical/derive.ts` / `writer.ts`：`DerivedFact.accountId`；`loadRelatedRows` 仍按 `(referenceType, externalId)` 加载（与既有实现同形），作用域相等在**内存**判定（避免 relation OR 让批量导入退化）；`persistCanonicalFact()` = find-first + create，P2002 时重读同一事实再更新（并发下最多一行；DB 唯一索引才是 correctness source）。
- `services/reconciliation/prisma-repository.ts`：投影带 `accountId`（优先持久化值，回退连接上下文）。

### 1.4 清单纯同步

- `tools/tenant-triggers/required-triggers.json`：73 → **78** 条 baseline（新增 5 条 accountId 跨租户守卫）。
- `DOMAIN_MODEL.md`：新增「多账户作用域（TRACK C2）」小节。

## 2. 验收证据

| 项 | 结果 |
|---|---|
| `c2-account-scope-db`（真实 PostgreSQL，8 项） | **8/8 PASS** —— 同 org 两账户同 externalId → 两条独立 ACTIVE 事实；客户端提交 accountId → 拒绝且零落库；历史行回退派生；跨租户 account 引用（SourceTransaction / CanonicalFact / ClaimItem）被拒；account 绑定写一次（SourceTransaction + SourceConnection）；legacy 仍按 `(org, factKey)` 唯一且允许同 factKey 落在不同 account；同 externalAccountId 跨 org 允许且事实隔离；凭据轮换不产生新 account identity |
| 既有 canonical / reconciliation 家族 | 39/39 PASS（含 identity-step2 / identity-backfill / shadow / parity / fact-db） |
| 批量导入回归（1 万行） | `ingest-bulk-db` 3/3 PASS（68s / 22s / 11s；期间修复 relation-OR 导致的写法退化） |
| 全量回归 | **188 files / 1854 tests PASS** |
| `tsc --noEmit` | 0 error |
| `prisma validate` | valid |
| upgrade deploy（本地库） | PASS（42 → 43 migrations） |
| fresh deploy（临时库全量迁移） | PASS —— 5 张表 `accountId`、结构化唯一 + legacy partial unique、6 条绑定不可变触发器（tgtype 19）、5 条跨租户守卫（tgtype 23）全部在位；tenant 与 append-only 清单门禁 PASS |

## 3. 未完成（留给 slice 2b → C2 FINAL）

- `RecoveryOpportunity` / `ClaimItem` / `EvidenceArtifact` 的 **服务端写入接线**（从 case/claim/evidence 生成路径派生 accountId）与 cross-account claim / evidence / settlement 拒绝语义。
- C2 12 项最低验收中依赖上述接线的条目（跨账户 claim / evidence / settlement 混合 → reject；account 级并发幂等；org 级聚合视图）。
- account identity immutable 已有 DB 不变量；`credentialVersion ≠ identityVersion` 需在 slice 2b 补文档 + 测试断言。

> 本切片未改 Payment / RecoveryLedger / autopay / R13；未触碰 R46 财务链语义。
