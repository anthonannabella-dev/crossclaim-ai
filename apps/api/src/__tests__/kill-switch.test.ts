// MSG-20260929-53 / -60 — Kill Switch（离线契约：fail-closed / 优先级 / 可见性 / CSRF / note / 限流）

import { beforeEach, describe, expect, it } from 'vitest';

import {
  KILL_SWITCH_CONFIRM_WINDOW_MS,
  KILL_SWITCH_DEFAULTS,
  KILL_SWITCH_RATE_LIMIT_PER_MINUTE,
  KILL_SWITCH_REASON_CODES,
  CsrfRejectedError,
  RateLimitedError,
  __resetKillSwitchRateLimit,
  assertKillSwitchCsrf,
  canChangeKillSwitch,
  canConfirmKillSwitch,
  enforceKillSwitchRateLimit,
  getKillSwitchStatus,
  hashIdempotencyKey,
  resolveKillSwitch,
  validateKillSwitchNote,
} from '../services/operations/kill-switch';

const ORG = 'cc000000-0000-4000-8000-0000000000f1';

function fakePrisma(logs: unknown[] = []) {
  return {
    auditLog: {
      create: async (args: { data: unknown }) => args.data,
      findMany: async () => logs,
    },
    // MSG-20260929-60：读层新增控制面状态（KillSwitchRequest），离线替身返回空集
    killSwitchRequest: { findMany: async () => [] },
  } as never;
}

const owner = { organizationId: ORG, actorUserId: 'user-owner', role: 'OWNER' };
const admin = { organizationId: ORG, actorUserId: 'user-admin', role: 'ADMIN' };

beforeEach(() => {
  __resetKillSwitchRateLimit();
});

describe('Kill Switch — fail-closed 与默认值', () => {
  it('01 无配置时默认：五项 disabled、observability enabled', () => {
    for (const scope of ['submission', 'billing', 'integration', 'platform_connector', 'workflow'] as const) {
      expect(KILL_SWITCH_DEFAULTS[scope]).toBe('disabled');
      expect(resolveKillSwitch(undefined, scope, ORG)).toEqual({ value: 'disabled', source: 'default' });
    }
    expect(resolveKillSwitch(undefined, 'observability', ORG)).toEqual({
      value: 'enabled',
      source: 'default',
    });
  });

  it('02 非法/未知取值一律按 disabled 处理（fail-closed）', () => {
    expect(resolveKillSwitch({ global: { submission: 'ON' } }, 'submission', ORG).value).toBe('disabled');
    expect(resolveKillSwitch({ global: { submission: true } }, 'submission', ORG).value).toBe('disabled');
  });
});

describe('Kill Switch — 解析优先级 tenant > global > default', () => {
  it('03 tenant 更严格时取 disabled', () => {
    const config = { global: { billing: 'enabled' }, tenant: { [ORG]: { billing: 'disabled' } } };
    expect(resolveKillSwitch(config, 'billing', ORG)).toEqual({ value: 'disabled', source: 'tenant' });
  });

  it('04 tenant 更宽松时仍取更严格（global disabled 胜出）', () => {
    const config = { global: { billing: 'disabled' }, tenant: { [ORG]: { billing: 'enabled' } } };
    expect(resolveKillSwitch(config, 'billing', ORG).value).toBe('disabled');
  });

  it('05 仅 global 配置时使用 global', () => {
    expect(resolveKillSwitch({ global: { workflow: 'enabled' } }, 'workflow', ORG)).toEqual({
      value: 'enabled',
      source: 'global',
    });
  });
});

describe('Kill Switch — 可见性（最小暴露）', () => {
  it('06 OWNER/ADMIN 全量；OPS 仅摘要；FINANCE/VIEWER 403', async () => {
    const prisma = fakePrisma();
    expect((await getKillSwitchStatus({ prisma }, owner)).visibility).toBe('full');
    expect((await getKillSwitchStatus({ prisma }, admin)).visibility).toBe('full');
    expect((await getKillSwitchStatus({ prisma }, { organizationId: ORG, role: 'OPS' })).visibility).toBe('summary');
    for (const role of ['FINANCE', 'VIEWER', '']) {
      await expect(getKillSwitchStatus({ prisma }, { organizationId: ORG, role })).rejects.toThrowError();
    }
  });

  it('07 OPS 摘要不含操作者/原因（字段仅 scope/value/source）', async () => {
    const view = await getKillSwitchStatus({ prisma: fakePrisma() }, { organizationId: ORG, role: 'OPS' });
    for (const item of view.switches) {
      expect(Object.keys(item).sort()).toEqual(['scope', 'source', 'value']);
    }
  });

  it('08 OWNER 全量视图带控制面状态字段（controlState 至少存在）', async () => {
    const view = await getKillSwitchStatus({ prisma: fakePrisma() }, owner);
    for (const item of view.switches) {
      expect(item.controlState).toBe('NONE');
      expect(item.pendingRequest).toBeUndefined();
    }
  });
});

