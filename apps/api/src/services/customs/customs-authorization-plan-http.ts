/**
 * CA-6 — 一键追回授权计划只读 HTTP 边界（MSG-20261004-02 §10）
 *   GET /customs-opportunities/:id/authorization-plan
 * 只读：不触发 filing、不写库、不外写；响应显式声明只读边界。
 * RBAC 复用既有海关只读角色（CUSTOMS_CLAIM_READ_ROLES），不新造权限模型。
 */

import { CUSTOMS_CLAIM_READ_ROLES } from './customs-claim-ready-http';
import type { CustomsOneClickAuthorizationPlan } from './customs-one-click-authorization';

export interface CustomsAuthorizationPlanHttpDeps {
  loadPlan(input: { organizationId: string; opportunityId: string }): Promise<CustomsOneClickAuthorizationPlan | null>;
}

export interface CustomsAuthorizationPlanHttpResult {
  status: number;
  body: Record<string, unknown>;
}

export async function handleCustomsAuthorizationPlanRequest(
  input: { opportunityId: string; session: { organizationId: string; actorUserId: string; role: string } },
  deps: CustomsAuthorizationPlanHttpDeps,
): Promise<CustomsAuthorizationPlanHttpResult> {
  const { session } = input;
  if (!(CUSTOMS_CLAIM_READ_ROLES as readonly string[]).includes(session.role)) {
    return { status: 403, body: { error: 'FORBIDDEN', reason: 'ROLE_NOT_PERMITTED' } };
  }
  if (typeof input.opportunityId !== 'string' || input.opportunityId.trim() === '') {
    return { status: 400, body: { error: 'INVALID_REQUEST', reason: 'OPPORTUNITY_ID_REQUIRED' } };
  }
  const plan = await deps.loadPlan({ organizationId: session.organizationId, opportunityId: input.opportunityId });
  if (!plan) return { status: 404, body: { error: 'NOT_FOUND' } };
  return {
    status: 200,
    body: {
      opportunityId: input.opportunityId,
      authorizationPlan: plan,
      boundary: {
        readOnly: true,
        filingSubmitted: false,
        transportEnabled: false,
        externalWritePerformed: false,
        productionCredentials: 'ABSENT',
      },
    },
  };
}
