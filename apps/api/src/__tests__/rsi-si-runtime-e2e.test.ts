/**
 * STEP_3G —— ONE CrossClaim SI Runtime 端到端验收（3G 十条）
 * 链路：Recovery signal → task → Policy Core → Recovery Pack → 确定性只读工具 → 证据 →
 *      Judge（park-for-judge）→ verdict（PASS / REVISE）→ continuation → restart/reconcile。
 *
 * 全程零网络、零外写、零真实 provider（local simulation / contract wiring only）。
 */

import { describe, expect, it } from 'vitest';

import {
  composeRsiRuntime,
  normalizeRsiVerdict,
  RSI_RUNTIME_COMPOSITION_BOUNDARY,
} from '../runtime/rsi-run';
import { createRecoverySiPack, type RecoverySiPackDependencies } from '../runtime/recovery-si-pack';
import type { RsiDomainPackEvidence } from '../runtime/rsi-domain-pack';
import { createRsiInMemoryReconcileStore } from '../runtime/rsi-restart-reconcile';
import type { RecoveryReadPorts } from '../services/intelligence/recovery-read-tools';
import type { RsiRecoveryGuardPort } from '../runtime/recovery-si-pack';

const SIGNALS = JSON.stringify([
  {
    kind: 'TEST_FAILURE',
    dedupeKey: 'recovery:PLATFORM:opp-1',
    summary: 'recovery read-only check requested',
    refs: ['run:1'],
    riskClass: 'LOW',
  },
]);

const ALLOW_GUARD: RsiRecoveryGuardPort = {
  async evaluate() {
    return { decision: 'ALLOW', reason: 'TEST_ALLOW' };
  },
};

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
    return { opportunityRef: input.opportunityRef, caseRef: 'case-1', evidenceCount: 2, kinds: ['POD'] };
  },
  async customsAuthorizationReadinessRead(input) {
    calls.push('customs');
    return { opportunityRef: input.opportunityRef, route: 'MODE_A', readyToFile: false, blockerCodes: ['POA_MISSING'] };
  },
});

const bind: RecoverySiPackDependencies['bind'] = (t) => {
  const match = /^task:recovery:([A-Z_]+):(.+)$/.exec(t.dedupeKey);
  if (match === null) return null;
  return {
    organizationId: 'org-1',
    domain: match[1] as never,
    actionKind: 'EXECUTE_READ_ONLY_CHECK',
    opportunityRef: match[2],
  };
};

describe('STEP_3G · ONE SI Runtime 端到端（Recovery Pack 作为 domain capability pack）', () => {
  it('STEP3_E2E_1..9 signal → task → policy → pack → read tools → evidence → judge → verdict → continuation', async () => {
    const readCalls: string[] = [];
    const seen: RsiDomainPackEvidence[] = [];
    const inner = createRecoverySiPack({ readPorts: readPorts(readCalls), bind, guard: ALLOW_GUARD });
    const pack = {
      ...inner,
      run: async (context: { task: { id: string; dedupeKey: string; priority: string }; packId: string }) => {
        const evidence = await inner.run(context as never);
        seen.push(evidence);
        return evidence;
      },
    };
    const readFile = async (filePath: string): Promise<string> => {
      if (filePath === 'mem://signals') return SIGNALS;
      if (filePath === 'mem://verdict') return 'PASS';
      throw new Error('unexpected path ' + filePath);
    };

    const composition = await composeRsiRuntime({
      readFile,
      signalsPath: 'mem://signals',
      verdictPath: 'mem://verdict',
      domainPacks: [pack],
      awaitVerdict: true,
      verdictWatch: { intervalMs: 60_000 },
    });

    // 1 + 2：Recovery signal 进入唯一 runtime → 生成 task
    const generation = composition.taskGeneration();
    expect(generation).not.toBeNull();
    expect(generation?.tasks.map((t) => t.dedupeKey)).toEqual(['task:recovery:PLATFORM:opp-1']);

    // 3 + 4 + 5 + 6：Policy Core → Recovery Pack → 确定性只读工具 → 证据
    const dispatched = await composition.controller.tick();
    expect(dispatched.claimed?.dedupeKey).toBe('task:recovery:PLATFORM:opp-1');
    expect(readCalls.length).toBeGreaterThan(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.status).toBe('PASS');
    expect(seen[0]?.modelCallCount).toBe(0);
    expect(seen[0]?.externalWritePerformed).toBe(false);
    expect(seen[0]?.evidenceRef.startsWith('recovery-si:PLATFORM:')).toBe(true);
    expect(composition.domainDispatchLog()[0]?.packId).toBe('recovery-si');

    // 7：Judge —— park-for-judge（跑完只作提案，等待裁决，绝不自动 PASS）
    expect(composition.controller.state().waitingForVerdict).toBe(true);

    // 8：PASS / REVISE 两条路径都可用（取值来自 artifact，不猜）
    expect(normalizeRsiVerdict('PASS')).toBe('PASS');
    expect(normalizeRsiVerdict('REVISE')).toBe('REVISE');
    expect(normalizeRsiVerdict('garbage')).toBeNull();
    composition.controller.markWaitingForVerdict('PASS');
    const settled = await composition.controller.emit('JUDGE_VERDICT_RECEIVED');
    expect(settled).toBeDefined();
    expect(composition.controller.state().waitingForVerdict).toBe(false);

    // 9：continuation 继续推进（无异常、无重复执行）
    const next = await composition.controller.tick();
    expect(next).toBeDefined();

    // 唯一 runtime 断言
    expect(composition.runtimeMembers().secondRuntime).toBe(0);
    expect(RSI_RUNTIME_COMPOSITION_BOUNDARY.domainCapabilityPacks).toContain('STATIC_COMPOSITION_ONLY');
    expect(RSI_RUNTIME_COMPOSITION_BOUNDARY.performsExternalWrite).toBe(false);
    expect(composition.verdictWatcher).not.toBeNull();
  });

  it('STEP3_E2E_10 restart/reconcile：过期的 ACTIVE lease 恢复、终止态不重放、重复运行幂等', async () => {
    const store = createRsiInMemoryReconcileStore({
      tasks: [
        { taskId: 'task-hot', dedupeKey: 'dedupe-hot', status: 'IN_PROGRESS', createdAt: '2026-10-05T00:00:00.000Z' },
        { taskId: 'task-done', dedupeKey: 'dedupe-done', status: 'PROMOTED', createdAt: '2026-10-05T00:00:00.000Z' },
      ],
      leases: [
        {
          leaseId: 'lease-1',
          taskId: 'task-hot',
          ownerRef: 'runtime-a',
          status: 'ACTIVE',
          acquiredAt: '2026-10-05T00:00:00.000Z',
          renewedAt: '2026-10-05T00:00:00.000Z',
          expiresAt: '2026-10-05T00:05:00.000Z',
        },
      ],
    });
    const composition = await composeRsiRuntime({
      readFile: async () => '[]',
      domainPacks: [createRecoverySiPack({ readPorts: readPorts([]), bind, guard: ALLOW_GUARD })],
      reconcile: { store, ownerRef: 'runtime-b' },
    });
    const plan = await composition.reconcileNow();
    expect(plan?.expiredLeaseIds).toEqual(['lease-1']);
    expect(plan?.recoveredTaskIds).toEqual(['task-hot']);
    expect(store.taskSnapshot().find((t) => t.taskId === 'task-done')?.status).toBe('PROMOTED');
    const second = await composition.reconcileNow();
    expect(second?.idempotentNoop).toBe(true);
    expect(store.taskSnapshot().find((t) => t.taskId === 'task-done')?.status).toBe('PROMOTED');
  });
});


