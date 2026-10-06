// P6-PROD-U1 schema / migration 合同测试（只读 schema.prisma / migration SQL / state-machine.ts，不需要数据库）
// ---------------------------------------------------------------------------
// 目的：把 HOST AUTHORIZATION 2026-10-06 的耐久底座硬要求钉死在 CI 上：
//   · PLATFORM_LEVEL：五张表都是平台级（无 organizationId / tenantId / customerId）
//   · 生命周期状态 TEXT + CHECK，且值域与 state-machine.ts 单源一致
//   · Strong dedupe：UNIQUE(verdictDigest) / UNIQUE(ticketDigest) / UNIQUE(idempotencyKey) / UNIQUE(reservationKey)
//   · Durable 状态机：非法跳转 fail-closed 触发器；terminal 不得再迁移
//   · 证据 append-only；outbox identity 不可改写；outbox 消费者交付幂等
//   · NO PRODUCTION ENABLEMENT：environment 只允许 SANDBOX
//   · migration 结构安全：无 DROP TABLE / 无 CREATE TYPE / 无 ALTER COLUMN / 无 DELETE / 无 TRUNCATE

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const API_ROOT = join(__dirname, '..', '..');
const SCHEMA = readFileSync(join(API_ROOT, 'prisma', 'schema.prisma'), 'utf8');
const STATE_MACHINE = readFileSync(
  join(API_ROOT, 'src', 'services', 'config-execution-durability', 'state-machine.ts'),
  'utf8',
);
const MIGRATION_DIR = '20261006120000_config_execution_durability';
const SQL = readFileSync(join(API_ROOT, 'prisma', 'migrations', MIGRATION_DIR, 'migration.sql'), 'utf8');
const SQL_CODE = SQL.split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n');

const DURABILITY_MODELS = [
  'ControlledConfigExecutionReservation',
  'ControlledConfigExecutionEvent',
  'ControlledConfigExecutionResult',
  'ControlledConfigExecutionOutbox',
  'ControlledConfigExecutionDelivery',
];

const modelBlock = (name: string): string => {
  const start = SCHEMA.indexOf(`model ${name} {`);
  if (start < 0) return '';
  return SCHEMA.slice(start, SCHEMA.indexOf('\n}', start));
};

// 从 state-machine.ts 读取 `export const NAME = ['A', 'B'] as const;` 的字面量值域。
const tsList = (name: string): string[] => {
  const m = new RegExp(`export const ${name}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as const;`).exec(STATE_MACHINE);
  if (!m) return [];
  return [...m[1].matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]);
};

// 从 state-machine.ts 读取 `export const NAME = { KEY: 'VALUE', ... } as const;` 的键值。
const tsRecord = (name: string): Array<[string, string]> => {
  const m = new RegExp(`export const ${name}\\s*=\\s*\\{([\\s\\S]*?)\\n\\} as const;`).exec(STATE_MACHINE);
  if (!m) return [];
  return [...m[1].matchAll(/([A-Z_]+)\s*:\s*'([A-Z_]+)'/g)].map((x) => [x[1], x[2]] as [string, string]);
};

// 取某个 CHECK 约束里的单引号字面量集合（按括号配对截取约束体，避免读到下一个约束）。
const checkValues = (constraint: string): string[] => {
  const at = SQL.indexOf(`CONSTRAINT "${constraint}"`);
  if (at < 0) return [];
  const open = SQL.indexOf('(', SQL.indexOf('CHECK', at));
  if (open < 0) return [];
  let depth = 0;
  let end = open;
  for (; end < SQL.length; end += 1) {
    const ch = SQL[end];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const body = SQL.slice(open, end);
  return [...body.matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]);
};

