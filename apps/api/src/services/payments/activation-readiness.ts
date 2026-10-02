/**
 * TRACK A / PC-12A（MSG-20261003-102 ⑬–⑯；FINAL 收口 MSG-20261003-103 CHANGE A/B/D）
 * — Payment Activation Readiness Contract。
 * ---------------------------------------------------------------
 * 语义分层（CHANGE A / D）：
 *   · `currentState`            —— **当前真正是否已开启**（payment / collection / autopay / externalWrite / r13）
 *   · `activationPrerequisites` —— 未来启用所需**前置条件**（provider 凭据 / R13 释放 / collection 批准 / external write 批准）
 *   · `activationReady`         —— 前置条件是否已具备（**不等于**已经开启）
 * 允许并必须能表达「已具备开启条件，但目前尚未开启」：
 *   activationReady = true 且 currentState.payment = ZERO 且 activationState = NOT_ACTIVATED。
 * 纪律：单个 env flag 不解锁；payment / collection / autopay / external write 四态独立；fee due ≠ fee collected；
 * 每项 check 都带 `source`（ENV / DB / CAPABILITY / INJECTED / EXPLICIT_FROZEN_GATE），不得凭空 true / false。
 * 边界：Payment = 0 · collection = OFF · autopay = OFF · external payment write = OFF · R13 HOLD。
 */

import { findPolicy } from '../commercial/policy-registry';
import { projectProviderReadiness } from '../connect/provider-integration-contract';
import { WEBHOOK_PROVIDER_REGISTRY } from '../webhooks/verification';
import { capabilityReady } from './payment-capabilities';

export type FactSource = 'ENV' | 'DB' | 'CAPABILITY' | 'INJECTED' | 'EXPLICIT_FROZEN_GATE';

export interface CheckFact {
  value: boolean;
  source: FactSource;
}

export interface PaymentActivationFacts {
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
  collectionApproved: boolean;
  externalWriteApproved: boolean;
  paymentActivated: boolean;
  collectionActivated: boolean;
  autopayActivated: boolean;
  externalWriteActivated: boolean;
}

export type FactSources = Partial<Record<keyof PaymentActivationFacts, FactSource>>;

export type PaymentActivationPosture = 'READY' | 'BLOCKED' | 'EXTERNAL_GATE';

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

const ACTIVATION_PREREQUISITES = [
  'providerCredentialsConfigured',
  'r13Released',
  'collectionApproved',
  'externalWriteApproved',
] as const satisfies readonly (keyof PaymentActivationFacts)[];

