# MULTI-PLATFORM / MULTI-ACCOUNT — 架构审计 + 最小 Schema Delta Proposal（TRACK C2）

状态：**AUDIT_DONE + PROPOSAL_SUBMITTED（未实施）** · 来源：**HOST PRODUCT ARCHITECTURE REQUIREMENT（Multi-Platform / Multi-Account）** · 执行顺序：HOST 指定 STEP 1 → STEP 2 → STEP 3
边界：本轮**未改 Schema、未写迁移、未实现任何同步模块**；Payment / autopay / payment collection / external payment write 继续 OFF；R13 Payment Activation = HOLD；`TRANSPORT=false`；无生产凭据。

## 1. 目标模型（HOST）

```
User → Organization → Platform → Platform Account / Store → SourceConnection(s)
     → SourceTransaction / CanonicalFact → RecoveryOpportunity → Case → Claim → Settlement / RecoveryPayout
```

一条 Organization 下：N 个平台 × 每平台 N 个账户/店铺 × 每账户 N 条连接；授权、失败、重连按 **Account/Store** 隔离；Case / Dashboard 可按 Organization → Platform → Account → Recovery Type 汇总额。

## 2. STEP 1 —— 现状审计（逐层支持矩阵）

| 层 | 现有实现 | 是否支持「1 Org → N 平台 → 每平台 N 账户 → 每账户 N 连接」 |
| --- | --- | --- |
| Organization | `Organization` | ✅ |
| Platform | `Channel` 枚举（AMAZON_FBA / AMAZON_OTHER / UPS / FEDEX / DHL / … / OTHER） | ⚠️ 部分：枚举混装「平台」与「平台内用途」，且缺 TIKTOK_SHOP / WALMART / SHOPIFY / STRIPE / PAYPAL / CUSTOMS |
| Platform Account / Store | **无实体** | ❌ 只能用 `SourceConnection.label` 近似 |
| SourceConnection | `organizationId / domain / channel / kind / status / label / credentialRef / config / lastSyncAt / lastError`，`@@unique([organizationId, channel, label])` | ⚠️ 一个 Store 可挂多条连接（靠 label 区分），但**无 account/store 归属列**、无 external account id / marketplace |
| SourceTransaction | `dedupeKey = sha256(organizationId\|connectionId\|referenceType\|externalId\|rowFingerprint)`，`@@unique([organizationId, dedupeKey])` | ✅ 带 connectionId（账户隔离）；⚠️ `connectionId` 可空 → 回退为 org 级 |
| CanonicalFact | `factKey = REFERENCETYPE:EXTERNALID`，`@@unique([organizationId, factKey])` | ❌ **无账户维度** |
| RecoveryOpportunity | `organizationId + domain + channel` | ⚠️ 无 account 归因（无法做 per-store 小计） |
| Case / Claim / Settlement | 经 opportunity 关联 | ⚠️ 同样缺 account 维度（链路可追溯但无法归到具体账户） |

## 3. STEP 2 —— 焦点核查（会否「不同账号串数据」）

**结论：会。** 证据（仓库实际代码）：

1. `apps/api/src/services/reconciliation/reconcile.ts`（`factKeyOf`）：
   ```ts
   export function factKeyOf(transaction: FactSourceTransaction): string | null {
     const externalId = transaction.externalId?.trim();
     const referenceType = transaction.referenceType?.trim();
     if (!externalId) return null;
     const type = referenceType ? referenceType.toUpperCase() : 'UNKNOWN';
     return `${type}:${externalId.toUpperCase()}`;
   }
   ```
   → fact 身份**只有 referenceType + externalId**，不含 connection / account。
2. `apps/api/prisma/schema.prisma`：`CanonicalFact @@unique([organizationId, factKey])`；`apps/api/src/services/canonical/writer.ts:145` 以 `organizationId_factKey` upsert。
   → 同一 Organization 下 Amazon US Store A 与 Store B 都上报 `INVOICE:INV-1001` 时，会被判定为**同一条 canonical fact**并被合并/冲突仲裁，**跨账户串数据**。
3. `SourceTransaction.dedupeKey` 已含 `connectionId`，但该列可空且逻辑允许为空 → 无连接来源的行在更早一层同样 org 级合并。
4. `SourceConnection @@unique([organizationId, channel, label])`：`label` 是**展示名**，用户改名即失去稳定身份，无法承载 external account id / store id / seller id / marketplace·region / 账户所有权 / 生命周期。

即：现状**无法稳定表达** HOST 列出的 external account ID、store ID、seller ID、marketplace/region、account ownership、一个 Store 多 Connection、同平台多 Store、Store 生命周期。

## 4. STEP 3 —— 判定与处置

现有模型**不足**（非「已足够，仅记录设计」的分支）→ 按 HOST 指令提交**最小 Schema Delta Proposal**，**不实施**；Schema 变化按项目规则必须先回架构方裁决。

## 5. 最小 Schema Delta Proposal（供裁决；全部可空、向后兼容、不重写现有表）

