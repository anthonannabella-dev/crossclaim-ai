import { Router } from 'express';
import multer from 'multer';
import prisma from '../../config/database';
import { authenticate } from '../../middleware/auth';
import { requireActiveTenant } from '../../middleware/tenant';
import { withQuota } from '../../middleware/usageMiddleware';
import {
  auditDocument,
  batchAudit,
  crossCheckDocuments,
  detectDocType,
  DOC_TYPE_LABELS,
} from '../../services/documentAuditService';

const router = Router();
router.use(authenticate);
router.use(requireActiveTenant);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 50 },
});

// 单证上传+AI审核
router.post('/', ...withQuota('document_upload'), upload.array('files', 50), async (req, res) => {
  const tenantId = req.tenant!.tenantId;
  const files = req.files as Express.Multer.File[];

  if (!files || files.length === 0) {
    res.status(400).json({ success: false, error: '请上传至少一个单证文件' });
    return;
  }

  try {
    const auditInputs = files.map(f => ({
      buffer: f.buffer,
      fileName: f.originalname,
      originalName: f.originalname,
    }));

    const result = await batchAudit(tenantId, auditInputs);

    await prisma.auditLog.create({
      data: {
        tenantId,
        action: 'document_audit',
        detail: `单证AI审核: ${result.summary.total}份 | 通过: ${result.summary.passed} | 错误: ${result.summary.errors} | 警告: ${result.summary.warnings}`,
      },
    });

    // Webhook事件
    import('../../services/webhook/eventEmitter').then(({ eventEmitter }) =>
      eventEmitter.fire('document.audited', tenantId, {
        total: result.summary.total,
        passed: result.summary.passed,
        errors: result.summary.errors,
        warnings: result.summary.warnings,
        documents: result.documents.slice(0, 10).map(r => ({
          fileName: r.fileName,
          docType: r.docType,
          passed: r.passed,
        })),
      }).catch(() => {}),
    );

    res.json({ success: true, data: result });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || '单证审核失败' });
  }
});

// 单份单证审核
router.post('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const doc = await prisma.document.findUnique({ where: { id } });
    if (!doc) {
      res.status(404).json({ success: false, error: '文档不存在' });
      return;
    }

    // 从MinIO获取文件buffer（简化：从本地OCR结果重新分析）
    if (!doc.ocrResult) {
      res.status(400).json({ success: false, error: '该文档尚未进行OCR识别，请先上传识别' });
      return;
    }

    const docType = detectDocType(doc.ocrResult, doc.fileName);
    const docTypeLabel = DOC_TYPE_LABELS[docType];

    // 使用已存储的OCR结果进行字段提取
    const { aiExtractFields } = await import('../../services/documentAuditService');
    const fields = await aiExtractFields(docType, docTypeLabel, doc.ocrResult);

    const result = {
      documentId: doc.id,
      fileName: doc.fileName,
      docType,
      docTypeLabel,
      ocrText: (doc.ocrResult || '').slice(0, 3000),
      fields,
      issues: [] as any[],
      completeness: 0,
      passed: false,
    };

    // Re-validate
    const { validateFields } = await import('../../services/documentAuditService');
    const issues = (validateFields as any)(docType, fields) || [];

    const fieldDefs = (await import('../../services/documentAuditService')).DOC_FIELDS;
    const defs = fieldDefs[docType] || [];
    const filledRequired = defs.filter((d: any) => d.required && fields.find(f => f.field === d.field)?.value).length;
    const totalRequired = defs.filter((d: any) => d.required).length;
    result.completeness = totalRequired > 0 ? Math.round((filledRequired / totalRequired) * 100) : 100;
    result.issues = issues;
    result.passed = !issues.some((i: any) => i.severity === 'error') && result.completeness >= 60;

    res.json({ success: true, data: result });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 跨单证交叉检查
router.post('/cross-check', async (req, res) => {
  const { documentIds } = req.body;

  if (!documentIds || !Array.isArray(documentIds) || documentIds.length < 2) {
    res.status(400).json({ success: false, error: '请提供至少2个已审计的单证ID' });
    return;
  }

  try {
    const docs = await prisma.document.findMany({
      where: { id: { in: documentIds } },
    });

    if (docs.length < 2) {
      res.status(400).json({ success: false, error: '未找到足够的单证记录' });
      return;
    }

    // 为每个文档重新审计
    const { aiExtractFields, DOC_FIELDS } = await import('../../services/documentAuditService');
    const auditResults = [];
    for (const doc of docs) {
      if (!doc.ocrResult) continue;
      const docType = detectDocType(doc.ocrResult, doc.fileName);
      const docTypeLabel = DOC_TYPE_LABELS[docType];
      const fields = await aiExtractFields(docType, docTypeLabel, doc.ocrResult);
      const fieldDefs = DOC_FIELDS[docType];
      const filledRequired = fieldDefs.filter(d => d.required && fields.find(f => f.field === d.field)?.value).length;
      const totalRequired = fieldDefs.filter(d => d.required).length;
      auditResults.push({
        documentId: doc.id,
        fileName: doc.fileName,
        docType,
        docTypeLabel,
        ocrText: (doc.ocrResult || '').slice(0, 3000),
        fields: fields.map(f => ({
          ...f,
          value: typeof f.value === 'string' ? f.value.slice(0, 200) : f.value,
        })),
        issues: [],
        completeness: totalRequired > 0 ? Math.round((filledRequired / totalRequired) * 100) : 100,
        passed: true,
      });
    }

    const crossChecks = crossCheckDocuments(
      auditResults.map(d => ({ id: d.documentId, fileName: d.fileName, auditResult: d }))
    );

    res.json({
      success: true,
      data: {
        documents: auditResults,
        crossChecks,
        overallPassed: crossChecks.every(c => c.passed),
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// 提运单同组交叉比对
// ============================================================

// 按提单号自动分组交叉比对
router.post('/cross-check/by-bl', async (req, res) => {
  const { blNo } = req.body;
  if (!blNo) {
    res.status(400).json({ success: false, error: '请提供提单号' });
    return;
  }
  try {
    const { groupCrossCheckByBL } = await import('../../services/documentAuditService');
    const result = await groupCrossCheckByBL(req.tenant!.tenantId, blNo);
    res.json({ success: true, data: result });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 按提单号查询历史审核记录
router.get('/history/by-bl/:blNo', async (req, res) => {
  try {
    const { getAuditHistoryByBL } = await import('../../services/documentAuditService');
    const history = await getAuditHistoryByBL(req.tenant!.tenantId, req.params.blNo);
    res.json({ success: true, data: history });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 获取审计历史
router.get('/history', async (req, res) => {
  const records = await prisma.document.findMany({
    where: {
      tenantId: req.tenant!.tenantId,
      ocrResult: { not: null },
    },
    orderBy: { updatedAt: 'desc' },
    take: 50,
  });
  res.json(records);
});

export default router;
