/**
 * C21 — ONE-CLICK START RECOVERY HTTP 边界（HOST DIRECTIVE 2026-10-03 补充四；MSG-20261003-124 ⑭–㉑）
 * ---------------------------------------------------------------
 *   · POST /customs-opportunities/:id/start-recovery —— 只做 server-side validation / qualification /
 *     authorization readiness / filing route decision / immutable snapshot / internal workflow state。
 *     **不调用 C18 provider、不执行 filing**：filingSubmitted=false、externalWritePerformed=false、
 *     transportEnabled=false、externalExecutionStatus=NOT_STARTED（⑯⑰）。
 *   · GET /customs-opportunities/:id/filing-status —— tenant-scoped 读模型（C19 projection），
 *     不返回 credential / broker secret / authority token / raw PII（⑳）。
 *   · 身份与全部业务事实由 server 派生；client 注入领域字段一律 400（⑱）。
 */

import { PERMISSIONS, type AppRole } from '../workflow/permissions';
import type { CustomsAuthorizationFlags } from './customs-authorization-readiness';
import {
  CUSTOMS_ONE_CLICK_FORBIDDEN_CLIENT_FIELDS,
  prepareCustomsOneClickStart,
  type CustomsOneClickOutcome,
  type CustomsOpportunityTruth,
} from './customs-one-click-start';
import {
  projectCustomsFilingStatus,
  type CustomsFilingStatusFact,
} from './customs-filing-status';
import type { CustomsFilingCapabilities } from './customs-filing-provider';

export const CUSTOMS_RECOVERY_START_CAPABILITY = 'customs.recovery.one_click_start';

export interface CustomsRecoveryHttpSession {
  organizationId: string;
  actorUserId: string;
  role: string;
}

export interface CustomsRecoveryHttpResult {
  status: number;
  body: Record<string, unknown>;
}

export interface CustomsRecoveryHttpDeps {
  opportunities: {
    load(organizationId: string, opportunityId: string): Promise<CustomsOpportunityTruth | null>;
  };
  authorization: CustomsAuthorizationFlags;
  provider: { providerId: string; capabilities: CustomsFilingCapabilities } | null;
  filingStatus: { listFacts(organizationId: string, opportunityId: string): Promise<CustomsFilingStatusFact[]> };
  now?: () => Date;
}

const FAILURE_STATUS: Record<string, number> = {
  INVALID_REQUEST: 400,
  CAPABILITY_REQUIRED: 403,
  OPPORTUNITY_NOT_FOUND: 404,
  ENTRY_FACT_MISSING: 409,
  EVIDENCE_INCOMPLETE: 409,
  NOT_ELIGIBLE: 409,
  AMOUNT_NOT_READY: 409,
  REMEDY_ROUTE_MISSING: 409,
  DEADLINE_PASSED: 409,
  PACKAGE_NOT_READY: 409,
  AUTHORIZATION_NOT_READY: 409,
  FILING_CAPABILITY_MISSING: 409,
};

export function classifyCustomsRecoveryHttp(outcome: CustomsOneClickOutcome): CustomsRecoveryHttpResult {
  if (outcome.ready) {
    return {
      status: 200,
      body: {
        recoveryStatus: 'READY_TO_FILE',
        filingSubmitted: false,
        externalExecutionStatus: 'NOT_STARTED',
        submissionSnapshot: outcome.snapshot,
        blockers: [],
      },
    };
  }
  return {
    status: FAILURE_STATUS[outcome.reasonCode] ?? 400,
    body: {
      code: outcome.reasonCode,
      disposition: outcome.disposition,
      blockers: outcome.blockers,
      filingSubmitted: false,
      externalExecutionStatus: 'NOT_STARTED',
    },
  };
}

function roleCanStart(role: string): boolean {
  const matrix = PERMISSIONS[role as AppRole];
  return matrix !== undefined && matrix.startCustomsRecovery === true;
}

function roleIsKnown(role: string): boolean {
  return PERMISSIONS[role as AppRole] !== undefined;
}

export async function handleCustomsRecoveryStartRequest(
  input: {
    opportunityId: string;
    request: Record<string, unknown>;
    session: CustomsRecoveryHttpSession;
  },
  deps: CustomsRecoveryHttpDeps,
): Promise<CustomsRecoveryHttpResult> {
  for (const field of CUSTOMS_ONE_CLICK_FORBIDDEN_CLIENT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(input.request, field)) {
      return { status: 400, body: { code: 'INVALID_REQUEST', detail: 'FIELD_NOT_ALLOWED:' + field } };
    }
  }
  const allowed = roleCanStart(input.session.role);
  const outcome = await prepareCustomsOneClickStart(
    {
      opportunityId: input.opportunityId,
      request: input.request,
      context: {
        organizationId: input.session.organizationId,
        actorUserId: input.session.actorUserId,
        actorCapabilities: allowed ? [CUSTOMS_RECOVERY_START_CAPABILITY] : [],
      },
      requiredCapability: CUSTOMS_RECOVERY_START_CAPABILITY,
    },
    {
      opportunities: deps.opportunities,
      authorization: deps.authorization,
      provider: deps.provider,
      ...(deps.now ? { now: deps.now } : {}),
    },
  );
  return classifyCustomsRecoveryHttp(outcome);
}

export async function handleCustomsFilingStatusReadRequest(
  input: { opportunityId: string; session: CustomsRecoveryHttpSession },
  deps: CustomsRecoveryHttpDeps,
): Promise<CustomsRecoveryHttpResult> {
  if (!roleIsKnown(input.session.role)) {
    return { status: 403, body: { code: 'CAPABILITY_REQUIRED' } };
  }
  const truth = await deps.opportunities.load(input.session.organizationId, input.opportunityId);
  if (truth === null) return { status: 404, body: { code: 'OPPORTUNITY_NOT_FOUND' } };
  const facts = await deps.filingStatus.listFacts(input.session.organizationId, input.opportunityId);
  const projection = projectCustomsFilingStatus(facts, {
    organizationId: input.session.organizationId,
    opportunityId: input.opportunityId,
  });
  return {
    status: 200,
    body: {
      filingStatus: {
        opportunityId: projection.opportunityId,
        currentStatus: projection.currentStatus,
        currentSourceLevel: projection.currentSourceLevel,
        currentFactId: projection.currentFactId,
        history: projection.history,
        factCount: projection.factCount,
        hasAuthorityVerifiedFact: projection.hasAuthorityVerifiedFact,
        inferredTransitions: projection.inferredTransitions,
        derivesRecoveredCash: false,
        derivesFee: false,
      },
    },
  };
}
