/**
 * R46 S2 —— 服务端 canonical Receipt Snapshot 与 digest
 * ---------------------------------------------------------------
 * 依据：MSG-20261002-53 CHANGE E / MSG-20261002-54 CHANGE B / MSG-20261002-55 CHANGE B。
 *
 * 硬规则（S2 验收）：
 *   1) digest **只能**由本模块（唯一 server-side builder/canonicalizer）计算；
 *      调用方提供的 digest / 派生字段一律不可信 → fail-closed；
 *   2) `snapshotDigest === sha256(canonicalJson(business fields))`，可被等价性测试证明；
 *   3) 参与 digest 的**只有业务字段**：organizationId / claim·case linkage / linkage basis /
 *      external identity（kind + valueHash + version）/ fingerprint（+ version）/ amount（4 位定点）/
 *      currency（canonical 大写）/ receivedAt（UTC）/ sourceKind / evidence 引用（稳定排序）；
 *   4) **不**参与 digest 的元数据：createdByUserId 等非业务审计字段、原始 `externalIdentityValue`
 *      （仅 provenance / display，不进 digest、不做唯一性依据）；
 *   5) 任何可信业务字段变化 → digest 变化；仅元数据变化 → digest 不变。
 *
 * 禁止：本模块不写数据库、不创建 Settlement、不触碰 Fee / Billing / Payment / RecoveryLedger。
 */

import { createHash } from 'node:crypto';

import { canonicalJson } from '../platform-write/snapshot';

export const RECEIPT_SNAPSHOT_VERSION = 'v1';

export const SETTLEMENT_EXTERNAL_IDENTITY_KINDS = [
  'BANK_TRANSACTION',
  'PSP_SETTLEMENT',
  'PLATFORM_SETTLEMENT_REPORT',
  'CARRIER_SETTLEMENT',
  'INSURER_PAYOUT',
  'CHECK_REFERENCE',
  'MANUAL_DOCUMENT',
  'OTHER',
] as const;
export type SettlementExternalIdentityKind = (typeof SETTLEMENT_EXTERNAL_IDENTITY_KINDS)[number];

export const SETTLEMENT_LINKAGE_BASIS_KINDS = [
  'CLAIM_ITEM_DIRECT',
  'CASE_LEVEL_ALLOCATION',
  'MANUAL_BASIS',
] as const;
export type SettlementLinkageBasisKind = (typeof SETTLEMENT_LINKAGE_BASIS_KINDS)[number];

export const SETTLEMENT_RECEIPT_SOURCE_KINDS = [
  'OFFICIAL_API',
  'PLATFORM_REPORT',
  'BANK_STATEMENT',
  'PSP_SETTLEMENT_REPORT',
  'MANUAL_DOCUMENT',
] as const;
export type SettlementReceiptSourceKind = (typeof SETTLEMENT_RECEIPT_SOURCE_KINDS)[number];

export type ReceiptSnapshotErrorCode =
  | 'INVALID_INPUT'
  | 'MISSING_EXTERNAL_IDENTITY'
  | 'MISSING_LINKAGE_BASIS'
  | 'INVALID_AMOUNT'
  | 'INVALID_CURRENCY'
  | 'INVALID_TIMESTAMP'
  | 'INVALID_EVIDENCE'
  | 'DUPLICATE_EVIDENCE'
  | 'CLIENT_DERIVED_FIELD_NOT_TRUSTED';

export class ReceiptSnapshotError extends Error {
  constructor(
    public readonly code: ReceiptSnapshotErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'ReceiptSnapshotError';
  }
}

export interface ReceiptEvidenceRefInput {
  evidenceArtifactId: string;
  digest: string;
  kind: string;
}

export interface ReceiptSnapshotInput {
  organizationId: string;
  claimItemId?: string | null;
  caseId?: string | null;
  linkageBasisKind: SettlementLinkageBasisKind;
  linkageBasisRef?: string | null;
  externalIdentityKind: SettlementExternalIdentityKind;
  /** 服务端 canonical 化后的外部引用原文；仅 provenance，**不进 digest** */
  externalIdentityValue?: string | null;
  /** sha256(canonicalExternalIdentityValue) —— 参与唯一性与 digest */
  externalIdentityValueHash?: string | null;
  externalIdentityVersion?: string | null;
  financialEventFingerprint?: string | null;
  financialEventFingerprintVersion?: string | null;
  amount: string;
  currency: string;
  receivedAt: string | Date;
  sourceKind: SettlementReceiptSourceKind;
  evidenceReferences: ReceiptEvidenceRefInput[];
  /** 非业务元数据：不参与 digest */
  createdByUserId?: string | null;
  /** 客户端若提供 digest → 一律拒绝（不可信输入） */
  clientSnapshotDigest?: string | null;
}

