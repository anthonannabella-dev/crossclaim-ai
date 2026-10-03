/**
 * P0-1（MASTER GAP CLOSURE · BUSINESS SURVIVAL GATE）— Customs Import ↔ Return/Export/Destruction 证据匹配。
 * ---------------------------------------------------------------
 * 目标链：Import Entry Line Evidence + Return/Export/Destruction Fact → 商品/HTS/SKU/数量/币种/辖区/lineage 匹配
 *         → EXACT / PARTIAL / AMBIGUOUS / NO_MATCH → Eligible Quantity / Duty Basis → Claim-Ready Evidence Package。
 *
 * 硬边界（HOST DIRECTIVE 2026-10-03）：
 *   · AMBIGUOUS 绝不自动转 ELIGIBLE（不猜、不默认匹配）；NO_MATCH 不产生可追回数量；
 *   · PARTIAL 只按已证明匹配的部分计算，禁止放大；所有匹配保留 provenance / evidence lineage；
 *   · 跨租户 / 跨账户 lineage 一律拒绝；currency / HTS mismatch 拒绝或 INDETERMINATE；
 *   · 本层**不**做 filing（Production/Transport Gate 仍 HOLD）。
 */

import { createHash } from 'node:crypto';

export const CUSTOMS_RETURN_KINDS = ['RETURN', 'EXPORT', 'DESTRUCTION'] as const;
export type CustomsReturnKind = (typeof CUSTOMS_RETURN_KINDS)[number];

export const CUSTOMS_RETURN_SOURCES = ['BROKER_DOCUMENT', 'VENDOR_FEED', 'ABI_VENDOR', 'USER_UPLOAD'] as const;
export type CustomsReturnSource = (typeof CUSTOMS_RETURN_SOURCES)[number];

export const CUSTOMS_MATCH_STATUSES = ['EXACT', 'PARTIAL', 'AMBIGUOUS', 'NO_MATCH'] as const;
export type CustomsMatchStatus = (typeof CUSTOMS_MATCH_STATUSES)[number];

export const CUSTOMS_MATCH_REASON_CODES = [
  'HTS_MATCH',
  'SKU_MATCH',
  'QUANTITY_COVERED',
  'QUANTITY_PARTIAL',
  'HTS_MISMATCH',
  'SKU_MISMATCH',
  'CURRENCY_MISMATCH',
  'JURISDICTION_MISMATCH',
  'AMBIGUOUS_DUPLICATE_EVIDENCE',
  'NO_RETURN_EVIDENCE',
  'DUPLICATE_FACT_DEDUPED',
] as const;
export type CustomsMatchReasonCode = (typeof CUSTOMS_MATCH_REASON_CODES)[number];

export const CUSTOMS_MATCH_ERROR_CODES = [
  'INVALID_REQUEST',
  'INVALID_RETURN_KIND',
  'INVALID_SOURCE',
  'INVALID_QUANTITY',
  'INVALID_CURRENCY',
  'INVALID_DIGEST',
  'CROSS_TENANT_LINEAGE',
  'CROSS_ACCOUNT_LINEAGE',
  'RAW_PII_NOT_ALLOWED',
  'UNKNOWN_REASON',
] as const;
export type CustomsMatchErrorCode = (typeof CUSTOMS_MATCH_ERROR_CODES)[number];

export class CustomsReturnMatchError extends Error {
  readonly code: CustomsMatchErrorCode;

  constructor(code: CustomsMatchErrorCode, detail: string) {
    super(code + ': ' + detail);
    this.name = 'CustomsReturnMatchError';
    this.code = code;
  }
}

export interface CustomsReturnFactInput {
  organizationId: string;
  platformAccountId: string;
  entryNumber: string;
  htsCode: string;
  sku: string | null;
  kind: string;
  quantity: string;
  currency: string;
  jurisdiction: string;
  importerOfRecordRef: string;
  source: string;
  rawReference: string;
  observedAt: string;
}

export interface CustomsReturnFact {
  returnFactId: string;
  organizationId: string;
  platformAccountId: string;
  entryNumber: string;
  htsCode: string;
  sku: string | null;
  kind: CustomsReturnKind;
  quantity: string;
  currency: string;
  jurisdiction: string;
  importerOfRecordRef: string;
  source: CustomsReturnSource;
  rawReference: string;
  observedAt: string;
  contentDigest: string;
  readonly readOnly: true;
  readonly filingPerformed: false;
  readonly paymentPerformed: false;
  readonly productionCredentials: 'ABSENT';
}

