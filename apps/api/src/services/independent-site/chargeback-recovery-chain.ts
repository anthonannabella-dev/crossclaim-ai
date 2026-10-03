/**
 * BG-010（MSG-20261003-133 Q1/Q2②）— PS04 Phase 1：独立站 / 拒付**内部只读链**。
 * ---------------------------------------------------------------
 * 链：Payment/Dispute 事实 → Evidence Assembly → Qualification Input → Claim-Ready Evidence Package → 只读查询视图。
 *
 * 硬边界（架构方明文）：
 *   · 仅 fixture / CSV / FILE_UPLOAD；**不接** Shopify/Stripe/PayPal 真实 API、Webhook、生产凭据；**不实现** dispute.submit；
 *   · 支付账户必须有 tenant + merchant/payment-account lineage；缺失或歧义 → INDETERMINATE / NOT_READY；
 *   · evidence due date 缺失 → INDETERMINATE（fail-closed）；
 *   · 金额口径互不等同：disputeAmount ≠ recoverableAmountEstimate ≠ wonAmount ≠ settledAmount ≠ billableAmount；
 *   · Claim-Ready Package 只表示「材料已准备」，绝不表示已提交 / 已胜诉 / 已到账；
 *   · 不得存 PAN / CVV / 完整支付凭据 / PSP secret；
 *   · 资金归属本阶段只做**事实归属**：确认该 merchant/payment account 属于当前 tenant；不托管、不划转、不代收代付。
 */

export const PS04_PSP_CHANNELS = ['SHOPIFY', 'STRIPE', 'PAYPAL'] as const;
export type Ps04PspChannel = (typeof PS04_PSP_CHANNELS)[number];

export const PS04_DISPUTE_STATUSES = ['OPEN', 'NEEDS_RESPONSE', 'WON', 'LOST', 'UNKNOWN'] as const;
export type Ps04DisputeStatus = (typeof PS04_DISPUTE_STATUSES)[number];

export const PS04_EVIDENCE_KINDS = ['ORDER_RECORD', 'DELIVERY_PROOF', 'CUSTOMER_COMMUNICATION', 'REFUND_RECORD', 'POLICY_RECORD', 'OTHER'] as const;
export type Ps04EvidenceKind = (typeof PS04_EVIDENCE_KINDS)[number];

export const PS04_PACKAGE_STATUSES = ['READY', 'NOT_READY', 'INDETERMINATE'] as const;
export type Ps04PackageStatus = (typeof PS04_PACKAGE_STATUSES)[number];

export const PS04_REASON_CODES = [
  'OK',
  'MISSING_LINEAGE',
  'AMBIGUOUS_LINEAGE',
  'MISSING_EVIDENCE_DUE_DATE',
  'UNKNOWN_DISPUTE_STATUS',
  'CURRENCY_MISMATCH',
  'MISSING_DISPUTE_EVIDENCE',
  'FORBIDDEN_PAYMENT_CREDENTIAL_FIELD',
  'DISPUTE_NOT_FOUND',
] as const;
export type Ps04ReasonCode = (typeof PS04_REASON_CODES)[number];

export class Ps04ChainError extends Error {
  readonly code: 'INVALID_REQUEST' | 'CROSS_TENANT_LINEAGE';
  constructor(code: 'INVALID_REQUEST' | 'CROSS_TENANT_LINEAGE', detail: string) {
    super(code + ': ' + detail);
    this.name = 'Ps04ChainError';
    this.code = code;
  }
}

export interface Ps04PaymentAccountRef {
  organizationId: string;
  merchantId: string;
  paymentAccountId: string;
  channel: string;
}

export interface Ps04PaymentTransactionFact {
  organizationId: string;
  account: Ps04PaymentAccountRef;
  transactionReference: string;
  amount: string;
  currency: string;
  occurredAt: string;
}

export interface Ps04DisputeFact {
  organizationId: string;
  account: Ps04PaymentAccountRef;
  disputeReference: string;
  transactionReference: string;
  status: string;
  amount: string;
  currency: string;
  evidenceDueBy: string | null;
  reasonCode: string | null;
  observedAt: string;
}

export interface Ps04EvidenceRecord {
  organizationId: string;
  disputeReference: string;
  kind: string;
  reference: string;
  observedAt: string;
}

export interface Ps04SettlementEvidence {
  organizationId: string;
  disputeReference: string;
  amount: string;
  currency: string;
  reference: string;
  observedAt: string;
}

