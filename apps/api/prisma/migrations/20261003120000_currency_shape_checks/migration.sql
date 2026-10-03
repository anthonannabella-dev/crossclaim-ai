-- CUSTOMS GAP G4 → G9 复核（MASTER GAP CLOSURE）：可枚举/形状列缺 DB 约束
-- 本批只补 currency 形状（ISO 4217 三位大写）：应用层已强校验，DB 层此前仅继承默认（无约束）。
-- 不改语义、不迁移数据；对既有非法值会 fail-closed（当前库不存在此类值）。

ALTER TABLE "ReimbursementFact"
  ADD CONSTRAINT "ReimbursementFact_currency_shape" CHECK ("currency" ~ '^[A-Z]{3}$');

ALTER TABLE "ExpectedRecoveryBasis"
  ADD CONSTRAINT "ExpectedRecoveryBasis_currency_shape" CHECK ("currency" ~ '^[A-Z]{3}$');

ALTER TABLE "ClaimReconciliationProjection"
  ADD CONSTRAINT "ClaimReconciliationProjection_currency_shape" CHECK ("currency" ~ '^[A-Z]{3}$');

-- 其余 G9 候选（status / kind / mode 类枚举列）见 docs/releases/G9-CONSTRAINT-GAP-SCAN.md，需逐个核对允许值后再补。
