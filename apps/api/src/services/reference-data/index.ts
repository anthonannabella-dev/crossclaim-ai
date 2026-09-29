/**
 * C-0015 Step 1 — 参照数据适配器（承运商费率 / DAS / SLA 暂停；关税税率 / 301 豁免清单）
 * ---------------------------------------------------------------
 * 架构方批准：MSG-20260929-12（Carrier Step 1 GO）、MSG-20260929-13（Customs Step 1 GO）、
 * MSG-20260929-14（两份设计均 GO_IMPLEMENTATION，STEP1 ONLY）。
 *
 * 只做：文件解析 → 字段白名单映射 → 生效窗口解析 → 行级校验 →
 *       规范化参照工件（带版本指纹）+ 校验报告。
 * 不做（且本文件绝不引入）：Schema/建表、规则判定、税率适用、金额计算、
 *       申诉函、对外动作、API 同步、OCR、网络访问。
 *
 * 防猜原则：未识别列只列出；无法判定的行进 quarantine 并给 ACTION，绝不产出近似值。
 */

import { createHash } from 'node:crypto';

import { detectFormat, type UploadFormat } from '../validation-run/adapters';
import { parseCsv } from '../validation-run/verify';
import { readXlsxRows } from '../validation-run/adapters/xlsx';

export const ADAPTER_VERSION = 'reference-data/v1';

export type CarrierArtifactType =
  | 'CARRIER_FUEL_SURCHARGE'
  | 'CARRIER_DAS_ZIP'
  | 'CARRIER_SLA_SUSPENSION';

export type CustomsArtifactType = 'CUSTOMS_DUTY_RATE' | 'CUSTOMS_301_EXCLUSION';

export const QUARANTINE_REASONS = [
  'UNKNOWN_FORMAT',
  'PDF_STRUCTURE_ONLY_NO_OCR',
  'MISSING_REQUIRED_FIELD',
  'INVALID_DATE',
  'INVERTED_WINDOW',
  'AMBIGUOUS_WINDOW',
  'AMBIGUOUS_RATE_SCALE',
  'INVALID_HS_CODE',
  'INVALID_COUNTRY_CODE',
  'INVALID_FLAG',
  'EMPTY_SOURCE',
] as const;
export type QuarantineReason = (typeof QUARANTINE_REASONS)[number];

export interface QuarantinedRow {
  rowNumber: number;
  /** 原始行内容指纹（sha256）；**绝不回传原始值** */
  rowHash: string;
  reason: QuarantineReason;
}

export interface ReferenceAmbiguity {
  field: string;
  detail: string;
  action: string;
}

export interface ReferenceReport {
  engineeringStatus: 'PASS' | 'FAIL';
  format: UploadFormat;
  status: 'PASS' | 'QUARANTINE';
  artifactType: CarrierArtifactType | CustomsArtifactType | null;
  sourceFileName: string;
  sourceSha256: string;
  originalRowCount: number;
  adaptedRowCount: number;
  mappedColumns: Record<string, string | null>;
  unknownColumns: string[];
  quarantinedRows: QuarantinedRow[];
  ambiguities: ReferenceAmbiguity[];
  windows: { minEffectiveDate: string | null; maxEffectiveDate: string | null; openEndedCount: number };
  duplicates: number;
  quarantineReason?: QuarantineReason;
  generatedAt: string;
}

export interface ReferenceArtifact<TEntry> {
  artifactType: CarrierArtifactType | CustomsArtifactType;
  sourceSha256: string;
  sourceFormat: UploadFormat;
  generatedAt: string;
  adapterVersion: string;
  fieldCoverage: Record<string, { mapped: boolean; column: string | null }>;
  unmappedColumns: string[];
  windows: ReferenceReport['windows'];
  entries: TEntry[];
}

export interface ReferenceAdaptResult<TEntry> {
  report: ReferenceReport;
  artifact: ReferenceArtifact<TEntry> | null;
}

export interface AdaptInput {
  fileName: string;
  bytes: Buffer;
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// 共享工具
// ---------------------------------------------------------------------------

function sha256(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

/** 表头归一：去空白/下划线/连字符 + 小写（与 ingest 映射同一口径） */
export function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, '');
}

interface SourceTable {
  format: UploadFormat;
  header: string[];
  rows: string[][];
}

