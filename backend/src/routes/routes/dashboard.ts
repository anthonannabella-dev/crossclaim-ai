import { Router } from 'express';
import prisma from '../../config/database';
import { authenticate } from '../../middleware/auth';

const router = Router();
router.use(authenticate);

// Dashboard quick stats
router.get('/stats', async (req, res) => {
  const tenantId = req.tenant!.tenantId;

  const [docCount, hsCount, recentPayments, processedDocs, highRiskCbam, aiLogs24h, apiCalls24h, pendingDecl, archivedGroups, todoReview, todoError, todoProcessing, todoChecked] = await Promise.all([
    prisma.document.count({ where: { tenantId } }),
    prisma.hSCode.count(),
    prisma.payment.count({ where: { tenantId, status: 'success' } }),
    prisma.document.count({ where: { tenantId, ocrResult: { not: null } } }),
    prisma.cBAMRecord.count({ where: { tenantId, riskLevel: 'high' } }),
    prisma.auditLog.count({
      where: {
        tenantId,
        action: { in: ['ai_classify', 'ai_smart_classify', 'ai_diagnose', 'ai_aeo', 'ai_reconcile'] },
        createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
    }),
    prisma.apiCallLog.count({
      where: {
        token: { tenantId },
        createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
    }),
    // 待申报批次
    prisma.batchGroup.count({
      where: { tenantId, declaredAt: null, archivedAt: null, status: { notIn: ['rejected', 'pre_check_failed', 'error'] } },
    }),
    // 已归档批次
    prisma.batchGroup.count({ where: { tenantId, archivedAt: { not: null } } }),
    // 待复核
    prisma.batchGroup.count({ where: { tenantId, status: 'pending_review' } }),
    // 异常/退单
    prisma.batchGroup.count({ where: { tenantId, status: { in: ['error', 'pre_check_failed', 'rejected'] } } }),
    // 处理中
    prisma.batchGroup.count({ where: { tenantId, status: { in: ['ocr_running', 'ai_checking', 'auto_filling', 'pre_checking'] } } }),
    // 已复核待申报
    prisma.batchGroup.count({ where: { tenantId, status: 'checked' } }),
  ]);

  res.json({
    totalDocuments: docCount,
    totalHsQueries: hsCount,
    activeSubscriptions: recentPayments,
    recentPayments,
    auditPassed: processedDocs,
    auditWarnings: highRiskCbam,
    aiCallsToday: aiLogs24h,
    apiCallsToday: apiCalls24h,
    pendingDeclarations: pendingDecl,
    archivedGroups,
    todoReview,
    todoError,
    todoProcessing,
    todoChecked,
  });
});

// Dashboard recent activity
router.get('/activity', async (req, res) => {
  const tenantId = req.tenant!.tenantId;

  const logs = await prisma.auditLog.findMany({
    where: { tenantId },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: {
      id: true,
      action: true,
      detail: true,
      createdAt: true,
    },
  });

  res.json(logs);
});


// 使用量趋势（最近30天每日API调用 & AI调用）
router.get('/trends', async (req, res) => {
  const tenantId = req.tenant!.tenantId;
  const days = 30;
  const result: { date: string; apiCalls: number; aiCalls: number; documents: number }[] = [];

  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

    const [apiCalls, aiCalls, documents] = await Promise.all([
      prisma.apiCallLog.count({
        where: {
          token: { tenantId },
          createdAt: { gte: dayStart, lt: dayEnd },
        },
      }),
      prisma.auditLog.count({
        where: {
          tenantId,
          action: { in: ['ai_classify', 'ai_smart_classify', 'ai_diagnose', 'ai_aeo', 'ai_reconcile'] },
          createdAt: { gte: dayStart, lt: dayEnd },
        },
      }),
      prisma.document.count({
        where: {
          tenantId,
          createdAt: { gte: dayStart, lt: dayEnd },
        },
      }),
    ]);

    result.push({
      date: dayStart.toISOString().slice(0, 10),
      apiCalls,
      aiCalls,
      documents,
    });
  }

  res.json(result);
});

// 用户活跃度（最近7天DAU/WAU + HS查询热力图）
router.get('/activity-stats', async (req, res) => {
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;

  const dau = await prisma.auditLog.groupBy({
    by: ['tenantId'],
    where: {
      createdAt: { gte: new Date(now - 1 * dayMs) },
    },
  });

  const wau = await prisma.auditLog.groupBy({
    by: ['tenantId'],
    where: {
      createdAt: { gte: new Date(now - 7 * dayMs) },
    },
  });

  const hsQueryLogs = await prisma.apiCallLog.findMany({
    where: {
      token: { tenantId: req.tenant!.tenantId },
      endpoint: { contains: 'hscode' },
      createdAt: { gte: new Date(now - 7 * dayMs) },
    },
    select: { createdAt: true },
  });

  const heatmap: Record<string, number> = {};
  for (const log of hsQueryLogs) {
    const hour = new Date(log.createdAt).getHours();
    const key = hour + ':00';
    heatmap[key] = (heatmap[key] || 0) + 1;
  }

  res.json({
    dau: dau.length,
    wau: wau.length,
    hsQueryHeatmap: heatmap,
  });
});

// 功能使用统计排名
router.get('/feature-ranking', async (req, res) => {
  const tenantId = req.tenant!.tenantId;

  const features = await prisma.auditLog.groupBy({
    by: ['action'],
    where: {
      tenantId,
      action: { startsWith: 'analytics:' },
      createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
    },
    _count: true,
    orderBy: { _count: { action: 'desc' } },
    take: 10,
  });

  res.json(features.map((f: any) => ({
    feature: f.action.replace('analytics:', ''),
    count: f._count,
  })));
});


export default router;
