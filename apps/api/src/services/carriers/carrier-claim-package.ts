/**
 * CARRIER QUEUE #9A（MSG-20261003-117 ⑱–㉜）— CLAIM PACKAGE GENERATION。
 * ---------------------------------------------------------------
 * 目标：把 `CarrierClaimReadyPackageInput`（Queue #8）转成 **human-reviewable / downloadable** 的
 *       `CarrierClaimPackage` —— **仍然不是**自动 carrier submission。
 * 硬边界：
 *   · 只有 packageCompleteness = COMPLETE 才允许 READY_FOR_MANUAL_SUBMISSION；否则 NEEDS_REVIEW + 保留 blockers。
 *   · 本单元只能产生 NEEDS_REVIEW / READY_FOR_MANUAL_SUBMISSION；MANUALLY_SUBMITTED 只能由后续 human action path 进入（Queue #9B）。
 *   · 金额只能以 **estimated** 标签呈现；不得出现 amountDue / refundApproved / guaranteedRecovery。
 *   · 多币种必须分离（claimAmountsByCurrency[]），不合成单一总额、不做 FX。
 *   · 不得携带 raw credential / token / inline signature image / raw provider payload。
 *   · 纯函数（无端口、无网络）；deterministic（packageId 来自 immutable input refs / versions，不用随机 UUID）。
 * HOLD_EXTERNAL：真实 carrier claim submission（UPS/FedEx claim API·portal rules、production authorization、real account
 *              permissions、provider-specific claim forms、real contractual terms）尚未提供 —— 本单元只生成可人工审核的包。
 */

import type { CarrierProvider } from './connector-capability';
import type { ShipmentEvidenceBundle } from './carrier-evidence-bundle';
import type { CarrierSlaEligibilityEvaluation } from './carrier-sla-eligibility';
import type { CarrierEstimateBasis, CarrierRecoveryEstimation, CarrierRecoveryEstimateStatus } from './carrier-recovery-estimate';

/** ㉙ 本单元只能产生前两个状态；MANUALLY_SUBMITTED 属 Queue #9B。 */
export const CARRIER_CLAIM_PACKAGE_STATUSES = ['READY_FOR_MANUAL_SUBMISSION', 'NEEDS_REVIEW'] as const;
export type CarrierClaimPackageStatus = (typeof CARRIER_CLAIM_PACKAGE_STATUSES)[number];

/** ㉕ 人工流程：不做自动提交。 */
export const CARRIER_SUBMISSION_MODES = ['MANUAL'] as const;
export type CarrierSubmissionMode = (typeof CARRIER_SUBMISSION_MODES)[number];

/** ㉖ 提交渠道（仅 metadata）。 */
export const CARRIER_SUBMISSION_CHANNELS = ['PORTAL', 'EMAIL', 'SUPPORT_CASE', 'API_UNAVAILABLE'] as const;
export type CarrierSubmissionChannel = (typeof CARRIER_SUBMISSION_CHANNELS)[number];

/** ㉔ evidence manifest 类型。 */
export const CARRIER_CLAIM_EVIDENCE_TYPES = ['TRACKING', 'INVOICE', 'POD', 'TERMS', 'ELIGIBILITY_EVALUATION', 'RECOVERY_ESTIMATE'] as const;
export type CarrierClaimEvidenceType = (typeof CARRIER_CLAIM_EVIDENCE_TYPES)[number];

export interface CarrierClaimEvidenceManifestItem {
  type: CarrierClaimEvidenceType;
  reference: string | null;
  required: boolean;
  present: boolean;
  source: string;
}

export interface CarrierSubmissionDestination {
  provider: CarrierProvider;
  channel: CarrierSubmissionChannel;
  /** 仅作 metadata；本单元不执行访问 / 提交。 */
  referenceUrl: string | null;
}

/** ㉑㉒㉓ 每个币种一行金额（标签明确为 estimated）。 */
export interface CarrierClaimAmountLine {
  currency: string;
  estimateStatus: CarrierRecoveryEstimateStatus;
  estimatedRecoverableAmount: string | null;
  estimateBasis: CarrierEstimateBasis | null;
}

