/**
 * CHANGE D（MSG-20261003-142）— Phase-1 producer wiring。
 * ---------------------------------------------------------------
 * 正常执行一次 Independent-site Phase 1（`assembleChargebackRecoveryPackage`）后，
 * **自动**把结果写成只读投影（幂等：同一 immutable 结果 → ALREADY_APPENDED；结果变化 → 追加历史）。
 * 这样 `/independent-site-disputes/:ref/state` 在默认 runtime 下能读到 phase1，而不是永远 notPersisted。
 */

import { assembleChargebackRecoveryPackage, type Ps04ClaimReadyEvidencePackage } from './chargeback-recovery-chain';
import type { Ps04Phase1ProjectionStore, Ps04Phase1ProjectionWriteResult } from './ps04-phase1-projection-store';

export interface Ps04Phase1RunInput {
  organizationId: string;
  disputeReference: string;
  disputeFacts: Parameters<typeof assembleChargebackRecoveryPackage>[0]['disputeFacts'];
  evidenceRecords: Parameters<typeof assembleChargebackRecoveryPackage>[0]['evidenceRecords'];
  settlementEvidence?: Parameters<typeof assembleChargebackRecoveryPackage>[0]['settlementEvidence'];
  requiredEvidenceKinds?: readonly string[];
  policyId: string;
  policyVersion: string;
  algorithmVersion: string;
  now?: string;
}

export interface Ps04Phase1RunResult {
  package: Ps04ClaimReadyEvidencePackage;
  projection: Ps04Phase1ProjectionWriteResult;
}

export async function runPs04Phase1(
  input: Ps04Phase1RunInput,
  deps: { store: Ps04Phase1ProjectionStore },
): Promise<Ps04Phase1RunResult> {
  const assembled = assembleChargebackRecoveryPackage({
    organizationId: input.organizationId,
    disputeReference: input.disputeReference,
    disputeFacts: input.disputeFacts,
    evidenceRecords: input.evidenceRecords,
    ...(input.settlementEvidence ? { settlementEvidence: input.settlementEvidence } : {}),
    ...(input.requiredEvidenceKinds ? { requiredEvidenceKinds: input.requiredEvidenceKinds } : {}),
    ...(input.now ? { now: input.now } : {}),
  });

  const qualificationStatus =
    assembled.status === 'READY' ? 'QUALIFIED' : assembled.status === 'INDETERMINATE' ? 'INDETERMINATE' : 'NOT_QUALIFIED';
  const evidenceReadinessStatus = assembled.missingEvidenceKinds.length === 0 ? 'READY' : 'NOT_READY';

  const projection = await deps.store.appendProjection({
    organizationId: input.organizationId,
    disputeReference: input.disputeReference,
    policyId: input.policyId,
    policyVersion: input.policyVersion,
    algorithmVersion: input.algorithmVersion,
    qualificationStatus,
    qualificationReasonCodes: [...assembled.reasonCodes],
    evidenceReadinessStatus,
    evidenceSummary: {
      evidenceKinds: assembled.evidenceManifest.map((item) => item.kind),
      missingEvidenceKinds: [...assembled.missingEvidenceKinds],
      channel: assembled.channel,
    },
    claimReadyStatus: assembled.status,
    packageId: assembled.packageId,
    packageDigest: null,
    computedAt: new Date(input.now ?? new Date().toISOString()),
  });

  return { package: assembled, projection };
}

export const PS04_PHASE1_RUNNER_BOUNDARY = {
  persistsReadOnlyProjection: true,
  idempotent: true,
  externalWritePerformed: false,
  autoSubmitAllowed: false,
  productionCredentials: 'ABSENT',
} as const;
