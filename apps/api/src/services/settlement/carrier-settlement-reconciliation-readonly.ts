/**
 * MSG-20261003-133 Q2①（架构方裁决）— Carrier 结果 → Settlement **只读**对账投影。
 * ---------------------------------------------------------------
 * 目标：补上 Recovery 链最关键的「结果事实 → 到账事实」断点，但在 Real Money HOLD 下**只读**。
 *
 * 硬边界（架构方明文）：
 *   · 只产出 reconciliation projection / discrepancy；**不创建** Settlement 事实，**不改** Payment / Billing / 真实资金；
 *   · 没有银行 / 支付 / 结算证据时，carrier APPROVED / PAID 文本**不得**升级为 Settlement.RECEIVED；
 *   · 金额口径互不等同：carrierClaimed ≠ recoverable ≠ won ≠ settled ≠ billable；
 *   · 币种不一致 → INDETERMINATE（不做 FX 换算）；未知状态 → INDETERMINATE（不猜测）。
 */

export const CARRIER_OUTCOME_STATUSES = ['APPROVED', 'PAID', 'PARTIAL', 'DENIED', 'UNKNOWN'] as const;
export type CarrierOutcomeStatus = (typeof CARRIER_OUTCOME_STATUSES)[number];

export const SETTLEMENT_EVIDENCE_KINDS = ['BANK_STATEMENT', 'PSP_PAYOUT', 'REMITTANCE_ADVICE', 'NONE'] as const;
export type SettlementEvidenceKind = (typeof SETTLEMENT_EVIDENCE_KINDS)[number];

export const CARRIER_SETTLEMENT_PROJECTION_STATUSES = [
  'MATCHED',
  'AWAITING_SETTLEMENT_EVIDENCE',
  'DISCREPANCY',
  'INDETERMINATE',
] as const;
export type CarrierSettlementProjectionStatus = (typeof CARRIER_SETTLEMENT_PROJECTION_STATUSES)[number];

export const CARRIER_SETTLEMENT_REASONS = [
  'OK',
  'CARRIER_OUTCOME_WITHOUT_SETTLEMENT_EVIDENCE',
  'SETTLEMENT_AMOUNT_MISMATCH',
  'CURRENCY_MISMATCH',
  'UNKNOWN_CARRIER_STATUS',
  'CARRIER_DENIED_NOT_BILLABLE',
  'TENANT_LINEAGE_MISMATCH',
  'MISSING_REFERENCE_LINEAGE',
] as const;
export type CarrierSettlementReason = (typeof CARRIER_SETTLEMENT_REASONS)[number];

export class CarrierSettlementReconciliationError extends Error {
  readonly code: 'INVALID_REQUEST' | 'CROSS_TENANT_LINEAGE';
  constructor(code: 'INVALID_REQUEST' | 'CROSS_TENANT_LINEAGE', detail: string) {
    super(code + ': ' + detail);
    this.name = 'CarrierSettlementReconciliationError';
    this.code = code;
  }
}

export interface CarrierOutcomeFactInput {
  organizationId: string;
  providerReference: string;
  status: string;
  amount: string;
  currency: string;
  observedAt: string;
}

export interface SettlementEvidenceInput {
  organizationId: string;
  kind: string;
  amount: string | null;
  currency: string;
  reference: string;
  observedAt: string;
}

export interface CarrierSettlementProjection {
  organizationId: string;
  providerReference: string;
  carrierStatus: CarrierOutcomeStatus;
  projectionStatus: CarrierSettlementProjectionStatus;
  reasonCodes: readonly CarrierSettlementReason[];
  carrierClaimedAmount: string;
  settledEvidenceAmount: string | null;
  currency: string;
  readonly createsSettlementFact: false;
  readonly upgradesCarrierTextToReceived: false;
  readonly modifiesMoney: false;
  readonly billable: false;
  readonly appliesFxConversion: false;
}

const DECIMAL_PATTERN = /^-?\d{1,15}(\.\d{1,6})?$/;

function fail(code: 'INVALID_REQUEST' | 'CROSS_TENANT_LINEAGE', detail: string): never {
  throw new CarrierSettlementReconciliationError(code, detail);
}

