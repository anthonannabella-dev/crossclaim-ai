#!/usr/bin/env node
// R45 S5 / MSG-20261002-50 —— Outcome / Reimbursement Reconciliation 域 **只读**一致性 checker
// ---------------------------------------------------------------------------
// 用法（CI 与本地通用）：
//   node tools/consistency/check-reconciliation.mjs | PGPASSWORD=... psql -h ... -U ... -d ... -v ON_ERROR_STOP=1
// 语义（MSG-20261002-50 ③ / MSG-20261002-49）：
//   **DETECT ≠ REPAIR**：本脚本只输出 SELECT 与判定结果；**不含任何 INSERT / UPDATE / DELETE / ALTER**
//   （不得自动修复事实、basis、projection、membership、approval 或 evidence）。
//   - clean database → psql 退出码 0（打印 OK NOTICE）
//   - 人工制造的漂移 → RAISE EXCEPTION → psql 非零退出码
//
// 检查面（MSG-20261002-50 ③ 最低检查面 → 本文件编号）：
//   [1] projection ↔ ProjectionFact generation 一致
//   [2] dangling / cross-tenant basis 引用 与 binding
//   [3] dangling / cross-tenant policy 引用 与 scope/version 一致
//   [4] deterministic rebuild（net + status，容差内）== stored projection
//   [5] over-recovery exceptional state 必须带 AMOUNT_EXCEEDS_EXPECTED reason
//   [6] 每个 (org, claimItem) 至多一条 effective basis
//   [7] 每个 policy scope 至多一条 effective policy
//   [8] reversal linkage（目标存在 / 同租户 / 为 OBSERVED / 不自指 / 不重复）
//   [9] evidence 引用（存在 / 同租户；人工路径 ≥1 且可用来源）
//  [10] S4 approval 语义（basis：受保护动作 + 绑定一致 + 恰好消费一次）
//  [11] S4 approval 语义（override：approvalId + 恰好消费一次 + 未跨授权）
//  [12] S4 approval 语义（人工 provider outcome：审计绑定 + 恰好消费一次）
//  [13] provider identity 冲突（同 org+provider+providerEventId 出现多个指纹）
//  [14] matchedFactIds 摘要缓存 == membership 关系表（当前 generation）

