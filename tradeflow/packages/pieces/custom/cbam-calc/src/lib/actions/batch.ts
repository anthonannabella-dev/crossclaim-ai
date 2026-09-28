import { createAction, Property } from '@activepieces/pieces-framework';

export const cbamBatchAction = createAction({
  name: 'batch_cbam',
  displayName: '批量CBAM计算',
  description: '批量输入多个HS编码和出口量，一次性计算CBAM碳关税成本',
  props: {
    inputData: Property.LongText({
      displayName: '批量数据',
      description: '每行一个：HS编码,出口量(吨)\n例：\n7208,500\n7601,200\n2523,1000',
      required: true,
    }),
    carbonPrice: Property.Number({
      displayName: '欧盟碳价(€/tCO2)',
      defaultValue: 80,
      required: false,
    }),
  },
  async run(ctx) {
    const lines = (ctx.propsValue.inputData as string)
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean);

    const carbonPrice = Number(ctx.propsValue.carbonPrice) || 80;

    const sectorMap: Record<string, { sector: string; emissions: number }> = {
      '72': { sector: '钢铁', emissions: 2.1 },
      '76': { sector: '铝', emissions: 7.5 },
      '25': { sector: '水泥', emissions: 0.65 },
      '31': { sector: '化肥', emissions: 2.0 },
      '28': { sector: '氢', emissions: 11.0 },
      '27': { sector: '电力', emissions: 0.5 },
    };

    const results = lines.map(line => {
      const [code, weightStr] = line.split(/[,\s]+/);
      const weight = parseFloat(weightStr) || 0;
      const chapter = code.replace(/[^0-9]/g, '').slice(0, 2);
      const sector = sectorMap[chapter] || { sector: '其他', emissions: 1.0 };

      const emissions = weight * sector.emissions;
      const cost = emissions * carbonPrice;

      return {
        hsCode: code,
        sector: sector.sector,
        weightTons: weight,
        emissionsTons: emissions.toFixed(1),
        estimatedCostEUR: `€${cost.toLocaleString()}`,
        riskLevel: cost > 100000 ? 'HIGH' : cost > 10000 ? 'MEDIUM' : 'LOW',
      };
    });

    const totalCost = results.reduce((s, r) => {
      const cost = parseFloat(r.estimatedCostEUR.replace(/[€,]/g, ''));
      return s + (isNaN(cost) ? 0 : cost);
    }, 0);

    return {
      success: true,
      totalItems: results.length,
      totalEstimatedCost: `€${totalCost.toLocaleString()}`,
      carbonPrice: `€${carbonPrice}/tCO2`,
      data: results,
      summary: {
        highRiskCount: results.filter(r => r.riskLevel === 'HIGH').length,
        mediumRiskCount: results.filter(r => r.riskLevel === 'MEDIUM').length,
        lowRiskCount: results.filter(r => r.riskLevel === 'LOW').length,
      },
    };
  },
});
