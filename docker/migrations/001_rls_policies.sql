-- ============================================================
-- PostgreSQL Row-Level Security (RLS) — 多租户数据隔离
-- 每个表按 tenant_id 强制执行行级安全策略
-- ============================================================

-- 启用 RLS
ALTER TABLE "Document" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CBAMRecord" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Payment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SubAccount" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ApiToken" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ApiCallLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TimeGrant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LegalConsent" ENABLE ROW LEVEL SECURITY;

-- 当前租户参数 (应用层设置)
-- SET app.current_tenant_id = 'tenant-uuid';

-- 通用 RLS 策略: 只允许访问本租户数据
-- Document
CREATE POLICY tenant_isolation_document ON "Document"
  FOR ALL
  USING ("tenantId" = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant_id', true)::uuid);

-- CBAMRecord
CREATE POLICY tenant_isolation_cbam ON "CBAMRecord"
  FOR ALL
  USING ("tenantId" = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant_id', true)::uuid);

-- Payment
CREATE POLICY tenant_isolation_payment ON "Payment"
  FOR ALL
  USING ("tenantId" = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant_id', true)::uuid);

-- SubAccount
CREATE POLICY tenant_isolation_subaccount ON "SubAccount"
  FOR ALL
  USING ("tenantId" = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant_id', true)::uuid);

-- ApiToken
CREATE POLICY tenant_isolation_apitoken ON "ApiToken"
  FOR ALL
  USING ("tenantId" = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant_id', true)::uuid);

-- AuditLog
CREATE POLICY tenant_isolation_auditlog ON "AuditLog"
  FOR ALL
  USING ("tenantId" = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant_id', true)::uuid);

-- TimeGrant
CREATE POLICY tenant_isolation_timegrant ON "TimeGrant"
  FOR ALL
  USING ("tenantId" = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant_id', true)::uuid);

-- LegalConsent
CREATE POLICY tenant_isolation_legalconsent ON "LegalConsent"
  FOR ALL
  USING ("tenantId" = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant_id', true)::uuid);

-- ApiCallLog: 通过 ApiToken 的 tenantId 间接隔离
CREATE POLICY tenant_isolation_apicalllog ON "ApiCallLog"
  FOR ALL
  USING (
    "tokenId" IN (
      SELECT id FROM "ApiToken"
      WHERE "tenantId" = current_setting('app.current_tenant_id', true)::uuid
    )
  );

-- 管理员绕过 RLS (admin 表无 tenant_id, admin 可访问所有数据)
-- 在应用层: 管理员查询前不设置 current_tenant_id 或使用 bypass 函数
CREATE OR REPLACE FUNCTION bypass_rls()
RETURNS void AS $$
BEGIN
  PERFORM set_config('app.current_tenant_id', '', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
