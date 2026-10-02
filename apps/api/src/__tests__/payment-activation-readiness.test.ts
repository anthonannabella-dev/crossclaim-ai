/**
 * TRACK A / PC-12A — 支付激活就绪投影单元回归（MSG-20261003-102 ⑮–⑯）。
 * 断言：默认全 HOLD/OFF；单一 env flag 不解锁；多 gate 独立；fee due ≠ collected；无 secret。
 */

import { describe, expect, it } from 'vitest';

import {
  REVERSAL_POLICY_DOCUMENT,
  defaultPaymentActivationFacts,
  projectPaymentActivationReadiness,
} from '../services/payments/activation-readiness';

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
  collectionExplicitlyEnabled: true,
  externalPaymentWriteExplicitlyEnabled: true,
};

describe('PC-12A — payment activation readiness', () => {
  it('默认：payment=ZERO / collection=OFF / autopay=OFF / externalWrite=OFF / r13=HOLD，且 ready=false', () => {
    const result = projectPaymentActivationReadiness(defaultPaymentActivationFacts(), { now: () => NOW });
    expect(result.ready).toBe(false);
    expect(result.posture).toBe('BLOCKED');
    expect(result.status).toEqual({
      payment: 'ZERO',
      collection: 'OFF',
      autopay: 'OFF',
      externalWrite: 'OFF',
      r13: 'HOLD',
      paymentProcessingEnabled: false,
    });
    expect(result.blockers).toContain('EXTERNAL:R13_NOT_RELEASED');
  });

  it('单一 env flag（PAYMENTS_ENABLED=true）不解锁：ready 仍 false，collection/autopay/externalWrite 不变', () => {
    const result = projectPaymentActivationReadiness(
      defaultPaymentActivationFacts({ paymentProcessingEnabled: true }),
      { now: () => NOW },
    );
    expect(result.ready).toBe(false);
    expect(result.status.paymentProcessingEnabled).toBe(true);
    expect(result.status.collection).toBe('OFF');
    expect(result.status.autopay).toBe('OFF');
    expect(result.status.externalWrite).toBe('OFF');
    expect(result.blockers).toContain('EXTERNAL:collectionExplicitlyEnabled');
    expect(result.blockers).toContain('EXTERNAL:externalPaymentWriteExplicitlyEnabled');
  });

  it('R13 未释放 / 缺 provider 凭据：即使内部全绿也停在 EXTERNAL_GATE', () => {
    const internalOnly = projectPaymentActivationReadiness(
      { ...allGreen, r13Released: false, providerCredentialsConfigured: false },
      { now: () => NOW },
    );
    expect(internalOnly.internalReady).toBe(true);
    expect(internalOnly.ready).toBe(false);
    expect(internalOnly.posture).toBe('EXTERNAL_GATE');
    expect(internalOnly.blockers).toEqual([
      'EXTERNAL:providerCredentialsConfigured',
      'EXTERNAL:R13_NOT_RELEASED',
    ]);
  });

  it('内部条件缺失 → BLOCKED（外部 gate 齐全也不例外）', () => {
    const blocked = projectPaymentActivationReadiness(
      { ...allGreen, reconciliationReady: false },
      { now: () => NOW },
    );
    expect(blocked.ready).toBe(false);
    expect(blocked.posture).toBe('BLOCKED');
    expect(blocked.blockers).toContain('INTERNAL:reconciliationReady');
  });

  it('「provider 已配置但 collection=OFF」是合法中间态：ready=false、posture=EXTERNAL_GATE', () => {
    const result = projectPaymentActivationReadiness(
      { ...allGreen, collectionExplicitlyEnabled: false },
      { now: () => NOW },
    );
    expect(result.gates.providerCredentials).toBe(true);
    expect(result.gates.collectionExplicitlyEnabled).toBe(false);
    expect(result.ready).toBe(false);
    expect(result.posture).toBe('EXTERNAL_GATE');
    expect(result.blockers).toEqual(['EXTERNAL:collectionExplicitlyEnabled']);
  });

  it('四个 gate 彼此独立：单独打开任一项都不等于全部就绪', () => {
    for (const key of [
      'providerCredentialsConfigured',
      'r13Released',
      'collectionExplicitlyEnabled',
      'externalPaymentWriteExplicitlyEnabled',
    ] as const) {
      const result = projectPaymentActivationReadiness(defaultPaymentActivationFacts({ [key]: true }), {
        now: () => NOW,
      });
      expect(result.ready).toBe(false);
    }
  });

  it('fee due ≠ fee collected；reversal 影响面复用既有 money truth', () => {
    const result = projectPaymentActivationReadiness(allGreen, { now: () => NOW });
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

  it('全绿时 ready=true / posture=READY（仅作为未来目标态断言，当前仓库默认不会达成）', () => {
    const result = projectPaymentActivationReadiness(allGreen, { now: () => NOW });
    expect(result.ready).toBe(true);
    expect(result.posture).toBe('READY');
    expect(result.blockers).toEqual([]);
  });

  it('输出不含任何 secret 取值（只有状态码与 blocker code）', () => {
    const raw = JSON.stringify(projectPaymentActivationReadiness(allGreen, { now: () => NOW }));
    for (const forbidden of ['sk_', 'whsec', 'client_secret', 'password']) {
      expect(raw).not.toContain(forbidden);
    }
  });
});
