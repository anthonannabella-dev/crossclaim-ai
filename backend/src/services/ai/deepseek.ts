import OpenAI from 'openai';
import pLimit from 'p-limit';
import { env } from '../../config/env';
import { cacheGet, cacheSet } from '../../config/redis';
import { logger } from '../../config/logger';

// ── 全局并发限流 ─────────────────────────────────────────
const concurrencyLimit = pLimit(5);

// ── 单例 client ──────────────────────────────────────────
let client: OpenAI | null = null;

export function getClient(): OpenAI {
  if (!client) {
    const config = env();
    client = new OpenAI({
      apiKey: config.DEEPSEEK_API_KEY || '***',
      baseURL: 'https://api.deepseek.com/v1',
      timeout: 30_000,
      maxRetries: 0,
    });
  }
  return client;
}

// ── 共用请求 helper ─────────────────────────────────────
interface CompletionOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: 'json_object' | 'text';
  cacheTTL?: number;
  cacheNs?: string;
}

const DEFAULT_OPTS: CompletionOptions = {
  model: 'deepseek-chat',
  temperature: 0.3,
  maxTokens: 1000,
  responseFormat: 'text',
  cacheTTL: 0,
  cacheNs: 'default',
};

export async function completion(
  prompt: string,
  opts: CompletionOptions = {},
): Promise<string> {
  const { model, temperature, maxTokens, responseFormat, cacheTTL, cacheNs } = {
    ...DEFAULT_OPTS,
    ...opts,
  };
  const config = env();
  if (!config.DEEPSEEK_API_KEY) {
    logger.warn('[DeepSeek] DEEPSEEK_API_KEY not configured');
    return '';
  }

  const cacheKey = cacheTTL ? `ai:${cacheNs}:${hashStr(prompt)}` : null;
  if (cacheKey) {
    const cached = await cacheGet(cacheKey);
    if (cached !== null) {
      logger.debug('[DeepSeek] cache hit: %s', cacheKey.slice(0, 60));
      return cached;
    }
  }

  const result = await concurrencyLimit(async () => {
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await getClient().chat.completions.create({
          model: model!,
          messages: [{ role: 'user', content: prompt }],
          temperature,
          max_tokens: maxTokens,
          ...(responseFormat === 'json_object' ? { response_format: { type: 'json_object' as const } } : {}),
        });
        const text = response.choices[0]?.message?.content || '';
        logger.debug('[DeepSeek] success (attempt %d): %s chars', attempt + 1, text.length);

        if (cacheKey && cacheTTL) {
          await cacheSet(cacheKey, text, cacheTTL).catch(() => {});
        }
        return text;
      } catch (err: any) {
        lastErr = err;
        const status = err?.status || err?.response?.status;
        const isRateLimit = status === 429 || (err?.message || '').includes('rate limit');

        if (isRateLimit && attempt < 2) {
          const wait = Math.min(1000 * Math.pow(2, attempt), 4000);
          logger.warn('[DeepSeek] 429 rate limit, retrying in %dms (attempt %d/3)', wait, attempt + 2);
          await sleep(wait);
          continue;
        }

        logger.error('[DeepSeek] request failed: %s', err?.message || err);
        return '';
      }
    }
    logger.error('[DeepSeek] all 3 attempts exhausted: %s', lastErr?.message);
    return '';
  });

  return result;
}

export async function completionJSON<T = any>(
  prompt: string,
  opts: CompletionOptions = {},
): Promise<T | null> {
  const text = await completion(prompt, { ...opts, responseFormat: 'json_object' });
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    logger.error('[DeepSeek] JSON parse failed, raw: %s', text.slice(0, 200));
    return null;
  }
}

