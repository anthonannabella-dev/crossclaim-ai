/**
 * Recovery SI —— 结构化 Recovery Plan（Phase 1）
 * ---------------------------------------------------------------
 * 输入：CustomerRecoveryState + 优先级排序 + 工具注册表；
 * 输出：**确定性** action 列表（同样的 snapshot → 同样的 plan）。
 *
 * Phase 1 允许的动作集合（**不含 REAL_SUBMIT**）：EXECUTE_READ_ONLY_CHECK / PREPARE_PACKAGE /
 * REQUEST_EVIDENCE / REQUEST_AUTHORIZATION / REQUEST_OWNER_APPROVAL / WAIT_PROVIDER / FILE_MODE_FALLBACK /
 * HOLD / READY_FOR_EXECUTION。所有 action 的 `executionMode` 均为 `SIMULATED`（真正执行仍走 Action Guard → HITL/OWNER）。
 */

import type { CustomerRecoveryState, OpportunitySlice, RecoveryDomain } from './customer-recovery-state';
import type { ScoredOpportunity } from './recovery-prioritizer';
import type { RecoveryToolRegistry } from './recovery-tool-registry';

export const RECOVERY_ACTION_KINDS = [
  'EXECUTE_READ_ONLY_CHECK',
  'PREPARE_PACKAGE',
  'REQUEST_EVIDENCE',
  'REQUEST_AUTHORIZATION',
  'REQUEST_OWNER_APPROVAL',
  'WAIT_PROVIDER',
  'FILE_MODE_FALLBACK',
  'HOLD',
  'READY_FOR_EXECUTION',
] as const;
export type RecoveryActionKind = (typeof RECOVERY_ACTION_KINDS)[number];

export interface RecoveryPlanAction {
  domain: RecoveryDomain;
  opportunityRef: string;
  objective: string;
  proposedAction: RecoveryActionKind;
  reasonCodes: readonly string[];
  prerequisites: readonly string[];
  missingEvidence: readonly string[];
  authorizationRequired: boolean;
  ownerApprovalRequired: boolean;
  expectedRecovery: { amount: number; currency: string } | null;
  confidence: ScoredOpportunity['confidence'];
  executionMode: 'SIMULATED' | 'EXTERNAL_GATED';
  toolRef: string | null;
  blockedReason: string | null;
}

export interface RecoveryPlan {
  organizationId: string;
  generatedAt: string;
  snapshotObservedAt: string;
  actions: readonly RecoveryPlanAction[];
  reasonCodes: readonly string[];
}

const pickTool = (
  registry: RecoveryToolRegistry,
  domain: RecoveryDomain,
  access: 'PREPARE' | 'READ',
): string | null => {
  const candidates = registry
    .list()
    .filter((tool) => tool.domain === domain && tool.access === access)
    .map((tool) => tool.name)
    .sort();
  return candidates[0] ?? null;
};

