// AGENT EXPERIENCE LAYER / P2 —— Goal → 既有 ONE SI Runtime 接线回归（真实 composeRsiRuntime）
// ---------------------------------------------------------------------------
// 证明（HOST P2 要求）：
//   * Goal 计划只经**既有任务队列**进入既有 runtime（不直接 runner.run、不建循环）；
//   * `task:recovery:*` 永远由保留 pack `recovery-si` 派发，**caller runner 不得抢占**；
//   * 经 `domainPacks` 注入 `recovery-si` 被拒绝（不得用自定义 guard 绕过 Shared Action Guard）；
//   * 非 recovery 任务才走 caller runner（证明 mux 分离真实存在）；
//   * 入队 ≠ 执行；binding / adapter 声明不建 runtime / scheduler / event loop；
//   * `SECOND_RUNTIME = 0`。

import { describe, expect, it } from 'vitest';

import { composeRsiRuntime } from '../runtime/rsi-run';

import * as agentGoalBarrel from '../services/agent-goal';
import type { RsiDomainCapabilityPack } from '../runtime/rsi-domain-pack';
import type { RecoveryReadPorts } from '../services/intelligence/recovery-read-tools';
import {
  GOAL_RUNTIME_BINDING_BOUNDARY,
  assertAdmissionIsNotExecution,
  compileAgentGoal,
  createGoalRuntimeBinding,
  planAgentGoal,
  resolveGoalCapabilities,
  validateAgentGoalDraft,
  type GoalCapabilityFacts,
  type GoalPlan,
  type GoalTaskDraft,
} from '../services/agent-goal';

const NOW = new Date('2026-10-07T05:30:00.000Z');
const CONTEXT = { organizationId: 'org-goal-rt-1', actorUserId: 'user-1', now: NOW };
const GOAL_TEXT = '检查 Amazon 可以追回的钱，符合授权范围的直接处理';

function facts(overrides: Partial<GoalCapabilityFacts> = {}): GoalCapabilityFacts {
  return {
    productionGate: 'NOT_SATISFIED',
    writeEnabled: false,
    tenantEnabled: true,
    featureEnabled: { 'evidence.read': true, 'claim.prepare': true, 'recovery.manual_submit': true },
    platformEnablement: {},
    killSwitchActive: false,
    providerCapabilityReady: {},
    customsPoaSatisfied: false,
    regulatoryRestriction: null,
    standingAuthorizationValid: true,
    standingAuthorizationLimitUsd: 1_000,
    ...overrides,
  };
}

function planFor(text: string = GOAL_TEXT): GoalPlan {
  const compiled = compileAgentGoal({ text });
  if (!compiled.ok) throw new Error('compile failed: ' + compiled.reason);
  const goal = validateAgentGoalDraft({ draft: compiled.draft, context: CONTEXT });
  const capabilities = resolveGoalCapabilities({
    organizationId: goal.organizationId,
    domains: goal.domains,
    facts: facts(),
    now: NOW,
  });
  return planAgentGoal({ goal, capabilities, now: NOW });
}

/** 既有 runtime 队列的 host 端口（测试用内存实现；本层不提供生产队列实现） */
function createQueue(stored: Array<{ id: string; dedupeKey: string; priority: string }>) {
  return {
    async admit(input: { organizationId: string; tasks: readonly GoalTaskDraft[] }) {
      const admitted: string[] = [];
      const alreadyPresent: string[] = [];
      for (const task of input.tasks) {
        if (stored.some((row) => row.dedupeKey === task.dedupeKey)) {
          alreadyPresent.push(task.dedupeKey);
          continue;
        }
        stored.push({ id: task.dedupeKey, dedupeKey: task.dedupeKey, priority: 'P2' });
        admitted.push(task.dedupeKey);
      }
      return { admitted, alreadyPresent };
    },
  };
}

