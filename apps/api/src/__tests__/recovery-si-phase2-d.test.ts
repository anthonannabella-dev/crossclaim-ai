/** Recovery SI P2-D v1 —— Action Guard dry-run 验收（MSG-20261005-19：D1–D10） */

import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildCustomerRecoveryState,
  type CapabilitySlice,
  type CustomerRecoveryState,
  type OpportunitySlice,
} from '../services/intelligence/customer-recovery-state';
import { planRecovery } from '../services/intelligence/recovery-planner';
import { prioritizeOpportunities } from '../services/intelligence/recovery-prioritizer';
import { decideRecoveryExecutionRequest } from '../services/intelligence/recovery-policy';
import {
  RECOVERY_ALLOWED_GUARD_ACTIONS,
  RECOVERY_GUARD_ACTION_MAP,
  RECOVERY_GUARD_DRY_RUN_BOUNDARY,
  RECOVERY_PLAN_DIGEST_VERSION,
  buildRecoveryPlanDigest,
  resolveGuardAction,
  runRecoveryGuardDryRun,
} from '../services/intelligence/recovery-guard-dry-run';
import { createRecoveryToolRegistry, type RecoveryToolRegistry } from '../services/intelligence/recovery-tool-registry';
import { evaluateActionGuard, type ActionGuardResult } from '../services/action-guard/action-guard';
import type { ControlPlaneSnapshot } from '../services/action-guard/control-plane';

const NOW = '2026-10-05T04:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const ORG = 'org-p2d';

const opportunity = (over: Partial<OpportunitySlice> = {}): OpportunitySlice => ({
  opportunityRef: 'opp-1',
  domain: 'CARRIER',
  organizationId: ORG,
  recoverable: { amount: 680, currency: 'USD', source: 'CANONICAL_FACT' },
  eligibility: 'ELIGIBLE',
  evidenceComplete: true,
  missingEvidence: [],
  authorizationReady: true,
  deadline: '2026-11-01T00:00:00.000Z',
  providerCostUsd: 0,
  expectedOperationalCostUsd: 0,
  riskClass: 'LOW',
  observedAt: NOW,
  ...over,
});

const capability = (domain: CapabilitySlice['domain']): CapabilitySlice => ({
  domain,
  readOnlyTools: [],
  providerApproval: 'READY',
});

const stateWith = (opportunities: readonly OpportunitySlice[]): CustomerRecoveryState => {
  const result = buildCustomerRecoveryState({
    organizationId: ORG,
    observedAt: NOW,
    opportunities,
    capability: [capability('CARRIER'), capability('CUSTOMS'), capability('PLATFORM'), capability('INDEPENDENT_SITE')],
  });
  if (!result.ok) throw new Error('fixture tenant mismatch');
  return result.state;
};

const registry = (): RecoveryToolRegistry =>
  createRecoveryToolRegistry([
    { name: 'recovery.carrier.package_preview.prepare', domain: 'CARRIER', access: 'PREPARE', description: 'fixture', invoke: async () => ({}) },
    { name: 'recovery.customs.package_preview.prepare', domain: 'CUSTOMS', access: 'PREPARE', description: 'fixture', invoke: async () => ({}) },
    { name: 'recovery.opportunity.read', domain: 'PLATFORM', access: 'READ', description: 'fixture', invoke: async () => ({}) },
  ]);

