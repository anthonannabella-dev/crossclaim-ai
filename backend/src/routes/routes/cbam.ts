import { Router } from 'express';
import prisma from '../../config/database';
import { authenticate } from '../../middleware/auth';
import { requireActiveTenant } from '../../middleware/tenant';
import { calculateCBAM as aiCalculateCBAM } from '../../services/ai/deepseek';
import { calculateCBAMCost, detectCBAMSector, CBAM_SECTORS, SECTOR_DEFAULTS, getCarbonPricing } from '../../services/cbamCalculator';
import { onCBAMHighRisk } from '../../services/activepiecesService';
import { withQuota } from '../../middleware/usageMiddleware';

const router = Router();
router.use(authenticate);
router.use(requireActiveTenant);

// CBAM行业及排放基准数据
router.get('/sectors', async (_req, res) => {
  const sectors = CBAM_SECTORS.map(s => {
    const defaults = SECTOR_DEFAULTS[s.sector];
    return {
      sector: s.sector,
      name: s.name,
      cnName: s.cnName,
      hsPrefixes: s.hsPrefixes,
      baseEmissions: defaults.base,
      methods: defaults.methods,
      euBenchmark: defaults.euBenchmark,
    };
  });
  const pricing = getCarbonPricing();
  res.json({ sectors, pricing });
});

// HS编码 → CBAM行业自动识别
router.get('/detect', (req, res) => {
  const { hsCode } = req.query;
  if (!hsCode || typeof hsCode !== 'string') {
    res.status(400).json({ success: false, error: '请提供HS编码' });
    return;
  }
  const sector = detectCBAMSector(hsCode);
  if (!sector) {
    res.json({ success: true, data: { covered: false, message: '该产品不在CBAM六大行业范围内' } });
    return;
  }
  const defaults = SECTOR_DEFAULTS[sector.sector];
  res.json({
    success: true,
    data: {
      covered: true,
      sector: { name: sector.name, cnName: sector.cnName, sector: sector.sector },
      methods: defaults.methods,
      euBenchmark: defaults.euBenchmark,
      baseEmissions: defaults.base,
    },
  });
});

// CBAM碳关税测算 (真实计算引擎 + AI分析)
router.post('/calculate', ...withQuota('cbam'), async (req, res) => {
  const { hsCode, productDesc, quantity, unit, sector: sectorInput, productionMethod, directEmissionsOverride, indirectEmissionsOverride } = req.body;
  const tenantId = req.tenant!.tenantId;

  if (!hsCode) {
    res.status(400).json({ success: false, error: '请提供HS编码' });
    return;
  }

  try {
    // 使用真实计算引擎
    const calcResult = calculateCBAMCost({
      hsCode,
      productDesc,
      quantity: Number(quantity) || 100,
      unit,
      sector: sectorInput,
      productionMethod: productionMethod || undefined,
      directEmissionsOverride: directEmissionsOverride != null ? Number(directEmissionsOverride) : undefined,
      indirectEmissionsOverride: indirectEmissionsOverride != null ? Number(indirectEmissionsOverride) : undefined,
    });

    // AI补充分析 (并行，不阻塞)
    let aiAnalysis: string | null = null;
    try {
      const ai = await aiCalculateCBAM(hsCode);
      aiAnalysis = ai.analysis || null;
    } catch {
      // AI不可用时使用计算结果
    }

    // 存入数据库
    const record = await prisma.cBAMRecord.create({
      data: {
        tenantId,
        hsCode,
        productDesc: calcResult.productDesc,
        embeddedEmissions: calcResult.emissions.totalEmbeddedEmissions,
        emissionFactor: calcResult.emissions.directEmissions,
        carbonPrice: calcResult.pricing.euEtsPrice,
        carbonCost: calcResult.costs.netCBAMCost,
        estimatedCost: calcResult.costs.netCBAMCost,
        riskLevel: calcResult.riskLevel,
      },
    });

    if (calcResult.riskLevel === 'high') {
      onCBAMHighRisk(tenantId, hsCode, calcResult.riskLevel);
      // Webhook事件
      import('../../services/webhook/eventEmitter').then(({ eventEmitter }) =>
        eventEmitter.fire('cbam.high_risk', tenantId, {
          hsCode,
          productDesc: calcResult.productDesc,
          riskLevel: calcResult.riskLevel,
          totalEmbeddedEmissions: calcResult.emissions.totalEmbeddedEmissions,
          netCBAMCost: calcResult.costs.netCBAMCost,
        }).catch(() => {}),
      );
    }

    await prisma.auditLog.create({
      data: {
        tenantId,
        action: 'cbam_calculate',
        detail: `CBAM测算: ${calcResult.sector.cnName} HS${hsCode} | 隐含排放: ${calcResult.emissions.totalEmbeddedEmissions.toFixed(2)} tCO₂/${calcResult.unit} | 净CBAM成本: €${calcResult.costs.netCBAMCost.toFixed(2)} | 风险: ${calcResult.riskLevel}`,
      },
    });

    res.json({
      success: true,
      data: {
        ...calcResult,
        aiAnalysis,
        recordId: record.id,
      },
    });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message || 'CBAM测算失败' });
  }
});