class FileQuarantine extends Error {
  readonly reason: QuarantineReason;
  constructor(reason: QuarantineReason) {
    super(reason);
    this.reason = reason;
  }
}

function rowsFromJson(text: string): { header: string[]; rows: string[][] } {
  const parsed = JSON.parse(text) as unknown;
  const items = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { items?: unknown }).items)
      ? ((parsed as { items: unknown[] }).items as unknown[])
      : null;
  if (!items || items.length === 0) throw new FileQuarantine('EMPTY_SOURCE');

  const objects = items as Array<Record<string, unknown>>;
  const header: string[] = [];
  for (const object of objects) {
    for (const key of Object.keys(object ?? {})) if (!header.includes(key)) header.push(key);
  }
  const rows = objects.map((object) =>
    header.map((key) => {
      const value = (object ?? {})[key];
      if (value === null || value === undefined) return '';
      return String(value);
    }),
  );
  return { header, rows };
}

/** 读成表；PDF / 未知格式 / 空表 → 文件级 quarantine */
export function readSourceTable(fileName: string, bytes: Buffer): SourceTable {
  const format = detectFormat(fileName, bytes);
  if (format === 'PDF') throw new FileQuarantine('PDF_STRUCTURE_ONLY_NO_OCR');
  if (format === 'UNKNOWN') throw new FileQuarantine('UNKNOWN_FORMAT');

  if (format === 'XLSX') {
    const rows = readXlsxRows(bytes).filter((row) => row.some((cell) => (cell ?? '').trim() !== ''));
    const [header, ...body] = rows;
    if (!header || body.length === 0) throw new FileQuarantine('EMPTY_SOURCE');
    return { format, header: header.map((cell) => (cell ?? '').trim()), rows: body };
  }

  if (format === 'JSON') {
    const { header, rows } = rowsFromJson(bytes.toString('utf8'));
    if (rows.length === 0) throw new FileQuarantine('EMPTY_SOURCE');
    return { format, header, rows };
  }

  const parsed = parseCsv(bytes.toString('utf8'));
  const [header, ...body] = parsed;
  if (!header || body.length === 0) throw new FileQuarantine('EMPTY_SOURCE');
  return { format, header: header.map((cell) => cell.trim()), rows: body };
}

/** 严格日期解析：只认 YYYY-MM-DD / YYYY/MM/DD / 带时区 ISO 8601（不猜月日顺序） */
export function parseStrictDate(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;

  const dateOnly = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(trimmed);
  if (dateOnly) {
    const [, y, m, d] = dateOnly;
    const year = Number(y);
    const month = Number(m);
    const day = Number(d);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day
    ) {
      return null;
    }
    return date.toISOString().slice(0, 10);
  }

  if (/^\d{4}-\d{2}-\d{2}[Tt].+([Zz]|[+-]\d{2}:\d{2})$/.test(trimmed)) {
    const parsed = new Date(trimmed);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed.toISOString().slice(0, 10);
  }
  return null;
}

/**
 * 百分数费率规范化：接受 `12.5` / `12.5%` / `0`。
 * 写成小数（0 < v < 1）且未显式带 % → AMBIGUOUS_RATE_SCALE（防 100 倍误差）。
 */
export function normalizeRate(value: string): { rate: string } | { error: 'AMBIGUOUS_RATE_SCALE' } {
  const trimmed = value.trim().replace(/\s/g, '');
  if (trimmed === '') return { error: 'AMBIGUOUS_RATE_SCALE' };
  const hasPercent = trimmed.endsWith('%');
  const numeric = hasPercent ? trimmed.slice(0, -1) : trimmed;
  if (!/^\d+(\.\d{1,6})?$/.test(numeric)) return { error: 'AMBIGUOUS_RATE_SCALE' };
  const asNumber = Number(numeric);
  if (!Number.isFinite(asNumber)) return { error: 'AMBIGUOUS_RATE_SCALE' };
  if (!hasPercent && asNumber > 0 && asNumber < 1) return { error: 'AMBIGUOUS_RATE_SCALE' };
  return { rate: asNumber.toFixed(4) };
}

/** 真/假字面量；缺失返回 'unknown'（**不等于 false**） */
export function normalizeFlag(value: string): boolean | 'unknown' | { error: 'INVALID_FLAG' } {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === '') return 'unknown';
  if (['true', 'y', 'yes', '1'].includes(trimmed)) return true;
  if (['false', 'n', 'no', '0'].includes(trimmed)) return false;
  return { error: 'INVALID_FLAG' };
}

