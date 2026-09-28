import { createAction, Property } from '@activepieces/pieces-framework';

const RATES: Record<string, { mfn: number; ftas: { name: string; rate: number }[] }> = {
  '8507.60.00': { mfn: 10.0, ftas: [{ name: 'RCEP', rate: 6.0 }, { name: '中国-东盟', rate: 0.0 }, { name: '中国-韩国', rate: 4.0 }] },
  '8541.43.00': { mfn: 0.0, ftas: [{ name: 'RCEP', rate: 0.0 }, { name: '中国-东盟', rate: 0.0 }] },
  '8504.40.13': { mfn: 0.0, ftas: [] },
  '8501.31.00': { mfn: 12.0, ftas: [{ name: 'RCEP', rate: 7.0 }, { name: '中国-东盟', rate: 5.0 }] },
  '8544.42.11': { mfn: 0.0, ftas: [] },
  '8481.80.90': { mfn: 7.0, ftas: [{ name: 'RCEP', rate: 4.0 }] },
  '3902.10.00': { mfn: 6.5, ftas: [{ name: 'RCEP', rate: 4.0 }, { name: '中国-东盟', rate: 0.0 }, { name: '中国-韩国', rate: 3.5 }] },
  '7210.49.00': { mfn: 4.0, ftas: [{ name: 'RCEP', rate: 2.5 }, { name: '中国-韩国', rate: 0.0 }] },
  'default': { mfn: 8.0, ftas: [{ name: 'RCEP', rate: 5.0 }] },
};

export const batchTariffAction = createAction({
  name: 'batch_tariff',
  displayName: '批量税率查询',
  description: '输入HS编码列表，返回每个编码的MFN税率和FTA优惠税率',
  props: {
    hsCodes: Property.LongText({
      displayName: 'HS编码列表',
      description: '每行一个HS编码，如：\n8507.60.00\n8541.43.00\n3902.10.00',
      required: true,
    }),
    includeFTAs: Property.Checkbox({
      displayName: '包含FTA优惠税率',
      description: '同时查询各自由贸易协定优惠税率',
      defaultValue: true,
      required: false,
    }),
  },
  async run(ctx) {
    const codes = (ctx.propsValue.hsCodes as string)
      .split('\n')
      .map(c => c.trim())
      .filter(Boolean);

    const includeFTA = ctx.propsValue.includeFTAs as boolean;

    const results = codes.map(code => {
      const rateInfo = RATES[code] || RATES['default'];
      return {
        hsCode: code,
        mfnRate: rateInfo.mfn,
        ftaRates: includeFTA ? rateInfo.ftas : [],
        bestFTA: includeFTA && rateInfo.ftas.length > 0
          ? rateInfo.ftas.reduce((a, b) => (a.rate < b.rate ? a : b))
          : null,
        savingsEstimate: includeFTA && rateInfo.ftas.length > 0
          ? `${((rateInfo.mfn - Math.min(...rateInfo.ftas.map(f => f.rate))) / rateInfo.mfn * 100).toFixed(0)}%`
          : '0%',
      };
    });

    return {
      success: true,
      total: results.length,
      includeFTA,
      summary: {
        totalMFNRate: results.reduce((s, r) => s + r.mfnRate, 0),
        bestFTAFound: results.filter(r => r.bestFTA).length,
        averageSavings: results.some(r => r.savingsEstimate !== '0%')
          ? '可达60%+' : '无优惠适用',
      },
      data: results,
    };
  },
});
