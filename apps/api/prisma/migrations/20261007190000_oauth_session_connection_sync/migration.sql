-- ============================================================
-- CrossClaim — AGENT EXPERIENCE LAYER / P9（HOST 2026-10-07 授权）
-- B2 真实缺口最小补强：
--   1) OAuthAuthorizationSession —— durable OAuth 授权会话（state 摘要 + 一次性 + 绑定原 goal 以便恢复）
--   2) ConnectionSyncState        —— 既有 SourceConnection 的**同步检查点投影**（不是第二连接事实源）
-- tenant 保护：两张表 cc_tenant_* 基线（SyncState 带 connectionId → SourceConnection 同租户校验）+ 归属不可变
-- 依据：docs/releases/AGENT-EXPERIENCE-P9-OAUTH-SESSION-REPORT.md
-- ============================================================

CREATE TABLE "OAuthAuthorizationSession" (
  "id"             TEXT         NOT NULL,
  "organizationId" TEXT         NOT NULL,
  "userId"         TEXT         NOT NULL,
  "provider"       TEXT         NOT NULL,
  "callbackPath"   TEXT         NOT NULL,
  -- 只存 state 的 sha256，原始 state 永不落库（防泄漏 / 防重放探测）
  "stateDigest"    TEXT         NOT NULL,
  -- PKCE verifier 仅服务端使用；绝不出现在任何响应 / 日志 / 前端
  "codeVerifier"   TEXT,
  "redirectTarget" TEXT         NOT NULL,
  -- callback 成功后可恢复的原始 goal（可为空：纯连接授权）
  "resumeGoalId"   TEXT,
  "status"         TEXT         NOT NULL DEFAULT 'PENDING',
  "failureReason"  TEXT,
  "connectionId"   TEXT,
  "credentialRef"  TEXT,
  "initiatedAt"    TIMESTAMP(3) NOT NULL,
  "expiresAt"      TIMESTAMP(3) NOT NULL,
  "consumedAt"     TIMESTAMP(3),
  "createdAt"      TIMESTAMP(3) NOT NULL,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OAuthAuthorizationSession_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OAuthAuthorizationSession_status_chk" CHECK (
    "status" IN ('PENDING','CONSUMED','SUCCEEDED','FAILED')
  ),
  CONSTRAINT "OAuthAuthorizationSession_digest_chk" CHECK (length("stateDigest") = 64),
  CONSTRAINT "OAuthAuthorizationSession_window_chk" CHECK ("expiresAt" > "initiatedAt"),
  CONSTRAINT "OAuthAuthorizationSession_consumed_chk" CHECK (
    ("status" = 'PENDING' AND "consumedAt" IS NULL)
    OR ("status" <> 'PENDING' AND "consumedAt" IS NOT NULL)
  )
);
-- 重放保护：同租户同 state 摘要只允许一条
CREATE UNIQUE INDEX "OAuthAuthorizationSession_org_state_key"
  ON "OAuthAuthorizationSession"("organizationId", "stateDigest");
CREATE UNIQUE INDEX "OAuthAuthorizationSession_organizationId_id_key"
  ON "OAuthAuthorizationSession"("organizationId", "id");
CREATE INDEX "OAuthAuthorizationSession_scope_status_idx"
  ON "OAuthAuthorizationSession"("organizationId", "provider", "status", "expiresAt");

CREATE TABLE "ConnectionSyncState" (
  "id"                   TEXT         NOT NULL,
  "organizationId"       TEXT         NOT NULL,
  "connectionId"         TEXT         NOT NULL,
  -- 不透明检查点（cursor / checkpoint）；含义由各 provider adapter 解释
  "cursor"               TEXT,
  "lastSuccessfulSyncAt" TIMESTAMP(3),
  "lastAttemptAt"        TIMESTAMP(3),
  "lastError"            TEXT,
  "lastErrorAt"          TIMESTAMP(3),
  "consecutiveFailures"  INTEGER      NOT NULL DEFAULT 0,
  "retryState"           TEXT         NOT NULL DEFAULT 'IDLE',
  "nextRetryAt"          TIMESTAMP(3),
  "createdAt"            TIMESTAMP(3)  NOT NULL,
  "updatedAt"            TIMESTAMP(3)  NOT NULL,
  CONSTRAINT "ConnectionSyncState_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ConnectionSyncState_retry_chk" CHECK ("retryState" IN ('IDLE','BACKOFF','NEEDS_REAUTH')),
  CONSTRAINT "ConnectionSyncState_failures_chk" CHECK ("consecutiveFailures" >= 0)
);
-- 每个连接**恰好一条**状态（不是第二连接事实源）
CREATE UNIQUE INDEX "ConnectionSyncState_org_connection_key"
  ON "ConnectionSyncState"("organizationId", "connectionId");
