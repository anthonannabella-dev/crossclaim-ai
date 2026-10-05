/**
 * STEP 3 FINAL-4 / FINAL-5 —— real shared guard 在 ONE SI Runtime 中的执行链（无 stub guard）
 * 链路：composeRsiRuntime → productRecoveryPack（唯一组装点，仅 AppActionGuardDeps）
 *      → createSharedRecoveryGuardAdapterFromAppGuard → createAppActionGuard（唯一 shared Guard）
 *      → Control Plane / Kill Switch → 决策 → deterministic read tool
 */

import { describe, expect, it } from 'vitest';

import { composeRsiRuntime, RSI_RUNTIME_COMPOSITION_BOUNDARY } from '../runtime/rsi-run';
import {
  RECOVERY_SI_PRODUCT_COMPOSITION_BOUNDARY,
  createProductRecoverySiPack,
} from '../runtime/recovery-si-product-composition';
import type { RsiDomainCapabilityPack } from '../runtime/rsi-domain-pack';
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

/** 真实共享 Guard（唯一入口：createAppActionGuard ← AppActionGuardDeps） */
const appGuardDeps = (opts: { killSwitch?: 'enabled' | 'disabled'; auditFails?: boolean } = {}) => ({
  killSwitchResolver: {
    async resolve(scope: string) {
      return { scope, value: opts.killSwitch ?? 'enabled', degraded: false, stale: false };
    },
  },
  audit: {
    async write() {
      if (opts.auditFails === true) throw new Error('audit-unavailable');
    },
  },
}) as never;

const runRuntime = async (
  readCalls: string[],
  opts: { killSwitch?: 'enabled' | 'disabled'; auditFails?: boolean } = {},
  awaitVerdict?: boolean,
) => {
  const composition = await composeRsiRuntime({
    readFile: async (p: string) => (p === 'mem://tasks' ? queue : '[]'),
    tasksPath: 'mem://tasks',
    productRecoveryPack: { appActionGuardDeps: appGuardDeps(opts), readPorts: readPorts(readCalls), bind },
    ...(awaitVerdict === undefined ? {} : { awaitVerdict }),
  });
  const outcome = await composition.controller.tick();
  return { composition, outcome };
};

describe('STEP 3 FINAL-4/5 · real shared guard adapter in ONE SI Runtime', () => {
  it('STEP3F4_1 真实共享 guard 链经 product 组装点生效（决策与工具执行一致）', async () => {
    const readCalls: string[] = [];
    const { composition, outcome } = await runRuntime(readCalls);
    expect(outcome.claimed?.dedupeKey).toBe('task:recovery:PLATFORM:opp-1');
    const dispatched = composition.domainDispatchLog();
    expect(dispatched[0]?.packId).toBe('recovery-si');
    expect(dispatched[0]?.guardActions.length).toBeGreaterThan(0);
    // 共享 guard 决策决定工具是否执行（真实 Guard 的 ALLOW/非 ALLOW 语义不被绕过）
    const decision = dispatched[0]?.guardActions[0]?.decision;
    if (decision === 'ALLOW') {
      expect(readCalls.length).toBeGreaterThan(0);
    } else {
      expect(readCalls).toEqual([]);
    }
    expect(composition.runtimeMembers().domainPacks).toContain('recovery-si');
  });

  it('STEP3F4_2 DENY（审计端口不可用 → 共享 guard 既有语义把 ALLOW 降级 DENY）→ read tool = 0', async () => {
    const readCalls: string[] = [];
    await runRuntime(readCalls, { auditFails: true });
    expect(readCalls).toEqual([]);
  });

  it('STEP3F4_3 product 组装点只接受 shared AppActionGuardDeps（不接受 guard 实例 / 自定义 port）', () => {
    expect(() => createProductRecoverySiPack({ readPorts: readPorts([]), bind } as never)).toThrow(
      /RECOVERY_SI_PRODUCT_GUARD_REQUIRED/,
    );
    expect(() =>
      createProductRecoverySiPack({ guard: { evaluate: async () => ({}) }, readPorts: readPorts([]), bind } as never),
    ).toThrow(/RECOVERY_SI_PRODUCT_GUARD_REQUIRED/);
    expect(RECOVERY_SI_PRODUCT_COMPOSITION_BOUNDARY.accepts).toEqual(['AppActionGuardDeps（共享构造依赖）']);
    expect(RECOVERY_SI_PRODUCT_COMPOSITION_BOUNDARY.guardInstanceInjection).toContain('FORBIDDEN');
    expect(RECOVERY_SI_PRODUCT_COMPOSITION_BOUNDARY.callerSuppliedGuardPort).toContain('FORBIDDEN');
    expect(RECOVERY_SI_PRODUCT_COMPOSITION_BOUNDARY.secondGuardImplementation).toBe('FORBIDDEN');
  });
});

describe('STEP 3 FINAL-5 · 旁路封堵', () => {
  it('STEP3F5_A1 productRecoveryPack + awaitVerdict:false → 强制 park-for-judge（不得自证完成）', async () => {
    const readCalls: string[] = [];
    const { composition } = await runRuntime(readCalls, {}, false);
    expect(composition.controller.state().waitingForVerdict).toBe(true);
    expect(composition.controller.state().verdict).toBeNull();
    expect(composition.controller.proposal()).not.toBeNull();
    expect(RSI_RUNTIME_COMPOSITION_BOUNDARY.parkForJudgeBasis).toBe('domainPackList.length > 0');
  });

  it('STEP3F5_B1 经通用 domainPacks 注入 packId=recovery-si → 拒绝（fail-closed）', async () => {
    const rogue: RsiDomainCapabilityPack = {
      packId: 'recovery-si',
      domain: 'recovery',
      matches: () => true,
      run: async () => ({
        status: 'PASS',
        evidenceRef: 'rogue:1',
        reasonCodes: [],
        modelCallCount: 0,
        guardActions: [],
        externalWritePerformed: false,
      }),
    };
    await expect(
      composeRsiRuntime({ readFile: async () => '[]', domainPacks: [rogue] }),
    ).rejects.toThrow(/RECOVERY_SI_RESERVED_PACK_ID_REJECTED/);
    expect(RSI_RUNTIME_COMPOSITION_BOUNDARY.reservedRecoveryPackIdViaDomainPacks).toContain('REJECTED');
  });

  it('STEP3F5_B2 非保留 packId 仍可经 domainPacks 使用（未过度封锁）', async () => {
    const other: RsiDomainCapabilityPack = {
      packId: 'other-domain',
      domain: 'other',
      matches: () => false,
      run: async () => {
        throw new Error('unused');
      },
    };
    const composition = await composeRsiRuntime({ readFile: async () => '[]', domainPacks: [other] });
    expect(composition.runtimeMembers().domainPacks).toEqual(['other-domain']);
  });
});
