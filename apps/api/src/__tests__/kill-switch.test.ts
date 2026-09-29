// MSG-20260929-53 — Kill Switch v1（设计要求逐项：fail-closed / 优先级 / 可见性 / 双人确认 / 审计字段）

import { describe, expect, it } from 'vitest';

import {
  KILL_SWITCH_DEFAULTS,
  KILL_SWITCH_REASON_CODES,
  __resetKillSwitchPending,
  changeKillSwitch,
  getKillSwitchStatus,
  resolveKillSwitch,
} from '../services/operations/kill-switch';

const ORG = 'cc000000-0000-4000-8000-0000000000f1';

function fakePrisma(audits: unknown[], logs: unknown[] = []) {
  return {
    auditLog: {
      create: async (args: { data: unknown }) => {
        audits.push(args.data);
        return args.data;
      },
      findMany: async () => logs,
    },
  } as never;
}

const owner = { organizationId: ORG, actorUserId: 'user-owner', role: 'OWNER' };
const admin = { organizationId: ORG, actorUserId: 'user-admin', role: 'ADMIN' };

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
    const audits: unknown[] = [];
    const prisma = fakePrisma(audits);
    expect((await getKillSwitchStatus({ prisma }, owner)).visibility).toBe('full');
    expect((await getKillSwitchStatus({ prisma }, admin)).visibility).toBe('full');
    expect((await getKillSwitchStatus({ prisma }, { organizationId: ORG, role: 'OPS' })).visibility).toBe('summary');
    for (const role of ['FINANCE', 'VIEWER', '']) {
      await expect(getKillSwitchStatus({ prisma }, { organizationId: ORG, role })).rejects.toThrowError();
    }
  });

  it('07 OPS 摘要不含操作者/原因（字段仅 scope/value/source）', async () => {
    const prisma = fakePrisma([]);
    const view = await getKillSwitchStatus({ prisma }, { organizationId: ORG, role: 'OPS' });
    for (const item of view.switches) {
      expect(Object.keys(item).sort()).toEqual(['scope', 'source', 'value']);
    }
  });
});

describe('Kill Switch — 权限与双人确认', () => {
  it('08 拉闸：OWNER 单人立即生效并写审计', async () => {
    __resetKillSwitchPending();
    const audits: unknown[] = [];
    const result = await changeKillSwitch({ prisma: fakePrisma(audits) }, owner, {
      scope: 'submission',
      target: 'disabled',
      reasonCode: 'MAINTENANCE',
    });
    expect(result.status).toBe('applied');
    expect(audits).toHaveLength(1);
    expect((audits[0] as { action: string }).action).toBe('killswitch.changed');
  });

  it('09 OPS/FINANCE 不能变更（403）', async () => {
    __resetKillSwitchPending();
    for (const role of ['OPS', 'FINANCE', 'VIEWER']) {
      await expect(
        changeKillSwitch({ prisma: fakePrisma([]) }, { organizationId: ORG, actorUserId: 'u', role }, {
          scope: 'submission',
          target: 'disabled',
          reasonCode: 'MAINTENANCE',
        }),
      ).rejects.toThrowError();
    }
  });

  it('10 开启需第二人确认：同人闭环被拒，另一 OWNER/ADMIN 确认后生效', async () => {
    __resetKillSwitchPending();
    const audits: unknown[] = [];
    const prisma = fakePrisma(audits);
    const request = await changeKillSwitch({ prisma }, owner, {
      scope: 'workflow',
      target: 'enabled',
      reasonCode: 'SECURITY_INCIDENT',
    });
    expect(request.status).toBe('awaiting_confirmation');
    expect(audits).toHaveLength(0);

    await expect(
      changeKillSwitch({ prisma }, owner, {
        scope: 'workflow',
        target: 'enabled',
        reasonCode: 'SECURITY_INCIDENT',
      }),
    ).rejects.toThrowError(/同一用户/);

    const confirmed = await changeKillSwitch({ prisma }, admin, {
      scope: 'workflow',
      target: 'enabled',
      reasonCode: 'SECURITY_INCIDENT',
    });
    expect(confirmed.status).toBe('applied');
    expect(confirmed.confirmationBy).toBe('user-admin');
    expect(audits).toHaveLength(1);
  });

  it('11 确认窗口超时 → 待确认失效（不可开启）', async () => {
    __resetKillSwitchPending();
    let clock = 1_000_000;
    const audits: unknown[] = [];
    const prisma = fakePrisma(audits);
    await changeKillSwitch({ prisma }, owner, {
      scope: 'integration',
      target: 'enabled',
      reasonCode: 'TESTING',
      now: () => clock,
    });
    clock += 16 * 60 * 1000;
    await expect(
      changeKillSwitch({ prisma }, admin, {
        scope: 'integration',
        target: 'enabled',
        reasonCode: 'TESTING',
        now: () => clock,
      }),
    ).rejects.toThrowError();
    expect(audits).toHaveLength(0);
  });

  it('12 reasonCode 白名单校验（含 OTHER 合法）', async () => {
    __resetKillSwitchPending();
    const prisma = fakePrisma([]);
    await expect(
      changeKillSwitch({ prisma }, owner, { scope: 'billing', target: 'disabled', reasonCode: 'BECAUSE' }),
    ).rejects.toThrowError();
    expect(KILL_SWITCH_REASON_CODES).toContain('OTHER');
    const ok = await changeKillSwitch({ prisma }, owner, {
      scope: 'billing',
      target: 'disabled',
      reasonCode: 'OTHER',
      note: 'planned drill',
    });
    expect(ok.status).toBe('applied');
  });
});
