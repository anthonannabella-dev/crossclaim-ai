/**
 * CA-5 — CUSTOMS AUTHORIZATION CENTER 只读 HTTP 边界（MSG-20261004-02 §9）
 * ---------------------------------------------------------------
 *   · GET /customs-opportunities/:id/authorization-center → tenant-scoped 只读读模型（六项清单投影）。
 *   · 只读：不触发 filing、不外写、不扣款；响应显式带 filingSubmitted=false / transportEnabled=false。
 *   · RBAC 复用既有海关只读角色（CUSTOMS_CLAIM_READ_ROLES），不新造权限模型。
 *   · loadCenter 缺省实现返回 null → 404（fail-closed，不伪造状态）。
 */

import { CUSTOMS_CLAIM_READ_ROLES } from './customs-claim-ready-http';
import type { CustomsAuthorizationCenter } from './customs-authorization-center';

export interface CustomsAuthorizationCenterHttpSession {
  organizationId: string;
  actorUserId: string;
  role: string;
}

export interface CustomsAuthorizationCenterHttpDeps {
  loadCenter(input: { organizationId: string; opportunityId: string }): Promise<CustomsAuthorizationCenter | null>;
}

export interface CustomsAuthorizationCenterHttpResult {
  status: number;
  body: Record<string, unknown>;
}

export async function handleCustomsAuthorizationCenterRequest(
  input: { opportunityId: string; session: CustomsAuthorizationCenterHttpSession },
  deps: CustomsAuthorizationCenterHttpDeps,
): Promise<CustomsAuthorizationCenterHttpResult> {
  const { session } = input;
  if (!(CUSTOMS_CLAIM_READ_ROLES as readonly string[]).includes(session.role)) {
    return { status: 403, body: { error: 'FORBIDDEN', reason: 'ROLE_NOT_PERMITTED' } };
  }
  if (typeof input.opportunityId !== 'string' || input.opportunityId.trim() === '') {
    return { status: 400, body: { error: 'INVALID_REQUEST', reason: 'OPPORTUNITY_ID_REQUIRED' } };
  }

  const center = await deps.loadCenter({
    organizationId: session.organizationId,
    opportunityId: input.opportunityId,
  });
  if (!center) return { status: 404, body: { error: 'NOT_FOUND' } };

  return {
    status: 200,
    body: {
      opportunityId: input.opportunityId,
      authorizationCenter: center,
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
