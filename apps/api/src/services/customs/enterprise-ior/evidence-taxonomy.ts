/**
 * ENTERPRISE IOR RECOVERY LAYER — ⑤ EVIDENCE TAXONOMY（正式证据类型 + safe-reference/digest）。
 */

export const CUSTOMS_EVIDENCE_KINDS = [
  'CBP_7501',
  'CBP_28',
  'CBP_29',
  'ACE_ENTRY_RECORD',
  'BROKER_ENTRY_RECORD',
  'DUTY_PAYMENT_RECORD',
  'RETURN_RECORD',
  'EXPORT_RECORD',
  'DESTRUCTION_RECORD',
  'RULING_REFERENCE',
  'EXCLUSION_REFERENCE',
  'POA_REFERENCE',
  'REFUND_EVIDENCE',
] as const;
export type CustomsEvidenceKind = (typeof CUSTOMS_EVIDENCE_KINDS)[number];

export interface CustomsEvidenceReferenceInput {
  kind: string;
  reference: string;
  digest: string | null;
  observedAt: string | null;
}

export interface CustomsEvidenceReference {
  kind: CustomsEvidenceKind;
  reference: string;
  digest: string | null;
  observedAt: string | null;
}

export const EVIDENCE_TAXONOMY_REASONS = ['OK', 'UNKNOWN_EVIDENCE_KIND', 'UNSAFE_REFERENCE', 'INVALID_DIGEST'] as const;
export type EvidenceTaxonomyReason = (typeof EVIDENCE_TAXONOMY_REASONS)[number];

const SAFE_REFERENCE_PATTERN = /^[A-Za-z0-9._:@#/-]{1,96}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

export class CustomsEvidenceTaxonomyError extends Error {
  readonly code: EvidenceTaxonomyReason;
  constructor(code: EvidenceTaxonomyReason, detail: string) {
    super(code + ': ' + detail);
    this.name = 'CustomsEvidenceTaxonomyError';
    this.code = code;
  }
}

export function normalizeEvidenceReference(input: CustomsEvidenceReferenceInput): CustomsEvidenceReference {
  const kind = String(input.kind ?? '').toUpperCase();
  if (!(CUSTOMS_EVIDENCE_KINDS as readonly string[]).includes(kind)) {
    throw new CustomsEvidenceTaxonomyError('UNKNOWN_EVIDENCE_KIND', '未知证据类型：' + kind);
  }
  const reference = String(input.reference ?? '').trim();
  if (!SAFE_REFERENCE_PATTERN.test(reference)) {
    throw new CustomsEvidenceTaxonomyError('UNSAFE_REFERENCE', '证据引用必须是 machine-safe reference（禁止 PII/自由文本）');
  }
  if (input.digest !== null && input.digest !== undefined && !DIGEST_PATTERN.test(String(input.digest))) {
    throw new CustomsEvidenceTaxonomyError('INVALID_DIGEST', 'digest 必须是 hex64');
  }
  return {
    kind: kind as CustomsEvidenceKind,
    reference,
    digest: input.digest ?? null,
    observedAt: input.observedAt ?? null,
  };
}

export const EVIDENCE_TAXONOMY_BOUNDARY = {
  safeReferenceOnly: true,
  digestOptionalButValidated: true,
  rawPiiStored: false,
  productionCredentials: 'ABSENT',
} as const;
