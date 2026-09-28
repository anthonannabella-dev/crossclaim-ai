/**
 * 列映射：外部列名 → 内部字段
 * ---------------------------------------------------------------
 * 设计要点：
 *   - 映射是**数据**（落 ImportBatch.columnMapping 快照），不是代码常量
 *   - 大小写与首尾空白不敏感；一个内部字段只能被映射一次
 *   - 必需字段缺失时直接拒绝整批（这是"表头级"错误，不是行级错误）
 */

import { IngestError, INTERNAL_FIELDS, type ColumnMapping, type InternalField } from './types';

/**
 * 每个内部字段在源文件里常见的别名，便于自动映射。
 * 比较前会统一去掉空白 / 下划线 / 连字符并转小写（见 normalizeKey），
 * 因此这里写"人类可读"的写法即可。
 */
const ALIASES: Record<InternalField, string[]> = {
  externalId: ['external id', 'id', 'invoice', 'invoice no', 'invoice number', 'tracking', 'tracking number', 'order', 'order id', 'shipment', 'shipment id'],
  referenceType: ['reference type', 'type', 'doc type', 'document type'],
  occurredAt: ['occurred at', 'date', 'invoice date', 'ship date', 'occurred'],
  amount: ['amount', 'net amount', 'net charge', 'total', 'charge', 'fee'],
  currency: ['currency', 'ccy'],
};

const REQUIRED: InternalField[] = ['amount'];

function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, '');
}

/** 自动映射：表头 → 内部字段（找不到就不映射） */
export function autoMap(header: string[]): ColumnMapping {
  const mapping: ColumnMapping = {};
  const used = new Set<string>();

  for (const field of INTERNAL_FIELDS) {
    const aliases = ALIASES[field];
    const normalizedAliases = aliases.map(normalizeKey);
    const hit = header.find((column) => {
      const key = normalizeKey(column);
      return !used.has(column) && normalizedAliases.includes(key);
    });
    if (hit) {
      mapping[field] = hit;
      used.add(hit);
    }
  }
  return mapping;
}

/** 校验映射是否可用；返回规范化后的映射（列名保持原样） */
export function validateMapping(header: string[], mapping: ColumnMapping): ColumnMapping {
  const headerSet = new Set(header);
  const seen = new Set<string>();
  const out: ColumnMapping = {};

  for (const field of INTERNAL_FIELDS) {
    const column = mapping[field];
    if (column === undefined) continue;
    if (!headerSet.has(column)) {
      throw new IngestError(`列映射指向不存在的列: ${field} → ${column}`);
    }
    if (seen.has(column)) {
      throw new IngestError(`同一个源列被映射到多个内部字段: ${column}`);
    }
    seen.add(column);
    out[field] = column;
  }

  for (const field of REQUIRED) {
    if (!out[field]) throw new IngestError(`缺少必需字段的列映射: ${field}`);
  }
  return out;
}

/** 表头 → 每行原始对象 */
export function toRawRows(header: string[], rows: string[][]): Array<Record<string, string>> {
  return rows.map((cells) => {
    const raw: Record<string, string> = {};
    header.forEach((column, index) => {
      raw[column] = (cells[index] ?? '').trim();
    });
    return raw;
  });
}