describe('P6-PROD-U1 Controlled Config Execution Durability（schema 合同）', () => {
  it('五张耐久底座表都在 schema.prisma 中', () => {
    for (const name of DURABILITY_MODELS) {
      expect(modelBlock(name), '缺少模型 ' + name).not.toBe('');
    }
  });

  it('PLATFORM_LEVEL：五张表都不带租户 / 客户列', () => {
    for (const name of DURABILITY_MODELS) {
      const block = modelBlock(name);
      expect(block, name + ' 不应有 organizationId').not.toMatch(/organizationId/);
      expect(block, name + ' 不应有 tenantId').not.toMatch(/tenantId/);
      expect(block, name + ' 不应有 customerId').not.toMatch(/customerId/);
    }
  });

  it('生命周期状态用 String（TEXT），不是 Prisma enum', () => {
    expect(modelBlock('ControlledConfigExecutionReservation')).toMatch(/status\s+String/);
    expect(modelBlock('ControlledConfigExecutionEvent')).toMatch(/kind\s+String/);
    expect(modelBlock('ControlledConfigExecutionResult')).toMatch(/resultCode\s+String/);
    expect(modelBlock('ControlledConfigExecutionResult')).toMatch(/semantics\s+String/);
  });

  it('Strong dedupe：UNIQUE(verdict/ticket/idempotency/reservationKey) + 证据唯一键', () => {
    const reservation = modelBlock('ControlledConfigExecutionReservation');
    expect(reservation).toMatch(/reservationKey\s+String\s+@unique/);
    expect(reservation).toMatch(/authorizationVerdictDigest\s+String\s+@unique/);
    expect(reservation).toMatch(/authorizationTicketDigest\s+String\s+@unique/);
    expect(reservation).toMatch(/idempotencyKey\s+String\s+@unique/);
    expect(modelBlock('ControlledConfigExecutionEvent')).toMatch(/@@unique\(\[reservationId, seq\]\)/);
    expect(modelBlock('ControlledConfigExecutionResult')).toMatch(/reservationId\s+String\s+@unique/);
    expect(modelBlock('ControlledConfigExecutionOutbox')).toMatch(/eventKey\s+String\s+@unique/);
    expect(modelBlock('ControlledConfigExecutionDelivery')).toMatch(/@@unique\(\[outboxId, consumerRef\]\)/);
  });

  it('lease / ownership 字段齐全（ownerRef / leaseId / acquiredAt / renewedAt / expiresAt）', () => {
    const reservation = modelBlock('ControlledConfigExecutionReservation');
    for (const field of ['ownerRef', 'leaseId', 'leaseAcquiredAt', 'leaseRenewedAt', 'leaseExpiresAt', 'executionAttempt']) {
      expect(reservation, '缺少 ' + field).toMatch(new RegExp(`${field}\\s+`));
    }
  });

  it('DB CHECK 的值域与 state-machine.ts 单源一致', () => {
    const pairs: Array<[string, string]> = [
      ['ControlledConfigExecutionReservation_status_chk', 'CONFIG_EXECUTION_RESERVATION_STATES'],
      ['ControlledConfigExecutionReservation_environment_chk', 'CONFIG_EXECUTION_ENVIRONMENTS'],
      ['ControlledConfigExecutionReservation_mode_chk', 'CONFIG_EXECUTION_MODES'],
      ['ControlledConfigExecutionEvent_kind_chk', 'CONFIG_EXECUTION_EVENT_KINDS'],
      ['ControlledConfigExecutionResult_status_chk', 'CONFIG_EXECUTION_TERMINAL_STATES'],
      ['ControlledConfigExecutionResult_code_chk', 'CONFIG_EXECUTION_RESULT_CODES'],
      ['ControlledConfigExecutionResult_evidence_source_chk', 'CONFIG_EXECUTION_EVIDENCE_SOURCES'],
      ['ControlledConfigExecutionOutbox_topic_chk', 'CONFIG_EXECUTION_OUTBOX_TOPICS'],
    ];
    for (const [constraint, constant] of pairs) {
      const dbValues = checkValues(constraint);
      const tsValues = tsList(constant);
      expect(dbValues.length, constraint + ' 未在 migration 里找到值域').toBeGreaterThan(0);
      expect(tsValues.length, constant + ' 未在 state-machine.ts 里找到值域').toBeGreaterThan(0);
      expect(dbValues.slice().sort(), constraint + ' 必须与 ' + constant + ' 完全一致').toEqual(
        tsValues.slice().sort(),
      );
    }
  });

  it('resultCode → semantics 一一对应，且失败/未知结果不携带 COMMITTED 语义', () => {
    const semantics = tsRecord('CONFIG_EXECUTION_RESULT_SEMANTICS');
    expect(semantics.length).toBeGreaterThanOrEqual(10);
    for (const [code, value] of semantics) {
      expect(SQL, `${code} 的 semantics 未写进 migration`).toContain(
        `("resultCode" = '${code}' AND "semantics" = '${value}')`,
      );
      if (code !== 'COMMITTED') {
        expect(value, `${code} 不得携带 COMMITTED 语义`).not.toBe('SANDBOX_CONFIG_MUTATION_COMMITTED');
      }
    }
    const statuses = tsRecord('CONFIG_EXECUTION_RESULT_CODE_STATUS');
    for (const [code] of semantics) {
      expect(statuses.map((s) => s[0]), `${code} 缺 resultCode → status 映射`).toContain(code);
    }
  });

  it('Durable 状态机：非法跳转 fail-closed + terminal 不得再迁移', () => {
    expect(SQL).toMatch(
      /CREATE TRIGGER "cc_config_execution_status_transition"[\s\S]{0,120}BEFORE UPDATE ON "ControlledConfigExecutionReservation"/,
    );
    expect(SQL).toMatch(/CONFIG_EXECUTION_ILLEGAL_TRANSITION/);
    expect(SQL).toMatch(/CONFIG_EXECUTION_TERMINAL_IMMUTABLE/);
    expect(SQL).toMatch(/CONFIG_EXECUTION_IDENTITY_IMMUTABLE/);
    expect(SQL).toMatch(/OLD\."status" = 'RESERVED' AND NEW\."status" IN \('EXECUTING','CANCELLED','SUPERSEDED'\)/);
  });

  it('证据 append-only：事件 / 终态结果 / 交付账本都有 cc_append_only__ 触发器', () => {
    for (const table of [
      'ControlledConfigExecutionEvent',
      'ControlledConfigExecutionResult',
      'ControlledConfigExecutionDelivery',
    ]) {
      expect(SQL).toMatch(
        new RegExp('CREATE TRIGGER "cc_append_only__' + table + '"[\\s\\S]{0,160}BEFORE UPDATE OR DELETE'),
      );
    }
  });

  it('outbox identity 不可改写（只允许 dispatchedAt / dispatchAttempts）+ reservation 不可删除', () => {
    expect(SQL).toMatch(
      /CREATE TRIGGER "cc_outbox_identity_immutable__ControlledConfigExecutionOutbox"[\s\S]{0,120}BEFORE UPDATE ON/,
    );
    expect(SQL).toMatch(
      /CREATE TRIGGER "cc_no_delete__ControlledConfigExecutionReservation"[\s\S]{0,120}BEFORE DELETE ON/,
    );
  });

  it('NO PRODUCTION ENABLEMENT：environment 只允许 SANDBOX、没有 production 状态', () => {
    expect(checkValues('ControlledConfigExecutionReservation_environment_chk')).toEqual(['SANDBOX']);
    expect(SQL_CODE).not.toMatch(/PRODUCTION_APPLIED/);
    expect(SQL_CODE).not.toMatch(/ROLLED_OUT/);
    expect(SQL_CODE).not.toMatch(/DEPLOYED/);
  });

  it('migration 结构安全：不删表 / 不建类型 / 不改列 / 不删数据', () => {
    expect(SQL_CODE).not.toMatch(/DROP\s+TABLE/i);
    expect(SQL_CODE).not.toMatch(/CREATE\s+TYPE/i);
    expect(SQL_CODE).not.toMatch(/ALTER\s+COLUMN/i);
    expect(SQL_CODE).not.toMatch(/^\s*DELETE\s+FROM/im);
    expect(SQL_CODE).not.toMatch(/TRUNCATE/i);
    const drops = [...SQL_CODE.matchAll(/DROP\s+(\w+)/gi)].map((m) => m[1].toUpperCase());
    expect([...new Set(drops)]).toEqual(['TRIGGER']);
  });

  it('migration 覆盖恰好这五张新表', () => {
    const created = [...SQL_CODE.matchAll(/CREATE TABLE "(\w+)"/g)].map((m) => m[1]);
    expect(created.slice().sort()).toEqual(DURABILITY_MODELS.slice().sort());
  });
});
