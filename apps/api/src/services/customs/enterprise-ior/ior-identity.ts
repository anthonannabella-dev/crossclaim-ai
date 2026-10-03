/**
 * ENTERPRISE IOR RECOVERY LAYER — ① IOR / CLAIMANT IDENTITY（server-side verified identity，只读契约）。
 * ---------------------------------------------------------------
 *  · 复用现有 importerOfRecordRef，不删除、不重做。
 *  · 禁止客户端自报 IOR truth；身份必须由 server-side 校验来源（verificationSource）支撑。
 *  · 禁止裸存 EIN / Importer Number / 银行账号 / credential；敏感值只能是 encrypted/tokenized reference。
 */

export const IOR_PRINCIPAL_TYPES = ['IMPORTER_OF_RECORD', 'DRAWBACK_CLAIMANT'] as const;
export type IorPrincipalType = (typeof IOR_PRINCIPAL_TYPES)[number];

export const IOR_VERIFICATION_STATUSES = ['UNVERIFIED', 'PENDING', 'VERIFIED', 'REVOKED', 'UNKNOWN'] as const;
export type IorVerificationStatus = (typeof IOR_VERIFICATION_STATUSES)[number];

export const IOR_VERIFICATION_SOURCES = ['BROKER_ATTESTATION', 'ACE_LOOKUP', 'CUSTOMER_DOCUMENT', 'MANUAL_REVIEW', 'NONE'] as const;
export type IorVerificationSource = (typeof IOR_VERIFICATION_SOURCES)[number];

export const IOR_IDENTITY_REASONS = [
  'OK',
  'CLIENT_REPORTED_TRUTH_NOT_ALLOWED',
  'RAW_SENSITIVE_VALUE_NOT_ALLOWED',
  'MISSING_LEGAL_ENTITY_REF',
  'UNVERIFIED_IDENTITY',
  'REVOKED_IDENTITY',
  'OUT_OF_EFFECTIVE_WINDOW',
] as const;
export type IorIdentityReason = (typeof IOR_IDENTITY_REASONS)[number];

export class IorContractError extends Error {
  readonly code: 'INVALID_REQUEST' | 'CLIENT_REPORTED_TRUTH' | 'RAW_SENSITIVE_VALUE';
  constructor(code: 'INVALID_REQUEST' | 'CLIENT_REPORTED_TRUTH' | 'RAW_SENSITIVE_VALUE', detail: string) {
    super(code + ': ' + detail);
    this.name = 'IorContractError';
    this.code = code;
  }
}

export interface IorIdentityInput {
  organizationId: string;
  jurisdiction: string;
  principalType: string;
  importerOfRecordRef: string;
  legalEntityRef: string;
  aceAccountRef: string | null;
  verificationStatus: string;
  verificationSource: string;
  verifiedAt: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
}

export interface IorIdentity extends IorIdentityInput {
  principalType: IorPrincipalType;
  verificationStatus: IorVerificationStatus;
  verificationSource: IorVerificationSource;
  readonly clientReportedTruthAccepted: false;
  readonly rawSensitiveValuesStored: false;
  readonly readOnly: true;
}

const RAW_SENSITIVE_PATTERNS = [
  /^\d{2}-\d{7}$/, // EIN 形状
  /^\d{7,9}$/, // importer number 形状
];
const RAW_SENSITIVE_KEYS = ['ein', 'importernumber', 'bankaccount', 'routingnumber', 'iban', 'credential', 'password', 'apikey', 'token'];

function fail(code: 'INVALID_REQUEST' | 'CLIENT_REPORTED_TRUTH' | 'RAW_SENSITIVE_VALUE', detail: string): never {
  throw new IorContractError(code, detail);
}

function scanRawSensitive(value: unknown, depth = 0): void {
  if (depth > 4 || value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalised = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (RAW_SENSITIVE_KEYS.includes(normalised)) fail('RAW_SENSITIVE_VALUE', '禁止裸存敏感字段：' + key);
    if (typeof child === 'string' && RAW_SENSITIVE_PATTERNS.some((pattern) => pattern.test(child.trim()))) {
      fail('RAW_SENSITIVE_VALUE', '禁止裸存敏感值（' + key + '）');
    }
    scanRawSensitive(child, depth + 1);
  }
}

/**
 * 归一化 IOR 身份（fail-closed）。客户端自报的 verified 状态一律拒绝。
 */
export function normalizeIorIdentity(input: IorIdentityInput, options: { clientReported?: boolean } = {}): IorIdentity {
  if (options.clientReported === true) fail('CLIENT_REPORTED_TRUTH', '客户端不得自报 IOR truth');
  scanRawSensitive(input);
  for (const field of ['organizationId', 'jurisdiction', 'importerOfRecordRef'] as const) {
    if (typeof input[field] !== 'string' || input[field].trim() === '') fail('INVALID_REQUEST', field + ' 必填');
  }
  const principalType = String(input.principalType ?? '').toUpperCase();
  if (!(IOR_PRINCIPAL_TYPES as readonly string[]).includes(principalType)) fail('INVALID_REQUEST', 'principalType 非法');
  const verificationStatus = String(input.verificationStatus ?? '').toUpperCase();
  if (!(IOR_VERIFICATION_STATUSES as readonly string[]).includes(verificationStatus)) fail('INVALID_REQUEST', 'verificationStatus 非法');
  const verificationSource = String(input.verificationSource ?? '').toUpperCase();
  if (!(IOR_VERIFICATION_SOURCES as readonly string[]).includes(verificationSource)) fail('INVALID_REQUEST', 'verificationSource 非法');

  return {
    ...input,
    principalType: principalType as IorPrincipalType,
    verificationStatus: verificationStatus as IorVerificationStatus,
    verificationSource: verificationSource as IorVerificationSource,
    clientReportedTruthAccepted: false,
    rawSensitiveValuesStored: false,
    readOnly: true,
  };
}

/** 身份可用性判定（不给阻塞细节以外的东西；fail-closed）。 */
export function evaluateIorIdentity(identity: IorIdentity, now: string): { usable: boolean; reasonCodes: readonly IorIdentityReason[] } {
  const reasons: IorIdentityReason[] = [];
  if (!identity.legalEntityRef) reasons.push('MISSING_LEGAL_ENTITY_REF');
  if (identity.verificationStatus === 'UNVERIFIED' || identity.verificationStatus === 'PENDING' || identity.verificationStatus === 'UNKNOWN') {
    reasons.push('UNVERIFIED_IDENTITY');
  }
  if (identity.verificationStatus === 'REVOKED') reasons.push('REVOKED_IDENTITY');
  if (identity.effectiveTo !== null && Date.parse(identity.effectiveTo) < Date.parse(now)) reasons.push('OUT_OF_EFFECTIVE_WINDOW');
  if (identity.effectiveFrom !== null && Date.parse(identity.effectiveFrom) > Date.parse(now)) reasons.push('OUT_OF_EFFECTIVE_WINDOW');
  return { usable: reasons.length === 0, reasonCodes: reasons.length > 0 ? reasons : ['OK'] };
}

export const IOR_IDENTITY_BOUNDARY = {
  clientReportedTruthAccepted: false,
  rawSensitiveValuesStored: false,
  readOnly: true,
  productionCredentials: 'ABSENT',
} as const;
