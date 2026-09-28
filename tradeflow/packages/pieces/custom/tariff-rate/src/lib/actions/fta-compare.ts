import { createAction, Property } from '@activepieces/pieces-framework';

const FTA_AGREEMENTS = [
  { name: '中国-东盟FTA', shortName: 'ASEAN', active: true },
  { name: '中国-韩国FTA', shortName: 'KOREA', active: true },
  { name: '中国-澳大利亚FTA', shortName: 'AUS', active: true },
  { name: 'RCEP', shortName: 'RCEP', active: true },
  { name: '中国-瑞士FTA', shortName: 'SWISS', active: true },
];

const FTA_RATES: Record<string, { name: string; rates: Record<string, number | null> }> = {
  '8507.60.00': { name: '锂离子蓄电池', rates: { RCEP: 6.0, ASEAN: 0.0, KOREA: 4.0, AUS: 7.0, SWISS: 8.0 } },
  '8541.43.00': { name: '光伏电池', rates: { RCEP: 0.0, ASEAN: 0.0, KOREA: 0.0, AUS: 0.0, SWISS: 0.0 } },
  '3902.10.00': { name: '聚丙烯', rates: { RCEP: 4.0, ASEAN: 0.0, KOREA: 3.5, AUS: 5.0, SWISS: 4.5 } },
  '7210.49.00': { name: '镀锌钢板', rates: { RCEP: 2.5, ASEAN: null, KOREA: 0.0, AUS: 3.0, SWISS: 3.5 } },
  '8501.31.00': { name: '直流电动机', rates: { RCEP: 7.0, ASEAN: 5.0, KOREA: 8.0, AUS: 9.0, SWISS: 10.0 } },
  'default': { name: '通用税率', rates: { RCEP: 6.0, ASEAN: 5.0, KOREA: 6.5, AUS: 7.0, SWISS: 7.5 } },
};

export const ftaCompareAction = createAction({
  name: 'compare_fta_rates',
  displayName: 'FTA税率对比',
  description: '对比所有自由贸易协定的优惠税率，找出最优方案',
  props: {
    hsCode: Property.ShortText({
      displayName: 'HS编码',
      description: '输入完整HS编码',
      required: true,
    }),
    originCountry: Property.ShortText({
      displayName: '原产国',
      description: '商品的原产国（用于筛选适用FTA）',
      required: false,
    }),
    showAll: Property.Checkbox({
      displayName: '显示全部FTA',
      description: '即使税率不可用也显示所有协议',
      defaultValue: false,
      required: false,
    }),
  },
  async run(ctx) {
    const code = (ctx.propsValue.hsCode as string).trim();
    const origin = (ctx.propsValue.originCountry as string || '').trim();
    const showAll = ctx.propsValue.showAll as boolean;

    const rateData = FTA_RATES[code] || FTA_RATES['default'];

    const comparisons = FTA_AGREEMENTS
      .filter(fta => {
        if (showAll) return true;
        const rate = rateData.rates[fta.shortName];
        return rate !== null;
      })
      .map(fta => ({
        agreement: fta.name,
        shortName: fta.shortName,
        rate: rateData.rates[fta.shortName],
        isActive: fta.active,
        isBest: false,
      }));

    // Find best rate
    const validRates = comparisons.filter(c => c.rate !== null);
    const bestRate = validRates.length > 0
      ? Math.min(...validRates.map(c => c.rate!))
      : null;

    if (bestRate !== null) {
      comparisons.forEach(c => { if (c.rate === bestRate) c.isBest = true; });
    }

    const mfnRate = rateData.name === '锂离子蓄电池' ? 10.0
      : rateData.name === '光伏电池' ? 0.0
      : rateData.name === '聚丙烯' ? 6.5
      : rateData.name === '镀锌钢板' ? 4.0
      : rateData.name === '直流电动机' ? 12.0
      : 8.0;

    return {
      success: true,
      hsCode: code,
      productName: rateData.name,
      originCountry: origin || '未指定',
      mfnRate,
      comparisons,
      summary: {
        totalFTAsChecked: FTA_AGREEMENTS.length,
        applicableFTAs: validRates.length,
        bestRate: bestRate !== null ? `${bestRate}%` : '无优惠适用',
        bestFTA: bestRate !== null
          ? comparisons.filter(c => c.rate === bestRate).map(c => c.shortName).join(', ')
          : null,
        savingsVsMFN: bestRate !== null && mfnRate > 0
          ? `${((mfnRate - bestRate) / mfnRate * 100).toFixed(0)}%`
          : '0%',
      },
    };
  },
});
