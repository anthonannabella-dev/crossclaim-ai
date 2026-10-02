/**
 * TRACK A / PC-12A（MSG-20261003-102 ⑬–⑯）— Payment Activation Readiness Contract。
 * ---------------------------------------------------------------
 * 目标：在 **Payment 继续 ZERO / HOLD** 的前提下，回答「如果明天把 payment 打开，是否具备安全启用条件？」
 * 纪律：
 *   · **不能**靠单个 `PAYMENTS_ENABLED=true` 解锁生产收费；activation 需要多个**相互独立**的 gate；
 *   · payment processing / collection / autopay / external write 四个概念**彼此独立**；
 *   · 允许「provider credentials 已配置但 collection=OFF」这种合法中间状态；
 *   · fee due ≠ fee collected（recovered amount 不等于成功费已收）；
 *   · 复用既有 payment / recovery 事实，**不复制新的 money truth**；
 *   · readiness 只返回安全状态码与 blocker，**绝不返回 secret 取值**。
 * 边界：Payment = 0 · collection = OFF · autopay = OFF · external payment write = OFF · R13 HOLD。
 */

/** 13 项独立检查（⑮.2）。 */
export interface PaymentActivationFacts {
  /** 仅表示处理开关（env `PAYMENTS_ENABLED`）；**不是**生产就绪。 */
  paymentProcessingEnabled: boolean;
  providerCredentialsConfigured: boolean;
  webhookVerificationReady: boolean;
  paymentWebhookSecretConfigured: boolean;
  billingModelReady: boolean;
  feePolicyCurrent: boolean;
  commercialAcceptanceReady: boolean;
  reconciliationReady: boolean;
  retryReplayControlsReady: boolean;
  actionGuardReady: boolean;
  killSwitchReady: boolean;
  r13Released: boolean;
  collectionExplicitlyEnabled: boolean;
  externalPaymentWriteExplicitlyEnabled: boolean;
}

export type PaymentActivationPosture = 'READY' | 'BLOCKED' | 'EXTERNAL_GATE';

/** 内部工程条件（缺一即 BLOCKED）。 */
const INTERNAL_CHECKS = [
  'webhookVerificationReady',
  'paymentWebhookSecretConfigured',
  'billingModelReady',
  'feePolicyCurrent',
  'commercialAcceptanceReady',
  'reconciliationReady',
  'retryReplayControlsReady',
  'actionGuardReady',
  'killSwitchReady',
] as const satisfies readonly (keyof PaymentActivationFacts)[];

/** 外部 / 授权条件（⑮.3：多 gate 同时满足；任何一个 env flag 都不能单点解锁）。 */
const EXTERNAL_CHECKS = [
  'providerCredentialsConfigured',
  'r13Released',
  'collectionExplicitlyEnabled',
  'externalPaymentWriteExplicitlyEnabled',
] as const satisfies readonly (keyof PaymentActivationFacts)[];

export interface PaymentActivationReadiness {
  ready: boolean;
  posture: PaymentActivationPosture;
  internalReady: boolean;
  /** 四个彼此独立的对外 gate（不得互相推导）。 */
  gates: {
    providerCredentials: boolean;
    r13Released: boolean;
    collectionExplicitlyEnabled: boolean;
    externalPaymentWriteExplicitlyEnabled: boolean;
  };
  /** 现状（恒为当前冻结值；由 PAYMENT_STATE + 显式 gate 派生）。 */
  status: {
    payment: 'ZERO';
    collection: 'OFF';
    autopay: 'OFF';
    externalWrite: 'OFF';
    r13: 'HOLD';
    paymentProcessingEnabled: boolean;
  };
  checks: Record<string, boolean>;
  blockers: string[];
  /** fee due ≠ fee collected（⑮.7）。 */
  feeDueVsCollected: {
    feeDue: 'DERIVED_FROM_CONFIRMED_SETTLEMENT';
    feeCollected: 'ZERO';
    separated: true;
    recoveredAmountIsNotCollectedFee: true;
  };
  /** reversal 影响面（⑮.8）：复用既有事实，不新建 money truth。 */
  reversalPolicy: {
    documentRef: string;
    affectsFeeDue: true;
    affectsFeeCollected: false;
    affectsInvoiceStatus: true;
    affectsReconciliation: true;
    reusesExistingMoneyTruth: true;
  };
  checkedAt: string;
}

