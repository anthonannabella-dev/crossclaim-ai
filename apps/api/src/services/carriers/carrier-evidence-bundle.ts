/**
 * CARRIER QUEUE #6（MSG-20261003-111 ⑤）— SLA Evidence Assembly / Eligibility Input Plane。
 * CARRIER QUEUE #6 FINAL（MSG-20261003-112 ⑫⑬⑭⑮⑯⑱⑲）— EVIDENCE FACT / CONFLICT SEMANTICS：
 *   · promisedDeliveryAt 只取自 tracking.estimatedDeliveryAt；不得用 shipDate 替代，也不得用 slaCommitmentHours 在本层推算 deadline。
 *   · deliveryTimes 暴露 tracking / POD 两个交付时间来源；冲突 → DELIVERY_TIME_CONFLICT 且 actualDeliveryAt = null（不静默择一）。
 *   · serviceLevel 冲突 → SERVICE_LEVEL_CONFLICT 且 serviceLevel = null（同时暴露 trackingServiceLevel / termsServiceLevel）。
 *   · completeness（证据类型是否齐备）与 evidenceConflicts（证据是否互相一致）相互独立；conflict 不得塞进 missingEvidence。
 * ---------------------------------------------------------------
 * 目标：把已存在的只读事实（tracking / invoice / POD / carrier terms / service level）装配为一个**证据输入包**，
 *       供后续 eligibility evaluation 消费 —— **不是** claim submission。
 * 硬边界：
 *   · 只装配证据；`adjudicationPerformed = false`，不产生 refundDue / slaEligible / claimValue / successFee / recoveryAmount。
 *   · 跨平面身份必须一致（provider + externalAccountId + trackingNumber），否则 fail-closed。
 *   · 金额不跨币种相加：只按 currency 分组给出 carrier-billed 合计。
 *   · 只保留 safe reference；不携带 raw payload / signature / 完整收件人姓名。
 *   · 纯装配（无端口、无网络）；TRANSPORT=false · platformWriteEnabled=false · productionCredentials=ABSENT。
 */

import type { CarrierProvider } from './connector-capability';
import type { CarrierTrackingSnapshot } from './carrier-tracking-read';
import { addDecimalStrings, type CarrierInvoiceFact, type CarrierPODFact } from './carrier-invoice-pod-read';

/** SLA 条款证据输入（只声明事实与来源，不做适用性认定）。 */
export interface CarrierTermsEvidence {
  provider: CarrierProvider;
  source: 'CONTRACT' | 'RATE_CARD' | 'CARRIER_TERMS' | 'MANUAL';
  termsReference: string;
  serviceLevel: string | null;
  /** 承诺时效（小时）；只作为事实输入，是否满足由后续 eligibility 判定。 */
  slaCommitmentHours: number | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  rawReference: string;
}

export const SHIPMENT_EVIDENCE_GAPS = [
  'TRACKING_FACT',
  'INVOICE_FACT',
  'POD_FACT',
  'CARRIER_TERMS',
  'SERVICE_LEVEL',
] as const;
export type ShipmentEvidenceGap = (typeof SHIPMENT_EVIDENCE_GAPS)[number];

/** 证据互相冲突（≠ 证据缺失）：只暴露冲突，不在证据层裁决“谁更可信”（MSG-112 ⑱⑲）。 */
export const SHIPMENT_EVIDENCE_CONFLICTS = [
  'DELIVERY_TIME_CONFLICT',
  'SERVICE_LEVEL_CONFLICT',
] as const;
export type ShipmentEvidenceConflict = (typeof SHIPMENT_EVIDENCE_CONFLICTS)[number];

export interface CarrierBilledTotal {
  currency: string;
  totalCharge: string;
  invoiceCount: number;
  /**
   * 事实字段（不判定）：total − Σ(component subtotals)。
   * provider invoice 可能存在 discount / rounding / unmapped adjustment，因此只保留 delta，不据此判断数据错误。
   * 任一 component 缺失时为 null。
   */
  deltaFromComponents: string | null;
}

/** 交付时间来源（两类只读事实各自保留；证据层不择一）。 */
export interface ShipmentEvidenceDeliveryTimes {
  trackingDeliveredAt: string | null;
  podDeliveredAt: string | null;
}

/** 供 eligibility evaluation 使用的**证据**输入（不含任何判定结论）。 */
export interface ShipmentEvidenceSlaInputs {
  promisedDeliveryAt: string | null;
  actualDeliveryAt: string | null;
  /** tracking / POD 各自的交付时间事实（冲突时 actualDeliveryAt 为 null）。 */
  deliveryTimes: ShipmentEvidenceDeliveryTimes;
  exceptionOrDelayObserved: boolean;
  scanEventCount: number;
  /** 仅在 tracking / terms 一致（或仅一方有值）时为 canonical value；冲突时为 null。 */
  serviceLevel: string | null;
  trackingServiceLevel: string | null;
  termsServiceLevel: string | null;
  slaCommitmentHours: number | null;
  billedTotals: readonly CarrierBilledTotal[];
}