CREATE UNIQUE INDEX "ConnectionSyncState_organizationId_id_key"
  ON "ConnectionSyncState"("organizationId", "id");

-- ---------- 身份不可改写 ----------
CREATE OR REPLACE FUNCTION "cc_oauth_session_identity_immutable"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."organizationId" IS DISTINCT FROM OLD."organizationId"
     OR NEW."userId"        IS DISTINCT FROM OLD."userId"
     OR NEW."provider"      IS DISTINCT FROM OLD."provider"
     OR NEW."stateDigest"   IS DISTINCT FROM OLD."stateDigest"
     OR NEW."callbackPath"  IS DISTINCT FROM OLD."callbackPath"
     OR NEW."redirectTarget" IS DISTINCT FROM OLD."redirectTarget"
     OR NEW."initiatedAt"   IS DISTINCT FROM OLD."initiatedAt"
     OR NEW."expiresAt"     IS DISTINCT FROM OLD."expiresAt"
     OR NEW."createdAt"     IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'OAUTH_SESSION_IDENTITY_IMMUTABLE: session identity must not be rewritten';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "cc_oauth_session_identity__OAuthAuthorizationSession" ON "OAuthAuthorizationSession";
CREATE TRIGGER "cc_oauth_session_identity__OAuthAuthorizationSession"
  BEFORE UPDATE ON "OAuthAuthorizationSession"
  FOR EACH ROW EXECUTE FUNCTION "cc_oauth_session_identity_immutable"();

CREATE OR REPLACE FUNCTION "cc_connection_sync_identity_immutable"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."organizationId" IS DISTINCT FROM OLD."organizationId"
     OR NEW."connectionId" IS DISTINCT FROM OLD."connectionId"
     OR NEW."createdAt"    IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'CONNECTION_SYNC_IDENTITY_IMMUTABLE: sync state identity must not be rewritten';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "cc_connection_sync_identity__ConnectionSyncState" ON "ConnectionSyncState";
CREATE TRIGGER "cc_connection_sync_identity__ConnectionSyncState"
  BEFORE UPDATE ON "ConnectionSyncState"
  FOR EACH ROW EXECUTE FUNCTION "cc_connection_sync_identity_immutable"();

-- ---------- tenant 保护（基线 + 归属不可变） ----------
DROP TRIGGER IF EXISTS "cc_tenant_oauthauthorizationsession" ON "OAuthAuthorizationSession";
CREATE TRIGGER "cc_tenant_oauthauthorizationsession"
  BEFORE INSERT OR UPDATE ON "OAuthAuthorizationSession"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity();

DROP TRIGGER IF EXISTS "cc_tenant_connectionsyncstate" ON "ConnectionSyncState";
CREATE TRIGGER "cc_tenant_connectionsyncstate"
  BEFORE INSERT OR UPDATE ON "ConnectionSyncState"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity('connectionId', 'SourceConnection');

DROP TRIGGER IF EXISTS "cc_tenant_immutable__OAuthAuthorizationSession" ON "OAuthAuthorizationSession";
CREATE TRIGGER "cc_tenant_immutable__OAuthAuthorizationSession"
  BEFORE UPDATE ON "OAuthAuthorizationSession"
  FOR EACH ROW EXECUTE FUNCTION cc_forbid_tenant_reassignment();

DROP TRIGGER IF EXISTS "cc_tenant_immutable__ConnectionSyncState" ON "ConnectionSyncState";
CREATE TRIGGER "cc_tenant_immutable__ConnectionSyncState"
  BEFORE UPDATE ON "ConnectionSyncState"
  FOR EACH ROW EXECUTE FUNCTION cc_forbid_tenant_reassignment();

-- 回滚（人工）：DROP TRIGGER / DROP TABLE（见上）
