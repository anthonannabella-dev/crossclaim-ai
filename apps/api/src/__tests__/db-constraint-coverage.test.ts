/**
 * G9（MASTER GAP CLOSURE）— DB 约束覆盖守卫。
 * 目的：枚举类 / 形状类列必须有数据库级约束，避免「Schema 有字段但无 DB constraint」。
 * 方式：静态读取全部迁移 SQL，断言关键 CHECK 与 append-only 触发器存在（防止后续被静默移除）。
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const API_ROOT = join(__dirname, '..', '..');
const MIGRATIONS_DIR = join(API_ROOT, 'prisma', 'migrations');
const SQL = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(MIGRATIONS_DIR, entry.name, 'migration.sql'))
  .map((file) => {
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return '';
    }
  })
  .join('\n');

const requireCheck = (constraint: string, pattern: RegExp) => {
  it('CHECK 存在：' + constraint, () => {
    const index = SQL.indexOf('"' + constraint + '"');
    expect(index, '缺少约束 ' + constraint).toBeGreaterThan(-1);
    expect(SQL.slice(index, index + 400)).toMatch(pattern);
  });
};

describe('G9 — 关键 DB 约束覆盖', () => {
  requireCheck('CustomsEntryFactRecord_source_check', /CHECK \("source" IN \(/);
  requireCheck('CustomsEntryFactRecord_jurisdiction_check', /CHECK \("jurisdiction" ~ /);
  requireCheck('CustomsEntryFactRecord_content_digest_shape', /CHECK \("contentDigest" ~ /);
  requireCheck('CustomsEntryDutyLineRecord_kind_check', /CHECK \("kind" IN \(/);
  requireCheck('CustomsEntryDutyLineRecord_currency_check', /CHECK \("currency" ~ /);
  requireCheck('CustomsEntryDutyLineRecord_line_ordinal_check', /CHECK \("lineOrdinal" >= 0\)/);
  requireCheck('CustomsEntryDutyLineRecord_amount_range_check', /CHECK \("amount" > /);
  requireCheck('CustomsDutyTruthRecord_input_digest_shape', /CHECK \("inputDigest" ~ /);
  requireCheck('CustomsRecoveryEstimateRecord_result_digest_shape', /CHECK \("resultDigest" ~ /);
  requireCheck('ReimbursementFact_currency_shape', /CHECK \("currency" ~ /);
  requireCheck('PlatformWriteAttempt_reconciledStatus_check', /CHECK \("reconciledStatus" IS NULL OR "reconciledStatus" IN \(/);
  requireCheck('PlatformWriteAttempt_targetKind_non_empty_check', /CHECK \(length\("targetKind"\) > 0\)/);
  requireCheck('FileAsset_sourceRef_non_empty_check', /CHECK \(length\("sourceRef"\) > 0\)/);
  requireCheck('ClaimItem_sourceFingerprint_non_empty_check', /CHECK \(length\("sourceFingerprint"\) > 0\)/);
  requireCheck('ProviderOutcomeFact_sourceRef_non_empty_check', /CHECK \(length\("sourceRef"\) > 0\)/);
  requireCheck('ReimbursementFact_sourceRef_non_empty_check', /CHECK \(length\("sourceRef"\) > 0\)/);
  requireCheck('RecoveryPayout_sourceType_check', /CHECK \("sourceType" IN \(/);
  requireCheck('ExpectedRecoveryBasis_currency_shape', /CHECK \("currency" ~ /);
  requireCheck('ClaimReconciliationProjection_currency_shape', /CHECK \("currency" ~ /);

  it('append-only 触发器存在：事实层 + 计算投影', () => {
    for (const trigger of [
      'cc_append_only__CustomsEntryFactRecord',
      'cc_append_only__CustomsEntryDutyLineRecord',
      'cc_append_only__CustomsDutyTruthRecord',
      'cc_append_only__CustomsDiscrepancyRecord',
      'cc_append_only__CustomsEligibilityRecord',
      'cc_append_only__CustomsRecoveryEstimateRecord',
    ]) {
      expect(SQL.includes('CREATE TRIGGER "' + trigger + '"'), '缺少 append-only 触发器 ' + trigger).toBe(true);
    }
  });

  it('投影表不允许「latest 覆盖」式设计：迁移中不出现针对投影表的 UPDATE 语句', () => {
    for (const table of [
      'CustomsDutyTruthRecord',
      'CustomsDiscrepancyRecord',
      'CustomsEligibilityRecord',
      'CustomsRecoveryEstimateRecord',
    ]) {
      const updatePattern = new RegExp('UPDATE "' + table + '"', 'g');
      expect(SQL.match(updatePattern)).toBeNull();
    }
  });
});