export const REVERSAL_POLICY_DOCUMENT =
  'docs/releases/SUCCESS-FEE-BILLING-REDLINE.md';

function blockersOf(facts: PaymentActivationFacts): string[] {
  const blockers: string[] = [];
  for (const key of INTERNAL_CHECKS) if (!facts[key]) blockers.push('INTERNAL:' + key);
  if (!facts.providerCredentialsConfigured) blockers.push('EXTERNAL:providerCredentialsConfigured');
  if (!facts.r13Released) blockers.push('EXTERNAL:R13_NOT_RELEASED');
  if (!facts.collectionExplicitlyEnabled) blockers.push('EXTERNAL:collectionExplicitlyEnabled');
  if (!facts.externalPaymentWriteExplicitlyEnabled) blockers.push('EXTERNAL:externalPaymentWriteExplicitlyEnabled');
  return blockers;
}

/**
 * 纯投影（可单测）：ready = 内部条件全满足 **且** 四个对外 gate 全满足。
 * `paymentProcessingEnabled=true` 本身**不**改变 ready / collection / autopay / externalWrite（分离原则）。
 */
export function projectPaymentActivationReadiness(
  facts: PaymentActivationFacts,
  deps: { now?: () => Date } = {},
): PaymentActivationReadiness {
  const internalReady = INTERNAL_CHECKS.every((key) => facts[key]);
  const gates = {
    providerCredentials: facts.providerCredentialsConfigured,
    r13Released: facts.r13Released,
    collectionExplicitlyEnabled: facts.collectionExplicitlyEnabled,
    externalPaymentWriteExplicitlyEnabled: facts.externalPaymentWriteExplicitlyEnabled,
  };
  const externalReady = Object.values(gates).every(Boolean);
  const ready = internalReady && externalReady;
  const posture: PaymentActivationPosture = ready ? 'READY' : internalReady ? 'EXTERNAL_GATE' : 'BLOCKED';
  const checks: Record<string, boolean> = {};
  for (const key of INTERNAL_CHECKS) checks[key] = facts[key];
  for (const key of EXTERNAL_CHECKS) checks[key] = facts[key];
  checks.paymentProcessingEnabled = facts.paymentProcessingEnabled;
  const at = (deps.now ?? (() => new Date()))();
  return {
    ready,
    posture,
    internalReady,
    gates,
    status: {
      payment: 'ZERO',
      collection: 'OFF',
      autopay: 'OFF',
      externalWrite: 'OFF',
      r13: 'HOLD',
      paymentProcessingEnabled: facts.paymentProcessingEnabled,
    },
    checks,
    blockers: ready ? [] : blockersOf(facts),
    feeDueVsCollected: {
      feeDue: 'DERIVED_FROM_CONFIRMED_SETTLEMENT',
      feeCollected: 'ZERO',
      separated: true,
      recoveredAmountIsNotCollectedFee: true,
    },
    reversalPolicy: {
      documentRef: REVERSAL_POLICY_DOCUMENT,
      affectsFeeDue: true,
      affectsFeeCollected: false,
      affectsInvoiceStatus: true,
      affectsReconciliation: true,
      reusesExistingMoneyTruth: true,
    },
    checkedAt: at.toISOString(),
  };
}

/** 当前仓库的保守默认（未接真实 provider / 未释放 R13）。 */
export function defaultPaymentActivationFacts(
  overrides: Partial<PaymentActivationFacts> = {},
): PaymentActivationFacts {
  return {
    paymentProcessingEnabled: false,
    providerCredentialsConfigured: false,
    webhookVerificationReady: true,
    paymentWebhookSecretConfigured: false,
    billingModelReady: true,
    feePolicyCurrent: true,
    commercialAcceptanceReady: false,
    reconciliationReady: false,
    retryReplayControlsReady: true,
    actionGuardReady: false,
    killSwitchReady: false,
    r13Released: false,
    collectionExplicitlyEnabled: false,
    externalPaymentWriteExplicitlyEnabled: false,
    ...overrides,
  };
}