// ---------------------------------------------------------------------------
// 字段白名单（只映射这里的列；未识别的列只列出）
// ---------------------------------------------------------------------------

const CARRIER_ALIASES: Record<string, string[]> = {
  carrierName: ['carriername', 'carrier', '承运商', '承运商名称', '快递商'],
  effectiveDate: ['effectivedate', 'effectivefrom', 'startdate', '生效日期', '生效时间'],
  expirationDate: ['expirationdate', 'effectiveto', 'enddate', '失效日期', '失效时间'],
  rateValue: ['ratevalue', 'fuelrate', 'surchargerate', 'percentage', '燃油费率', '费率'],
  serviceLevel: ['servicelevel', 'service', '服务等级'],
  postalCode: ['postalcode', 'zip', 'zipcode', '邮编', '邮政编码'],
  dasType: ['dastype', 'type', 'extended', 'remote', '类型'],
  state: ['state', 'province', '州', '省份'],
  startDate: ['startdate', 'from', 'suspensionstart', '开始日期'],
  endDate: ['enddate', 'to', 'suspensionend', '结束日期'],
  scopeNote: ['scopenote', 'scope', 'region', '范围'],
  reasonNote: ['reasonnote', 'reason', 'announcement', '说明'],
  sourceNote: ['sourcenote', 'source', 'reference', '来源'],
};

const CUSTOMS_ALIASES: Record<string, string[]> = {
  countryCode: ['countrycode', 'country', '国家代码', 'destination', '目的国'],
  hsCode: ['hscode', 'hs', 'hts', 'htscode', 'tariffcode', '税则号', 'hs编码'],
  baseDutyRate: ['basedutyrate', 'baserate', 'generalrate', 'dutyrate', '基础税率', '关税税率'],
  preferentialRate: ['preferentialrate', 'preferential', 'ftarate', '优惠税率'],
  exclusionFlag: ['exclusionflag', 'exclusion', 'section301', '301exclusion', 'exclusion301', '豁免标记'],
  exclusionId: ['exclusionid', '豁免编号'],
  effectiveDate: ['effectivedate', 'effectivefrom', 'startdate', '生效日期', '生效时间'],
  expirationDate: ['expirationdate', 'effectiveto', 'enddate', '失效日期', '失效时间'],
  sourceNote: ['sourcenote', 'source', 'authority', 'reference', '来源'],
};

function mapHeader(header: string[], aliases: Record<string, string[]>): Record<string, string | null> {
  const mapped: Record<string, string | null> = {};
  const used = new Set<string>();
  for (const [field, names] of Object.entries(aliases)) {
    const normalizedNames = names.map(normalizeHeader);
    const hit = header.find(
      (column) => !used.has(column) && normalizedNames.includes(normalizeHeader(column)),
    );
    mapped[field] = hit ?? null;
    if (hit) used.add(hit);
  }
  return mapped;
}

function unknownColumns(header: string[], mapped: Record<string, string | null>): string[] {
  const known = new Set(Object.values(mapped).filter((value): value is string => value !== null));
  return header.filter((column) => !known.has(column));
}

/** 表头 → 字段 → 列下标（只按表头定位，绝不在数据行里找列名） */
function indexMap(header: string[], mapped: Record<string, string | null>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [field, column] of Object.entries(mapped)) {
    out[field] = column === null ? -1 : header.indexOf(column);
  }
  return out;
}

function readCell(row: string[], indices: Record<string, number>, field: string): string {
  const index = indices[field];
  if (index === undefined || index < 0) return '';
  return (row[index] ?? '').trim();
}

function buildWindows(entries: Array<{ effectiveDate: string; expirationDate: string | null }>) {
  const dates = entries.map((entry) => entry.effectiveDate).sort();
  return {
    minEffectiveDate: dates[0] ?? null,
    maxEffectiveDate: dates[dates.length - 1] ?? null,
    openEndedCount: entries.filter((entry) => entry.expirationDate === null).length,
  };
}

const ACTION_FOR_REASON: Partial<Record<QuarantineReason, string>> = {
  INVALID_DATE: 'fix_source_row_then_reimport',
  INVERTED_WINDOW: 'fix_source_row_then_reimport',
  AMBIGUOUS_WINDOW: 'manual_confirmation_required',
  AMBIGUOUS_RATE_SCALE: 'confirm_rate_scale_then_reimport',
  INVALID_HS_CODE: 'fix_source_row_then_reimport',
  INVALID_COUNTRY_CODE: 'fix_source_row_then_reimport',
  INVALID_FLAG: 'fix_source_row_then_reimport',
};

