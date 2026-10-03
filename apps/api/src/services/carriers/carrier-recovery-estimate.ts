/**
 * CARRIER QUEUE #8（MSG-20261003-115 ⑯–㉝）— RECOVERY AMOUNT ESTIMATION + CLAIM-READY PACKAGE INPUT。
 * CARRIER QUEUE #8 FINAL（MSG-20261003-116 ⑱⑲⑳㉑㉒㉓）— CLAIM-READY PACKAGE COMPLETENESS SEMANTICS：
 *   · package COMPLETE 要求 estimate basis 也完整：status=ESTIMATED && estimateBasis=COMPLETE_RULE_BASIS && blockers 为空；
 *     因此 ANY PARTIAL_PROVIDER_RULE_BASIS / unresolved blocker → package = PARTIAL。
 *   · estimate 本身**仍可**是 ESTIMATED + PARTIAL_PROVIDER_RULE_BASIS（保守下界估算），只是 claim-ready package 不完整。
 *   · invariant：package COMPLETE → blockers.length === 0。
 * --------------------------------------------------------------- * ---------------------------------------------------------------
 * 目标：在**已确定性判定**的基础上给出可追回金额的**估算值**，并准备 claim-ready 输入 —— 仅此而已。
 * 硬边界：
 *   · 只有 eligibility.decision = ELIGIBLE 才允许产生金额；INDETERMINATE → BLOCKED_INDETERMINATE + null + blockers；
 *     NOT_ELIGIBLE → NOT_ELIGIBLE + null（**不得用 0.00 冒充「已计算为零」**）。
 *   · 金额必须来自 explicit eligible charge basis，**不得**简单取 invoice.totalCharge。
 *   · 不跨币种合并、不做 FX；不计算 successFee / commission / collectionAmount；不输出 actualRecovered（estimate ≠ 已收回现金）。
 *   · claim-ready package 只是输入，不是提交 payload：claimSubmissionPerformed=false / transport=false / platformWrite=false。
 *   · 纯函数（无端口、无网络）；deterministic；estimate rules 显式 versioned。
 * HOLD_EXTERNAL：真实 recovery formula（UPS/FedEx 合同退款规则、service guarantee exclusions、eligible charge 定义、真实 invoice 样本、
 *              真实已裁决索赔）尚未提供，因此本版规则是**保守的、明确标注的**估算规则，不得伪装成 provider production recovery formula。
 */

import type { CarrierProvider } from './connector-capability';
import type { ShipmentEvidenceBundle } from './carrier-evidence-bundle';
import type { CarrierSlaDecision, CarrierSlaEligibilityEvaluation } from './carrier-sla-eligibility';
import { addDecimalStrings, type CarrierInvoiceFact } from './carrier-invoice-pod-read';

/** ㉔ estimate rule versioning：金额逻辑必须可追踪。 */
export const CARRIER_ESTIMATE_RULE_SET_ID = 'carrier-recovery-estimate';
export const CARRIER_ESTIMATE_RULE_SET_VERSION = '1.0.0';

type ChargeKind = CarrierInvoiceFact['charges'][number]['kind'];
type ChargeRecord = CarrierInvoiceFact['charges'][number];

/** ㉑ status 枚举（未知 / 不可适用一律用 status + null，不用 0.00）。 */
export const CARRIER_RECOVERY_ESTIMATE_STATUSES = ['ESTIMATED', 'NOT_ELIGIBLE', 'BLOCKED_INDETERMINATE', 'MISSING_AMOUNT_BASIS'] as const;
export type CarrierRecoveryEstimateStatus = (typeof CARRIER_RECOVERY_ESTIMATE_STATUSES)[number];

/** ㉓ charge eligibility：显式区分 included / unknown / excluded，绝不猜。 */
export const CARRIER_CHARGE_ELIGIBILITIES = ['INCLUDED', 'UNKNOWN', 'EXCLUDED_FROM_CARRIER_SLA_ESTIMATE'] as const;
export type CarrierChargeEligibility = (typeof CARRIER_CHARGE_ELIGIBILITIES)[number];

