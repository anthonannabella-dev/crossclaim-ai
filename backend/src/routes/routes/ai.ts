import { Router } from 'express';
import prisma from '../../config/database';
import { authenticate } from '../../middleware/auth';
import { requireActiveTenant } from '../../middleware/tenant';
import { classifyHSCode, dualValidation, analyzeRCEP, calculateCBAM, diagnoseRejection } from '../../services/ai/deepseek';
import { smartClassify } from '../../services/ai/smartClassify';
import { onLowConfidenceClassification } from '../../services/activepiecesService';
import { withQuota } from '../../middleware/usageMiddleware';
import { diagnose } from '../../services/rejectionDiagnosis';
import { generateAEOReport } from '../../services/aeoReportGenerator';
import { runReconciliation } from '../../services/financialReconciliation';

const router = Router();
router.use(authenticate);
router.use(requireActiveTenant);

// AI归类双校验
router.post('/classify', ...withQuota('ai_classify'), async (req, res) => {
  const { question, description } = req.body;
  const query = question || description || '';
  if (!query || query.trim().length === 0) {
    res.status(400).json({ error: '请提供商品描述 (question 或 description)' });
    return;
  }
  const tenantId = req.tenant!.tenantId;

  const candidates = await prisma.hSCode.findMany({
    where: { description: { contains: query.slice(0, 15) } },
    take: 5,
  });

  const aiResult = await dualValidation(query);

  await prisma.auditLog.create({
    data: {
      tenantId,
      action: 'ai_classify',
      detail: `AI归类: "${query.slice(0, 100)}" → ${aiResult.primary.hsCode} (置信度: ${Math.round(aiResult.primary.confidence * 100)}%)`,
    },
  });

  // Webhook事件
  import('../../services/webhook/eventEmitter').then(({ eventEmitter }) =>
    eventEmitter.fire('ai.classify', tenantId, {
      hsCode: aiResult.primary.hsCode,
      classification: aiResult.primary.classification,
      confidence: aiResult.primary.confidence,
      query: query.slice(0, 200),
    }).catch(() => {}),
  );

  if (aiResult.primary.confidence < 0.8) {
    onLowConfidenceClassification(tenantId, aiResult.primary.hsCode, aiResult.primary.confidence);
  }

  res.json({
    ...aiResult,
    dbCandidates: candidates.map((c: { code: string; description: string | null }) => ({ code: c.code, desc: c.description })),
  });
});

// 智能归类+税率 (统一入口: OCR → AI归类 → 税率汇总)
router.post('/smart-classify', ...withQuota('ai_classify'), async (req, res) => {
  const { description, imageBase64 } = req.body;
  const tenantId = req.tenant!.tenantId;

  try {
    const result = await smartClassify({ description: description || '', imageBase64 });

    await prisma.auditLog.create({
      data: {
        tenantId,
        action: 'ai_smart_classify',
        detail: `智能归类: "${(description || result.ocrText || '').slice(0, 100)}" → ${result.hsCode} (${Math.round(result.confidence * 100)}%)`,
      },
    });

    res.json({ success: true, data: result });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message || '智能归类失败' });
  }
});

// 报关退单AI诊断
router.post('/diagnose', async (req, res) => {
  const { rejectionCode, rejectionReason, documents } = req.body;
  const tenantId = req.tenant!.tenantId;

  const result = await diagnose({ rejectionCode, rejectionReason, documents }, tenantId);

  res.json(result);
});

// AEO年度自查报告自动生成
router.post('/aeo-report', async (req, res) => {
  const tenantId = req.tenant!.tenantId;

  const report = await generateAEOReport(tenantId);

  res.json(report);
});

// 关务财务自动对账
router.post('/financial-reconciliation', async (req, res) => {
  const { startDate, endDate } = req.body;
  const tenantId = req.tenant!.tenantId;

  const result = await runReconciliation(tenantId, startDate, endDate);

  res.json(result);
});

// 批量导出
router.get('/export-transactions', async (req, res) => {
  const payments = await prisma.payment.findMany({
    where: { tenantId: req.tenant!.tenantId },
    orderBy: { createdAt: 'desc' },
  });
  res.json(payments);
});

export default router;