export function actionForReason(reason: QuarantineReason): string {
  return ACTION_FOR_REASON[reason] ?? 'manual_confirmation_required';
}

// ---------------------------------------------------------------------------
// 承运商参照数据（fuel surcharge / DAS zip / SLA suspension）
// ---------------------------------------------------------------------------

export interface CarrierEntry {
  rowNumber: number;
  rowHash: string;
  carrierName: string;
  effectiveDate: string;
  expirationDate: string | null;
  rateValue?: string;
  serviceLevel?: string | null;
  postalCode?: string;
  dasType?: string | null;
  state?: string | null;
  startDate?: string;
  endDate?: string;
  scopeNote?: string | null;
  reasonNote?: string | null;
  sourceNote?: string | null;
}

export type CarrierAdaptResult = ReferenceAdaptResult<CarrierEntry>;

const CARRIER_REQUIRED: Record<CarrierArtifactType, string[]> = {
  CARRIER_FUEL_SURCHARGE: ['carrierName', 'effectiveDate', 'rateValue'],
  CARRIER_DAS_ZIP: ['carrierName', 'postalCode', 'effectiveDate'],
  CARRIER_SLA_SUSPENSION: ['carrierName', 'startDate', 'endDate'],
};

function detectCarrierArtifact(mapped: Record<string, string | null>): CarrierArtifactType | null {
  if (mapped.postalCode) return 'CARRIER_DAS_ZIP';
  if (mapped.startDate && mapped.endDate) return 'CARRIER_SLA_SUSPENSION';
  if (mapped.rateValue) return 'CARRIER_FUEL_SURCHARGE';
  return null;
}

