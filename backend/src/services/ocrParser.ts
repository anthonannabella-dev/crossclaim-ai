/**
 * OCR 识别服务 — 阿里云 OCR SDK
 * 使用 RecognizeAdvanced API 识别扫描文档、图片中的文字
 */
import prisma from '../config/database';
import {
  DeclarationData, CustomsMode, CUSTOMS_MODE_INFO, DeliveryMethod,
  runPreCheck, PreCheckResult, getXmlGenerator
} from './declarationBuilder';
import fs from 'fs';
import path from 'path';

// 阿里云 OCR Client (延迟初始化)
let ocrClient: any = null;

function getOcrClient(): any {
  if (ocrClient) return ocrClient;

  const accessKeyId = process.env.ALIYUN_OCR_ACCESS_KEY_ID;
  const accessKeySecret = process.env.ALIYUN_OCR_ACCESS_KEY_SECRET;

  if (!accessKeyId || !accessKeySecret) {
    throw new Error('阿里云 OCR 未配置: 缺少 ALIYUN_OCR_ACCESS_KEY_ID 或 ALIYUN_OCR_ACCESS_KEY_SECRET');
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Client = require('@alicloud/ocr-api20210707').default;
  ocrClient = new Client({
    accessKeyId,
    accessKeySecret,
    endpoint: 'ocr-api.cn-hangzhou.aliyuncs.com',
  });
  return ocrClient;
}

/**
 * 识别图片/扫描件中的全部文字
 */
export async function recognizeImage(imagePath: string): Promise<string> {
  const client = getOcrClient();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { RecognizeAdvancedRequest } = require('@alicloud/ocr-api20210707');

  if (!fs.existsSync(imagePath)) {
    throw new Error(`图片文件不存在: ${imagePath}`);
  }

  const request = new RecognizeAdvancedRequest();
  request.body = fs.createReadStream(imagePath);

  const response = await client.recognizeAdvanced(request);
  const data = response.body;

  if (!data || !data.content) {
    return '';
  }

  return data.content;
}

/**
 * 识别图片并提取结构化报关数据
 */
export async function parseDocument(
  imagePath: string,
  category?: string
): Promise<Partial<DeclarationData>> {
  const rawText = await recognizeImage(imagePath);
  if (!rawText.trim()) {
    return {};
  }

  if (category && ['invoice', 'packing_list', 'bill_of_lading', 'contract'].includes(category)) {
    return await extractWithAI(rawText, category);
  }

  return {} as Partial<DeclarationData>;
}

/**
 * 基于 AI (DeepSeek) 从 OCR 文本中提取结构化报关字段
 */
export async function extractWithAI(text: string, mode: string): Promise<Partial<DeclarationData>> {
  try {
    const { completion } = await import('./ai/deepseek');
    const prompt = `你是一个报关数据提取专家。从以下OCR识别文本中提取报关所需的字段信息。
文档类型: ${mode}

OCR 文本:
${text.slice(0, 8000)}

请提取以下字段(JSON格式):
{
  "items": [{"hsCode": "HS编码", "description": "商品描述", "quantity": 数量, "unit": "单位", "unitPrice": 单价, "totalPrice": 总价, "originCountry": "原产国"}],
  "totalValue": 总金额,
  "grossWeight": 毛重,
  "netWeight": 净重,
  "consignor": "发货人",
  "consignee": "收货人",
  "billOfLading": "提单号",
  "destinationPort": "目的港",
  "tradeTerms": "贸易术语"
}

只返回 JSON，不要其他文字。无法提取的字段用 null。`;

    const result = await completion(prompt, { temperature: 0.1 });
    try {
      const parsed = JSON.parse(result);
      return parsed;
    } catch {
      return { [Symbol.for('ocrRawText') as any]: text } as any;
    }
  } catch (err) {
    console.error('[ocrParser] AI 提取失败:', (err as Error).message);
    return {} as Partial<DeclarationData>;
  }
}

/**
 * AI 预检报关数据
 */
export async function aiPreCheck(declaration: DeclarationData): Promise<any> {
  try {
    const { completion } = await import('./ai/deepseek');
    const result = await completion(`检查以下报关数据的合规性：${JSON.stringify(declaration)}`, { temperature: 0.1 });
    try { return JSON.parse(result); } catch { return {}; }
  } catch {
    return {};
  }
}

export { CUSTOMS_MODE_INFO, getXmlGenerator };
