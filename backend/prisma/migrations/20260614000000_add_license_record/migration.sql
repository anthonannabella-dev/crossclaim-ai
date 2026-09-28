-- AddLicenseRecord
-- 证件台账（监管证件/许可证），用于到期预警与证件类风险

CREATE TABLE IF NOT EXISTS "LicenseRecord" (
  "id"               TEXT NOT NULL,
  "tenantId"         TEXT NOT NULL,
  "licenseType"      TEXT NOT NULL,
  "licenseCode"      TEXT,
  "licenseNo"        TEXT NOT NULL,
  "holder"           TEXT,
  "relatedHsCodes"   TEXT,
  "issuingAuthority" TEXT,
  "issueDate"        TIMESTAMP(3),
  "expiryDate"       TIMESTAMP(3),
  "status"           TEXT NOT NULL DEFAULT 'active',
  "notes"            TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LicenseRecord_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "LicenseRecord_tenantId_idx" ON "LicenseRecord"("tenantId");
CREATE INDEX IF NOT EXISTS "LicenseRecord_tenantId_expiryDate_idx" ON "LicenseRecord"("tenantId", "expiryDate");