export function adaptCarrierReferenceFile(input: AdaptInput): CarrierAdaptResult {
  const at = (input.now ?? (() => new Date()))();
  const generatedAt = at.toISOString();
  const sourceSha256 = sha256(input.bytes);

  let table: SourceTable;
  try {
    table = readSourceTable(input.fileName, input.bytes);
  } catch (error) {
    const reason = error instanceof FileQuarantine ? error.reason : 'UNKNOWN_FORMAT';
    return {
      artifact: null,
      report: emptyReport(input.fileName, sourceSha256, generatedAt, 'UNKNOWN', reason),
    };
  }

  const mapped = mapHeader(table.header, CARRIER_ALIASES);
  const indices = indexMap(table.header, mapped);
  const artifactType = detectCarrierArtifact(mapped);
  if (!artifactType) {
    return {
      artifact: null,
      report: {
        ...emptyReport(input.fileName, sourceSha256, generatedAt, table.format, 'MISSING_REQUIRED_FIELD'),
        originalRowCount: table.rows.length,
        mappedColumns: mapped,
        unknownColumns: unknownColumns(table.header, mapped),
      },
    };
  }

  const required = CARRIER_REQUIRED[artifactType];
  const missingColumns = required.filter((field) => mapped[field] === null);
  if (missingColumns.length > 0) {
    return {
      artifact: null,
      report: {
        ...emptyReport(input.fileName, sourceSha256, generatedAt, table.format, 'MISSING_REQUIRED_FIELD'),
        originalRowCount: table.rows.length,
        mappedColumns: mapped,
        unknownColumns: unknownColumns(table.header, mapped),
      },
    };
  }
  const quarantined: QuarantinedRow[] = [];
  const entries: CarrierEntry[] = [];
  const seen = new Set<string>();
  let duplicates = 0;

  table.rows.forEach((row, index) => {
    const rowNumber = index + 2; // 1-based，含表头
    const rowHash = sha256(row.join('\u0001'));
    if (seen.has(rowHash)) duplicates += 1;
    seen.add(rowHash);

    const missing = required.filter((field) => readCell(row, indices, field) === '');
    if (missing.length > 0) {
      quarantined.push({ rowNumber, rowHash, reason: 'MISSING_REQUIRED_FIELD' });
      return;
    }

    const carrierName = readCell(row, indices, 'carrierName');
    const isSla = artifactType === 'CARRIER_SLA_SUSPENSION';
    const effectiveRaw = isSla ? readCell(row, indices, 'startDate') : readCell(row, indices, 'effectiveDate');
    const expirationRaw = isSla ? readCell(row, indices, 'endDate') : readCell(row, indices, 'expirationDate');
    const effectiveDate = parseStrictDate(effectiveRaw);
    if (!effectiveDate) {
      quarantined.push({ rowNumber, rowHash, reason: 'INVALID_DATE' });
      return;
    }
    let expirationDate: string | null = null;
    if (expirationRaw !== '') {
      expirationDate = parseStrictDate(expirationRaw);
      if (!expirationDate) {
        quarantined.push({ rowNumber, rowHash, reason: 'INVALID_DATE' });
        return;
      }
      if (expirationDate <= effectiveDate) {
        quarantined.push({ rowNumber, rowHash, reason: 'INVERTED_WINDOW' });
        return;
      }
    }

    const entry: CarrierEntry = {
      rowNumber,
      rowHash,
      carrierName,
      effectiveDate,
      expirationDate,
      sourceNote: readCell(row, indices, 'sourceNote') || null,
    };

    if (artifactType === 'CARRIER_FUEL_SURCHARGE') {
      const rate = normalizeRate(readCell(row, indices, 'rateValue'));
      if ('error' in rate) {
        quarantined.push({ rowNumber, rowHash, reason: rate.error });
        return;
      }
      entry.rateValue = rate.rate;
      entry.serviceLevel = readCell(row, indices, 'serviceLevel') || null;
    } else if (artifactType === 'CARRIER_DAS_ZIP') {
      entry.postalCode = readCell(row, indices, 'postalCode');
      entry.dasType = readCell(row, indices, 'dasType') || null;
      entry.state = readCell(row, indices, 'state') || null;
    } else {
      entry.startDate = effectiveDate;
      entry.endDate = expirationDate ?? effectiveDate;
      entry.scopeNote = readCell(row, indices, 'scopeNote') || null;
      entry.reasonNote = readCell(row, indices, 'reasonNote') || null;
    }
    entries.push(entry);
  });

  const ambiguities = detectOverlaps(
    artifactType,
    entries,
    artifactType === 'CARRIER_DAS_ZIP'
      ? ['carrierName', 'postalCode']
      : artifactType === 'CARRIER_FUEL_SURCHARGE'
        ? ['carrierName', 'serviceLevel']
        : ['carrierName'],
  );

  const windows = buildWindows(
    entries.map((entry) => ({
      effectiveDate: entry.effectiveDate,
      expirationDate: entry.expirationDate,
    })),
  );

  const report: ReferenceReport = {
    engineeringStatus: 'PASS',
    format: table.format,
    status: 'PASS',
    artifactType,
    sourceFileName: input.fileName,
    sourceSha256,
    originalRowCount: table.rows.length,
    adaptedRowCount: entries.length,
    mappedColumns: mapped,
    unknownColumns: unknownColumns(table.header, mapped),
    quarantinedRows: quarantined,
    ambiguities,
    windows,
    duplicates,
    generatedAt,
  };

  return {
    report,
    artifact: {
      artifactType,
      sourceSha256,
      sourceFormat: table.format,
      generatedAt,
      adapterVersion: ADAPTER_VERSION,
      fieldCoverage: coverageOf(mapped),
      unmappedColumns: report.unknownColumns,
      windows,
      entries,
    },
  };
}

// ---------------------------------------------------------------------------
// 关税参照数据（duty rate / 301 exclusion）
// ---------------------------------------------------------------------------

export interface CustomsEntry {
  rowNumber: number;
  rowHash: string;
  countryCode: string;
  hsCode: string;
  baseDutyRate?: string;
  preferentialRate?: string | null;
  exclusionFlag: boolean | 'unknown';
  exclusionId?: string | null;
  effectiveDate: string;
  expirationDate: string | null;
  sourceNote?: string | null;
}

export type CustomsAdaptResult = ReferenceAdaptResult<CustomsEntry>;

/** HS Code 只做字符规范化：去分隔符后必须为 6 / 8 / 10 位数字；不改写、不推断。 */
export function normalizeHsCode(value: string): string | null {
  const compact = value.trim().replace(/[.\-\s]/g, '');
  if (!/^\d{6}$|^\d{8}$|^\d{10}$/.test(compact)) return null;
  return compact;
}

