/**
 * C-0009.1-A — 平台导出表头 → 规范 14 列 的映射（不猜含义）
 * ---------------------------------------------------------------
 * 规则：
 *   · 表头做标准化（小写、去分隔符与空白）后按别名表匹配；
 *   · 匹配不到就进 `unknownColumns`（**不猜测**它对应哪一列）；
 *   · 需要人工判断的（例如只有一列通用 "currency"）进 `ambiguities` 并给出 ACTION。
 */

import { createHash } from 'node:crypto';

import type { ValidationRow } from '../anonymize';
import {
  CANONICAL_COLUMNS,
  OPTIONAL_COLUMNS,
  REQUIRED_COLUMNS,
  type AdapterAmbiguity,
  type AdapterMetadata,
  type AdaptedRow,
} from './types';

export const COLUMN_ALIASES: Record<string, readonly string[]> = {
  orderId: ['orderid', 'order', 'orderno', 'ordernumber', 'amazonorderid', 'merchantorderid', '订单号', '订单编号'],
  trackingNo: ['tracking', 'trackingno', 'trackingnumber', 'trackingid', 'awb', 'awbno', '运单号', '物流单号', '快递单号'],
  invoiceNo: ['invoice', 'invoiceno', 'invoicenumber', 'invoiceid', 'documentnumber', 'settlementid', '发票号', '结算单号'],
  channel: ['channel', 'carrier', 'service', 'shipmethod', 'shippingmethod', '渠道', '承运商', '运输方式'],
  promisedDeliveredAt: ['promised', 'promiseddeliveredat', 'promiseddelivery', 'estimateddelivery', 'sla', 'sladue', '承诺妥投', '承诺时间'],
  actualDeliveredAt: ['delivered', 'deliveredat', 'actualdelivery', 'actualdeliveredat', 'deliverydate', '妥投时间', '实际妥投'],
  billedAmount: ['billed', 'billedamount', 'carriercharge', 'freightcharge', 'shippingcharge', '运费', '运费金额'],
  billedCurrency: ['billedcurrency', 'freightcurrency', '运费币种'],
  invoiceAmount: ['invoiceamount', 'invoiced', 'invoicedamount', 'chargedamount', '账单金额', '账单'],
  invoiceCurrency: ['invoicecurrency', '币种'],
  evidenceRef: ['evidence', 'evidenceref', 'pod', 'proof', 'proofofdelivery', '凭证', '单据'],
  settlementRef: ['settlement', 'settlementref', 'payout', 'payoutid', '赔付', '赔付单号'],
  claimOutcome: ['claimoutcome', 'claimstatus', '理赔状态', '索赔状态'],
  note: ['note', 'notes', 'remark', 'remarks', 'description', 'feedescription', 'feetype', 'fee type', '备注', '说明', '费用类型'],
};

const GENERIC_CURRENCY = ['currency', 'curr', '币别'];
const GENERIC_FEE_TYPE = ['feetype', 'fee type', '费用类型', 'fee'];

export const METADATA_ALIASES: Record<keyof AdapterMetadata, readonly string[]> = {
  sourcePlatform: ['sourceplatform', 'platform', '来源平台', '平台'],
  transactionId: ['transactionid', 'transaction', 'txnid', '交易号'],
  transactionDate: ['transactiondate', 'date', '日期', '交易日期'],
  sku: ['sku', 'fnsku', 'asin', 'reference', 'sku/reference', '商品编码'],
  feeType: GENERIC_FEE_TYPE,
  direction: ['direction', '方向', '借贷'],
  settlementPeriod: ['settlementperiod', 'period', '结算周期'],
};

export function normalizeHeader(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\s_\-./\\()[\]{}:：、,，]/g, '')
    .trim();
}

export interface HeaderMapping {
  /** canonical 列 → 原始列下标（未命中为 null） */
  index: Record<string, number | null>;
  /** canonical 列 → 命中的原始表头文本 */
  matchedHeader: Record<string, string | null>;
  metadataIndex: Record<keyof AdapterMetadata, number | null>;
  unknownColumns: string[];
  ambiguities: AdapterAmbiguity[];
}

