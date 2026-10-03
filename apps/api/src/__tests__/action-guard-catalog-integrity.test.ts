// CHANGE A（MSG-20260930-12）：未知动作只接受目录自有键，原型链键不得绕过 UNKNOWN_ACTION。

import { describe, expect, it } from 'vitest';
import { ACTION_GUARD_CATALOG, evaluateActionGuard } from '../services/action-guard/action-guard';
import { createActionGuardCapabilitySource, scopesForAction } from '../services/action-guard/capability-source';
import { withActionGuard } from '../services/action-guard/guard-enforcement';
import { createRuntimeActionGuard } from '../services/action-guard/runtime-guard';

const ORG = 'b2a00000-0000-4000-8000-0000000000aa';
const ACTOR = 'b2b00000-0000-4000-8000-0000000000bb';
const HOSTILE = ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf', 'isPrototypeOf'];

function runtime(caps: Parameters<typeof createRuntimeActionGuard>[0]) {
  return createRuntimeActionGuard(caps);
}

describe('Action Guard catalog integrity（CHANGE A）', () => {
  it('01 原型链键与未注册动作：决策一律 UNKNOWN_ACTION + DENY', () => {
    for (const action of [...HOSTILE, 'claim.delete_everything']) {
      const result = evaluateActionGuard({
        action,
        actorUserId: ACTOR,
        organizationId: ORG,
        capabilities: { tenantEnabled: true, writeEnabled: true, productionGate: 'SATISFIED' },
      });
      expect(result.decision, action).toBe('DENY');
      expect(result.code, action).toBe('ACTION_GUARD_UNKNOWN_ACTION');
      expect(result.risk, action).toBe('UNKNOWN');
    }
  });

  it('02 目录本身不含继承键（自有键检查有效）', () => {
    expect(Object.prototype.hasOwnProperty.call(ACTION_GUARD_CATALOG, 'toString')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(ACTION_GUARD_CATALOG, 'constructor')).toBe(false);
    expect(Object.keys(ACTION_GUARD_CATALOG)).not.toContain('__proto__');
  });

  it('03 runtime assertAllowed：原型链键抛 ActionGuardDeniedError / ACTION_GUARD_UNKNOWN_ACTION，且写审计', async () => {
    const events: Array<{ decision?: string; code?: string }> = [];
    const guard = runtime({
      capabilities: { resolve: async () => ({ tenantEnabled: true, writeEnabled: true, productionGate: 'SATISFIED' }) },
      audit: { write: (record) => void events.push(record as { decision?: string; code?: string }) },
    });
    for (const action of HOSTILE) {
      const error = (await guard
        .assertAllowed({ action, actorUserId: ACTOR, organizationId: ORG, approvalId: 'a-1' })
        .catch((e) => e)) as { name?: string; code?: string };
      expect(error.name, action).toBe('ActionGuardDeniedError');
      expect(error.code, action).toBe('ACTION_GUARD_UNKNOWN_ACTION');
    }
    expect(events).toHaveLength(HOSTILE.length);
    expect(events.every((e) => e.decision === 'DENY' && e.code === 'ACTION_GUARD_UNKNOWN_ACTION')).toBe(true);
  });

  it('04 wrapper：原型链键被拒时 work 执行 0 次', async () => {
    let calls = 0;
    const guard = runtime({
      capabilities: { resolve: async () => ({ tenantEnabled: true, writeEnabled: true, productionGate: 'SATISFIED' }) },
      audit: { write: () => {} },
    });
    for (const action of HOSTILE) {
      await withActionGuard({
        guard,
        input: { action, actorUserId: ACTOR, organizationId: ORG, approvalId: 'a-1' },
        work: () => {
          calls += 1;
        },
      }).catch(() => undefined);
    }
    expect(calls).toBe(0);
  });

  it('05 capability source：未知/继承键动作返回空 scope 且 resolve 不抛异常', async () => {
    for (const action of HOSTILE) expect(scopesForAction(action), action).toEqual([]);
    expect(scopesForAction('claim.submit')).toEqual(['submission']);

    const source = createActionGuardCapabilitySource({
      killSwitch: {
        async resolve(scope: string) {
          return { scope, value: 'enabled' as const, degraded: false };
        },
      },
    });
    for (const action of HOSTILE) {
      const snapshot = await source.resolve({ organizationId: ORG, action });
      expect(snapshot, action).toBeDefined();
      expect(snapshot?.tenantEnabled, action).toBe(true);
    }
  });
});
