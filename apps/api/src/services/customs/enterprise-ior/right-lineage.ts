/**
 * ENTERPRISE IOR RECOVERY LAYER — ② RECOVERY RIGHT LINEAGE（evidence-backed / append-only / 可审计）。
 * ---------------------------------------------------------------
 * 必须能证明：Entry → IOR → claimant → recovery right → remedy → filing authorization。
 * IOR ≠ 自动等于所有 remedy 的合法 claimant；任何不明确 → IOR_RIGHTS_UNCLEAR / CLAIMANT_RIGHTS_UNCLEAR → NEEDS_MANUAL / BROKER_REVIEW。
 */

export const RIGHT_LINEAGE_REASONS = [
  'OK',
  'ENTRY_NOT_LINKED',
  'IOR_NOT_VERIFIED',
  'CLAIMANT_NOT_ESTABLISHED',
  'IOR_RIGHTS_UNCLEAR',
  'CLAIMANT_RIGHTS_UNCLEAR',
  'REMEDY_NOT_AUTHORIZED',
  'FILING_AUTHORIZATION_MISSING',
] as const;
export type RightLineageReason = (typeof RIGHT_LINEAGE_REASONS)[number];

export interface RightLineageEvidence {
  kind: 'ENTRY_RECORD' | 'IOR_VERIFICATION' | 'CLAIMANT_ATTESTATION' | 'RECOVERY_RIGHT_DOCUMENT' | 'FILING_AUTHORIZATION';
  reference: string;
  digest: string | null;
}

export interface RightLineageInput {
  organizationId: string;
  entryReference: string;
  importerOfRecordRef: string;
  claimantRef: string;
  remedyRoute: string;
  iorVerified: boolean;
  iorRightsForRemedy: 'CONFIRMED' | 'UNCLEAR' | 'ABSENT';
  claimantRightsForRemedy: 'CONFIRMED' | 'UNCLEAR' | 'ABSENT';
  filingAuthorized: boolean;
  evidence: readonly RightLineageEvidence[];
}

export interface RightLineageResult {
  outcome: 'COMPLETE' | 'NEEDS_MANUAL' | 'BROKER_REVIEW';
  reasonCodes: readonly RightLineageReason[];
  requiredEvidenceKinds: readonly string[];
  readonly autoFilingAllowed: false;
  readonly appendOnly: true;
}

const REQUIRED_EVIDENCE: readonly RightLineageEvidence['kind'][] = [
  'ENTRY_RECORD',
  'IOR_VERIFICATION',
  'CLAIMANT_ATTESTATION',
  'RECOVERY_RIGHT_DOCUMENT',
  'FILING_AUTHORIZATION',
];

/**
 * 评估权利链（fail-closed；不产生 filing 动作）。
 */
export function evaluateRightLineage(input: RightLineageInput): RightLineageResult {
  const reasons: RightLineageReason[] = [];
  const present = new Set(input.evidence.map((item) => item.kind));
  const missing = REQUIRED_EVIDENCE.filter((kind) => !present.has(kind));

  if (!input.entryReference) reasons.push('ENTRY_NOT_LINKED');
  if (!input.iorVerified) reasons.push('IOR_NOT_VERIFIED');
  if (!input.claimantRef) reasons.push('CLAIMANT_NOT_ESTABLISHED');
  if (input.iorRightsForRemedy === 'UNCLEAR') reasons.push('IOR_RIGHTS_UNCLEAR');
  if (input.iorRightsForRemedy === 'ABSENT') reasons.push('REMEDY_NOT_AUTHORIZED');
  if (input.claimantRightsForRemedy === 'UNCLEAR') reasons.push('CLAIMANT_RIGHTS_UNCLEAR');
  if (input.claimantRightsForRemedy === 'ABSENT') reasons.push('REMEDY_NOT_AUTHORIZED');
  if (!input.filingAuthorized) reasons.push('FILING_AUTHORIZATION_MISSING');
  if (missing.length > 0 && !reasons.includes('REMEDY_NOT_AUTHORIZED')) {
    // 证据缺失同样 fail-closed
    if (missing.includes('RECOVERY_RIGHT_DOCUMENT')) reasons.push('IOR_RIGHTS_UNCLEAR');
    if (missing.includes('CLAIMANT_ATTESTATION')) reasons.push('CLAIMANT_RIGHTS_UNCLEAR');
  }

  const manual = reasons.some((reason) => ['IOR_RIGHTS_UNCLEAR', 'CLAIMANT_RIGHTS_UNCLEAR', 'REMEDY_NOT_AUTHORIZED'].includes(reason));
  const outcome: RightLineageResult['outcome'] =
    reasons.length === 0 ? 'COMPLETE' : manual ? 'BROKER_REVIEW' : 'NEEDS_MANUAL';

  return {
    outcome,
    reasonCodes: reasons.length > 0 ? reasons : ['OK'],
    requiredEvidenceKinds: REQUIRED_EVIDENCE,
    autoFilingAllowed: false,
    appendOnly: true,
  };
}

export const RIGHT_LINEAGE_BOUNDARY = {
  autoFilingAllowed: false,
  appendOnly: true,
  iorImpliesClaimant: false,
  unclearRightsRequireReview: true,
  productionCredentials: 'ABSENT',
} as const;
