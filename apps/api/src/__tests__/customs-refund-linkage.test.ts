/**
 * C19 trusted ingest + C20 refund→settlement 契约层验收（HOST DIRECTIVE §3；MSG-20261003-123 ⑧）。
 * 断言：可信 ingest 只接受 provider/authority 来源且带 reference、时间合法、幂等；
 *       refund→fee 只在 verified receipt + 服务端 15% 策略下成立，其它一律 fail-closed。
 */

import { describe, expect, it } from 'vitest';

import { ingestCustomsFilingStatus, type CustomsFilingStatusIngestStore } from '../services/customs/customs-filing-status-ingest';
import type { CustomsFilingStatusFact } from '../services/customs/customs-filing-status';
import { CUSTOMS_REFUND_LINKAGE_BOUNDARY, evaluateCustomsRefundFeeTrigger } from '../services/customs/customs-refund-settlement-linkage';
import { resolveFeePolicy } from '../services/commercial/fee-policy';

const ORG = 'ccf10000-0000-4000-8000-000000000001';
const OPP = 'opp-customs-refund-1';
const NOW = new Date('2026-10-03T09:00:00.000Z');
const POLICY = resolveFeePolicy('CUSTOMS_SUCCESS_15', '2026-10-03');

function memoryStore(): CustomsFilingStatusIngestStore & { rows: CustomsFilingStatusFact[] } {
  const rows: CustomsFilingStatusFact[] = [];
  return {
    rows,
    async append(fact) {
      const existing = rows.find((r) => r.factId === fact.factId);
      if (existing) return { created: false, fact: existing };
      rows.push(fact);
      return { created: true, fact };
    },
  };
}

const BASE_INGEST = {
  source: 'AUTHORITY_VERIFIED' as string,
  adapterId: 'customs-authority-adapter',
  payload: {
    organizationId: ORG,
    opportunityId: OPP,
    status: 'ACCEPTED' as const,
    providerReference: 'AUTH-REF-1' as string | null,
    observedAt: '2026-10-03T08:00:00.000Z',
    idempotencyKey: 'webhook-1',
  },
  recordedAt: '2026-10-03T08:00:01.000Z',
};

function ingestInput(overrides: Partial<typeof BASE_INGEST> = {}) {
  return { ...BASE_INGEST, ...overrides };
}

describe('C19 trusted ingest port', () => {
  it('authority/provider 来源 + reference + 合法时间 → RECORDED（sourceLevel 由 adapter 固定）', async () => {
    const store = memoryStore();
    const res = await ingestCustomsFilingStatus(ingestInput(), { store, now: () => NOW });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.status).toBe('RECORDED');
    expect(res.fact.sourceLevel).toBe('AUTHORITY_VERIFIED');
    expect(res.fact.status).toBe('ACCEPTED');
    expect(res.fact.derivesRecoveredCash).toBe(false);
    expect(store.rows).toHaveLength(1);
  });

  it('未知来源（含 USER_REPORTED）→ UNKNOWN_SOURCE，零事实（人工路径不得走可信 ingest）', async () => {
    const store = memoryStore();
    const userReported = await ingestCustomsFilingStatus(ingestInput({ source: 'USER_REPORTED' }), { store, now: () => NOW });
    expect(userReported.ok).toBe(false);
    if (!userReported.ok) expect(userReported.reason).toBe('UNKNOWN_SOURCE');
    const bogus = await ingestCustomsFilingStatus(ingestInput({ source: 'SOMETHING_ELSE' }), { store, now: () => NOW });
    expect(bogus.ok).toBe(false);
    expect(store.rows).toHaveLength(0);
  });

  it('缺 providerReference / 非法时间 / 未来时间 → 稳定失败码', async () => {
    const store = memoryStore();
    const noRef = await ingestCustomsFilingStatus(
      ingestInput({ payload: { ...BASE_INGEST.payload, providerReference: null } }),
      { store, now: () => NOW },
    );
    expect(noRef.ok).toBe(false);
    if (!noRef.ok) expect(noRef.reason).toBe('MISSING_PROVIDER_REFERENCE');
    const badTime = await ingestCustomsFilingStatus(
      ingestInput({ payload: { ...BASE_INGEST.payload, observedAt: 'not-a-date' } }),
      { store, now: () => NOW },
    );
    expect(badTime.ok).toBe(false);
    if (!badTime.ok) expect(badTime.reason).toBe('INVALID_TIMESTAMP');
    const future = await ingestCustomsFilingStatus(
      ingestInput({ payload: { ...BASE_INGEST.payload, observedAt: '2026-10-05T00:00:00.000Z' } }),
      { store, now: () => NOW },
    );
    expect(future.ok).toBe(false);
    if (!future.ok) expect(future.reason).toBe('FUTURE_TIMESTAMP');
  });

  it('幂等：同一 idempotencyKey 重复投递 → ALREADY_RECORDED，事实仍一条', async () => {
    const store = memoryStore();
    const first = await ingestCustomsFilingStatus(ingestInput(), { store, now: () => NOW });
    const second = await ingestCustomsFilingStatus(ingestInput(), { store, now: () => NOW });
    if (!first.ok || !second.ok) throw new Error('expected ok');
    expect(first.status).toBe('RECORDED');
    expect(second.status).toBe('ALREADY_RECORDED');
    expect(store.rows).toHaveLength(1);
  });
});

