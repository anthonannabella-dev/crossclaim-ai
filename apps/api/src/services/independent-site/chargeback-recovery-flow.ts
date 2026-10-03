/**
 * CHANGE D（MSG-20261003-135）— Independent-site / Chargeback **内部闭环**（fixture / manual-handoff 版）。
 * ---------------------------------------------------------------
 * 在 PS04 Phase 1 只读链（事实 → 证据 → 资格输入 → claim-ready 包）之上，补内部闭环：
 *   start recovery → manual dispute handoff（人工递交记录）→ PSP 响应事实 → 结算对账
 *   → RecoveryLedger → 15% fee → BillingInvoice(DRAFT)
 *
 * 硬约束（架构方明文 + HOLD_EXTERNAL 不变）：
 *   · **不接** Shopify / Stripe / PayPal 真实 API、Webhook、生产凭据；不实现 dispute.submit；
 *   · submitted ≠ won ≠ settled ≠ recovered ≠ billable（五个状态互相独立，逐级可证）；
 *   · APPROVED / WON 不得当到账；estimated ≠ fee basis；未验证结算 → recovered=0；
 *   · 任何跨租户事实 → 拒绝；同一 executionKey 重放 → 复用既有结果，不产生第二条；
 *   · 零外部写：externalWritePerformed=false / transportEnabled=false / paymentCollected=false。
 */

export const PS04_HANDOFF_CHANNELS = ['MANUAL_PORTAL', 'MANUAL_EMAIL', 'FIXTURE'] as const;
export type Ps04HandoffChannel = (typeof PS04_HANDOFF_CHANNELS)[number];

export const PS04_RESPONSE_DISPOSITIONS = ['WON', 'LOST', 'PARTIAL', 'UNKNOWN'] as const;
export type Ps04ResponseDisposition = (typeof PS04_RESPONSE_DISPOSITIONS)[number];

export const PS04_SETTLEMENT_VERIFICATION = ['VERIFIED', 'UNVERIFIED'] as const;
export type Ps04SettlementVerification = (typeof PS04_SETTLEMENT_VERIFICATION)[number];

export const PS04_FLOW_REASONS = [
  'OK',
  'PACKAGE_NOT_READY',
  'QUALIFICATION_NOT_PASSED',
  'MISSING_CAPABILITY',
  'CROSS_TENANT_FACT',
  'HANDOFF_ALREADY_RECORDED',
  'HANDOFF_NOT_RECORDED',
  'SETTLEMENT_NOT_VERIFIED',
  'RESPONSE_NOT_WON',
  'DIGEST_MISMATCH',
  'CURRENCY_MISMATCH',
] as const;
export type Ps04FlowReason = (typeof PS04_FLOW_REASONS)[number];

export class Ps04FlowError extends Error {
  readonly code: 'NOT_FOUND' | 'FORBIDDEN' | 'CONFLICT' | 'INVALID';
  constructor(code: 'NOT_FOUND' | 'FORBIDDEN' | 'CONFLICT' | 'INVALID', detail: string) {
    super(code + ': ' + detail);
    this.name = 'Ps04FlowError';
    this.code = code;
  }
}

export interface Ps04HandoffFact {
  organizationId: string;
  disputeReference: string;
  packageId: string;
  packageDigest: string;
  channel: Ps04HandoffChannel;
  handoffReference: string;
  attestedByActorId: string;
  executionKey: string;
  recordedAt: string;
}

export interface Ps04ResponseFact {
  organizationId: string;
  disputeReference: string;
  disposition: Ps04ResponseDisposition;
  amount: string | null;
  currency: string;
  source: 'MANUAL_ENTRY' | 'FIXTURE';
  observedAt: string;
}

export interface Ps04SettlementFact {
  organizationId: string;
  disputeReference: string;
  amount: string;
  currency: string;
  verification: Ps04SettlementVerification;
  reference: string;
  receivedAt: string;
}

