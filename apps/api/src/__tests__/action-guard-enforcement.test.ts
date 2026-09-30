// ACTION GUARD enforcement wrapper 单测（MSG-20260930-03 项 ②）。
// CHANGE B（MSG-20260930-12）：本文件中的静态扫描只是**有限静态约定检查**（单引号字面量 + 同文件字符串），
// 不能证明调用关系/执行顺序，也不作为「业务强制覆盖」的验收证据。

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GUARD_ENFORCED_ACTIONS,
  withActionGuard,
} from '../services/action-guard/guard-enforcement';
import { createRuntimeActionGuard } from '../services/action-guard/runtime-guard';

const ORG = 'b2a00000-0000-4000-8000-0000000000aa';
const ACTOR = 'b2b00000-0000-4000-8000-0000000000bb';
const API_SRC = join(process.cwd(), 'src');

const satisfied = {
  tenantEnabled: true,
  writeEnabled: true,
  featureEnabled: Object.fromEntries(GUARD_ENFORCED_ACTIONS.map((a) => [a, true])),
  platformEnablement: Object.fromEntries(GUARD_ENFORCED_ACTIONS.map((a) => [a, true])),
  productionGate: 'SATISFIED' as const,
  hostApprovalGranted: true,
};

function guardWith(caps: typeof satisfied | undefined, auditEvents: unknown[] = []) {
  return createRuntimeActionGuard({
    capabilities: { resolve: async () => caps },
    audit: { write: (record) => void auditEvents.push(record) },
  });
}

describe('Action Guard enforcement wrapper', () => {
  it('01 ALLOW：work 恰好执行一次，并把 decision 透传', async () => {
    let calls = 0;
    const result = await withActionGuard({
      guard: guardWith(satisfied),
      input: { action: 'claim.submit', actorUserId: ACTOR, organizationId: ORG, approvalId: 'a-1' },
      work: (decision) => {
        calls += 1;
        return decision.code;
      },
    });
    expect(calls).toBe(1);
    expect(result).toBe('ACTION_GUARD_ALLOWED');
  });

  it('02 DENY：work 绝不执行（零副作用），抛 ActionGuardDeniedError', async () => {
    let calls = 0;
    await expect(
      withActionGuard({
        guard: guardWith(undefined),
        input: { action: 'claim.submit', actorUserId: ACTOR, organizationId: ORG, approvalId: 'a-1' },
        work: () => {
          calls += 1;
        },
      }),
    ).rejects.toMatchObject({ name: 'ActionGuardDeniedError' });
    expect(calls).toBe(0);
  });

  it('03 缺审批：work 绝不执行，抛 ActionGuardApprovalRequiredError', async () => {
    let calls = 0;
    await expect(
      withActionGuard({
        guard: guardWith(satisfied),
        input: { action: 'claim.submit', actorUserId: ACTOR, organizationId: ORG },
        work: () => {
          calls += 1;
        },
      }),
    ).rejects.toMatchObject({ name: 'ActionGuardApprovalRequiredError' });
    expect(calls).toBe(0);
  });

  it('04 被拒也写审计（含 action / decision / reason）', async () => {
    const events: Array<{ actionName?: string; decision?: string }> = [];
    await withActionGuard({
      guard: guardWith(undefined, events),
      input: { action: 'platform.write', actorUserId: ACTOR, organizationId: ORG },
      work: () => 'never',
    }).catch(() => undefined);
    expect(events).toHaveLength(1);
    expect(events[0]?.actionName).toBe('platform.write');
    expect(events[0]?.decision).toBe('DENY');
  });

  it('05 work 自身抛错时原样上抛（不吞错、不重试）', async () => {
    await expect(
      withActionGuard({
        guard: guardWith(satisfied),
        input: { action: 'claim.submit', actorUserId: ACTOR, organizationId: ORG, approvalId: 'a-1' },
        work: () => {
          throw new Error('downstream failure');
        },
      }),
    ).rejects.toThrow('downstream failure');
  });

  it('06 依赖缺失即失败（不允许「无守卫直接执行」的写法）', async () => {
    await expect(
      withActionGuard({ guard: undefined as never, input: { action: 'claim.submit', actorUserId: ACTOR, organizationId: ORG }, work: () => 1 }),
    ).rejects.toThrow('ACTION_GUARD_MISSING_RUNTIME_GUARD');
    await expect(
      withActionGuard({ guard: guardWith(satisfied), input: { action: 'claim.submit', actorUserId: ACTOR, organizationId: ORG, approvalId: 'a-1' }, work: undefined as never }),
    ).rejects.toThrow('ACTION_GUARD_MISSING_WORK_FUNCTION');
  });

  it('07 有限静态约定检查（非覆盖验收）：受保护动作字面量与守卫同文件出现', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'action-guard' || entry.name === '__tests__') continue;
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        const source = readFileSync(full, 'utf8');
        for (const action of GUARD_ENFORCED_ACTIONS) {
          if (!source.includes(`'${action}'`)) continue;
          if (source.includes('withActionGuard') || source.includes('assertAllowed')) continue;
          offenders.push(`${full.replace(API_SRC, 'src')} :: ${action}`);
        }
      }
    };
    walk(API_SRC);
    expect(offenders).toEqual([]);
  });
});
