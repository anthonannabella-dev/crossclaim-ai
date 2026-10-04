-- CA-4 REVISE D（MSG-20261004-06 §3 批准）— CUSTOMS BROKER AUTHORIZATION SESSION
-- 受控可迁移状态机（CustomsBrokerAuthorizationSession）+ append-only 事件历史
-- （CustomsBrokerAuthorizationSessionEvent）。tenant scoped；零真实 Broker / provider / CBP / ACE / ABI 外写。

CREATE TYPE "CustomsBrokerAuthorizationSessionStatus" AS ENUM (
  'CREATED',
  'CUSTOMER_ACTION_REQUIRED',
  'SIGNED',
  'PROVIDER_VERIFYING',
  'VERIFIED',
  'REJECTED',
  'EXPIRED',
  'REVOKED'
);

CREATE TYPE "CustomsBrokerAuthorizationVerificationSource" AS ENUM (
  'PROVIDER_EVIDENCE',
  'MANUAL_REVIEW'
);

CREATE TABLE "CustomsBrokerAuthorizationSession" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "principalRef" TEXT NOT NULL,
  "brokerRef" TEXT NOT NULL,
  "providerRef" TEXT NOT NULL,
  "jurisdiction" TEXT NOT NULL,
  "requestedScope" JSONB NOT NULL,
  "authorizationType" "CustomsBrokerAuthorizationType" NOT NULL,
  "route" TEXT NOT NULL,
  "status" "CustomsBrokerAuthorizationSessionStatus" NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "externalAuthorizationUrlRef" TEXT,
  "providerAuthorizationRef" TEXT,
  "evidenceArtifactRef" TEXT,
  "verificationSource" "CustomsBrokerAuthorizationVerificationSource",
  "verifiedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "contentDigest" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CustomsBrokerAuthorizationSession_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CustomsBrokerAuthorizationSession_digest_shape" CHECK ("contentDigest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "CustomsBrokerAuthorizationSession_version_positive" CHECK ("version" >= 1),
  CONSTRAINT "CustomsBrokerAuthorizationSession_scope_tokens" CHECK (cc_customs_scope_tokens_valid("requestedScope")),
  CONSTRAINT "CustomsBrokerAuthorizationSession_route_known" CHECK ("route" IN ('BROKER_FILED', 'SELF_FILED', 'SERVICE_PROVIDER_TRANSMIT')),
  CONSTRAINT "CustomsBrokerAuthorizationSession_principal_ref_shape" CHECK ("principalRef" ~ '^[A-Za-z0-9._:@#/-]{1,96}$'),
  CONSTRAINT "CustomsBrokerAuthorizationSession_broker_ref_shape" CHECK ("brokerRef" ~ '^[A-Za-z0-9._:@#/-]{1,96}$'),
  CONSTRAINT "CustomsBrokerAuthorizationSession_provider_ref_shape" CHECK ("providerRef" ~ '^[A-Za-z0-9._:@#/-]{1,96}$'),
  CONSTRAINT "CustomsBrokerAuthorizationSession_principal_ref_not_ein" CHECK ("principalRef" !~ '^[0-9]{2}-[0-9]{7}$' AND "principalRef" !~ '^[0-9]{6,12}$'),
  CONSTRAINT "CustomsBrokerAuthorizationSession_broker_ref_not_ein" CHECK ("brokerRef" !~ '^[0-9]{2}-[0-9]{7}$' AND "brokerRef" !~ '^[0-9]{6,12}$'),
  CONSTRAINT "CustomsBrokerAuthorizationSession_provider_ref_not_ein" CHECK ("providerRef" !~ '^[0-9]{2}-[0-9]{7}$' AND "providerRef" !~ '^[0-9]{6,12}$'),
  CONSTRAINT "CustomsBrokerAuthorizationSession_url_ref_opaque" CHECK (
    "externalAuthorizationUrlRef" IS NULL
    OR ("externalAuthorizationUrlRef" ~ '^[A-Za-z0-9._:@#/-]{1,96}$'
        AND "externalAuthorizationUrlRef" !~* '^(https?://|javascript:|data:|file:)')
  ),
  CONSTRAINT "CustomsBrokerAuthorizationSession_provider_auth_ref_opaque" CHECK (
    "providerAuthorizationRef" IS NULL
    OR ("providerAuthorizationRef" ~ '^[A-Za-z0-9._:@#/-]{1,96}$'
        AND "providerAuthorizationRef" !~* '^(https?://|javascript:|data:|file:)')
  ),
  CONSTRAINT "CustomsBrokerAuthorizationSession_evidence_ref_opaque" CHECK (
    "evidenceArtifactRef" IS NULL
    OR ("evidenceArtifactRef" ~ '^[A-Za-z0-9._:@#/-]{1,96}$'
        AND "evidenceArtifactRef" !~* '^(https?://|javascript:|data:|file:)')
  ),
  CONSTRAINT "CustomsBrokerAuthorizationSession_verified_needs_evidence" CHECK (
    "status" <> 'VERIFIED'
    OR ("evidenceArtifactRef" IS NOT NULL AND "verificationSource" IS NOT NULL AND "verifiedAt" IS NOT NULL)
  ),
  CONSTRAINT "CustomsBrokerAuthorizationSession_verification_source_only_verified" CHECK (
    "verificationSource" IS NULL OR "status" = 'VERIFIED'
  ),
  CONSTRAINT "CustomsBrokerAuthorizationSession_verified_at_only_verified" CHECK (
    "verifiedAt" IS NULL OR "status" = 'VERIFIED'
  ),
  CONSTRAINT "CustomsBrokerAuthorizationSession_completed_terminal" CHECK (
    ("completedAt" IS NOT NULL) = ("status" IN ('VERIFIED', 'REJECTED', 'EXPIRED', 'REVOKED'))
  ),
  CONSTRAINT "CustomsBrokerAuthorizationSession_expiry_window" CHECK ("expiresAt" IS NULL OR "expiresAt" >= "createdAt")
);

