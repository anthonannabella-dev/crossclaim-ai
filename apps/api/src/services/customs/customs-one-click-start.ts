/**
 * C21 — ONE-CLICK START RECOVERY（HOST DIRECTIVE 2026-10-03 补充四 §3）
 * ---------------------------------------------------------------
 * 客户端只提供 opportunityId 与必要确认字段；其余全部 server-derived：
 *   recoverableAmount / classification / eligibility / ruleVersion / IOR / claimant /
 *   broker / packageDigest / feeRate / filingRoute / deadline 一律不得由 client 提供。
 * 全部前置条件满足 → READY_TO_FILE + immutable submission snapshot；否则 fail-closed。
 * 本模块**不提交**任何 filing（真实申报 = HOLD_EXTERNAL / REGULATED GATE）。
 */

import { evaluateCustomsAuthorizationReadiness, type CustomsAuthorizationFlags } from './customs-authorization-readiness';
import {
  CUSTOMS_AUTO_FILING_REQUIRED_OPERATIONS,
  missingFilingCapabilities,
  type CustomsFilingCapabilities,
} from './customs-filing-provider';

/** server-side opportunity truth（由既有 Case / ClaimItem / Evidence / Eligibility / Package 派生）。 */
export interface CustomsOpportunityTruth {
  opportunityId: string;
  organizationId: string;
  entryFactPresent: boolean;
  evidenceBundleCompleteness: 'COMPLETE' | 'PARTIAL';
  eligibilityDecision: 'ELIGIBLE' | 'NOT_ELIGIBLE' | 'INDETERMINATE';
  recoverableAmounts: ReadonlyArray<{ currency: string; amount: string }>;
  remedyRoute: string | null;
  filingDeadline: string | null;
  recoveryPackageStatus: 'READY' | 'NEEDS_REVIEW';
  ruleVersion: string;
}

export interface CustomsOneClickContext {
  organizationId: string;
  actorUserId: string;
  actorCapabilities: readonly string[];
}

export interface CustomsOneClickDeps {
  opportunities: {
    load(organizationId: string, opportunityId: string): Promise<CustomsOpportunityTruth | null>;
  };
  authorization: CustomsAuthorizationFlags;
  provider: { providerId: string; capabilities: CustomsFilingCapabilities } | null;
  now?: () => Date;
}

export type CustomsOneClickReason =
  | 'INVALID_REQUEST'
  | 'CAPABILITY_REQUIRED'
  | 'OPPORTUNITY_NOT_FOUND'
  | 'ENTRY_FACT_MISSING'
  | 'EVIDENCE_INCOMPLETE'
  | 'NOT_ELIGIBLE'
  | 'AMOUNT_NOT_READY'
  | 'REMEDY_ROUTE_MISSING'
  | 'DEADLINE_PASSED'
  | 'PACKAGE_NOT_READY'
  | 'AUTHORIZATION_NOT_READY'
  | 'FILING_CAPABILITY_MISSING';

export interface CustomsOneClickSubmissionSnapshot {
  opportunityId: string;
  organizationId: string;
  entryFactPresent: true;
  evidenceBundleCompleteness: 'COMPLETE';
  eligibilityDecision: 'ELIGIBLE';
  ruleVersion: string;
  recoverableAmounts: ReadonlyArray<{ currency: string; amount: string }>;
  remedyRoute: string;
  filingDeadline: string | null;
  recoveryPackageStatus: 'READY';
  providerId: string;
}

export type CustomsOneClickOutcome =
  | {
      ready: true;
      disposition: 'READY_TO_FILE';
      snapshot: CustomsOneClickSubmissionSnapshot;
      blockers: readonly string[];
      filingSubmitted: false;
      externalWritePerformed: false;
      authoritySubmissionPerformed: false;
      transportEnabled: false;
      productionCredentials: 'ABSENT';
    }
  | {
      ready: false;
      disposition: 'BROKER_HANDOFF' | 'NEEDS_MANUAL' | 'BLOCKED';
      reasonCode: CustomsOneClickReason;
      blockers: readonly string[];
      filingSubmitted: false;
      externalWritePerformed: false;
    };

