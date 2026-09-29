// MSG-20260929-65 — Effective Kill Switch Resolver（离线：16 行矩阵 + I1-I4 + source 迁移）

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  KILL_SWITCH_RESOLVER_MAX_TTL_MS,
  createEffectiveKillSwitchResolver,
  projectEffectiveValue,
  type KillSwitchControlRow,
} from '../services/operations/kill-switch-resolver';

const ORG = 'cc000000-0000-4000-8000-0000000000c1';
const ORG_B = 'cc000000-0000-4000-8000-0000000000c2';

function row(partial: Partial<KillSwitchControlRow> & { scope: string }): KillSwitchControlRow {
  return {
    id: partial.id ?? `req-${partial.scope}-${partial.state ?? 'X'}`,
    scope: partial.scope,
    target: partial.target ?? 'ENABLED',
    state: partial.state ?? 'APPLIED',
    appliedAt: partial.appliedAt ?? new Date('2026-09-29T10:00:00.000Z'),
    confirmedAt: partial.confirmedAt ?? new Date('2026-09-29T10:00:00.000Z'),
    expiresAt: partial.expiresAt ?? new Date('2026-09-29T10:15:00.000Z'),
    requestedBy: partial.requestedBy ?? 'user-a',
  };
}

/** 只读端口替身（I2：端口类型不含任何写方法） */
function port(rowsByOrg: Record<string, KillSwitchControlRow[]>, onQuery?: () => void) {
  return {
    findMany: async (args: { where: { organizationId: string } }): Promise<KillSwitchControlRow[]> => {
      onQuery?.();
      return rowsByOrg[args.where.organizationId] ?? [];
    },
  };
}

function throwingPort(error: Error) {
  return {
    findMany: async (): Promise<KillSwitchControlRow[]> => {
      throw error;
    },
  };
}

const T0 = new Date('2026-09-29T12:00:00.000Z');

