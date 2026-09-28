import { Router } from 'express';
import { authenticate } from '../../middleware/auth';
import { generateReport } from '../../services/reportGenerator';
import prisma from '../../config/database';

const router = Router();
router.use(authenticate);

// GET /api/reports/download?type=compliance&format=xlsx&dateFrom=...&dateTo=...
router.get('/download', async (req, res) => {
  try {
    const tenantId = req.tenant!.tenantId;
    const { type = 'summary', format = 'xlsx', dateFrom, dateTo } = req.query;

    const result = await generateReport({
      tenantId,
      type: type as 'compliance' | 'cbam' | 'declaration' | 'summary',
      format: format as 'xlsx' | 'pdf',
      dateFrom: dateFrom as string | undefined,
      dateTo: dateTo as string | undefined,
    });

    res.setHeader('Content-Type', result.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(result.fileName)}"`);
    res.send(result.buffer);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(400).json({ success: false, error: message });
  }
});

// GET /api/reports/analytics — dashboard chart data
router.get('/analytics', async (req, res) => {
  try {
    const tenantId = req.tenant!.tenantId;

    // HS code distribution by chapter
    const hsCodes = await prisma.hSCode.findMany({ take: 200 });
    const chapterDist: Record<string, number> = {};
    hsCodes.forEach((h: any) => {
      const chapter = h.code.slice(0, 2);
      chapterDist[chapter] = (chapterDist[chapter] || 0) + 1;
    });

    // Monthly document uploads (last 6 months)
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    const docs = await prisma.document.findMany({
      where: { tenantId, createdAt: { gte: sixMonthsAgo } },
      select: { createdAt: true, category: true },
    });

    const monthlyUploads: Record<string, number> = {};
    docs.forEach((d: any) => {
      const month = d.createdAt.toISOString().slice(0, 7);
      monthlyUploads[month] = (monthlyUploads[month] || 0) + 1;
    });

    // Document category breakdown
    const categoryDist: Record<string, number> = {};
    docs.forEach((d: any) => {
      const cat = d.category || 'other';
      categoryDist[cat] = (categoryDist[cat] || 0) + 1;
    });

    // CBAM risk level distribution
    const cbamRecords = await prisma.cBAMRecord.findMany({
      where: { tenantId },
      select: { riskLevel: true },
    });
    const riskDist: Record<string, number> = { HIGH: 0, MEDIUM: 0, LOW: 0 };
    cbamRecords.forEach((r: any) => {
      const level = r.riskLevel || 'LOW';
      riskDist[level] = (riskDist[level] || 0) + 1;
    });

    // Recent audit activity (last 30 days)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const auditLogs = await prisma.auditLog.findMany({
      where: { tenantId, createdAt: { gte: thirtyDaysAgo } },
      select: { action: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    const dailyActivity: Record<string, number> = {};
    auditLogs.forEach((log: any) => {
      const day = log.createdAt.toISOString().slice(0, 10);
      dailyActivity[day] = (dailyActivity[day] || 0) + 1;
    });

    // Monthly declarations (报关单, last 12 months)
    const twelveMonthsAgo = new Date();
    twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);
    const declDocs = await prisma.declaration.findMany({
      where: { tenantId, createdAt: { gte: twelveMonthsAgo } },
      select: { createdAt: true, status: true },
    });
    const monthlyDeclarations: Record<string, { total: number; submitted: number; rejected: number; completed: number }> = {};
    declDocs.forEach((d: any) => {
      const month = d.createdAt.toISOString().slice(0, 7);
      if (!monthlyDeclarations[month]) monthlyDeclarations[month] = { total: 0, submitted: 0, rejected: 0, completed: 0 };
      monthlyDeclarations[month].total++;
      if (d.status === 'submitted' || d.status === 'completed') monthlyDeclarations[month].submitted++;
      if (d.status === 'rejected') monthlyDeclarations[month].rejected++;
      if (d.status === 'completed') monthlyDeclarations[month].completed++;
    });

    res.json({
      success: true,
      data: {
        hsDistribution: Object.entries(chapterDist).map(([chapter, count]) => ({ chapter, count })),
        monthlyUploads: Object.entries(monthlyUploads).map(([month, count]) => ({ month, count })),
        monthlyDeclarations: Object.entries(monthlyDeclarations).map(([month, st]) => ({ month, ...st })),
        categoryDistribution: Object.entries(categoryDist).map(([category, count]) => ({ category, count })),
        cbamRiskDistribution: Object.entries(riskDist).map(([level, count]) => ({ level, count })),
        dailyActivity: Object.entries(dailyActivity).map(([date, count]) => ({ date, count })),
        summary: {
          totalDocuments: docs.length,
          totalHS: hsCodes.length,
          totalAuditLogs: auditLogs.length,
          cbamHighRisk: riskDist.HIGH,
        },
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ success: false, error: message });
  }
});

export default router;