export interface ShipmentEvidenceBundle {
  bundleId: string;
  organizationId: string;
  provider: CarrierProvider;
  externalAccountId: string;
  trackingNumber: string;
  completeness: 'COMPLETE' | 'PARTIAL';
  missingEvidence: readonly ShipmentEvidenceGap[];
  /** 证据互相冲突；与 completeness 独立（COMPLETE + SERVICE_LEVEL_CONFLICT 为合法状态）。 */
  evidenceConflicts: readonly ShipmentEvidenceConflict[];
  tracking: CarrierTrackingSnapshot;
  invoices: readonly CarrierInvoiceFact[];
  pod: CarrierPODFact | null;
  terms: CarrierTermsEvidence | null;
  slaInputs: ShipmentEvidenceSlaInputs;
  evidenceReferences: readonly string[];
  observedAt: string;
  /** Queue #6 只做证据装配。 */
  evidenceOnly: true;
  /** 明确：本包**未**做 eligibility / 赔付 / claim 认定。 */
  adjudicationPerformed: false;
  readOnly: true;
  transportEnabled: false;
  platformWriteEnabled: false;
  productionCredentials: 'ABSENT';
}

export interface ShipmentEvidenceAssemblyInput {
  organizationId: string;
  tracking: CarrierTrackingSnapshot | null;
  invoices?: readonly CarrierInvoiceFact[] | null;
  pod?: CarrierPODFact | null;
  terms?: CarrierTermsEvidence | null;
}

export type ShipmentEvidenceFailureCode =
  | 'TRACKING_FACT_REQUIRED'
  | 'TENANT_CONTEXT_REQUIRED'
  | 'EVIDENCE_IDENTITY_MISMATCH'
  | 'EVIDENCE_INPUT_INVALID';

export type ShipmentEvidenceOutcome =
  | { ok: true; bundle: ShipmentEvidenceBundle }
  | { ok: false; reason: ShipmentEvidenceFailureCode };

