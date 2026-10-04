-- CA-4 FINAL REVISE（MSG-20261004-07 CHANGE FINAL-D1）
-- 受控 UPDATE 必须是一次真正的状态迁移：同状态 UPDATE 一律拒绝，
-- 避免出现「Session 内容变化但没有对应 append-only SessionEvent」的旁路。
-- 只替换守卫函数体；触发器本身沿用 20261004050000 的定义。

CREATE OR REPLACE FUNCTION cc_customs_broker_auth_session_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."organizationId" <> OLD."organizationId" THEN
    RAISE EXCEPTION 'CUSTOMS_BROKER_AUTH_SESSION_TENANT: organizationId is immutable';
  END IF;
  IF NEW."sessionId" <> OLD."sessionId"
     OR NEW."principalRef" <> OLD."principalRef"
     OR NEW."brokerRef" <> OLD."brokerRef"
     OR NEW."providerRef" <> OLD."providerRef"
     OR NEW."jurisdiction" <> OLD."jurisdiction"
     OR NEW."authorizationType" <> OLD."authorizationType"
     OR NEW."route" <> OLD."route"
     OR NEW."requestedScope" <> OLD."requestedScope"
     OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'CUSTOMS_BROKER_AUTH_SESSION_IDENTITY_IMMUTABLE: session identity fields cannot be updated';
  END IF;
  IF NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'CUSTOMS_BROKER_AUTH_SESSION_VERSION: version must increment by exactly 1 (got % -> %)', OLD."version", NEW."version";
  END IF;
  -- CHANGE FINAL-D1：每一次 session mutation 必须是一次状态迁移
  IF NEW."status" = OLD."status" THEN
    RAISE EXCEPTION 'CUSTOMS_BROKER_AUTH_SESSION_TRANSITION_REQUIRED: same-status UPDATE is not allowed (status=%)', OLD."status";
  END IF;
  IF NOT (
    (OLD."status" = 'CREATED' AND NEW."status" IN ('CUSTOMER_ACTION_REQUIRED', 'SIGNED', 'REVOKED', 'EXPIRED'))
    OR (OLD."status" = 'CUSTOMER_ACTION_REQUIRED' AND NEW."status" IN ('SIGNED', 'EXPIRED', 'REVOKED'))
    OR (OLD."status" = 'SIGNED' AND NEW."status" IN ('PROVIDER_VERIFYING', 'VERIFIED', 'REJECTED', 'EXPIRED', 'REVOKED'))
    OR (OLD."status" = 'PROVIDER_VERIFYING' AND NEW."status" IN ('VERIFIED', 'REJECTED', 'EXPIRED', 'REVOKED'))
  ) THEN
    RAISE EXCEPTION 'CUSTOMS_BROKER_AUTH_SESSION_TRANSITION: % -> % is not an allowed transition', OLD."status", NEW."status";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