export function normalizeCountryCode(value: string): string | null {
  const trimmed = value.trim();
  return /^[A-Za-z]{2}$/.test(trimmed) ? trimmed.toUpperCase() : null;
}

export function adaptCustomsReferenceFile(input: AdaptInput): CustomsAdaptResult {
  const at = (input.now ?? (() => new Date()))();
  const generatedAt = at.toISOString();
  const sourceSha256 = sha256(input.bytes);

  let table: SourceTable;
  try {
    table = readSourceTable(input.fileName, input.bytes);
  } catch (error) {
    const reason = error instanceof FileQuarantine ? error.reason : 'UNKNOWN_FORMAT';
    return {
      artifact: null,
      report: emptyReport(input.fileName, sourceSha256, generatedAt, 'UNKNOWN', reason),
    };
  }

  const mapped = mapHeader(table.header, CUSTOMS_ALIASES);
  const indices = indexMap(table.header, mapped);
  const artifactType: CustomsArtifactType =
    mapped.exclusionId || (mapped.exclusionFlag && !mapped.baseDutyRate)
      ? 'CUSTOMS_301_EXCLUSION'
      : 'CUSTOMS_DUTY_RATE';
  const required =
    artifactType === 'CUSTOMS_DUTY_RATE'
      ? ['countryCode', 'hsCode', 'baseDutyRate', 'effectiveDate']
      : ['countryCode', 'hsCode', 'effectiveDate'];
  const missingColumns = required.filter((field) => mapped[field] === null);
  if (missingColumns.length > 0) {
    return {
      artifact: null,
      report: {
        ...emptyReport(input.fileName, sourceSha256, generatedAt, table.format, 'MISSING_REQUIRED_FIELD'),
        originalRowCount: table.rows.length,
        mappedColumns: mapped,
        unknownColumns: unknownColumns(table.header, mapped),
      },
    };
  }

  const quarantined: QuarantinedRow[] = [];
  const entries: CustomsEntry[] = [];
  const seen = new Set<string>();
  let duplicates = 0;

  table.rows.forEach((row, index) => {
    const rowNumber = index + 2;
    const rowHash = sha256(row.join('\u0001'));
    if (seen.has(rowHash)) duplicates += 1;
    seen.add(rowHash);

    const missing = required.filter((field) => readCell(row, indices, field) === '');
    if (missing.length > 0) {
      quarantined.push({ rowNumber, rowHash, reason: 'MISSING_REQUIRED_FIELD' });
      return;
    }

    const countryCode = normalizeCountryCode(readCell(row, indices, 'countryCode'));
    if (!countryCode) {
      quarantined.push({ rowNumber, rowHash, reason: 'INVALID_COUNTRY_CODE' });
      return;
    }
    const hsCode = normalizeHsCode(readCell(row, indices, 'hsCode'));
    if (!hsCode) {
      quarantined.push({ rowNumber, rowHash, reason: 'INVALID_HS_CODE' });
      return;
    }
    const effectiveDate = parseStrictDate(readCell(row, indices, 'effectiveDate'));
    if (!effectiveDate) {
      quarantined.push({ rowNumber, rowHash, reason: 'INVALID_DATE' });
      return;
    }
    const expirationRaw = readCell(row, indices, 'expirationDate');
    let expirationDate: string | null = null;
    if (expirationRaw !== '') {
      expirationDate = parseStrictDate(expirationRaw);
      if (!expirationDate) {
        quarantined.push({ rowNumber, rowHash, reason: 'INVALID_DATE' });
        return;
      }
      if (expirationDate <= effectiveDate) {
        quarantined.push({ rowNumber, rowHash, reason: 'INVERTED_WINDOW' });
        return;
      }
    }

    const flag = normalizeFlag(readCell(row, indices, 'exclusionFlag'));
    if (typeof flag === 'object') {
      quarantined.push({ rowNumber, rowHash, reason: 'INVALID_FLAG' });
      return;
    }
    const entry: CustomsEntry = {
      rowNumber,
      rowHash,
      countryCode,
      hsCode,
      exclusionFlag: flag,
      effectiveDate,
      expirationDate,
      sourceNote: readCell(row, indices, 'sourceNote') || null,
    };

    if (artifactType === 'CUSTOMS_DUTY_RATE') {
      const base = normalizeRate(readCell(row, indices, 'baseDutyRate'));
      if ('error' in base) {
        quarantined.push({ rowNumber, rowHash, reason: base.error });
        return;
      }
      entry.baseDutyRate = base.rate;
      const preferentialRaw = readCell(row, indices, 'preferentialRate');
      if (preferentialRaw !== '') {
        const preferential = normalizeRate(preferentialRaw);
        if ('error' in preferential) {
          quarantined.push({ rowNumber, rowHash, reason: preferential.error });
          return;
        }
        entry.preferentialRate = preferential.rate;
      } else {
        entry.preferentialRate = null;
      }
    } else {
      entry.exclusionId = readCell(row, indices, 'exclusionId') || null;
    }
    entries.push(entry);
  });

  const ambiguities = detectOverlaps(artifactType, entries, ['countryCode', 'hsCode']);
  const windows = buildWindows(
    entries.map((entry) => ({
      effectiveDate: entry.effectiveDate,
      expirationDate: entry.expirationDate,
    })),
  );

  const report: ReferenceReport = {
    engineeringStatus: 'PASS',
    format: table.format,
    status: 'PASS',
    artifactType,
    sourceFileName: input.fileName,
    sourceSha256,
    originalRowCount: table.rows.length,
    adaptedRowCount: entries.length,
    mappedColumns: mapped,
    unknownColumns: unknownColumns(table.header, mapped),
    quarantinedRows: quarantined,
    ambiguities,
    windows,
    duplicates,
    generatedAt,
  };

  return {
    report,
    artifact: {
      artifactType,
      sourceSha256,
      sourceFormat: table.format,
      generatedAt,
      adapterVersion: ADAPTER_VERSION,
      fieldCoverage: coverageOf(mapped),
      unmappedColumns: report.unknownColumns,
      windows,
      entries,
    },
  };
}

