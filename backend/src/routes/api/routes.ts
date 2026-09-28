import { Router } from 'express';
import prisma from '../../config/database';
import { authenticateApiToken } from '../../middleware/auth';
import { planBasedLimiter } from '../../middleware/rateLimiter';
import { trackUsage } from '../../middleware/usageMiddleware';
import Tesseract from 'tesseract.js';

const router = Router();

// 所有外部API需要Token认证
router.use(authenticateApiToken);

// 按计划分层限频
router.use(planBasedLimiter);

// 跟踪API调用用量
router.use(trackUsage('api_call'));

// 请求计时(须在所有路由之前注册,否则 submit-once 等先注册的路由拿不到 _startTime,时延记为0)
router.use((req, _res, next) => {
  (req as any)._startTime = Date.now();
  next();
});

// 一键申报
// 一键申报（构建→预检→保存→提交）
router.post('/submit-once', async (req, res) => {
  const tenant = (req as any).apiTenant;
  if (!tenant) {
    res.status(401).json({ success: false, error: '未授权' });
    return;
  }

  const {
    hsCodes = [],
    itemDetails,
    customsMode,
    importerExporter,
    transportMode,
    vesselFlight,
    portOfLoading,
    portOfDischarge,
    portOfEntry,
    tradeTerms,
    currency,
    declarant,
    declarantCode,
    agentName,
    agentCode,
    contractNo,
    containerNo,
    packageType,
    grossWeight,
    netWeight,
    totalValue,
    marketName,
    marketCode,
    supplierName,
    ecommercePlatform,
    orderNo,
    logisticsNo,
    destinationCountry,
  } = req.body;

  if (!hsCodes || !Array.isArray(hsCodes) || hsCodes.length === 0) {
    res.status(400).json({ success: false, error: '缺少 hsCodes（HS编码列表）' });
    return;
  }

  try {
    const { buildDeclaration, runPreCheck } = await import('../../services/declarationBuilder');
    const { saveDraft, submitDeclaration } = await import('../../services/declarationService');

    const built = await buildDeclaration(tenant.id, { hsCodes, itemDetails, importerExporter, transportMode, vesselFlight, portOfLoading, portOfDischarge, portOfEntry, tradeTerms, currency });

    const declaration = {
      ...built.declaration,
      customsMode: customsMode || 'normal',
      declarant: declarant || 'API用户',
      declarantCode: declarantCode || undefined,
      agentName: agentName || undefined,
      agentCode: agentCode || undefined,
      contractNo: contractNo || undefined,
      containerNo: containerNo || undefined,
      packageType: packageType || undefined,
      grossWeight: grossWeight || undefined,
      netWeight: netWeight || undefined,
      totalValue: totalValue || built.declaration.totalValue,
      marketName: marketName || undefined,
      marketCode: marketCode || undefined,
      supplierName: supplierName || undefined,
      ecommercePlatform: ecommercePlatform || undefined,
      orderNo: orderNo || undefined,
      logisticsNo: logisticsNo || undefined,
      destinationCountry: destinationCountry || undefined,
    };

    const preCheck = await runPreCheck(declaration);
    const draft = await saveDraft(tenant.id, declaration, preCheck);

    let submitted = null;
    if (preCheck.passed) {
      submitted = await submitDeclaration(tenant.id, draft.id);
    }

    logApiCall(req, res.statusCode);
    res.json({
      success: true,
      data: {
        declarationId: draft.id,
        declarationNo: draft.declarationNo,
        status: submitted ? 'submitted' : 'draft',
        preCheckPassed: preCheck.passed,
        score: preCheck.score,
        xmlContent: built.xmlContent,
        issues: preCheck.issues,
        preCheckSupplement: (preCheck as any).aiPreCheckSupplement || null,
      },
    });
  } catch (err: any) {
    console.error('[submit-once] error:', err);
    res.status(500).json({ success: false, error: err.message || '申报处理异常' });
    logApiCall(req, res.statusCode);
  }
});