export interface ReceiptSnapshotBusinessFields {
  snapshotVersion: string;
  organizationId: string;
  claimItemId: string | null;
  caseId: string | null;
  linkageBasisKind: SettlementLinkageBasisKind;
  linkageBasisRef: string | null;
  externalIdentityKind: SettlementExternalIdentityKind;
  externalIdentityValueHash: string | null;
  externalIdentityVersion: string | null;
  financialEventFingerprint: string | null;
  financialEventFingerprintVersion: string | null;
  amount: string;
  currency: string;
  receivedAtUtc: string;
  sourceKind: SettlementReceiptSourceKind;
  evidenceReferences: { evidenceArtifactId: string; digest: string; kind: string }[];
}

export interface ReceiptSnapshotRecord extends ReceiptSnapshotBusinessFields {
  snapshotDigest: string;
  /** provenance / display only —— 不参与 digest */
  externalIdentityValue: string | null;
  createdByUserId: string | null;
}

const HEX64 = /^[0-9a-f]{64}$/;
const AMOUNT = /^\d+(\.\d+)?$/;

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * 4 位定点规范化：`1.5` / `1.500000` → `1.5000`。
 * 允许超出 4 位的**尾随零**（语义等价），但拒绝真正的额外精度（如 `1.00001`）、
 * 负数 / 0 / 非数字。
 */
export function canonicalAmount(raw: string): string {
  const text = String(raw ?? '').trim();
  if (!AMOUNT.test(text)) {
    throw new ReceiptSnapshotError('INVALID_AMOUNT', 'amount must be a positive decimal');
  }
  const [intPart, fracPart = ''] = text.split('.');
  if (fracPart.length > 4 && /[^0]/.test(fracPart.slice(4))) {
    throw new ReceiptSnapshotError('INVALID_AMOUNT', 'amount precision must not exceed 4 dp');
  }
  const scaled = BigInt(intPart) * 10000n + BigInt((fracPart + '0000').slice(0, 4));
  if (scaled <= 0n) {
    throw new ReceiptSnapshotError('INVALID_AMOUNT', 'amount must be > 0');
  }
  const intOut = scaled / 10000n;
  const fracOut = (scaled % 10000n).toString().padStart(4, '0');
  return `${intOut}.${fracOut}`;
}

/** 币种 canonical 化：trim + upper，必须 3 位大写字母（v1 不做任何汇率换算） */
export function canonicalCurrency(raw: string): string {
  const text = String(raw ?? '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(text)) {
    throw new ReceiptSnapshotError('INVALID_CURRENCY', 'currency must be ISO-4217 alpha-3');
  }
  return text;
}

/** 时间 canonical 化：统一 UTC + 毫秒精度（ISO-8601 `Z`） */
export function canonicalReceivedAt(raw: string | Date): string {
  const date = raw instanceof Date ? raw : new Date(String(raw));
  if (Number.isNaN(date.getTime())) {
    throw new ReceiptSnapshotError('INVALID_TIMESTAMP', 'receivedAt must be a valid timestamp');
  }
  return date.toISOString();
}

/**
 * evidence 引用规范化：逐条校验（id 非空 / digest 64hex / kind 非空）+ 去重 + 稳定排序。
 * 排序键 = (evidenceArtifactId, kind, digest) —— 输入顺序变化不影响 digest。
 */
export function canonicalEvidenceRefs(input: ReceiptEvidenceRefInput[]): {
  evidenceArtifactId: string;
  digest: string;
  kind: string;
}[] {
  if (!Array.isArray(input) || input.length < 1) {
    throw new ReceiptSnapshotError('INVALID_EVIDENCE', 'at least one evidence reference is required');
  }
  const seen = new Set<string>();
  const out = input.map((raw) => {
    const evidenceArtifactId = String(raw?.evidenceArtifactId ?? '').trim();
    const digest = String(raw?.digest ?? '').trim().toLowerCase();
    const kind = String(raw?.kind ?? '').trim();
    if (!evidenceArtifactId || !kind || !HEX64.test(digest)) {
      throw new ReceiptSnapshotError('INVALID_EVIDENCE', 'evidence reference is malformed');
    }
    const key = `${evidenceArtifactId}\u0000${kind}`;
    if (seen.has(key)) {
      throw new ReceiptSnapshotError('DUPLICATE_EVIDENCE', 'duplicate evidence reference');
    }
    seen.add(key);
    return { evidenceArtifactId, digest, kind };
  });
  return out.sort((a, b) => {
    if (a.evidenceArtifactId !== b.evidenceArtifactId) return a.evidenceArtifactId < b.evidenceArtifactId ? -1 : 1;
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    if (a.digest !== b.digest) return a.digest < b.digest ? -1 : 1;
    return 0;
  });
}

function requiredId(value: unknown, label: string): string {
  const text = String(value ?? '').trim();
  if (!text) throw new ReceiptSnapshotError('INVALID_INPUT', `${label} is required`);
  return text;
}