/** append-only 事实端口（实现方必须拒绝 UPDATE/DELETE 与同一 executionKey 的第二次写入）。 */
export interface Ps04RecoveryFlowPort {
  appendHandoff(fact: Ps04HandoffFact): Promise<{ appended: boolean; existing: Ps04HandoffFact | null }>;
  listHandoffs(organizationId: string, disputeReference: string): Promise<Ps04HandoffFact[]>;
  getHandoff(organizationId: string, disputeReference: string): Promise<Ps04HandoffFact | null>;
}

export interface Ps04FeePolicyRef {
  policyId: string;
  policyVersion: string;
  /** 万分比；1500 = 15%。 */
  rateBasisPoints: number;
}

export interface Ps04StartRecoveryInput {
  organizationId: string;
  disputeReference: string;
  packageId: string;
  packageDigest: string;
  packageStatus: 'READY' | 'NOT_READY' | 'INDETERMINATE';
  qualificationStatus: 'QUALIFIED' | 'CONDITIONAL' | 'NOT_QUALIFIED' | 'INDETERMINATE';
  actorCapabilities: readonly string[];
  requiredCapability: string;
  channel: Ps04HandoffChannel;
  handoffReference: string;
  attestedByActorId: string;
  executionKey: string;
  now: string;
}

export interface Ps04RecoveryStartDecision {
  started: boolean;
  reasonCodes: readonly Ps04FlowReason[];
  handoffFact: Ps04HandoffFact | null;
  replay: boolean;
  readonly externalWritePerformed: false;
  readonly transportEnabled: false;
  readonly paymentCollected: false;
}

const DECIMAL_PATTERN = /^-?\d{1,15}(\.\d{1,6})?$/;

export function ps04Decimal6(value: string): string {
  if (typeof value !== 'string' || !DECIMAL_PATTERN.test(value.trim())) {
    throw new Ps04FlowError('INVALID', '非法十进制值');
  }
  const trimmed = value.trim();
  const negative = trimmed.startsWith('-');
  const digits = negative ? trimmed.slice(1) : trimmed;
  const [whole, fraction = ''] = digits.split('.');
  return (negative ? '-' : '') + whole + '.' + fraction.padEnd(6, '0').slice(0, 6);
}

function toScaled(value: string): bigint {
  const normalised = ps04Decimal6(value);
  const negative = normalised.startsWith('-');
  const digits = (negative ? normalised.slice(1) : normalised).replace('.', '');
  const scaled = BigInt(digits);
  return negative ? -scaled : scaled;
}

function formatScaled(scaled: bigint): string {
  const negative = scaled < 0n;
  const digits = (negative ? -scaled : scaled).toString().padStart(7, '0');
  return (negative ? '-' : '') + digits.slice(0, digits.length - 6) + '.' + digits.slice(digits.length - 6);
}

/** 15%（或 policy 指定）成功费：只对**已验证实际追回**计费。 */
export function computePs04SuccessFee(recoveredAmount: string, policy: Ps04FeePolicyRef): string {
  if (!Number.isInteger(policy.rateBasisPoints) || policy.rateBasisPoints < 0 || policy.rateBasisPoints > 10000) {
    throw new Ps04FlowError('INVALID', 'rateBasisPoints 非法');
  }
  const recovered = toScaled(recoveredAmount);
  if (recovered <= 0n) return '0.000000';
  return formatScaled((recovered * BigInt(policy.rateBasisPoints)) / 10000n);
}

/**
 * start recovery：只做 server-side 校验 + 记录人工递交事实；不调用任何 PSP。
 */