// CBAM批量测算
router.post('/batch-calculate', async (req, res) => {
  const { items } = req.body; // [{hsCode, productDesc, quantity, productionMethod}]
  const tenantId = req.tenant!.tenantId;

  if (!items || !Array.isArray(items) || items.length === 0) {
    res.status(400).json({ success: false, error: '请提供测算项目列表' });
    return;
  }

  try {
    const results = items.map((item: any) => {
      try {
        const calcResult = calculateCBAMCost({
          hsCode: item.hsCode,
          productDesc: item.productDesc,
          quantity: Number(item.quantity) || 100,
          sector: item.sector,
          productionMethod: item.productionMethod,
          directEmissionsOverride: item.directEmissionsOverride,
          indirectEmissionsOverride: item.indirectEmissionsOverride,
        });
        return { success: true, ...calcResult };
      } catch (err: any) {
        return { success: false, hsCode: item.hsCode, error: err.message };
      }
    });

    // Save all to DB (cast needed because TS can't narrow union after filter/map)
    const successResults = results.filter(r => r.success);
    const savePromises = successResults.map(r => {
      const ok = r as any;
      return prisma.cBAMRecord.create({
        data: {
          tenantId,
          hsCode: ok.hsCode,
          productDesc: ok.productDesc,
          embeddedEmissions: ok.emissions.totalEmbeddedEmissions,
          emissionFactor: ok.emissions.directEmissions,
          carbonPrice: ok.pricing.euEtsPrice,
          carbonCost: ok.costs.netCBAMCost,
          estimatedCost: ok.costs.netCBAMCost,
          riskLevel: ok.riskLevel,
        },
      }).catch(() => null);
    });

    await Promise.all(savePromises);

    const highRiskCount = successResults.filter(r => (r as any).riskLevel === 'high').length;

    await prisma.auditLog.create({
      data: {
        tenantId,
        action: 'cbam_batch_calculate',
        detail: `CBAM批量测算: ${results.length}项 | 成功: ${successResults.length} | 高风险: ${highRiskCount}`,
      },
    });

    res.json({
      success: true,
      data: {
        results,
        summary: {
          total: results.length,
          success: successResults.length,
          highRisk: highRiskCount,
          totalCBAMCost: successResults.reduce((sum, r) => sum + (r as any).costs.netCBAMCost, 0),
        },
      },
    });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// CBAM历史记录
router.get('/history', async (req, res) => {
  const records = await prisma.cBAMRecord.findMany({
    where: { tenantId: req.tenant!.tenantId },
    orderBy: { calculatedAt: 'desc' },
    take: 100,
  });
  res.json(records);
});

// CBAM风险统计
router.get('/risk-summary', async (req, res) => {
  const [high, medium, low] = await Promise.all([
    prisma.cBAMRecord.count({ where: { tenantId: req.tenant!.tenantId, riskLevel: 'high' } }),
    prisma.cBAMRecord.count({ where: { tenantId: req.tenant!.tenantId, riskLevel: 'medium' } }),
    prisma.cBAMRecord.count({ where: { tenantId: req.tenant!.tenantId, riskLevel: 'low' } }),
  ]);

  // 汇总碳成本
  const aggregate = await prisma.cBAMRecord.aggregate({
    where: { tenantId: req.tenant!.tenantId },
    _sum: { estimatedCost: true },
  });

  res.json({
    high, medium, low, total: high + medium + low,
    totalEstimatedCost: Math.round((aggregate._sum.estimatedCost || 0) * 100) / 100,
  });
});

export default router;
