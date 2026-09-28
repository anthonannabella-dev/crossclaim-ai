import Tesseract from 'tesseract.js';
import prisma from '../../config/database';
import { classifyHSCode, analyzeRCEP } from './deepseek';

interface SmartClassifyInput {
  description: string;
  imageBase64?: string;
}

interface TariffInfo {
  mfn: { rate: number | null; source: string };
  ftas: { name: string; shortName: string; rate: number | null; ruleType: string; ruleDetail: string | null }[];
}

interface SmartClassifyResult {
  hsCode: string;
  classification: string;
  confidence: number;
  alternatives: { code: string; desc: string }[];
  source: string;
  suggestion: string;
  ocrText?: string;
  tariffs: TariffInfo;
  cbam: { riskLevel: string; estimatedCost: number | null; carbonPrice: number | null } | null;
  rcepAnalysis: { originCriteria: string; savings: string; analysis: string } | null;
}

async function runOCR(imageBase64: string): Promise<string> {
  try {
    const buffer = Buffer.from(imageBase64, 'base64');
    const { data } = await Tesseract.recognize(buffer, 'chi_sim+eng', { logger: () => {} });
    return data.text.slice(0, 5000).trim();
  } catch {
    return '';
  }
}

async function localFallback(description: string): Promise<string | null> {
  // 数字优先: 提取HS编码数字直接匹配
  const digits = description.replace(/[^0-9]/g, '');
  if (digits.length >= 4) {
    const match = await prisma.hSCode.findFirst({
      where: { code: { startsWith: digits.slice(0, 6) } },
    });
    if (match) return match.code;
  }

  // 中文关键词匹配 — 使用 raw query 确保 UTF-8 正确
  const words = description.match(/[一-鿿㐀-䶿]{2,}/g) || [];
  for (const word of words) {
    const results: any[] = await prisma.$queryRawUnsafe(
      `SELECT code FROM HSCode WHERE description LIKE '%' || $1 || '%' OR category LIKE '%' || $1 || '%' LIMIT 1`,
      word
    );
    if (results.length > 0) return results[0].code;
  }

  // Prisma contains 尝试 (部分SQLite配置下work)
  const kw = description.slice(0, 10);
  const results = await prisma.hSCode.findMany({
    where: {
      OR: [
        { description: { contains: kw } },
        { description: { startsWith: kw } },
      ],
    },
    take: 3,
  });
  if (results.length > 0) return results[0].code;

  return null;
}

