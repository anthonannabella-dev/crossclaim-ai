import { createAction, Property } from '@activepieces/pieces-framework';

export const rcepAnalysisAction = createAction({
  name: 'rcep_analysis',
  displayName: 'RCEP深度分析',
  description: '分析RCEP框架下的原产地规则、关税减让和合规要求',
  props: {
    hsCode: Property.ShortText({
      displayName: 'HS编码',
      description: '输入完整HS编码',
      required: true,
    }),
    exportCountry: Property.StaticDropdown({
      displayName: '出口国',
      description: '选择商品出口国',
      required: true,
      defaultValue: 'CN',
      options: {
        options: [
          { label: '中国', value: 'CN' },
          { label: '日本', value: 'JP' },
          { label: '韩国', value: 'KR' },
          { label: '澳大利亚', value: 'AU' },
          { label: '新西兰', value: 'NZ' },
          { label: '东盟', value: 'ASEAN' },
        ],
      },
    }),
    importCountry: Property.StaticDropdown({
      displayName: '进口国',
      description: '选择RCEP成员进口国',
      required: true,
      defaultValue: 'JP',
      options: {
        options: [
          { label: '日本', value: 'JP' },
          { label: '中国', value: 'CN' },
          { label: '韩国', value: 'KR' },
          { label: '澳大利亚', value: 'AU' },
          { label: '新西兰', value: 'NZ' },
          { label: '东盟', value: 'ASEAN' },
        ],
      },
    }),
  },
  async run(ctx) {
    const code = (ctx.propsValue.hsCode as string).trim();
    const exportCountry = ctx.propsValue.exportCountry as string;
    const importCountry = ctx.propsValue.importCountry as string;

    // Mock RCEP analysis data
    const analysis = {
      hsCode: code,
      tradeRoute: `${exportCountry} → ${importCountry}`,
      rcepStatus: '已生效',
      baseRate: code === '8507.60.00' ? 10.0 : 6.5,
      rcepRate: code === '8507.60.00' ? 6.0 : 4.0,
      tariffReduction: code === '8507.60.00' ? 40.0 : 38.5,
      reductionSchedule: '20年内逐步降至0%',
      originCriteria: [
        '完全获得 (WO): 天然产品可直接适用',
        '区域价值成分≥40% (RVC40): 适用于加工产品',
        '税则改变 (CTH): 4位税号改变即符合',
      ],
      certificateRequired: true,
      certificateType: 'RCEP原产地证书 (Form RCEP)',
      complianceChecklist: [
        '确认商品HS编码在RCEP关税减让表中',
        '计算RVC区域价值成分≥40%',
        '准备RCEP原产地证书或经核准出口商声明',
        '保留采购发票、成本核算等证明材料至少3年',
      ],
      estimatedAnnualSavings: exportCountry === 'CN' && importCountry === 'JP'
        ? '约 US$ 15,000 / 百万美元贸易额'
        : '约 US$ 8,000 / 百万美元贸易额',
      nextReviewDate: '2027-01-01 (第五轮降税)',
    };

    return { success: true, analysis };
  },
});
