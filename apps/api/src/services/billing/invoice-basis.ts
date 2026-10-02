/**
 * R46 S5-A —— Canonical Invoice Basis（MSG-20261002-63）
 * ------------------------------------------------------------------
 * 唯一服务端 canonical builder：invoiceBasisDigest = sha256(canonicalInvoiceBasis)。
 * 绑定字段（冻结）：organizationId / feeCalculationId / feeChainId / customerAccountIdentity /
 *   currency / feeAmount / policyRef / feeBasisVersion / membershipDigest / invoiceBasisVersion。
 * 客户端**不得**自证 digest / amount / currency / customer identity / policy·basis version。
 */

import { createHash } from 'node:crypto';

import { canonicalJson } from '../platform-write/snapshot';

export const INVOICE_BASIS_VERSION = 'invoice-basis/v1';

export interface InvoiceBasisInput {
  organizationId: string;
  feeCalculationId: string;
  feeChainId: string | null;
  customerAccountIdentity: string;
  currency: string;
  feeAmount: string;
  policyRef: string | null;
  feeBasisVersion: string | null;
  membershipDigest: string | null;
}

function amount4(value: string): string {
  const trimmed = String(value).trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return trimmed;
  const negative = trimmed.startsWith('-');
  const [whole, fraction = ''] = trimmed.replace(/^-/, '').split('.');
  return (negative ? '-' : '') + whole + '.' + (fraction + '0000').slice(0, 4);
}

/** 规范化后的 canonical invoice basis（字段顺序固定） */
export function canonicalInvoiceBasis(input: InvoiceBasisInput): string {
  return canonicalJson({
    basisVersion: INVOICE_BASIS_VERSION,
    organizationId: input.organizationId.trim(),
    feeCalculationId: input.feeCalculationId.trim(),
    feeChainId: input.feeChainId ?? null,
    customerAccountIdentity: input.customerAccountIdentity.trim(),
    currency: input.currency.trim().toUpperCase(),
    feeAmount: amount4(input.feeAmount),
    policyRef: input.policyRef ?? null,
    feeBasisVersion: input.feeBasisVersion ?? null,
    membershipDigest: input.membershipDigest ?? null,
  });
}

export function computeInvoiceBasis(input: InvoiceBasisInput): {
  basisVersion: string;
  canonical: string;
  digest: string;
} {
  const canonical = canonicalInvoiceBasis(input);
  return {
    basisVersion: INVOICE_BASIS_VERSION,
    canonical,
    digest: createHash('sha256').update(canonical).digest('hex'),
  };
}

/** 客户端提交体中禁止出现的可信字段（invoice amount / digest / customer identity ...） */
export const FORBIDDEN_INVOICE_CLIENT_FIELDS = [
  'invoiceBasisDigest',
  'invoiceAmount',
  'invoiceTotal',
  'currency',
  'customerAccountIdentity',
  'policyRef',
  'feeBasisVersion',
] as const;

export class InvoiceBasisError extends Error {
  constructor(
    public readonly code: 'CLIENT_INVOICE_FIELDS_NOT_TRUSTED',
    message?: string,
  ) {
    super(message ? code + ': ' + message : code);
    this.name = 'InvoiceBasisError';
  }
}

export function assertNoClientInvoiceFields(payload: Record<string, unknown>): void {
  for (const field of FORBIDDEN_INVOICE_CLIENT_FIELDS) {
    if (payload[field] !== undefined && payload[field] !== null) {
      throw new InvoiceBasisError(
        'CLIENT_INVOICE_FIELDS_NOT_TRUSTED',
        'client-supplied invoice field "' + field + '" is not trusted',
      );
    }
  }
}
