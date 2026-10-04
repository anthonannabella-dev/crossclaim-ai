-- C18 provider persistence（SCHEMA DELTA A/B，依据 MSG-20261004-24 授权生成）
-- 生成方式：prisma migrate diff（live DB → datamodel）后**只保留 C18 相关语句**，
-- 因为本地 dev DB 存在与 C18 无关的历史 drift；随后手工追加 DB 级不变量（CHECK / trigger）。
-- 声明：本文件为 create-only，**未执行**（migrate deploy = NOT RUN，migration applied = NO）。
-- 内容全部为新增对象：3 个 enum、3 张表、7 个索引、3 个外键，无 DROP、无 ALTER 既有业务真值。

-- CreateEnum
CREATE TYPE "CustomsProviderRelationship" AS ENUM ('CROSSCLAIM_SAAS', 'BROKER_OF_RECORD', 'CLIENT_DIRECT', 'REFERRAL_PARTNER');

-- CreateEnum
CREATE TYPE "CustomsProviderBindingStatus" AS ENUM ('ACTIVE', 'PENDING_VERIFICATION', 'SUSPENDED', 'REVOKED');

-- CreateEnum
CREATE TYPE "CustomsProviderBindingEvent" AS ENUM ('BOUND', 'REBOUND', 'REAUTH_REQUIRED', 'SUSPENDED', 'REVOKED', 'RESTORED');

-- CreateTable
CREATE TABLE "CustomsProviderTenantBinding" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "principalRef" TEXT NOT NULL,
    "bindingScopeVersion" TEXT NOT NULL DEFAULT 'v1',
    "jurisdictionAnchor" TEXT NOT NULL,
    "bindingSlotRef" TEXT NOT NULL,
    "bindingScopeKey" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "providerTenantRef" TEXT NOT NULL,
    "providerAccountRef" TEXT NOT NULL,
    "relationship" "CustomsProviderRelationship" NOT NULL,
    "relationshipEvidenceRef" TEXT,
    "relationshipVerifiedAt" TIMESTAMP(3),
    "jurisdictionScope" TEXT[],
    "status" "CustomsProviderBindingStatus" NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "credentialReference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomsProviderTenantBinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomsProviderTenantBindingLineage" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "bindingId" TEXT NOT NULL,
    "event" "CustomsProviderBindingEvent" NOT NULL,
    "actorRef" TEXT NOT NULL,
    "note" TEXT,
    "snapshot" JSONB NOT NULL,
    "snapshotDigest" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceRef" TEXT,

    CONSTRAINT "CustomsProviderTenantBindingLineage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomsProviderWebhookReplayClaim" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomsProviderWebhookReplayClaim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CustomsProviderTenantBinding_organizationId_providerId_prin_idx" ON "CustomsProviderTenantBinding"("organizationId", "providerId", "principalRef", "status");

-- CreateIndex
CREATE INDEX "CustomsProviderTenantBinding_organizationId_bindingScopeKey_idx" ON "CustomsProviderTenantBinding"("organizationId", "bindingScopeKey");

-- CreateIndex
CREATE UNIQUE INDEX "CustomsProviderTenantBinding_organizationId_id_key" ON "CustomsProviderTenantBinding"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "CustomsProviderTenantBinding_organizationId_providerId_bind_key" ON "CustomsProviderTenantBinding"("organizationId", "providerId", "bindingScopeKey");

-- CreateIndex
CREATE INDEX "CustomsProviderTenantBindingLineage_organizationId_bindingI_idx" ON "CustomsProviderTenantBindingLineage"("organizationId", "bindingId", "occurredAt");

-- CreateIndex
CREATE INDEX "CustomsProviderWebhookReplayClaim_claimedAt_idx" ON "CustomsProviderWebhookReplayClaim"("claimedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CustomsProviderWebhookReplayClaim_providerId_deliveryId_key" ON "CustomsProviderWebhookReplayClaim"("providerId", "deliveryId");

-- AddForeignKey
ALTER TABLE "CustomsProviderTenantBinding" ADD CONSTRAINT "CustomsProviderTenantBinding_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomsProviderTenantBindingLineage" ADD CONSTRAINT "CustomsProviderTenantBindingLineage_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomsProviderTenantBindingLineage" ADD CONSTRAINT "CustomsProviderTenantBindingLineage_bindingId_fkey" FOREIGN KEY ("bindingId") REFERENCES "CustomsProviderTenantBinding"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─────────────────────────────────────────────────────────────
-- C18 SCHEMA DELTA（MSG-20261004-24 授权）：DB 级不变量
-- 1) CROSSCLAIM_SAAS 必须有关系证据（camelCase 列名，按 Prisma 约定加引号）
-- 2) binding identity 创建后 immutable（trigger 拒绝 UPDATE 身份列）
-- 3) lineage append-only（trigger 拒绝 UPDATE/DELETE）
-- 4) lineage 与 binding 必须同租户（tenant integrity trigger，沿用既有函数风格）
-- 5) snapshotDigest 必须是 64 位小写 hex
-- ─────────────────────────────────────────────────────────────

