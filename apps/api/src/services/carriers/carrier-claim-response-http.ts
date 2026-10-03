/**
 * CARRIER QUEUE #10 FINAL（MSG-20261003-122 ㉘㉙㉛）— HTTP 边界（router 可调用单元）。
 * ---------------------------------------------------------------
 *   · 人工补录：POST /carrier-claim-packages/:packageId/responses
 *     **只允许 source = USER_REPORTED** —— client body 出现 source / verificationLevel /
 *     身份字段一律 400（㉙：HTTP surface 不得暴露 provider 来源选择权）。
 *   · 读模型：GET /carrier-claim-packages/:packageId/responses（tenant-scoped；
 *     返回 currentStatus / currentVerificationLevel / history / provenance / timestamps，
 *     不返回任何 credential / raw provider secret）。
 *   · 角色 → 权限：PERMISSIONS[role].recordCarrierClaimResponse（OWNER/ADMIN/OPS）；
 *     读模型仅要求已认证成员角色已知（未知角色 403）。
 *   · 该动作已注册 Action Guard：carrier.claim_response.record（INTERNAL_WRITE，不启用 TRANSPORT）。
 *   · 状态映射：INVALID_REQUEST/PROVIDER_REFERENCE_REQUIRED/INVALID_TIMESTAMP/FUTURE_TIMESTAMP→400；
 *     CAPABILITY_REQUIRED→403；SUBMISSION_NOT_FOUND→404（anti-enumeration）；RECORDED→201；
 *     ALREADY_RECORDED→200（幂等重放不当 500）。错误响应只含稳定 code。
 *   · 绝不调用 carrier API / portal / browser automation；不产生 carrier confirmation；不动资金真值。
 */

import { PERMISSIONS, type AppRole } from '../workflow/permissions';
import {
  CARRIER_CLAIM_RESPONSE_CAPABILITY,
  projectCarrierClaimResponse,
  recordCarrierClaimResponse,
  type CarrierClaimResponseOutcome,
  type CarrierClaimResponseStore,
  type CarrierClaimResponseStatus,
  type CarrierClaimResponseSubmissionRef,
} from './carrier-claim-response';

/** 已认证会话派生的上下文（绝不来自 request body）。 */
export interface CarrierClaimResponseHttpSession {
  organizationId: string;
  actorUserId: string;
  role: string;
}

export interface CarrierClaimResponseHttpResult {
  status: number;
  body: Record<string, unknown>;
}

export interface CarrierClaimResponseHttpDeps {
  submissions: {
    load(organizationId: string, packageId: string): Promise<CarrierClaimResponseSubmissionRef | null>;
  };
  store: CarrierClaimResponseStore;
  now?: () => Date;
}

/** 人工补录 client 允许的字段（不含 source / verificationLevel / 身份字段）。 */
export interface CarrierClaimResponseHumanRequest {
  status: CarrierClaimResponseStatus;
  providerReference?: string | null;
  observedAt?: string | null;
  note?: string | null;
}

const FAILURE_STATUS: Record<string, number> = {
  INVALID_REQUEST: 400,
  PROVIDER_REFERENCE_REQUIRED: 400,
  PROVIDER_SOURCE_NOT_TRUSTED: 400,
  INVALID_TIMESTAMP: 400,
  FUTURE_TIMESTAMP: 400,
  CAPABILITY_REQUIRED: 403,
  SUBMISSION_NOT_FOUND: 404,
};

/** 人工入口禁止出现的字段（㉙）。 */
const FORBIDDEN_HUMAN_FIELDS = [
  'source',
  'verificationLevel',
  'organizationId',
  'recordedByUserId',
  'provider',
  'externalAccountId',
  'trackingNumber',
  'idempotencyKey',
  'factId',
] as const;

function roleCanRecord(role: string): boolean {
  const matrix = PERMISSIONS[role as AppRole];
  return matrix !== undefined && matrix.recordCarrierClaimResponse === true;
}

function roleIsKnown(role: string): boolean {
  return PERMISSIONS[role as AppRole] !== undefined;
}

export async function handleCarrierClaimResponseRecordRequest(
  input: {
    packageId: string;
    request: CarrierClaimResponseHumanRequest & Record<string, unknown>;
    session: CarrierClaimResponseHttpSession;
  },
  deps: CarrierClaimResponseHttpDeps,
): Promise<CarrierClaimResponseHttpResult> {
  for (const field of FORBIDDEN_HUMAN_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(input.request, field)) {
      return { status: 400, body: { code: 'INVALID_REQUEST', detail: 'FIELD_NOT_ALLOWED:' + field } };
    }
  }

  const allowed = roleCanRecord(input.session.role);
  const outcome: CarrierClaimResponseOutcome = await recordCarrierClaimResponse(
    {
      packageId: input.packageId,
      request: {
        status: input.request.status,
        source: 'USER_REPORTED',
        providerReference: input.request.providerReference ?? null,
        observedAt: input.request.observedAt ?? null,
        note: input.request.note ?? null,
      },
      context: {
        organizationId: input.session.organizationId,
        actorUserId: input.session.actorUserId,
        actorCapabilities: allowed ? [CARRIER_CLAIM_RESPONSE_CAPABILITY] : [],
      },
    },
    { submissions: deps.submissions, store: deps.store, ...(deps.now ? { now: deps.now } : {}) },
  );

  if (!outcome.ok) {
    return { status: FAILURE_STATUS[outcome.reason] ?? 400, body: { code: outcome.reason } };
  }
  return {
    status: outcome.status === 'RECORDED' ? 201 : 200,
    body: { status: outcome.status, responseFact: outcome.fact },
  };
}

export async function handleCarrierClaimResponseReadRequest(
  input: { packageId: string; session: CarrierClaimResponseHttpSession },
  deps: CarrierClaimResponseHttpDeps,
): Promise<CarrierClaimResponseHttpResult> {
  if (!roleIsKnown(input.session.role)) {
    return { status: 403, body: { code: 'CAPABILITY_REQUIRED' } };
  }
  const submission = await deps.submissions.load(input.session.organizationId, input.packageId);
  if (submission === null) return { status: 404, body: { code: 'SUBMISSION_NOT_FOUND' } };

  const facts = await deps.store.listByPackage(input.session.organizationId, input.packageId);
  const projection = projectCarrierClaimResponse(facts, {
    organizationId: input.session.organizationId,
    packageId: input.packageId,
  });
  return {
    status: 200,
    body: {
      responses: {
        packageId: projection.packageId,
        currentStatus: projection.currentStatus,
        currentVerificationLevel: projection.currentVerificationLevel,
        currentFactId: projection.currentFactId,
        history: projection.statusHistory,
        factCount: projection.factCount,
        hasProviderVerifiedFact: projection.hasProviderVerifiedFact,
        derivesRecoveredCash: false,
        derivesSuccessFee: false,
      },
    },
  };
}
