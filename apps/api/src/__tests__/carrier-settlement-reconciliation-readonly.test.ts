/** MSG-20261003-133 Q2① — Carrier→Settlement 只读对账投影回归。 */

import { describe, expect, it } from 'vitest';

import {
  CARRIER_SETTLEMENT_BOUNDARY,
  CarrierSettlementReconciliationError,
  projectCarrierSettlementReconciliation,
} from '../services/settlement/carrier-settlement-reconciliation-readonly';

const ORG = 'org-1';

const outcome = (overrides: Record<string, unknown> = {}) => ({
  organizationId: ORG,
  providerReference: 'carrier-claim-1',
  status: 'APPROVED',
  amount: '1200.00',
  currency: 'USD',
  observedAt: '2026-10-01T00:00:00.000Z',
  ...overrides,
});

const evidence = (overrides: Record<string, unknown> = {}) => ({
  organizationId: ORG,
  kind: 'BANK_STATEMENT',
  amount: '1200.00',
  currency: 'USD',
  reference: 'carrier-claim-1',
  observedAt: '2026-10-02T00:00:00.000Z',
  ...overrides,
});

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return error instanceof CarrierSettlementReconciliationError ? error.code : 'NOT_A_RECON_ERROR';
  }
  return 'NO_ERROR';
};

describe('Carrier→Settlement 只读对账投影', () => {
  it('有结算证据且金额一致 → MATCHED（仍不创建 Settlement 事实、不可计费）', () => {
    const [row] = projectCarrierSettlementReconciliation({ carrierOutcomes: [outcome()], settlementEvidence: [evidence()] });
    expect(row.projectionStatus).toBe('MATCHED');
    expect(row.settledEvidenceAmount).toBe('1200.000000');
    expect(row.createsSettlementFact).toBe(false);
    expect(row.upgradesCarrierTextToReceived).toBe(false);
    expect(row.modifiesMoney).toBe(false);
    expect(row.billable).toBe(false);
  });

  it('APPROVED / PAID 无结算证据 → AWAITING_SETTLEMENT_EVIDENCE（不得视为已到账）', () => {
    for (const status of ['APPROVED', 'PAID'] as const) {
      const [row] = projectCarrierSettlementReconciliation({ carrierOutcomes: [outcome({ status })], settlementEvidence: [] });
      expect(row.projectionStatus).toBe('AWAITING_SETTLEMENT_EVIDENCE');
      expect(row.reasonCodes).toContain('CARRIER_OUTCOME_WITHOUT_SETTLEMENT_EVIDENCE');
      expect(row.settledEvidenceAmount).toBeNull();
    }
  });

  it('金额不一致 → DISCREPANCY；DENIED 无证据 → 不可计费标记', () => {
    const [mismatch] = projectCarrierSettlementReconciliation({
      carrierOutcomes: [outcome()],
      settlementEvidence: [evidence({ amount: '1000.00' })],
    });
    expect(mismatch.projectionStatus).toBe('DISCREPANCY');
    expect(mismatch.reasonCodes).toContain('SETTLEMENT_AMOUNT_MISMATCH');

    const [denied] = projectCarrierSettlementReconciliation({ carrierOutcomes: [outcome({ status: 'DENIED' })], settlementEvidence: [] });
    expect(denied.projectionStatus).toBe('AWAITING_SETTLEMENT_EVIDENCE');
    expect(denied.reasonCodes).toContain('CARRIER_DENIED_NOT_BILLABLE');
  });

  it('币种不一致 → INDETERMINATE（不做 FX）；未知状态 → INDETERMINATE', () => {
    const [currency] = projectCarrierSettlementReconciliation({
      carrierOutcomes: [outcome()],
      settlementEvidence: [evidence({ currency: 'CAD' })],
    });
    expect(currency.projectionStatus).toBe('INDETERMINATE');
    expect(currency.reasonCodes).toContain('CURRENCY_MISMATCH');

    const [unknown] = projectCarrierSettlementReconciliation({ carrierOutcomes: [outcome({ status: 'MAYBE_PAID' })], settlementEvidence: [] });
    expect(unknown.projectionStatus).toBe('INDETERMINATE');
    expect(unknown.reasonCodes).toContain('UNKNOWN_CARRIER_STATUS');
  });

  it('跨租户结算证据 → 拒绝（CROSS_TENANT_LINEAGE）', () => {
    expect(
      codeOf(() =>
        projectCarrierSettlementReconciliation({
          carrierOutcomes: [outcome()],
          settlementEvidence: [evidence({ organizationId: 'org-2' })],
        }),
      ),
    ).toBe('CROSS_TENANT_LINEAGE');
  });

  it('缺少 providerReference lineage → MISSING_REFERENCE_LINEAGE（仍不猜测到账）', () => {
    const [row] = projectCarrierSettlementReconciliation({
      carrierOutcomes: [outcome({ providerReference: '' })],
      settlementEvidence: [],
    });
    expect(row.reasonCodes).toContain('MISSING_REFERENCE_LINEAGE');
    expect(row.projectionStatus).toBe('AWAITING_SETTLEMENT_EVIDENCE');
  });

  it('确定性 + 边界常量：只读、不创建/不改资金、不 FX、不升级为 RECEIVED', () => {
    const input = { carrierOutcomes: [outcome()], settlementEvidence: [evidence()] };
    expect(JSON.stringify(projectCarrierSettlementReconciliation(input))).toBe(JSON.stringify(projectCarrierSettlementReconciliation(input)));
    expect(CARRIER_SETTLEMENT_BOUNDARY.readOnly).toBe(true);
    expect(CARRIER_SETTLEMENT_BOUNDARY.createsSettlementFact).toBe(false);
    expect(CARRIER_SETTLEMENT_BOUNDARY.upgradesCarrierTextToReceived).toBe(false);
    expect(CARRIER_SETTLEMENT_BOUNDARY.modifiesMoney).toBe(false);
    expect(CARRIER_SETTLEMENT_BOUNDARY.requiresSettlementEvidenceForReceived).toBe(true);
  });
});