describe('Kill Switch — 角色矩阵（MSG-20260929-60：发起仅 OWNER，确认 OWNER/ADMIN）', () => {
  it('09 发起：仅 OWNER；确认：OWNER/ADMIN', () => {
    expect(canChangeKillSwitch('OWNER')).toBe(true);
    for (const role of ['ADMIN', 'OPS', 'FINANCE', 'VIEWER', undefined, '']) {
      expect(canChangeKillSwitch(role), String(role)).toBe(false);
    }
    expect(canConfirmKillSwitch('OWNER')).toBe(true);
    expect(canConfirmKillSwitch('ADMIN')).toBe(true);
    for (const role of ['OPS', 'FINANCE', 'VIEWER', undefined, '']) {
      expect(canConfirmKillSwitch(role), String(role)).toBe(false);
    }
  });

  it('10 确认窗口常量 = 15 分钟；reasonCode 白名单含 SECURITY_INCIDENT/OTHER', () => {
    expect(KILL_SWITCH_CONFIRM_WINDOW_MS).toBe(15 * 60 * 1000);
    expect(KILL_SWITCH_REASON_CODES).toContain('SECURITY_INCIDENT');
    expect(KILL_SWITCH_REASON_CODES).toContain('OTHER');
  });
});

describe('Kill Switch — CSRF（同源 + 自定义头；MSG-20260929-55 §11.2）', () => {
  const base = { host: 'localhost:3000', csrfHeader: '1' };

  it('11 同源 + 自定义头 → 通过；缺头 / 缺 Origin / 跨源 / 非法 Origin → 拒绝', () => {
    expect(() => assertKillSwitchCsrf({ ...base, origin: 'http://localhost:3000' })).not.toThrow();
    expect(() => assertKillSwitchCsrf({ ...base, referer: 'http://localhost:3000/operations' })).not.toThrow();
    expect(() => assertKillSwitchCsrf({ host: base.host, origin: 'http://localhost:3000' })).toThrowError(CsrfRejectedError);
    expect(() => assertKillSwitchCsrf({ ...base })).toThrowError(CsrfRejectedError);
    expect(() => assertKillSwitchCsrf({ ...base, origin: 'https://evil.example' })).toThrowError(CsrfRejectedError);
    expect(() => assertKillSwitchCsrf({ ...base, origin: 'not-a-url' })).toThrowError(CsrfRejectedError);
    expect(() => assertKillSwitchCsrf({ ...base, origin: 'http://localhost:3001' })).toThrowError(CsrfRejectedError);
  });
});

describe('Kill Switch — note 约束（≤200 字符 + 凭据拒绝）', () => {
  it('12 合法 note 通过；超长 / 凭据样式 → 拒绝', () => {
    expect(validateKillSwitchNote(undefined)).toBeUndefined();
    expect(validateKillSwitchNote('计划内演练')).toBe('计划内演练');
    expect(() => validateKillSwitchNote('x'.repeat(201))).toThrowError(/200/);
    expect(() => validateKillSwitchNote('token=abc123')).toThrowError();
    expect(() => validateKillSwitchNote('password: hunter2')).toThrowError();
    expect(() =>
      validateKillSwitchNote('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payloadpart'),
    ).toThrowError();
    // 长 hex / 长连续 base64 串同样视为凭据样式
    expect(() => validateKillSwitchNote('a'.repeat(40))).toThrowError();
    expect(() => validateKillSwitchNote('x'.repeat(40))).toThrowError();
    expect(validateKillSwitchNote('planned maintenance drill')).toBe('planned maintenance drill');
  });
});

describe('Kill Switch — 速率限制（同租户同人同 scope 5 次/分钟）', () => {
  it('13 第 6 次被拒；SECURITY_INCIDENT 不受限；不同 scope / 不同人各自独立', () => {
    const actor = { organizationId: ORG, actorUserId: 'user-owner' };
    for (let i = 0; i < KILL_SWITCH_RATE_LIMIT_PER_MINUTE; i += 1) {
      expect(() => enforceKillSwitchRateLimit(actor, 'submission', 'MAINTENANCE', 1_000_000 + i)).not.toThrow();
    }
    expect(() => enforceKillSwitchRateLimit(actor, 'submission', 'MAINTENANCE', 1_000_010)).toThrowError(
      RateLimitedError,
    );
    // 紧急关闭不受限（但审计必须带 emergency=true —— 见 DB 用例）
    for (let i = 0; i < 10; i += 1) {
      expect(() => enforceKillSwitchRateLimit(actor, 'submission', 'SECURITY_INCIDENT', 1_000_020 + i)).not.toThrow();
    }
    expect(() => enforceKillSwitchRateLimit(actor, 'billing', 'MAINTENANCE', 1_000_030)).not.toThrow();
    expect(() =>
      enforceKillSwitchRateLimit({ ...actor, actorUserId: 'other-user' }, 'submission', 'MAINTENANCE', 1_000_040),
    ).not.toThrow();
    // 窗口滚动：1 分钟后恢复
    expect(() => enforceKillSwitchRateLimit(actor, 'submission', 'MAINTENANCE', 1_000_000 + 61_000)).not.toThrow();
  });
});

describe('Kill Switch — 幂等键哈希', () => {
  it('14 同键同租户稳定、跨租户不同、且不含原文', () => {
    const key = '3f1a7f2e-1111-4222-8333-444455556666';
    const a = hashIdempotencyKey(ORG, key);
    expect(a).toBe(hashIdempotencyKey(ORG, key));
    expect(a).toHaveLength(32);
    expect(a).not.toContain(key);
    expect(a).not.toBe(hashIdempotencyKey('cc000000-0000-4000-8000-0000000000f2', key));
  });
});
