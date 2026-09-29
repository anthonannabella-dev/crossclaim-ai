/**
 * C-0009.1-A — 适配器入口：任意平台导出文件 → 规范 14 列输入 + 适配报告
 * ---------------------------------------------------------------
 * 支持：CSV / JSON / XLSX；PDF 只做结构识别（**不做 OCR 自动化**）→ QUARANTINE。
 * 不做：金额判断、自动生成索赔、平台连接器、Schema 扩张。
 */

import { createHash } from 'node:crypto';

import { parseCsv } from '../verify';
import { CANONICAL_COLUMNS, type AdaptResult, type AdapterReport, type UploadFormat } from './types';
import { adaptRows, coverageOf } from './mapping';
import { readXlsxRows } from './xlsx';

export * from './types';
export { COLUMN_ALIASES, adaptRows, coverageOf, mapHeader, normalizeHeader } from './mapping';

export function detectFormat(fileName: string, bytes: Buffer): UploadFormat {
  const lower = fileName.toLowerCase();
  if (bytes.subarray(0, 4).toString('utf8') === '%PDF') return 'PDF';
  if (bytes.subarray(0, 2).toString('utf8') === 'PK') return 'XLSX';
  if (lower.endsWith('.json')) return 'JSON';
  if (lower.endsWith('.csv') || lower.endsWith('.tsv')) return 'CSV';
  if (lower.endsWith('.xlsx')) return 'XLSX';
  if (lower.endsWith('.pdf')) return 'PDF';
  // 内容兜底：第一个非空白字符是 { 或 [ 视为 JSON
  const head = bytes.toString('utf8').trimStart()[0];
  if (head === '{' || head === '[') return 'JSON';
  return 'UNKNOWN';
}

function rowsFromJson(text: string): string[][] {
  const parsed = JSON.parse(text) as unknown;
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('JSON_ADAPTER_EMPTY: 需要一个非空对象数组');
  const objects = parsed as Array<Record<string, unknown>>;
  const header: string[] = [];
  for (const object of objects) {
    for (const key of Object.keys(object ?? {})) if (!header.includes(key)) header.push(key);
  }
  const rows = objects.map((object) =>
    header.map((key) => {
      const value = (object ?? {})[key];
      if (value === null || value === undefined) return '';
      return typeof value === 'object' ? JSON.stringify(value) : String(value);
    }),
  );
  return [header, ...rows];
}

function parseToRows(format: UploadFormat, bytes: Buffer): string[][] {
  const text = bytes.toString('utf8');
  if (format === 'CSV') return parseCsv(text);
  if (format === 'JSON') return rowsFromJson(text);
  if (format === 'XLSX') return readXlsxRows(bytes);
  throw new Error(`ADAPTER_UNSUPPORTED_FORMAT: ${format}`);
}

export interface AdaptInput {
  fileName: string;
  bytes: Buffer;
  now?: () => Date;
}

