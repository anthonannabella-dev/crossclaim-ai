-- ============================================================
-- CrossClaim — CARRIER QUEUE #9B FINAL-2（MSG-20261003-120 ⑫⑬⑭）
-- ------------------------------------------------------------
-- 数据库层收口「human report ≠ carrier confirmation」这条真值边界。
--   ⑫ CHANGE A：carrierConfirmationStatus 只允许 NOT_VERIFIED。
--      理由：append-only 只保证「插入后不能改」，不保证「插入时值一定真实」；
--      若 DB 允许任意字符串（APPROVED / CONFIRMED / ACCEPTED / RECOVERED），
--      未来新的内部写入路径或运维脚本就可能制造永久 append-only 的错误事实。
--   ⑬ RECOMMENDED：submissionMode 只允许 MANUAL（本表语义即人工提交见证）。
-- 说明：纯新增 CHECK 约束；不改既有列 / 索引 / 触发器；不写凭据或资金字段。
-- 边界：NO platform write · Payment = 0 · autopay = OFF · collection = OFF ·
--       external payment write = OFF · R13 HOLD · TRANSPORT = false · 无生产凭据。
-- ============================================================

-- ⑫ ONLY NOT_VERIFIED IS LEGAL
ALTER TABLE "CarrierManualSubmission"
  ADD CONSTRAINT "CarrierManualSubmission_carrierConfirmationStatus_check"
  CHECK ("carrierConfirmationStatus" = 'NOT_VERIFIED');

-- ⑬ manual submission attestation only
ALTER TABLE "CarrierManualSubmission"
  ADD CONSTRAINT "CarrierManualSubmission_submissionMode_check"
  CHECK ("submissionMode" = 'MANUAL');

-- 回滚（人工）：ALTER TABLE "CarrierManualSubmission" DROP CONSTRAINT <约束名>;