// 记录API调用 (在响应完成后)
function logApiCall(req: any, statusCode: number) {
  const tokenRecord = req.apiTokenRecord;
  const durationMs = Date.now() - (req._startTime || Date.now());

  Promise.all([
    prisma.apiToken.update({
      where: { id: tokenRecord.id },
      data: {
        totalCalls: { increment: 1 },
        monthlyCalls: { increment: 1 },
        lastUsedAt: new Date(),
      },
    }),
    prisma.apiCallLog.create({
      data: {
        tokenId: tokenRecord.id,
        endpoint: req.path,
        method: req.method,
        statusCode,
        ip: req.ip || req.headers['x-forwarded-for'] as string || 'unknown',
        durationMs,
      },
    }),
  ]).catch(() => {}); // 日志失败不影响响应
}

// HS编码查询
router.get('/hscode', async (req, res) => {
  const { q, code } = req.query;

  const where: any = {};
  if (q) {
    where.OR = [
      { code: { contains: q as string } },
      { description: { contains: q as string } },
    ];
  }
  if (code) {
    where.code = code as string;
  }

  const results = await prisma.hSCode.findMany({
    where,
    take: 50,
  });

  logApiCall(req, res.statusCode);
  res.json({ success: true, data: results });
});

// 税率测算 (RCEP)
router.post('/tariff', async (req, res) => {
  const { hsCode, country } = req.body;

  if (!hsCode) {
    res.status(400).json({ success: false, error: '缺少 hsCode 参数' });
    return;
  }

  let appliedRate: number | null = null;
  let originCriteria = '请参考海关最新公告';
  let source = '海关总署';

  const rcepFta = await prisma.ftaAgreement.findUnique({ where: { shortName: 'RCEP' } });
  if (rcepFta) {
    const originRule = await prisma.originRule.findUnique({
      where: { ftaAgreementId_hsCode: { ftaAgreementId: rcepFta.id, hsCode } },
    });
    if (originRule) {
      appliedRate = originRule.tariffReduction ?? null;
      originCriteria = originRule.ruleDetail || '请参考海关最新公告';
      source = originRule.source || '海关总署';
    }
  }

  if (appliedRate == null) {
    const oldRule = await prisma.rCEPRule.findFirst({ where: { productCode: hsCode } });
    if (oldRule) {
      appliedRate = oldRule.tariffReduction ?? null;
      originCriteria = oldRule.originCriteria;
      source = oldRule.source;
    }
  }

  const result = {
    hsCode,
    country: country || '未知',
    appliedRate,
    originCriteria,
    source,
    updatedAt: new Date().toISOString(),
  };

  logApiCall(req, res.statusCode);
  res.json({ success: true, data: result });
});

// CBAM碳关税计算
router.post('/cbam', async (req, res) => {
  const { hsCode, emissionValue } = req.body;

  if (!hsCode) {
    res.status(400).json({ success: false, error: '缺少 hsCode 参数' });
    return;
  }

  const record = await prisma.cBAMRecord.findFirst({
    where: { hsCode },
    orderBy: { calculatedAt: 'desc' },
  });

  const result = {
    hsCode,
    emissionValue: emissionValue || null,
    embeddedEmissions: record?.embeddedEmissions || null,
    carbonPrice: record?.carbonPrice || null,
    estimatedCost: record?.estimatedCost || null,
    riskLevel: record?.riskLevel || 'unknown',
    calculatedAt: record?.calculatedAt?.toISOString() || new Date().toISOString(),
  };

  logApiCall(req, res.statusCode);
  res.json({ success: true, data: result });
});

// OCR识别
router.post('/ocr', async (req, res) => {
  const { imageBase64 } = req.body;

  if (!imageBase64) {
    res.status(400).json({ success: false, error: '缺少 imageBase64 参数' });
    return;
  }

  let text = '';
  let confidence = 0;
  try {
    const buffer = Buffer.from(imageBase64, 'base64');
    const { data } = await Tesseract.recognize(buffer, 'chi_sim+eng', { logger: () => {} });
    text = data.text.slice(0, 10000);
    confidence = data.confidence / 100;
  } catch {
    text = '[OCR失败] 无法识别该图片内容';
  }

  const result = { text, confidence };

  logApiCall(req, res.statusCode);
  res.json({ success: true, data: result });
});