export interface CustomsEntryLineEvidence {
  organizationId: string;
  platformAccountId: string;
  lineOrdinal: number;
  htsCode: string;
  sku: string | null;
  quantity: string;
  currency: string;
  jurisdiction: string;
}

export interface CustomsMatchPolicy {
  policyId: string;
  policyVersion: string;
  /** true = HTS 必须一致才算匹配（默认 true，不允许猜测）。 */
  requireHtsMatch: boolean;
  /** true = SKU 非空时必须一致（默认 true）。 */
  requireSkuMatchWhenPresent: boolean;
}

export interface CustomsLineMatchResult {
  lineOrdinal: number;
  status: CustomsMatchStatus;
  matchedReturnFactIds: readonly string[];
  matchedQuantity: string;
  eligibleQuantity: string;
  reasonCodes: readonly CustomsMatchReasonCode[];
}

export interface CustomsReturnMatchingResult {
  policyId: string;
  policyVersion: string;
  lines: readonly CustomsLineMatchResult[];
  dedupedReturnFactIds: readonly string[];
  readonly autoFiling: false;
  readonly transportEnabled: false;
  readonly ambiguousTreatedAsEligible: false;
  readonly partialScaledUp: false;
}

const DECIMAL_PATTERN = /^-?\d{1,15}(\.\d{1,6})?$/;
const SAFE_REFERENCE_PATTERN = /^[A-Za-z0-9._:@#/-]{1,96}$/;
const FORBIDDEN_KEYS = ['importername', 'importeraddress', 'consignee', 'contact', 'accesstoken', 'credential', 'rawpayload', 'password', 'secret'];

function fail(code: CustomsMatchErrorCode, detail: string): never {
  throw new CustomsReturnMatchError(code, detail);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return '{' + Object.keys(record).sort().map((key) => JSON.stringify(key) + ':' + canonical(record[key])).join(',') + '}';
  }
  return JSON.stringify(value ?? null);
}

