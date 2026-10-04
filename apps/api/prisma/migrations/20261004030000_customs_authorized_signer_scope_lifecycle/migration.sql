-- CA-2 REVISE（MSG-20261004-02 CHANGE A/B/C）— scope 元素形状 / revoke 双向一致 / supersededAt 窗口。
-- 原迁移 20261004020000 已应用，本迁移只做约束收紧（不改列）。

CREATE OR REPLACE FUNCTION cc_customs_scope_tokens_valid(scope jsonb) RETURNS boolean AS $$
  SELECT jsonb_typeof(scope) = 'array'
     AND jsonb_array_length(scope) > 0
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements_text(scope) AS elem
       WHERE elem !~ '^(\*|[A-Z][A-Z0-9_]{2,63})$'
     );
$$ LANGUAGE sql IMMUTABLE;

ALTER TABLE "CustomsAuthorizedSignerFact" DROP CONSTRAINT IF EXISTS "CustomsAuthorizedSignerFact_scope_array";
ALTER TABLE "CustomsAuthorizedSignerFact"
  ADD CONSTRAINT "CustomsAuthorizedSignerFact_scope_tokens"
  CHECK (cc_customs_scope_tokens_valid("scope"));

ALTER TABLE "CustomsAuthorizedSignerFact" DROP CONSTRAINT IF EXISTS "CustomsAuthorizedSignerFact_revoked_consistent";
ALTER TABLE "CustomsAuthorizedSignerFact"
  ADD CONSTRAINT "CustomsAuthorizedSignerFact_revoked_bidirectional"
  CHECK (("revokedAt" IS NULL) = ("verificationStatus" <> 'REVOKED'));

ALTER TABLE "CustomsAuthorizedSignerFact" DROP CONSTRAINT IF EXISTS "CustomsAuthorizedSignerFact_supersede_window";
ALTER TABLE "CustomsAuthorizedSignerFact"
  ADD CONSTRAINT "CustomsAuthorizedSignerFact_supersede_window"
  CHECK ("supersededAt" IS NULL OR "supersededAt" >= "effectiveAt");
