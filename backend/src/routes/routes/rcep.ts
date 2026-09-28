import { Router } from 'express';
import prisma from '../../config/database';
import { authenticate } from '../../middleware/auth';
import { requireActiveTenant } from '../../middleware/tenant';
import { analyzeRCEP } from '../../services/ai/deepseek';
import { withQuota } from '../../middleware/usageMiddleware';

const router = Router();
router.use(authenticate);
router.use(requireActiveTenant);

// RCEP最优关税核算 (AI增强)
router.post('/calculate', ...withQuota('rcep'), async (req, res) => {
  const { hsCode, destinationCountry } = req.body;

  // 先从数据库查规则（支持格式模糊匹配: 8471.30.00 → 8471.30）
  const digits = hsCode.replace(/[^0-9]/g, '');
  // Build dotted format prefixes: "720839" → "7208.39", "72083900" → "7208.39.00"
  const dot4 = digits.slice(0, 4);
  const dot6 = digits.slice(0, 6).replace(/^(\d{4})(\d{2})/, '$1.$2');
  const dot10 = digits.slice(0, 10).replace(/^(\d{4})(\d{2})(\d{2})(\d{2})/, '$1.$2.$3.$4');

  let rule = await prisma.rCEPRule.findFirst({
    where: { productCode: hsCode },
  });
  if (!rule) {
    rule = await prisma.rCEPRule.findFirst({
      where: { productCode: { startsWith: dot10 } },
    });
  }
  if (!rule) {
    rule = await prisma.rCEPRule.findFirst({
      where: { productCode: { startsWith: dot6 } },
    });
  }
  if (!rule) {
    rule = await prisma.rCEPRule.findFirst({
      where: { productCode: { startsWith: dot4 } },
    });
  }

  // AI增强分析
  const aiAnalysis = await analyzeRCEP(hsCode, destinationCountry);

  const result = {
    hsCode,
    destinationCountry,
    dbRule: rule ? {
      originCriteria: rule.originCriteria,
      tariffReduction: rule.tariffReduction,
      source: rule.source,
    } : null,
    aiAnalysis,
    recommendedRate: rule?.tariffReduction || aiAnalysis.appliedRate || 0,
    savings: aiAnalysis.savings || `较最惠国税率节省 ${rule?.tariffReduction || 0}%`,
    source: aiAnalysis.source || rule?.source || 'RCEP协定',
    analysis: aiAnalysis.analysis || '',
  };

  await prisma.auditLog.create({
    data: {
      tenantId: req.tenant!.tenantId,
      action: 'rcep_calculate',
      detail: `RCEP核算: HS${hsCode} → ${destinationCountry}, 最优税率: ${result.recommendedRate}%`,
    },
  });

  // Webhook事件
  import('../../services/webhook/eventEmitter').then(({ eventEmitter }) =>
    eventEmitter.fire('rcep.calculated', req.tenant!.tenantId, {
      hsCode,
      destinationCountry,
      recommendedRate: result.recommendedRate,
      originCriteria: result.dbRule?.originCriteria || result.aiAnalysis?.originCriteria || '',
      savings: result.savings,
    }).catch(() => {}),
  );

  res.json(result);
});

router.get('/rules', async (_req, res) => {
  const rules = await prisma.rCEPRule.findMany({ take: 200 });
  res.json(rules);
});

export default router;