CREATE UNIQUE INDEX "CustomsBrokerAuthorizationSession_org_session_key"
  ON "CustomsBrokerAuthorizationSession"("organizationId", "sessionId");
CREATE INDEX "CustomsBrokerAuthorizationSession_org_principal_broker_idx"
  ON "CustomsBrokerAuthorizationSession"("organizationId", "principalRef", "brokerRef");
CREATE INDEX "CustomsBrokerAuthorizationSession_org_status_idx"
  ON "CustomsBrokerAuthorizationSession"("organizationId", "status");

ALTER TABLE "CustomsBrokerAuthorizationSession"
  ADD CONSTRAINT "CustomsBrokerAuthorizationSession_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "CustomsBrokerAuthorizationSessionEvent" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "sessionRowId" TEXT NOT NULL,
  "fromStatus" "CustomsBrokerAuthorizationSessionStatus" NOT NULL,
  "toStatus" "CustomsBrokerAuthorizationSessionStatus" NOT NULL,
  "verificationSource" "CustomsBrokerAuthorizationVerificationSource",
  "reason" TEXT,
  "contentDigest" TEXT NOT NULL,
  "observedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CustomsBrokerAuthorizationSessionEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CustomsBrokerAuthorizationSessionEvent_digest_shape" CHECK ("contentDigest" ~ '^[0-9a-f]{64}$')
);

CREATE INDEX "CustomsBrokerAuthorizationSessionEvent_org_session_observed_idx"
  ON "CustomsBrokerAuthorizationSessionEvent"("organizationId", "sessionRowId", "observedAt");
CREATE INDEX "CustomsBrokerAuthorizationSessionEvent_session_idx"
  ON "CustomsBrokerAuthorizationSessionEvent"("sessionRowId");