export interface Ps04ClaimReadyEvidencePackage {
  packageId: string;
  organizationId: string;
  disputeReference: string;
  status: Ps04PackageStatus;
  reasonCodes: readonly Ps04ReasonCode[];
  channel: string;
  currency: string;
  /** 金额口径严格分离（不得互相赋值） */
  disputeAmount: string;
  recoverableAmountEstimate: string | null;
  wonAmount: string | null;
  settledAmount: string | null;
  billableAmount: null;
  evidenceManifest: readonly { kind: string; reference: string }[];
  missingEvidenceKinds: readonly string[];
  readonly submissionPerformed: false;
  readonly filingPerformed: false;
  readonly customerSubmissionPerformed: false;
  readonly fundsCustody: false;
  readonly fundsTransfer: false;
  readonly ownsRecoveredCash: false;
  readonly productionCredentials: 'ABSENT';
}

const DECIMAL_PATTERN = /^-?\d{1,15}(\.\d{1,6})?$/;
const FORBIDDEN_FIELDS = ['pan', 'cvv', 'cvc', 'cardnumber', 'paymentcredential', 'pspsecret', 'clientsecret', 'accesstoken', 'refreshtoken'];

function fail(code: 'INVALID_REQUEST' | 'CROSS_TENANT_LINEAGE', detail: string): never {
  throw new Ps04ChainError(code, detail);
}

export function decimal6(value: string): string {
  if (typeof value !== 'string' || !DECIMAL_PATTERN.test(value.trim())) fail('INVALID_REQUEST', '非法十进制金额');
  const trimmed = value.trim();
  const negative = trimmed.startsWith('-');
  const digits = negative ? trimmed.slice(1) : trimmed;
  const [whole, fraction = ''] = digits.split('.');
  return (negative ? '-' : '') + whole + '.' + fraction.padEnd(6, '0').slice(0, 6);
}

function scanForbiddenFields(value: unknown, depth = 0): void {
  if (depth > 4 || value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalised = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (FORBIDDEN_FIELDS.includes(normalised)) fail('INVALID_REQUEST', '禁止的支付凭据字段：' + key);
    scanForbiddenFields(child, depth + 1);
  }
}

export const PS04_CHAIN_BOUNDARY = {
  readOnly: true,
  externalPspCalls: false,
  webhooks: false,
  disputeSubmit: false,
  fundsCustody: false,
  fundsTransfer: false,
  ownsRecoveredCash: false,
  productionCredentials: 'ABSENT',
  billableAmountAlwaysNull: true,
} as const;

function lineageOk(account: Ps04PaymentAccountRef | undefined, organizationId: string): Ps04ReasonCode | null {
  if (!account) return 'MISSING_LINEAGE';
  if (account.organizationId !== organizationId) fail('CROSS_TENANT_LINEAGE', '支付账户不属于当前租户');
  if (!account.merchantId || !account.paymentAccountId) return 'MISSING_LINEAGE';
  if (!PS04_PSP_CHANNELS.includes(account.channel as Ps04PspChannel)) return 'AMBIGUOUS_LINEAGE';
  return null;
}

/**
 * 装配 PS04 Phase 1 的 claim-ready 证据包（只读；不做任何提交、不持有资金）。
 */
