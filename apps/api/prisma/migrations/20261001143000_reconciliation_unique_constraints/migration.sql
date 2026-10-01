-- ============================================================
-- CrossClaim — R45 S1 / M4
-- 唯一性与 effective 判定：partial unique index（Prisma schema 无法表达，原生 SQL 落库）
-- ------------------------------------------------------------
-- 依据：MSG-20261001-45 CHANGE C + MSG-20261001-46 Q1 / CHANGE C
--   1) ExpectedRecoveryBasis：同一 (tenant, claimItem) 任意时刻至多一个 effective（supersededAt IS NULL）；
--      partial unique **仅作最终防线**：supersede 必须按 CAS 事务顺序执行（见 S4 服务层）；
--   2) ReimbursementFact：同一 OBSERVED 至多一个有效 full reversal（partial unique）；
--   3) ReconciliationTolerancePolicy：同一 scope（tenant + provider + operation + version）
--      至多一个 effective policy；scope 内的 NULL 以 '*' 归一（避免 NULL 不参与唯一性）；
--   4) 显式系统 exact policy 记录（provider / operation 为空，tolerance = 0/0）：
--      CHANGE C 要求「无 provider-specific policy 时使用显式系统记录」，不得代码隐式 fallback。
-- 性质：纯新增索引 + 一条系统常量记录；零既有对象改动。
-- ============================================================

CREATE UNIQUE INDEX "expected_recovery_basis_effective_unique"
  ON "ExpectedRecoveryBasis" ("organizationId", "claimItemId")
  WHERE "supersededAt" IS NULL;

CREATE UNIQUE INDEX "reimbursement_fact_full_reversal_unique"
  ON "ReimbursementFact" ("organizationId", "reversesFactId")
  WHERE "reversesFactId" IS NOT NULL;

CREATE UNIQUE INDEX "reconciliation_tolerance_policy_scope_unique"
  ON "ReconciliationTolerancePolicy" (
    COALESCE("organizationId", '*'), COALESCE("provider", '*'), COALESCE("operation", '*'), "policyVersion"
  )
  WHERE "supersededAt" IS NULL;

-- 显式系统 exact policy（CHANGE C）：每个 Projection 都必须能引用 tolerancePolicyId + policyVersion
INSERT INTO "ReconciliationTolerancePolicy" (
  "id", "organizationId", "provider", "operation", "policyVersion",
  "absoluteTolerance", "relativeTolerance", "effectiveAt", "createdByUserId"
) VALUES (
  'cc0f0000-0000-4000-8000-000000000001', NULL, NULL, NULL, 'v1',
  0, 0, CURRENT_TIMESTAMP, 'SYSTEM_EXACT_POLICY'
)
ON CONFLICT ("id") DO NOTHING;

-- 回滚（人工）：DROP INDEX IF EXISTS <name>; DELETE FROM "ReconciliationTolerancePolicy" WHERE "id" = 'cc0f0000-0000-4000-8000-000000000001';