export async function smartClassify(input: SmartClassifyInput): Promise<SmartClassifyResult> {
  let { description } = input;

  // Step 1: OCR if image provided
  let ocrText: string | undefined;
  if (input.imageBase64) {
    ocrText = await runOCR(input.imageBase64);
    if (ocrText && !description) {
      description = ocrText;
    }
  }

  if (!description || description.trim().length === 0) {
    throw new Error('请提供商品描述或上传包含文字的商品图片');
  }

  // Step 2: AI classify + DB queries + RCEP analysis in parallel
  const classifyPromise = classifyHSCode(description.trim());

  // Fire AI classify first, then use the result for DB lookups
  const classification = await classifyPromise;

  const { hsCode: aiHsCode, classification: classDesc, confidence, alternatives, source, suggestion } = classification;

  // Fallback: AI失败时用本地DB关键词匹配
  let hsCode = aiHsCode;
  let isAiResult = true;
  if (!hsCode) {
    const fallback = await localFallback(description.trim());
    if (fallback) {
      hsCode = fallback;
      isAiResult = false;
    }
  }

  if (!hsCode) {
    return {
      hsCode: '', classification: classDesc, confidence, alternatives, source, suggestion,
      ocrText,
      tariffs: { mfn: { rate: null, source: '' }, ftas: [] },
      cbam: null,
      rcepAnalysis: null,
    };
  }

  // Step 3: DB lookups + RCEP AI analysis (parallel)
  // Normalize HS code: AI returns "8471.30", DB stores "8471.30.00"
  const digits = hsCode.replace(/[^0-9]/g, '');

  async function findHsCode(code: string): Promise<any> {
    const exact = await prisma.hSCode.findUnique({ where: { code } }).catch(() => null);
    if (exact) return exact;
    const match6 = await prisma.hSCode.findFirst({
      where: { code: { startsWith: code.replace(/[^0-9]/g, '').slice(0, 6) } },
      orderBy: { code: 'asc' },
    }).catch(() => null);
    if (match6) return match6;
    const match4 = await prisma.hSCode.findFirst({
      where: { code: { startsWith: code.replace(/[^0-9]/g, '').slice(0, 4) } },
      orderBy: { code: 'asc' },
    }).catch(() => null);
    return match4;
  }

  const prefix4 = digits.slice(0, 4);

  const [hscodeRecord, originRules, cbamRecord, rcepAnalysis] = await Promise.all([
    findHsCode(hsCode),
    prisma.originRule.findMany({
      where: {
        hsCode: { startsWith: prefix4 },
      },
      include: { ftaAgreement: { select: { name: true, shortName: true } } },
      take: 20,
    }).catch(() => []),
    (async () => {
      let cbam = await prisma.cBAMRecord.findFirst({
        where: { hsCode },
        orderBy: { calculatedAt: 'desc' },
      }).catch(() => null);
      if (!cbam) {
        cbam = await prisma.cBAMRecord.findFirst({
          where: { hsCode: { startsWith: digits.slice(0, 6) } },
          orderBy: { calculatedAt: 'desc' },
        }).catch(() => null);
      }
      if (!cbam) {
        cbam = await prisma.cBAMRecord.findFirst({
          where: { hsCode: { startsWith: digits.slice(0, 4) } },
          orderBy: { calculatedAt: 'desc' },
        }).catch(() => null);
      }
      return cbam;
    })(),
    analyzeRCEP(hsCode, '').catch(() => null),
  ]);

  // Step 4: Build tariff comparison
  const mfn = {
    rate: hscodeRecord?.tariffRate ?? null,
    source: '海关进出口税则',
  };

  const ftaMap = new Map<string, TariffInfo['ftas'][0]>();
  for (const rule of originRules) {
    const fta = rule.ftaAgreement;
    const existing = ftaMap.get(fta.shortName);
    if (!existing || (rule.tariffReduction != null && (existing.rate == null || rule.tariffReduction < existing.rate))) {
      ftaMap.set(fta.shortName, {
        name: fta.name,
        shortName: fta.shortName,
        rate: rule.tariffReduction ?? null,
        ruleType: rule.ruleType,
        ruleDetail: rule.ruleDetail,
      });
    }
  }

  // Sort: lowest rate first
  const ftas = Array.from(ftaMap.values()).sort((a, b) => {
    if (a.rate == null) return 1;
    if (b.rate == null) return -1;
    return a.rate - b.rate;
  });

  // Step 5: Assemble CBAM
  const cbam = cbamRecord ? {
    riskLevel: cbamRecord.riskLevel || 'unknown',
    estimatedCost: cbamRecord.estimatedCost ?? null,
    carbonPrice: cbamRecord.carbonPrice ?? null,
  } : null;

  return {
    hsCode,
    classification: isAiResult ? classDesc : `本地数据库匹配: ${hscodeRecord?.description || hsCode}`,
    confidence: isAiResult ? confidence : 0.7,
    alternatives: isAiResult ? alternatives : [],
    source: isAiResult ? source : '本地海关税则数据库',
    suggestion: isAiResult ? suggestion : '建议使用真实DeepSeek API Key获得AI智能归类',
    ocrText,
    tariffs: { mfn, ftas },
    cbam,
    rcepAnalysis: rcepAnalysis && isAiResult ? {
      originCriteria: rcepAnalysis.originCriteria || '',
      savings: rcepAnalysis.savings || '',
      analysis: rcepAnalysis.analysis || '',
    } : null,
  };
}
