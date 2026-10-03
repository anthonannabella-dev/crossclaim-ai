-- ============================================================
-- CrossClaim — CARRIER QUEUE #10 FINAL（MSG-20261003-122 ⑳–㉖）
-- carrier claim response facts：append-only / tenant-scoped / DB 强制真值。
--   ㉑ status / source / verificationLevel 枚举 + DB truth：
--      source = USER_REPORTED  →  verificationLevel MUST = UNVERIFIED
--   ㉒ 非法组合：source = USER_REPORTED AND verificationLevel = PROVIDER_VERIFIED
--   ㉓ append-only：UPDATE / DELETE 由触发器拒绝（状态变化 = 新增 fact，不覆盖历史）
--   ㉔ tenant guard：沿用 cc_tenant_* / cc_tenant_immutable__*（不新造隔离机制）
--   ㉕ DB idempotency：UNIQUE(organizationId, packageId, idempotencyKey)
--   provider 来源必须携带 provider reference（与契约层 PROVIDER_REFERENCE_REQUIRED 对齐）。
-- 不存 recovered amount / success fee / payment truth / credential / token。
-- 边界：NO platform write · Payment = 0 · autopay = OFF · collection = OFF ·
--       R13 HOLD · TRANSPORT = false · 无生产凭据。
-- ============================================================

CREATE TABLE "CarrierClaimResponseFact" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "packageId" TEXT NOT NULL,
  "submissionRecordId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "externalAccountId" TEXT NOT NULL,
  "trackingNumber" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "verificationLevel" TEXT NOT NULL,
  "providerReference" TEXT,
  "observedAt" TIMESTAMP(3) NOT NULL,
  "recordedAt" TIMESTAMP(3) NOT NULL,
  "rawArtifactReference" TEXT,
  "recordedByUserId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CarrierClaimResponseFact_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CarrierClaimResponseFact_status_check" CHECK ("status" IN (
    'PENDING', 'UNDER_REVIEW', 'DENIED', 'APPROVED',
    'PARTIALLY_APPROVED', 'PAID', 'CLOSED', 'UNKNOWN')),
  CONSTRAINT "CarrierClaimResponseFact_source_check" CHECK ("source" IN (
    'USER_REPORTED', 'PROVIDER_API', 'PROVIDER_WEBHOOK',
    'PROVIDER_DOCUMENT', 'PROVIDER_PORTAL_ARTIFACT')),
  CONSTRAINT "CarrierClaimResponseFact_verification_level_check"
    CHECK ("verificationLevel" IN ('UNVERIFIED', 'PROVIDER_VERIFIED')),
  -- ㉑ DB truth：用户报告的响应永远不能是 provider 已验证
  CONSTRAINT "CarrierClaimResponseFact_user_reported_unverified_check"
    CHECK ("source" <> 'USER_REPORTED' OR "verificationLevel" = 'UNVERIFIED'),
  -- ㉒ 显式冗余：禁止 (USER_REPORTED, PROVIDER_VERIFIED) 组合
  CONSTRAINT "CarrierClaimResponseFact_no_user_verified_check"
    CHECK (NOT ("source" = 'USER_REPORTED' AND "verificationLevel" = 'PROVIDER_VERIFIED')),
  -- provider 来源必须带 provider reference
  CONSTRAINT "CarrierClaimResponseFact_provider_reference_check"
    CHECK ("source" = 'USER_REPORTED' OR "providerReference" IS NOT NULL)
);

-- ㉕ DB idempotency：同 (org, package, idempotencyKey) 至多一条 fact
CREATE UNIQUE INDEX "CarrierClaimResponseFact_organizationId_packageId_idempotencyKey_key"
  ON "CarrierClaimResponseFact" ("organizationId", "packageId", "idempotencyKey");
-- 读模型：按时间取 history / current projection
CREATE INDEX "CarrierClaimResponseFact_organizationId_packageId_observedAt_idx"
  ON "CarrierClaimResponseFact" ("organizationId", "packageId", "observedAt");

ALTER TABLE "CarrierClaimResponseFact" ADD CONSTRAINT "CarrierClaimResponseFact_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CarrierClaimResponseFact" ADD CONSTRAINT "CarrierClaimResponseFact_recordedByUserId_fkey"
  FOREIGN KEY ("recordedByUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CarrierClaimResponseFact" ADD CONSTRAINT "CarrierClaimResponseFact_submissionRecordId_fkey"
  FOREIGN KEY ("submissionRecordId") REFERENCES "CarrierManualSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------- ㉔ 租户守卫 / 归属不可变 ----------
DROP TRIGGER IF EXISTS cc_tenant_carrierclaimresponsefact ON "CarrierClaimResponseFact";
CREATE TRIGGER cc_tenant_carrierclaimresponsefact
  BEFORE INSERT OR UPDATE ON "CarrierClaimResponseFact"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity('submissionRecordId', 'CarrierManualSubmission');

DROP TRIGGER IF EXISTS "cc_tenant_immutable__CarrierClaimResponseFact" ON "CarrierClaimResponseFact";
CREATE TRIGGER "cc_tenant_immutable__CarrierClaimResponseFact"
  BEFORE UPDATE ON "CarrierClaimResponseFact"
  FOR EACH ROW EXECUTE FUNCTION cc_forbid_tenant_reassignment();

-- ---------- ㉓ append-only ----------
CREATE OR REPLACE FUNCTION cc_carrier_claim_response_fact_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'APPEND_ONLY_TABLE: % rejects %', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "cc_append_only__CarrierClaimResponseFact" ON "CarrierClaimResponseFact";
CREATE TRIGGER "cc_append_only__CarrierClaimResponseFact"
  BEFORE UPDATE OR DELETE ON "CarrierClaimResponseFact"
  FOR EACH ROW EXECUTE FUNCTION cc_carrier_claim_response_fact_append_only();

-- 迁移不使用 DISABLE TRIGGER；不写任何凭据 / 资金字段。