/** 只读证据包装配（无端口 / 无网络 / 无判定）。 */
export function assembleShipmentEvidence(
  input: ShipmentEvidenceAssemblyInput,
  options: { now?: () => Date } = {},
): ShipmentEvidenceOutcome {
  const organizationId = typeof input.organizationId === 'string' ? input.organizationId.trim() : '';
  if (organizationId === '') return { ok: false, reason: 'TENANT_CONTEXT_REQUIRED' };
  if (!input.tracking) return { ok: false, reason: 'TRACKING_FACT_REQUIRED' };

  const tracking = input.tracking;
  if (typeof tracking !== 'object' || tracking === null) return { ok: false, reason: 'EVIDENCE_INPUT_INVALID' };
  const provider = tracking.provider;
  const externalAccountId = tracking.externalAccountId;
  const trackingNumber = tracking.trackingNumber;
  if (!provider || !externalAccountId || !trackingNumber) return { ok: false, reason: 'EVIDENCE_INPUT_INVALID' };

  const invoices = input.invoices ?? [];
  const pod = input.pod ?? null;
  const terms = input.terms ?? null;

  // 跨平面身份必须一致（provider + account + tracking）。
  const identities = [
    ...invoices.map((invoice) => ({ provider: invoice.provider, account: invoice.externalAccountId, tracking: invoice.trackingNumber })),
    ...(pod ? [{ provider: pod.provider, account: pod.externalAccountId, tracking: pod.trackingNumber }] : []),
  ];
  for (const identity of identities) {
    if (identity.provider !== provider || identity.account !== externalAccountId) {
      return { ok: false, reason: 'EVIDENCE_IDENTITY_MISMATCH' };
    }
    if (identity.tracking !== null && identity.tracking !== undefined && identity.tracking !== trackingNumber) {
      return { ok: false, reason: 'EVIDENCE_IDENTITY_MISMATCH' };
    }
  }
  if (terms && terms.provider !== provider) return { ok: false, reason: 'EVIDENCE_IDENTITY_MISMATCH' };

  const missing: ShipmentEvidenceGap[] = [];
  if (invoices.length === 0) missing.push('INVOICE_FACT');
  if (!pod) missing.push('POD_FACT');
  if (!terms) missing.push('CARRIER_TERMS');
  if (!terms?.serviceLevel && !tracking.serviceLevel) missing.push('SERVICE_LEVEL');

  // 金额按币种分组，绝不跨币种相加。
  const byCurrency = new Map<string, { amounts: string[]; count: number }>();
  for (const invoice of invoices) {
    const bucket = byCurrency.get(invoice.currency) ?? { amounts: [], count: 0 };
    bucket.amounts.push(invoice.totalCharge);
    bucket.count += 1;
    byCurrency.set(invoice.currency, bucket);
  }
  const billedTotals: CarrierBilledTotal[] = [...byCurrency.entries()]
    .map(([currency, bucket]) => {
      const totals = invoices.filter((invoice) => invoice.currency === currency).map((invoice) => invoice.totalCharge);
      const components = invoices
        .filter((invoice) => invoice.currency === currency)
        .flatMap((invoice) => [invoice.baseCharge, invoice.fuelSurcharge, invoice.accessorialCharges, invoice.tax])
        .filter((value): value is string => value !== null);
      const delta = components.length > 0 ? addDecimalStrings([addDecimalStrings(totals), '-' + addDecimalStrings(components).replace(/^-/, '')]) : null;
      return {
        currency,
        totalCharge: addDecimalStrings(bucket.amounts),
        invoiceCount: bucket.count,
        deltaFromComponents: delta,
      };
    })
    .sort((left, right) => (left.currency < right.currency ? -1 : left.currency > right.currency ? 1 : 0));

  const exceptionOrDelayObserved = tracking.events.some((event) => event.status === 'EXCEPTION' || event.status === 'DELAYED');
  const invoiceReferences = invoices.map((invoice) => invoice.invoiceReference);
  const evidenceReferences = [
    tracking.rawReference,
    ...invoices.map((invoice) => invoice.rawReference),
    ...(pod ? [pod.rawReference, ...(pod.documentReference ? [pod.documentReference] : [])] : []),
    ...(terms ? [terms.rawReference, terms.termsReference] : []),
  ];
  const observedAt = (options.now ?? (() => new Date()))().toISOString();
  const bundleId = ['carrier-evidence', provider, externalAccountId, trackingNumber, ...invoiceReferences, ...evidenceReferences].join('|');

  // MSG-112 ⑬⑭ CHANGE B：交付时间冲突必须暴露，证据层不得裁定“谁更可信”。
  const trackingDeliveredAt = tracking.deliveredAt ?? null;
  const podDeliveredAt = pod?.deliveredAt ?? null;
  const deliveryTimes: ShipmentEvidenceDeliveryTimes = { trackingDeliveredAt, podDeliveredAt };
  const deliveryTimeConflict =
    trackingDeliveredAt !== null && podDeliveredAt !== null && trackingDeliveredAt !== podDeliveredAt;
  const actualDeliveryAt = deliveryTimeConflict
    ? null
    : trackingDeliveredAt !== null && podDeliveredAt !== null
      ? trackingDeliveredAt
      : trackingDeliveredAt ?? podDeliveredAt;

  // MSG-112 ⑮⑯ CHANGE C：service level 冲突必须暴露，证据层不得静默覆盖。
  const trackingServiceLevel = tracking.serviceLevel ?? null;
  const termsServiceLevel = terms?.serviceLevel ?? null;
  const serviceLevelConflict =
    trackingServiceLevel !== null && termsServiceLevel !== null && trackingServiceLevel !== termsServiceLevel;
  const serviceLevel = serviceLevelConflict ? null : termsServiceLevel ?? trackingServiceLevel;

  // MSG-112 ⑱：conflict 与 missing evidence 分离。
  const evidenceConflicts: ShipmentEvidenceConflict[] = [];
  if (deliveryTimeConflict) evidenceConflicts.push('DELIVERY_TIME_CONFLICT');
  if (serviceLevelConflict) evidenceConflicts.push('SERVICE_LEVEL_CONFLICT');

  return {
    ok: true,
    bundle: {
      bundleId,
      organizationId,
      provider,
      externalAccountId,
      trackingNumber,
      completeness: missing.length === 0 ? 'COMPLETE' : 'PARTIAL',
      missingEvidence: missing,
      evidenceConflicts,
      tracking,
      invoices,
      pod,
      terms,
      slaInputs: {
        // MSG-112 ⑫ CHANGE A：只绑定真实已存在的承诺/预计送达事实；slaCommitmentHours 仅作独立 evidence input。
        promisedDeliveryAt: tracking.estimatedDeliveryAt ?? null,
        actualDeliveryAt,
        deliveryTimes,
        exceptionOrDelayObserved,
        scanEventCount: tracking.events.length,
        serviceLevel,
        trackingServiceLevel,
        termsServiceLevel,
        slaCommitmentHours: terms?.slaCommitmentHours ?? null,
        billedTotals,
      },
      evidenceReferences,
      observedAt,
      evidenceOnly: true,
      adjudicationPerformed: false,
      readOnly: true,
      transportEnabled: false,
      platformWriteEnabled: false,
      productionCredentials: 'ABSENT',
    },
  };
}
