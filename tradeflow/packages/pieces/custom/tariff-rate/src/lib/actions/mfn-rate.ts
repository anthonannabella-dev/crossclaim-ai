import { createAction, Property } from '@activepieces/pieces-framework';

const MFN_RATES: Record<string, { code: string; name: string; mfn: number; unit: string; vat: number; supervision: string }> = {
  '8507.60.00': { code: '8507.60.00', name: '锂离子蓄电池', mfn: 10.0, unit: '个', vat: 13.0, supervision: '出口许可证' },
  '8541.43.00': { code: '8541.43.00', name: '光伏电池', mfn: 0.0, unit: '个', vat: 13.0, supervision: '' },
  '8504.40.13': { code: '8504.40.13', name: '逆变器', mfn: 0.0, unit: '个', vat: 13.0, supervision: '' },
  '8501.31.00': { code: '8501.31.00', name: '直流电动机≤750W', mfn: 12.0, unit: '台', vat: 13.0, supervision: '3C认证' },
  '3902.10.00': { code: '3902.10.00', name: '聚丙烯', mfn: 6.5, unit: '千克', vat: 13.0, supervision: '进口许可证' },
  '7208.51.00': { code: '7208.51.00', name: '热轧钢板≥10mm', mfn: 6.0, unit: '千克', vat: 13.0, supervision: '' },
  '7210.49.00': { code: '7210.49.00', name: '镀锌钢板', mfn: 4.0, unit: '千克', vat: 13.0, supervision: '' },
  '6110.30.00': { code: '6110.30.00', name: '化纤制针织套头衫', mfn: 6.0, unit: '件/千克', vat: 13.0, supervision: '' },
  '9403.60.99': { code: '9403.60.99', name: '其他木家具', mfn: 0.0, unit: '件', vat: 13.0, supervision: '' },
  '8542.31.90': { code: '8542.31.90', name: '其他集成电路', mfn: 0.0, unit: '个', vat: 13.0, supervision: '' },
};

export const mfnRateAction = createAction({
  name: 'query_mfn_rate',
  displayName: 'MFN税率查询',
  description: '查询指定HS编码的最惠国税率、增值税率及监管条件',
  props: {
    hsCode: Property.ShortText({
      displayName: 'HS编码',
      description: '输入完整HS编码，如 8507.60.00',
      required: true,
    }),
    declaredValue: Property.Number({
      displayName: '申报金额(USD)',
      description: '用于估算应缴税额',
      required: false,
      defaultValue: 0,
    }),
  },
  async run(ctx) {
    const code = (ctx.propsValue.hsCode as string).trim();
    const declaredValue = Number(ctx.propsValue.declaredValue) || 0;

    const rateInfo = MFN_RATES[code] || {
      code,
      name: '未在数据库中找到',
      mfn: 8.0,
      unit: '件',
      vat: 13.0,
      supervision: '请查阅最新海关公告',
    };

    const customsDuty = declaredValue > 0 ? (declaredValue * rateInfo.mfn / 100).toFixed(2) : null;
    const vatAmount = declaredValue > 0 ? (declaredValue * (1 + rateInfo.mfn / 100) * rateInfo.vat / 100).toFixed(2) : null;

    return {
      success: true,
      hsCode: code,
      classification: { name: rateInfo.name, unit: rateInfo.unit },
      tariff: {
        mfnRate: `${rateInfo.mfn}%`,
        vatRate: `${rateInfo.vat}%`,
        supervision: rateInfo.supervision || '无特殊监管',
      },
      estimatedCost: declaredValue > 0 ? {
        declaredValue: declaredValue.toFixed(2),
        customsDuty: `${customsDuty} USD`,
        vat: `${vatAmount} USD`,
        totalTax: `${(Number(customsDuty) + Number(vatAmount)).toFixed(2)} USD`,
      } : null,
      source: 'mock_db',
    };
  },
});
