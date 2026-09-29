/**
 * C-0009.1-A — 平台导出文件适配器（**验证加速层**）
 * ---------------------------------------------------------------
 * 架构方批准（MSG-20260929-02）：
 *   · 只做：文件解析 / 字段映射 / 规范化 / quarantine / 验证报告
 *   · **不做**：业务判断（什么该追、可追回多少）、自动生成索赔、平台连接器、未经 Delta 评审的 Schema 扩张
 *   · 数据治理：字段白名单、未识别字段进 quarantine、保留原始行号、保留来源指纹、**绝不覆盖原始数据**
 *
 * 本模块纯函数 + 本地文件，**无网络、无凭据、无平台账号**。
 */

import type { ValidationRow } from '../anonymize';

/** 规范输入列（C-0009.1 的 14 列），适配器的目标形状。 */
export const CANONICAL_COLUMNS = [
  'orderId',
  'trackingNo',
  'invoiceNo',
  'channel',
  'promisedDeliveredAt',
  'actualDeliveredAt',
  'billedAmount',
  'billedCurrency',
  'invoiceAmount',
  'invoiceCurrency',
  'evidenceRef',
  'settlementRef',
  'claimOutcome',
  'note',
] as const;

export const REQUIRED_COLUMNS = ['orderId', 'trackingNo', 'invoiceNo'] as const;
export const OPTIONAL_COLUMNS = CANONICAL_COLUMNS.filter(
  (column) => !(REQUIRED_COLUMNS as readonly string[]).includes(column),
);

export type UploadFormat = 'CSV' | 'JSON' | 'XLSX' | 'PDF' | 'UNKNOWN';
export type AdapterStatus = 'PASS' | 'QUARANTINE';

/** 适配器附加的中间字段（架构方点名的 13 项），只用于报告，不进入规范输入。 */
export interface AdapterMetadata {
  sourcePlatform: string | null;
  transactionId: string | null;
  transactionDate: string | null;
  sku: string | null;
  feeType: string | null;
  direction: string | null;
  settlementPeriod: string | null;
}

export interface AdaptedRow {
  /** 规范输入行（14 列） */
  row: ValidationRow;
  /** 原始文件里的行号（1-based，含表头偏移），用于对账与人工复核 */
  rowNumber: number;
  /** 该行原始内容指纹（sha256），用于「同一行是否被改过」的判定 */
  rawRowHash: string;
  metadata: AdapterMetadata;
}

export interface AdapterAmbiguity {
  field: string;
  detail: string;
  action: string;
}

export interface AdapterReport {
  engineeringStatus: 'PASS' | 'FAIL';
  format: UploadFormat;
  status: AdapterStatus;
  sourceFileName: string;
  sourceSha256: string;
  originalRowCount: number;
  adaptedRowCount: number;
  /** canonical 列 → 命中的原始表头（未命中为空） */
  mappedColumns: Record<string, string | null>;
  /** 无法识别的原始列名（不猜测含义） */
  unknownColumns: string[];
  /** 不确定项：必须人工确认，绝不自行猜 */
  ambiguities: AdapterAmbiguity[];
  coverage: {
    requiredMatched: number;
    requiredTotal: number;
    optionalMatched: number;
    optionalTotal: number;
  };
  quarantineReason?: string;
  generatedAt: string;
}

export interface AdaptResult {
  report: AdapterReport;
  rows: AdaptedRow[];
}