ALTER TABLE "CustomsProviderTenantBinding"
  ADD CONSTRAINT "CustomsProviderTenantBinding_crossclaim_saas_evidence_chk"
  CHECK (
    "relationship" <> 'CROSSCLAIM_SAAS'
    OR ("relationshipEvidenceRef" IS NOT NULL AND "relationshipVerifiedAt" IS NOT NULL)
  );

ALTER TABLE "CustomsProviderTenantBindingLineage"
  ADD CONSTRAINT "CustomsProviderTenantBindingLineage_snapshot_digest_chk"
  CHECK ("snapshotDigest" ~ '^[0-9a-f]{64}$');

-- binding identity：创建后不可变（除 id/时间戳/可变 provider 侧字段与状态外，身份列一律禁改）
CREATE OR REPLACE FUNCTION "cc_c18_binding_identity_immutable"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."organizationId"      IS DISTINCT FROM OLD."organizationId"
     OR NEW."providerId"       IS DISTINCT FROM OLD."providerId"
     OR NEW."principalRef"     IS DISTINCT FROM OLD."principalRef"
     OR NEW."bindingScopeVersion" IS DISTINCT FROM OLD."bindingScopeVersion"
     OR NEW."jurisdictionAnchor"  IS DISTINCT FROM OLD."jurisdictionAnchor"
     OR NEW."bindingSlotRef"      IS DISTINCT FROM OLD."bindingSlotRef"
     OR NEW."bindingScopeKey"     IS DISTINCT FROM OLD."bindingScopeKey" THEN
    RAISE EXCEPTION 'C18_BINDING_IDENTITY_IMMUTABLE: binding identity columns are immutable after creation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "cc_identity_immutable__CustomsProviderTenantBinding" ON "CustomsProviderTenantBinding";
CREATE TRIGGER "cc_identity_immutable__CustomsProviderTenantBinding"
  BEFORE UPDATE ON "CustomsProviderTenantBinding"
  FOR EACH ROW EXECUTE FUNCTION "cc_c18_binding_identity_immutable"();

-- lineage：append-only（沿用仓库既有 cc_append_only__* 命名风格）
CREATE OR REPLACE FUNCTION "cc_c18_binding_lineage_append_only"()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'C18_LINEAGE_APPEND_ONLY: lineage facts are append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "cc_append_only__CustomsProviderTenantBindingLineage" ON "CustomsProviderTenantBindingLineage";
CREATE TRIGGER "cc_append_only__CustomsProviderTenantBindingLineage"
  BEFORE UPDATE OR DELETE ON "CustomsProviderTenantBindingLineage"
  FOR EACH ROW EXECUTE FUNCTION "cc_c18_binding_lineage_append_only"();

-- lineage / binding 必须同租户（tenant integrity）
CREATE OR REPLACE FUNCTION "cc_c18_lineage_tenant_integrity"()
RETURNS TRIGGER AS $$
DECLARE
  binding_org TEXT;
BEGIN
  SELECT l."organizationId" INTO binding_org
  FROM "CustomsProviderTenantBinding" b
  JOIN "CustomsProviderTenantBindingLineage" l ON l."bindingId" = b."id"
  WHERE b."id" = NEW."bindingId"
  LIMIT 1;
  IF binding_org IS NULL THEN
    SELECT "organizationId" INTO binding_org FROM "CustomsProviderTenantBinding" WHERE "id" = NEW."bindingId";
  END IF;
  IF binding_org IS NOT NULL AND binding_org <> NEW."organizationId" THEN
    RAISE EXCEPTION 'C18_LINEAGE_TENANT_MISMATCH: lineage organizationId must equal its binding organizationId';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "cc_tenant_integrity__CustomsProviderTenantBindingLineage" ON "CustomsProviderTenantBindingLineage";
CREATE TRIGGER "cc_tenant_integrity__CustomsProviderTenantBindingLineage"
  BEFORE INSERT OR UPDATE ON "CustomsProviderTenantBindingLineage"
  FOR EACH ROW EXECUTE FUNCTION "cc_c18_lineage_tenant_integrity"();