// 报关数据查询
router.get('/declarations', async (req, res) => {
  const { startDate, endDate, category } = req.query;
  const tenant = (req as any).apiTenant;

  const where: any = { tenantId: tenant.id };
  if (startDate && endDate) {
    where.createdAt = {
      gte: new Date(startDate as string),
      lte: new Date(endDate as string),
    };
  }
  if (category) {
    where.category = category as string;
  }

  const docs = await prisma.document.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: {
      id: true,
      fileName: true,
      fileType: true,
      fileSize: true,
      category: true,
      ocrResult: true,
      createdAt: true,
    },
  });

  logApiCall(req, res.statusCode);
  res.json({ success: true, data: docs, total: docs.length });
});

// 政策预警
router.get('/policy-alerts', async (req, res) => {
  const { category } = req.query;

  const where: any = { isActive: true };
  if (category) {
    where.category = category as string;
  }

  const alerts = await prisma.policyAlert.findMany({
    where,
    orderBy: { publishDate: 'desc' },
    take: 50,
  });

  logApiCall(req, res.statusCode);
  res.json({ success: true, data: alerts, total: alerts.length });
});

// OpenAPI 3.0 规范文档
router.get('/docs', (_req, res) => {
  const spec = {
    openapi: '3.0.0',
    info: {
      title: '出口报关合规AI SaaS API',
      version: '1.0.0',
      description: '企业版对外开放API网关。使用前请在企业控制台获取 AppKey 和 API Token。',
      contact: { name: '技术支持', email: 'support@customs-saas.com' },
    },
    servers: [
      { url: '/external', description: 'API Gateway' },
    ],
    security: [{ ApiKeyAuth: [], ApiTokenAuth: [] }],
    components: {
      securitySchemes: {
        ApiKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'X-App-Key',
          description: '企业AppKey，在企业控制台获取',
        },
        ApiTokenAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'X-API-Token',
          description: 'API Token，在企业控制台获取',
        },
      },
      schemas: {
        HSCode: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            code: { type: 'string', example: '8471.30' },
            description: { type: 'string' },
            tariffRate: { type: 'number' },
            category: { type: 'string' },
          },
        },
        TariffResult: {
          type: 'object',
          properties: {
            hsCode: { type: 'string' },
            country: { type: 'string' },
            appliedRate: { type: 'number' },
            originCriteria: { type: 'string' },
            source: { type: 'string' },
          },
        },
        CBAMResult: {
          type: 'object',
          properties: {
            hsCode: { type: 'string' },
            emissionValue: { type: 'number', nullable: true },
            embeddedEmissions: { type: 'number', nullable: true },
            carbonPrice: { type: 'number', nullable: true },
            estimatedCost: { type: 'number', nullable: true },
            riskLevel: { type: 'string', enum: ['low', 'medium', 'high', 'unknown'] },
          },
        },
        Document: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            fileName: { type: 'string' },
            fileType: { type: 'string' },
            category: { type: 'string' },
            ocrResult: { type: 'string', nullable: true },
            createdAt: { type: 'string', format: 'date-time' },
          },
        },
        PolicyAlert: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            category: { type: 'string' },
            publishDate: { type: 'string', format: 'date-time' },
            summary: { type: 'string' },
            source: { type: 'string' },
          },
        },
      },
    },
    paths: {
      '/hscode': {
        get: {
          tags: ['HS编码'],
          summary: 'HS编码查询',
          parameters: [
            { name: 'q', in: 'query', description: '关键词搜索（编码或描述）', schema: { type: 'string' } },
            { name: 'code', in: 'query', description: '精确编码查询', schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: '查询结果', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'array', items: { $ref: '#/components/schemas/HSCode' } } } } } } },
            '429': { description: '调用频率超限' },
          },
        },
      },
      '/tariff': {
        post: {
          tags: ['税率测算'],
          summary: 'RCEP税率测算',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['hsCode'],
                  properties: {
                    hsCode: { type: 'string', description: 'HS编码' },
                    country: { type: 'string', description: '目的国' },
                  },
                },
              },
            },
          },
          responses: {
            '200': { description: '税率结果', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { $ref: '#/components/schemas/TariffResult' } } } } } },
          },
        },
      },
      '/cbam': {
        post: {
          tags: ['CBAM碳关税'],
          summary: 'CBAM碳排放成本计算',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['hsCode'],
                  properties: {
                    hsCode: { type: 'string', description: 'HS编码' },
                    emissionValue: { type: 'number', description: '企业报告的碳排放值(吨CO2)' },
                  },
                },
              },
            },
          },
          responses: {
            '200': { description: '计算结果', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { $ref: '#/components/schemas/CBAMResult' } } } } } },
          },
        },
      },
      '/ocr': {
        post: {
          tags: ['OCR识别'],
          summary: '单证OCR文字识别',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['imageBase64'],
                  properties: {
                    imageBase64: { type: 'string', description: '图片Base64编码' },
                  },
                },
              },
            },
          },
          responses: {
            '200': { description: '识别结果', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { text: { type: 'string' }, confidence: { type: 'number' } } } } } } } },
          },
        },
      },
      '/declarations': {
        get: {
          tags: ['报关数据'],
          summary: '报关单证数据查询',
          parameters: [
            { name: 'startDate', in: 'query', description: '开始日期(ISO)', schema: { type: 'string', format: 'date' } },
            { name: 'endDate', in: 'query', description: '结束日期(ISO)', schema: { type: 'string', format: 'date' } },
            { name: 'category', in: 'query', description: '单证分类', schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: '报关数据列表', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'array', items: { $ref: '#/components/schemas/Document' } }, total: { type: 'integer' } } } } } },
          },
        },
      },
      '/policy-alerts': {
        get: {
          tags: ['政策预警'],
          summary: '海关政策预警查询',
          parameters: [
            { name: 'category', in: 'query', description: '政策分类', schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: '预警列表', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'array', items: { $ref: '#/components/schemas/PolicyAlert' } }, total: { type: 'integer' } } } } } },
          },
        },
      },

      '/submit-once': {
        post: {
          tags: ['一键申报'],
          summary: '一键出口申报（构建→预检→提交）',
          description: '企业上传HS编码和货物信息，系统自动构建报关单、合规预检、保存草稿并提交申报。预检不通过时返回问题列表，不会提交。',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['hsCodes'],
                  properties: {
                    hsCodes: { type: 'array', items: { type: 'string' }, description: 'HS编码列表' },
                    itemDetails: { type: 'array', items: { type: 'object', properties: { hsCode: { type: 'string' }, quantity: { type: 'number' }, unitPrice: { type: 'number' }, description: { type: 'string' }, originCountry: { type: 'string' } } }, description: '货物明细' },
                    customsMode: { type: 'string', description: '申报模式: normal/9610/9710/9810/1039/1210/1239' },
                    importerExporter: { type: 'string', description: '进出口商名称' },
                    transportMode: { type: 'string', description: '运输方式' },
                    tradeTerms: { type: 'string', description: '贸易术语' },
                    currency: { type: 'string', description: '币制' },
                    declarant: { type: 'string', description: '申报人' },
                    contractNo: { type: 'string', description: '合同号' },
                    destinationCountry: { type: 'string', description: '目的国' },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: '申报结果',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                      data: {
                        type: 'object',
                        properties: {
                          declarationId: { type: 'string', description: '申报单ID' },
                          declarationNo: { type: 'string', description: '申报编号' },
                          status: { type: 'string', enum: ['draft', 'submitted'], description: 'draft=预检未过未提交, submitted=已提交' },
                          preCheckPassed: { type: 'boolean' },
                          score: { type: 'number', description: '预检评分0-100' },
                          xmlContent: { type: 'string', description: '生成的XML报文' },
                          issues: { type: 'array', items: { type: 'object', properties: { severity: { type: 'string' }, code: { type: 'string' }, message: { type: 'string' } } } },
                          preCheckSupplement: { type: 'string' },
                        },
                      },
                    },
                  },
                },
              },
            },
            '400': { description: '请求参数错误' },
            '500': { description: '服务器内部错误' },
          },
        },
      },
    },
    tags: [
      { name: 'HS编码', description: 'HS编码查询与搜索' },
      { name: '税率测算', description: 'RCEP优惠税率计算' },
      { name: 'CBAM碳关税', description: '碳边境调节机制成本核算' },
      { name: 'OCR识别', description: '单证光学字符识别' },
      { name: '报关数据', description: '报关单证数据管理' },
      { name: '政策预警', description: '海关政策变动预警' },
      { name: '一键申报', description: '企业一键申报出口报关' },
    ],
  };

  res.json(spec);
});

export default router;