export async function startIndependentSiteRecovery(
  input: Ps04StartRecoveryInput,
  port: Ps04RecoveryFlowPort,
): Promise<Ps04RecoveryStartDecision> {
  const reasons: Ps04FlowReason[] = [];
  if (input.packageStatus !== 'READY') reasons.push('PACKAGE_NOT_READY');
  if (!(input.qualificationStatus === 'QUALIFIED' || input.qualificationStatus === 'CONDITIONAL')) {
    reasons.push('QUALIFICATION_NOT_PASSED');
  }
  if (!input.actorCapabilities.includes(input.requiredCapability)) reasons.push('MISSING_CAPABILITY');

  if (reasons.includes('MISSING_CAPABILITY')) throw new Ps04FlowError('FORBIDDEN', '缺少所需能力：' + input.requiredCapability);
  if (reasons.length > 0) {
    return {
      started: false,
      reasonCodes: reasons,
      handoffFact: null,
      replay: false,
      externalWritePerformed: false,
      transportEnabled: false,
      paymentCollected: false,
    };
  }

  const fact: Ps04HandoffFact = {
    organizationId: input.organizationId,
    disputeReference: input.disputeReference,
    packageId: input.packageId,
    packageDigest: input.packageDigest,
    channel: input.channel,
    handoffReference: input.handoffReference,
    attestedByActorId: input.attestedByActorId,
    executionKey: input.executionKey,
    recordedAt: input.now,
  };
  const result = await port.appendHandoff(fact);
  if (!result.appended && result.existing) {
    if (result.existing.executionKey !== fact.executionKey) {
      throw new Ps04FlowError('CONFLICT', '同一 dispute 已存在不同 executionKey 的递交事实');
    }
    return {
      started: true,
      reasonCodes: ['HANDOFF_ALREADY_RECORDED'],
      handoffFact: result.existing,
      replay: true,
      externalWritePerformed: false,
      transportEnabled: false,
      paymentCollected: false,
    };
  }
  return {
    started: true,
    reasonCodes: ['OK'],
    handoffFact: fact,
    replay: false,
    externalWritePerformed: false,
    transportEnabled: false,
    paymentCollected: false,
  };
}

export interface Ps04RecoveryConsolidationInput {
  organizationId: string;
  disputeReference: string;
  currency: string;
  disputeAmount: string;
  handoff: Ps04HandoffFact | null;
  response: Ps04ResponseFact | null;
  settlement: Ps04SettlementFact | null;
  feePolicy: Ps04FeePolicyRef;
  expectedPackageDigest: string | null;
  now: string;
}

export interface Ps04RecoveryConsolidation {
  organizationId: string;
  disputeReference: string;
  currency: string;
  reasonCodes: readonly Ps04FlowReason[];
  /** 五个状态互相独立：submitted ≠ won ≠ settled ≠ recovered ≠ billable。 */
  submitted: boolean;
  won: boolean;
  settled: boolean;
  recovered: boolean;
  billable: boolean;
  disputeAmount: string;
  recoveredAmount: string;
  feeAmount: string;
  feePolicyId: string;
  feePolicyVersion: string;
  ledgerEntry: { recoveredAmount: string; currency: string; source: 'PSP_SETTLEMENT_VERIFIED' } | null;
  invoiceDraft: { amount: string; currency: string; basis: 'VERIFIED_ACTUAL_INCREMENTAL_RECOVERY' } | null;
  readonly externalWritePerformed: false;
  readonly transportEnabled: false;
  readonly paymentCollected: false;
  readonly autoSubmitAllowed: false;
  computedAt: string;
}

/**
 * 归一化收敛：把「递交 / 响应 / 结算」三类事实投影成可计费性判定（只读、确定性）。
 */
