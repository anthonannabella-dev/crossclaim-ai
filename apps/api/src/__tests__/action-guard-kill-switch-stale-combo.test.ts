// CHANGE D1 组合验收：适配器 → 能力源 → runtime guard（wrapper 拒绝时 work=0）

import { describe, expect, it } from 'vitest';
import { createActionGuardCapabilitySource } from '../services/action-guard/capability-source';
import { withActionGuard } from '../services/action-guard/guard-enforcement';
import { createKillSwitchReadPort } from '../services/action-guard/kill-switch-adapter';
import { createRuntimeActionGuard } from '../services/action-guard/runtime-guard';

const ORG = 'b2a00000-0000-4000-8000-0000000000aa';
const ACTOR = 'b2b00000-0000-4000-8000-0000000000bb';

/** 除 Kill Switch 健康标记外，其余闸门全部满足，用于隔离 stale 的影响 */
function build(stale: unknown) {
  const guard = createRuntimeActionGuard({
    capabilities: createActionGuardCapabilitySource({
      killSwitch: createKillSwitchReadPort({
        async resolve(scope: string) {
          return { scope, value: 'enabled', degraded: false, stale } as never;
        },
      }),
      providers: {
        productionGate: () => 'SATISFIED',
        writeEnabled: () => true,
        hostApprovalGranted: () => true,
        featureFlags: ({ action }) => ({ [action]: true }),
        platformEnablement: ({ action }) => ({ [action]: true }),
      },
    }),
    audit: { write: () => {} },
  });
  return guard;
}

describe('Kill Switch stale 组合验收（CHANGE D1）', () => {
  it('01 合法 stale=false 且其余闸门满足：claim.submit ALLOW（对照）', async () => {
    const guard = build(false);
    const result = await guard.assertAllowed({ action: 'claim.submit', actorUserId: ACTOR, organizationId: ORG, approvalId: 'a-1' });
    expect(result.decision).toBe('ALLOW');
  });

  it('02 合法 stale=true：拒绝（陈旧值不得放行）', async () => {
    const guard = build(true);
    await expect(
      guard.assertAllowed({ action: 'claim.submit', actorUserId: ACTOR, organizationId: ORG, approvalId: 'a-1' }),
    ).rejects.toMatchObject({ code: 'ACTION_GUARD_REQUIREMENTS_NOT_MET' });
  });

  it("03 stale 非法类型（'true' / 'false' / 1 / null / {}）：一律拒绝，且 wrapper work=0", async () => {
    for (const bad of ['true', 'false', 1, null, {}, []]) {
      const guard = build(bad);
      let calls = 0;
      await expect(
        withActionGuard({
          guard,
          input: { action: 'claim.submit', actorUserId: ACTOR, organizationId: ORG, approvalId: 'a-1' },
          work: () => {
            calls += 1;
          },
        }),
        JSON.stringify(bad),
      ).rejects.toMatchObject({ code: 'ACTION_GUARD_REQUIREMENTS_NOT_MET' });
      expect(calls, JSON.stringify(bad)).toBe(0);
    }
  });
});
