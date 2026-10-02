-- ============================================================
-- CrossClaim — TRACK C2 / M1–M3（MSG-20261002-66 授权实施）
-- ------------------------------------------------------------
-- M1：显式 Platform 维度（保留 Channel 兼容层）
-- M2：PlatformAccount（business provenance identity；token 不入表）
-- M3：SourceConnection.platformAccountId（1 account → N connections）
-- 边界：不改 Payment；不启用 autopay；R13 HOLD；TRANSPORT=false。
-- ============================================================

CREATE TYPE "Platform" AS ENUM (
  'AMAZON','TIKTOK_SHOP','WALMART','SHOPIFY','STRIPE','PAYPAL','UPS','FEDEX','DHL','CUSTOMS','OTHER'
);

CREATE TABLE "PlatformAccount" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "platform" "Platform" NOT NULL,
  "externalAccountId" TEXT NOT NULL,
  "identityVersion" TEXT NOT NULL DEFAULT 'v1',
  "marketplace" TEXT,
  "region" TEXT,
  "displayName" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'NEEDS_AUTH',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PlatformAccount_pkey" PRIMARY KEY ("id")
);

-- organization-scoped identity（禁止全局 UNIQUE(platform, externalAccountId)）
CREATE UNIQUE INDEX "PlatformAccount_org_platform_external_key"
  ON "PlatformAccount" ("organizationId","platform","externalAccountId","identityVersion");
CREATE INDEX "PlatformAccount_org_platform_status_idx"
  ON "PlatformAccount" ("organizationId","platform","status");
ALTER TABLE "PlatformAccount" ADD CONSTRAINT "PlatformAccount_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SourceConnection" ADD COLUMN "platformAccountId" TEXT;
ALTER TABLE "SourceConnection" ADD CONSTRAINT "SourceConnection_platformAccountId_fkey"
  FOREIGN KEY ("platformAccountId") REFERENCES "PlatformAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "SourceConnection_org_platformaccount_idx"
  ON "SourceConnection" ("organizationId","platformAccountId");

-- ---------- 租户守卫 / 不可变 ----------
DROP TRIGGER IF EXISTS cc_tenant_platformaccount ON "PlatformAccount";
CREATE TRIGGER cc_tenant_platformaccount
  BEFORE INSERT OR UPDATE ON "PlatformAccount"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity();

DROP TRIGGER IF EXISTS "cc_tenant_immutable__PlatformAccount" ON "PlatformAccount";
CREATE TRIGGER "cc_tenant_immutable__PlatformAccount"
  BEFORE UPDATE ON "PlatformAccount"
  FOR EACH ROW EXECUTE FUNCTION cc_forbid_tenant_reassignment();

-- account FK 跨租户引用守卫
DROP TRIGGER IF EXISTS cc_tenant_sourceconnection_platformaccountid ON "SourceConnection";
CREATE TRIGGER cc_tenant_sourceconnection_platformaccountid
  BEFORE INSERT OR UPDATE ON "SourceConnection"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity('platformAccountId','PlatformAccount');

-- 迁移不使用任何 disable trigger；不做 label→account 的猜测式回填（M6：legacy 保持 unresolved）
