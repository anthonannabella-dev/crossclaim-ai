-- Add wechat fields to Tenant model
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "wechatOpenId" TEXT;
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "wechatUnionId" TEXT;
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "wechatNickname" TEXT;
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "wechatAvatar" TEXT;
CREATE INDEX IF NOT EXISTS "Tenant_wechatOpenId_idx" ON "Tenant"("wechatOpenId");
CREATE INDEX IF NOT EXISTS "Tenant_wechatUnionId_idx" ON "Tenant"("wechatUnionId");