export function consolidateIndependentSiteRecovery(input: Ps04RecoveryConsolidationInput): Ps04RecoveryConsolidation {
  const reasons: Ps04FlowReason[] = [];
  const disputeAmount = ps04Decimal6(input.disputeAmount);

  if (input.handoff && input.expectedPackageDigest !== null && input.handoff.packageDigest !== input.expectedPackageDigest) {
    reasons.push('DIGEST_MISMATCH');
  }
  if (input.response && input.response.currency !== input.currency) reasons.push('CURRENCY_MISMATCH');
  if (input.settlement && input.settlement.currency !== input.currency) reasons.push('CURRENCY_MISMATCH');

  const submitted = input.handoff !== null;
  if (!submitted) reasons.push('HANDOFF_NOT_RECORDED');

  const won = input.response !== null && (input.response.disposition === 'WON' || input.response.disposition === 'PARTIAL');
  const settled = input.settlement !== null && input.settlement.verification === 'VERIFIED';
  if (input.settlement !== null && input.settlement.verification !== 'VERIFIED') reasons.push('SETTLEMENT_NOT_VERIFIED');

  const recoveredAmount = settled && input.settlement ? ps04Decimal6(input.settlement.amount) : '0.000000';
  const recovered = settled && toScaled(recoveredAmount) > 0n;
  if (settled && !won) reasons.push('RESPONSE_NOT_WON');

  // 计费前提：已递交 + 已胜诉 + 已**验证**到账 + 金额为正。approved/won 本身绝不计费。
  const billable = submitted && won && settled && recovered && !reasons.includes('DIGEST_MISMATCH') && !reasons.includes('CURRENCY_MISMATCH');
  const feeAmount = billable ? computePs04SuccessFee(recoveredAmount, input.feePolicy) : '0.000000';

  return {
    organizationId: input.organizationId,
    disputeReference: input.disputeReference,
    currency: input.currency,
    reasonCodes: reasons.length > 0 ? reasons : ['OK'],
    submitted,
    won,
    settled,
    recovered,
    billable,
    disputeAmount,
    recoveredAmount,
    feeAmount,
    feePolicyId: input.feePolicy.policyId,
    feePolicyVersion: input.feePolicy.policyVersion,
    ledgerEntry: recovered ? { recoveredAmount, currency: input.currency, source: 'PSP_SETTLEMENT_VERIFIED' } : null,
    invoiceDraft: billable
      ? { amount: feeAmount, currency: input.currency, basis: 'VERIFIED_ACTUAL_INCREMENTAL_RECOVERY' }
      : null,
    externalWritePerformed: false,
    transportEnabled: false,
    paymentCollected: false,
    autoSubmitAllowed: false,
    computedAt: input.now,
  };
}

/** 账本一致性自检（供测试与运行期断言复用）。 */
export function assertIndependentSiteLedgerConsistency(result: Ps04RecoveryConsolidation): void {
  if (result.billable && !result.recovered) throw new Ps04FlowError('INVALID', 'billable 必须蕴含 recovered');
  if (result.billable && !result.settled) throw new Ps04FlowError('INVALID', 'billable 必须蕴含 settled');
  if (result.billable && !result.won) throw new Ps04FlowError('INVALID', 'billable 必须蕴含 won');
  if (result.billable && !result.submitted) throw new Ps04FlowError('INVALID', 'billable 必须蕴含 submitted');
  if (result.won && !result.submitted) throw new Ps04FlowError('INVALID', 'won 必须蕴含 submitted');
  if (result.settled && !result.submitted) throw new Ps04FlowError('INVALID', 'settled 必须蕴含 submitted');
  if (!result.billable && result.invoiceDraft !== null) throw new Ps04FlowError('INVALID', '不可计费时不得产生 invoiceDraft');
  if (result.billable && result.ledgerEntry === null) throw new Ps04FlowError('INVALID', '可计费必须有 ledgerEntry');
  if (result.recoveredAmount !== '0.000000' && !result.settled) throw new Ps04FlowError('INVALID', '未验证结算不得产生 recoveredAmount');
}

/** 服务级 HTTP 映射（真实路由接线见 BG-020 后的批次）。 */
export function toPs04HttpStatus(error: unknown): number {
  if (error instanceof Ps04FlowError) {
    if (error.code === 'FORBIDDEN') return 403;
    if (error.code === 'NOT_FOUND') return 404;
    if (error.code === 'CONFLICT') return 409;
  }
  return 400;
}

export const PS04_FLOW_BOUNDARY = {
  externalPspCall: false,
  disputeSubmitImplemented: false,
  productionCredentials: 'ABSENT',
  submittedImpliesWon: false,
  wonImpliesSettled: false,
  settledImpliesRecovered: false,
  wonIsFeeBasis: false,
  estimatedIsFeeBasis: false,
  approvedIsPaid: false,
  feeOnlyOnVerifiedActualRecovery: true,
  transportEnabled: false,
  paymentCollected: false,
} as const;
