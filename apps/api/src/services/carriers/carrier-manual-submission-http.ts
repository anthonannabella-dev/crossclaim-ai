/**
 * CARRIER QUEUE #9B FINAL（MSG-20261003-119 ㉔㉕㉖㉗㉘）— HTTP 边界（router 可调用单元）。
 * ---------------------------------------------------------------
 * 职责：把已认证会话（server-derived）与 route param 组合成 domain 调用，并把结果映射为稳定 HTTP 响应。
 *   · route: POST /carrier-claim-packages/:packageId/manual-submission
 *   · client 只能提交 carrierReference? / reportedCarrierSubmissionAt? / note?（packageId 来自 route param）。
 *   · 角色 → 权限：PERMISSIONS[role].recordCarrierManualSubmission（OWNER/ADMIN/OPS；FINANCE/VIEWER/未知角色拒绝）。
 *   · 该动作已注册进 Action Guard（carrier.manual_submission.record，INTERNAL_WRITE + workflow kill switch）。
 *   · 状态映射（㉖）：INVALID_REQUEST→400；CAPABILITY_REQUIRED→403；PACKAGE_NOT_FOUND→404；
 *     TENANT_MISMATCH→404（与既有 anti-enumeration 约定一致）；PACKAGE_NOT_READY→409；
 *     RECORDED→201；ALREADY_RECORDED→200（幂等重放不得当 500）。错误响应只含稳定 code，不泄漏内部信息。
 *   · 绝不调用 carrier API / portal / browser automation；不产生 carrier confirmation。
 */

import { PERMISSIONS, type AppRole } from '../workflow/permissions';
import {
  CARRIER_MANUAL_SUBMISSION_CAPABILITY,
  recordCarrierManualSubmission,
  type CarrierManualSubmissionAuditSink,
  type CarrierManualSubmissionOutcome,
  type CarrierManualSubmissionRequest,
} from './carrier-manual-submission';
import type { CarrierClaimPackageSource } from './carrier-manual-submission';
import type { CarrierManualSubmissionStore } from './carrier-manual-submission';

/** 已认证会话派生的上下文（绝不来自 request body）。 */
export interface CarrierManualSubmissionHttpSession {
  organizationId: string;
  actorUserId: string;
  role: string;
}

export interface CarrierManualSubmissionHttpResult {
  status: number;
  body: Record<string, unknown>;
}

export interface CarrierManualSubmissionHttpDeps {
  packages: CarrierClaimPackageSource;
  store: CarrierManualSubmissionStore;
  audit: CarrierManualSubmissionAuditSink;
  now: () => Date;
}

const FAILURE_STATUS: Record<string, number> = {
  INVALID_REQUEST: 400,
  CAPABILITY_REQUIRED: 403,
  PACKAGE_NOT_FOUND: 404,
  TENANT_MISMATCH: 404,
  PACKAGE_NOT_READY: 409,
};

function roleCanRecord(role: string): boolean {
  const matrix = PERMISSIONS[role as AppRole];
  return matrix !== undefined && matrix.recordCarrierManualSubmission === true;
}

export async function handleCarrierManualSubmissionRequest(
  input: {
    packageId: string;
    request: CarrierManualSubmissionRequest;
    session: CarrierManualSubmissionHttpSession;
  },
  deps: CarrierManualSubmissionHttpDeps,
): Promise<CarrierManualSubmissionHttpResult> {
  const allowed = roleCanRecord(input.session.role);
  const outcome: CarrierManualSubmissionOutcome = await recordCarrierManualSubmission(
    {
      packageId: input.packageId,
      request: input.request,
      context: {
        organizationId: input.session.organizationId,
        actorUserId: input.session.actorUserId,
        actorCapabilities: allowed ? [CARRIER_MANUAL_SUBMISSION_CAPABILITY] : [],
      },
    },
    deps,
  );

  if (!outcome.ok) {
    return { status: FAILURE_STATUS[outcome.reason] ?? 400, body: { code: outcome.reason } };
  }
  return {
    status: outcome.status === 'RECORDED' ? 201 : 200,
    body: { status: outcome.status, submissionRecord: outcome.record },
  };
}
