import { getExportRebateRateSync } from './taxRebateRates';

export interface TaxRebateInput {
  hsCode: string;
  description?: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  currency?: 'USD' | 'CNY';
  exchangeRate?: number;
}

export interface TaxRebateItemResult {
  hsCode: string;
  description: string;
  exportRate: number;
  vatRate: number;
  quantity: number;
  unit: string;
  fobAmountCNY: number;
  taxRebateAmount: number;
  nonRefundableAmount: number;
  category: string;
  note?: string;
}

export interface TaxRebateResult {
  items: TaxRebateItemResult[];
  totalFobCNY: number;
  totalRebate: number;
  totalNonRefundable: number;
  exchangeRate: number;
  itemCount: number;
  calculatedAt: string;
}

const DEFAULT_EXCHANGE_RATE = 7.1;

export function calculateTaxRebate(
  items: TaxRebateInput[],
  exchangeRate: number = DEFAULT_EXCHANGE_RATE,
): TaxRebateResult {
  const results: TaxRebateItemResult[] = [];

  for (const item of items) {
    const rateInfo = getExportRebateRateSync(item.hsCode);
    const rate = item.currency === 'CNY' ? 1 : (item.exchangeRate || exchangeRate);

    const fobAmountCNY = item.quantity * item.unitPrice * rate;
    const taxRebateAmount = Math.round(fobAmountCNY * rateInfo.rate / 100 * 100) / 100;
    const nonRefundableAmount = Math.round(fobAmountCNY * (rateInfo.vatRate - rateInfo.rate) / 100 * 100) / 100;

    const note = rateInfo.rate === 0
      ? `${rateInfo.description} — 不退税，出口需缴纳${rateInfo.vatRate}%增值税`
      : rateInfo.rate < rateInfo.vatRate
        ? `${rateInfo.description} — 差额${(rateInfo.vatRate - rateInfo.rate)}%转入成本`
        : undefined;

    results.push({
      hsCode: item.hsCode,
      description: item.description || rateInfo.description || item.hsCode,
      exportRate: rateInfo.rate,
      vatRate: rateInfo.vatRate,
      quantity: item.quantity,
      unit: item.unit,
      fobAmountCNY: Math.round(fobAmountCNY * 100) / 100,
      taxRebateAmount,
      nonRefundableAmount,
      category: rateInfo.category,
      note,
    });
  }

  return {
    items: results,
    totalFobCNY: Math.round(results.reduce((s, r) => s + r.fobAmountCNY, 0) * 100) / 100,
    totalRebate: Math.round(results.reduce((s, r) => s + r.taxRebateAmount, 0) * 100) / 100,
    totalNonRefundable: Math.round(results.reduce((s, r) => s + r.nonRefundableAmount, 0) * 100) / 100,
    exchangeRate,
    itemCount: results.length,
    calculatedAt: new Date().toISOString(),
  };
}
