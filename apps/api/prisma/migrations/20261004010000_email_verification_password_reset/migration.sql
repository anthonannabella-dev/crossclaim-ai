-- PC-01B / P0 — EMAIL VERIFICATION + PASSWORD RECOVERY（MSG-20261003-148/149 APPROVE_WITH_REVISIONS）
-- 只存 SHA-256 digest；tokenHash UNIQUE；consumedAt/supersededAt 支撑原子消费与重发 supersede。
CREATE TABLE "EmailVerificationToken" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "supersededAt" TIMESTAMP(3),
  "requesterIpHash" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EmailVerificationToken_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EmailVerificationToken_token_hash_shape" CHECK ("tokenHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "EmailVerificationToken_ip_hash_shape" CHECK ("requesterIpHash" IS NULL OR "requesterIpHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "EmailVerificationToken_expiry_after_created" CHECK ("expiresAt" > "createdAt")
);
CREATE UNIQUE INDEX "EmailVerificationToken_tokenHash_key" ON "EmailVerificationToken"("tokenHash");
CREATE INDEX "EmailVerificationToken_userId_expiresAt_idx" ON "EmailVerificationToken"("userId", "expiresAt");
CREATE INDEX "EmailVerificationToken_userId_consumedAt_idx" ON "EmailVerificationToken"("userId", "consumedAt");
ALTER TABLE "EmailVerificationToken" ADD CONSTRAINT "EmailVerificationToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "PasswordResetToken" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "supersededAt" TIMESTAMP(3),
  "requesterIpHash" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PasswordResetToken_token_hash_shape" CHECK ("tokenHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "PasswordResetToken_ip_hash_shape" CHECK ("requesterIpHash" IS NULL OR "requesterIpHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "PasswordResetToken_expiry_after_created" CHECK ("expiresAt" > "createdAt")
);
CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");
CREATE INDEX "PasswordResetToken_userId_expiresAt_idx" ON "PasswordResetToken"("userId", "expiresAt");
CREATE INDEX "PasswordResetToken_userId_consumedAt_idx" ON "PasswordResetToken"("userId", "consumedAt");
ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 令牌摘要 / 归属不可改写（改哈希或换 user 只能通过新建行）
CREATE OR REPLACE FUNCTION cc_auth_token_row_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW."tokenHash" <> OLD."tokenHash" OR NEW."userId" <> OLD."userId" THEN
    RAISE EXCEPTION 'AUTH_TOKEN_IDENTITY_IMMUTABLE: tokenHash / userId cannot be changed';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "cc_auth_token_immutable__EmailVerificationToken" ON "EmailVerificationToken";
CREATE TRIGGER "cc_auth_token_immutable__EmailVerificationToken"
  BEFORE UPDATE ON "EmailVerificationToken"
  FOR EACH ROW EXECUTE FUNCTION cc_auth_token_row_immutable();

DROP TRIGGER IF EXISTS "cc_auth_token_immutable__PasswordResetToken" ON "PasswordResetToken";
CREATE TRIGGER "cc_auth_token_immutable__PasswordResetToken"
  BEFORE UPDATE ON "PasswordResetToken"
  FOR EACH ROW EXECUTE FUNCTION cc_auth_token_row_immutable();