1. **新枚举 `Platform`**：`AMAZON` · `TIKTOK_SHOP` · `WALMART` · `SHOPIFY` · `STRIPE` · `PAYPAL` · `UPS` · `FEDEX` · `DHL` · `CUSTOMS` · `OTHER`。保留 `Channel` 不动（避免大规模重写）；`Platform` 先只用于账户身份。
2. **新表 `PlatformAccount`（Store）**：`id` · `organizationId` · `platform` · `externalAccountId` · `marketplace?` · `region?` · `displayName` · `status`（ACTIVE / NEEDS_AUTH / DISABLED / REVOKED）· `createdAt` · `updatedAt` · `@@unique([organizationId, platform, externalAccountId])` · `@@index([organizationId, platform, status])`。
   - **token / secret 不入此表**（继续由 `SourceConnection.credentialRef` 承载）。
   - `displayName` 仅展示；身份由 `(organizationId, platform, externalAccountId)` 决定。
3. **`SourceConnection.platformAccountId String?`**（+ 索引）：一个 Store 可挂多条连接（Orders / Settlement / Inventory / Returns / File Upload / Email ingestion；Shopify + Stripe/PayPal 亦然）。
4. **账户作用域下推**：`SourceTransaction.accountId String?`、`CanonicalFact.accountId String?`、`RecoveryOpportunity.accountId String?`（均由 connection → account 服务端派生，客户端不得自证）。
5. **fact identity 升级（关键）**：`factKey` 语义升级为含账户维度的 `ACCOUNT{externalAccountId}|{type}:{externalId}`；唯一约束改为 `@@unique([organizationId, accountId, factKey])`；**legacy 行保留旧格式与旧唯一索引**（partial unique：`WHERE accountId IS NOT NULL` ≠ 旧索引 `WHERE accountId IS NULL`），保证「不同账户不再合并」且历史行仍可读。
6. **回填与 fail-closed**：迁移内置重复审计（发现同 org 同 factKey 但 account 不同 → 输出冲突清单并要求人工裁决，**禁止静默合并/删除**）；无法推断账户的历史行保持 `accountId = NULL`（legacy unscoped）；**新写入路径强制要求 account 维度**。
7. **授权/失败隔离**：`PlatformAccount.status` 与 `SourceConnection.status` 分层；token revoke/expire/rotate/reconnect 只影响该 Connection，账户级状态由该账户下连接状态聚合派生（不改现有连接表语义）。

### 明确不做（与 HOST「禁止」一致）

不打断当前 Recovery 主线 · 不批量重写 Prisma Schema · 不为每个平台写并行系统 · 不实现全量同步模块 · token/secret 不入 `PlatformAccount` · 不用 label 当身份 · 不把不同账户的数据合并进同一 CanonicalFact · 当前不引入 Enterprise RBAC · 当前不做组织多租户重构 · 不开放 Production API / external write。

## 6. 验收场景（10 项 → 未来永久回归基线）

1. 一个 Organization 同时接入 Amazon + TikTok + Shopify + UPS；
2. 同一平台下两个不同 Seller Account 独立存在；
3. 两个 Amazon 账户上报相同 `orderId` → **不得合并**（dedupe/fact 均隔离）；
4. 一个 Store 挂多条 SourceConnection；
5. Store A 授权 revoke 不影响 Store B；
6. 某条 Connection 凭据轮换/重连不影响同账户其它 Connection 的既有事实；
7. Opportunity / Case 可追溯至具体 Account 与 Connection；
8. Platform 小计 = 该平台各 Account 小计之和；
9. Account 停用/删除不破坏历史 Recovery 追溯（append-only facts 仍可归属）；
10. 跨租户严格 fail-closed。

## 7. 排期与边界

| 项 | 状态 |
| --- | --- |
| STEP 1 现状审计 | ✅ 已完成（§2） |
| STEP 2 焦点核查 | ✅ 已完成（§3，发现跨账户合并缺陷） |
| STEP 3 判定 | ✅ 模型不足 → 提交最小 Schema Delta Proposal（§5） |
| 提案裁决 | ⏳ 待架构方（Schema 变化必须审计） |
| 实施 | ⛔ 未开始；主线（R46 → Full Regression）不受影响 |

边界不变：`Payment activation = OFF` · `autopay = OFF` · `payment collection = OFF` · `external payment write = OFF` · R13 Payment Activation = HOLD · `TRANSPORT = false` · 无生产凭据。

计费口径（HOST 指定）：继续按 **Recovery Outcome**（平台/物流 = Success Fee；Customs = Free Audit → Paid Claim-Ready Package），**不引入 per-seat / per-store 订阅**，多账户不重复收费。

权限（HOST 指定）：当前继续以 Organization 为租户边界（OWNER / ADMIN / OPS / FINANCE / VIEWER）；`platformAccountId` 的预留**不实现** account-scoped ACL，仅为未来「员工 A 仅可见 Amazon US Store A」留出挂点。
