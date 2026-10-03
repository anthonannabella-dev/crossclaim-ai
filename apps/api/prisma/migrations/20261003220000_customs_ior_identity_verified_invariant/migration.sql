-- CHANGE A（MSG-20261003-137）：IOR 身份事实的 VERIFIED 不变量必须由 DB 保证。
-- 背景：CustomsIorIdentityFact 是身份"事实真值"表；service 层不生成非法组合不能替代 DB invariant。
-- 禁止落库的组合：verificationStatus = VERIFIED 且 (verificationSource = NONE 或 verifiedAt IS NULL)。

ALTER TABLE "CustomsIorIdentityFact"
  ADD CONSTRAINT "CustomsIorIdentityFact_verified_needs_source"
    CHECK ("verificationStatus" <> 'VERIFIED' OR "verificationSource" <> 'NONE'),
  ADD CONSTRAINT "CustomsIorIdentityFact_verified_needs_verified_at"
    CHECK ("verificationStatus" <> 'VERIFIED' OR "verifiedAt" IS NOT NULL);
