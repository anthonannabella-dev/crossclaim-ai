/**
 * RSI-RT-06 平台级自治状态表 —— 合同测试（MSG-20261005-01 = PASS WITH REVISE）
 * ---------------------------------------------------------------
 * 只读 schema.prisma / migration SQL / rsi-lifecycle.ts，不需要数据库。
 * 目的：把本轮裁决的五条硬要求钉死在 CI 上，避免以后被静默改回。
 *   · PLATFORM_LEVEL：无 organizationId / tenantId / customerId
 *   · 生命周期状态 TEXT + CHECK，且值域与 rsi-lifecycle.ts 单源一致
 *   · Incident / Task / Candidate / Promotion 各带 UNIQUE(dedupeKey)
 *   · AutonomyLease.renewedAt 存在，taskId 唯一
 *   · 证据表 append-only；PromotionDecision judgeRef <> candidate.builderRef
 *   · migration 结构安全：无 DROP TABLE / 无 CREATE TYPE / 无 ALTER COLUMN
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const API_ROOT = join(__dirname, '..', '..');
const SCHEMA = readFileSync(join(API_ROOT, 'prisma', 'schema.prisma'), 'utf8');
const LIFECYCLE = readFileSync(join(API_ROOT, 'src', 'services', 'autonomy', 'rsi-lifecycle.ts'), 'utf8');
const MIGRATION_DIR = '20261005000000_rsi_autonomy_state_persistence';
const SQL = readFileSync(join(API_ROOT, 'prisma', 'migrations', MIGRATION_DIR, 'migration.sql'), 'utf8');
/** 结构安全检查只看真实语句；注释里出现「DROP TABLE」这类字样不该触发误报。 */
const SQL_CODE = SQL.split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n');

const modelBlock = (name: string): string => {
  const start = SCHEMA.indexOf(`model ${name} {`);
  if (start < 0) return '';
  return SCHEMA.slice(start, SCHEMA.indexOf('\n}', start));
};

/** 从 rsi-lifecycle.ts 读取 `export const NAME = ['A', 'B'] as const;` 的字面量值域。 */
const tsStates = (name: string): string[] => {
  const m = new RegExp(`${name}\\s*(?::[^=]+)?=\\s*\\[([\\s\\S]*?)\\]`).exec(LIFECYCLE);
  if (!m) return [];
  return [...m[1].matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]);
};

/** 从 migration 里取某个 CHECK 约束的 IN ( ... ) 值域。 */
const checkStates = (constraint: string): string[] => {
  const at = SQL.indexOf(`"${constraint}"`);
  if (at < 0) return [];
  const m = /IN\s*\(([^)]*)\)/.exec(SQL.slice(at, at + 500));
  if (!m) return [];
  return [...m[1].matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]);
};

const RSI_MODELS = [
  'AutonomyIncident',
  'AutonomyTask',
  'AutonomyCandidate',
  'AutonomyEvaluationRun',
  'AutonomyMetricResult',
  'AutonomyPromotionDecision',
  'AutonomyRollbackRecord',
  'AutonomyLease',
];

