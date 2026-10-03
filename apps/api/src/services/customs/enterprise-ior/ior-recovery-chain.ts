/**
 * ENTERPRISE IOR RECOVERY LAYER — ⑪ 全链装配（read-only / fail-closed / 零外写）。
 * ---------------------------------------------------------------
 *  7501/Entry → verified IOR → verified claimant/right → remedy + deadline → qualification
 *  → evidence → estimate → claim-ready → broker authorization readiness
 *  → filing-provider readiness → refund destination readiness
 *
 * 硬规则：
 *   · 任一环节不明确 → 该 stage 不 READY，且 claimPackageReady=false；不自动提交。
 *   · filing provider readiness 属 HOLD_EXTERNAL：宿主未单独启用前恒 NOT_READY。
 *   · 本模块不调用任何外部系统；autoSubmitAllowed 恒 false。
 */

import {
  evaluateCustomerQualification,
  type CustomerQualificationDecision,
  type CustomerReadiness,
  type RecoveryEconomicsPolicy,
} from '../../commercial/customer-qualification-gate';
import { evaluateBrokerAuthorization, type BrokerAuthorizationInput } from './broker-poa';
import {
  normalizeEvidenceReference,
  type CustomsEvidenceReference,
  type CustomsEvidenceReferenceInput,
} from './evidence-taxonomy';
import { evaluateIorIdentity, type IorIdentity } from './ior-identity';
import {
  evaluateEnterpriseIorReadiness,
  toQualificationIorSummary,
  type EnterpriseIorReadinessInput,
} from './ior-qualification-readiness';
import { evaluateRefundDestinationReadiness, type RefundDestinationInput } from './refund-destination';
import { evaluateRemedyDeadline } from './remedy-deadline';
import { evaluateRightLineage } from './right-lineage';

export const IOR_CHAIN_STAGES = [
  'ENTRY_REFERENCE',
  'IOR_IDENTITY',
  'RIGHT_LINEAGE',
  'REMEDY_DEADLINE',
  'QUALIFICATION',
  'EVIDENCE',
  'RECOVERY_ESTIMATE',
  'BROKER_AUTHORIZATION_READINESS',
  'REFUND_DESTINATION_READINESS',
  'FILING_PROVIDER_READINESS',
  'CLAIM_READY',
] as const;
export type IorChainStage = (typeof IOR_CHAIN_STAGES)[number];

export const IOR_CHAIN_STAGE_STATUSES = ['READY', 'NOT_READY', 'INDETERMINATE', 'EXPIRED', 'BLOCKED'] as const;
export type IorChainStageStatus = (typeof IOR_CHAIN_STAGE_STATUSES)[number];

export interface IorChainStageResult {
  stage: IorChainStage;
  status: IorChainStageStatus;
  reasonCodes: readonly string[];
}

export interface FilingProviderCapability {
  providerId: string;
  /** ABI / filing capability 是否已由宿主启用（HOLD_EXTERNAL 下恒 false）。 */
  filingCapabilityEnabled: boolean;
  credentialPresent: boolean;
}

export interface IorRecoveryChainInput {
  organizationId: string;
  entryReference: string;
  identity: IorIdentity;
  rightLineage: EnterpriseIorReadinessInput['rightLineage'];
  remedyDeadline: EnterpriseIorReadinessInput['remedyDeadline'];
  deadlinePolicies: EnterpriseIorReadinessInput['deadlinePolicies'];
  brokerAuthorization: BrokerAuthorizationInput | null;
  refundDestination: RefundDestinationInput | null;
  evidence: readonly CustomsEvidenceReferenceInput[];
  customerReadiness: CustomerReadiness;
  estimatedRecoveryAmount: string;
  estimatedExternalApiCost: string;
  estimatedBrokerCost: string;
  policy: RecoveryEconomicsPolicy;
  filingProvider: FilingProviderCapability;
  now: string;
}

export interface IorRecoveryChainResult {
  organizationId: string;
  entryReference: string;
  stages: readonly IorChainStageResult[];
  claimPackageReady: boolean;
  filingReady: boolean;
  qualification: CustomerQualificationDecision;
  evidence: readonly CustomsEvidenceReference[];
  readonly autoSubmitAllowed: false;
  readonly filingSubmitted: false;
  readonly externalWritePerformed: false;
  readonly transportEnabled: false;
  readonly productionCredentials: 'ABSENT';
  computedAt: string;
}

function stage(stageName: IorChainStage, status: IorChainStageStatus, reasonCodes: readonly string[]): IorChainStageResult {
  return { stage: stageName, status, reasonCodes: reasonCodes.length > 0 ? reasonCodes : ['OK'] };
}

/**
 * 全链装配（确定性、只读、fail-closed）。任何未装配的环节都会显式落 stage。
 */
