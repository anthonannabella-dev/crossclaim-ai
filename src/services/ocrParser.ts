import { env } from '../config/env';
import {
  DeclarationData,
  CustomsMode,
  CUSTOMS_MODE_INFO,
  DeliveryMethod,
  runPreCheck,
  PreCheckResult,
  getXmlGenerator,
} from './declarationBuilder';

// ============================================================
// OCR 智能字段提取：扫描件/照片 → DeclarationData 结构化字段
// ============================================================

export async function extractFieldsFromOCR(
  ocrText: string,
  fileName?: string,
  targetMode?: CustomsMode
): Promise<Partial<DeclarationData>> {
  const config = env();
  if (!config.DEEPSEEK_API_KEY || config.DEEPSEEK_API_KEY.length < 10) {
    throw new Error('DEEPSEEK_API_KEY not configured');
  }

  const { completionJSON } = await import('./ai/deepseek');

  let modeInstruction = '';
  if (targetMode && targetMode !== 'normal') {
    const cfg = CUSTOMS_MODE_INFO[targetMode];
    modeInstruction = `\n\u7533\u62a5\u6a21\u5f0f: ${cfg.label} (${cfg.supervisionCode})\n\u9700\u8981\u63d0\u53d6\u7684\u5b57\u6bb5: ${cfg.requiredFields.join(', ')}\n`;
  }

  const prompt = `\u4f60\u662f\u4e00\u4f4d\u6d77\u5173\u62a5\u5173\u5355\u6570\u636e\u5f55\u5165\u4e13\u5bb6\u3002\u8bf7\u4ece\u4ee5\u4e0bOCR\u8bc6\u522b\u7684\u626b\u63cf\u4ef6\u6587\u672c\u4e2d\uff0c\u63d0\u53d6\u5e76\u6574\u7406\u51fa\u7ed3\u6784\u5316\u7684\u62a5\u5173\u5355\u6570\u636e\u3002

${modeInstruction}

\u8bf7\u4e25\u683c\u6309\u7167\u4ee5\u4e0bJSON\u683c\u5f0f\u8fd4\u56de\uff0c\u672a\u8bc6\u522b\u5230\u7684\u5b57\u6bb5\u8bbe\u4e3anull\u6216\u7a7a\u6570\u7ec4\uff1a

{
  "declarant": "\u7533\u62a5\u5355\u4f4d\u5168\u79f0",
  "declarantCode": "10\u4f4d\u6d77\u5173\u7f16\u7801",
  "importerExporter": "\u8fdb\u51fa\u53e3\u5546\u540d\u79f0",
  "transportMode": "\u6d77\u8fd0|\u7a7a\u8fd0|\u9646\u8fd0|\u94c1\u8def",
  "vesselFlight": "\u8239\u540d/\u822a\u73ed\u53f7",
  "portOfLoading": "\u8d77\u8fd0\u6e2f",
  "portOfDischarge": "\u76ee\u7684\u6e2f",
  "portOfEntry": "\u5165\u5883\u53e3\u5cb8",
  "tradeTerms": "FOB|CIF|CFR|EXW|DDP|DAP",
  "currency": "USD|EUR|CNY|JPY|KRW|HKD",
  "contractNo": "\u5408\u540c\u53f7",
  "licenseNo": "\u8bb8\u53ef\u8bc1\u53f7",
  "billOfLading": "\u63d0\u5355\u53f7",
  "containerNo": "\u96c6\u88c5\u7bb1\u53f7",
  "packageType": "\u5305\u88c5\u79cd\u7c7b",
  "grossWeight": "\u6bdb\u91cd\u6570\u5b57",
  "netWeight": "\u51c0\u91cd\u6570\u5b57",
  "packageCount": "\u4ef6\u6570",
  "dutyMode": "\u5f81\u7a0e\u65b9\u5f0f",
  "taxPreference": "\u7a0e\u6536\u4f18\u60e0\u7c7b\u578b",
  "purpose": "\u7528\u9014",
  "orderNo": "\u8ba2\u5355\u53f7\uff08\u8de8\u5883\u7535\u5546\u7528\uff09",
  "paymentNo": "\u652f\u4ed8\u6d41\u6c34\u53f7\uff08\u8de8\u5883\u7535\u5546\u7528\uff09",
  "logisticsNo": "\u7269\u6d41\u8fd0\u5355\u53f7",
  "ecommercePlatform": "\u7535\u5546\u5e73\u53f0\u540d\u79f0",
  "ecommercePlatformCode": "\u7535\u5546\u5e73\u53f0\u4ee3\u7801",
  "deliveryMethod": "\u914d\u9001\u65b9\u5f0f",
  "bondedWarehouseId": "\u4fdd\u7a0e\u4ed3\u4ee3\u7801",
  "bondedWarehouseName": "\u4fdd\u7a0e\u4ed3\u540d\u79f0",
  "consumerName": "\u6d88\u8d39\u8005\u59d3\u540d",
  "consumerIdType": "\u6d88\u8d39\u8005\u8bc1\u4ef6\u7c7b\u578b",
  "consumerIdNumber": "\u6d88\u8d39\u8005\u8bc1\u4ef6\u53f7\u7801",
  "consumerPhone": "\u6d88\u8d39\u8005\u7535\u8bdd",
  "items": [
    {
      "hsCode": "HS\u7f16\u7801\uff088-10\u4f4d\uff09",
      "description": "\u5546\u54c1\u540d\u79f0\u53ca\u89c4\u683c",
      "quantity": "\u6570\u91cf",
      "unit": "\u5355\u4f4d",
      "unitPrice": "\u5355\u4ef7",
      "totalPrice": "\u603b\u4ef7",
      "currency": "\u5e01\u79cd",
      "originCountry": "\u539f\u4ea7\u56fd\uff08\u4e24\u4f4d\u56fd\u5bb6\u4ee3\u7801\uff09"
    }
  ]
}

\u91cd\u8981\u89c4\u5219\uff1a
1. \u53ea\u8fd4\u56deJSON\uff0c\u4e0d\u8981\u89e3\u91ca
2. \u6ca1\u6709\u627e\u5230\u7684\u5b57\u6bb5\u8bbe\u4e3anull
3. \u5e01\u79cd\u7edf\u4e00\u7528\u4e09\u4f4d\u5b57\u6bcd\u4ee3\u7801
4. HS\u7f16\u7801\u4fdd\u7559\u539f\u683c\u5f0f\uff08\u59828471.30\uff09
5. \u5546\u54c1\u660e\u7ec6\u4ece\u53d1\u7968/\u88c5\u7bb1\u5355\u4e2d\u63d0\u53d6
6. \u6570\u5b57\u5b57\u6bb5\u53ea\u8fd4\u56de\u6570\u5b57\uff0c\u4e0d\u8981\u5e26\u5355\u4f4d\u6587\u5b57

OCR\u6587\u672c\u5185\u5bb9\uff1a
"""
${ocrText.slice(0, 8000)}
"""`;

  const result = await completionJSON<Partial<DeclarationData>>(prompt, {
    model: 'deepseek-chat',
    temperature: 0.1,
    maxTokens: 4000,
  });
  if (!result) {
    throw new Error('AI \\u89e3\\u6790\\u65e0\\u8fd4\\u56de\\u6216\\u683c\\u5f0f\\u5f02\\u5e38');
  }
  return result;
}
export async function ocrToDeclaration(
  ocrText: string,
  fileName?: string,
  targetMode?: CustomsMode
): Promise<{
  parsed: Partial<DeclarationData>;
  xmlContent?: string;
  preCheck?: PreCheckResult;
}> {
  const parsed = await extractFieldsFromOCR(ocrText, fileName, targetMode);

  if (parsed.items && parsed.items.length > 0) {
    const mode = targetMode || 'normal';
    const modeCfg = CUSTOMS_MODE_INFO[mode];

    const declaration: DeclarationData = {
      declarant: parsed.declarant || 'OCR\u8bc6\u522b',
      importerExporter: parsed.importerExporter || '',
      transportMode: parsed.transportMode || '\u6d77\u8fd0',
      vesselFlight: parsed.vesselFlight || '',
      portOfLoading: parsed.portOfLoading || '',
      portOfDischarge: parsed.portOfDischarge || '',
      portOfEntry: parsed.portOfEntry || '',
      tradeTerms: parsed.tradeTerms || 'FOB',
      currency: parsed.currency || 'USD',
      items: (parsed.items || []).map((item: any, i: number) => ({
        itemNo: i + 1,
        hsCode: item.hsCode || '',
        description: item.description || '',
        quantity: item.quantity || 1,
        unit: item.unit || '\u4ef6',
        unitPrice: item.unitPrice || 0,
        totalPrice: item.totalPrice || (item.unitPrice || 0) * (item.quantity || 1),
        currency: item.currency || parsed.currency || 'USD',
        originCountry: item.originCountry || 'CN',
        tariffRate: null,
        ftaRate: null,
        ftaName: null,
      })),
      documents: [],
      totalValue: (parsed.items || []).reduce((s: number, i: any) =>
        s + (i.totalPrice || (i.unitPrice || 0) * (i.quantity || 1)), 0),
      customsMode: mode,
      supervisionCode: modeCfg.supervisionCode,
      taxMethod: modeCfg.taxMethod,
      contractNo: parsed.contractNo,
      licenseNo: parsed.licenseNo,
      billOfLading: parsed.billOfLading,
      containerNo: parsed.containerNo,
      packageType: parsed.packageType,
      grossWeight: parsed.grossWeight,
      netWeight: parsed.netWeight,
      packageCount: parsed.packageCount,
      dutyMode: parsed.dutyMode,
      taxPreference: parsed.taxPreference,
      purpose: parsed.purpose,
      orderNo: parsed.orderNo,
      paymentNo: parsed.paymentNo,
      logisticsNo: parsed.logisticsNo,
      ecommercePlatform: parsed.ecommercePlatform,
      ecommercePlatformCode: parsed.ecommercePlatformCode,
      deliveryMethod: parsed.deliveryMethod as DeliveryMethod | undefined,
      bondedWarehouseId: parsed.bondedWarehouseId,
      bondedWarehouseName: parsed.bondedWarehouseName,
      consumerName: parsed.consumerName,
      consumerIdType: parsed.consumerIdType,
      consumerIdNumber: parsed.consumerIdNumber,
      consumerPhone: parsed.consumerPhone,
    };

    const preCheck = runPreCheck(declaration);
    const xmlGenerator = getXmlGenerator(mode);
    const xmlContent = xmlGenerator(declaration);

    return { parsed, preCheck, xmlContent };
  }

  return { parsed };
}
