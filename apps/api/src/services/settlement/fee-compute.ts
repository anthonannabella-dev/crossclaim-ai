/**
 * R46 S4 —— 确定性 Fee 计算（纯函数，无 IO）
 * 依据：MSG-20261002-59（S4 AUTHORIZED）。
 *
 * 硬约束：
 *   - Fee 基数只能来自 confirmed + unreversed + eligible 的 Settlement 金额（由 caller 传入 eligible 集合）；
 *   - 费率 / policyRef / feeBasisVersion 必须服务端提供；客户端自报费率一律拒绝；
 *   - membershipDigest 由 canonical 输入重建：membership 集合 + amount + currency + policyRef + feeBasisVersion；
 *   - 金额一律 4 位定点 BigInt（禁浮点）；v1 不换汇。
 */

import { createHash } from 'node:crypto';

import { canonicalJson } from '../platform-write/snapshot';
import { canonicalAmount, canonicalCurrency, ReceiptSnapshotError } from './receipt-snapshot';

export const FEE_ALGORITHM_VERSION = 'settlement-fee/v1';

export class FeeComputeError extends Error {
  constructor(
    public readonly code: string,
    message?: string,
  ) {
    super(message ? code + ': ' + message : code);
    this.name = 'FeeComputeError';
  }
}

export interface FeeMembershipInput {
  settlementId: string;
  /** 已到账金额（Decimal 字符串） */
  amount: string;
  currency: string;
}

export interface FeePolicyInput {
  basis: 'RECOVERED_AMOUNT_PCT' | 'FIXED' | 'NONE';
  /** 百分比 basis 时必填，0–1 之间，最多 6 位小数 */
  rate?: string | null;
  /** 固定费用（FIXED 时必填） */
  fixedAmount?: string | null;
  policyRef: string;
  feeBasisVersion: string;
  currency: string;
}

export interface FeeComputeInput {
  memberships: FeeMembershipInput[];
  adjustments?: FeeMembershipInput[];
  policy: FeePolicyInput;
  /** 客户端若自报费率 / 政策 → 一律拒绝 */
  clientSuppliedRate?: string | null;
  clientSuppliedPolicyRef?: string | null;
}

export interface FeeComputeResult {
  baseAmount: string;
  feeAmount: string;
  currency: string;
  membershipDigest: string;
  algorithmVersion: string;
  policyRef: string;
  feeBasisVersion: string;
}

const SCALE = 10000n;

function parseDecimal(value: string, label: string): bigint {
  let canonical: string;
  try {
    canonical = canonicalAmount(value);
  } catch (error) {
    if (error instanceof ReceiptSnapshotError) throw new FeeComputeError('INVALID_AMOUNT', label);
    throw error;
  }
  const [i, f = '0000'] = canonical.split('.');
  return BigInt(i) * SCALE + BigInt(f);
}

function formatDecimal(scaled: bigint): string {
  const int = scaled / SCALE;
  const frac = (scaled % SCALE).toString().padStart(4, '0');
  return `${int}.${frac}`;
}

function parseRate(value: string): bigint {
  const text = String(value).trim();
  if (!/^0(\.\d{1,6})?$|^1(\.0{1,6})?$/.test(text)) {
    throw new FeeComputeError('INVALID_RATE', 'rate must be a decimal in [0,1] with <= 6 dp');
  }
  const [i, f = ''] = text.split('.');
  const scaled = BigInt(i) * 1000000n + BigInt((f + '000000').slice(0, 6));
  if (scaled > 1000000n) throw new FeeComputeError('INVALID_RATE', 'rate must be <= 1');
  return scaled;
}

/** membershipDigest：可由输入确定性重建 */
export function computeMembershipDigest(input: FeeComputeInput): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        algorithmVersion: FEE_ALGORITHM_VERSION,
        policyRef: input.policy.policyRef,
        feeBasisVersion: input.policy.feeBasisVersion,
        basis: input.policy.basis,
        rate: input.policy.rate ?? null,
        fixedAmount: input.policy.fixedAmount ?? null,
        memberships: [...input.memberships]
          .map((m) => ({ settlementId: m.settlementId, amount: canonicalAmount(m.amount), currency: canonicalCurrency(m.currency) }))
          .sort((a, b) => (a.settlementId < b.settlementId ? -1 : a.settlementId > b.settlementId ? 1 : 0)),
        adjustments: [...(input.adjustments ?? [])]
          .map((m) => ({ settlementId: m.settlementId, amount: canonicalAmount(m.amount), currency: canonicalCurrency(m.currency) }))
          .sort((a, b) => (a.settlementId < b.settlementId ? -1 : a.settlementId > b.settlementId ? 1 : 0)),
      }),
    )
    .digest('hex');
}

/** 确定性 Fee 计算（server-side policy only） */
export function computeSettlementFee(input: FeeComputeInput): FeeComputeResult {
  if (input.clientSuppliedRate || input.clientSuppliedPolicyRef) {
    throw new FeeComputeError('CLIENT_FEE_INPUT_NOT_TRUSTED', 'client-supplied rate/policy is not trusted');
  }
  if (!input.memberships || input.memberships.length < 1) {
    throw new FeeComputeError('MEMBERSHIP_REQUIRED', 'at least one membership is required');
  }
  const currency = canonicalCurrency(input.policy.currency);
  let positive = 0n;
  for (const m of input.memberships) {
    if (canonicalCurrency(m.currency) !== currency) throw new FeeComputeError('CURRENCY_MISMATCH', 'membership currency mismatch');
    positive += parseDecimal(m.amount, 'membership.amount');
  }
  let negative = 0n;
  for (const a of input.adjustments ?? []) {
    if (canonicalCurrency(a.currency) !== currency) throw new FeeComputeError('CURRENCY_MISMATCH', 'adjustment currency mismatch');
    negative += parseDecimal(a.amount, 'adjustment.amount');
  }
  const net = positive - negative;
  if (net < 0n) throw new FeeComputeError('NEGATIVE_NET_BASIS', 'adjustments exceed eligible receipts');
  if (net === 0n) throw new FeeComputeError('ZERO_BASIS', 'net billable basis is zero');

  let fee: bigint;
  if (input.policy.basis === 'RECOVERED_AMOUNT_PCT') {
    if (!input.policy.rate) throw new FeeComputeError('RATE_REQUIRED', 'rate is required for percentage basis');
    fee = (net * parseRate(input.policy.rate)) / 1000000n;
  } else if (input.policy.basis === 'FIXED') {
    if (!input.policy.fixedAmount) throw new FeeComputeError('FIXED_AMOUNT_REQUIRED', 'fixedAmount is required for FIXED basis');
    fee = parseDecimal(input.policy.fixedAmount, 'fixedAmount');
  } else {
    throw new FeeComputeError('FEE_BASIS_NONE', 'FeeBasis NONE is not billable');
  }
  if (fee <= 0n) throw new FeeComputeError('ZERO_FEE', 'computed fee must be > 0');

  return {
    baseAmount: formatDecimal(net),
    feeAmount: formatDecimal(fee),
    currency,
    membershipDigest: computeMembershipDigest(input),
    algorithmVersion: FEE_ALGORITHM_VERSION,
    policyRef: input.policy.policyRef,
    feeBasisVersion: input.policy.feeBasisVersion,
  };
}
