/**
 * STEP 3 FINAL-4（MSG-20261005-43）—— **real-adapter runtime E2E**
 * 链路：composeRsiRuntime → product recovery pack（唯一组装点）→ shared Action Guard adapter
 *      → createRuntimeActionGuard（共享实现：capabilities + audit）→ ALLOW → deterministic read tool
 *
 * 证明：ALLOW → read tool > 0；DENY / degraded → read tool = 0（且 domain pack 无法注入自定义 ALLOW guard）。
 */

import { describe, expect, it } from 'vitest';

import { composeRsiRuntime } from '../runtime/rsi-run';
import {
  RECOVERY_SI_PRODUCT_COMPOSITION_BOUNDARY,
  createProductRecoverySiPack,
} from '../runtime/recovery-si-product-composition';
import { createRuntimeActionGuard } from '../services/action-guard/runtime-guard';
import type { RecoveryReadPorts } from '../services/intelligence/recovery-read-tools';

const queue = JSON.stringify([
  { id: 'task-1', dedupeKey: 'task:recovery:PLATFORM:opp-1', priority: 'P2' },
]);

const bind = () => ({
  organizationId: 'org-1',
  domain: 'PLATFORM' as never,
  actionKind: 'EXECUTE_READ_ONLY_CHECK' as never,
  opportunityRef: 'opp-1',
});

const readPorts = (calls: string[]): RecoveryReadPorts => ({
  async opportunityRead(input) {
    calls.push('opportunity');
    return {
      opportunityRef: input.opportunityRef,
      status: 'READY',
      currency: 'USD',
      hasRecoverableAmount: true,
      hasRuleEvaluation: true,
    };
  },
  async evidenceRead(input) {
    calls.push('evidence');
    return { opportunityRef: input.opportunityRef, caseRef: 'case-1', evidenceCount: 1, kinds: ['POD'] };
  },
  async customsAuthorizationReadinessRead(input) {
    calls.push('customs');
    return { opportunityRef: input.opportunityRef, route: 'MODE_A', readyToFile: false, blockerCodes: [] };
  },
});

const runRuntime = async (guard: Parameters<typeof createProductRecoverySiPack>[0]['guard'], readCalls: string[]) => {
  const composition = await composeRsiRuntime({
    readFile: async (p: string) => (p === 'mem://tasks' ? queue : '[]'),
    tasksPath: 'mem://tasks',
    productRecoveryPack: { guard, readPorts: readPorts(readCalls), bind },
  });
  const outcome = await composition.controller.tick();
  return { composition, outcome };
};

describe('STEP 3 FINAL-4 · real shared guard adapter in ONE SI Runtime', () => {
  it('STEP3F4_1 ALLOW（真实共享 guard + audit 可用）→ read tool > 0 且 pack 标记 shared guard wiring', async () => {
    const readCalls: string[] = [];
    const guard = createRuntimeActionGuard({
      capabilities: {
        async resolve() {
          return { tenantEnabled: true, productionGate: 'SATISFIED', writeEnabled: false } as never;
        },
      },
      audit: { async write() {} } as never,
    });
    const { composition, outcome } = await runRuntime(guard, readCalls);
    expect(outcome.claimed?.dedupeKey).toBe('task:recovery:PLATFORM:opp-1');
    const dispatched = composition.domainDispatchLog();
    expect(dispatched[0]?.packId).toBe('recovery-si');
    expect(dispatched[0]?.guardActions.length).toBeGreaterThan(0);
    expect(readCalls.length).toBeGreaterThan(0);
    expect(composition.runtimeMembers().domainPacks).toContain('recovery-si');
  });

  it('STEP3F4_2 DENY（真实共享 guard：审计端口缺失 → ALLOW 降级 DENY）→ read tool = 0', async () => {
    const readCalls: string[] = [];
    const guard = createRuntimeActionGuard({
      capabilities: {
        async resolve() {
          return { tenantEnabled: true, productionGate: 'SATISFIED', writeEnabled: false } as never;
        },
      },
    });
    await runRuntime(guard, readCalls);
    expect(readCalls).toEqual([]);
  });

  it('STEP3F4_3 degraded（capabilities 端口抛错 → 状态不可用）→ read tool = 0', async () => {
    const readCalls: string[] = [];
    const guard = createRuntimeActionGuard({
      capabilities: {
        async resolve() {
          throw new Error('control-plane-unavailable');
        },
      },
      audit: { async write() {} } as never,
    });
    await runRuntime(guard, readCalls);
    expect(readCalls).toEqual([]);
  });

  it('STEP3F4_4 product 组装点只接受 shared guard 类型，且必须提供一个（不可缺省）', () => {
    expect(() =>
      createProductRecoverySiPack({ readPorts: readPorts([]), bind } as never),
    ).toThrow(/RECOVERY_SI_PRODUCT_GUARD_REQUIRED/);
    expect(RECOVERY_SI_PRODUCT_COMPOSITION_BOUNDARY.callerSuppliedGuardPort).toContain('FORBIDDEN');
    expect(RECOVERY_SI_PRODUCT_COMPOSITION_BOUNDARY.uniqueAssemblyPoint).toBe(true);
  });
});