export interface CarrierClaimPackage {
  /** ㉘ 逻辑 id：来自 immutable input refs / versions（稳定，不是随机 UUID）。 */
  packageId: string;
  bundleId: string;
  organizationId: string;
  provider: CarrierProvider;
  externalAccountId: string;
  trackingNumber: string;
  eligibilityReference: {
    bundleId: string;
    ruleSetId: string;
    ruleSetVersion: string;
    decision: string;
  };
  /** ㉑ rule provenance：金额规则与资格规则版本都必须随包携带。 */
  estimateRuleSetId: string;
  estimateRuleSetVersion: string;
  claimAmountsByCurrency: readonly CarrierClaimAmountLine[];
  /** ㉒ 金额呈现标签：只能是 estimated。 */
  amountLabel: 'ESTIMATED_RECOVERABLE';
  evidenceManifest: readonly CarrierClaimEvidenceManifestItem[];
  termsReference: string | null;
  trackingEvidenceReference: string;
  invoiceReferences: readonly string[];
  podReference: string | null;
  submissionMode: CarrierSubmissionMode;
  submissionDestination: CarrierSubmissionDestination;
  submissionInstructions: readonly string[];
  packageStatus: CarrierClaimPackageStatus;
  packageCompleteness: 'COMPLETE' | 'PARTIAL';
  blockers: readonly string[];
  generatedAt: string;
  packageOnly: true;
  manualSubmissionRequired: true;
  claimSubmissionPerformed: false;
  readOnly: true;
  transportEnabled: false;
  platformWriteEnabled: false;
  productionCredentials: 'ABSENT';
}

/**
 * ㉗ provider-specific package template（独立 renderer/template，不做 giant if(provider)）。
 * referenceUrl 保持 null：本单元不验证也不访问任何真实提交入口（HOLD_EXTERNAL）。
 */
interface CarrierPackageTemplate {
  channel: CarrierSubmissionChannel;
  providerNote: string;
}

const CARRIER_PACKAGE_TEMPLATES: Record<CarrierProvider, CarrierPackageTemplate> = {
  UPS: { channel: 'PORTAL', providerNote: 'UPS_MANUAL_CLAIM_CHANNEL_NOT_VERIFIED_HOLD_EXTERNAL' },
  FEDEX: { channel: 'SUPPORT_CASE', providerNote: 'FEDEX_MANUAL_CLAIM_CHANNEL_NOT_VERIFIED_HOLD_EXTERNAL' },
};

function templateFor(provider: CarrierProvider): CarrierPackageTemplate {
  return CARRIER_PACKAGE_TEMPLATES[provider];
}

/**
 * 生成人工审核用的 claim package（纯函数，deterministic）。
 *   · packageCompleteness = COMPLETE 且 required evidence 齐备 → READY_FOR_MANUAL_SUBMISSION；
 *   · 否则 NEEDS_REVIEW 并保留全部 blockers。
 */