/**
 * 业务字段集合（**digest 的唯一输入面**）。
 * 刻意排除：createdByUserId 等元数据、externalIdentityValue（provenance only）。
 */
export function receiptSnapshotBusinessFields(input: ReceiptSnapshotInput): ReceiptSnapshotBusinessFields {
  if (input.clientSnapshotDigest) {
    throw new ReceiptSnapshotError(
      'CLIENT_DERIVED_FIELD_NOT_TRUSTED',
      'client-provided snapshotDigest is not trusted',
    );
  }
  const externalIdentityValueHash = input.externalIdentityValueHash
    ? String(input.externalIdentityValueHash).trim().toLowerCase()
    : null;
  if (externalIdentityValueHash && !HEX64.test(externalIdentityValueHash)) {
    throw new ReceiptSnapshotError('INVALID_INPUT', 'externalIdentityValueHash must be 64hex');
  }
  const fingerprint = input.financialEventFingerprint
    ? String(input.financialEventFingerprint).trim().toLowerCase()
    : null;
  if (fingerprint && !HEX64.test(fingerprint)) {
    throw new ReceiptSnapshotError('INVALID_INPUT', 'financialEventFingerprint must be 64hex');
  }
  if (!externalIdentityValueHash && !fingerprint) {
    throw new ReceiptSnapshotError(
      'MISSING_EXTERNAL_IDENTITY',
      'either externalIdentityValueHash or financialEventFingerprint is required',
    );
  }
  if (!SETTLEMENT_LINKAGE_BASIS_KINDS.includes(input.linkageBasisKind)) {
    throw new ReceiptSnapshotError('MISSING_LINKAGE_BASIS', 'linkageBasisKind is invalid');
  }
  const linkageBasisRef = input.linkageBasisRef ? String(input.linkageBasisRef).trim() : null;
  const claimItemId = input.claimItemId ? String(input.claimItemId).trim() : null;
  const caseId = input.caseId ? String(input.caseId).trim() : null;
  if (input.linkageBasisKind === 'MANUAL_BASIS' && !linkageBasisRef) {
    throw new ReceiptSnapshotError('MISSING_LINKAGE_BASIS', 'MANUAL_BASIS requires linkageBasisRef');
  }
  if (input.linkageBasisKind === 'CLAIM_ITEM_DIRECT' && !claimItemId) {
    throw new ReceiptSnapshotError('MISSING_LINKAGE_BASIS', 'CLAIM_ITEM_DIRECT requires claimItemId');
  }

  return {
    snapshotVersion: RECEIPT_SNAPSHOT_VERSION,
    organizationId: requiredId(input.organizationId, 'organizationId'),
    claimItemId,
    caseId,
    linkageBasisKind: input.linkageBasisKind,
    linkageBasisRef,
    externalIdentityKind: input.externalIdentityKind,
    externalIdentityValueHash,
    externalIdentityVersion: input.externalIdentityVersion
      ? String(input.externalIdentityVersion).trim()
      : null,
    financialEventFingerprint: fingerprint,
    financialEventFingerprintVersion: input.financialEventFingerprintVersion
      ? String(input.financialEventFingerprintVersion).trim()
      : null,
    amount: canonicalAmount(input.amount),
    currency: canonicalCurrency(input.currency),
    receivedAtUtc: canonicalReceivedAt(input.receivedAt),
    sourceKind: input.sourceKind,
    evidenceReferences: canonicalEvidenceRefs(input.evidenceReferences),
  };
}

/** `sha256(canonicalJson(business fields))` —— 唯一合法 digest 计算入口 */
export function computeReceiptSnapshotDigest(input: ReceiptSnapshotInput): string {
  return sha256(canonicalJson(receiptSnapshotBusinessFields(input)));
}

/** 服务端构建完整 snapshot（含 digest）；不写库 */
export function buildReceiptSnapshot(input: ReceiptSnapshotInput): ReceiptSnapshotRecord {
  const fields = receiptSnapshotBusinessFields(input);
  return {
    ...fields,
    snapshotDigest: sha256(canonicalJson(fields)),
    externalIdentityValue: input.externalIdentityValue ? String(input.externalIdentityValue).trim() : null,
    createdByUserId: input.createdByUserId ? String(input.createdByUserId).trim() : null,
  };
}

/** 校验已存 digest 与重算结果一致（用于读路径 / checker） */
export function assertReceiptSnapshotDigest(
  storedDigest: string,
  input: ReceiptSnapshotInput,
): void {
  const expected = computeReceiptSnapshotDigest(input);
  if (String(storedDigest ?? '').trim().toLowerCase() !== expected) {
    throw new ReceiptSnapshotError(
      'CLIENT_DERIVED_FIELD_NOT_TRUSTED',
      'stored snapshotDigest does not match server-side canonical recomputation',
    );
  }
}
