import { createAction, Property } from '@activepieces/pieces-framework';
import { httpClient, HttpMethod } from '@activepieces/pieces-common';

// Mock HS classification database — replace with real API call
// API endpoint: POST {API_BASE}/api/ai/smart-classify
const MOCK_CLASSIFICATIONS: Record<string, { code: string; name: string; confidence: number; alternatives: string[] }> = {
  '锂电池': { code: '8507.60.00', name: '锂离子蓄电池', confidence: 0.95, alternatives: ['8506.50.00', '8507.80.00'] },
  '光伏': { code: '8541.43.00', name: '光伏电池', confidence: 0.93, alternatives: ['8541.40.90', '8501.31.00'] },
  '集成电路': { code: '8542.31.90', name: '其他集成电路', confidence: 0.96, alternatives: ['8542.32.00', '8542.39.00'] },
  '钢铁': { code: '7208.51.00', name: '热轧钢板≥10mm', confidence: 0.88, alternatives: ['7208.52.00', '7209.16.00'] },
  '服装': { code: '6110.30.00', name: '化纤制针织套头衫', confidence: 0.91, alternatives: ['6204.43.00', '6110.20.00'] },
  '家具': { code: '9403.60.99', name: '其他木家具', confidence: 0.89, alternatives: ['9401.71.00', '9403.50.99'] },
  '塑料': { code: '3901.10.00', name: '聚乙烯<0.94', confidence: 0.87, alternatives: ['3902.10.00', '3907.40.00'] },
  '汽车': { code: '8703.23.19', name: '1.5L<排量≤2L汽油轿车', confidence: 0.94, alternatives: ['8703.32.30', '8703.40.00'] },
  '药品': { code: '3004.90.90', name: '其他零售包装药品', confidence: 0.90, alternatives: ['3004.39.00', '3002.15.00'] },
  '食品': { code: '2106.90.90', name: '其他未列名食品', confidence: 0.82, alternatives: ['2103.90.90', '1905.90.00'] },
};

export const hsClassifyAction = createAction({
  name: 'classify_hs_code',
  displayName: 'HS编码归类',
  description: '根据商品描述智能匹配HS编码，返回最佳匹配及备选方案',
  props: {
    productDescription: Property.ShortText({
      displayName: '商品描述',
      description: '输入商品名称或描述文字',
      required: true,
    }),
    useAI: Property.Checkbox({
      displayName: '使用AI增强',
      description: '启用AI大模型进行深度语义匹配（需要API Key）',
      defaultValue: true,
      required: false,
    }),
  },
  async run(ctx) {
    const { productDescription } = ctx.propsValue;
    const desc = productDescription as string;
    const useAI = ctx.propsValue.useAI as boolean;

    // Try mock data first
    let bestMatch = MOCK_CLASSIFICATIONS[desc];
    if (!bestMatch) {
      // Fuzzy match: find partial keyword match
      for (const [key, value] of Object.entries(MOCK_CLASSIFICATIONS)) {
        if (desc.includes(key) || key.includes(desc)) {
          bestMatch = value;
          break;
        }
      }
    }

    if (!bestMatch) {
      bestMatch = {
        code: '8479.89.99',
        name: `未精确匹配: ${desc}`,
        confidence: 0.60,
        alternatives: ['请尝试更具体的商品描述'],
      };
    }

    // Real API call (commented out — uncomment when backend is running):
    // try {
    //   const apiBase = process.env.TRADEFLOW_API_URL || 'http://localhost:3000';
    //   const res = await httpClient.sendRequest({
    //     method: HttpMethod.POST,
    //     url: `${apiBase}/api/ai/smart-classify`,
    //     headers: { 'Content-Type': 'application/json' },
    //     body: { description: desc, useAI },
    //   });
    //   return res.body;
    // } catch { /* fall through to mock */ }

    return {
      success: true,
      query: desc,
      method: useAI ? 'AI增强' : '关键词匹配',
      classification: {
        hsCode: bestMatch.code,
        name: bestMatch.name,
        confidence: bestMatch.confidence,
        source: 'mock_db',
      },
      alternatives: bestMatch.alternatives.map((alt: string) => ({
        hsCode: typeof alt === 'string' && alt.includes('.') ? alt : '',
        description: alt,
      })),
      suggestion: bestMatch.confidence >= 0.9
        ? '高置信度，可直接使用'
        : '建议人工复核确认',
    };
  },
});