describe('RSI-RT-06 平台级自治状态表（MSG-20261005-01）', () => {
  it('八张 RSI 表都在 schema.prisma 中', () => {
    for (const name of RSI_MODELS) expect(modelBlock(name), '缺少模型 ' + name).not.toBe('');
  });

  it('RSI_PLATFORM_SCOPE_EXCEPTION：不带任何租户/客户列', () => {
    for (const name of RSI_MODELS) {
      const block = modelBlock(name);
      expect(block, name + ' 不应有 organizationId').not.toMatch(/organizationId/);
      expect(block, name + ' 不应有 tenantId').not.toMatch(/tenantId/);
      expect(block, name + ' 不应有 customerId').not.toMatch(/customerId/);
    }
  });

  it('生命周期状态用 String（TEXT），不是 Prisma enum', () => {
    for (const name of ['AutonomyIncident', 'AutonomyTask', 'AutonomyCandidate', 'AutonomyLease']) {
      expect(modelBlock(name)).toMatch(/status\s+String/);
    }
    expect(modelBlock('AutonomyEvaluationRun')).toMatch(/status\s+String/);
    expect(modelBlock('AutonomyPromotionDecision')).toMatch(/decision\s+String/);
  });

  it('Incident / Task / Candidate / Promotion 各带 UNIQUE(dedupeKey)', () => {
    for (const name of [
      'AutonomyIncident',
      'AutonomyTask',
      'AutonomyCandidate',
      'AutonomyPromotionDecision',
    ]) {
      expect(modelBlock(name), name + ' 缺 UNIQUE(dedupeKey)').toMatch(/@@unique\(\[dedupeKey\]\)/);
    }
  });

  it('AutonomyLease：taskId 唯一 + renewedAt 存在（可用 now - renewedAt 判断健康）', () => {
    const lease = modelBlock('AutonomyLease');
    expect(lease).toMatch(/taskId\s+String\s+@unique/);
    expect(lease).toMatch(/renewedAt\s+DateTime/);
    expect(lease).toMatch(/ownerRef\s+String/);
    expect(lease).toMatch(/expiresAt\s+DateTime/);
  });

  it('DB CHECK 的生命周期值域与 rsi-lifecycle.ts 单源一致', () => {
    const pairs: Array<[string, string]> = [
      ['AutonomyIncident_status_chk', 'RSI_INCIDENT_STATES'],
      ['AutonomyTask_status_chk', 'RSI_TASK_STATES'],
      ['AutonomyCandidate_status_chk', 'RSI_CANDIDATE_STATES'],
      ['AutonomyLease_status_chk', 'RSI_LEASE_STATES'],
      ['AutonomyEvaluationRun_kind_chk', 'RSI_EVALUATION_KINDS'],
      ['AutonomyEvaluationRun_status_chk', 'RSI_EVALUATION_RUN_STATES'],
      ['AutonomyPromotionDecision_decision_chk', 'RSI_PROMOTION_DECISIONS'],
      ['AutonomyIncident_risk_class_chk', 'RSI_RISK_CLASSES'],
      ['AutonomyTask_risk_class_chk', 'RSI_RISK_CLASSES'],
    ];
    for (const [constraint, constant] of pairs) {
      const dbValues = checkStates(constraint);
      const tsValues = tsStates(constant);
      expect(dbValues.length, constraint + ' 未在 migration 里找到值域').toBeGreaterThan(0);
      expect(tsValues.length, constant + ' 未在 rsi-lifecycle.ts 里找到值域').toBeGreaterThan(0);
      expect(dbValues.slice().sort(), constraint + ' 必须与 ' + constant + ' 完全一致').toEqual(tsValues.slice().sort());
    }
  });

  it('证据表 append-only：三张表都有 cc_append_only__ 触发器', () => {
    for (const table of ['AutonomyMetricResult', 'AutonomyPromotionDecision', 'AutonomyRollbackRecord']) {
      expect(SQL).toMatch(
        new RegExp('CREATE TRIGGER "cc_append_only__' + table + '"[\\s\\S]{0,160}BEFORE UPDATE OR DELETE'),
      );
    }
  });

  it('Builder/Judge 分离：PromotionDecision 插入前校验 judgeRef <> candidate.builderRef', () => {
    expect(SQL).toMatch(
      /CREATE TRIGGER "cc_rsi_promotion_judge_separation"[\s\S]{0,160}BEFORE INSERT ON "AutonomyPromotionDecision"/,
    );
    expect(SQL).toMatch(/RSI_BUILDER_JUDGE_SAME_ACTOR/);
    expect(SQL).toMatch(/NEW\."judgeRef" = builder/);
  });

  it('migration 结构安全：不删表 / 不建类型 / 不改列 / 不删数据', () => {
    expect(SQL_CODE).not.toMatch(/DROP\s+TABLE/i);
    expect(SQL_CODE).not.toMatch(/CREATE\s+TYPE/i);
    expect(SQL_CODE).not.toMatch(/ALTER\s+COLUMN/i);
    expect(SQL_CODE).not.toMatch(/^\s*DELETE\s+FROM/im);
    expect(SQL_CODE).not.toMatch(/TRUNCATE/i);
    // 只允许 DROP 一种对象：本 migration 自建的触发器（保证可重复执行）。
    const drops = [...SQL_CODE.matchAll(/DROP\s+(\w+)/gi)].map((m) => m[1].toUpperCase());
    expect([...new Set(drops)]).toEqual(['TRIGGER']);
  });

  it('migration 覆盖恰好 8 张新表', () => {
    const created = [...SQL_CODE.matchAll(/CREATE TABLE "(\w+)"/g)].map((m) => m[1]);
    expect(created.slice().sort()).toEqual(RSI_MODELS.slice().sort());
  });
});
