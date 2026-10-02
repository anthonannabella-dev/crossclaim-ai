# TRACK C2-A — Multi-Account Boundary · 实施计划与迁移草案（待裁决后执行）

状态：**PLAN_DRAFT（docs-only；未改 Schema、未写 migration）** · 依赖：架构方对 `TRACK-C2-BATCH1-AUDIT-GAP-MATRIX-AND-DELTA-REQUEST.md` §4 的裁决
依据：**MSG-20261002-65 ③**（TRACK C2 第一批 = 现状取证 → gap matrix → Schema Delta 决策请求；**不要直接修改 Schema**；唯一性采用 organization-scoped identity，禁止全局 `UNIQUE(platform, externalAccountId)`）
边界：Payment / autopay / collection / external write 全部 OFF；R13 HOLD；`TRANSPORT=false`；无生产凭据。

## 1. 目标（裁决通过后一次性完成的最小修复）

让「1 Organization → N Platform → 每平台 N Account → 每 Account N Connection → 事实/Claim/Evidence/Settlement」在**数据库层**可区分，且：

- 不同账户不合并事实（修复 `CanonicalFact.factKey` 无账户维度）；
- 授权/凭据生命周期按账户隔离（Store A 失效不影响 Store B）；
- Case/Claim/Evidence/Settlement 可归因到具体账户；
- 兼容历史行（不静默合并、不删除）。

## 2. 迁移步骤草案（单迁移，全部可空、向后兼容）

### M1 — `Platform` 枚举 + `PlatformAccount` 表

```sql
CREATE TYPE "Platform" AS ENUM ('AMAZON','TIKTOK_SHOP','WALMART','SHOPIFY','STRIPE','PAYPAL','UPS','FEDEX','DHL','CUSTOMS','OTHER');

CREATE TABLE "PlatformAccount" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL REFERENCES "Organization"("id") ON DELETE CASCADE,
  "platform" "Platform" NOT NULL,
  "externalAccountId" TEXT NOT NULL,
  "identityVersion" TEXT NOT NULL DEFAULT 'v1',
  "marketplace" TEXT,
  "region" TEXT,
  "displayName" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'NEEDS_AUTH',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

-- organization-scoped identity（**禁止**全局 UNIQUE(platform, externalAccountId)）
CREATE UNIQUE INDEX "PlatformAccount_org_platform_external_key"
  ON "PlatformAccount" ("organizationId", "platform", "externalAccountId", "identityVersion");
CREATE INDEX "PlatformAccount_org_platform_status_idx" ON "PlatformAccount" ("organizationId", "platform", "status");
```

> token/secret **不入此表**；凭据仍由 `SourceConnection.credentialRef` 承担（引用语义不变）。

### M2 — `SourceConnection.platformAccountId?`（一个 Store 多 Connection）

```sql
ALTER TABLE "SourceConnection" ADD COLUMN "platformAccountId" TEXT
  REFERENCES "PlatformAccount"("id") ON DELETE SET NULL;
CREATE INDEX "SourceConnection_org_platformaccount_idx" ON "SourceConnection" ("organizationId", "platformAccountId");
```

### M3 — account 维度下推（全部可空）

```sql
ALTER TABLE "SourceTransaction"           ADD COLUMN "accountId" TEXT REFERENCES "PlatformAccount"("id") ON DELETE SET NULL;
ALTER TABLE "CanonicalFact"               ADD COLUMN "accountId" TEXT REFERENCES "PlatformAccount"("id") ON DELETE SET NULL;
ALTER TABLE "RecoveryOpportunity"         ADD COLUMN "accountId" TEXT REFERENCES "PlatformAccount"("id") ON DELETE SET NULL;
ALTER TABLE "ClaimItem"                   ADD COLUMN "accountId" TEXT REFERENCES "PlatformAccount"("id") ON DELETE SET NULL;
ALTER TABLE "EvidenceArtifact"            ADD COLUMN "accountId" TEXT REFERENCES "PlatformAccount"("id") ON DELETE SET NULL;
```

服务端从连接上下文派生 `accountId`（`connection.platformAccountId`），**不接受客户端提交**。

### M4 — fact identity 账户作用域（关键修复）