export function mapHeader(header: string[]): HeaderMapping {
  const normalized = header.map((value) => normalizeHeader(value));
  const index: Record<string, number | null> = {};
  const matchedHeader: Record<string, string | null> = {};
  const used = new Set<number>();

  const take = (aliases: readonly string[]): number | null => {
    for (const alias of aliases) {
      const position = normalized.findIndex((value, i) => value === alias && !used.has(i));
      if (position >= 0) {
        used.add(position);
        return position;
      }
    }
    return null;
  };

  for (const column of CANONICAL_COLUMNS) {
    const position = take(COLUMN_ALIASES[column] ?? []);
    index[column] = position;
    matchedHeader[column] = position === null ? null : (header[position] ?? null);
  }

  const metadataIndex = {} as Record<keyof AdapterMetadata, number | null>;
  for (const key of Object.keys(METADATA_ALIASES) as Array<keyof AdapterMetadata>) {
    metadataIndex[key] = take(METADATA_ALIASES[key]);
  }

  const ambiguities: AdapterAmbiguity[] = [];
  // 只有一列通用币种：不猜它属于账单还是运费，先当作账单币种并明确要求人工确认
  const genericCurrency = take(GENERIC_CURRENCY);
  if (genericCurrency !== null) {
    used.add(genericCurrency);
    if (index.invoiceCurrency === null) {
      index.invoiceCurrency = genericCurrency;
      matchedHeader.invoiceCurrency = header[genericCurrency] ?? null;
    }
    ambiguities.push({
      field: 'currency',
      detail: '只有一列通用币种，无法判断它属于账单还是运费',
      action: 'manual confirmation required',
    });
  }
  if (index.billedCurrency === null && index.invoiceCurrency !== null) {
    ambiguities.push({
      field: 'billedCurrency',
      detail: '运费币种缺失（未自行复制账单币种）',
      action: 'manual confirmation required',
    });
  }
  for (const column of REQUIRED_COLUMNS) {
    if (index[column] === null) {
      ambiguities.push({
        field: column,
        detail: `必需列 ${column} 在导出文件里没有对应表头`,
        action: 'manual confirmation required',
      });
    }
  }

  const unknownColumns = header.filter((_value, position) => {
    const normal = normalized[position];
    if (normal === '') return false;
    const known =
      Object.values(COLUMN_ALIASES).some((aliases) => aliases.includes(normal)) ||
      Object.values(METADATA_ALIASES).some((aliases) => aliases.includes(normal)) ||
      GENERIC_CURRENCY.includes(normal);
    return !known;
  });

  return { index, matchedHeader, metadataIndex, unknownColumns, ambiguities };
}

const cell = (cells: string[], position: number | null): string =>
  position === null ? '' : (cells[position] ?? '').trim();

export function adaptRows(header: string[], rows: string[][]): { rows: AdaptedRow[]; mapping: HeaderMapping } {
  const mapping = mapHeader(header);
  const adapted = rows.map((cells, index) => {
    const row: ValidationRow = {};
    for (const column of CANONICAL_COLUMNS) row[column] = cell(cells, mapping.index[column]);
    if (!row.claimOutcome) row.claimOutcome = 'NOT_STARTED';
    const metadata: AdapterMetadata = {
      sourcePlatform: cell(cells, mapping.metadataIndex.sourcePlatform) || null,
      transactionId: cell(cells, mapping.metadataIndex.transactionId) || null,
      transactionDate: cell(cells, mapping.metadataIndex.transactionDate) || null,
      sku: cell(cells, mapping.metadataIndex.sku) || null,
      feeType: cell(cells, mapping.metadataIndex.feeType) || null,
      direction: cell(cells, mapping.metadataIndex.direction) || null,
      settlementPeriod: cell(cells, mapping.metadataIndex.settlementPeriod) || null,
    };
    return {
      row,
      // 表头占第 1 行，数据从第 2 行起
      rowNumber: index + 2,
      rawRowHash: createHash('sha256').update(JSON.stringify(cells), 'utf8').digest('hex'),
      metadata,
    };
  });
  return { rows: adapted, mapping };
}

export function coverageOf(mapping: HeaderMapping): {
  requiredMatched: number;
  requiredTotal: number;
  optionalMatched: number;
  optionalTotal: number;
} {
  return {
    requiredMatched: REQUIRED_COLUMNS.filter((column) => mapping.index[column] !== null).length,
    requiredTotal: REQUIRED_COLUMNS.length,
    optionalMatched: OPTIONAL_COLUMNS.filter((column) => mapping.index[column] !== null).length,
    optionalTotal: OPTIONAL_COLUMNS.length,
  };
}