function hashStr(s: string): string {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    hash = ((hash << 5) - hash) + ch;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ============================================================
// 原有业务函数
// ============================================================

export async function classifyHSCode(description: string): Promise<{
  hsCode: string;
  classification: string;
  confidence: number;
  alternatives: { code: string; desc: string }[];
  source: string;
  suggestion: string;
}> {
  const prompt = `你是一位资深海关归类专家。请根据以下商品描述进行HS编码归类:

商品描述: ${description}

请返回JSON格式:
{
  "hsCode": "主要推荐的HS编码(如8471.30)",
  "classification": "归类说明",
  "confidence": 0.0-1.0的置信度,
  "alternatives": [{"code": "备选HS编码", "desc": "备选说明"}],
  "source": "政策依据(海关总署公告号/RCEP协定条款)",
  "suggestion": "人工复核建议"
}

注意:
- 如果置信度低于0.8, 必须标注需要人工复核
- 政策来源必须引用具体公告号
- 不要编造不存在的HS编码`;

  const result = await completionJSON<{
    hsCode?: string;
    classification?: string;
    confidence?: number;
    alternatives?: { code: string; desc: string }[];
    source?: string;
    suggestion?: string;
  }>(prompt, {
    model: 'deepseek-chat',
    temperature: 0.3,
    maxTokens: 1000,
    cacheNs: `classify:${hashStr(description)}`,
    cacheTTL: 86_400,
  });

  return {
    hsCode: result?.hsCode || '',
    classification: result?.classification || '',
    confidence: result?.confidence ?? 0.5,
    alternatives: result?.alternatives || [],
    source: result?.source || '',
    suggestion: result?.suggestion || '建议人工复核',
  };
}

export async function analyzeRCEP(hsCode: string, destinationCountry: string): Promise<{
  originCriteria: string;
  appliedRate: number;
  savings: string;
  analysis: string;
  source: string;
}> {
  const countryNames: Record<string, string> = {
    JP: '日本', KR: '韩国', AU: '澳大利亚', NZ: '新西兰', ASEAN: '东盟',
  };

  const prompt = `分析HS编码 ${hsCode} 出口到${countryNames[destinationCountry] || destinationCountry}的RCEP最优关税:

请返回JSON:
{
  "originCriteria": "适用的原产地规则",
  "appliedRate": 适用税率百分比,
  "savings": "相比最惠国税率的节省说明",
  "analysis": "详细分析和建议",
  "source": "RCEP协定具体条款引用"
}`;

  const result = await completionJSON<{
    originCriteria?: string;
    appliedRate?: number;
    savings?: string;
    analysis?: string;
    source?: string;
  }>(prompt, {
    model: 'deepseek-chat',
    temperature: 0.3,
    maxTokens: 800,
    cacheNs: `rcep:${hsCode}:${destinationCountry}`,
    cacheTTL: 86_400,
  });

  return {
    originCriteria: result?.originCriteria || '请查看RCEP协定附件',
    appliedRate: result?.appliedRate ?? 0,
    savings: result?.savings || 'AI分析暂不可用',
    analysis: result?.analysis || '',
    source: result?.source || 'RCEP协定',
  };
}

export async function calculateCBAM(hsCode: string): Promise<{
  emissionFactor: number;
  carbonCost: number;
  riskLevel: string;
  analysis: string;
}> {
  const prompt = `计算HS编码 ${hsCode} 产品的EU CBAM碳关税:

请返回JSON:
{
  "emissionFactor": 隐含排放因子(tCO2/单位),
  "carbonCost": 预估碳成本(欧元),
  "riskLevel": "low/medium/high",
  "analysis": "详细分析及应对建议"
}`;

  const result = await completionJSON<{
    emissionFactor?: number;
    carbonCost?: number;
    riskLevel?: string;
    analysis?: string;
  }>(prompt, {
    model: 'deepseek-chat',
    temperature: 0.3,
    maxTokens: 600,
    cacheNs: `cbam:${hsCode}`,
    cacheTTL: 86_400,
  });

  return {
    emissionFactor: result?.emissionFactor ?? 0,
    carbonCost: result?.carbonCost ?? 0,
    riskLevel: result?.riskLevel || 'medium',
    analysis: result?.analysis || 'CBAM测算暂不可用，请参考EU官方方法学',
  };
}

export async function diagnoseRejection(rejectionReason: string): Promise<{
  diagnosis: string;
  fixSteps: string[];
  estimatedFixTime: string;
}> {
  const prompt = `你是报关退单诊断专家。以下报关单被退回:

退单原因: ${rejectionReason}

请返回JSON:
{
  "diagnosis": "退单根因诊断",
  "fixSteps": ["修复步骤1", "修复步骤2", ...],
  "estimatedFixTime": "预计修复时间"
}`;

  const result = await completionJSON<{
    diagnosis?: string;
    fixSteps?: string[];
    estimatedFixTime?: string;
  }>(prompt, {
    model: 'deepseek-chat',
    temperature: 0.3,
    maxTokens: 800,
    cacheNs: `diagnose:${hashStr(rejectionReason)}`,
    cacheTTL: 3_600,
  });

  return {
    diagnosis: result?.diagnosis || 'AI诊断暂不可用',
    fixSteps: result?.fixSteps || ['请核对申报信息', '联系海关咨询'],
    estimatedFixTime: result?.estimatedFixTime || '未知',
  };
}

export async function dualValidation(description: string): Promise<{
  primary: any;
  secondary: any;
  consistent: boolean;
  recommendation: string;
}> {
  const [primary, secondary] = await Promise.all([
    classifyHSCode(description),
    classifyHSCode(`请从不同角度重新归类: ${description}`),
  ]);

  const consistent = primary.hsCode === secondary.hsCode;

  return {
    primary,
    secondary,
    consistent,
    recommendation: consistent
      ? `双校验一致: ${primary.hsCode}, 置信度: ${Math.round(primary.confidence * 100)}%`
      : `双校验结果不一致，强烈建议人工复核。结果A: ${primary.hsCode}, 结果B: ${secondary.hsCode}`,
  };
}

export { completion as callAI };
