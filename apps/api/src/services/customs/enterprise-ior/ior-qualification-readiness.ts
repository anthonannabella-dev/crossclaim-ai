/**
 * ENTERPRISE IOR RECOVERY LAYER — ⑥ ENTERPRISE IOR QUALIFICATION（复用既有 Qualification Gate，不建第二套引擎）。
 * ---------------------------------------------------------------
 * 把 ①②③④⑦ 的只读契约聚合成一个「IOR readiness」输入平面，喂给既有
 * `evaluateCustomerQualification`（P0-2 Recovery Economics Gate）。
 *
 * 硬规则：
 *   · 任何 IOR / claimant / right / deadline / POA / refund destination 不明确 → 不得自动追回。
 *   · 本模块不调用任何外部系统；昂贵 Customs / Broker / Filing API 仍必须在 Gate 判 QUALIFIED 之后。
 *   · deadline 已过 → 终局（terminal）；其余缺口 → 待证据/人工补齐（非终局）。
 */

import { evaluateBrokerAuthorization, type BrokerAuthorizationInput } from './broker-poa';
import { evaluateIorIdentity, type IorIdentity } from './ior-identity';
import { evaluateRefundDestinationReadiness, type RefundDestinationInput } from './refund-destination';
import {
  evaluateRemedyDeadline,
  type CustomsRemedyDeadlinePolicy,
  type RemedyDeadlineInput,
  type RemedyDeadlineResult,
} from './remedy-deadline';
import { evaluateRightLineage, type RightLineageInput, type RightLineageResult } from './right-lineage';

export const IOR_QUALIFICATION_REASONS = [
  'OK',
  'IOR_IDENTITY_UNUSABLE',
  'RIGHT_LINEAGE_INCOMPLETE',
  'RIGHT_LINEAGE_NEEDS_MANUAL',
  'BROKER_AUTHORIZATION_MISSING',
  'BROKER_AUTHORIZATION_NOT_READY',
  'REMEDY_DEADLINE_INDETERMINATE',
  'REMEDY_DEADLINE_EXPIRED',
  'REFUND_DESTINATION_NOT_READY',
] as const;
export type IorQualificationReason = (typeof IOR_QUALIFICATION_REASONS)[number];

export interface EnterpriseIorReadinessInput {
  identity: IorIdentity;
  rightLineage: RightLineageInput;
  brokerAuthorization: BrokerAuthorizationInput | null;
  remedyDeadline: RemedyDeadlineInput;
  deadlinePolicies: readonly CustomsRemedyDeadlinePolicy[];
  refundDestination: RefundDestinationInput | null;
  now: string;
}

export interface EnterpriseIorReadiness {
  ready: boolean;
  /** 终局缺口（例如 remedy deadline 已过）→ 应判 NOT_QUALIFIED，而非 INDETERMINATE。 */
  terminal: boolean;
  reasonCodes: readonly IorQualificationReason[];
  identityUsable: boolean;
  rightLineage: RightLineageResult['outcome'];
  brokerAuthorizationUsable: boolean | null;
  remedyDeadlineStatus: RemedyDeadlineResult['status'];
  refundDestinationReady: boolean | null;
  readonly autoFilingAllowed: false;
  readonly callsExpensiveProvider: false;
  readonly readOnly: true;
}

/** Gate 侧消费的最小摘要（不改变既有 gate 语义，仅新增输入平面）。 */
export interface EnterpriseIorQualificationSummary {
  ready: boolean;
  terminal: boolean;
  reasonCodes: readonly string[];
}

/**
 * 聚合 IOR readiness（确定性、只读、fail-closed）。
 */
export function evaluateEnterpriseIorReadiness(input: EnterpriseIorReadinessInput): EnterpriseIorReadiness {
  const reasons: IorQualificationReason[] = [];

  const identity = evaluateIorIdentity(input.identity, input.now);
  if (!identity.usable) reasons.push('IOR_IDENTITY_UNUSABLE');

  const lineage = evaluateRightLineage(input.rightLineage);
  if (lineage.outcome === 'NEEDS_MANUAL') reasons.push('RIGHT_LINEAGE_INCOMPLETE');
  if (lineage.outcome === 'BROKER_REVIEW') reasons.push('RIGHT_LINEAGE_NEEDS_MANUAL');

  let brokerAuthorizationUsable: boolean | null = null;
  if (input.brokerAuthorization === null) {
    reasons.push('BROKER_AUTHORIZATION_MISSING');
  } else {
    const broker = evaluateBrokerAuthorization(input.brokerAuthorization, input.now);
    brokerAuthorizationUsable = broker.usable;
    if (!broker.usable) reasons.push('BROKER_AUTHORIZATION_NOT_READY');
  }

  const deadline = evaluateRemedyDeadline(input.remedyDeadline, input.deadlinePolicies, input.now);
  if (deadline.status === 'INDETERMINATE') reasons.push('REMEDY_DEADLINE_INDETERMINATE');
  if (deadline.status === 'EXPIRED') reasons.push('REMEDY_DEADLINE_EXPIRED');

  let refundDestinationReady: boolean | null = null;
  if (input.refundDestination === null) {
    reasons.push('REFUND_DESTINATION_NOT_READY');
  } else {
    const refund = evaluateRefundDestinationReadiness(input.refundDestination);
    refundDestinationReady = refund.ready;
    if (!refund.ready) reasons.push('REFUND_DESTINATION_NOT_READY');
  }

  return {
    ready: reasons.length === 0,
    terminal: deadline.status === 'EXPIRED',
    reasonCodes: reasons.length > 0 ? reasons : ['OK'],
    identityUsable: identity.usable,
    rightLineage: lineage.outcome,
    brokerAuthorizationUsable,
    remedyDeadlineStatus: deadline.status,
    refundDestinationReady,
    autoFilingAllowed: false,
    callsExpensiveProvider: false,
    readOnly: true,
  };
}

export function toQualificationIorSummary(readiness: EnterpriseIorReadiness): EnterpriseIorQualificationSummary {
  return { ready: readiness.ready, terminal: readiness.terminal, reasonCodes: readiness.reasonCodes };
}

export const IOR_QUALIFICATION_BOUNDARY = {
  reusesExistingQualificationGate: true,
  secondQualificationEngine: false,
  gatesExpensiveAdapters: true,
  missingInputIsFailClosed: true,
  autoFilingAllowed: false,
  callsExpensiveProvider: false,
  productionCredentials: 'ABSENT',
} as const;
