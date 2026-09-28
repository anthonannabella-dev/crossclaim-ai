import type { RecoveryChannel } from '@prisma/client';
import { DEFAULT_SIGNAL_TYPE, mergeMapping, resolveColumns } from './columns';
import type { AdapterResult, ColumnMapping, NormalizedRow, SkippedRow } from './types';

/**
 * 把二维表适配成 NormalizedRow —— 纯函数，不碰数据库，便于单测。
 */

/** 金额解析：容忍 "$1,234.56"、"(12.30)"（会计负数）、全角符号、空白 */
export function parseAmount(raw: unknown): number | undefined {
  if (raw == null) return undefined;
  let s = String(raw).trim();
  if (!s) return undefined;

  // 会计括号表示负数
  const negative = /^\(.*\)$/.test(s);
  s = s
    .replace(/[()]/g, '')
    .replace(/[¥$€£￥,，\s]/g, '')
    .replace(/[％%]/g, '');

  if (!/^-?\d+(\.\d+)?$/.test(s)) return undefined;
  const n = Number(s);
  if (Number.isNaN(n)) return undefined;
  return negative ? -Math.abs(n) : n;
}

/** 日期解析：容忍 Date 对象、ISO、YYYY/MM/DD、YYYY-MM-DD、Excel 序列号 */
export function parseDate(raw: unknown): Date | undefined {
  if (raw == null) return undefined;
  const s = String(raw).trim();
  if (!s) return undefined;

  // Excel 序列号（1900 日期系统）
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const serial = Number(s);
    if (serial > 20000 && serial < 60000) {
      const ms = Date.UTC(1899, 11, 30) + serial * 86400000;
      return new Date(ms);
    }
  }

  const normalized = s.replace(/\//g, '-').replace(/\./g, '-');
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function pick(row: string[], idx: number | undefined): string | undefined {
  if (idx == null) return undefined;
  const v = row[idx];
  return v == null || String(v).trim() === '' ? undefined : String(v).trim();
}

export function adaptRows(
  channel: RecoveryChannel,
  matrix: string[][],
  override?: ColumnMapping,
): AdapterResult {
  const skipped: SkippedRow[] = [];

  if (!matrix.length) {
    return { rows: [], skipped: [{ line: 0, reason: '文件为空' }], resolvedColumns: {} };
  }

  const header = matrix[0] ?? [];
  const mapping = mergeMapping(channel, override);
  const cols = resolveColumns(header, mapping);

  // 至少要能定位到"金额"或"单号"，否则说明表头完全不认识 —— 明确报错，不静默产出空结果
  if (cols.amountActual == null && cols.amountExpected == null && cols.sourceRef == null) {
    throw new Error(
      `无法识别 ${channel} 的表头：未找到金额列或单号列。` +
      `实际表头为 [${header.slice(0, 8).join(', ')}...]。请用 mapping 参数指定列名。`,
    );
  }

  const defaultCurrency = 'USD';
  const rows: NormalizedRow[] = [];

  for (let r = 1; r < matrix.length; r++) {
    const line = r + 1; // 表头占第 1 行
    const row = matrix[r] ?? [];
    if (row.every((c) => String(c ?? '').trim() === '')) continue; // 空行

    const raw: Record<string, unknown> = {};
    header.forEach((h, i) => {
      const key = String(h ?? '').trim() || `col_${i}`;
      raw[key] = row[i] ?? '';
    });

    const sourceRef = pick(row, cols.sourceRef);
    const amountActual = parseAmount(pick(row, cols.amountActual));
    const amountExpected = parseAmount(pick(row, cols.amountExpected));
    const currency = pick(row, cols.currency) || defaultCurrency;
    const occurredAt = parseDate(pick(row, cols.occurredAt));
    const rawType = pick(row, cols.signalType);
    const signalType = rawType || DEFAULT_SIGNAL_TYPE[channel] || 'UNCLASSIFIED';

    // 一条既没有金额、也没有单号的记录没有追回价值，计入 skipped 并说明原因
    if (amountActual == null && amountExpected == null && !sourceRef) {
      skipped.push({ line, reason: '无金额且无单号，无法判断是否漏损' });
      continue;
    }

    rows.push({ sourceRef, occurredAt, amountExpected, amountActual, currency, signalType, raw });
  }

  return { rows, skipped, resolvedColumns: cols };
}