const controlPlane = (opts: { decision?: ActionGuardResult['decision']; degraded?: boolean; code?: string } = {}) => {
  let calls = 0;
  let seenCapabilities: unknown = 'NOT_SET';
  return {
    calls: () => calls,
    seenCapabilities: () => seenCapabilities,
    port: {
      async snapshotFor(): Promise<ControlPlaneSnapshot> {
        return {
          degraded: opts.degraded === true,
          config: {
            globalDisabled: false,
            mode: 'DRY_RUN',
            productionGate: 'NOT_SATISFIED',
            platformEnabled: {},
            tenantFeatureEnabled: {},
            hostApprovalGranted: false,
          },
        };
      },
      async evaluateWithoutAudit(input: { action: string; capabilities?: unknown }): Promise<ActionGuardResult> {
        calls += 1;
        seenCapabilities = input.capabilities ?? null;
        return {
          decision: opts.decision ?? 'DENY',
          code: opts.code ?? 'ACTION_GUARD_DRY_RUN_DENY_FIXTURE',
          action: input.action,
          risk: 'EXTERNAL_WRITE',
          reasons: ['fixture'],
          requiredGates: [],
        };
      },
    },
  };
};

const planFor = (state: CustomerRecoveryState, reg: RecoveryToolRegistry) =>
  planRecovery({ state, ranked: prioritizeOpportunities(state).ranked, registry: reg, generatedAt: NOW });

