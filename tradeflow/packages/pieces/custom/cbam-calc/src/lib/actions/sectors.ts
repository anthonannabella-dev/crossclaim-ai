import { createAction } from '@activepieces/pieces-framework';

export const cbamSectorAction = createAction({
  name: 'list_cbam_sectors',
  displayName: 'CBAM行业基准查询',
  description: '查询CBAM覆盖的六大行业碳排放基准值和计算参数',
  props: {},
  async run() {
    return {
      success: true,
      regulation: 'EU Regulation 2023/956',
      effectiveDate: '2023-10-01 (过渡期) / 2026-01-01 (正式征收)',
      sectors: [
        {
          name: '钢铁',
          cnCodes: ['7208', '7209', '7210', '7225'],
          directEmissions: { value: 1.8, unit: 'tCO2/t' },
          indirectEmissions: { value: 0.3, unit: 'tCO2/t' },
          benchmarkSource: 'EU ETS Benchmark Decision 2021/447',
          riskFactors: ['高碳排放', '欧盟反倾销调查风险', '建议使用电弧炉工艺降低排放'],
        },
        {
          name: '铝',
          cnCodes: ['7601', '7603', '7604', '7605', '7606'],
          directEmissions: { value: 1.5, unit: 'tCO2/t (原铝) / 0.3 tCO2/t (再生铝)' },
          indirectEmissions: { value: 6.0, unit: 'tCO2/t' },
          benchmarkSource: 'EU ETS',
          riskFactors: ['电力排放占比高', '建议使用绿电/水电铝', '再生铝可大幅降低CBAM成本'],
        },
        {
          name: '水泥',
          cnCodes: ['2523'],
          directEmissions: { value: 0.6, unit: 'tCO2/t' },
          indirectEmissions: { value: 0.05, unit: 'tCO2/t' },
          benchmarkSource: 'EU ETS',
          riskFactors: ['工艺排放为主', '替代燃料可降低排放'],
        },
        {
          name: '化肥',
          cnCodes: ['3102', '3103', '3104', '3105'],
          directEmissions: { value: 1.6, unit: 'tCO2/t (氨) / 0.2 tCO2/t (尿素)' },
          indirectEmissions: { value: 0.4, unit: 'tCO2/t' },
          benchmarkSource: 'EU ETS Product Benchmarks',
          riskFactors: ['天然气原料排放高', '绿氨技术可大幅降低'],
        },
        {
          name: '氢',
          cnCodes: ['2804'],
          directEmissions: { value: 9.0, unit: 'tCO2/t (灰氢) / 0 tCO2/t (绿氢)' },
          indirectEmissions: { value: 2.0, unit: 'tCO2/t' },
          benchmarkSource: 'EU Renewable Energy Directive',
          riskFactors: ['灰氢成本极高', '绿氢/蓝氢可豁免CBAM', '需提供可再生能源证明'],
        },
        {
          name: '电力',
          cnCodes: ['2716'],
          directEmissions: { value: 0.5, unit: 'tCO2/MWh (中国电网平均)' },
          indirectEmissions: { value: 0.0, unit: 'tCO2/MWh' },
          benchmarkSource: 'IEA 2023 Emissions Factors',
          riskFactors: ['电网排放因子按中国平均值计算', '绿电PPA可降低排放因子'],
        },
      ],
      disclaimer: '以上数据为行业基准值。实际排放数据以企业碳核查报告为准。CBAM过渡期内可使用默认值。',
    };
  },
});
