/**
 * TRACK A / PC-12A FINAL — readiness truth wiring 单元回归（MSG-20261003-103 CHANGE A/B/D）。
 * 断言：currentState 与 activationPrerequisites 分离；activationReady ≠ 当前已开启；
 * 单 env flag 不解锁；每项 check 带 source；fee due ≠ collected；无 secret。
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_FACT_SOURCES,
  REVERSAL_POLICY_DOCUMENT,
  defaultPaymentActivationFacts,
  deriveFeePolicyCurrent,
  deriveProviderCredentialsConfigured,
  deriveWebhookVerificationReady,
  projectPaymentActivationReadiness,
} from '../services/payments/activation-readiness';
import { PAYMENT_OPERATION_CAPABILITIES, capabilityReady } from '../services/payments/payment-capabilities';

const NOW = new Date('2026-10-02T00:00:00.000Z');
const allGreen = {
  paymentProcessingEnabled: true,
  providerCredentialsConfigured: true,
  webhookVerificationReady: true,
  paymentWebhookSecretConfigured: true,
  billingModelReady: true,
  feePolicyCurrent: true,
  commercialAcceptanceReady: true,
  reconciliationReady: true,
  retryReplayControlsReady: true,
  actionGuardReady: true,
  killSwitchReady: true,
  r13Released: true,
  collectionApproved: true,
  externalWriteApproved: true,
};
const project = (facts: Parameters<typeof projectPaymentActivationReadiness>[0]) =>
  projectPaymentActivationReadiness(facts, { sources: DEFAULT_FACT_SOURCES, now: () => NOW });

describe('PC-12A FINAL — readiness semantics（CHANGE A / D）', () => {
  it('默认：currentState 全冻结（ZERO/OFF/OFF/OFF/HOLD），activationReady=false，activationState=NOT_ACTIVATED', () => {
    const result = project(defaultPaymentActivationFacts());
    expect(result.activationReady).toBe(false);
    expect(result.ready).toBe(false);
    expect(result.posture).toBe('BLOCKED');
    expect(result.currentState).toEqual({
      payment: 'ZERO',
      collection: 'OFF',
      autopay: 'OFF',
      externalWrite: 'OFF',
      r13: 'HOLD',
    });
    expect(result.activationState).toBe('NOT_ACTIVATED');
    expect(result.readinessMeaning).toBe('PREREQUISITES_NOT_READY');
    expect(result.blockers).toContain('EXTERNAL:R13_NOT_RELEASED');
  });

  it('CHANGE A/D：前置条件齐备但尚未开启 → activationReady=true 且 currentState 仍冻结（不再是矛盾）', () => {
    const result = project({ ...defaultPaymentActivationFacts(), ...allGreen, paymentActivated: false, collectionActivated: false, autopayActivated: false, externalWriteActivated: false });
    expect(result.activationReady).toBe(true);
    expect(result.readinessMeaning).toBe('PREREQUISITES_READY_NOT_ACTIVATED');
    expect(result.activationState).toBe('NOT_ACTIVATED');
    expect(result.currentState.payment).toBe('ZERO');
    expect(result.currentState.collection).toBe('OFF');
    expect(result.currentState.externalWrite).toBe('OFF');
    expect(result.currentState.r13).toBe('RELEASED');
    expect(result.blockers).toEqual([]);
  });

  it('真正开启后 activationState=ACTIVATED（currentState 反映真实开关）', () => {
    const result = project({
      ...defaultPaymentActivationFacts(),
      ...allGreen,
      paymentActivated: true,
      collectionActivated: true,
    });
    expect(result.activationState).toBe('ACTIVATED');
    expect(result.currentState.payment).toBe('ENABLED');
    expect(result.currentState.collection).toBe('ON');
  });

  it('单 env flag（PAYMENTS_ENABLED=true）不解锁，且不影响 currentState', () => {
    const result = project(defaultPaymentActivationFacts({ paymentProcessingEnabled: true }));
    expect(result.activationReady).toBe(false);
    expect(result.checks.paymentProcessingEnabled).toEqual({ value: true, source: 'ENV' });
    expect(result.currentState).toEqual({
      payment: 'ZERO',
      collection: 'OFF',
      autopay: 'OFF',
      externalWrite: 'OFF',
      r13: 'HOLD',
    });
    expect(result.blockers).toContain('EXTERNAL:collectionApproved');
    expect(result.blockers).toContain('EXTERNAL:externalWriteApproved');
  });

  it('R13 未释放 / 缺 provider 凭据：内部全绿也停在 EXTERNAL_GATE', () => {
    const result = project({ ...defaultPaymentActivationFacts(), ...allGreen, r13Released: false, providerCredentialsConfigured: false });
    expect(result.internalReady).toBe(true);
    expect(result.activationReady).toBe(false);
    expect(result.posture).toBe('EXTERNAL_GATE');
    expect(result.blockers).toEqual(['EXTERNAL:providerCredentialsConfigured', 'EXTERNAL:R13_NOT_RELEASED']);
  });

  it('内部条件缺失 → BLOCKED', () => {
    const result = project({ ...defaultPaymentActivationFacts(), ...allGreen, reconciliationReady: false });
    expect(result.posture).toBe('BLOCKED');
    expect(result.blockers).toContain('INTERNAL:reconciliationReady');
  });

  it('「provider 已配置 + collection 未批准」是合法中间态', () => {
    const result = project({ ...defaultPaymentActivationFacts(), ...allGreen, collectionApproved: false });
    expect(result.activationPrerequisites.providerCredentialsConfigured).toBe(true);
    expect(result.activationPrerequisites.collectionApproved).toBe(false);
    expect(result.activationReady).toBe(false);
    expect(result.posture).toBe('EXTERNAL_GATE');
    expect(result.blockers).toEqual(['EXTERNAL:collectionApproved']);
  });

  it('四个前置条件彼此独立：单独打开任一项都不构成 activationReady', () => {
    for (const key of [
      'providerCredentialsConfigured',
      'r13Released',
      'collectionApproved',
      'externalWriteApproved',
    ] as const) {
      const result = project(defaultPaymentActivationFacts({ [key]: true }));
      expect(result.activationReady).toBe(false);
    }
  });
});

describe('PC-12A FINAL — fact provenance（CHANGE B）', () => {
  it('冻结 gate 明确标记 EXPLICIT_FROZEN_GATE（不是「系统不知道状态」）', () => {
    const result = project(defaultPaymentActivationFacts());
    expect(result.checks.r13Released.source).toBe('EXPLICIT_FROZEN_GATE');
    expect(result.checks.collectionApproved.source).toBe('EXPLICIT_FROZEN_GATE');
    expect(result.checks.externalWriteApproved.source).toBe('EXPLICIT_FROZEN_GATE');
    expect(result.checks.actionGuardReady.source).toBe('INJECTED');
    expect(result.checks.killSwitchReady.source).toBe('INJECTED');
    expect(result.checks.commercialAcceptanceReady.source).toBe('DB');
    expect(result.checks.paymentWebhookSecretConfigured.source).toBe('ENV');
  });

  it('既有能力事实源：webhook 验签 / provider 凭据 / 费用政策 / 计费 / retry·replay 均为派生值', () => {
    expect(deriveWebhookVerificationReady()).toBe(true);
    expect(deriveProviderCredentialsConfigured()).toBe(false);
    expect(deriveFeePolicyCurrent()).toBe(true);
    expect(capabilityReady('billingModel')).toBe(true);
    expect(capabilityReady('retryReplay')).toBe(true);
    expect(capabilityReady('reconciliation')).toBe(false);
    expect(PAYMENT_OPERATION_CAPABILITIES.reconciliation.productionVerified).toBe(false);
    const facts = defaultPaymentActivationFacts();
    expect(facts.webhookVerificationReady).toBe(true);
    expect(facts.billingModelReady).toBe(true);
    expect(facts.retryReplayControlsReady).toBe(true);
    expect(facts.feePolicyCurrent).toBe(true);
    expect(facts.reconciliationReady).toBe(false);
  });
});

describe('PC-12A FINAL — money truth', () => {
  it('fee due ≠ fee collected；reversal 复用既有 money truth', () => {
    const result = project(defaultPaymentActivationFacts());
    expect(result.feeDueVsCollected).toEqual({
      feeDue: 'DERIVED_FROM_CONFIRMED_SETTLEMENT',
      feeCollected: 'ZERO',
      separated: true,
      recoveredAmountIsNotCollectedFee: true,
    });
    expect(result.reversalPolicy.documentRef).toBe(REVERSAL_POLICY_DOCUMENT);
    expect(result.reversalPolicy.affectsFeeCollected).toBe(false);
    expect(result.reversalPolicy.reusesExistingMoneyTruth).toBe(true);
  });

  it('输出不含任何 secret 取值', () => {
    const raw = JSON.stringify(project({ ...defaultPaymentActivationFacts(), ...allGreen }));
    for (const forbidden of ['sk_', 'whsec', 'client_secret', 'password']) {
      expect(raw).not.toContain(forbidden);
    }
  });
});
