/**
 * CSV 解析（零依赖，RFC4180 语义 + 实战容错）
 * ---------------------------------------------------------------
 * 支持：引号包裹字段、字段内逗号、字段内换行、"" 转义、CRLF/LF、UTF-8 BOM、
 *       分隔符可选（, ; \t）、结尾空行忽略。
 * 不支持（明确不做，避免半吊子实现）：多字符分隔符、注释行、类型推断。
 */

import { IngestError, type ParseResult } from './types';

export interface CsvParseOptions {
  delimiter?: ',' | ';' | '\t';
  /** 最多解析多少数据行（防止超大文件一次性吃光内存；默认 50000） */
  maxRows?: number;
}

export function parseCsv(text: string, options: CsvParseOptions = {}): ParseResult {
  const delimiter = options.delimiter ?? ',';
  const maxRows = options.maxRows ?? 50_000;
  if (typeof text !== 'string') throw new IngestError('CSV 内容必须是字符串');

  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;
  let rowCount = 0;

  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    const isBlank = row.length === 1 && row[0].trim() === '';
    if (!isBlank) {
      rows.push(row);
      rowCount += 1;
    }
    row = [];
  };

  while (i < input.length) {
    const ch = input[i];

    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      pushField();
      i += 1;
      continue;
    }
    if (ch === '\r') {
      if (input[i + 1] === '\n') i += 1;
      pushRow();
      if (rowCount > maxRows) throw new IngestError(`CSV 行数超过上限 ${maxRows}`);
      i += 1;
      continue;
    }
    if (ch === '\n') {
      pushRow();
      if (rowCount > maxRows) throw new IngestError(`CSV 行数超过上限 ${maxRows}`);
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }

  if (inQuotes) throw new IngestError('CSV 引号未闭合');
  if (field !== '' || row.length > 0) pushRow();
  if (rows.length === 0) throw new IngestError('CSV 没有可解析的内容');

  const header = rows[0].map((h) => h.trim());
  if (header.every((h) => h === '')) throw new IngestError('CSV 表头为空');

  return { header, rows: rows.slice(1) };
}