describe('C20 refund → settlement → 15% fee', () => {
  const verifiedReceipt = {
    settlementId: 'stl-customs-1',
    verifiedAmount: '18620.00',
    currency: 'USD',
    confirmationStatus: 'CONFIRMED' as const,
    reconciliationStatus: 'RECONCILED' as const,
    evidenceSourceLevel: 'AUTHORITY_VERIFIED' as const,
  };

  it('USER_REPORTED refund evidence → REFUND_EVIDENCE_UNVERIFIED（fail-closed）', () => {
    const decision = evaluateCustomsRefundFeeTrigger({
      refundEvidence: { opportunityId: OPP, providerReference: 'X', sourceLevel: 'USER_REPORTED', amount: '18620.00', currency: 'USD' },
      verifiedReceipt,
      policy: POLICY,
    });
    expect(decision.billable).toBe(false);
    if (!decision.billable) expect(decision.reasonCode).toBe('REFUND_EVIDENCE_UNVERIFIED');
  });

  it('无 verified receipt → NO_VERIFIED_RECEIPT', () => {
    const decision = evaluateCustomsRefundFeeTrigger({
      refundEvidence: { opportunityId: OPP, providerReference: 'X', sourceLevel: 'AUTHORITY_VERIFIED', amount: '18620.00', currency: 'USD' },
      verifiedReceipt: null,
      policy: POLICY,
    });
    expect(decision.billable).toBe(false);
    if (!decision.billable) expect(decision.reasonCode).toBe('NO_VERIFIED_RECEIPT');
  });

  it('verified receipt + CUSTOMS_SUCCESS_15 → 15% fee（含 settlement lineage）', () => {
    const decision = evaluateCustomsRefundFeeTrigger({
      refundEvidence: { opportunityId: OPP, providerReference: 'X', sourceLevel: 'AUTHORITY_VERIFIED', amount: '18620.00', currency: 'USD' },
      verifiedReceipt,
      policy: POLICY,
    });
    expect(decision.billable).toBe(true);
    if (!decision.billable) return;
    expect(decision.fee.feeAmount).toBe('2793.00');
    expect(decision.fee.currency).toBe('USD');
    expect(decision.fee.policyId).toBe('CUSTOMS_SUCCESS_15');
    expect(decision.fee.policyVersion).toBe('v1');
    expect(decision.fee.settlementId).toBe('stl-customs-1');
  });

  it('非计费策略（waiver）经 fee guard → FEE_GUARD_REJECTED（detail=POLICY_NOT_BILLABLE）', () => {
    const waiver = resolveFeePolicy('CUSTOMS_VIP_WAIVER', '2026-10-03');
    const decision = evaluateCustomsRefundFeeTrigger({
      refundEvidence: { opportunityId: OPP, providerReference: 'X', sourceLevel: 'AUTHORITY_VERIFIED', amount: '18620.00', currency: 'USD' },
      verifiedReceipt,
      policy: waiver,
    });
    expect(decision.billable).toBe(false);
    if (!decision.billable) {
      expect(decision.reasonCode).toBe('FEE_GUARD_REJECTED');
      expect(decision.detail).toBe('POLICY_NOT_BILLABLE');
    }
  });

  it('边界自证：契约层不写 Settlement / 不写 RecoveryPayout / 不扣款', () => {
    expect(CUSTOMS_REFUND_LINKAGE_BOUNDARY.writesSettlement).toBe(false);
    expect(CUSTOMS_REFUND_LINKAGE_BOUNDARY.writesRecoveryPayout).toBe(false);
    expect(CUSTOMS_REFUND_LINKAGE_BOUNDARY.paymentCollectionPerformed).toBe(false);
    expect(CUSTOMS_REFUND_LINKAGE_BOUNDARY.autopayEnabled).toBe(false);
    expect(CUSTOMS_REFUND_LINKAGE_BOUNDARY.externalPaymentWrite).toBe(false);
    expect(CUSTOMS_REFUND_LINKAGE_BOUNDARY.productionCredentials).toBe('ABSENT');
  });
});
