/**
 * 规范导入格式（canonical ingest format）
 * ---------------------------------------------------------------
 * 目的：给所有外部平台一个**唯一的落点**。平台记录在这里被压平成
 * SourceTransaction 的 5 个规范列，平台特有字段只作为证据留在 `source`。
 *
 * 幂等语义（与 CSV 路径完全一致，未做任何改动）：
 *   dedupeKey = sha256(organizationId | connectionId | referenceType | externalId | rowFingerprint)
 *   rowFingerprint 只覆盖**规范列**，不覆盖 `source` 载荷 ——
 *   平台侧附加元数据变化（例如多返回一个字段）不应制造第二条交易。
 */

import type { ColumnMapping, InternalField, RawRow } from '../ingest/types';
import { INTERNAL_FIELDS } from '../ingest/types';
import { AdapterMappingError, type AdapterRecord } from './types';

/** 规范列 = 导入层的内部字段，顺序即映射快照顺序 */
export const CANONICAL_COLUMNS: readonly InternalField[] = INTERNAL_FIELDS;

/** 规范列的恒等映射（适配器输出即内部字段名），落进 ImportBatch.columnMapping 作为快照 */
export const CANONICAL_MAPPING: ColumnMapping = INTERNAL_FIELDS.reduce<ColumnMapping>(
  (acc, field) => {
    acc[field] = field;
    return acc;
  },
  {},
);

/** 与 Decimal(18,4) 对齐：最多 4 位小数，不接受科学计数法 */
const DECIMAL_SAFE = /^-?\d+(\.\d{1,4})?$/;

/**
 * 金额一律以**十进制字符串**往下游走，禁止浮点误差进入账目。
 * number 只在能被安全表示（整数或 ≤4 位小数、无科学计数法）时接受，
 * 否则明确报错，避免 `0.1 + 0.2` 这类静默污染。
 */
export function canonicalAmount(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !DECIMAL_SAFE.test(String(value))) {
      throw new AdapterMappingError(
        `金额必须用十进制字符串表达（收到 number ${String(value)}），避免浮点误差`,
      );
    }
    return String(value);
  }
  return value.trim();
}

/** 日期只做「Date → ISO 字符串」的搬运，不做任何业务日期推算 */
export function canonicalDate(value: string | Date | null | undefined): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new AdapterMappingError('日期非法（Invalid Date）');
    return value.toISOString();
  }
  return value.trim();
}

export function canonicalText(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

export function canonicalCurrency(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  return value.trim().toUpperCase();
}

export interface CanonicalRows {
  /** 规范列名（= CANONICAL_COLUMNS） */
  header: string[];
  /** 恒等映射快照 */
  mapping: ColumnMapping;
  /** 规范行，与输入 records 同序同长 */
  rows: RawRow[];
  /** 与 rows 同序的平台原始载荷（证据；未提供则是 undefined） */
  sources: unknown[];
}

export function toCanonicalRows(records: readonly AdapterRecord[]): CanonicalRows {
  const rows = records.map<RawRow>((record) => ({
    externalId: canonicalText(record.externalId),
    referenceType: canonicalText(record.referenceType),
    occurredAt: canonicalDate(record.occurredAt),
    amount: canonicalAmount(record.amount),
    currency: canonicalCurrency(record.currency),
  }));

  return {
    header: [...CANONICAL_COLUMNS],
    mapping: { ...CANONICAL_MAPPING },
    rows,
    sources: records.map((record) => record.source),
  };
}

/**
 * raw 证据投影：规范列 + `_source`（平台原始载荷）。
 * `raw` 是审计/证据字段，**不参与**幂等指纹计算（指纹在 normalize 阶段基于规范列算好）。
 */
export function withSourceEvidence(row: RawRow, source: unknown): Record<string, unknown> {
  const evidence: Record<string, unknown> = { ...row };
  if (source !== undefined) evidence._source = source;
  return evidence;
}