describe('STEP_3 FINAL-2 · CHANGE A —— proposal 与 Judge verdict 分离', () => {
  it('STEP3F2_A1 proposal 不得被 watchdog 当 verdict 消费；external verdict 才是唯一完成来源', async () => {
    const readCalls: string[] = [];
    const pack = createRecoverySiPack({ readPorts: readPorts(readCalls), bind, guard: ALLOW_GUARD });
    const composition = await composeRsiRuntime({
      readFile: async (p: string) => (p === 'mem://signals' ? SIGNALS : '[]'),
      signalsPath: 'mem://signals',
      domainPacks: [pack],
    });
    const first = await composition.controller.tick();
    expect(first.claimed?.dedupeKey).toBe('task:recovery:PLATFORM:opp-1');
    expect(composition.controller.state().waitingForVerdict).toBe(true);
    expect(composition.controller.state().verdict).toBeNull();
    expect(composition.controller.proposal()?.status).toBe('PASS');
    await composition.controller.tick();
    await composition.controller.tick();
    expect(composition.controller.state().waitingForVerdict).toBe(true);
    expect(composition.controller.state().verdict).toBeNull();
    composition.controller.markWaitingForVerdict('PASS');
    await composition.controller.emit('JUDGE_VERDICT_RECEIVED');
    expect(composition.controller.state().waitingForVerdict).toBe(false);
    expect(readCalls.length).toBeGreaterThan(0);
  });

  it('STEP3F2_A2 malformed verdict → 保持等待（不猜、不自证完成）', () => {
    expect(normalizeRsiVerdict('garbage')).toBeNull();
    expect(normalizeRsiVerdict(undefined)).toBeNull();
    expect(RSI_RUNTIME_COMPOSITION_BOUNDARY.secondRuntime).toBe(0);
  });
});

describe('STEP_3 FINAL-3 · CHANGE A —— domainPacks 不可被 awaitVerdict:false 绕过', () => {
  it('STEP3F3_A1 显式 awaitVerdict:false + domainPacks → 仍 park-for-judge，不自证完成', async () => {
    const pack = createRecoverySiPack({ readPorts: readPorts([]), bind, guard: ALLOW_GUARD });
    const queue = JSON.stringify([{ id: 'task-1', dedupeKey: 'task:recovery:PLATFORM:opp-1', priority: 'P2' }]);
    const composition = await composeRsiRuntime({
      readFile: async (p: string) => (p === 'mem://tasks' ? queue : '[]'),
      tasksPath: 'mem://tasks',
      domainPacks: [pack],
      awaitVerdict: false,
    });
    const outcome = await composition.controller.tick();
    expect(outcome.claimed?.dedupeKey).toBe('task:recovery:PLATFORM:opp-1');
    expect(composition.controller.state().waitingForVerdict).toBe(true);
    expect(composition.controller.state().verdict).toBeNull();
    expect(composition.controller.proposal()?.status).toBe('PASS');
    composition.controller.markWaitingForVerdict('PASS');
    await composition.controller.emit('JUDGE_VERDICT_RECEIVED');
    expect(composition.controller.state().waitingForVerdict).toBe(false);
    expect(RSI_RUNTIME_COMPOSITION_BOUNDARY.domainPackAlwaysParksForJudge).toBe(true);
  });
});
