/**
 * CARRIER QUEUE #7（MSG-20261003-113 ⑱–㉞）— SLA ELIGIBILITY EVALUATION CONTRACT。
 * ---------------------------------------------------------------
 * 目标：把 ShipmentEvidenceBundle 转成**可解释、确定性**的 CarrierSlaEligibilityEvaluation，
 *       只回答「基于当前证据，哪些 SLA 条件成立 / 不成立 / 无法判断」—— 不执行任何追回动作。
 * 硬边界（㉘㉙㉚㉞）：
 *   · 不输出 recoveryAmount / claimValue / refundDue / successFee（本层不算钱）。
 *   · 不 submit claim / create dispute / file refund / carrier API mutation / payout / payment·collection。
 *   · deterministic：同一 bundle → 相同 evaluation；无 LLM judgment / 概率评分 / 随机决策。
 *   · UNKNOWN ≠ FAIL；PARTIAL ≠ NOT_ELIGIBLE；evidence conflict 必须让依赖规则 UNKNOWN，不得静默消解。
 *   · 纯函数（无端口、无网络）；TRANSPORT=false · platformWriteEnabled=false · productionCredentials=ABSENT。
 */

import type { CarrierProvider } from './connector-capability';
import type { ShipmentEvidenceBundle, ShipmentEvidenceConflict } from './carrier-evidence-bundle';

/** ㉛ rule versioning：规则集标识 / 版本（规则变化后可解释历史结果差异）。 */
export const CARRIER_SLA_RULE_SET_ID = 'carrier-sla-eligibility';
export const CARRIER_SLA_RULE_SET_VERSION = '1.0.0';

/** ⑳ evaluation outcome：不能只有 true/false。 */
export const CARRIER_SLA_DECISIONS = ['ELIGIBLE', 'NOT_ELIGIBLE', 'INDETERMINATE'] as const;
export type CarrierSlaDecision = (typeof CARRIER_SLA_DECISIONS)[number];

/** ㉑ rule status：PASS | FAIL | UNKNOWN（UNKNOWN 不得当作 FAIL）。 */
export const CARRIER_SLA_RULE_STATUSES = ['PASS', 'FAIL', 'UNKNOWN'] as const;
export type CarrierSlaRuleStatus = (typeof CARRIER_SLA_RULE_STATUSES)[number];

/** ㉒ initial rule dimensions。 */
export const CARRIER_SLA_RULE_IDS = [
  'EVIDENCE_COMPLETENESS',
  'EVIDENCE_CONFLICTS',
  'TERMS_EVIDENCE_PRESENT',
  'TERMS_EFFECTIVE_RANGE',
  'SERVICE_LEVEL_MATCH',
  'DELIVERY_TIMING',
  'EXCEPTION_OR_DELAY_OBSERVED',
  'BILLED_INVOICE_PRESENT',
] as const;
export type CarrierSlaRuleId = (typeof CARRIER_SLA_RULE_IDS)[number];

/** ㉑ 单条规则的确定性结果（可解释：ruleId / status / reasonCode / 证据引用）。 */
export interface CarrierSlaRuleResult {
  ruleId: CarrierSlaRuleId;
  status: CarrierSlaRuleStatus;
  reasonCode: string;
  evidenceReferences: readonly string[];
}

export type CarrierSlaServiceLevelSource =
  | 'TRACKING_AND_TERMS'
  | 'TRACKING_ONLY'
  | 'TERMS_ONLY'
  | 'NONE';

/** 评估依据（只描述事实，不含任何金额）。 */
export interface CarrierSlaEvaluationBasis {
  completeness: 'COMPLETE' | 'PARTIAL';
  evidenceConflicts: readonly ShipmentEvidenceConflict[];
  promisedDeliveryAt: string | null;
  actualDeliveryAt: string | null;
  serviceLevel: string | null;
  serviceLevelSource: CarrierSlaServiceLevelSource;
  exceptionOrDelayObserved: boolean;
  scanEventCount: number;
  invoiceCount: number;
  termsPresent: boolean;
  /** ㉓ relevant date source 必须显式声明（本版本只用 tracking.shipDate）。 */
  relevantDateSource: 'TRACKING_SHIP_DATE';
  relevantDate: string | null;
}

/** ㉜ outcome：只含判定与解释字段，无金额、无执行标志。 */
export interface CarrierSlaEligibilityEvaluation {
  bundleId: string;
  organizationId: string;
  provider: CarrierProvider;
  externalAccountId: string;
  trackingNumber: string;
  ruleSetId: string;
  ruleSetVersion: string;
  evaluatedAt: string;
  decision: CarrierSlaDecision;
  ruleResults: readonly CarrierSlaRuleResult[];
  blockers: readonly string[];
  evaluationBasis: CarrierSlaEvaluationBasis;
  evidenceReferences: readonly string[];
  evaluationOnly: true;
  claimSubmissionPerformed: false;
  readOnly: true;
  transportEnabled: false;
  platformWriteEnabled: false;
  productionCredentials: 'ABSENT';
}