export interface CarrierChargeEligibilityDecision {
  kind: ChargeKind;
  rawChargeCode: string | null;
  eligibility: CarrierChargeEligibility;
  included: boolean;
  reasonCode: string;
  amount: string;
  currency: string;
}

/** ㉙ deterministic estimate basis（不使用 LLM confidence score）。 */
export type CarrierEstimateBasis = 'COMPLETE_RULE_BASIS' | 'PARTIAL_PROVIDER_RULE_BASIS';

/** ㉒ 每个币种一个 estimate（禁止跨币种合并 / FX guessing）。 */
export interface CarrierRecoveryEstimate {
  bundleId: string;
  currency: string;
  status: CarrierRecoveryEstimateStatus;
  estimatedRecoverableAmount: string | null;
  estimateBasis: CarrierEstimateBasis | null;
  includedCharges: readonly CarrierChargeEligibilityDecision[];
  excludedCharges: readonly CarrierChargeEligibilityDecision[];
  calculationBasis: readonly string[];
  blockers: readonly string[];
  evidenceReferences: readonly string[];
}

/** ㉕ claim-ready package input（**不是**最终提交 payload）。 */
export interface CarrierClaimReadyPackageInput {
  provider: CarrierProvider;
  externalAccountId: string;
  trackingNumber: string;
  eligibilityEvaluationReference: {
    bundleId: string;
    ruleSetId: string;
    ruleSetVersion: string;
    decision: CarrierSlaDecision;
  };
  amountEstimateReferences: readonly {
    currency: string;
    status: CarrierRecoveryEstimateStatus;
    estimatedRecoverableAmount: string | null;
  }[];
  eligibleChargeReferences: readonly {
    currency: string;
    kind: ChargeKind;
    rawChargeCode: string | null;
    amount: string;
  }[];
  evidenceReferences: readonly string[];
  termsReference: string | null;
  trackingEvidenceReference: string;
  invoiceEvidenceReferences: readonly string[];
  podReference: string | null;
  blockers: readonly string[];
  packageCompleteness: 'COMPLETE' | 'PARTIAL';
  packageOnly: true;
  claimSubmissionPerformed: false;
  transportEnabled: false;
  platformWriteEnabled: false;
}

export interface CarrierRecoveryEstimation {
  bundleId: string;
  organizationId: string;
  provider: CarrierProvider;
  externalAccountId: string;
  trackingNumber: string;
  eligibilityRuleSetId: string;
  eligibilityRuleSetVersion: string;
  eligibilityDecision: CarrierSlaDecision;
  estimateRuleSetId: string;
  estimateRuleSetVersion: string;
  estimatesByCurrency: readonly CarrierRecoveryEstimate[];
  claimReadyPackageInput: CarrierClaimReadyPackageInput;
  estimateOnly: true;
  claimSubmissionPerformed: false;
  readOnly: true;
  transportEnabled: false;
  platformWriteEnabled: false;
  productionCredentials: 'ABSENT';
}

/**
 * 保守 v1 charge eligibility 规则（**不是** provider 合同公式；HOLD_EXTERNAL 覆盖真实规则）：
 *   · BASE → INCLUDED（基础运费是 SLA 退款最常见的可追回基础，v1 保守纳入）。
 *   · DUTY_TAX → EXCLUDED_FROM_CARRIER_SLA_ESTIMATE（关税/税金不属于 carrier SLA 退款）。
 *   · 其余（FUEL / RESIDENTIAL / REMOTE_AREA / ADDRESS_CORRECTION / DIMENSIONAL / OVERSIZE / OTHER）：
 *     provider-rule dependent → UNKNOWN，**保守排除**，绝不猜。
 */
