import { createAction, Property } from '@activepieces/pieces-framework';

const SECTOR_DEFAULTS: Record<string, { name: string; directEmissions: number; indirectEmissions: number; unit: string }> = {
  steel: { name: '钢铁', directEmissions: 1.8, indirectEmissions: 0.3, unit: '吨CO2/吨产品' },
  aluminum: { name: '铝', directEmissions: 8.5, indirectEmissions: 6.0, unit: '吨CO2/吨产品' },
  cement: { name: '水泥', directEmissions: 0.6, indirectEmissions: 0.05, unit: '吨CO2/吨产品' },
  fertilizer: { name: '化肥', directEmissions: 1.6, indirectEmissions: 0.4, unit: '吨CO2/吨产品' },
  hydrogen: { name: '氢', directEmissions: 9.0, indirectEmissions: 2.0, unit: '吨CO2/吨产品' },
  electricity: { name: '电力', directEmissions: 0.5, indirectEmissions: 0.0, unit: '吨CO2/MWh' },
};

export const cbamCalculateAction = createAction({
  name: 'calculate_cbam',
  displayName: 'CBAM碳关税计算',
  description: '根据HS编码、行业和出口量计算预估碳关税成本',
  props: {
    sector: Property.StaticDropdown({
      displayName: '行业类别',
      description: '选择CBAM覆盖的行业',
      required: true,
      defaultValue: 'steel',
      options: {
        options: [
          { label: '钢铁', value: 'steel' },
          { label: '铝', value: 'aluminum' },
          { label: '水泥', value: 'cement' },
          { label: '化肥', value: 'fertilizer' },
          { label: '氢', value: 'hydrogen' },
          { label: '电力', value: 'electricity' },
        ],
      },
    }),
    exportWeight: Property.Number({
      displayName: '出口总量(吨)',
      description: '年度预计对欧盟出口量（吨）',
      required: true,
      defaultValue: 1000,
    }),
    euCarbonPrice: Property.Number({
      displayName: '欧盟碳价(€/吨CO2)',
      description: '当前EU ETS碳配额价格，默认80€',
      required: false,
      defaultValue: 80,
    }),
    knownEmissions: Property.Number({
      displayName: '已知碳排放(吨CO2)',
      description: '如果知道实际排放数据可填写，留空则使用行业默认值',
      required: false,
    }),
  },
  async run(ctx) {
    const sectorKey = ctx.propsValue.sector as string;
    const weight = Number(ctx.propsValue.exportWeight) || 0;
    const carbonPrice = Number(ctx.propsValue.euCarbonPrice) || 80;
    const knownEmissions = ctx.propsValue.knownEmissions as number | undefined;

    const sector = SECTOR_DEFAULTS[sectorKey] || SECTOR_DEFAULTS['steel'];
    const totalEmissionsPerUnit = sector.directEmissions + sector.indirectEmissions;
    const totalEmissions = knownEmissions || (weight * totalEmissionsPerUnit);

    const estimatedCost = totalEmissions * carbonPrice;
    const freeAllowance = weight * sector.directEmissions * 0.03; // 2026: 97% paid, 3% free
    const effectiveCost = (totalEmissions - freeAllowance) * carbonPrice;

    return {
      success: true,
      calculation: {
        sector: sector.name,
        quantity: `${weight} 吨`,
        euCarbonPrice: `€${carbonPrice}/吨CO2`,
        emissions: {
          direct: `${(weight * sector.directEmissions).toFixed(1)} 吨CO2`,
          indirect: `${(weight * sector.indirectEmissions).toFixed(1)} 吨CO2`,
          total: `${totalEmissions.toFixed(1)} 吨CO2`,
        },
        costs: {
          grossCost: `€${estimatedCost.toLocaleString()}`,
          freeAllowance: `€${(freeAllowance * carbonPrice).toLocaleString()}`,
          effectiveCost: `€${effectiveCost.toLocaleString()}`,
          perTonCost: `€${(effectiveCost / weight).toFixed(2)}/吨`,
        },
        riskLevel: effectiveCost > 500000 ? '高' : effectiveCost > 100000 ? '中' : '低',
      },
      regulatoryInfo: {
        reportingPeriod: '季度报告（次年1/4/7/10月提交）',
        deadline: '报告期结束后1个月内',
        penaltyRisk: '未报告罚款 €10-50/吨CO2',
        nextMilestone: '2026年1月起全面征收，取消免费配额过渡',
      },
    };
  },
});