/**
 * 确定性 SLA 资格评估（纯函数）：
 *   · decision 由 rule results 推导：任一 FAIL → NOT_ELIGIBLE；否则任一 UNKNOWN → INDETERMINATE；否则 ELIGIBLE。
 *   · 缺证据 / 证据冲突只产生 UNKNOWN（绝不硬判 NOT_ELIGIBLE）。
 *   · blockers 列出所有非 PASS 规则的 ruleId:reasonCode（确定性顺序 = 规则声明顺序）。
 */
export function evaluateCarrierSlaEligibility(
  bundle: ShipmentEvidenceBundle,
  options: { now?: () => Date } = {},
): CarrierSlaEligibilityEvaluation {
  const sla = bundle.slaInputs;
  const conflicts = bundle.evidenceConflicts;
  const terms = bundle.terms;
  const trackingReference = bundle.tracking.rawReference;
  const termsReferences = terms ? [terms.rawReference, terms.termsReference] : [];
  const deliveryReferences = [trackingReference, ...(bundle.pod ? [bundle.pod.rawReference] : [])];
  const invoiceReferences = bundle.invoices.map((invoice) => invoice.rawReference);

  const trackingServiceLevel = sla.trackingServiceLevel;
  const termsServiceLevel = sla.termsServiceLevel;
  const serviceLevelSource: CarrierSlaServiceLevelSource =
    trackingServiceLevel !== null && termsServiceLevel !== null ? 'TRACKING_AND_TERMS'
      : trackingServiceLevel !== null ? 'TRACKING_ONLY'
        : termsServiceLevel !== null ? 'TERMS_ONLY'
          : 'NONE';

  const relevantDateSource: 'TRACKING_SHIP_DATE' = 'TRACKING_SHIP_DATE';
  const relevantDate = bundle.tracking.shipDate ?? null;

  const ruleResults: CarrierSlaRuleResult[] = [];
  const push = (
    ruleId: CarrierSlaRuleId,
    status: CarrierSlaRuleStatus,
    reasonCode: string,
    evidenceReferences: readonly string[],
  ): void => {
    ruleResults.push({ ruleId, status, reasonCode, evidenceReferences });
  };

  // ㉒ⓐ evidence completeness（缺证据 → UNKNOWN，不是 FAIL）。
  if (bundle.completeness === 'COMPLETE') push('EVIDENCE_COMPLETENESS', 'PASS', 'EVIDENCE_COMPLETE', bundle.evidenceReferences);
  else push('EVIDENCE_COMPLETENESS', 'UNKNOWN', 'EVIDENCE_INCOMPLETE', bundle.missingEvidence.map((gap) => 'missing:' + gap));

  // ㉒ⓑ evidence conflicts（冲突 → UNKNOWN，不得静默消解）。
  if (conflicts.length === 0) push('EVIDENCE_CONFLICTS', 'PASS', 'EVIDENCE_CONFLICT_FREE', []);
  else push('EVIDENCE_CONFLICTS', 'UNKNOWN', 'EVIDENCE_CONFLICT_PRESENT', conflicts.map((conflict) => 'conflict:' + conflict));

  // ㉒ⓒ terms evidence present。
  if (terms) push('TERMS_EVIDENCE_PRESENT', 'PASS', 'TERMS_EVIDENCE_PRESENT', termsReferences);
  else push('TERMS_EVIDENCE_PRESENT', 'UNKNOWN', 'TERMS_EVIDENCE_MISSING', []);

  // ㉓ terms applicability：必须显式判断（relevant date source + inclusive 语义），缺日期 → UNKNOWN。
  if (!terms) push('TERMS_EFFECTIVE_RANGE', 'UNKNOWN', 'TERMS_EVIDENCE_MISSING', []);
  else if (relevantDate === null) push('TERMS_EFFECTIVE_RANGE', 'UNKNOWN', 'RELEVANT_DATE_UNAVAILABLE', termsReferences);
  else if (terms.effectiveFrom === null && terms.effectiveTo === null) push('TERMS_EFFECTIVE_RANGE', 'UNKNOWN', 'TERMS_RANGE_UNAVAILABLE', termsReferences);
  else if (terms.effectiveFrom !== null && relevantDate < terms.effectiveFrom) push('TERMS_EFFECTIVE_RANGE', 'FAIL', 'TERMS_NOT_EFFECTIVE', termsReferences);
  else if (terms.effectiveTo !== null && relevantDate > terms.effectiveTo) push('TERMS_EFFECTIVE_RANGE', 'FAIL', 'TERMS_NOT_EFFECTIVE', termsReferences);
  else push('TERMS_EFFECTIVE_RANGE', 'PASS', 'TERMS_EFFECTIVE_RANGE_INCLUDES_RELEVANT_DATE', termsReferences);

  // ㉒ⓔ service level match（冲突 → UNKNOWN；两来源一致或仅一方有值 → PASS）。
  if (conflicts.includes('SERVICE_LEVEL_CONFLICT')) push('SERVICE_LEVEL_MATCH', 'UNKNOWN', 'SERVICE_LEVEL_CONFLICT', termsReferences);
  else if (sla.serviceLevel === null) push('SERVICE_LEVEL_MATCH', 'UNKNOWN', 'SERVICE_LEVEL_UNAVAILABLE', termsReferences);
  else push('SERVICE_LEVEL_MATCH', 'PASS', 'SERVICE_LEVEL_CONSISTENT', termsReferences);

  // ㉔ delivery timing（只做确定性比较；lateObserved 不等于可退款）。
  if (conflicts.includes('DELIVERY_TIME_CONFLICT')) push('DELIVERY_TIMING', 'UNKNOWN', 'DELIVERY_TIME_CONFLICT', deliveryReferences);
  else if (sla.promisedDeliveryAt === null) push('DELIVERY_TIMING', 'UNKNOWN', 'PROMISED_DELIVERY_UNAVAILABLE', deliveryReferences);
  else if (sla.actualDeliveryAt === null) push('DELIVERY_TIMING', 'UNKNOWN', 'ACTUAL_DELIVERY_UNAVAILABLE', deliveryReferences);
  else if (sla.actualDeliveryAt > sla.promisedDeliveryAt) push('DELIVERY_TIMING', 'PASS', 'LATE_DELIVERY_OBSERVED', deliveryReferences);
  else push('DELIVERY_TIMING', 'FAIL', 'ON_TIME_OR_EARLY', deliveryReferences);

  // ㉒ⓖ exception / delay observation（observation，不是 slaEligible）。
  if (sla.exceptionOrDelayObserved) push('EXCEPTION_OR_DELAY_OBSERVED', 'PASS', 'EXCEPTION_OR_DELAY_OBSERVED', deliveryReferences);
  else push('EXCEPTION_OR_DELAY_OBSERVED', 'FAIL', 'EXCEPTION_DELAY_NOT_OBSERVED', deliveryReferences);

  // ㉒ⓗ billed invoice presence（缺 invoice → UNKNOWN）。
  if (bundle.invoices.length > 0) push('BILLED_INVOICE_PRESENT', 'PASS', 'BILLED_INVOICE_PRESENT', invoiceReferences);
  else push('BILLED_INVOICE_PRESENT', 'UNKNOWN', 'INVOICE_EVIDENCE_MISSING', []);

  const failed = ruleResults.filter((result) => result.status === 'FAIL');
  const unknown = ruleResults.filter((result) => result.status === 'UNKNOWN');
  const decision: CarrierSlaDecision = failed.length > 0 ? 'NOT_ELIGIBLE' : unknown.length > 0 ? 'INDETERMINATE' : 'ELIGIBLE';
  const blockers = [...failed, ...unknown].map((result) => result.ruleId + ':' + result.reasonCode);
  const evidenceReferences = [
    ...new Set([...termsReferences, ...deliveryReferences, ...invoiceReferences, ...bundle.evidenceReferences]),
  ];

  return {
    bundleId: bundle.bundleId,
    organizationId: bundle.organizationId,
    provider: bundle.provider,
    externalAccountId: bundle.externalAccountId,
    trackingNumber: bundle.trackingNumber,
    ruleSetId: CARRIER_SLA_RULE_SET_ID,
    ruleSetVersion: CARRIER_SLA_RULE_SET_VERSION,
    evaluatedAt: (options.now ?? (() => new Date()))().toISOString(),
    decision,
    ruleResults,
    blockers,
    evaluationBasis: {
      completeness: bundle.completeness,
      evidenceConflicts: conflicts,
      promisedDeliveryAt: sla.promisedDeliveryAt,
      actualDeliveryAt: sla.actualDeliveryAt,
      serviceLevel: sla.serviceLevel,
      serviceLevelSource,
      exceptionOrDelayObserved: sla.exceptionOrDelayObserved,
      scanEventCount: sla.scanEventCount,
      invoiceCount: bundle.invoices.length,
      termsPresent: terms !== null,
      relevantDateSource,
      relevantDate,
    },
    evidenceReferences,
    evaluationOnly: true,
    claimSubmissionPerformed: false,
    readOnly: true,
    transportEnabled: false,
    platformWriteEnabled: false,
    productionCredentials: 'ABSENT',
  };
}