function classifyCharge(charge: ChargeRecord): {
  eligibility: CarrierChargeEligibility;
  included: boolean;
  reasonCode: string;
} {
  if (charge.kind === 'BASE') return { eligibility: 'INCLUDED', included: true, reasonCode: 'BASE_CHARGE_INCLUDED_V1' };
  if (charge.kind === 'DUTY_TAX') return { eligibility: 'EXCLUDED_FROM_CARRIER_SLA_ESTIMATE', included: false, reasonCode: 'DUTY_TAX_EXCLUDED_FROM_SLA_ESTIMATE' };
  return { eligibility: 'UNKNOWN', included: false, reasonCode: 'PROVIDER_RULE_DEPENDENT_UNKNOWN' };
}

/**
 * 估算 + claim-ready 输入准备（纯函数，deterministic）。
 *   · eligibility.bundleId 必须与 bundle.bundleId 一致，否则 fail-closed（produces no estimate）。
 *   · 只有 ELIGIBLE 才可能产生金额；INDETERMINATE → BLOCKED_INDETERMINATE；NOT_ELIGIBLE → NOT_ELIGIBLE。
 */
export function estimateCarrierRecovery(
  input: { bundle: ShipmentEvidenceBundle; eligibility: CarrierSlaEligibilityEvaluation },
): CarrierRecoveryEstimation {
  const { bundle, eligibility } = input;
  const decision = eligibility.decision;
  const bundleMismatch = eligibility.bundleId !== bundle.bundleId;

  const bundleBlockers: string[] = [];
  if (bundleMismatch) bundleBlockers.push('ELIGIBILITY_BUNDLE_MISMATCH');
  if (bundle.invoices.length === 0) bundleBlockers.push('INVOICE_EVIDENCE_MISSING');

  const currencyBuckets = [...new Set(bundle.invoices.map((invoice) => invoice.currency))].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

  const estimatesByCurrency: CarrierRecoveryEstimate[] = [];
  if (!bundleMismatch) {
    for (const currency of currencyBuckets) {
      const invoices = bundle.invoices.filter((invoice) => invoice.currency === currency);
      const chargeRecords = invoices.flatMap((invoice) => invoice.charges);
      const decisions: CarrierChargeEligibilityDecision[] = chargeRecords.map((charge) => {
        const classified = classifyCharge(charge);
        return {
          kind: charge.kind,
          rawChargeCode: charge.rawChargeCode ?? null,
          eligibility: classified.eligibility,
          included: classified.included,
          reasonCode: classified.reasonCode,
          amount: charge.amount,
          currency,
        };
      });
      const included = decisions.filter((decision) => decision.included);
      const excluded = decisions.filter((decision) => !decision.included);
      const hasUnknown = decisions.some((decision) => decision.eligibility === 'UNKNOWN');
      const evidenceReferences = [
        ...new Set(invoices.flatMap((invoice) => [invoice.rawReference, ...(invoice.invoiceReference ? [invoice.invoiceReference] : [])])),
      ];

      let status: CarrierRecoveryEstimateStatus;
      let amount: string | null = null;
      let estimateBasis: CarrierEstimateBasis | null = null;
      const blockers: string[] = [];
      const calculationBasis: string[] = [];

      if (decision === 'NOT_ELIGIBLE') {
        status = 'NOT_ELIGIBLE';
        blockers.push('ELIGIBILITY_NOT_ELIGIBLE');
      } else if (decision === 'INDETERMINATE') {
        status = 'BLOCKED_INDETERMINATE';
        blockers.push('ELIGIBILITY_INDETERMINATE');
        blockers.push(...eligibility.blockers);
      } else if (included.length === 0) {
        // 没有 explicit eligible charge basis：绝不用 0.00 冒充「已计算为零」。
        status = 'MISSING_AMOUNT_BASIS';
        blockers.push(decisions.length === 0 ? 'NO_CHARGE_RECORDS' : 'NO_INCLUDED_CHARGE_BASIS');
      } else {
        status = 'ESTIMATED';
        amount = addDecimalStrings(included.map((entry) => entry.amount));
        estimateBasis = hasUnknown ? 'PARTIAL_PROVIDER_RULE_BASIS' : 'COMPLETE_RULE_BASIS';
        calculationBasis.push('SUM_OF_INCLUDED_CHARGES');
        for (const entry of included) calculationBasis.push(entry.kind + ':' + entry.amount + ':' + entry.reasonCode);
        if (hasUnknown) blockers.push('UNKNOWN_CHARGE_ELIGIBILITY_EXCLUDED');
      }

      estimatesByCurrency.push({
        bundleId: bundle.bundleId,
        currency,
        status,
        estimatedRecoverableAmount: amount,
        estimateBasis,
        includedCharges: included,
        excludedCharges: excluded,
        calculationBasis,
        blockers,
        evidenceReferences,
      });
    }
  }

  const eligibleChargeReferences = estimatesByCurrency.flatMap((estimate) =>
    estimate.includedCharges.map((charge) => ({
      currency: estimate.currency,
      kind: charge.kind,
      rawChargeCode: charge.rawChargeCode,
      amount: charge.amount,
    })),
  );
  const packageBlockers = [
    ...bundleBlockers,
    ...estimatesByCurrency.flatMap((estimate) => estimate.blockers.map((blocker) => estimate.currency + ':' + blocker)),
  ];
  // MSG-116 ⑱⑲⑳ CHANGE A：COMPLETE 要求 estimate basis 完整（COMPLETE_RULE_BASIS 且无 unresolved blocker）。
  const allEstimateBasisComplete =
    estimatesByCurrency.length > 0 &&
    estimatesByCurrency.every(
      (estimate) =>
        estimate.status === 'ESTIMATED' &&
        estimate.estimateBasis === 'COMPLETE_RULE_BASIS' &&
        estimate.blockers.length === 0,
    );
  const packageCompleteness: 'COMPLETE' | 'PARTIAL' =
    !bundleMismatch && bundle.completeness === 'COMPLETE' && decision === 'ELIGIBLE' && allEstimateBasisComplete
      ? 'COMPLETE'
      : 'PARTIAL';

  const claimReadyPackageInput: CarrierClaimReadyPackageInput = {
    provider: bundle.provider,
    externalAccountId: bundle.externalAccountId,
    trackingNumber: bundle.trackingNumber,
    eligibilityEvaluationReference: {
      bundleId: bundle.bundleId,
      ruleSetId: eligibility.ruleSetId,
      ruleSetVersion: eligibility.ruleSetVersion,
      decision,
    },
    amountEstimateReferences: estimatesByCurrency.map((estimate) => ({
      currency: estimate.currency,
      status: estimate.status,
      estimatedRecoverableAmount: estimate.estimatedRecoverableAmount,
    })),
    eligibleChargeReferences,
    evidenceReferences: eligibility.evidenceReferences,
    termsReference: bundle.terms ? bundle.terms.termsReference : null,
    trackingEvidenceReference: bundle.tracking.rawReference,
    invoiceEvidenceReferences: bundle.invoices.map((invoice) => invoice.rawReference),
    podReference: bundle.pod ? bundle.pod.rawReference : null,
    blockers: packageBlockers,
    packageCompleteness,
    packageOnly: true,
    claimSubmissionPerformed: false,
    transportEnabled: false,
    platformWriteEnabled: false,
  };

  return {
    bundleId: bundle.bundleId,
    organizationId: bundle.organizationId,
    provider: bundle.provider,
    externalAccountId: bundle.externalAccountId,
    trackingNumber: bundle.trackingNumber,
    eligibilityRuleSetId: eligibility.ruleSetId,
    eligibilityRuleSetVersion: eligibility.ruleSetVersion,
    eligibilityDecision: decision,
    estimateRuleSetId: CARRIER_ESTIMATE_RULE_SET_ID,
    estimateRuleSetVersion: CARRIER_ESTIMATE_RULE_SET_VERSION,
    estimatesByCurrency,
    claimReadyPackageInput,
    estimateOnly: true,
    claimSubmissionPerformed: false,
    readOnly: true,
    transportEnabled: false,
    platformWriteEnabled: false,
    productionCredentials: 'ABSENT',
  };
}
