import ExcelJS from 'exceljs';
import Papa from 'papaparse';

/**
 * 把 CSV / XLSX 统一读成二维字符串表。
 * 保持"纯函数"：输入 buffer，输出矩阵，不碰数据库。
 */

export type FileType = 'csv' | 'xlsx';

export function detectFileType(fileName: string): FileType {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.xlsx') || lower.endsWith('.xlsm')) return 'xlsx';
  return 'csv';
}

/** CSV → 二维表。自动跳空行；首行视为表头。 */
export function parseCsv(buffer: Buffer | string): string[][] {
  const text =
    typeof buffer === 'string' ? buffer : buffer.toString('utf8').replace(/^\uFEFF/, '');

  const parsed = Papa.parse<string[]>(text, {
    skipEmptyLines: 'greedy',
    // 不自动识别类型：金额/日期/单号原样保留，交给适配器按业务规则解析
    dynamicTyping: false,
  });

  if (parsed.errors?.length) {
    const fatal = parsed.errors.filter((e) => e.type === 'Delimiter' || e.code === 'UndetectableDelimiter');
    if (fatal.length) {
      throw new Error(`CSV 解析失败: ${fatal[0].message}`);
    }
  }

  return (parsed.data || []).map((row) => (Array.isArray(row) ? row.map((c) => String(c ?? '')) : []));
}

/** ExcelJS 单元格 → 字符串（要处理富文本/公式/超链接等对象形态） */
function cellToString(value: ExcelJS.CellValue): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();

  const v = value as unknown as Record<string, unknown>;
  if (typeof v.text === 'string') return v.text;                                  // 超链接
  if (Array.isArray(v.richText)) {                                                  // 富文本
    return (v.richText as { text?: string }[]).map((r) => r.text ?? '').join('');
  }
  if (v.result != null) return String(v.result);                                    // 公式结果
  if (v.formula != null) return String(v.result ?? '');                             // 只有公式，无缓存值
  return '';
}

/** XLSX → 二维表（取第一个工作表） */
export async function parseXlsx(buffer: Buffer): Promise<string[][]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);

  const sheet = wb.worksheets[0];
  if (!sheet) return [];

  const rows: string[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const values: string[] = [];
    // ExcelJS 行号从 1 开始；row.values 是稀疏数组，下标 0 为空
    const raw = row.values as ExcelJS.CellValue[];
    for (let i = 1; i < raw.length; i++) values.push(cellToString(raw[i]));
    rows.push(values);
  });

  return rows;
}

/** 按文件类型分派 */
export async function parseTabular(fileName: string, buffer: Buffer): Promise<string[][]> {
  return detectFileType(fileName) === 'xlsx' ? parseXlsx(buffer) : parseCsv(buffer);
}

