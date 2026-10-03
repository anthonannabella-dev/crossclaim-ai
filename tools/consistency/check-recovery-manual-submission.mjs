#!/usr/bin/env node
// R43 S5 / MSG-20261001-37 —— 人工追回提交域 **只读**一致性 checker
// ---------------------------------------------------------------------------
// 用法（CI 与本地通用）：
//   node tools/consistency/check-recovery-manual-submission.mjs | PGPASSWORD=... psql -h ... -U ... -d ... -v ON_ERROR_STOP=1
// 语义（MSG-20261001-37）：
//   detect ≠ repair：本脚本**只读**，只输出 SQL 与判定结果；不包含任何 INSERT/UPDATE/DELETE/ALTER。
//   - clean database → psql 退出码 0（打印 OK NOTICE）
//   - 人工制造的漂移 → RAISE EXCEPTION → psql 非零退出码
//   - 第 9 项（package 终态与历史 submission 的关系）作为**事实关系**在 NOTICE 中报告，不判失败、不修改
// 检查项 1–8 / 10–12 见 buildRecoveryManualConsistencySql 内的注释与 SQL。
// R43 S6（MSG-20261001-38 CHANGE A）：第 5c 项为 approval 语义强校验（同租户 / 目标 Case /
// boundAction=recovery.manual_submit / boundPayload.basisReference=versioned basis / fingerprintVersion=v1）。