const bind = (task: { dedupeKey: string }): never | null => {
  const match = /^task:recovery:([A-Z_]+):/.exec(task.dedupeKey);
  if (!match) return null;
  return {
    organizationId: CONTEXT.organizationId,
    domain: match[1],
    actionKind: 'EXECUTE_READ_ONLY_CHECK',
    opportunityRef: 'opp-goal-1',
  } as never;
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
    return { opportunityRef: input.opportunityRef, caseRef: 'case-1', evidenceCount: 1, kinds: ['POD'] };
  },
  async customsAuthorizationReadinessRead(input) {
    calls.push('customs');
    return { opportunityRef: input.opportunityRef, route: 'MODE_A', readyToFile: false, blockerCodes: [] };
  },
});

const appGuardDeps = () =>
  ({
    killSwitchResolver: {
      async resolve(scope: string) {
        return { scope, value: 'enabled', degraded: false, stale: false };
      },
    },
    audit: { async write() {} },
  }) as never;

async function runRuntime(input: {
  stored: Array<{ id: string; dedupeKey: string; priority: string }>;
  readCalls?: string[];
  callerRunner?: { run(task: { dedupeKey: string }): Promise<{ status: string; evidenceRef: string }> };
}) {
  const composition = await composeRsiRuntime({
    readFile: async (p: string) => (p === 'mem://tasks' ? JSON.stringify(input.stored) : '[]'),
    tasksPath: 'mem://tasks',
    productRecoveryPack: { appActionGuardDeps: appGuardDeps(), readPorts: readPorts(input.readCalls ?? []), bind },
    ...(input.callerRunner === undefined ? {} : { runner: input.callerRunner as never }),
  });
  const outcome = await composition.controller.tick();
  return { composition, outcome };
}

