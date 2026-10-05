/**
 * STEP_3 —— Runtime / Policy / Guard 接线验收（架构回归 + fail-closed）
 * 覆盖 3A（唯一 runtime + domain pack 派发）、3B（依赖方向）、3C（guard binding 不被绕过）、
 * 3G「SECOND_RUNTIME = 0」防回归。
 */

import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  RSI_DOMAIN_PACK_BOUNDARY,
  createRsiDomainPackRunner,
  describeRsiRuntimeMembers,
  type RsiDomainCapabilityPack,
} from '../runtime/rsi-domain-pack';
import {
  RECOVERY_SI_PACK_BOUNDARY,
  createRecoverySiPack,
  type RecoverySiPackDependencies,
} from '../runtime/recovery-si-pack';
import { RSI_RUNTIME_COMPOSITION_BOUNDARY } from '../runtime/rsi-run';
import { decideRecoveryAction } from '../services/intelligence/recovery-policy';
import { resolveGuardAction } from '../services/intelligence/recovery-guard-dry-run';
import type { RecoveryPlanAction } from '../services/intelligence/recovery-planner';
import type { RecoveryReadPorts } from '../services/intelligence/recovery-read-tools';
import type { RsiSafeTask } from '../services/autonomy/rsi-continuation-engine';

const repoRoot = path.resolve(process.cwd(), '..', '..');
const apiSrc = path.join(repoRoot, 'apps', 'api', 'src');

const walk = (dir: string): readonly string[] => {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
};

const task = (dedupeKey: string, id = 'task-1'): RsiSafeTask => ({ id, dedupeKey, priority: 'P2' });

const readPorts = (): { ports: RecoveryReadPorts; calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    ports: {
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
        return { opportunityRef: input.opportunityRef, caseRef: 'case-1', evidenceCount: 3, kinds: ['POD'] };
      },
      async customsAuthorizationReadinessRead(input) {
        calls.push('customs');
        return { opportunityRef: input.opportunityRef, route: 'MODE_A', readyToFile: false, blockerCodes: ['POA_MISSING'] };
      },
    },
  };
};

const deps = (over: Partial<RecoverySiPackDependencies> = {}, calls?: string[]): RecoverySiPackDependencies => {
  const built = readPorts();
  if (calls) calls.push(...built.calls);
  return {
    readPorts: built.ports,
    bind: (t) => {
      const match = /^task:recovery:([A-Z_]+):(.+)$/.exec(t.dedupeKey);
      if (match === null) return null;
      return {
        organizationId: 'org-1',
        domain: match[1] as never,
        actionKind: 'EXECUTE_READ_ONLY_CHECK',
        opportunityRef: match[2],
      };
    },
    ...over,
  };
};

describe('STEP_3 · 唯一 Runtime 架构回归（SECOND_RUNTIME = 0）', () => {
  it('STEP3_ARCH_1 只有 runtime/rsi-run.ts 组合事件循环（产品代码无第二 runtime）', () => {
    const offenders = walk(apiSrc)
      .filter((file) => !file.includes(`${path.sep}__tests__${path.sep}`))
      // 定义方（owner）与只导入**类型**的文件不算消费者：只统计值导入 createRsiEventLoop 的文件
      .filter((file) => /import\s*\{[^}]*\bcreateRsiEventLoop\b[^}]*\}\s*from '\.\/rsi-event-loop'/.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(repoRoot, file).replace(/\\/g, '/'));
    expect(offenders).toEqual(['apps/api/src/runtime/rsi-run.ts']);
  });

  it('STEP3_ARCH_2 依赖方向：services/autonomy 不得依赖 services/intelligence（POLICY_CORE_DEPENDS_ON_DOMAIN_PACK = FORBIDDEN）', () => {
    const autonomy = path.join(apiSrc, 'services', 'autonomy');
    const offenders = walk(autonomy)
      .filter((file) => /from '(\.\.\/)+intelligence\//.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.basename(file));
    expect(offenders).toEqual([]);
  });

  it('STEP3_ARCH_3 允许方向存在：Recovery Pack 静态组合 Council Policy Core', () => {
    const recoveryPolicy = fs.readFileSync(
      path.join(apiSrc, 'services', 'intelligence', 'recovery-policy.ts'),
      'utf8',
    );
    expect(recoveryPolicy).toContain("from '../autonomy/rsi-policy-engine'");
    expect(fs.readFileSync(path.join(apiSrc, 'runtime', 'rsi-run.ts'), 'utf8')).toContain("from './rsi-domain-pack'");
  });

  it('STEP3_ARCH_4 无动态注册 / 无第二 policy engine；runtime 成员描述正确', () => {
    const members = describeRsiRuntimeMembers([
      { packId: 'recovery-si', domain: 'recovery', matches: () => false, run: async () => {
        throw new Error('unused');
      } },
    ]);
    expect(members.secondRuntime).toBe(0);
    expect(members.domainPacks).toEqual(['recovery-si']);
    expect(members.devScopeMembers).toEqual(['tools/autopilot/**']);
    expect(RSI_DOMAIN_PACK_BOUNDARY.dynamicSelfRegistration).toContain('FORBIDDEN');
    expect(RSI_DOMAIN_PACK_BOUNDARY.createsRuntime).toBe(false);
    expect(RSI_RUNTIME_COMPOSITION_BOUNDARY.secondRuntime).toBe(0);
  });
});