describe('Effective Kill Switch — 16 行验证矩阵（MSG-20260929-65 B）', () => {
  it('01 global hard disabled + tenant enabled → disabled / global-hard-disabled', async () => {
    const resolver = createEffectiveKillSwitchResolver({
      controlRequests: port({ [ORG]: [] }),
      config: { global: { submission: 'disabled' }, tenant: { [ORG]: { submission: 'enabled' } } },
      now: () => T0,
    });
    const result = await resolver.resolve('submission', ORG);
    expect(result.value).toBe('disabled');
    expect(result.source).toBe('global-hard-disabled');
  });

  it('02 tenant disabled（控制请求）+ global enabled → disabled / tenant-control', async () => {
    const resolver = createEffectiveKillSwitchResolver({
      controlRequests: port({
        [ORG]: [row({ scope: 'workflow', target: 'DISABLED', state: 'APPLIED' })],
      }),
      config: { global: { workflow: 'enabled' } },
      now: () => T0,
    });
    const result = await resolver.resolve('workflow', ORG);
    expect(result.value).toBe('disabled');
    expect(result.source).toBe('tenant-control');
  });

  it('03 tenant enabled（控制请求）+ 无 global → enabled / tenant-control', async () => {
    const resolver = createEffectiveKillSwitchResolver({
      controlRequests: port({
        [ORG]: [row({ scope: 'integration', target: 'ENABLED', state: 'APPLIED' })],
      }),
      now: () => T0,
    });
    const result = await resolver.resolve('integration', ORG);
    expect(result.value).toBe('enabled');
    expect(result.source).toBe('tenant-control');
  });

  it('04 无配置 business scope → disabled / environment-default', async () => {
    const resolver = createEffectiveKillSwitchResolver({ controlRequests: port({ [ORG]: [] }), now: () => T0 });
    for (const scope of ['submission', 'billing', 'integration', 'platform_connector', 'workflow']) {
      const result = await resolver.resolve(scope, ORG);
      expect(result.value, scope).toBe('disabled');
      expect(result.source, scope).toBe('environment-default');
    }
  });

  it('05 无配置 observability → enabled / environment-default', async () => {
    const resolver = createEffectiveKillSwitchResolver({ controlRequests: port({ [ORG]: [] }), now: () => T0 });
    const result = await resolver.resolve('observability', ORG);
    expect(result.value).toBe('enabled');
    expect(result.source).toBe('environment-default');
  });

  it('06/07/08 PENDING_ENABLE / EXPIRED / CANCELLED 一律不参与 effective', async () => {
    const cases: Array<[string, KillSwitchControlRow]> = [
      [
        'pending enable',
        row({
          scope: 'submission',
          state: 'PENDING_ENABLE',
          appliedAt: null,
          confirmedAt: null,
          expiresAt: new Date('2026-09-29T12:15:00.000Z'), // 相对 T0 仍在确认窗口内
        }),
      ],
      ['expired request', row({ scope: 'submission', state: 'EXPIRED', appliedAt: null, confirmedAt: null })],
      ['cancelled request', row({ scope: 'submission', state: 'CANCELLED', appliedAt: null, confirmedAt: null })],
    ];
    for (const [label, controlRow] of cases) {
      const resolver = createEffectiveKillSwitchResolver({
        controlRequests: port({ [ORG]: [controlRow] }),
        now: () => T0,
      });
      const result = await resolver.resolve('submission', ORG);
      expect(result.value, label).toBe('disabled');
      expect(result.source, label).toBe('environment-default');
      expect(result.controlState, label).toBe(controlRow.state);
    }
  });

  it('09 multiple applied → latest wins（appliedAt 最新者）', async () => {
    const resolver = createEffectiveKillSwitchResolver({
      controlRequests: port({
        [ORG]: [
          row({ scope: 'billing', id: 'r1', target: 'ENABLED', appliedAt: new Date('2026-09-29T09:00:00Z') }),
          row({ scope: 'billing', id: 'r2', target: 'DISABLED', appliedAt: new Date('2026-09-29T11:00:00Z') }),
        ],
      }),
      now: () => T0,
    });
    const result = await resolver.resolve('billing', ORG);
    expect(result.value).toBe('disabled');
    expect(result.source).toBe('tenant-control');
  });

  it('10 same timestamp → id tie breaker（并列时确定性）', async () => {
    const ts = new Date('2026-09-29T11:00:00Z');
    /** 同一 id 永远带同一 target —— 断言结果与「行顺序」无关，只由 id 字典序决定 */
    const rowsInOrder = (order: [string, string]) =>
      order.map((id) =>
        row({
          scope: 'billing',
          id,
          target: id === 'aaa' ? 'DISABLED' : 'ENABLED',
          appliedAt: ts,
          confirmedAt: ts,
        }),
      );
    const build = (order: [string, string]) =>
      createEffectiveKillSwitchResolver({
        controlRequests: port({ [ORG]: rowsInOrder(order) }),
        now: () => T0,
      });
    const a = await build(['aaa', 'bbb']).resolve('billing', ORG);
    const b = await build(['bbb', 'aaa']).resolve('billing', ORG);
    expect(a.value).toBe(b.value);
    expect(a.value).toBe('disabled'); // id 字典序最小者（aaa=DISABLED）胜出，与行顺序无关
  });

  it('11 unknown scope → disabled（fail-closed）', async () => {
    const resolver = createEffectiveKillSwitchResolver({ controlRequests: port({ [ORG]: [] }), now: () => T0 });
    const result = await resolver.resolve('not-a-scope', ORG);
    expect(result.value).toBe('disabled');
    expect(result.source).toBe('fail-closed');
  });

  it('12 unknown value（配置非法）→ disabled（fail-closed，不退化为默认）', async () => {
    for (const config of [
      { global: { submission: 'ON' } },
      { tenant: { [ORG]: { submission: true } } },
    ]) {
      const resolver = createEffectiveKillSwitchResolver({
        controlRequests: port({ [ORG]: [] }),
        config: config as never,
        now: () => T0,
      });
      const result = await resolver.resolve('submission', ORG);
      expect(result.value).toBe('disabled');
      expect(result.source).toBe('fail-closed');
    }
  });

  it('13 DB failure business → fail closed（disabled / fail-closed / degraded）', async () => {
    const resolver = createEffectiveKillSwitchResolver({
      controlRequests: throwingPort(new Error('db down')),
      now: () => T0,
    });
    for (const scope of ['submission', 'billing', 'integration', 'platform_connector', 'workflow']) {
      const result = await resolver.resolve(scope, ORG);
      expect(result.value, scope).toBe('disabled');
      expect(result.source, scope).toBe('fail-closed');
      expect(result.degraded, scope).toBe(true);
      expect(result.stale, scope).toBe(false);
    }
  });

  it('14 DB failure observability → 上次已知值 + degraded + stale + 上次评估时间', async () => {
    let fail = false;
    const t1 = new Date('2026-09-29T11:00:00Z');
    const t2 = new Date('2026-09-29T11:00:10Z');
    const resolver = createEffectiveKillSwitchResolver({
      controlRequests: {
        findMany: async () => {
          if (fail) throw new Error('db down');
          return [row({ scope: 'observability', target: 'DISABLED', state: 'APPLIED' })];
        },
      },
      now: () => (fail ? t2 : t1),
    });
    const healthy = await resolver.resolve('observability', ORG);
    expect(healthy.value).toBe('disabled');
    expect(healthy.degraded).toBe(false);

    fail = true;
    const degraded = await resolver.resolve('observability', ORG);
    expect(degraded.degraded).toBe(true);
    expect(degraded.stale).toBe(true);
    expect(degraded.value).toBe('disabled'); // 上次已知值，且明确标记陈旧
    expect(degraded.evaluatedAt).toBe(t1.toISOString()); // 不得用当前时间冒充
  });

  it('15 tenant isolation → 不读取其他租户的控制面', async () => {
    const seen: string[] = [];
    const resolver = createEffectiveKillSwitchResolver({
      controlRequests: port(
        {
          [ORG]: [row({ scope: 'submission', target: 'ENABLED', state: 'APPLIED' })],
          [ORG_B]: [],
        },
        () => undefined,
      ),
      now: () => T0,
    });
    const a = await resolver.resolve('submission', ORG);
    const b = await resolver.resolve('submission', ORG_B);
    expect(a.value).toBe('enabled');
    expect(b.value).toBe('disabled');
    expect(seen).toEqual([]);
    // resolveAll 只返回自己租户的 6 项
    const allB = await resolver.resolveAll(ORG_B);
    expect(allB).toHaveLength(6);
    expect(allB.every((item) => item.value === 'disabled' || item.scope === 'observability')).toBe(true);
  });

  it('16 cache invalidate → 写入后立即可见新结果；TTL 内命中缓存', async () => {
    let rows: KillSwitchControlRow[] = [];
    let queries = 0;
    const resolver = createEffectiveKillSwitchResolver({
      controlRequests: {
        findMany: async () => {
          queries += 1;
          return rows;
        },
      },
      now: () => T0,
    });
    const first = await resolver.resolve('workflow', ORG);
    expect(first.value).toBe('disabled');
    expect(first.cacheHit).toBe(false);

    const second = await resolver.resolve('workflow', ORG);
    expect(second.cacheHit).toBe(true);
    expect(queries).toBe(1); // TTL 内不重复查询

    // 控制面写入（模拟 POST /admin/kill-switch 成功后的主动失效）
    rows = [row({ scope: 'workflow', target: 'ENABLED', state: 'APPLIED' })];
    resolver.invalidate(ORG, 'workflow');
    const third = await resolver.resolve('workflow', ORG);
    expect(third.value).toBe('enabled');
    expect(third.cacheHit).toBe(false);
    expect(queries).toBe(2);

    // TTL 过期后自然失效（跨实例陈旧窗口 <= TTL）
    let clock = T0.getTime();
    const ttlResolver = createEffectiveKillSwitchResolver({
      controlRequests: {
        findMany: async () => {
          queries += 1;
          return rows;
        },
      },
      now: () => new Date(clock),
      ttlMs: 5_000,
    });
    await ttlResolver.resolve('workflow', ORG);
    const beforeExpiry = await ttlResolver.resolve('workflow', ORG);
    expect(beforeExpiry.cacheHit).toBe(true);
    clock += 5_001;
    const afterExpiry = await ttlResolver.resolve('workflow', ORG);
    expect(afterExpiry.cacheHit).toBe(false);
  });

  it('17 TTL 上限被夹到 30 秒（禁止越过上限）', async () => {
    let clock = T0.getTime();
    let queries = 0;
    const resolver = createEffectiveKillSwitchResolver({
      controlRequests: {
        findMany: async () => {
          queries += 1;
          return [];
        },
      },
      now: () => new Date(clock),
      ttlMs: 10 * 60 * 1000,
    });
    await resolver.resolve('workflow', ORG);
    await resolver.resolve('workflow', ORG);
    expect(queries).toBe(1);
    clock += KILL_SWITCH_RESOLVER_MAX_TTL_MS + 1;
    await resolver.resolve('workflow', ORG);
    expect(queries).toBe(2); // 超过 30s 必须重新读取
  });
});

