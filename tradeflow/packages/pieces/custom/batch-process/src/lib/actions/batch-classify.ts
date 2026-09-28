import { createAction, Property } from '@activepieces/pieces-framework';

const MOCK_DATA: Record<string, { code: string; name: string; confidence: number }> = {
  '锂电池': { code: '8507.60.00', name: '锂离子蓄电池', confidence: 0.95 },
  '光伏组件': { code: '8541.43.00', name: '光伏电池', confidence: 0.93 },
  '逆变器': { code: '8504.40.13', name: '逆变器', confidence: 0.97 },
  '电缆': { code: '8544.42.11', name: '带接头数据线≤80V', confidence: 0.90 },
  '电动机': { code: '8501.31.00', name: '直流电动机≤750W', confidence: 0.92 },
  '阀门': { code: '8481.80.90', name: '其他阀门', confidence: 0.89 },
  '聚丙烯': { code: '3902.10.00', name: '聚丙烯', confidence: 0.94 },
  '镀锌钢': { code: '7210.49.00', name: '镀锌钢板', confidence: 0.91 },
};

export const batchClassifyAction = createAction({
  name: 'batch_classify',
  displayName: '批量HS归类',
  description: '输入多行商品描述（每行一个），批量返回HS编码归类结果',
  props: {
    products: Property.LongText({
      displayName: '商品列表',
      description: '每行一个商品名称，如：\n锂电池\n光伏组件\n逆变器',
      required: true,
    }),
    outputFormat: Property.StaticDropdown({
      displayName: '输出格式',
      description: '选择结果格式',
      required: true,
      defaultValue: 'json',
      options: {
        options: [
          { label: 'JSON数组', value: 'json' },
          { label: 'CSV文本', value: 'csv' },
          { label: 'Markdown表格', value: 'markdown' },
        ],
      },
    }),
  },
  async run(ctx) {
    const products = (ctx.propsValue.products as string)
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);

    const results = products.map(name => {
      let match = MOCK_DATA[name];
      if (!match) {
        for (const [key, val] of Object.entries(MOCK_DATA)) {
          if (name.includes(key) || key.includes(name)) { match = val; break; }
        }
      }
      return match || { code: '8479.89.99', name: name, confidence: 0.55 };
    });

    const format = ctx.propsValue.outputFormat as string;
    if (format === 'csv') {
      const csv = ['商品名称,HS编码,商品描述,置信度',
        ...results.map(r => `${r.name},${r.code},${r.name},${r.confidence}`)].join('\n');
      return { success: true, total: results.length, format: 'csv', data: csv };
    }
    if (format === 'markdown') {
      const md = ['| 商品名称 | HS编码 | 置信度 |',
        '|----------|--------|--------|',
        ...results.map(r => `| ${r.name} | ${r.code} | ${(r.confidence * 100).toFixed(1)}% |`)].join('\n');
      return { success: true, total: results.length, format: 'markdown', data: md };
    }
    return { success: true, total: results.length, format: 'json', data: results };
  },
});