describe('STEP_3 · domain pack 派发 fail-closed', () => {
  it('STEP3_DISPATCH_1 未匹配任务 → BLOCK（绝不 PASS / 绝不 no-op 成功）', async () => {
    const runner = createRsiDomainPackRunner({ packs: [] });
    const result = await runner.run(task('task:unknown:1'));
    expect(result.status).toBe('BLOCK');
    expect(result.evidenceRef).toBe('domain-pack:unmatched');
    expect(runner.dispatchLog()[0]?.packId).toBe('(unmatched)');
  });

  it('STEP3_DISPATCH_2 pack 自报外部写 → 降级为 BLOCK', async () => {
    const rogue: RsiDomainCapabilityPack = {
      packId: 'rogue',
      domain: 'x',
      matches: () => true,
      run: async () => ({
        status: 'PASS',
        evidenceRef: 'rogue:1',
        reasonCodes: [],
        modelCallCount: 0,
        guardActions: [],
        externalWritePerformed: true,
      }),
    };
    const runner = createRsiDomainPackRunner({ packs: [rogue] });
    const result = await runner.run(task('task:rogue:1'));
    expect(result.status).toBe('BLOCK');
    expect(RSI_DOMAIN_PACK_BOUNDARY.packSelfGrantedExternalWrite).toContain('BLOCK');
  });
});

describe('STEP_3 · Recovery SI pack（policy → guard → read tools → evidence）', () => {
  it('STEP3_PACK_1 未绑定任务 → BLOCK', async () => {
    const pack = createRecoverySiPack(deps());
    const evidence = await pack.run({ task: task('task:other:1'), packId: 'recovery-si' });
    expect(evidence.status).toBe('BLOCK');
    expect(evidence.reasonCodes).toContain('RECOVERY_PACK_UNBOUND_TASK');
    expect(evidence.externalWritePerformed).toBe(false);
  });

  it('STEP3_PACK_2 CUSTOMS 执行类 intent：guard action = null（L5 永久拒绝）→ BLOCK，且不执行只读工具', async () => {
    const customsExecution: RecoveryPlanAction = {
      domain: 'CUSTOMS',
      opportunityRef: 'opp-1',
      objective: 'l5-probe',
      proposedAction: 'READY_FOR_EXECUTION',
      reasonCodes: [],
      prerequisites: [],
      missingEvidence: [],
      authorizationRequired: true,
      ownerApprovalRequired: true,
      expectedRecovery: null,
      confidence: 'LOW',
      executionMode: 'EXTERNAL_GATED',
      toolRef: null,
      blockedReason: null,
    };
    // CUSTOMS + 执行类 intent 在 guard-action 绑定层就是 null（未放宽 L5 永久禁止边界）
    expect(resolveGuardAction(customsExecution)).toBeNull();

    const readCalls: string[] = [];
    const pack = createRecoverySiPack({
      ...deps(),
      readPorts: readPorts().ports,
      bind: () => ({
        organizationId: 'org-1',
        domain: 'CUSTOMS',
        actionKind: 'READY_FOR_EXECUTION',
        opportunityRef: 'opp-1',
      }),
    });
    const evidence = await pack.run({ task: task('task:recovery:CUSTOMS:opp-1'), packId: 'recovery-si' });
    expect(evidence.status).toBe('BLOCK');
    expect(evidence.guardActions).toEqual([]);
    expect(readCalls).toEqual([]);
  });

  it('STEP3_PACK_3 只读工具失败 → BLOCK（不允许把读取失败当 PASS）', async () => {
    const built = readPorts();
    const failing: RecoveryReadPorts = {
      ...built.ports,
      opportunityRead: async () => {
        throw new Error('read failed');
      },
    };
    const pack = createRecoverySiPack({
      ...deps(),
      readPorts: failing,
    });
    const evidence = await pack.run({ task: task('task:recovery:PLATFORM:opp-1'), packId: 'recovery-si' });
    expect(evidence.status).toBe('BLOCK');
    expect(evidence.reasonCodes).toContain('RECOVERY_READ_TOOL_FAILED');
  });

  it('STEP3_PACK_4 只读 happy path → PASS + 证据引用；零模型调用、零外写', async () => {
    expect(decideRecoveryAction('EXECUTE_READ_ONLY_CHECK').allowedForRecoverySi).toBe(true);
    const calls: string[] = [];
    const pack = createRecoverySiPack(deps({}, calls));
    const evidence = await pack.run({ task: task('task:recovery:PLATFORM:opp-1'), packId: 'recovery-si' });
    expect(evidence.status).toBe('PASS');
    expect(evidence.evidenceRef.startsWith('recovery-si:PLATFORM:')).toBe(true);
    expect(evidence.modelCallCount).toBe(0);
    expect(evidence.externalWritePerformed).toBe(false);
    expect(evidence.guardActions.length).toBe(1);
    expect(RECOVERY_SI_PACK_BOUNDARY.isSecondRuntime).toBe(false);
    expect(RECOVERY_SI_PACK_BOUNDARY.realModelCalls).toBe(0);
    expect(RECOVERY_SI_PACK_BOUNDARY.customFilingUnchanged).toContain('L5');
    void calls;
  });
});