ALTER TABLE "CustomsBrokerAuthorizationSessionEvent"
  ADD CONSTRAINT "CustomsBrokerAuthorizationSessionEvent_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomsBrokerAuthorizationSessionEvent"
  ADD CONSTRAINT "CustomsBrokerAuthorizationSessionEvent_sessionRowId_fkey"
  FOREIGN KEY ("sessionRowId") REFERENCES "CustomsBrokerAuthorizationSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION cc_customs_broker_auth_session_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."organizationId" <> OLD."organizationId" THEN
    RAISE EXCEPTION 'CUSTOMS_BROKER_AUTH_SESSION_TENANT: organizationId is immutable';
  END IF;
  IF NEW."sessionId" <> OLD."sessionId"
     OR NEW."principalRef" <> OLD."principalRef"
     OR NEW."brokerRef" <> OLD."brokerRef"
     OR NEW."providerRef" <> OLD."providerRef"
     OR NEW."jurisdiction" <> OLD."jurisdiction"
     OR NEW."authorizationType" <> OLD."authorizationType"
     OR NEW."route" <> OLD."route"
     OR NEW."requestedScope" <> OLD."requestedScope"
     OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'CUSTOMS_BROKER_AUTH_SESSION_IDENTITY_IMMUTABLE: session identity fields cannot be updated';
  END IF;
  IF NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'CUSTOMS_BROKER_AUTH_SESSION_VERSION: version must increment by exactly 1 (got % -> %)', OLD."version", NEW."version";
  END IF;
  IF NEW."status" <> OLD."status" THEN
    IF NOT (
      (OLD."status" = 'CREATED' AND NEW."status" IN ('CUSTOMER_ACTION_REQUIRED', 'SIGNED', 'REVOKED', 'EXPIRED'))
      OR (OLD."status" = 'CUSTOMER_ACTION_REQUIRED' AND NEW."status" IN ('SIGNED', 'EXPIRED', 'REVOKED'))
      OR (OLD."status" = 'SIGNED' AND NEW."status" IN ('PROVIDER_VERIFYING', 'VERIFIED', 'REJECTED', 'EXPIRED', 'REVOKED'))
      OR (OLD."status" = 'PROVIDER_VERIFYING' AND NEW."status" IN ('VERIFIED', 'REJECTED', 'EXPIRED', 'REVOKED'))
    ) THEN
      RAISE EXCEPTION 'CUSTOMS_BROKER_AUTH_SESSION_TRANSITION: % -> % is not an allowed transition', OLD."status", NEW."status";
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "cc_tenant_customsbrokerauthorizationsession" ON "CustomsBrokerAuthorizationSession";
CREATE TRIGGER "cc_tenant_customsbrokerauthorizationsession"
  BEFORE INSERT OR UPDATE ON "CustomsBrokerAuthorizationSession"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity();

DROP TRIGGER IF EXISTS "cc_tenant_immutable__CustomsBrokerAuthorizationSession" ON "CustomsBrokerAuthorizationSession";
CREATE TRIGGER "cc_tenant_immutable__CustomsBrokerAuthorizationSession"
  BEFORE UPDATE ON "CustomsBrokerAuthorizationSession"
  FOR EACH ROW EXECUTE FUNCTION cc_forbid_tenant_reassignment();

DROP TRIGGER IF EXISTS "cc_customs_broker_auth_session_guard" ON "CustomsBrokerAuthorizationSession";
CREATE TRIGGER "cc_customs_broker_auth_session_guard"
  BEFORE UPDATE ON "CustomsBrokerAuthorizationSession"
  FOR EACH ROW EXECUTE FUNCTION cc_customs_broker_auth_session_guard();

DROP TRIGGER IF EXISTS "cc_tenant_customsbrokerauthorizationsessionevent" ON "CustomsBrokerAuthorizationSessionEvent";
CREATE TRIGGER "cc_tenant_customsbrokerauthorizationsessionevent"
  BEFORE INSERT OR UPDATE ON "CustomsBrokerAuthorizationSessionEvent"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity('sessionRowId', 'CustomsBrokerAuthorizationSession');

DROP TRIGGER IF EXISTS "cc_tenant_immutable__CustomsBrokerAuthorizationSessionEvent" ON "CustomsBrokerAuthorizationSessionEvent";
CREATE TRIGGER "cc_tenant_immutable__CustomsBrokerAuthorizationSessionEvent"
  BEFORE UPDATE ON "CustomsBrokerAuthorizationSessionEvent"
  FOR EACH ROW EXECUTE FUNCTION cc_forbid_tenant_reassignment();

DROP TRIGGER IF EXISTS "cc_append_only__CustomsBrokerAuthorizationSessionEvent" ON "CustomsBrokerAuthorizationSessionEvent";
CREATE TRIGGER "cc_append_only__CustomsBrokerAuthorizationSessionEvent"
  BEFORE UPDATE OR DELETE ON "CustomsBrokerAuthorizationSessionEvent"
  FOR EACH ROW EXECUTE FUNCTION cc_customs_ior_fact_append_only();