export function assembleChargebackRecoveryPackage(input: {
  organizationId: string;
  disputeReference: string;
  disputeFacts: readonly Ps04DisputeFact[];
  evidenceRecords: readonly Ps04EvidenceRecord[];
  settlementEvidence?: readonly Ps04SettlementEvidence[];
  requiredEvidenceKinds?: readonly string[];
  now?: string;
}): Ps04ClaimReadyEvidencePackage {
  scanForbiddenFields(input);
  const required = input.requiredEvidenceKinds ?? ['ORDER_RECORD', 'DELIVERY_PROOF'];
  const dispute = input.disputeFacts.find(
    (candidate) => candidate.disputeReference === input.disputeReference && candidate.organizationId === input.organizationId,
  );
  if (!dispute) fail('INVALID_REQUEST', 'DISPUTE_NOT_FOUND');

  const reasons: Ps04ReasonCode[] = [];
  const lineageIssue = lineageOk(dispute.account, input.organizationId);
  if (lineageIssue) reasons.push(lineageIssue);
  if (!dispute.evidenceDueBy) reasons.push('MISSING_EVIDENCE_DUE_DATE');
  const status = String(dispute.status ?? '').toUpperCase();
  if (!(PS04_DISPUTE_STATUSES as readonly string[]).includes(status)) reasons.push('UNKNOWN_DISPUTE_STATUS');

  const evidence = input.evidenceRecords.filter((record) => record.disputeReference === dispute.disputeReference);
  for (const record of evidence) {
    if (record.organizationId !== input.organizationId) fail('CROSS_TENANT_LINEAGE', '证据记录不属于当前租户');
  }
  const presentKinds = new Set(evidence.map((record) => record.kind));
  const missing = required.filter((kind) => !presentKinds.has(kind));
  if (missing.length > 0) reasons.push('MISSING_DISPUTE_EVIDENCE');

  const settlement = (input.settlementEvidence ?? []).find(
    (candidate) => candidate.disputeReference === dispute.disputeReference && candidate.organizationId === input.organizationId,
  );
  if (settlement && settlement.currency !== dispute.currency) reasons.push('CURRENCY_MISMATCH');

  const fatal = reasons.some((reason) =>
    ['MISSING_LINEAGE', 'AMBIGUOUS_LINEAGE', 'CURRENCY_MISMATCH', 'FORBIDDEN_PAYMENT_CREDENTIAL_FIELD'].includes(reason),
  );
  const indeterminate = reasons.some((reason) =>
    ['MISSING_EVIDENCE_DUE_DATE', 'UNKNOWN_DISPUTE_STATUS'].includes(reason),
  );
  const packageStatus: Ps04PackageStatus = fatal ? 'NOT_READY' : indeterminate ? 'INDETERMINATE' : missing.length > 0 ? 'NOT_READY' : 'READY';

  const disputeAmount = decimal6(dispute.amount);
  const wonAmount = status === 'WON' && settlement ? decimal6(settlement.amount) : null;
  const settledAmount = settlement ? decimal6(settlement.amount) : null;
  const recoverableEstimate =
    packageStatus === 'READY' && (status === 'WON' || status === 'NEEDS_RESPONSE' || status === 'OPEN')
      ? decimal6(dispute.amount)
      : null;

  const body = {
    organizationId: input.organizationId,
    disputeReference: dispute.disputeReference,
    status: packageStatus,
    reasonCodes: reasons.length > 0 ? reasons : (['OK'] as Ps04ReasonCode[]),
    channel: dispute.account.channel,
    currency: dispute.currency,
    disputeAmount,
    recoverableAmountEstimate: recoverableEstimate,
    wonAmount,
    settledAmount,
    evidenceManifest: evidence.map((record) => ({ kind: record.kind, reference: record.reference })),
    missingEvidenceKinds: missing,
    observedAt: dispute.observedAt,
  };
  const digest = (() => {
    const canonical = (value: unknown): string => {
      if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
      if (value !== null && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        return '{' + Object.keys(record).sort().map((key) => JSON.stringify(key) + ':' + canonical(record[key])).join(',') + '}';
      }
      return JSON.stringify(value ?? null);
    };
    // 只用于 packageId 的确定性派生（非安全哈希用途）
    let hash = 0;
    const text = canonical(body);
    for (let index = 0; index < text.length; index += 1) {
      hash = (hash * 31 + text.charCodeAt(index)) % 2147483647;
    }
    return hash.toString(16).padStart(12, '0');
  })();

  return {
    packageId: 'ps04-' + digest,
    ...body,
    billableAmount: null,
    submissionPerformed: false,
    filingPerformed: false,
    customerSubmissionPerformed: false,
    fundsCustody: false,
    fundsTransfer: false,
    ownsRecoveredCash: false,
    productionCredentials: 'ABSENT',
  };
}

/** 只读查询视图：金额口径分别呈现，绝不合并为单一「可追回金额」。 */
export function toReadOnlyQueryView(pkg: Ps04ClaimReadyEvidencePackage) {
  return {
    packageId: pkg.packageId,
    status: pkg.status,
    reasonCodes: pkg.reasonCodes,
    amounts: {
      disputeAmount: pkg.disputeAmount,
      recoverableAmountEstimate: pkg.recoverableAmountEstimate,
      wonAmount: pkg.wonAmount,
      settledAmount: pkg.settledAmount,
      billableAmount: pkg.billableAmount,
    },
    boundary: {
      readOnly: true,
      submissionPerformed: pkg.submissionPerformed,
      filingPerformed: pkg.filingPerformed,
      customerSubmissionPerformed: pkg.customerSubmissionPerformed,
      fundsCustody: pkg.fundsCustody,
      fundsTransfer: pkg.fundsTransfer,
      ownsRecoveredCash: pkg.ownsRecoveredCash,
      productionCredentials: pkg.productionCredentials,
    },
  };
}