export function planRecovery(input: {
  state: CustomerRecoveryState;
  ranked: readonly ScoredOpportunity[];
  registry: RecoveryToolRegistry;
  generatedAt: string;
}): RecoveryPlan {
  const byRef = new Map<string, OpportunitySlice>(
    input.state.opportunities.map((slice) => [slice.opportunityRef, slice]),
  );
  const capabilityByDomain = new Map(input.state.capability.map((slice) => [slice.domain, slice]));
  const actions: RecoveryPlanAction[] = [];
  const planReasonCodes = new Set<string>();

  for (const scored of input.ranked) {
    const slice = byRef.get(scored.opportunityRef);
    if (slice === undefined) {
      actions.push({
        domain: scored.domain,
        opportunityRef: scored.opportunityRef,
        objective: 'unknown reference',
        proposedAction: 'HOLD',
        reasonCodes: ['REFERENCE_NOT_FOUND'],
        prerequisites: [],
        missingEvidence: [],
        authorizationRequired: false,
        ownerApprovalRequired: false,
        expectedRecovery: null,
        confidence: 'LOW',
        executionMode: 'SIMULATED',
        toolRef: null,
        blockedReason: 'REFERENCE_NOT_FOUND',
      });
      planReasonCodes.add('REFERENCE_NOT_FOUND');
      continue;
    }

    const capability = capabilityByDomain.get(slice.domain);
    const expectedRecovery =
      slice.recoverable === null
        ? null
        : { amount: scored.expectedRecoveryValue, currency: scored.currency };
    const base = {
      domain: slice.domain,
      opportunityRef: slice.opportunityRef,
      expectedRecovery,
      confidence: scored.confidence,
      executionMode: 'SIMULATED' as const,
      missingEvidence: [...slice.missingEvidence].sort(),
    };

    if (!slice.evidenceComplete || slice.missingEvidence.length > 0) {
      actions.push({
        ...base,
        objective: 'complete evidence before any submission',
        proposedAction: 'REQUEST_EVIDENCE',
        reasonCodes: ['EVIDENCE_INCOMPLETE'],
        prerequisites: ['evidence.complete'],
        authorizationRequired: !slice.authorizationReady,
        ownerApprovalRequired: false,
        toolRef: pickTool(input.registry, slice.domain, 'READ'),
        blockedReason: 'EVIDENCE_INCOMPLETE',
      });
      planReasonCodes.add('EVIDENCE_INCOMPLETE');
      continue;
    }
    if (!slice.authorizationReady) {
      actions.push({
        ...base,
        objective: 'obtain customer authorization',
        proposedAction: 'REQUEST_AUTHORIZATION',
        reasonCodes: ['AUTHORIZATION_MISSING'],
        prerequisites: ['authorization.ready'],
        authorizationRequired: true,
        ownerApprovalRequired: false,
        toolRef: pickTool(input.registry, slice.domain, 'READ'),
        blockedReason: 'AUTHORIZATION_MISSING',
      });
      planReasonCodes.add('AUTHORIZATION_MISSING');
      continue;
    }
    if (capability === undefined || capability.providerApproval === 'HOLD') {
      actions.push({
        ...base,
        objective: 'wait for provider approval / capability',
        proposedAction: 'WAIT_PROVIDER',
        reasonCodes: ['PROVIDER_APPROVAL_HOLD'],
        prerequisites: ['provider.approved'],
        authorizationRequired: false,
        ownerApprovalRequired: true,
        toolRef: null,
        blockedReason: 'PROVIDER_APPROVAL_HOLD',
      });
      planReasonCodes.add('PROVIDER_APPROVAL_HOLD');
      continue;
    }
    if (slice.riskClass === 'HIGH') {
      actions.push({
        ...base,
        objective: 'high-risk opportunity requires owner approval',
        proposedAction: 'REQUEST_OWNER_APPROVAL',
        reasonCodes: ['HIGH_RISK_OWNER_GATE'],
        prerequisites: ['owner.approval'],
        authorizationRequired: false,
        ownerApprovalRequired: true,
        toolRef: pickTool(input.registry, slice.domain, 'PREPARE'),
        blockedReason: null,
      });
      planReasonCodes.add('HIGH_RISK_OWNER_GATE');
      continue;
    }

    const prepareTool = pickTool(input.registry, slice.domain, 'PREPARE');
    if (prepareTool === null) {
      actions.push({
        ...base,
        objective: 'no registered PREPARE tool for this domain',
        proposedAction: 'HOLD',
        reasonCodes: ['TOOL_NOT_REGISTERED'],
        prerequisites: [],
        authorizationRequired: false,
        ownerApprovalRequired: false,
        toolRef: null,
        blockedReason: 'TOOL_NOT_REGISTERED',
      });
      planReasonCodes.add('TOOL_NOT_REGISTERED');
      continue;
    }

    actions.push({
      ...base,
      objective: 'prepare claim-ready package (no submission)',
      proposedAction: 'PREPARE_PACKAGE',
      reasonCodes: ['READY_TO_PREPARE'],
      prerequisites: ['evidence.complete', 'authorization.ready'],
      authorizationRequired: false,
      ownerApprovalRequired: false,
      toolRef: prepareTool,
      blockedReason: null,
    });
    actions.push({
      ...base,
      objective: 'hand off to deterministic executor after all gates',
      proposedAction: 'READY_FOR_EXECUTION',
      reasonCodes: ['SIMULATED_ONLY', 'ACTION_GUARD_REQUIRED'],
      prerequisites: ['action.guard', 'hitl.or.owner.gate'],
      authorizationRequired: false,
      // 走到这里说明 provider 能力已 READY；HIGH 风险在前一步已分流为 REQUEST_OWNER_APPROVAL
      ownerApprovalRequired: false,
      toolRef: prepareTool,
      blockedReason: null,
    });
    planReasonCodes.add('READY_TO_PREPARE');
  }

  return {
    organizationId: input.state.organizationId,
    generatedAt: input.generatedAt,
    snapshotObservedAt: input.state.observedAt,
    actions,
    reasonCodes: [...planReasonCodes].sort(),
  };
}

export const RECOVERY_PLANNER_BOUNDARY = {
  deterministic: true,
  realSubmitInPhase1: false,
  executionMode: 'SIMULATED',
  inventsFacts: false,
  mutatesState: false,
  invokesTools: false,
} as const;