describe('P2 · Goal → 既有 ONE SI Runtime（真实 composeRsiRuntime）', () => {
  it('P2-A1 计划并入既有队列 → 由 ONE SI Runtime 认领，派发到保留 pack recovery-si，caller runner 未被调用', async () => {
    const plan = planFor();
    const stored: Array<{ id: string; dedupeKey: string; priority: string }> = [];
    const binding = createGoalRuntimeBinding({ queue: createQueue(stored) });
    const admission = await binding.admit(plan, { now: NOW });
    expect(admission.kind).toBe('AGENT_GOAL_PLAN_ADMITTED');
    expect(admission.admitted).toEqual(plan.tasks.map((task) => task.dedupeKey));
    expect(admission.executedBy).toBe('ONE_SI_RUNTIME');
    expect(admission.admissionOnly).toBe(true);
    expect(admission.externalActionPerformed).toBe(false);
    expect(admission.createdRuntime).toBe(false);
    expect(() => assertAdmissionIsNotExecution(admission)).not.toThrow();

    const callerCalls: string[] = [];
    const { composition, outcome } = await runRuntime({
      stored,
      callerRunner: {
        async run(task: { dedupeKey: string }) {
          callerCalls.push(task.dedupeKey);
          return { status: 'PASS', evidenceRef: 'caller-runner' };
        },
      },
    });

    expect(outcome.claimed?.dedupeKey).toBe(plan.tasks[0].dedupeKey);
    expect(composition.domainDispatchLog()[0]?.packId).toBe('recovery-si');
    expect(callerCalls).toEqual([]);
  });

  it('P2-A2 非 recovery 任务才走 caller runner（mux 分离真实存在）', async () => {
    const stored = [{ id: 't-manual', dedupeKey: 'task:manual:1', priority: 'P2' }];
    const callerCalls: string[] = [];
    const { composition, outcome } = await runRuntime({
      stored,
      callerRunner: {
        async run(task: { dedupeKey: string }) {
          callerCalls.push(task.dedupeKey);
          return { status: 'PASS', evidenceRef: 'caller-runner' };
        },
      },
    });
    expect(outcome.claimed?.dedupeKey).toBe('task:manual:1');
    expect(callerCalls).toEqual(['task:manual:1']);
    expect(composition.domainDispatchLog()).toEqual([]);
  });

  it('P2-A3 经 domainPacks 注入 recovery-si 一律拒绝（不得用自定义 guard 抢占 Recovery）', async () => {
    const hijack = {
      packId: 'recovery-si',
      domain: 'PLATFORM',
      matches: () => true,
      async run() {
        return {
          status: 'PASS',
          evidenceRef: 'hijack',
          reasonCodes: [],
          modelCallCount: 0,
          guardActions: [],
          externalWritePerformed: false,
        };
      },
    } as unknown as RsiDomainCapabilityPack;

    await expect(
      composeRsiRuntime({
        readFile: async () => '[]',
        domainPacks: [hijack],
      }),
    ).rejects.toThrow(/RECOVERY_SI_RESERVED_PACK_ID_REJECTED/);
  });

  it('P2-A4 binding 拒绝非 recovery 命名空间；描述体声明不建 runtime / scheduler / loop、不直接调 runner', async () => {
    const binding = createGoalRuntimeBinding({ queue: createQueue([]) });
    const foreign = {
      ...planFor(),
      tasks: [{ ...planFor().tasks[0], dedupeKey: 'task:agent-goal:PLATFORM:1' }],
    } as unknown as GoalPlan;
    await expect(binding.admit(foreign)).rejects.toThrow(/GOAL_TASK_NAMESPACE_NOT_ALLOWED/);

    expect(binding.describe()).toMatchObject({
      entryPoint: 'existing-task-queue',
      createsRuntime: false,
      createsScheduler: false,
      createsEventLoop: false,
      callsRunnerDirectly: false,
      runtimeOwner: 'apps/api/src/runtime/rsi-run.ts',
    });
    expect(GOAL_RUNTIME_BINDING_BOUNDARY.admissionIsNotExecution).toBe(true);
    expect(GOAL_RUNTIME_BINDING_BOUNDARY.callsRunnerDirectly).toBe(false);
  });

  it('P2-A5 重复并入幂等（同 dedupeKey 不重复入队）；入队结果不得被当成执行结果', async () => {
    const plan = planFor();
    const stored: Array<{ id: string; dedupeKey: string; priority: string }> = [];
    const binding = createGoalRuntimeBinding({ queue: createQueue(stored) });
    const first = await binding.admit(plan, { now: NOW });
    const second = await binding.admit(plan, { now: NOW });
    expect(first.admitted.length).toBeGreaterThan(0);
    expect(second.admitted).toEqual([]);
    expect(second.alreadyPresent).toEqual(first.admitted);
    expect(stored).toHaveLength(first.admitted.length);

    expect(() => assertAdmissionIsNotExecution({ admissionOnly: false })).toThrow(/入队不等于执行/);
  });

  it('P2-A6 未注入队列端口 / adapter 未注入 runner → 一律拒绝（不得自建执行设施）', () => {
    expect(() => createGoalRuntimeBinding({ queue: undefined as never })).toThrow(/GOAL_TASK_QUEUE_PORT_REQUIRED/);
    // AEL-FINAL2（MSG-20261007-01 CHANGE 1）：direct-runner adapter 不得出现在产品导出面
    expect('createGoalRuntimeAdapter' in agentGoalBarrel).toBe(false);
    expect('GOAL_RUNTIME_ADAPTER_BOUNDARY' in agentGoalBarrel).toBe(false);
  });

  it('P2-A7 runtimeMembers：SECOND_RUNTIME = 0，唯一 runtime owner 为 rsi-run.ts', async () => {
    const stored: Array<{ id: string; dedupeKey: string; priority: string }> = [];
    const { composition } = await runRuntime({ stored });
    const members = composition.runtimeMembers();
    expect(members.secondRuntime).toBe(0);
    expect(members.runtimeOwner).toBe('apps/api/src/runtime/rsi-run.ts');
    expect(members.domainPacks).toContain('recovery-si');
  });
});