export function adaptUploadedFile(input: AdaptInput): AdaptResult {
  const now = (input.now ?? (() => new Date()))();
  const sourceSha256 = createHash('sha256').update(input.bytes).digest('hex');
  const format = detectFormat(input.fileName, input.bytes);

  const base: Pick<AdapterReport, 'sourceFileName' | 'sourceSha256' | 'generatedAt' | 'format'> = {
    format,
    sourceFileName: input.fileName,
    sourceSha256,
    generatedAt: now.toISOString(),
  };

  if (format === 'PDF') {
    return {
      rows: [],
      report: {
        ...base,
        engineeringStatus: 'FAIL',
        status: 'QUARANTINE',
        originalRowCount: 0,
        adaptedRowCount: 0,
        mappedColumns: Object.fromEntries(CANONICAL_COLUMNS.map((column) => [column, null])),
        unknownColumns: [],
        ambiguities: [
          {
            field: 'document',
            detail: 'PDF 只做结构识别，不进入 OCR 自动化（按 MSG-20260929-02 的范围）',
            action: 'manual confirmation required',
          },
        ],
        coverage: { requiredMatched: 0, requiredTotal: 3, optionalMatched: 0, optionalTotal: 11 },
        quarantineReason: 'PDF_STRUCTURE_ONLY_NO_OCR',
      },
    };
  }

  if (format === 'UNKNOWN') {
    return {
      rows: [],
      report: {
        ...base,
        engineeringStatus: 'FAIL',
        status: 'QUARANTINE',
        originalRowCount: 0,
        adaptedRowCount: 0,
        mappedColumns: Object.fromEntries(CANONICAL_COLUMNS.map((column) => [column, null])),
        unknownColumns: [],
        ambiguities: [
          { field: 'format', detail: '无法识别的文件格式', action: 'manual confirmation required' },
        ],
        coverage: { requiredMatched: 0, requiredTotal: 3, optionalMatched: 0, optionalTotal: 11 },
        quarantineReason: 'UNKNOWN_FORMAT',
      },
    };
  }

  let table: string[][];
  try {
    table = parseToRows(format, input.bytes);
  } catch (error) {
    return {
      rows: [],
      report: {
        ...base,
        engineeringStatus: 'FAIL',
        status: 'QUARANTINE',
        originalRowCount: 0,
        adaptedRowCount: 0,
        mappedColumns: Object.fromEntries(CANONICAL_COLUMNS.map((column) => [column, null])),
        unknownColumns: [],
        ambiguities: [
          {
            field: 'structure',
            detail: error instanceof Error ? error.message : String(error),
            action: 'manual confirmation required',
          },
        ],
        coverage: { requiredMatched: 0, requiredTotal: 3, optionalMatched: 0, optionalTotal: 11 },
        quarantineReason: 'STRUCTURE_UNREADABLE',
      },
    };
  }

  const [header, ...dataRows] = table;
  if (!header || header.length === 0) {
    return {
      rows: [],
      report: {
        ...base,
        engineeringStatus: 'FAIL',
        status: 'QUARANTINE',
        originalRowCount: 0,
        adaptedRowCount: 0,
        mappedColumns: Object.fromEntries(CANONICAL_COLUMNS.map((column) => [column, null])),
        unknownColumns: [],
        ambiguities: [{ field: 'header', detail: '文件没有表头', action: 'manual confirmation required' }],
        coverage: { requiredMatched: 0, requiredTotal: 3, optionalMatched: 0, optionalTotal: 11 },
        quarantineReason: 'NO_HEADER',
      },
    };
  }

  const { rows, mapping, dataAmbiguities } = adaptRows(header, dataRows);
  const coverage = coverageOf(mapping);
  return {
    rows,
    report: {
      ...base,
      engineeringStatus: 'PASS',
      status: coverage.requiredMatched === coverage.requiredTotal ? 'PASS' : 'QUARANTINE',
      originalRowCount: dataRows.length,
      adaptedRowCount: rows.length,
      mappedColumns: mapping.matchedHeader,
      unknownColumns: mapping.unknownColumns,
      ambiguities: [...mapping.ambiguities, ...dataAmbiguities],
      coverage,
      ...(coverage.requiredMatched === coverage.requiredTotal ? {} : { quarantineReason: 'REQUIRED_COLUMNS_MISSING' }),
    },
  };
}

/** 规范 CSV（14 列）——可直接喂给既有验证工具链。 */
export function toCanonicalCsv(rows: Array<{ row: Record<string, string> }>): string {
  const escape = (value: string) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const lines = [CANONICAL_COLUMNS.join(',')];
  for (const item of rows) lines.push(CANONICAL_COLUMNS.map((column) => escape(item.row[column] ?? '')).join(','));
  return lines.join('\n');
}

/** 人读适配报告（落盘为 VALIDATION-INPUT-ADAPTER-REPORT.md）。 */
export function renderAdapterReport(report: AdapterReport): string {
  const lines = [
    '# Validation Input Adapter Report（平台导出 → 规范输入；**不含业务判断**）',
    '',
    '```text',
    `engineeringStatus : ${report.engineeringStatus}`,
    `format            : ${report.format}`,
    `status            : ${report.status}${report.quarantineReason ? `  (${report.quarantineReason})` : ''}`,
    '```',
    '',
    `- 源文件：\`${report.sourceFileName}\``,
    `- 源文件 sha256：\`${report.sourceSha256}\``,
    `- 原始行数：${report.originalRowCount}（已适配 ${report.adaptedRowCount}）`,
    `- 生成时间：${report.generatedAt}`,
    '',
    '## 字段覆盖率',
    '',
    `- 必需列：${report.coverage.requiredMatched}/${report.coverage.requiredTotal}`,
    `- 可选列：${report.coverage.optionalMatched}/${report.coverage.optionalTotal}`,
    '',
    '| 规范列 | 命中的原始表头 |',
    '|---|---|',
    ...CANONICAL_COLUMNS.map(
      (column) => `| \`${column}\` | ${report.mappedColumns[column] ? `\`${report.mappedColumns[column]}\`` : '（未命中）'} |`,
    ),
    '',
    '## 无法识别的原始列（不猜测含义）',
    '',
    report.unknownColumns.length === 0
      ? '- 无'
      : report.unknownColumns.map((column) => `- \`${column}\``).join('\n'),
    '',
    '## 不确定项（必须人工确认）',
    '',
    report.ambiguities.length === 0
      ? '- 无'
      : report.ambiguities.map((item) => `- UNKNOWN: \`${item.field}\` — ${item.detail}\n  ACTION: ${item.action}`).join('\n'),
    '',
    '> 本报告只说明「文件能不能被结构化」；不判断费用是否合理、也不判断能不能追回。',
    '',
  ];
  return lines.join('\n');
}
