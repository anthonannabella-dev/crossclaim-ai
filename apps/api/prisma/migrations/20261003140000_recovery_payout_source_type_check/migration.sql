-- G9（MASTER GAP CLOSURE）第三单元：RecoveryPayout.sourceType 闭合枚举 CHECK
-- 值集合来自 services/recovery/recovery-confirmation.ts 的 PAYOUT_SOURCE_TYPES（代码内闭合枚举）。

ALTER TABLE "RecoveryPayout"
  ADD CONSTRAINT "RecoveryPayout_sourceType_check"
  CHECK ("sourceType" IN ('PLATFORM_SETTLEMENT', 'BANK_TRANSFER', 'OTHER'));

-- 其余 G9 扫描候选为「平台/外部提供的动态字符串」（claimType / platformType / opportunityType / basisSource /
-- resultStatus 等），不存在闭合值集合，DB 层不做枚举 CHECK，改由形状/非空约束与应用层校验负责。
