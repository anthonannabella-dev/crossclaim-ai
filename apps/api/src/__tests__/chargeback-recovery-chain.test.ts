/** BG-010 — PS04 Phase 1 内部只读链回归。 */

import { describe, expect, it } from 'vitest';

import {
  PS04_CHAIN_BOUNDARY,
  Ps04ChainError,
  assembleChargebackRecoveryPackage,
  toReadOnlyQueryView,
} from '../services/independent-site/chargeback-recovery-chain';

const ORG = 'org-1';
const account = { organizationId: ORG, merchantId: 'merchant-1', paymentAccountId: 'pa-1', channel: 'STRIPE' };

const dispute = (overrides: Record<string, unknown> = {}) => ({
  organizationId: ORG,
  account,
  disputeReference: 'dp-1',
  transactionReference: 'tx-1',
  status: 'NEEDS_RESPONSE',
  amount: '250.00',
  currency: 'USD',
  evidenceDueBy: '2026-10-20T00:00:00.000Z',
  reasonCode: 'product_not_received',
  observedAt: '2026-10-03T00:00:00.000Z',
  ...overrides,
});

const evidence = (kind: string, reference = 'ev-' + kind) => ({
  organizationId: ORG,
  disputeReference: 'dp-1',
  kind,
  reference,
  observedAt: '2026-10-03T01:00:00.000Z',
});

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return error instanceof Ps04ChainError ? error.code : 'NOT_A_PS04_ERROR';
  }
  return 'NO_ERROR';
};

const base = (overrides: Record<string, unknown> = {}) => ({
  organizationId: ORG,
  disputeReference: 'dp-1',
  disputeFacts: [dispute()],
  evidenceRecords: [evidence('ORDER_RECORD'), evidence('DELIVERY_PROOF')],
  ...overrides,
});

