/**
 * BG-019（CHANGE E · MSG-20261003-139/140）— Independent-site **Golden Path Critical-State Read Surface**。
 * ---------------------------------------------------------------
 * 只读读模型：把已持久化的 PS04 事实（handoff root / response / settlement）投影为**五个互相独立**的状态，
 * 供内部验收在 UI 上直接观察：
 *
 *   submitted ≠ won ≠ settled ≠ recovered ≠ billable
 *
 * 硬约束：
 *   · 只读：不重算、不写库、不触发任何外部调用；`recomputedOnRead=false`。
 *   · `WON` 不等到账；`settlement reference exists` 不等于 verified；只有 **VERIFIED 且有 evidence** 的 settlement
 *     才能进入 recovered / fee basis（事实层已由 DB CHECK 保证有 evidence）。
 *   · qualification / evidence / claim-ready 目前**未持久化**（PS04 Phase 1 为进程内链），读模型显式标为
 *     `NOT_PERSISTED`，绝不伪造。
 *   · 与 `chargeback-recovery-flow.ts` 的收敛规则保持一致（同源 `computePs04SuccessFee`）。
 */

import { computePs04SuccessFee, ps04Decimal6, type Ps04FeePolicyRef } from './chargeback-recovery-flow';

export const PS04_STATE_READ_ROLES = ['OWNER', 'ADMIN', 'OPS', 'FINANCE'] as const;

export interface Ps04HandoffRow {
  id: string;
  disputeReference: string;
  paymentAccountRef: string;
  channel: string;
  handoffReference: string;
  executionKey: string;
  observedAt: string;
}

export interface Ps04ResponseRow {
  id: string;
  disputeReference: string;
  disposition: string;
  amount: string | null;
  currency: string;
  source: string;
  observedAt: string;
}

export interface Ps04SettlementRow {
  id: string;
  disputeReference: string;
  amount: string;
  currency: string;
  verification: string;
  reference: string;
  evidenceArtifactRef: string | null;
  receivedAt: string;
}

export interface Ps04StateReadDeps {
  loadHandoff(organizationId: string, disputeReference: string): Promise<Ps04HandoffRow | null>;
  loadLatestResponse(organizationId: string, disputeReference: string): Promise<Ps04ResponseRow | null>;
  loadLatestSettlement(organizationId: string, disputeReference: string): Promise<Ps04SettlementRow | null>;
}

export interface Ps04StateReadSession {
  organizationId: string;
  actorUserId: string;
  role: string;
}

export interface Ps04StateReadResult {
  status: number;
  body: Record<string, unknown>;
}

const DEFAULT_FEE_POLICY: Ps04FeePolicyRef = { policyId: 'success-fee-2026', policyVersion: '1.0.0', rateBasisPoints: 1500 };

/**
 * GET /independent-site-disputes/:disputeReference/state —— 只读关键状态面。
 */
export async function getIndependentSiteRecoveryState(input: {
  session: Ps04StateReadSession;
  deps: Ps04StateReadDeps;
  disputeReference: string;
  feePolicy?: Ps04FeePolicyRef;
}): Promise<Ps04StateReadResult> {
  const { session, deps } = input;
  if (!(PS04_STATE_READ_ROLES as readonly string[]).includes(session.role)) {
    return { status: 403, body: { error: 'FORBIDDEN', reason: 'ROLE_NOT_PERMITTED' } };
  }
  const disputeReference = String(input.disputeReference ?? '').trim();
  if (disputeReference === '') {
    return { status: 400, body: { error: 'INVALID_REQUEST', reason: 'DISPUTE_REFERENCE_REQUIRED' } };
  }

  const handoff = await deps.loadHandoff(session.organizationId, disputeReference);
  if (!handoff) {
    // 不含 handoff root 的 dispute 不构成已完成启动的内部链；跨租户同样落在这里（不泄漏存在性）。
    return { status: 404, body: { error: 'NOT_FOUND' } };
  }
  const response = await deps.loadLatestResponse(session.organizationId, disputeReference);
  const settlement = await deps.loadLatestSettlement(session.organizationId, disputeReference);
  const feePolicy = input.feePolicy ?? DEFAULT_FEE_POLICY;

  const submitted = true;
  const won = response !== null && (response.disposition === 'WON' || response.disposition === 'PARTIAL');
  const settled = settlement !== null && settlement.verification === 'VERIFIED';
  const recoveredAmount = settled && settlement ? ps04Decimal6(settlement.amount) : '0.000000';
  const recovered = settled && recoveredAmount !== '0.000000' && !recoveredAmount.startsWith('-');
  const billable = submitted && won && settled && recovered;
  const feeAmount = billable ? computePs04SuccessFee(recoveredAmount, feePolicy) : '0.000000';

  return {
    status: 200,
    body: {
      dispute: {
        disputeReference,
        paymentAccountRef: handoff.paymentAccountRef,
        channel: handoff.channel,
        handoffReference: handoff.handoffReference,
        executionKey: handoff.executionKey,
        handoffObservedAt: handoff.observedAt,
      },
      // 五个状态必须分开呈现，UI 不得合并成单一 "Recovered" 标签。
      states: { submitted, won, settled, recovered, billable },
      response:
        response === null
          ? null
          : { disposition: response.disposition, amount: response.amount, currency: response.currency, source: response.source, observedAt: response.observedAt },
      settlement:
        settlement === null
          ? null
          : {
              amount: ps04Decimal6(settlement.amount),
              currency: settlement.currency,
              verification: settlement.verification,
              reference: settlement.reference,
              evidenceArtifactRef: settlement.evidenceArtifactRef,
              receivedAt: settlement.receivedAt,
            },
      amounts: { recoveredAmount, feeAmount, currency: settlement?.currency ?? response?.currency ?? null },
      invoiceDraft: billable ? { amount: feeAmount, currency: settlement?.currency ?? null, basis: 'VERIFIED_ACTUAL_INCREMENTAL_RECOVERY' } : null,
      // 明确未持久化的上游环节，避免 UI 误以为已具备。
      notPersisted: ['QUALIFICATION', 'EVIDENCE_PACKAGE', 'CLAIM_READY_PACKAGE'],
      boundary: {
        readOnly: true,
        recomputedOnRead: false,
        externalWritePerformed: false,
        filingSubmitted: false,
        transportEnabled: false,
        paymentCollected: false,
        productionCredentials: 'ABSENT',
      },
    },
  };
}

export const PS04_STATE_READ_BOUNDARY = {
  readOnly: true,
  recomputedOnRead: false,
  wonIsFeeBasis: false,
  settlementReferenceAloneIsNotVerified: true,
  statesKeptSeparate: ['submitted', 'won', 'settled', 'recovered', 'billable'],
  productionCredentials: 'ABSENT',
} as const;
