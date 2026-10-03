-- CI 修复（SELF_RESOLVE）：20261003130000 中 reconciledStatus 的允许值取错来源。
-- 正确来源 = services/platform-write/reconcile-policy.ts 的 ReconcileDecision.reconciledStatus：
  -- 'CONFIRMED_SUCCEEDED' | 'CONFIRMED_FAILED' | 'INCONCLUSIVE' | null

ALTER TABLE "PlatformWriteAttempt" DROP CONSTRAINT IF EXISTS "PlatformWriteAttempt_reconciledStatus_check";
ALTER TABLE "PlatformWriteAttempt"
  ADD CONSTRAINT "PlatformWriteAttempt_reconciledStatus_check"
  CHECK ("reconciledStatus" IS NULL OR "reconciledStatus" IN ('CONFIRMED_SUCCEEDED', 'CONFIRMED_FAILED', 'INCONCLUSIVE'));