describe('Recovery SI P2-D v1 · Action Guard dry-run', () => {
  it('D1 只有 fresh verified READY_FOR_EXECUTION 才进入 Guard；篡改/陈旧 → 零 Guard 调用', async () => {
    const state = stateWith([opportunity({ opportunityRef: 'opp-carrier' })]);
    const reg = registry();
    const plan = planFor(state, reg);
    const cp = controlPlane({ decision: 'ALLOW' });
    const run = await runRecoveryGuardDryRun({
      state, plan, registry: reg, controlPlane: cp.port, actorUserId: 'user-1', actorOrganizationId: ORG, nowMs: NOW_MS,
    });
    expect(run.ok).toBe(true);
    if (!run.ok) throw new Error('unreachable');
    expect(run.outcomes.length).toBeGreaterThan(0);
    expect(cp.calls()).toBe(run.guardCallCount);

    const tampered = { ...plan, actions: plan.actions.map((a) => (a.expectedRecovery ? { ...a, expectedRecovery: { ...a.expectedRecovery, amount: a.expectedRecovery.amount + 1 } } : a)) };
    const cp2 = controlPlane({ decision: 'ALLOW' });
    const rerun = await runRecoveryGuardDryRun({
      state, plan: tampered, registry: reg, controlPlane: cp2.port, actorUserId: 'user-1', actorOrganizationId: ORG, nowMs: NOW_MS,
    });
    expect(rerun.ok).toBe(true);
    if (!rerun.ok) throw new Error('unreachable');
    expect(rerun.outcomes.filter((o) => o.guardEvaluated)).toEqual([]);
    expect(cp2.calls()).toBe(0);
  });

  it('D2 不可变 execution basis 字段完整且指向真实 catalog action', async () => {
    const state = stateWith([opportunity({ opportunityRef: 'opp-carrier' })]);
    const reg = registry();
    const plan = planFor(state, reg);
    const cp = controlPlane({ decision: 'ALLOW' });
    const run = await runRecoveryGuardDryRun({
      state, plan, registry: reg, controlPlane: cp.port, actorUserId: 'user-1', actorOrganizationId: ORG, nowMs: NOW_MS,
    });
    if (!run.ok) throw new Error('unreachable');
    const basis = run.outcomes[0]!.basis!;
    expect(basis.basisVersion).toBe('recovery-execution-basis/v1');
    expect(basis.organizationId).toBe(ORG);
    expect(basis.recoveryActionKind).toBe('READY_FOR_EXECUTION');
    expect(basis.guardAction).toBe('claim.submit');
    expect(basis.planDigestVersion).toBe(RECOVERY_PLAN_DIGEST_VERSION);
    expect(basis.planDigest).toMatch(/^[0-9a-f]{64}$/);
    // 映射引用的必须是既有 catalog action（不是自造名字）
    expect(evaluateActionGuard({ action: basis.guardAction!, actorUserId: 'u', organizationId: ORG }).code).not.toBe('ACTION_GUARD_UNKNOWN_ACTION');
  });

  it('D3 tenant mismatch / actor 错配 → fail-closed 且零 Guard 调用', async () => {
    const state = stateWith([opportunity({})]);
    const reg = registry();
    const plan = planFor(state, reg);
    const cp = controlPlane({ decision: 'ALLOW' });
    const run = await runRecoveryGuardDryRun({
      state, plan, registry: reg, controlPlane: cp.port, actorUserId: 'u', actorOrganizationId: 'org-other', nowMs: NOW_MS,
    });
    expect(run.ok).toBe(false);
    if (run.ok) throw new Error('unreachable');
    expect(run.reason).toBe('TENANT_MISMATCH');
    expect(cp.calls()).toBe(0);
  });

  it('D4 Contro Plane 降级 → DENY 且零 Guard 调用', async () => {
    const state = stateWith([opportunity({})]);
    const reg = registry();
    const plan = planFor(state, reg);
    const cp = controlPlane({ degraded: true });
    const run = await runRecoveryGuardDryRun({
      state, plan, registry: reg, controlPlane: cp.port, actorUserId: 'u', actorOrganizationId: ORG, nowMs: NOW_MS,
    });
    if (!run.ok) throw new Error('unreachable');
    expect(run.outcomes.every((o) => o.decision === 'DENY')).toBe(true);
    expect(cp.calls()).toBe(0);
  });

  it('D5/D6 dry-run 不消费审批、不产生任何业务写入标记', async () => {
    const state = stateWith([opportunity({})]);
    const reg = registry();
    const plan = planFor(state, reg);
    const cp = controlPlane({ decision: 'ALLOW' });
    const run = await runRecoveryGuardDryRun({
      state, plan, registry: reg, controlPlane: cp.port, actorUserId: 'u', actorOrganizationId: ORG, nowMs: NOW_MS,
    });
    if (!run.ok) throw new Error('unreachable');
    expect(run.outcomes.every((o) => o.approvalConsumed === false)).toBe(true);
    expect(run.outcomes.every((o) => o.executorInvoked === false && o.executionAuthorized === false)).toBe(true);
    expect(RECOVERY_GUARD_DRY_RUN_BOUNDARY.approvalConsumption).toBe('FORBIDDEN');
    expect(RECOVERY_GUARD_DRY_RUN_BOUNDARY.businessFactWrite).toBe('FORBIDDEN');
  });

  it('D7/D8 Guard ALLOW 仍不是执行授权；CUSTOMS_FILING 继续 L5 且零 Guard 调用', async () => {
    const state = stateWith([opportunity({})]);
    const reg = registry();
    const plan = planFor(state, reg);
    const cp = controlPlane({ decision: 'ALLOW' });
    const run = await runRecoveryGuardDryRun({
      state, plan, registry: reg, controlPlane: cp.port, actorUserId: 'u', actorOrganizationId: ORG, nowMs: NOW_MS,
    });
    if (!run.ok) throw new Error('unreachable');
    expect(run.outcomes.every((o) => o.decision === 'ALLOW')).toBe(true);
    expect(RECOVERY_GUARD_DRY_RUN_BOUNDARY.executorInvocation).toBe('FORBIDDEN');

    const l5 = decideRecoveryExecutionRequest('CUSTOMS_FILING');
    expect(l5.permanentlyForbidden).toBe(true);
    expect(l5.allowedForRsi).toBe(false);
    expect(RECOVERY_GUARD_ACTION_MAP.CUSTOMS).toBeNull();
  });

  it('D9 未映射执行意图 → DENY 且零 Guard 调用（Customs 同理）', async () => {
    const state = stateWith([opportunity({ opportunityRef: 'opp-customs', domain: 'CUSTOMS' })]);
    const reg = registry();
    const plan = planFor(state, reg);
    const cp = controlPlane({ decision: 'ALLOW' });
    const run = await runRecoveryGuardDryRun({
      state, plan, registry: reg, controlPlane: cp.port, actorUserId: 'u', actorOrganizationId: ORG, nowMs: NOW_MS,
    });
    if (!run.ok) throw new Error('unreachable');
    const customs = run.outcomes.filter((o) => o.domain === 'CUSTOMS');
    expect(customs.length).toBeGreaterThan(0);
    expect(customs.every((o) => o.decision === 'DENY' && o.guardEvaluated === false)).toBe(true);
    expect(customs[0]!.code).toBe('GUARD_ACTION_UNMAPPED_L5_NO_CATALOG_ACTION');
    expect(cp.calls()).toBe(0);
    const customsReady = plan.actions.find((a) => a.domain === 'CUSTOMS' && a.proposedAction === 'READY_FOR_EXECUTION')!;
    expect(resolveGuardAction(customsReady)).toBeNull();
  });

  it('D9 SI 不构造 capabilities（传给 Guard 的 capabilities 为空）', async () => {
    const state = stateWith([opportunity({})]);
    const reg = registry();
    const plan = planFor(state, reg);
    const cp = controlPlane({ decision: 'ALLOW' });
    await runRecoveryGuardDryRun({
      state, plan, registry: reg, controlPlane: cp.port, actorUserId: 'u', actorOrganizationId: ORG, nowMs: NOW_MS,
    });
    expect(cp.seenCapabilities()).toBeNull();
    expect(RECOVERY_GUARD_DRY_RUN_BOUNDARY.siSelfSuppliedCapabilities).toBe(false);
  });

  it('D10 planDigest：同 plan 稳定、keys 顺序无关、execution-relevant 字段改变即变化', () => {
    const state = stateWith([opportunity({ opportunityRef: 'opp-a' }), opportunity({ opportunityRef: 'opp-b', domain: 'CARRIER' })]);
    const reg = registry();
    const plan = planFor(state, reg);
    const verified = plan.actions.filter((a) => a.proposedAction === 'READY_FOR_EXECUTION' || a.proposedAction === 'PREPARE_PACKAGE');
    const digestA = buildRecoveryPlanDigest({ plan, verifiedActions: verified });
    const digestB = buildRecoveryPlanDigest({ plan: { ...plan, actions: [...plan.actions].reverse() }, verifiedActions: [...verified].reverse() });
    expect(digestA).toBe(digestB);

    const tampered = verified.map((a) => (a.opportunityRef === 'opp-a' ? { ...a, expectedRecovery: { amount: 1, currency: 'USD' } } : a));
    expect(buildRecoveryPlanDigest({ plan, verifiedActions: tampered })).not.toBe(digestA);
    expect(buildRecoveryPlanDigest({ plan: { ...plan, generatedAt: '2030-01-01T00:00:00.000Z' }, verifiedActions: verified })).toBe(digestA);
    expect(RECOVERY_PLAN_DIGEST_VERSION).toBe('plan-digest/v1');
  });

  it('D9/D10 边界常量与静态映射自证（无动态名 / 无 fallback / 白名单）', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../services/intelligence/recovery-guard-dry-run.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/capabilities\s*:/);
    // 只禁止"动态构造 action 名"的手段（模板拼接在普通字符串中允许）
    expect(code).not.toMatch(/new Function|eval\(|require\(/);
    expect(code).toMatch(/RECOVERY_GUARD_ACTION_MAP/);
    expect(RECOVERY_GUARD_DRY_RUN_BOUNDARY.staticGuardActionMapping).toBe(true);
    expect(RECOVERY_GUARD_DRY_RUN_BOUNDARY.fallbackGuess).toBe(false);
    expect(RECOVERY_GUARD_DRY_RUN_BOUNDARY.runtimeWiring).toBe('NONE');
    for (const name of Object.values(RECOVERY_GUARD_ACTION_MAP)) {
      if (name === null) continue;
      expect(RECOVERY_ALLOWED_GUARD_ACTIONS).toContain(name);
    }
  });
});