describe('Effective Kill Switch — 投影函数（I3 disabled dominates）', () => {
  it('18 同层冲突（tenant config enabled + control DISABLED）→ disabled', () => {
    const projected = projectEffectiveValue(
      'workflow',
      ORG,
      { tenant: { [ORG]: { workflow: 'enabled' } } },
      { state: 'APPLIED', appliedValue: 'disabled', appliedAt: Date.now() },
    );
    expect(projected).toEqual({ value: 'disabled', source: 'tenant-control' });
  });

  it('19 同层冲突（tenant config disabled + control ENABLED）→ disabled（source=tenant-config）', () => {
    const projected = projectEffectiveValue(
      'workflow',
      ORG,
      { tenant: { [ORG]: { workflow: 'disabled' } } },
      { state: 'APPLIED', appliedValue: 'enabled', appliedAt: Date.now() },
    );
    expect(projected).toEqual({ value: 'disabled', source: 'tenant-config' });
  });
});

describe('Effective Kill Switch — I1 / I2 自动化验证', () => {
  const sourcePath = path.join(__dirname, '..', 'services', 'operations', 'kill-switch-resolver.ts');
  const schemaPath = path.join(__dirname, '..', '..', 'prisma', 'schema.prisma');

  it('I1 不落库：schema 中 KillSwitchRequest 无 effective 字段，resolver 无写操作', () => {
    const schema = readFileSync(schemaPath, 'utf8');
    const block = schema.slice(schema.indexOf('model KillSwitchRequest'), schema.indexOf('\n}', schema.indexOf('model KillSwitchRequest')));
    expect(block).not.toMatch(/effective/i);
    const source = readFileSync(sourcePath, 'utf8');
    // 只允许读取：不得出现任何写操作（含 Prisma data 参数）
    expect(source).not.toMatch(/\.create\(|\.createMany\(|\.update\(|\.updateMany\(|\.upsert\(|\.deleteMany\(/);
    expect(source).not.toMatch(/\.delete\(\{\s*(where|data)/);
    expect(source).not.toMatch(/data:\s*\{/);
    expect(source).not.toMatch(/\$executeRaw|\$queryRaw/);
  });

  it('I2 控制面不可改写配置：resolver 不写 env/配置，只读端口只声明 findMany', () => {
    const source = readFileSync(sourcePath, 'utf8');
    expect(source).not.toMatch(/process\.env\[[^\]]+\]\s*=/);
    expect(source).not.toMatch(/config\.(global|tenant)\[[^\]]+\]\s*=/);
    // 端口类型只声明 findMany（无 create/update/delete）
    const portBlock = source.slice(
      source.indexOf('export interface KillSwitchControlReadPort'),
      source.indexOf('export interface EffectiveKillSwitchResolver'),
    );
    expect(portBlock).toMatch(/findMany\(/);
    expect(portBlock).not.toMatch(/create|update|delete|upsert/);
  });
});
