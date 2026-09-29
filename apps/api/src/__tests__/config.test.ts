/**
 * Wave 0 · 配置与日志（单元测试，零依赖）
 */

import { describe, expect, it } from 'vitest';
import { EnvError, EnvValuesError, envPresence, loadEnv, validateEnvValues } from '../config/env';
import { createLogger, isSensitiveKey, redact } from '../config/logger';

// ============================================================
describe('P2-1 env 取值校验（MSG-20260929-70）', () => {
  it('合法取值不报错', () => {
    const result = validateEnvValues({
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      AUDIT_IP_SALT: 'a'.repeat(20),
      STORAGE_URL_SECRET: 'b'.repeat(20),
      STORAGE_DRIVER: 'local',
      METRICS_ENABLED: 'false',
      PORT: '3000',
      NODE_ENV: 'production',
    });
    expect(result.errors).toEqual([]);
  });

  it('非法取值只报变量名与原因码，不回显取值', () => {
    const result = validateEnvValues({
      DATABASE_URL: 'mysql://secret-user:secret-pass@host/db',
      AUDIT_IP_SALT: 'short',
      STORAGE_DRIVER: 'nfs',
      METRICS_ENABLED: 'yes',
      PORT: 'port',
      NODE_ENV: 'staging',
    });
    expect(result.errors).toEqual([
      'DATABASE_URL_INVALID_FORMAT',
      'AUDIT_IP_SALT_TOO_SHORT',
      'STORAGE_DRIVER_INVALID',
      'METRICS_ENABLED_INVALID',
      'PORT_INVALID',
      'NODE_ENV_INVALID',
    ]);
    const text = JSON.stringify(result) + new EnvValuesError(result.errors).message;
    for (const forbidden of ['secret-user', 'secret-pass', 'mysql://', 'short']) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });

  it('缺少 DATABASE_URL 只给 warning（启动期由 loadEnv fail fast）', () => {
    const result = validateEnvValues({});
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual(['DATABASE_URL_MISSING']);
  });
});

// ============================================================
describe('loadEnv', () => {
  it('缺必需变量时 fail fast，并一次列全所有缺失项', () => {
    expect(() => loadEnv({})).toThrow(EnvError);
    try {
      loadEnv({});
    } catch (err) {
      expect((err as EnvError).missing).toEqual(['DATABASE_URL']);
    }
  });

  it('缺失的可选变量使用默认值', () => {
    const env = loadEnv({ DATABASE_URL: 'postgresql://x' });
    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe('3000');
    expect(env.LOG_LEVEL).toBe('info');
  });

  it('空字符串视为未设置（不要用空串当值）', () => {
    const env = loadEnv({ DATABASE_URL: 'postgresql://x', PORT: '' });
    expect(env.PORT).toBe('3000');
  });

  it('envPresence 只报告是否设置，不回显值', () => {
    const presence = envPresence({ DATABASE_URL: 'secret-dsn' });
    expect(presence.DATABASE_URL).toBe(true);
    expect(Object.values(presence).every((v) => typeof v === 'boolean')).toBe(true);
  });
});

// ============================================================
describe('logger 脱敏', () => {
  it('识别敏感键名（含 snake_case / camelCase）', () => {
    for (const k of ['password', 'apiKey', 'api_key', 'JWT_SECRET', 'authorization', 'credentialRef']) {
      expect(isSensitiveKey(k), k).toBe(true);
    }
    for (const k of ['amount', 'currency', 'organizationId', 'caseNo']) {
      expect(isSensitiveKey(k), k).toBe(false);
    }
  });

  it('嵌套结构里的敏感字段被替换', () => {
    const out = redact({
      ok: 1,
      auth: { apiKey: 'sk-should-not-appear', nested: { password: 'p' } },
      list: [{ token: 't' }, { keep: 'v' }],
    }) as Record<string, unknown>;

    expect(JSON.stringify(out)).not.toContain('sk-should-not-appear');
    expect(JSON.stringify(out)).not.toContain('"p"');
    expect((out.list as Record<string, unknown>[])[1].keep).toBe('v');
  });

  it('Bearer / Basic 授权串整体脱敏', () => {
    expect(redact({ header: 'Bearer abc.def.ghi' })).toEqual({ header: '[REDACTED]' });
    expect(redact({ header: 'Basic dXNlcjpwYXNz' })).toEqual({ header: '[REDACTED]' });
  });

  it('循环引用与超深对象不会炸', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    const out = redact(a) as Record<string, unknown>;
    expect(out.name).toBe('a');
    expect(out.self).toBeDefined();
  });
});

describe('logger 输出', () => {
  function capture(level: 'debug' | 'info' | 'warn' | 'error') {
    const lines: string[] = [];
    const log = createLogger({ level, bindings: { service: 'test' }, sink: (l) => lines.push(l) });
    return { log, lines };
  }

  it('按级别过滤', () => {
    const { log, lines } = capture('warn');
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(lines).toHaveLength(2);
  });

  it('输出是单行合法 JSON，且带固定字段', () => {
    const { log, lines } = capture('debug');
    log.info('hello', { caseId: 'c1' });
    const parsed = JSON.parse(lines[0]);
    expect(parsed.msg).toBe('hello');
    expect(parsed.level).toBe('info');
    expect(parsed.service).toBe('test');
    expect(parsed.caseId).toBe('c1');
    expect(typeof parsed.ts).toBe('string');
  });

  it('日志里不会出现敏感值', () => {
    const { log, lines } = capture('debug');
    log.info('login', { password: 'hunter2', token: 'ghp_x' });
    expect(lines[0]).not.toContain('hunter2');
    expect(lines[0]).not.toContain('ghp_x');
    expect(lines[0]).toContain('[REDACTED]');
  });

  it('child logger 继承绑定字段', () => {
    const { log, lines } = capture('debug');
    log.child({ requestId: 'r1' }).info('scoped');
    const parsed = JSON.parse(lines[0]);
    expect(parsed.requestId).toBe('r1');
    expect(parsed.service).toBe('test');
  });
});
