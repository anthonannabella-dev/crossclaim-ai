import type { RecoveryChannel } from '@prisma/client';
import type { ColumnMapping } from './types';

/**
 * 三类起步渠道的默认列映射。
 *
 * ⚠️ 这些名字来自各家常见导出格式，但**客户实际表头可能不同**。
 * 表头不匹配时导入不会静默成功：适配器会把无法识别的行计入 skipped 并给出原因，
 * 同时把命中的列名下标回传（resolvedColumns），便于快速定位"客户换表头了"。
 */
export const DEFAULT_MAPPINGS: Partial<Record<RecoveryChannel, ColumnMapping>> = {
  // UPS 结算/发票明细
  UPS: {
    sourceRef: ['Tracking Number', 'Tracking No', 'TrackingNumber', 'Tracking #', '参考号', '运输单号', '追踪号'],
    occurredAt: ['Shipment Date', 'Invoice Date', 'Date', '发件日期', '账单日期', '日期'],
    amountActual: ['Net Charge', 'Net Amount', 'Billed Amount', 'Charge', '净费用', '计费金额', '金额'],
    currency: ['Currency Code', 'Currency', '币制', '币种'],
    signalType: ['Service', 'Charge Description', '服务', '费用说明'],
  },

  // FedEx 账单/发票明细
  FEDEX: {
    sourceRef: ['Tracking Number', 'Express or Ground Tracking ID', 'Tracking ID', 'Parcel Tracking Number', '追踪号', '运单号'],
    occurredAt: ['Ship Date', 'Invoice Date', 'Date', '发件日期', '账单日期', '日期'],
    amountActual: ['Net Charge Amount', 'Net Charge', 'Total Charges', 'Charge Amount', '净费用', '金额'],
    currency: ['Currency', 'Currency Code', '币制', '币种'],
    signalType: ['Service Type', 'Charge Description', '服务类型', '费用说明'],
  },

  // Amazon 平台报表（赔付/费用预览/调整）
  AMAZON: {
    sourceRef: ['reimbursement-id', 'shipment-id', 'order-id', 'settlement-id', 'adjustment-id', '交易编号', '订单号'],
    occurredAt: ['approval-date', 'posted-date', 'shipment-date', 'date', '日期', '发生日期'],
    amountExpected: ['amount-total', 'expected-amount', 'estimated-reimbursement', '应赔金额', '预期金额'],
    amountActual: ['amount', 'reimbursement-amount', 'total', '实际金额', '赔付金额'],
    currency: ['currency', 'currency-code', '币制', '币种'],
    signalType: ['reason', 'adjustment-type', 'transaction-type', '原因', '调整类型'],
  },
};

/** 各渠道默认的漏损类型（当文件里没有可用的类型列时使用） */
export const DEFAULT_SIGNAL_TYPE: Partial<Record<RecoveryChannel, string>> = {
  UPS: 'FREIGHT_CHARGE_MISBILL',
  FEDEX: 'FREIGHT_CHARGE_MISBILL',
  AMAZON: 'PLATFORM_ADJUSTMENT',
  FREIGHT: 'FREIGHT_CHARGE',
  INSURANCE: 'INSURANCE_CLAIM',
  CUSTOMS: 'DUTY_OVERPAID',
  OTHER: 'UNCLASSIFIED',
};

/** 表头行匹配时忽略大小写、空白与常见分隔符差异 */
export function normalizeHeader(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_\-.]/g, '');
}

/**
 * 在表头里找出目标字段对应的列下标。
 * 先精确匹配（忽略大小写/空白），再退化为包含匹配 —— 客户表头常带后缀，如 "Net Charge (USD)"。
 */
export function resolveColumns(
  header: unknown[],
  mapping: ColumnMapping,
): Record<string, number> {
  const normalizedHeader = header.map(normalizeHeader);
  const resolved: Record<string, number> = {};

  // 注意：不要用 Object.entries(mapping) —— 对没有索引签名的 interface，
  // TS 会把它退化成 [string, any][]，导致下面的回调参数丢失类型。
  const targets = Object.keys(mapping) as (keyof ColumnMapping)[];

  for (const target of targets) {
    const candidates = mapping[target];
    if (!candidates || candidates.length === 0) continue;

    const wanted: string[] = candidates.map((c) => normalizeHeader(c)).filter((s) => s !== '');

    let idx = normalizedHeader.findIndex((h) => h !== '' && wanted.includes(h));
    if (idx < 0) {
      idx = normalizedHeader.findIndex(
        (h) => h !== '' && wanted.some((w) => h.includes(w) || w.includes(h)),
      );
    }
    if (idx >= 0) resolved[target] = idx;
  }

  return resolved;
}

/** 取某渠道的生效映射（默认 + 客户覆盖） */
export function mergeMapping(
  channel: RecoveryChannel,
  override?: ColumnMapping,
): ColumnMapping {
  const base = DEFAULT_MAPPINGS[channel] ?? {};
  if (!override) return base;
  return { ...base, ...override };
}