/** 客户端禁止提供的字段（全部必须 server-derived）。 */
export const CUSTOMS_ONE_CLICK_FORBIDDEN_CLIENT_FIELDS = [
  'recoverableAmount',
  'recoverableAmounts',
  'classification',
  'eligibility',
  'ruleVersion',
  'ior',
  'claimant',
  'broker',
  'packageDigest',
  'feeRate',
  'filingRoute',
  'deadline',
  'organizationId',
  'actorUserId',
] as const;

function blocked(
  reasonCode: CustomsOneClickReason,
  disposition: 'BROKER_HANDOFF' | 'NEEDS_MANUAL' | 'BLOCKED',
  blockers: readonly string[] = [],
): CustomsOneClickOutcome {
  return { ready: false, disposition, reasonCode, blockers, filingSubmitted: false, externalWritePerformed: false };
}

export async function prepareCustomsOneClickStart(
  input: {
    opportunityId: string;
    request: Record<string, unknown>;
    context: CustomsOneClickContext;
    requiredCapability: string;
  },
  deps: CustomsOneClickDeps,
): Promise<CustomsOneClickOutcome> {
  for (const field of CUSTOMS_ONE_CLICK_FORBIDDEN_CLIENT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(input.request, field)) {
      return blocked('INVALID_REQUEST', 'BLOCKED', ['FIELD_NOT_ALLOWED:' + field]);
    }
  }
  if (!input.context.actorCapabilities.includes(input.requiredCapability)) {
    return blocked('CAPABILITY_REQUIRED', 'BLOCKED');
  }

  const truth = await deps.opportunities.load(input.context.organizationId, input.opportunityId);
  if (truth === null) return blocked('OPPORTUNITY_NOT_FOUND', 'BLOCKED');

  if (!truth.entryFactPresent) return blocked('ENTRY_FACT_MISSING', 'BLOCKED');
  if (truth.evidenceBundleCompleteness !== 'COMPLETE') return blocked('EVIDENCE_INCOMPLETE', 'NEEDS_MANUAL');
  if (truth.eligibilityDecision !== 'ELIGIBLE') return blocked('NOT_ELIGIBLE', 'BLOCKED');
  if (truth.recoverableAmounts.length === 0) return blocked('AMOUNT_NOT_READY', 'NEEDS_MANUAL');
  if (truth.remedyRoute === null) return blocked('REMEDY_ROUTE_MISSING', 'NEEDS_MANUAL');
  if (truth.recoveryPackageStatus !== 'READY') return blocked('PACKAGE_NOT_READY', 'NEEDS_MANUAL');

  const now = deps.now ? deps.now() : new Date();
  if (truth.filingDeadline !== null && Date.parse(truth.filingDeadline) < now.getTime()) {
    return blocked('DEADLINE_PASSED', 'BLOCKED');
  }

  const authorization = evaluateCustomsAuthorizationReadiness(deps.authorization);
  if (!authorization.ready) {
    return blocked('AUTHORIZATION_NOT_READY', 'BROKER_HANDOFF', authorization.blockers);
  }

  if (deps.provider === null) {
    return blocked('FILING_CAPABILITY_MISSING', 'BROKER_HANDOFF', CUSTOMS_AUTO_FILING_REQUIRED_OPERATIONS);
  }
  const missing = missingFilingCapabilities(deps.provider.capabilities, CUSTOMS_AUTO_FILING_REQUIRED_OPERATIONS);
  if (missing.length > 0) {
    return blocked('FILING_CAPABILITY_MISSING', 'BROKER_HANDOFF', missing);
  }

  return {
    ready: true,
    disposition: 'READY_TO_FILE',
    snapshot: {
      opportunityId: truth.opportunityId,
      organizationId: truth.organizationId,
      entryFactPresent: true,
      evidenceBundleCompleteness: 'COMPLETE',
      eligibilityDecision: 'ELIGIBLE',
      ruleVersion: truth.ruleVersion,
      recoverableAmounts: truth.recoverableAmounts,
      remedyRoute: truth.remedyRoute,
      filingDeadline: truth.filingDeadline,
      recoveryPackageStatus: 'READY',
      providerId: deps.provider.providerId,
    },
    blockers: [],
    filingSubmitted: false,
    externalWritePerformed: false,
    authoritySubmissionPerformed: false,
    transportEnabled: false,
    productionCredentials: 'ABSENT',
  };
}