describe('PS04 Phase 1 — chargeback recovery read-only chain', () => {
  it('证据齐备 + lineage 完整 + 有 deadline → READY，且金额口径分离', () => {
    const pkg = assembleChargebackRecoveryPackage(base() as never);
    expect(pkg.status).toBe('READY');
    expect(pkg.disputeAmount).toBe('250.000000');
    expect(pkg.recoverableAmountEstimate).toBe('250.000000');
    expect(pkg.wonAmount).toBeNull();
    expect(pkg.settledAmount).toBeNull();
    expect(pkg.billableAmount).toBeNull();
    expect(pkg.submissionPerformed).toBe(false);
    expect(pkg.fundsCustody).toBe(false);
    expect(pkg.ownsRecoveredCash).toBe(false);
  });

  it('缺失 / 歧义 lineage → NOT_READY（fail-closed）', () => {
    const missing = assembleChargebackRecoveryPackage(
      base({ disputeFacts: [dispute({ account: { ...account, merchantId: '' } })] }) as never,
    );
    expect(missing.status).toBe('NOT_READY');
    expect(missing.reasonCodes).toContain('MISSING_LINEAGE');

    const ambiguous = assembleChargebackRecoveryPackage(
      base({ disputeFacts: [dispute({ account: { ...account, channel: 'UNKNOWN_PSP' } })] }) as never,
    );
    expect(ambiguous.status).toBe('NOT_READY');
    expect(ambiguous.reasonCodes).toContain('AMBIGUOUS_LINEAGE');
  });

  it('缺 evidence due date / 未知争议状态 → INDETERMINATE', () => {
    const noDeadline = assembleChargebackRecoveryPackage(base({ disputeFacts: [dispute({ evidenceDueBy: null })] }) as never);
    expect(noDeadline.status).toBe('INDETERMINATE');
    expect(noDeadline.reasonCodes).toContain('MISSING_EVIDENCE_DUE_DATE');

    const unknown = assembleChargebackRecoveryPackage(base({ disputeFacts: [dispute({ status: 'MAYBE' })] }) as never);
    expect(unknown.status).toBe('INDETERMINATE');
    expect(unknown.reasonCodes).toContain('UNKNOWN_DISPUTE_STATUS');
  });

  it('证据缺失 → NOT_READY 且列出 missingEvidenceKinds；currency mismatch → NOT_READY', () => {
    const missingEvidence = assembleChargebackRecoveryPackage(base({ evidenceRecords: [evidence('ORDER_RECORD')] }) as never);
    expect(missingEvidence.status).toBe('NOT_READY');
    expect(missingEvidence.missingEvidenceKinds).toEqual(['DELIVERY_PROOF']);

    const currency = assembleChargebackRecoveryPackage(
      base({ settlementEvidence: [{ organizationId: ORG, disputeReference: 'dp-1', amount: '250.00', currency: 'CAD', reference: 'settle-1', observedAt: '2026-10-03T02:00:00.000Z' }] }) as never,
    );
    expect(currency.status).toBe('NOT_READY');
    expect(currency.reasonCodes).toContain('CURRENCY_MISMATCH');
  });

  it('WON + 结算证据 → wonAmount/settledAmount 有值，但 recoverable ≠ billable（billable 恒 null）', () => {
    const pkg = assembleChargebackRecoveryPackage(
      base({
        disputeFacts: [dispute({ status: 'WON' })],
        settlementEvidence: [{ organizationId: ORG, disputeReference: 'dp-1', amount: '250.00', currency: 'USD', reference: 'settle-1', observedAt: '2026-10-03T02:00:00.000Z' }],
      }) as never,
    );
    expect(pkg.status).toBe('READY');
    expect(pkg.wonAmount).toBe('250.000000');
    expect(pkg.settledAmount).toBe('250.000000');
    expect(pkg.billableAmount).toBeNull();
    expect(pkg.recoverableAmountEstimate).not.toBe(pkg.billableAmount);
  });

  it('禁止支付凭据字段（PAN/CVV/PSP secret）→ 拒绝', () => {
    expect(codeOf(() => assembleChargebackRecoveryPackage({ ...base(), pan: '4111111111111111' } as never))).toBe('INVALID_REQUEST');
    expect(codeOf(() => assembleChargebackRecoveryPackage({ ...base(), pspSecret: 'x' } as never))).toBe('INVALID_REQUEST');
    expect(
      codeOf(() =>
        assembleChargebackRecoveryPackage({
          ...base(),
          disputeFacts: [dispute({ account: { ...account, cvv: '123' } })],
        } as never),
      ),
    ).toBe('INVALID_REQUEST');
  });

  it('跨租户证据 / 争议 → 拒绝；争议不存在 → 拒绝', () => {
    expect(
      codeOf(() =>
        assembleChargebackRecoveryPackage({
          ...base(),
          evidenceRecords: [{ ...evidence('ORDER_RECORD'), organizationId: 'org-2' }],
        } as never),
      ),
    ).toBe('CROSS_TENANT_LINEAGE');
    expect(codeOf(() => assembleChargebackRecoveryPackage({ ...base(), disputeReference: 'nope' } as never))).toBe('INVALID_REQUEST');
  });

  it('确定性 + 只读查询视图 + 边界常量', () => {
    const first = assembleChargebackRecoveryPackage(base() as never);
    const second = assembleChargebackRecoveryPackage(base() as never);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    const view = toReadOnlyQueryView(first);
    expect(view.amounts.billableAmount).toBeNull();
    expect(view.boundary.readOnly).toBe(true);
    expect(view.boundary.submissionPerformed).toBe(false);
    expect(view.boundary.fundsTransfer).toBe(false);
    expect(PS04_CHAIN_BOUNDARY.disputeSubmit).toBe(false);
    expect(PS04_CHAIN_BOUNDARY.externalPspCalls).toBe(false);
    expect(PS04_CHAIN_BOUNDARY.billableAmountAlwaysNull).toBe(true);
  });
});