// ---------------------------------------------------------------------------
// 报告辅助
// ---------------------------------------------------------------------------

function coverageOf(mapped: Record<string, string | null>) {
  const out: Record<string, { mapped: boolean; column: string | null }> = {};
  for (const [field, column] of Object.entries(mapped)) {
    out[field] = { mapped: column !== null, column };
  }
  return out;
}

function emptyReport(
  fileName: string,
  sourceSha256: string,
  generatedAt: string,
  format: UploadFormat | 'UNKNOWN',
  reason: QuarantineReason,
): ReferenceReport {
  return {
    engineeringStatus: 'PASS',
    format: format === 'UNKNOWN' ? 'UNKNOWN' : format,
    status: 'QUARANTINE',
    artifactType: null,
    sourceFileName: fileName,
    sourceSha256,
    originalRowCount: 0,
    adaptedRowCount: 0,
    mappedColumns: {},
    unknownColumns: [],
    quarantinedRows: [],
    ambiguities: [{ field: 'source', detail: reason, action: actionForReason(reason) }],
    windows: { minEffectiveDate: null, maxEffectiveDate: null, openEndedCount: 0 },
    duplicates: 0,
    quarantineReason: reason,
    generatedAt,
  };
}

/** 重叠生效窗口：不判定谁优先，只报歧义（人工确认） */
function detectOverlaps<T extends { rowNumber: number; effectiveDate: string; expirationDate: string | null }>(
  artifactType: string,
  entries: T[],
  keyFields: string[],
): ReferenceAmbiguity[] {
  const groups = new Map<string, T[]>();
  for (const entry of entries) {
    const key = keyFields.map((field) => String((entry as unknown as Record<string, unknown>)[field] ?? '')).join('|');
    const list = groups.get(key) ?? [];
    list.push(entry);
    groups.set(key, list);
  }
  const ambiguities: ReferenceAmbiguity[] = [];
  for (const [key, list] of groups) {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i];
        const b = list[j];
        const aEnd = a.expirationDate ?? '9999-12-31';
        const bEnd = b.expirationDate ?? '9999-12-31';
        const overlaps = a.effectiveDate <= bEnd && b.effectiveDate <= aEnd;
        if (overlaps) {
          ambiguities.push({
            field: keyFields.join('+'),
            detail:
              'AMBIGUOUS_WINDOW: ' + artifactType + ' ' + key + ' 行 ' + a.rowNumber + ' 与 ' + b.rowNumber + ' 生效窗口重叠',
            action: actionForReason('AMBIGUOUS_WINDOW'),
          });
        }
      }
    }
  }
  return ambiguities;
}
