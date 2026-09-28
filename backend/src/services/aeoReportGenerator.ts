import prisma from '../config/database';

// AEO年度自查报告自动生成器

interface AEOReportSection {
  title: string;
  status: 'compliant' | 'needs_attention' | 'non_compliant';
  details: Record<string, any>;
  recommendations: string[];
}

export async function generateAEOReport(tenantId: string) {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { companyName: true, planTier: true, createdAt: true },
  });

  const now = new Date();
  const yearStart = new Date(now.getFullYear(), 0, 1);

  // 各维度数据收集
  const [
    docCount, docCategories,
    aiClassifyCount, lowConfCount,
    rcepCount, cbamCount,
    paymentAgg,
    auditCount,
  ] = await Promise.all([
    prisma.document.count({ where: { tenantId } }),
    prisma.document.groupBy({ by: ['category'], where: { tenantId }, _count: true }),
    prisma.auditLog.count({ where: { tenantId, action: 'ai_classify' } }),
    prisma.auditLog.count({ where: { tenantId, action: 'ai_classify', detail: { contains: '0.' } } }), // low confidence marker
    prisma.auditLog.count({ where: { tenantId, action: 'rcep_calculate' } }),
    prisma.auditLog.count({ where: { tenantId, action: 'cbam_calculate' } }),
    prisma.payment.aggregate({ where: { tenantId, status: 'success', paidAt: { gte: yearStart } }, _sum: { amount: true }, _count: true }),
    prisma.auditLog.count({ where: { tenantId, createdAt: { gte: yearStart } } }),
  ]);

  const paymentTotal = paymentAgg._sum?.amount || 0;
  const paymentCount = paymentAgg._count || 0;

  const sections: AEOReportSection[] = [
    {
      title: '单证档案管理',
      status: docCount >= 10 ? 'compliant' : docCount > 0 ? 'needs_attention' : 'non_compliant',
      details: {
        totalDocuments: docCount,
        byCategory: docCategories.reduce((acc: Record<string, number>, c: { category: string | null; _count: number }) => { acc[c.category || 'other'] = c._count; return acc; }, {} as Record<string, number>),
      },
      recommendations: docCount < 10
        ? ['建议补充至少10份单证以满足AEO档案要求']
        : ['档案管理良好，建议定期归档'],
    },
    {
      title: 'AI归类与合规',
      status: 'compliant',
      details: {
        aiClassifications: aiClassifyCount,
        lowConfidenceCases: lowConfCount,
        rcepCalculations: rcepCount,
        cbamCalculations: cbamCount,
      },
      recommendations: [
        'AI归类结果仅供参考，建议每月抽检10%',
        lowConfCount > 5 ? '低置信度归类较多，建议加强人工复核' : '',
      ].filter(Boolean),
    },
    {
      title: '财务合规',
      status: paymentCount > 0 ? 'compliant' : 'needs_attention',
      details: {
        totalPayments: paymentTotal,
        transactionCount: paymentCount,
        period: `${now.getFullYear()}年度`,
      },
      recommendations: [
        paymentCount === 0 ? '本年度无支付记录' : '',
        '建议保留完整支付凭证备查',
      ].filter(Boolean),
    },
    {
      title: '操作日志审计',
      status: auditCount > 0 ? 'compliant' : 'needs_attention',
      details: {
        totalAuditLogs: auditCount,
        retentionPeriod: '3年',
      },
      recommendations: ['操作日志已按要求保留', '建议每季度导出备份'],
    },
    {
      title: '合规建议总结',
      status: 'compliant',
      details: {},
      recommendations: [
        '关注海关总署最新AEO认证标准更新',
        '按时完成年度AEO自查',
        '保持与海关的沟通渠道畅通',
      ],
    },
  ];

  const report = {
    enterpriseName: tenant?.companyName,
    planTier: tenant?.planTier,
    generatedAt: now.toISOString(),
    reportYear: now.getFullYear(),
    overallStatus: sections.every(s => s.status === 'compliant') ? 'compliant' : 'needs_attention',
    sections,
  };

  // 审计日志
  await prisma.auditLog.create({
    data: {
      tenantId,
      action: 'aeo_report_generated',
      detail: `AEO年度报告生成: ${tenant?.companyName}, ${now.getFullYear()}年度`,
    },
  });

  return report;
}