export function generateCarrierClaimPackage(
  input: {
    bundle: ShipmentEvidenceBundle;
    eligibility: CarrierSlaEligibilityEvaluation;
    estimation: CarrierRecoveryEstimation;
  },
  options: { now?: () => Date } = {},
): CarrierClaimPackage {
  const { bundle, eligibility, estimation } = input;
  const claimReady = estimation.claimReadyPackageInput;
  const mismatched =
    estimation.bundleId !== bundle.bundleId ||
    eligibility.bundleId !== bundle.bundleId ||
    claimReady.eligibilityEvaluationReference.bundleId !== bundle.bundleId;
  // eligibility 与 estimation 必须来自同一套资格规则结果（防止传入过期/不一致的 evaluation）。
  const eligibilityEstimationMismatch =
    estimation.eligibilityDecision !== eligibility.decision ||
    estimation.eligibilityRuleSetId !== eligibility.ruleSetId ||
    estimation.eligibilityRuleSetVersion !== eligibility.ruleSetVersion;

  const evidenceManifest: CarrierClaimEvidenceManifestItem[] = [
    {
      type: 'TRACKING',
      reference: bundle.tracking.rawReference,
      required: true,
      present: bundle.tracking.rawReference.length > 0,
      source: 'QUEUE_4_TRACKING_FACT',
    },
    {
      type: 'INVOICE',
      reference: bundle.invoices.length > 0 ? bundle.invoices.map((invoice) => invoice.rawReference).join(
) : null,
      required: true,
      present: bundle.invoices.length > 0,
      source: 'QUEUE_5_INVOICE_FACT',
    },
    {
      type: 'POD',
      reference: bundle.pod ? bundle.pod.rawReference : null,
      required: true,
      present: bundle.pod !== null,
      source: 'QUEUE_5_POD_FACT',
    },
    {
      type: 'TERMS',
      reference: bundle.terms ? bundle.terms.termsReference : null,
      required: true,
      present: bundle.terms !== null,
      source: 'QUEUE_6_CARRIER_TERMS_EVIDENCE',
    },
    {
      type: 'ELIGIBILITY_EVALUATION',
      reference: eligibility.ruleSetId + '@' + eligibility.ruleSetVersion,
      required: true,
      present: eligibility.ruleResults.length > 0,
      source: 'QUEUE_7_SLA_ELIGIBILITY',
    },
    {
      type: 'RECOVERY_ESTIMATE',
      reference: estimation.estimateRuleSetId + '@' + estimation.estimateRuleSetVersion,
      required: true,
      present: estimation.estimatesByCurrency.length > 0,
      source: 'QUEUE_8_RECOVERY_ESTIMATE',
    },
  ];

  const missingRequiredEvidence = evidenceManifest
    .filter((item) => item.required && !item.present)
    .map((item) => item.type);

  const claimAmountsByCurrency: CarrierClaimAmountLine[] = estimation.estimatesByCurrency.map((estimate) => ({
    currency: estimate.currency,
    estimateStatus: estimate.status,
    estimatedRecoverableAmount: estimate.estimatedRecoverableAmount,
    estimateBasis: estimate.estimateBasis,
  }));

  const blockers = [
    ...(mismatched ? ['ESTIMATION_BUNDLE_MISMATCH'] : []),
    ...(eligibilityEstimationMismatch ? ['ELIGIBILITY_ESTIMATION_MISMATCH'] : []),
    ...claimReady.blockers,
    ...missingRequiredEvidence.map((type) => 'MISSING_REQUIRED_EVIDENCE:' + type),
  ];

  const packageCompleteness: 'COMPLETE' | 'PARTIAL' =
    !mismatched && !eligibilityEstimationMismatch && claimReady.packageCompleteness === 'COMPLETE' && missingRequiredEvidence.length === 0
      ? 'COMPLETE'
      : 'PARTIAL';
  const packageStatus: CarrierClaimPackageStatus =
    packageCompleteness === 'COMPLETE' ? 'READY_FOR_MANUAL_SUBMISSION' : 'NEEDS_REVIEW';

  const template = templateFor(bundle.provider);
  const packageId = [
    'carrier-claim-package',
    bundle.bundleId,
    eligibility.ruleSetId + '@' + eligibility.ruleSetVersion,
    estimation.estimateRuleSetId + '@' + estimation.estimateRuleSetVersion,
    ...claimAmountsByCurrency.map(
      (line) => line.currency + ':' + line.estimateStatus + ':' + (line.estimatedRecoverableAmount ?? 'null') + ':' + (line.estimateBasis ?? 'null'),
    ),
  ].join('|');

  return {
    packageId,
    bundleId: bundle.bundleId,
    organizationId: bundle.organizationId,
    provider: bundle.provider,
    externalAccountId: bundle.externalAccountId,
    trackingNumber: bundle.trackingNumber,
    eligibilityReference: {
      bundleId: eligibility.bundleId,
      ruleSetId: eligibility.ruleSetId,
      ruleSetVersion: eligibility.ruleSetVersion,
      decision: eligibility.decision,
    },
    estimateRuleSetId: estimation.estimateRuleSetId,
    estimateRuleSetVersion: estimation.estimateRuleSetVersion,
    claimAmountsByCurrency,
    amountLabel: 'ESTIMATED_RECOVERABLE',
    evidenceManifest,
    termsReference: claimReady.termsReference,
    trackingEvidenceReference: claimReady.trackingEvidenceReference,
    invoiceReferences: claimReady.invoiceEvidenceReferences,
    podReference: claimReady.podReference,
    submissionMode: 'MANUAL',
    submissionDestination: {
      provider: bundle.provider,
      channel: template.channel,
      referenceUrl: null,
    },
    submissionInstructions: [
      'PACKAGE_NOT_SUBMITTED_AUTOMATICALLY',
      'REVIEW_ELIGIBILITY_AND_ESTIMATE_BASIS_BEFORE_SUBMISSION',
      template.providerNote,
      'RECORD_MANUAL_SUBMISSION_SEPARATELY_QUEUE_9B',
    ],
    packageStatus,
    packageCompleteness,
    blockers,
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    packageOnly: true,
    manualSubmissionRequired: true,
    claimSubmissionPerformed: false,
    readOnly: true,
    transportEnabled: false,
    platformWriteEnabled: false,
    productionCredentials: 'ABSENT',
  };
}
