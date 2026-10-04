-- CA-3 REVISE CHANGE B/C（MSG-20261004-04）：
--   B = 稳定幂等身份 lifecycleKey（不含 observedAt）
--   C = Broker POA 生命周期字段与 signer 对齐（verifiedAt / revokedAt / supersededAt + DB invariant）

ALTER TABLE "CustomsBrokerPoaFact"
  ADD COLUMN IF NOT EXISTS "verifiedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "revokedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "supersededAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lifecycleKey" TEXT;

ALTER TABLE "CustomsAuthorizedSignerFact"
  ADD COLUMN IF NOT EXISTS "lifecycleKey" TEXT;

ALTER TABLE "CustomsBrokerPoaFact" DISABLE TRIGGER "cc_append_only__CustomsBrokerPoaFact";
ALTER TABLE "CustomsAuthorizedSignerFact" DISABLE TRIGGER "cc_append_only__CustomsAuthorizedSignerFact";

-- 历史行回填：VERIFIED 事实以 observedAt 作为 verifiedAt；lifecycleKey 用 legacy:<digest> 保证唯一
UPDATE "CustomsBrokerPoaFact"
  SET "verifiedAt" = COALESCE("verifiedAt", "observedAt")
  WHERE "verificationStatus" = 'VERIFIED' AND "verifiedAt" IS NULL;
UPDATE "CustomsBrokerPoaFact"
  SET "lifecycleKey" = 'legacy:' || "contentDigest"
  WHERE "lifecycleKey" IS NULL;
UPDATE "CustomsAuthorizedSignerFact"
  SET "lifecycleKey" = 'legacy:' || "contentDigest"
  WHERE "lifecycleKey" IS NULL;

ALTER TABLE "CustomsBrokerPoaFact" ENABLE TRIGGER "cc_append_only__CustomsBrokerPoaFact";
ALTER TABLE "CustomsAuthorizedSignerFact" ENABLE TRIGGER "cc_append_only__CustomsAuthorizedSignerFact";

ALTER TABLE "CustomsBrokerPoaFact" ALTER COLUMN "lifecycleKey" SET NOT NULL;
ALTER TABLE "CustomsAuthorizedSignerFact" ALTER COLUMN "lifecycleKey" SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "CustomsBrokerPoaFact_org_lifecycle_key" ON "CustomsBrokerPoaFact"("organizationId", "lifecycleKey");
CREATE UNIQUE INDEX IF NOT EXISTS "CustomsAuthorizedSignerFact_org_lifecycle_key" ON "CustomsAuthorizedSignerFact"("organizationId", "lifecycleKey");

ALTER TABLE "CustomsBrokerPoaFact" DROP CONSTRAINT IF EXISTS "CustomsBrokerPoaFact_verified_needs_timestamp";
ALTER TABLE "CustomsBrokerPoaFact"
  ADD CONSTRAINT "CustomsBrokerPoaFact_verified_needs_timestamp"
  CHECK ("verificationStatus" <> 'VERIFIED' OR "verifiedAt" IS NOT NULL);

ALTER TABLE "CustomsBrokerPoaFact" DROP CONSTRAINT IF EXISTS "CustomsBrokerPoaFact_revoked_bidirectional";
ALTER TABLE "CustomsBrokerPoaFact"
  ADD CONSTRAINT "CustomsBrokerPoaFact_revoked_bidirectional"
  CHECK (("revokedAt" IS NULL) = ("verificationStatus" <> 'REVOKED'));

ALTER TABLE "CustomsBrokerPoaFact" DROP CONSTRAINT IF EXISTS "CustomsBrokerPoaFact_supersede_window";
ALTER TABLE "CustomsBrokerPoaFact"
  ADD CONSTRAINT "CustomsBrokerPoaFact_supersede_window"
  CHECK ("supersededAt" IS NULL OR "supersededAt" >= "effectiveAt");