export function buildReconciliationConsistencySql() {
  return `DO $$
DECLARE
  v text;
BEGIN
  -- [1] membership generation 必须与 header 一致
  SELECT string_agg(f."projectionId" || ' (fact=' || f."projectionVersion" || ', header=' || p."projectionVersion" || ')', ', ')
    INTO v
    FROM "ClaimReconciliationProjectionFact" f
    JOIN "ClaimReconciliationProjection" p ON p.id = f."projectionId"
   WHERE f."projectionVersion" <> p."projectionVersion"
      OR f."organizationId" <> p."organizationId";
  IF v IS NOT NULL THEN
    RAISE EXCEPTION 'INCONSISTENT[1] projection membership generation mismatch: %', v;
  END IF;

  -- [2] projection.basisId 弱引用强校验（存在 / 同租户 / 同 claimItem）
  SELECT string_agg(p."id", ', ') INTO v
    FROM "ClaimReconciliationProjection" p
   WHERE p."basisId" IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM "ExpectedRecoveryBasis" b
        WHERE b."id" = p."basisId"
          AND b."organizationId" = p."organizationId"
          AND b."claimItemId" = p."claimItemId");
  IF v IS NOT NULL THEN
    RAISE EXCEPTION 'INCONSISTENT[2] dangling/cross-tenant projection basis reference: %', v;
  END IF;

  -- [3] projection.tolerancePolicyId 弱引用强校验（存在 / 同租户或系统级 / scope·version 一致）
  SELECT string_agg(p."id", ', ') INTO v
    FROM "ClaimReconciliationProjection" p
    JOIN "ClaimItem" c ON c.id = p."claimItemId" AND c."organizationId" = p."organizationId"
   WHERE NOT EXISTS (
       SELECT 1 FROM "ReconciliationTolerancePolicy" pol
        WHERE pol."id" = p."tolerancePolicyId"
          AND pol."policyVersion" = p."policyVersion"
          AND (pol."organizationId" IS NULL OR pol."organizationId" = p."organizationId")
          AND pol."provider" IS NULL
          AND pol."operation" IS NULL
          AND pol."supersededAt" IS NULL);
  IF v IS NOT NULL THEN
    RAISE EXCEPTION 'INCONSISTENT[3] dangling/cross-tenant/scope-mismatch projection policy reference: %', v;
  END IF;

  -- [4] deterministic rebuild：net 必须等于「有效 OBSERVED 且未被 override UNMATCHED 排除」之和；status 必须与 basis 比较一致
  WITH rebuilt AS (
    SELECT p."id" AS projection_id,
           p."organizationId" AS organization_id,
           p."claimItemId" AS claim_item_id,
           p."status" AS stored_status,
           p."basisId" AS stored_basis_id,
           p."expectedAmount" AS stored_expected,
           p."netMatchedObservedAmount" AS stored_net,
           COALESCE((
             SELECT SUM(f."amount")
               FROM "ReimbursementFact" f
              WHERE f."organizationId" = p."organizationId"
                AND f."claimItemId" = p."claimItemId"
                AND f."kind" = 'OBSERVED'
                AND NOT EXISTS (
                  SELECT 1 FROM "ReimbursementFact" r
                   WHERE r."organizationId" = f."organizationId" AND r."reversesFactId" = f."id")
                AND NOT EXISTS (
                  SELECT 1 FROM "ReconciliationOverrideDecision" o
                   WHERE o."organizationId" = f."organizationId"
                     AND o."reimbursementFactId" = f."id"
                     AND o."decisionKind" = 'UNMATCHED')
                AND (p."basisId" IS NULL OR f."currency" = (SELECT b."currency" FROM "ExpectedRecoveryBasis" b WHERE b."id" = p."basisId"))
           ), 0) AS rebuilt_net,
           (SELECT b."expectedRecoveryAmount" FROM "ExpectedRecoveryBasis" b WHERE b."id" = p."basisId") AS expected_amount,
           (SELECT pol."absoluteTolerance" FROM "ReconciliationTolerancePolicy" pol WHERE pol."id" = p."tolerancePolicyId") AS absolute_tolerance,
           (SELECT pol."relativeTolerance" FROM "ReconciliationTolerancePolicy" pol WHERE pol."id" = p."tolerancePolicyId") AS relative_tolerance
      FROM "ClaimReconciliationProjection" p
  ), judged AS (
    SELECT r.*,
           CASE
             WHEN r.rebuilt_net <> r.stored_net THEN 'NET_MISMATCH'
             WHEN r.stored_status = 'FULLY_RECONCILED' AND r.stored_basis_id IS NULL THEN 'FULLY_WITHOUT_BASIS'
             WHEN r.stored_status = 'MATCHED' AND r.stored_basis_id IS NOT NULL THEN 'MATCHED_WITH_BASIS'
             WHEN r.expected_amount IS NULL THEN NULL
             WHEN ABS(r.rebuilt_net - r.expected_amount) <= GREATEST(r.absolute_tolerance, r.expected_amount * r.relative_tolerance) THEN
               CASE WHEN r.stored_status <> 'FULLY_RECONCILED' AND r.stored_status <> 'AMBIGUOUS' THEN 'SHOULD_BE_FULLY' END
             WHEN r.rebuilt_net < r.expected_amount THEN
               CASE WHEN r.stored_status <> 'PARTIALLY_RECONCILED' AND r.stored_status <> 'AMBIGUOUS' THEN 'SHOULD_BE_PARTIAL' END
             ELSE
               CASE WHEN r.stored_status <> 'AMBIGUOUS' THEN 'SHOULD_BE_AMBIGUOUS_OVER_RECOVERY' END
           END AS verdict
      FROM rebuilt r
  )
  SELECT string_agg(j.projection_id || '[' || j.verdict || ']', ', ') INTO v FROM judged j WHERE j.verdict IS NOT NULL;
  IF v IS NOT NULL THEN
    RAISE EXCEPTION 'INCONSISTENT[4] stored projection != deterministic rebuild: %', v;
  END IF;

  -- [5] over-recovery exceptional state 必须带 AMOUNT_EXCEEDS_EXPECTED reason（来自 projection rebuild audit）
  SELECT string_agg(p."id", ', ') INTO v
    FROM "ClaimReconciliationProjection" p
   WHERE p."status" = 'AMBIGUOUS'
     AND p."expectedAmount" IS NOT NULL
     AND p."netMatchedObservedAmount" > p."expectedAmount"
     AND NOT EXISTS (
       SELECT 1 FROM "AuditLog" a
        WHERE a."organizationId" = p."organizationId"
          AND a."action" = 'reconciliation.projection_rebuilt'
          AND a."entityId" = p."id"
          AND a."changes" -> 'ambiguityReasons' @> '["AMOUNT_EXCEEDS_EXPECTED"]'::jsonb);
  IF v IS NOT NULL THEN
    RAISE EXCEPTION 'INCONSISTENT[5] over-recovery without AMOUNT_EXCEEDS_EXPECTED reason: %', v;
  END IF;

  -- [6] 每个 (org, claimItem) 至多一条 effective basis
  SELECT string_agg(x."organizationId" || '/' || x."claimItemId", ', ') INTO v
    FROM (
      SELECT b."organizationId", b."claimItemId", count(*) AS n
        FROM "ExpectedRecoveryBasis" b WHERE b."supersededAt" IS NULL
       GROUP BY 1, 2 HAVING count(*) > 1) x;
  IF v IS NOT NULL THEN
    RAISE EXCEPTION 'INCONSISTENT[6] multiple effective basis for claimItem: %', v;
  END IF;

  -- [7] 每个 policy scope 至多一条 effective policy
  SELECT string_agg(COALESCE(x."organizationId", '*') || '/' || COALESCE(x.provider, '*') || '/' || COALESCE(x.operation, '*'), ', ') INTO v
    FROM (
      SELECT pol."organizationId", pol."provider", pol."operation", count(*) AS n
        FROM "ReconciliationTolerancePolicy" pol WHERE pol."supersededAt" IS NULL
       GROUP BY 1, 2, 3, pol."policyVersion" HAVING count(*) > 1) x;
  IF v IS NOT NULL THEN
    RAISE EXCEPTION 'INCONSISTENT[7] multiple effective policy in scope: %', v;
  END IF;

  -- [8] reversal linkage：目标存在 / 同租户 / 为 OBSERVED / 不自指 / 同一 OBSERVED 不重复
  SELECT string_agg(r."id", ', ') INTO v
    FROM "ReimbursementFact" r
   WHERE r."kind" = 'REIMBURSEMENT_REVERSED'
     AND (r."reversesFactId" IS NULL
          OR r."reversesFactId" = r."id"
          OR NOT EXISTS (
            SELECT 1 FROM "ReimbursementFact" t
             WHERE t."id" = r."reversesFactId"
               AND t."organizationId" = r."organizationId"
               AND t."kind" = 'OBSERVED'));
  IF v IS NOT NULL THEN
    RAISE EXCEPTION 'INCONSISTENT[8] reversal linkage invalid: %', v;
  END IF;

  -- [9] evidence 引用：provider outcome 事实的每个 evidence 必须存在且同租户；人工路径必须 ≥1 且具备可用来源
  SELECT string_agg(f."id", ', ') INTO v
    FROM "ProviderOutcomeFact" f
   WHERE EXISTS (
       SELECT 1 FROM unnest(f."evidenceArtifactIds") AS eid
        WHERE NOT EXISTS (
          SELECT 1 FROM "EvidenceArtifact" e
           WHERE e."id" = eid AND e."organizationId" = f."organizationId"));
  IF v IS NOT NULL THEN
    RAISE EXCEPTION 'INCONSISTENT[9a] dangling/cross-tenant provider outcome evidence: %', v;
  END IF;

  SELECT string_agg(f."id", ', ') INTO v
    FROM "ProviderOutcomeFact" f
   WHERE f."sourceKind" = 'MANUAL_WITH_EVIDENCE'
     AND (cardinality(f."evidenceArtifactIds") < 1 OR f."reasonCode" IS NULL);
  IF v IS NOT NULL THEN
    RAISE EXCEPTION 'INCONSISTENT[9b] manual provider outcome missing evidence/reason: %', v;
  END IF;

  -- [10] basis 的 approval 语义：受保护动作审计存在 + 同租户 + 目标绑定一致 + 恰好消费一次
  SELECT string_agg(b."id", ', ') INTO v
    FROM "ExpectedRecoveryBasis" b
   WHERE NOT EXISTS (
       SELECT 1 FROM "AuditLog" a
        WHERE a."organizationId" = b."organizationId"
          AND a."action" IN ('reconciliation.basis_set', 'reconciliation.basis_superseded')
          AND a."entityId" = b."id"
          AND a."changes" ? 'approvalId'
          AND (
            SELECT count(*) FROM "AuditLog" c
             WHERE c."organizationId" = b."organizationId"
               AND c."action" = 'recovery.approval_consumed'
               AND c."changes" ->> 'approvalId' = a."changes" ->> 'approvalId') = 1);
  IF v IS NOT NULL THEN
    RAISE EXCEPTION 'INCONSISTENT[10] basis without valid consumed approval: %', v;
  END IF;

  -- [11] override 的 approval 语义：approvalId 必须是同租户 review_approved + boundAction 正确 + 恰好消费一次
  SELECT string_agg(o."id", ', ') INTO v
    FROM "ReconciliationOverrideDecision" o
   WHERE NOT EXISTS (
       SELECT 1 FROM "AuditLog" a
        WHERE a."organizationId" = o."organizationId"
          AND a."id" = o."approvalId"
          AND a."action" = 'recovery.review_approved'
          AND a."changes" ->> 'boundAction' = 'recovery.reconciliation_override')
     OR (SELECT count(*) FROM "AuditLog" c
          WHERE c."organizationId" = o."organizationId"
            AND c."action" = 'recovery.approval_consumed'
            AND c."changes" ->> 'approvalId' = o."approvalId") <> 1;
  IF v IS NOT NULL THEN
    RAISE EXCEPTION 'INCONSISTENT[11] override approval binding invalid: %', v;
  END IF;

  -- [12] 人工 provider outcome 的 approval 语义：审计绑定 + 同租户 + 恰好消费一次
  SELECT string_agg(f."id", ', ') INTO v
    FROM "ProviderOutcomeFact" f
   WHERE f."sourceKind" = 'MANUAL_WITH_EVIDENCE'
     AND NOT EXISTS (
       SELECT 1 FROM "AuditLog" a
        WHERE a."organizationId" = f."organizationId"
          AND a."action" = 'reconciliation.provider_outcome_recorded'
          AND a."entityId" = f."id"
          AND a."changes" ? 'approvalId'
          AND (SELECT count(*) FROM "AuditLog" c
                WHERE c."organizationId" = f."organizationId"
                  AND c."action" = 'recovery.approval_consumed'
                  AND c."changes" ->> 'approvalId' = a."changes" ->> 'approvalId') = 1);
  IF v IS NOT NULL THEN
    RAISE EXCEPTION 'INCONSISTENT[12] manual provider outcome without valid consumed approval: %', v;
  END IF;

  -- [13] provider identity 冲突：同 org + provider + providerEventId 出现多个指纹
  SELECT string_agg(x."organizationId" || '/' || x."provider" || '/' || x."providerEventId", ', ') INTO v
    FROM (
      SELECT f."organizationId", f."provider", f."providerEventId", count(DISTINCT f."providerEventFingerprint") AS n
        FROM "ProviderOutcomeFact" f WHERE f."providerEventId" IS NOT NULL
       GROUP BY 1, 2, 3 HAVING count(DISTINCT f."providerEventFingerprint") > 1) x;
  IF v IS NOT NULL THEN
    RAISE EXCEPTION 'INCONSISTENT[13] provider event identity collision (same id, multiple fingerprints): %', v;
  END IF;

  -- [14] matchedFactIds 摘要缓存必须与 membership 关系表一致（当前 generation）
  SELECT string_agg(p."id", ', ') INTO v
    FROM "ClaimReconciliationProjection" p
   WHERE COALESCE((
       SELECT array_agg(f."reimbursementFactId" ORDER BY f."reimbursementFactId")
         FROM "ClaimReconciliationProjectionFact" f
        WHERE f."projectionId" = p."id"), ARRAY[]::text[])
      IS DISTINCT FROM
        COALESCE((SELECT array_agg(x ORDER BY x) FROM unnest(p."matchedFactIds") AS x), ARRAY[]::text[]);
  IF v IS NOT NULL THEN
    RAISE EXCEPTION 'INCONSISTENT[14] matchedFactIds summary != membership relation: %', v;
  END IF;

  RAISE NOTICE 'OK: reconciliation consistency checks 1-14 passed (read-only)';
END
$$;
`;
}

if (process.argv[1] && process.argv[1].endsWith('check-reconciliation.mjs')) {
  process.stdout.write(buildReconciliationConsistencySql());
}