function sha256Hex(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

/** 6 位小数的十进制归一（与 C1/C2 口径一致，不经过浮点）。 */
export function decimal6(value: string): string {
  if (typeof value !== 'string' || !DECIMAL_PATTERN.test(value.trim())) fail('INVALID_QUANTITY', '非法十进制数量');
  const trimmed = value.trim();
  const negative = trimmed.startsWith('-');
  const digits = negative ? trimmed.slice(1) : trimmed;
  const [whole, fraction = ''] = digits.split('.');
  return (negative ? '-' : '') + whole + '.' + fraction.padEnd(6, '0').slice(0, 6);
}

function toScaled(value: string): bigint {
  const normalised = decimal6(value);
  const negative = normalised.startsWith('-');
  const digits = (negative ? normalised.slice(1) : normalised).replace('.', '');
  const scaled = BigInt(digits);
  return negative ? -scaled : scaled;
}

function formatScaled(scaled: bigint): string {
  const negative = scaled < 0n;
  const digits = (negative ? -scaled : scaled).toString().padStart(7, '0');
  const whole = digits.slice(0, digits.length - 6);
  const fraction = digits.slice(digits.length - 6);
  return (negative ? '-' : '') + whole + '.' + fraction;
}

function minScaled(left: string, right: string): string {
  const a = toScaled(left);
  const b = toScaled(right);
  return formatScaled(a <= b ? a : b);
}

/** 归一化 Return/Export/Destruction 事实（fail-closed；append-only 语义由持久化层保证）。 */
export function normalizeCustomsReturnFact(input: CustomsReturnFactInput): CustomsReturnFact {
  if (typeof input !== 'object' || input === null) fail('INVALID_REQUEST', '事实必须是对象');
  for (const [key, value] of Object.entries(input as unknown as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.some((forbidden) => key.toLowerCase().replace(/[^a-z0-9]/g, '') === forbidden)) {
      fail('RAW_PII_NOT_ALLOWED', '返回/出口/销毁事实层禁止 PII 与凭据字段');
    }
    if (value !== null && typeof value === 'object') {
      for (const nested of Object.keys(value as Record<string, unknown>)) {
        if (FORBIDDEN_KEYS.some((forbidden) => nested.toLowerCase().replace(/[^a-z0-9]/g, '') === forbidden)) {
          fail('RAW_PII_NOT_ALLOWED', '返回/出口/销毁事实层禁止 PII 与凭据字段（嵌套）');
        }
      }
    }
  }
  const kind = String(input.kind ?? '').toUpperCase();
  if (!(CUSTOMS_RETURN_KINDS as readonly string[]).includes(kind)) fail('INVALID_RETURN_KIND', '未知的 return/export/destruction 类型');
  const source = String(input.source ?? '').toUpperCase();
  if (!(CUSTOMS_RETURN_SOURCES as readonly string[]).includes(source)) fail('INVALID_SOURCE', '未知来源');
  const currency = String(input.currency ?? '');
  if (!/^[A-Z]{3}$/.test(currency)) fail('INVALID_CURRENCY', '币种必须是 3 位大写');
  for (const field of ['organizationId', 'platformAccountId', 'entryNumber', 'htsCode', 'jurisdiction', 'importerOfRecordRef', 'rawReference'] as const) {
    const value = input[field];
    if (typeof value !== 'string' || value.trim() === '') fail('INVALID_REQUEST', field + ' 必填');
  }
  if (input.sku !== null && (typeof input.sku !== 'string' || input.sku.trim() === '')) fail('INVALID_REQUEST', 'sku 必须为非空字符串或 null');
  if (!SAFE_REFERENCE_PATTERN.test(String(input.rawReference).trim())) {
    fail('INVALID_REQUEST', 'rawReference 必须是 machine-safe 引用（禁止空格 / 自由文本 / PII）');
  }
  if (!SAFE_REFERENCE_PATTERN.test(String(input.importerOfRecordRef).trim())) {
    fail('INVALID_REQUEST', 'importerOfRecordRef 必须是 machine-safe 引用（禁止空格 / PII）');
  }
  const quantity = decimal6(input.quantity);
  if (toScaled(quantity) <= 0n) fail('INVALID_QUANTITY', '数量必须为正');
  const payload = {
    organizationId: input.organizationId,
    platformAccountId: input.platformAccountId,
    entryNumber: input.entryNumber,
    htsCode: input.htsCode,
    sku: input.sku,
    kind,
    quantity,
    currency,
    jurisdiction: input.jurisdiction,
    importerOfRecordRef: input.importerOfRecordRef,
    source,
    rawReference: input.rawReference,
    observedAt: input.observedAt,
  };
  const contentDigest = sha256Hex(payload);
  return {
    returnFactId: sha256Hex({ organizationId: input.organizationId, contentDigest }).slice(0, 32),
    ...payload,
    kind: kind as CustomsReturnKind,
    source: source as CustomsReturnSource,
    contentDigest,
    readOnly: true,
    filingPerformed: false,
    paymentPerformed: false,
    productionCredentials: 'ABSENT',
  };
}

/**
 * 确定性匹配：Import entry line ↔ Return/Export/Destruction facts。
 * 同一输入必然产生同一结果（含 reasonCodes 顺序）；不猜、不放大、不只取“第一个相似项”。
 */
export function matchCustomsLinesToReturns(input: {
  entryLines: readonly CustomsEntryLineEvidence[];
  returnFacts: readonly CustomsReturnFact[];
  policy: CustomsMatchPolicy;
}): CustomsReturnMatchingResult {
  if (!Array.isArray(input.entryLines)) fail('INVALID_REQUEST', 'entryLines 必须是数组');
  if (!Array.isArray(input.returnFacts)) fail('INVALID_REQUEST', 'returnFacts 必须是数组');
  if (!input.policy || !input.policy.policyId || !input.policy.policyVersion) fail('INVALID_REQUEST', 'policy 必填');

  // 1) contentDigest 去重（重复 ingest → exactly one fact）
  const byDigest = new Map<string, CustomsReturnFact>();
  const deduped: string[] = [];
  for (const fact of input.returnFacts) {
    const existing = byDigest.get(fact.contentDigest);
    if (!existing) {
      byDigest.set(fact.contentDigest, fact);
      continue;
    }
    if (existing.returnFactId !== fact.returnFactId) deduped.push(fact.returnFactId);
  }
  const facts = [...byDigest.values()].sort((left, right) => left.returnFactId.localeCompare(right.returnFactId));

  const lines: CustomsLineMatchResult[] = [];
  for (const line of [...input.entryLines].sort((left, right) => left.lineOrdinal - right.lineOrdinal)) {
    const reasons: CustomsMatchReasonCode[] = [];
    const candidates = facts.filter((fact) => {
      if (fact.organizationId !== line.organizationId) {
        fail('CROSS_TENANT_LINEAGE', '返回事实与报关行不属于同一租户');
      }
      if (fact.platformAccountId !== line.platformAccountId) {
        fail('CROSS_ACCOUNT_LINEAGE', '返回事实与报关行不属于同一平台账户');
      }
      if (fact.jurisdiction !== line.jurisdiction) return false;
      if (fact.currency !== line.currency) return false;
      if (input.policy.requireHtsMatch && fact.htsCode !== line.htsCode) return false;
      if (input.policy.requireSkuMatchWhenPresent && line.sku !== null && fact.sku !== line.sku) return false;
      return true;
    });

    if (candidates.length === 0) {
      const htsMismatch = facts.some((fact) => fact.htsCode !== line.htsCode);
      const currencyMismatch = facts.some((fact) => fact.currency !== line.currency);
      const jurisdictionMismatch = facts.some((fact) => fact.jurisdiction !== line.jurisdiction);
      const evidenceExists = facts.length > 0;
      if (evidenceExists && currencyMismatch) reasons.push('CURRENCY_MISMATCH');
      if (evidenceExists && jurisdictionMismatch) reasons.push('JURISDICTION_MISMATCH');
      if (evidenceExists && htsMismatch) reasons.push('HTS_MISMATCH');
      if (!evidenceExists) reasons.push('NO_RETURN_EVIDENCE');
      lines.push({
        lineOrdinal: line.lineOrdinal,
        status: 'NO_MATCH',
        matchedReturnFactIds: [],
        matchedQuantity: formatScaled(0n),
        eligibleQuantity: formatScaled(0n),
        reasonCodes: reasons,
      });
      continue;
    }

    // 同一 SKU + 同 HTS + 同账户出现多条互相冲突的候选（数量不同）→ AMBIGUOUS（绝不自动 ELIGIBLE）
    const quantities = new Set(candidates.map((candidate) => candidate.quantity));
    if (candidates.length > 1 && quantities.size > 1) {
      lines.push({
        lineOrdinal: line.lineOrdinal,
        status: 'AMBIGUOUS',
        matchedReturnFactIds: candidates.map((candidate) => candidate.returnFactId).sort(),
        matchedQuantity: formatScaled(0n),
        eligibleQuantity: formatScaled(0n),
        reasonCodes: ['AMBIGUOUS_DUPLICATE_EVIDENCE'],
      });
      continue;
    }

    const matchedQuantity = formatScaled(candidates.reduce((total, candidate) => total + toScaled(candidate.quantity), 0n));
    const capped = minScaled(matchedQuantity, line.quantity);
    if (input.policy.requireHtsMatch) reasons.push('HTS_MATCH');
    if (line.sku !== null && input.policy.requireSkuMatchWhenPresent) reasons.push('SKU_MATCH');
    reasons.push(toScaled(capped) === toScaled(line.quantity) ? 'QUANTITY_COVERED' : 'QUANTITY_PARTIAL');
    if (deduped.length > 0) reasons.push('DUPLICATE_FACT_DEDUPED');
    lines.push({
      lineOrdinal: line.lineOrdinal,
      status: toScaled(capped) === toScaled(line.quantity) ? 'EXACT' : 'PARTIAL',
      matchedReturnFactIds: candidates.map((candidate) => candidate.returnFactId).sort(),
      matchedQuantity: capped,
      eligibleQuantity: capped,
      reasonCodes: reasons,
    });
  }

  return {
    policyId: input.policy.policyId,
    policyVersion: input.policy.policyVersion,
    lines,
    dedupedReturnFactIds: [...new Set(deduped)].sort(),
    autoFiling: false,
    transportEnabled: false,
    ambiguousTreatedAsEligible: false,
    partialScaledUp: false,
  };
}

export const CUSTOMS_RETURN_MATCHING_BOUNDARY = {
  autoFiling: false,
  transportEnabled: false,
  ambiguousTreatedAsEligible: false,
  partialScaledUp: false,
  guessesAmbiguous: false,
  crossTenantRejected: true,
  crossAccountRejected: true,
  credentials: 'ABSENT',
  externalWritePerformed: false,
} as const;