export interface PaymentActivationReadiness {
  activationReady: boolean;
  ready: boolean;
  /**
   * 必须与**当前 payment 状态**一致（PC-12A FINAL-2 / MSG-20261003-104 ⑪⑫）：
   *   !activationReady                                   → PREREQUISITES_NOT_READY
   *   activationReady && !paymentActivated               → PREREQUISITES_READY_NOT_ACTIVATED
   *   activationReady && paymentActivated                → PREREQUISITES_READY_AND_ACTIVATED
   */
  readinessMeaning:
    | 'PREREQUISITES_NOT_READY'
    | 'PREREQUISITES_READY_NOT_ACTIVATED'
    | 'PREREQUISITES_READY_AND_ACTIVATED';
  posture: PaymentActivationPosture;
  internalReady: boolean;
  currentState: {
    payment: 'ZERO' | 'ENABLED';
    collection: 'OFF' | 'ON';
    autopay: 'OFF' | 'ON';
    externalWrite: 'OFF' | 'ON';
    r13: 'HOLD' | 'RELEASED';
  };
  activationState: 'NOT_ACTIVATED' | 'ACTIVATED';
  activationPrerequisites: {
    providerCredentialsConfigured: boolean;
    r13Released: boolean;
    collectionApproved: boolean;
    externalWriteApproved: boolean;
  };
  checks: Record<string, CheckFact>;
  blockers: string[];
  feeDueVsCollected: {
    feeDue: 'DERIVED_FROM_CONFIRMED_SETTLEMENT';
    feeCollected: 'ZERO';
    separated: true;
    recoveredAmountIsNotCollectedFee: true;
  };
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

export const REVERSAL_POLICY_DOCUMENT = 'docs/releases/SUCCESS-FEE-BILLING-REDLINE.md';

function blockersOf(facts: PaymentActivationFacts): string[] {
  const blockers: string[] = [];
  for (const key of INTERNAL_CHECKS) if (!facts[key]) blockers.push('INTERNAL:' + key);
  if (!facts.providerCredentialsConfigured) blockers.push('EXTERNAL:providerCredentialsConfigured');
  if (!facts.r13Released) blockers.push('EXTERNAL:R13_NOT_RELEASED');
  if (!facts.collectionApproved) blockers.push('EXTERNAL:collectionApproved');
  if (!facts.externalWriteApproved) blockers.push('EXTERNAL:externalWriteApproved');
  return blockers;
}

export function projectPaymentActivationReadiness(
  facts: PaymentActivationFacts,
  options: { sources?: FactSources; now?: () => Date } = {},
): PaymentActivationReadiness {
  const sources = options.sources ?? {};
  const internalReady = INTERNAL_CHECKS.every((key) => facts[key]);
  const prerequisitesReady = ACTIVATION_PREREQUISITES.every((key) => facts[key]);
  const activationReady = internalReady && prerequisitesReady;
  const posture: PaymentActivationPosture = activationReady ? 'READY' : internalReady ? 'EXTERNAL_GATE' : 'BLOCKED';
  const checks: Record<string, CheckFact> = {};
  for (const key of [...INTERNAL_CHECKS, ...ACTIVATION_PREREQUISITES, 'paymentProcessingEnabled'] as const) {
    checks[key] = { value: facts[key], source: sources[key] ?? 'CAPABILITY' };
  }
  // PC-12A FINAL-2（MSG-20261003-104 ⑬⑭）：activationState 只由 **paymentActivated** 决定；
  // collection / autopay / externalWrite 是刻意独立的状态，不得反过来证明 payment 已启用。
  const at = (options.now ?? (() => new Date()))();
  return {
    activationReady,
    ready: activationReady,
    readinessMeaning: !activationReady
      ? 'PREREQUISITES_NOT_READY'
      : facts.paymentActivated
        ? 'PREREQUISITES_READY_AND_ACTIVATED'
        : 'PREREQUISITES_READY_NOT_ACTIVATED',
    posture,
    internalReady,
    currentState: {
      payment: facts.paymentActivated ? 'ENABLED' : 'ZERO',
      collection: facts.collectionActivated ? 'ON' : 'OFF',
      autopay: facts.autopayActivated ? 'ON' : 'OFF',
      externalWrite: facts.externalWriteActivated ? 'ON' : 'OFF',
      r13: facts.r13Released ? 'RELEASED' : 'HOLD',
    },
    activationState: facts.paymentActivated ? 'ACTIVATED' : 'NOT_ACTIVATED',
    activationPrerequisites: {
      providerCredentialsConfigured: facts.providerCredentialsConfigured,
      r13Released: facts.r13Released,
      collectionApproved: facts.collectionApproved,
      externalWriteApproved: facts.externalWriteApproved,
    },
    checks,
    blockers: activationReady ? [] : blockersOf(facts),
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

export const DEFAULT_FACT_SOURCES: FactSources = {
  webhookVerificationReady: 'CAPABILITY',
  providerCredentialsConfigured: 'CAPABILITY',
  paymentWebhookSecretConfigured: 'ENV',
  paymentProcessingEnabled: 'ENV',
  billingModelReady: 'CAPABILITY',
  reconciliationReady: 'CAPABILITY',
  retryReplayControlsReady: 'CAPABILITY',
  feePolicyCurrent: 'CAPABILITY',
  commercialAcceptanceReady: 'DB',
  actionGuardReady: 'INJECTED',
  killSwitchReady: 'INJECTED',
  r13Released: 'EXPLICIT_FROZEN_GATE',
  collectionApproved: 'EXPLICIT_FROZEN_GATE',
  externalWriteApproved: 'EXPLICIT_FROZEN_GATE',
};

/** 由既有事实源推导（CHANGE B）：webhook 验签能力 / provider 生产凭据 / 计费 / 对账 / retry·replay / 费用政策。 */
export function deriveWebhookVerificationReady(): boolean {
  return WEBHOOK_PROVIDER_REGISTRY.length > 0;
}

export function deriveProviderCredentialsConfigured(): boolean {
  return projectProviderReadiness().some((view) => view.productionCredentials !== 'ABSENT');
}

export function deriveFeePolicyCurrent(): boolean {
  return findPolicy('refund-and-fee-policy')?.status === 'CURRENT';
}

export function defaultPaymentActivationFacts(
  overrides: Partial<PaymentActivationFacts> = {},
): PaymentActivationFacts {
  return {
    paymentProcessingEnabled: false,
    providerCredentialsConfigured: deriveProviderCredentialsConfigured(),
    webhookVerificationReady: deriveWebhookVerificationReady(),
    paymentWebhookSecretConfigured: false,
    billingModelReady: capabilityReady('billingModel'),
    feePolicyCurrent: deriveFeePolicyCurrent(),
    commercialAcceptanceReady: false,
    reconciliationReady: capabilityReady('reconciliation'),
    retryReplayControlsReady: capabilityReady('retryReplay'),
    actionGuardReady: false,
    killSwitchReady: false,
    r13Released: false,
    collectionApproved: false,
    externalWriteApproved: false,
    paymentActivated: false,
    collectionActivated: false,
    autopayActivated: false,
    externalWriteActivated: false,
    ...overrides,
  };
}