export function evaluateIorRecoveryChain(input: IorRecoveryChainInput): IorRecoveryChainResult {
  const stages: IorChainStageResult[] = [];

  stages.push(
    stage('ENTRY_REFERENCE', input.entryReference ? 'READY' : 'NOT_READY', input.entryReference ? [] : ['ENTRY_REFERENCE_MISSING']),
  );

  const identity = evaluateIorIdentity(input.identity, input.now);
  stages.push(stage('IOR_IDENTITY', identity.usable ? 'READY' : 'BLOCKED', identity.reasonCodes));

  const lineage = evaluateRightLineage(input.rightLineage);
  stages.push(
    stage(
      'RIGHT_LINEAGE',
      lineage.outcome === 'COMPLETE' ? 'READY' : lineage.outcome === 'BROKER_REVIEW' ? 'INDETERMINATE' : 'NOT_READY',
      lineage.reasonCodes,
    ),
  );

  const deadline = evaluateRemedyDeadline(input.remedyDeadline, input.deadlinePolicies, input.now);
  stages.push(
    stage(
      'REMEDY_DEADLINE',
      deadline.status === 'ELIGIBLE_WINDOW' ? 'READY' : deadline.status === 'EXPIRED' ? 'EXPIRED' : 'INDETERMINATE',
      deadline.reasonCodes,
    ),
  );

  const iorReadiness = evaluateEnterpriseIorReadiness({
    identity: input.identity,
    rightLineage: input.rightLineage,
    brokerAuthorization: input.brokerAuthorization,
    remedyDeadline: input.remedyDeadline,
    deadlinePolicies: input.deadlinePolicies,
    refundDestination: input.refundDestination,
    now: input.now,
  });

  const qualification = evaluateCustomerQualification({
    readiness: input.customerReadiness,
    estimatedRecoveryAmount: input.estimatedRecoveryAmount,
    estimatedExternalApiCost: input.estimatedExternalApiCost,
    estimatedBrokerCost: input.estimatedBrokerCost,
    policy: input.policy,
    computedAt: input.now,
    iorReadiness: toQualificationIorSummary(iorReadiness),
  });
  stages.push(
    stage(
      'QUALIFICATION',
      qualification.qualificationStatus === 'QUALIFIED'
        ? 'READY'
        : qualification.qualificationStatus === 'NOT_QUALIFIED'
          ? 'NOT_READY'
          : 'INDETERMINATE',
      qualification.reasonCodes,
    ),
  );

  let evidence: readonly CustomsEvidenceReference[] = [];
  let evidenceStatus: IorChainStageStatus = 'READY';
  let evidenceReasons: string[] = [];
  try {
    evidence = input.evidence.map((item) => normalizeEvidenceReference(item));
  } catch (error) {
    evidenceStatus = 'BLOCKED';
    const code = (error as { code?: unknown } | null)?.code;
    evidenceReasons = [typeof code === 'string' ? code : 'EVIDENCE_INVALID'];
  }
  if (evidenceStatus === 'READY' && evidence.length === 0) {
    evidenceStatus = 'NOT_READY';
    evidenceReasons = ['NO_EVIDENCE_REFERENCE'];
  }
  stages.push(stage('EVIDENCE', evidenceStatus, evidenceReasons));

  const positiveEstimate =
    qualification.estimatedRecoveryAmount !== '0.000000' && !qualification.estimatedRecoveryAmount.startsWith('-');
  stages.push(
    stage('RECOVERY_ESTIMATE', positiveEstimate ? 'READY' : 'NOT_READY', positiveEstimate ? [] : ['NO_RECOVERY_ESTIMATE']),
  );

  const broker = input.brokerAuthorization === null ? null : evaluateBrokerAuthorization(input.brokerAuthorization, input.now);
  stages.push(
    stage(
      'BROKER_AUTHORIZATION_READINESS',
      broker?.usable === true ? 'READY' : 'NOT_READY',
      broker === null ? ['BROKER_AUTHORIZATION_MISSING'] : broker.reasonCodes,
    ),
  );

  const refund = input.refundDestination === null ? null : evaluateRefundDestinationReadiness(input.refundDestination);
  stages.push(
    stage(
      'REFUND_DESTINATION_READINESS',
      refund?.ready === true ? 'READY' : 'NOT_READY',
      refund === null ? ['REFUND_DESTINATION_NOT_READY'] : refund.reasonCodes,
    ),
  );

  const providerReasons: string[] = [];
  if (!input.filingProvider.filingCapabilityEnabled) providerReasons.push('FILING_CAPABILITY_DISABLED');
  if (!input.filingProvider.credentialPresent) providerReasons.push('PRODUCTION_CREDENTIALS_ABSENT');
  stages.push(stage('FILING_PROVIDER_READINESS', providerReasons.length === 0 ? 'READY' : 'NOT_READY', providerReasons));

  const claimPackageReady = stages
    .filter((item) => item.stage !== 'FILING_PROVIDER_READINESS' && item.stage !== 'CLAIM_READY')
    .every((item) => item.status === 'READY');
  stages.push(stage('CLAIM_READY', claimPackageReady ? 'READY' : 'NOT_READY', claimPackageReady ? [] : ['UPSTREAM_NOT_READY']));

  const filingProviderReady = stages.find((item) => item.stage === 'FILING_PROVIDER_READINESS')?.status === 'READY';

  return {
    organizationId: input.organizationId,
    entryReference: input.entryReference,
    stages,
    claimPackageReady,
    filingReady: claimPackageReady && filingProviderReady,
    qualification,
    evidence,
    autoSubmitAllowed: false,
    filingSubmitted: false,
    externalWritePerformed: false,
    transportEnabled: false,
    productionCredentials: 'ABSENT',
    computedAt: input.now,
  };
}

export const IOR_CHAIN_BOUNDARY = {
  readOnly: true,
  failClosed: true,
  autoSubmitAllowed: false,
  filingSubmitted: false,
  externalWritePerformed: false,
  transportEnabled: false,
  filingProviderUnderHoldExternal: true,
  productionCredentials: 'ABSENT',
} as const;