export function decimal6(value: string): string {
  if (typeof value !== 'string' || !DECIMAL_PATTERN.test(value.trim())) fail('INVALID_REQUEST', '非法十进制金额');
  const trimmed = value.trim();
  const negative = trimmed.startsWith('-');
  const digits = negative ? trimmed.slice(1) : trimmed;
  const [whole, fraction = ''] = digits.split('.');
  return (negative ? '-' : '') + whole + '.' + fraction.padEnd(6, '0').slice(0, 6);
}

function toScaled(value: string): bigint {
  const normalised = decimal6(value);
  const negative = normalised.startsWith('-');
  const digits = (negative ? normalised.slice(1) : normalised).replace('.', '');
  const scaled = BigInt(digits);
  return negative ? -scaled : scaled;
}

export const CARRIER_SETTLEMENT_BOUNDARY = {
  readOnly: true,
  createsSettlementFact: false,
  upgradesCarrierTextToReceived: false,
  modifiesMoney: false,
  billable: false,
  appliesFxConversion: false,
  requiresSettlementEvidenceForReceived: true,
} as const;

/**
 * 生成只读对账投影（每个 carrier outcome 一条；不写任何事实）。
 */
export function projectCarrierSettlementReconciliation(input: {
  carrierOutcomes: readonly CarrierOutcomeFactInput[];
  settlementEvidence: readonly SettlementEvidenceInput[];
}): readonly CarrierSettlementProjection[] {
  if (!Array.isArray(input.carrierOutcomes) || !Array.isArray(input.settlementEvidence)) {
    fail('INVALID_REQUEST', 'carrierOutcomes / settlementEvidence 必须是数组');
  }

  return input.carrierOutcomes.map((outcome) => {
    const status = String(outcome.status ?? '').toUpperCase();
    const reasons: CarrierSettlementReason[] = [];

    const evidence = input.settlementEvidence.find((candidate) => {
      if (candidate.organizationId !== outcome.organizationId) {
        fail('CROSS_TENANT_LINEAGE', '结算证据与 carrier outcome 不属于同一租户');
      }
      return candidate.reference === outcome.providerReference && candidate.kind !== 'NONE';
    });

    if (!outcome.providerReference || outcome.providerReference.trim() === '') {
      reasons.push('MISSING_REFERENCE_LINEAGE');
    }

    let projectionStatus: CarrierSettlementProjectionStatus;
    let settledEvidenceAmount: string | null = null;

    if (!(CARRIER_OUTCOME_STATUSES as readonly string[]).includes(status)) {
      projectionStatus = 'INDETERMINATE';
      reasons.push('UNKNOWN_CARRIER_STATUS');
    } else if (evidence && evidence.currency !== outcome.currency) {
      projectionStatus = 'INDETERMINATE';
      reasons.push('CURRENCY_MISMATCH');
    } else if (!evidence) {
      // 关键诚实语义：APPROVED / PAID 文本没有结算证据时**不得**视为已到账
      projectionStatus = 'AWAITING_SETTLEMENT_EVIDENCE';
      reasons.push('CARRIER_OUTCOME_WITHOUT_SETTLEMENT_EVIDENCE');
      if (status === 'DENIED') reasons.push('CARRIER_DENIED_NOT_BILLABLE');
    } else if (evidence.amount === null) {
      projectionStatus = 'INDETERMINATE';
      reasons.push('CARRIER_OUTCOME_WITHOUT_SETTLEMENT_EVIDENCE');
    } else {
      settledEvidenceAmount = decimal6(evidence.amount);
      if (toScaled(settledEvidenceAmount) === toScaled(outcome.amount)) {
        projectionStatus = 'MATCHED';
        reasons.push('OK');
      } else {
        projectionStatus = 'DISCREPANCY';
        reasons.push('SETTLEMENT_AMOUNT_MISMATCH');
      }
    }

    if (reasons.length === 0) reasons.push('OK');

    return {
      organizationId: outcome.organizationId,
      providerReference: outcome.providerReference,
      carrierStatus: (CARRIER_OUTCOME_STATUSES as readonly string[]).includes(status)
        ? (status as CarrierOutcomeStatus)
        : 'UNKNOWN',
      projectionStatus,
      reasonCodes: reasons,
      carrierClaimedAmount: decimal6(outcome.amount),
      settledEvidenceAmount,
      currency: outcome.currency,
      createsSettlementFact: false,
      upgradesCarrierTextToReceived: false,
      modifiesMoney: false,
      billable: false,
      appliesFxConversion: false,
    };
  });
}
