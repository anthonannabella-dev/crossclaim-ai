-- ============================================================
-- CrossClaim — TRACK A / PC-09（MSG-20261003-96 ⑬）
-- ------------------------------------------------------------
-- 版本化商业/法律文档的**显式接受事实**（最小模型，不做合同生命周期）。
-- 不变量：
--   1) append-only：接受事实创建后不得 UPDATE / DELETE；
--   2) 租户归属不可变（cc_tenant_immutable__PolicyAcceptance）；
--   3) 跨租户禁止：接受者必须是该组织的**在册成员**（isActive）；
--   4) 同一 (org, user, documentKey, documentVersion) 只有一条事实（唯一约束）。
-- 边界：不改 Payment；不启用 autopay / collection；R13 HOLD；TRANSPORT=false；不写任何凭据。
-- ============================================================

CREATE TABLE "PolicyAcceptance" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "documentKey" TEXT NOT NULL,
  "documentVersion" TEXT NOT NULL,
  "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "source" TEXT NOT NULL,
  "evidenceRef" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PolicyAcceptance_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PolicyAcceptance_organizationId_userId_documentKey_documentVersion_key"
  ON "PolicyAcceptance" ("organizationId", "userId", "documentKey", "documentVersion");
CREATE INDEX "PolicyAcceptance_organizationId_documentKey_documentVersion_idx"
  ON "PolicyAcceptance" ("organizationId", "documentKey", "documentVersion");
CREATE INDEX "PolicyAcceptance_organizationId_userId_idx"
  ON "PolicyAcceptance" ("organizationId", "userId");

ALTER TABLE "PolicyAcceptance" ADD CONSTRAINT "PolicyAcceptance_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PolicyAcceptance" ADD CONSTRAINT "PolicyAcceptance_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------- 租户守卫 / 归属不可变 ----------
DROP TRIGGER IF EXISTS cc_tenant_policyacceptance ON "PolicyAcceptance";
CREATE TRIGGER cc_tenant_policyacceptance
  BEFORE INSERT OR UPDATE ON "PolicyAcceptance"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity();

DROP TRIGGER IF EXISTS "cc_tenant_immutable__PolicyAcceptance" ON "PolicyAcceptance";
CREATE TRIGGER "cc_tenant_immutable__PolicyAcceptance"
  BEFORE UPDATE ON "PolicyAcceptance"
  FOR EACH ROW EXECUTE FUNCTION cc_forbid_tenant_reassignment();

-- ---------- 跨租户禁止：接受者必须是该组织的在册成员 ----------
CREATE OR REPLACE FUNCTION cc_policyacceptance_membership_guard() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "Membership" m
     WHERE m."organizationId" = NEW."organizationId"
       AND m."userId" = NEW."userId"
       AND m."isActive" = true
  ) THEN
    RAISE EXCEPTION 'POLICY_ACCEPTANCE_MEMBERSHIP_REQUIRED: user % is not an active member of organization %',
      NEW."userId", NEW."organizationId" USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS cc_policyacceptance_membership_guard ON "PolicyAcceptance";
CREATE TRIGGER cc_policyacceptance_membership_guard
  BEFORE INSERT ON "PolicyAcceptance"
  FOR EACH ROW EXECUTE FUNCTION cc_policyacceptance_membership_guard();

-- ---------- append-only：接受事实不可改 ----------
CREATE OR REPLACE FUNCTION cc_policy_acceptance_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'APPEND_ONLY_TABLE: % rejects %', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "cc_append_only__PolicyAcceptance" ON "PolicyAcceptance";
CREATE TRIGGER "cc_append_only__PolicyAcceptance"
  BEFORE UPDATE OR DELETE ON "PolicyAcceptance"
  FOR EACH ROW EXECUTE FUNCTION cc_policy_acceptance_append_only();

-- 迁移不使用任何 DISABLE TRIGGER；不写任何凭据 / 资金字段。