```sql
-- 新索引：有账户维度时按 (org, account, factKey) 唯一
CREATE UNIQUE INDEX "CanonicalFact_org_account_factkey_key"
  ON "CanonicalFact" ("organizationId", "accountId", "factKey")
  WHERE "accountId" IS NOT NULL;
-- 旧索引保留给 legacy（accountId IS NULL）
-- 既有：CREATE UNIQUE INDEX "CanonicalFact_organizationId_factKey_key" ON ("organizationId","factKey")
--      需改为 partial：WHERE "accountId" IS NULL
```

`factKey` 语义升级为 `ACCOUNT{externalAccountId}|{TYPE}:{EXTERNALID}`（legacy 行保持旧格式）。

### M5 — 回填与 fail-closed 审计

1. 依据 `SourceTransaction.connectionId → SourceConnection.platformAccountId` 回填 `accountId`；
2. 对历史 `CanonicalFact`：能唯一推断账户则回填；推断不唯一或缺失 → **保持 NULL（legacy）**；
3. 迁移内置**重复审计**：`(organizationId, accountId, factKey)` 重复 → 输出冲突清单并 `RAISE EXCEPTION`（**禁止静默合并/删除**）；
4. 回填期间按需 `DISABLE TRIGGER USER` + 重新启用（沿用 S4-A 既有范式），并复核 append-only 与 tenant 清单。

### M6 — 不变量与清单

- 新触发器命名避开 `cc_tenant_*` / `cc_append_only__*` 前缀（沿用 S4-A 经验），除非同步更新两份 checklist；
- `PlatformAccount` 含 `organizationId` → 必须挂 `cc_tenant_immutable__PlatformAccount` 与租户守卫触发器，并同步 `tools/tenant-triggers/required-triggers.json`；
- `architecture-contract` 模型计数需同步（新增 1 个 core 模型）。

## 3. 服务层契约（与 DB 同步实施）

| 项 | 规则 |
| --- | --- |
| account 派生 | 仅由服务端从 `connection.platformAccountId` 派生；客户端提交 `accountId` → `CLIENT_ACCOUNT_FIELD_NOT_TRUSTED` |
| 授权隔离 | `transitionConnection` / `rotateCredentialRef` 按 connection 级；账户级状态由该账户下连接聚合派生 |
| claim/evidence/settlement 归因 | 创建时写入派生 `accountId`；跨账户引用 → `CROSS_ACCOUNT_REFERENCE` fail-closed |
| 幂等 | `dedupeKey`/`factKey` 均含账户维度（同 externalId 不同账户不合并） |

## 4. 验收（MSG-65 的 12 项，全部落在真实 PostgreSQL）

1. one org / two Amazon accounts；2. one org / Amazon + TikTok；3. same externalAccountId across two orgs → allowed/isolation；4. cross-account claim access → reject；5. cross-account evidence binding → reject；6. cross-account settlement linkage → reject；7. client account spoof → reject；8. revoked account 不能 ingest 新事实；9. reconnect/credential rotation 不重写历史 provenance；10. account-level concurrency/idempotency；11. organization-level aggregate view 仍可行；12. **R46 full regression 保持绿色**（当前基线 187 files / 1846 tests）。

已提前交付可验证部分（本批行为基线 7/7）：#3、#8、#9、#12 与提交状态投影；其余 8 项需 M1–M6 落地后补齐。

## 5. 风险与验证

- **迁移风险**：回填会触碰资金相关事实表 → 必须 fresh deploy + upgrade deploy 双路径验收（沿用 S4-A/S5-A 做法）；
- **不可静默合并**：任何重复/冲突必须 fail-closed 并输出清单；
- **回滚**：迁移全部为「加列/加表/加索引」，回滚 = 删除新索引/列/表（旧路径 `accountId IS NULL` 始终可用）；
- **回归门槛**：R46 S1–S6 的永久基线（fee/settlement/invoice/consistency checker）必须保持绿色。

## 6. 执行前置

1. 架构方批准 §4 方向（或指定替代方案）；
2. `identityVersion` 定义为外部身份格式的必填维度（默认 `v1`）；
3. 明确 migration 是否允许在回填阶段临时禁用 append-only/tenant 触发器（沿用 S4-A 已批准的同类做法）。