export function buildRecoveryManualConsistencySql() {
  return `DO $$
DECLARE
  v text;
  facts text;
  subs int;
  refs int;
BEGIN
  -- 1) ClaimItem.status = SUBMITTED_MANUAL ⇒ 必须存在对应 Submission（同租户）
  SELECT string_agg(c.id, ', ') INTO v
    FROM "ClaimItem" c
   WHERE c.status = 'SUBMITTED_MANUAL'
     AND NOT EXISTS (
       SELECT 1 FROM "RecoveryManualSubmission" s
        WHERE s."claimItemId" = c.id AND s."organizationId" = c."organizationId");
  IF v IS NOT NULL THEN
    RAISE EXCEPTION 'INCONSISTENT[1] SUBMITTED_MANUAL without submission: %', v;
  END IF;

  -- 2) Submission ⇒ 对应 ClaimItem 必须处于 SUBMITTED_MANUAL / RECOVERED / CLOSED（同租户）
  SELECT string_agg(s.id, ', ') INTO v
    FROM "RecoveryManualSubmission" s
    JOIN "ClaimItem" c ON c.id = s."claimItemId" AND c."organizationId" = s."organizationId"
   WHERE c.status NOT IN ('SUBMITTED_MANUAL','RECOVERED','CLOSED');
  IF v IS NOT NULL THEN
    RAISE EXCEPTION 'INCONSISTENT[2] submission with non-submitted claim state: %', v;
  END IF;

  -- 3) submission 的 claim/case/package digest/basis 关系一致（含 caseId 与 ClaimItem 一致）
  SELECT string_agg(s.id, ', ') INTO v
    FROM "RecoveryManualSubmission" s
    JOIN "ClaimItem" c ON c.id = s."claimItemId" AND c."organizationId" = s."organizationId"
    JOIN "RecoveryPackage" p ON p.id = s."packageId" AND p."organizationId" = s."organizationId"
   WHERE (c."caseId" IS DISTINCT FROM s."caseId")
      OR (p."claimItemId" IS DISTINCT FROM s."claimItemId")
      OR (p."packageDigest" IS DISTINCT FROM s."packageDigest")
      OR (s."approvalBasisReference" IS DISTINCT FROM
            ('rmp1:' || s."claimItemId" || ':' || s."caseId" || ':' || p."packageVersion" || ':' || p."digestVersion" || ':' || p."packageDigest"));
  IF v IS NOT NULL THEN
    RAISE EXCEPTION 'INCONSISTENT[3] submission binding mismatch: %', v;
  END IF;

  -- 4) Submission 必须存在同租户 Package（缺失即失败；跨租户由 3) 的 join 条件覆盖）
  SELECT string_agg(s.id, ', ') INTO v
    FROM "RecoveryManualSubmission" s
   WHERE NOT EXISTS (
       SELECT 1 FROM "RecoveryPackage" p
        WHERE p.id = s."packageId" AND p."organizationId" = s."organizationId");
  IF v IS NOT NULL THEN
    RAISE EXCEPTION 'INCONSISTENT[4] submission without same-tenant package: %', v;
  END IF;

  -- 5) approvalId 唯一 + 绑定关系一致（同一租户内不得复用；且必须存在对应审批审计事件）
  SELECT string_agg(x."approvalId", ', ') INTO v
    FROM (SELECT "organizationId", "approvalId" FROM "RecoveryManualSubmission"
           WHERE "approvalId" IS NOT NULL
           GROUP BY "organizationId", "approvalId" HAVING count(*) > 1) x;
  IF v IS NOT NULL THEN
    RAISE EXCEPTION 'INCONSISTENT[5a] duplicated approvalId: %', v;
  END IF;
  SELECT string_agg(s.id, ', ') INTO v
    FROM "RecoveryManualSubmission" s
   WHERE NOT EXISTS (
       SELECT 1 FROM "AuditLog" a
        WHERE a.id = s."approvalId" AND a."organizationId" = s."organizationId"
          AND a.action = 'recovery.review_approved');
  IF v IS NOT NULL THEN
    RAISE EXCEPTION 'INCONSISTENT[5b] submission approval event missing: %', v;
  END IF;

  -- 5c) approval 语义强校验（R43 S6 / MSG-20261001-38 CHANGE A）：
  --     授权当前 submission 的那次 approval 必须 —— 同租户、事件族 = recovery.review_approved、
  --     目标（entityType/entityId）= 本单位 Case、boundAction = recovery.manual_submit、
  --     boundPayload.basisReference = 本 submission 保存的 versioned basis（五元复合串，天然排除他案/他包 approval）、
  --     boundPayload.fingerprintVersion = v1。任一不满足即视为数据库不一致（fail-closed）。
  SELECT string_agg(s.id, ', ') INTO v
    FROM "RecoveryManualSubmission" s
    JOIN "AuditLog" a ON a.id = s."approvalId" AND a."organizationId" = s."organizationId"
   WHERE a.action IS DISTINCT FROM 'recovery.review_approved'
      OR a."entityType" IS DISTINCT FROM 'Case'
      OR a."entityId" IS DISTINCT FROM s."caseId"
      OR (a.changes ->> 'boundAction') IS DISTINCT FROM 'recovery.manual_submit'
      OR (a.changes -> 'boundPayload' ->> 'basisReference') IS DISTINCT FROM s."approvalBasisReference"
      OR (a.changes -> 'boundPayload' ->> 'fingerprintVersion') IS DISTINCT FROM 'v1';
  IF v IS NOT NULL THEN
    RAISE EXCEPTION 'INCONSISTENT[5c] submission approval binding mismatch: %', v;
  END IF;

  -- 6) SubmissionEvidence 全部同租户且引用有效
  SELECT string_agg(e.id, ', ') INTO v
    FROM "RecoveryManualSubmissionEvidence" e
   WHERE NOT EXISTS (
       SELECT 1 FROM "EvidenceArtifact" a
        WHERE a.id = e."evidenceId" AND a."organizationId" = e."organizationId")
      OR NOT EXISTS (
       SELECT 1 FROM "RecoveryManualSubmission" s
        WHERE s.id = e."submissionId" AND s."organizationId" = e."organizationId");
  IF v IS NOT NULL THEN
    RAISE EXCEPTION 'INCONSISTENT[6] submission evidence tenant/reference invalid: %', v;
  END IF;

  -- 7) Reference 与 Submission / ClaimItem 同租户
  SELECT string_agg(r.id, ', ') INTO v
    FROM "RecoveryManualSubmissionReference" r
   WHERE NOT EXISTS (
       SELECT 1 FROM "RecoveryManualSubmission" s
        WHERE s.id = r."submissionId" AND s."organizationId" = r."organizationId");
  IF v IS NOT NULL THEN
    RAISE EXCEPTION 'INCONSISTENT[7] reference tenant mismatch: %', v;
  END IF;

  -- 8) providerCaseRefCanonical 满足 canonical contract（非空 / 已 trim / NFKC / 无连续空格）且同租户无重复
  SELECT string_agg(r.id, ', ') INTO v
    FROM "RecoveryManualSubmissionReference" r
   WHERE char_length(r."providerCaseRefCanonical") = 0
      OR r."providerCaseRefCanonical" <> btrim(r."providerCaseRefCanonical")
      OR r."providerCaseRefCanonical" <> normalize(r."providerCaseRefCanonical", NFKC)
      OR r."providerCaseRefCanonical" LIKE '%  %';
  IF v IS NOT NULL THEN
    RAISE EXCEPTION 'INCONSISTENT[8a] canonical reference contract violated: %', v;
  END IF;
  SELECT string_agg(x."providerCaseRefCanonical", ', ') INTO v
    FROM (SELECT "organizationId", "providerCaseRefCanonical"
            FROM "RecoveryManualSubmissionReference"
           GROUP BY "organizationId", "providerCaseRefCanonical" HAVING count(*) > 1) x;
  IF v IS NOT NULL THEN
    RAISE EXCEPTION 'INCONSISTENT[8b] duplicated canonical reference: %', v;
  END IF;

  -- 9) 事实关系（**不判失败**、不修改）：历史 submission 引用的 package 已处于终态
  SELECT string_agg(s.id, ', ') INTO facts
    FROM "RecoveryManualSubmission" s
    JOIN "RecoveryPackage" p ON p.id = s."packageId" AND p."organizationId" = s."organizationId"
   WHERE p.status IN ('SUPERSEDED','WITHDRAWN');

  SELECT count(*) INTO subs FROM "RecoveryManualSubmission";
  SELECT count(*) INTO refs FROM "RecoveryManualSubmissionReference";

  RAISE NOTICE 'OK: recovery manual submission consistency (submissions=%, references=%)', subs, refs;
  IF facts IS NOT NULL THEN
    RAISE NOTICE 'FACT[9] historical submissions referencing terminal packages (report only, no repair): %', facts;
  END IF;
END
$$;
`;
}

// CLI：默认打印 SQL（供 psql 执行）；--help 输出说明。
if (process.argv[1] && process.argv[1].endsWith('check-recovery-manual-submission.mjs')) {
  if (process.argv.includes('--help')) {
    process.stdout.write(
      'usage: node tools/consistency/check-recovery-manual-submission.mjs | psql -v ON_ERROR_STOP=1\n' +
        'read-only consistency checker for R43 manual recovery submissions (detect != repair)\n',
    );
  } else {
    process.stdout.write(buildRecoveryManualConsistencySql());
  }
}
