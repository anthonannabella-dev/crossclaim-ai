-- ============================================================
-- CrossClaim — C-0013-A ClaimItem.sourceFingerprint（纯增量）
-- ------------------------------------------------------------
-- MSG-20260928-130 / -132 / -134：
--   · 两个可空列：sourceFingerprint（来源指纹）+ fingerprintVersion（算法版本，当前 v1）
--   · 部分唯一索引：platformRef 为空时用指纹去重（关闭 RISK-C0011-001）
--   · 历史行不回填：两列保持 NULL，不受新索引约束
--   · 无新跨表引用 → 租户触发器仍为 27
-- 说明：部分唯一索引无法用 Prisma schema 表达，因此以原生 SQL 写在迁移里。
-- ============================================================

ALTER TABLE "ClaimItem" ADD COLUMN "sourceFingerprint" TEXT;
ALTER TABLE "ClaimItem" ADD COLUMN "fingerprintVersion" TEXT;

CREATE UNIQUE INDEX "ClaimItem_org_platform_fingerprint_key"
  ON "ClaimItem"("organizationId", "platformType", "sourceFingerprint")
  WHERE "sourceFingerprint" IS NOT NULL;
