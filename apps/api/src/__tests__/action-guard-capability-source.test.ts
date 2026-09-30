// ACTION GUARD capability source 单测：Kill Switch 接线 + 默认 fail closed（MSG-20260330-03 项 ②）

import { describe, expect, it, vi } from 'vitest';
import {
  ACTION_SCOPE_MAP,
  createActionGuardCapabilitySource,
  scopesForAction,
} from '../services/action-guard/capability-source';
import { createRuntimeActionGuard } from '../services/action-guard/runtime-guard';

const ORG = 'b2a00000-0000-4000-8000-0000000000aa';
const ACTOR = 'b2b00000-0000-4000-8000-0000000000bb';

function killSwitch(value: 'enabled' | 'disabled', opts: { degraded?: boolean } = {}) {
  const calls: Array<[string, string]> = [];
  return {
    calls,
    port: {
      async resolve(scope: string, organizationId: string) {
        calls.push([scope, organizationId]);
        return { scope, value, degraded: opts.degraded ?? false };
      },
    },
  };
}

describe('Action Guard capability source', () => {
  it('01 动作 → Kill Switch scope 映射（未列出的动作不查 Kill Switch）', () => {
    expect(scopesForAction('claim.submit')).toEqual(['submission']);
    expect(scopesForAction('platform.write')).toEqual(['platform_connector']);
    expect(scopesForAction('commission.charge')).toEqual(['billing']);
    expect(scopesForAction('evidence.read')).toEqual([]);
    expect(scopesForAction('secret.rotate')).toEqual([]);
    expect(Object.keys(ACTION_SCOPE_MAP)).not.toContain('evidence.read');
  });

  it('02 Kill Switch disabled：tenant 未启用 → 运行时守卫拒绝', async () => {
    const ks = killSwitch('disabled');
    const guard = createRuntimeActionGuard({
      capabilities: createActionGuardCapabilitySource({ killSwitch: ks.port }),
      audit: { write: () => {} },
    });
    await expect(
      guard.assertAllowed({ action: 'claim.submit', actorUserId: ACTOR, organizationId: ORG, approvalId: 'a-1' }),
    ).rejects.toMatchObject({ code: 'ACTION_GUARD_REQUIREMENTS_NOT_MET' });
    expect(ks.calls).toEqual([['submission', ORG]]);
  });

  it('03 Kill Switch degraded：同样 fail closed（拒绝）', async () => {
    const ks = killSwitch('enabled', { degraded: true });
    const guard = createRuntimeActionGuard({
      capabilities: createActionGuardCapabilitySource({ killSwitch: ks.port }),
      audit: { write: () => {} },
    });
    await expect(
      guard.assertAllowed({ action: 'claim.submit', actorUserId: ACTOR, organizationId: ORG, approvalId: 'a-1' }),
    ).rejects.toMatchObject({ code: 'ACTION_GUARD_REQUIREMENTS_NOT_MET' });
  });

  it('04 Kill Switch 抛异常：STATE_UNAVAILABLE（拒绝）', async () => {
    const guard = createRuntimeActionGuard({
      capabilities: createActionGuardCapabilitySource({
        killSwitch: {
          async resolve() {
            throw new Error('kill switch db down');
          },
        },
      }),
      audit: { write: () => {} },
    });
    await expect(
      guard.assertAllowed({ action: 'claim.submit', actorUserId: ACTOR, organizationId: ORG, approvalId: 'a-1' }),
    ).rejects.toMatchObject({ code: 'ACTION_GUARD_STATE_UNAVAILABLE' });
  });

  it('05 默认提供方全缺省：即使 Kill Switch enabled 也拒绝（生产 HOLD 姿态）', async () => {
    const guard = createRuntimeActionGuard({
      capabilities: createActionGuardCapabilitySource({ killSwitch: killSwitch('enabled').port }),
      audit: { write: () => {} },
    });
    const error = await guard
      .assertAllowed({ action: 'claim.submit', actorUserId: ACTOR, organizationId: ORG, approvalId: 'a-1' })
      .catch((e) => e);
    expect(error.code).toBe('ACTION_GUARD_REQUIREMENTS_NOT_MET');
    expect(error.reasons.join('|')).toContain('feature flag 未开启');
    expect(error.reasons.join('|')).toContain('platform-level enablement 未开启');
    expect(error.reasons.join('|')).toContain('production gate 未满足');
  });

  it('06 提供方全部满足 + Kill Switch enabled：ALLOW（能力快照正确组装）', async () => {
    const auditEvents: unknown[] = [];
    const guard = createRuntimeActionGuard({
      capabilities: createActionGuardCapabilitySource({
        killSwitch: killSwitch('enabled').port,
        providers: {
          productionGate: () => 'SATISFIED',
          writeEnabled: () => true,
          hostApprovalGranted: () => true,
          featureFlags: ({ action }) => ({ [action]: true }),
          platformEnablement: ({ action }) => ({ [action]: true }),
        },
      }),
      audit: { write: (record) => void auditEvents.push(record) },
    });
    const result = await guard.assertAllowed({
      action: 'claim.submit',
      actorUserId: ACTOR,
      organizationId: ORG,
      approvalId: 'a-1',
    });
    expect(result.decision).toBe('ALLOW');
    expect(auditEvents).toHaveLength(1);
  });

  it('07 多 scope 动作：任一 scope 未启用即拒绝（逐个 scope 都必须查）', async () => {
    const resolve = vi.fn(
      async (scope: string): Promise<{ scope: string; value: 'enabled' | 'disabled'; degraded: boolean }> => ({
        scope,
        value: scope === 'billing' ? 'disabled' : 'enabled',
        degraded: false,
      }),
    );
    // 临时把 claim.submit 扩展为双 scope 动作，验证「每个 scope 都必须查」
    ACTION_SCOPE_MAP['claim.submit'] = ['submission', 'billing'];
    try {
      const guard = createRuntimeActionGuard({
        capabilities: createActionGuardCapabilitySource({ killSwitch: { resolve } }),
        audit: { write: () => {} },
      });
      await guard.assertAllowed({ action: 'claim.submit', actorUserId: ACTOR, organizationId: ORG, approvalId: 'a-1' });
      throw new Error('expected rejection');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('ACTION_GUARD_REQUIREMENTS_NOT_MET');
      expect(resolve).toHaveBeenCalledWith('submission', ORG);
      expect(resolve).toHaveBeenCalledWith('billing', ORG);
    } finally {
      ACTION_SCOPE_MAP['claim.submit'] = ['submission'];
    }
  });
});
