import { diagnoseRejection } from './ai/deepseek';
import prisma from '../config/database';

// 报关退单AI智能诊断修复引擎

interface RejectionCase {
  rejectionCode: string;
  rejectionReason: string;
  documents?: string[];
}

// 退单智能诊断
export async function diagnose(rejection: RejectionCase, tenantId: string) {
  // 1. AI诊断
  const aiResult = await diagnoseRejection(rejection.rejectionReason);

  // 2. 查找相似历史案例
  const similarCases = await prisma.auditLog.findMany({
    where: {
      action: 'ai_diagnose',
      detail: { contains: rejection.rejectionCode || '' },
    },
    take: 5,
  });

  // 3. 分析关联单证
  let docSuggestions: string[] = [];
  if (rejection.documents?.length) {
    const docs = await prisma.document.findMany({
      where: {
        tenantId,
        fileName: { in: rejection.documents },
      },
    });
    docSuggestions = docs.map((d: { fileName: string }) => `单证"${d.fileName}"可能需更新: 检查日期、签章、格式`);
  }

  // 4. 生成修复方案
  const diagnosis = {
    rejectionCode: rejection.rejectionCode,
    originalReason: rejection.rejectionReason,
    aiDiagnosis: aiResult.diagnosis,
    fixSteps: aiResult.fixSteps || [],
    estimatedFixTime: aiResult.estimatedFixTime || '未知',
    similarCases: similarCases.length,
    docSuggestions,
    preventionTips: [
      '申报前使用AI双校验确认HS编码',
      '定期更新HS编码库',
      '关注海关最新公告',
    ],
    createdAt: new Date().toISOString(),
  };

  // 审计日志
  await prisma.auditLog.create({
    data: {
      tenantId,
      action: 'rejection_diagnosis',
      detail: `退单诊断: 代码${rejection.rejectionCode}, ${aiResult.diagnosis.slice(0, 200)}`,
    },
  });

  return diagnosis;
}

// 常见退单原因库
export const COMMON_REJECTIONS = [
  { code: 'HS001', reason: 'HS编码归类不准确', category: 'classification' },
  { code: 'HS002', reason: '申报价格异常', category: 'valuation' },
  { code: 'HS003', reason: '原产地证明不完整', category: 'origin' },
  { code: 'HS004', reason: '许可证件缺失', category: 'license' },
  { code: 'HS005', reason: '单证信息不一致', category: 'document' },
  { code: 'HS006', reason: '检验检疫未完成', category: 'inspection' },
  { code: 'CBAM001', reason: 'CBAM碳排放数据不完整', category: 'cbam' },
  { code: 'RCEP001', reason: 'RCEP原产地声明不符合要求', category: 'rcep' },
];
