import { Router } from 'express';
import multer from 'multer';
import prisma from '../../config/database';
import { authenticate } from '../../middleware/auth';
import { requireActiveTenant } from '../../middleware/tenant';
import { ensureTenantBucket, tenantBucket, getMinio } from '../../config/minio';
import { withQuota } from '../../middleware/usageMiddleware';
import { v4 as uuid } from 'uuid';
import {
  auditDocument,
  batchAudit,
  crossCheckDocuments,
  detectDocType,
  DOC_TYPE_LABELS,
} from '../../services/documentAuditService';
import { ensureBatchGroup, triggerGroupOCR } from '../../services/groupPipelineService';
import { eventEmitter } from '../../services/webhook/eventEmitter';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 50 }, // 单文件 ≤20MB
});

const router = Router();
router.use(authenticate);

// ============================================================
// 单证 CRUD
// ============================================================

// 单证列表
router.get('/', requireActiveTenant, async (req, res) => {
  const docs = await prisma.document.findMany({
    where: { tenantId: req.tenant!.tenantId },
    orderBy: { createdAt: 'desc' },
  });
  res.json(docs);
});

// 上传单证
router.post('/upload', requireActiveTenant, upload.single('file'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: '请上传文件' });
    return;
  }

  const tenantId = req.tenant!.tenantId;
  await ensureTenantBucket(tenantId);

  const ext = req.file.originalname.split('.').pop();
  const objectName = `docs/${req.body.category || 'general'}/${uuid()}.${ext}`;
  const minio = getMinio();

  if (minio) {
    await minio.putObject(tenantBucket(tenantId), objectName, req.file.buffer);
  }

  const doc = await prisma.document.create({
    data: {
      tenantId,
      fileName: req.file.originalname,
      fileType: ext || 'unknown',
      fileSize: req.file.size,
      minioPath: objectName,
      category: req.body.category,
      projectTag: req.body.projectTag || undefined,
      contractNo: req.body.contractNo || undefined,
      billOfLading: req.body.billOfLading || undefined,
    },
  });

  // 如果有提运单号，自动创建/更新分组并触发 OCR
  if (req.body.billOfLading) {
    try {
      const groupId = await ensureBatchGroup(tenantId, req.body.billOfLading, doc.id, req.body.projectTag);
      await triggerGroupOCR(groupId).catch(() => {});
    } catch (e) {
      // 分组创建失败不影响上传
    }
  }

  // 触发自动化流水线事件
  eventEmitter.fire('document.uploaded', tenantId, {
    documentId: doc.id,
    billOfLading: req.body.billOfLading || '',
    fileName: doc.fileName,
    category: doc.category,
  }).catch(() => {});

  res.status(201).json(doc);
});

// 下载单证
router.get('/:id/download', requireActiveTenant, async (req, res) => {
  const doc = await prisma.document.findUnique({ where: { id: String(req.params.id) } });
  if (!doc || doc.tenantId !== req.tenant!.tenantId) {
    res.status(404).json({ error: '文件不存在' });
    return;
  }

  const minio = getMinio();
  if (!minio) {
    res.status(500).json({ error: '存储服务不可用' });
    return;
  }
  const stream = await minio.getObject(tenantBucket(doc.tenantId), doc.minioPath);

  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(doc.fileName)}"`);
  res.setHeader('Content-Type', 'application/octet-stream');
  stream.pipe(res);
});

// 修改单证信息
router.put('/:id', requireActiveTenant, async (req, res) => {
  try {
    const id = String(req.params.id);
    const tenantId = req.tenant!.tenantId;
    // 租户归属校验:只能改本租户单证
    const existing = await prisma.document.findFirst({ where: { id, tenantId } });
    if (!existing) {
      res.status(404).json({ success: false, error: '单证不存在或无权访问' });
      return;
    }
    const updateData: any = {};
    if (req.body.category !== undefined) updateData.category = req.body.category;
    if (req.body.projectTag !== undefined) updateData.projectTag = req.body.projectTag;
    if (req.body.contractNo !== undefined) updateData.contractNo = req.body.contractNo;
    if (req.body.billOfLading !== undefined) updateData.billOfLading = req.body.billOfLading;
    const doc = await prisma.document.update({
      where: { id },
      data: updateData,
    });
    res.json({ success: true, data: doc });
  } catch (err: any) {
    res.status(500).json({ success: false, error: '更新失败' });
  }
});

// 删除单证
router.delete('/:id', requireActiveTenant, async (req, res) => {
  const docId2 = String(req.params.id);
  const doc = await prisma.document.findUnique({ where: { id: docId2 } });
  if (!doc || doc.tenantId !== req.tenant!.tenantId) {
    res.status(404).json({ error: '文件不存在' });
    return;
  }

  const minio = getMinio();
  if (minio) {
    await minio.removeObject(tenantBucket(doc.tenantId), doc.minioPath);
  }
  await prisma.document.delete({ where: { id: String(req.params.id) } });

  res.json({ message: '删除成功' });
});

// ============================================================
// 单证 AI 审核（合并自 documentAudit.ts）
// ============================================================

// 上传+AI审核（批量）
router.post('/audit', requireActiveTenant, ...withQuota('document_upload'), upload.array('files', 50), async (req, res) => {
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

    // ── 自动触发提运单归集 pipeline ──
    try {
      const billOfLading = req.body.billOfLading || '';
      const projectTag = req.body.projectTag || '';
      if (billOfLading && result.documents && result.documents.length > 0) {
        const firstDoc = result.documents[0];
        const { ensureBatchGroup, triggerGroupOCR } = await import('../../services/groupPipelineService');
        const groupId = await ensureBatchGroup(
          tenantId, billOfLading, firstDoc.documentId || '', projectTag
        );
        await triggerGroupOCR(groupId);
      }
    } catch (pipelineErr: any) {
      console.error('[Pipeline] trigger failed:', pipelineErr.message);
    }

    res.json({ success: true, data: result });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || '单证审核失败' });
  }
});

// 单份单证审核（根据已存在的OCR结果）
router.post('/:id/audit', requireActiveTenant, async (req, res) => {
  const id = String(req.params.id);

  try {
    const doc = await prisma.document.findFirst({ where: { id, tenantId: req.tenant!.tenantId } });
    if (!doc) {
      res.status(404).json({ success: false, error: '文档不存在' });
      return;
    }

    if (!doc.ocrResult) {
      res.status(400).json({ success: false, error: '该文档尚未进行OCR识别，请先上传识别' });
      return;
    }

    const docType = detectDocType(doc.ocrResult, doc.fileName);
    const docTypeLabel = DOC_TYPE_LABELS[docType];

    const { aiExtractFields, DOC_FIELDS, validateFields } = await import('../../services/documentAuditService');
    const fields = await aiExtractFields(docType, docTypeLabel, doc.ocrResult);
    const issues = validateFields(docType, fields) || [];

    const defs = DOC_FIELDS[docType] || [];
    const filledRequired = defs.filter((d: any) => d.required && fields.find((f: any) => f.field === d.field)?.value).length;
    const totalRequired = defs.filter((d: any) => d.required).length;
    const completeness = totalRequired > 0 ? Math.round((filledRequired / totalRequired) * 100) : 100;
    const passed = !issues.some((i: any) => i.severity === 'error') && completeness >= 60;

    res.json({
      success: true,
      data: {
        documentId: doc.id,
        fileName: doc.fileName,
        docType,
        docTypeLabel,
        ocrText: (doc.ocrResult || '').slice(0, 3000),
        fields,
        issues,
        completeness,
        passed,
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 跨单证交叉检查
router.post('/audit/cross-check', requireActiveTenant, async (req, res) => {
  const { documentIds } = req.body;

  if (!documentIds || !Array.isArray(documentIds) || documentIds.length < 2) {
    res.status(400).json({ success: false, error: '请提供至少2个已审计的单证ID' });
    return;
  }

  try {
    const docs = await prisma.document.findMany({
      where: { id: { in: documentIds }, tenantId: req.tenant!.tenantId },
    });

    if (docs.length < 2) {
      res.status(400).json({ success: false, error: '未找到足够的单证记录' });
      return;
    }

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

// 获取审计历史
router.get('/audit/history', requireActiveTenant, async (req, res) => {
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

// ============================================================
// 提运单交叉比对 & 历史复核
// ============================================================

// 按提单号自动分组交叉比对
router.post('/cross-check/by-bl', requireActiveTenant, async (req, res) => {
  const { blNo } = req.body;
  if (!blNo) {
    res.status(400).json({ success: false, error: '请提供提单号' });
    return;
  }
  try {
    const tenantId = req.tenant!.tenantId;
    const { groupCrossCheckByBL } = await import('../../services/documentAuditService');
    const result = await groupCrossCheckByBL(tenantId, blNo);
    // ── 自动触发提运单归集 pipeline(提单号缺省回退到 blNo) ──
    try {
      const billOfLading = req.body.billOfLading || blNo;
      const projectTag = req.body.projectTag || '';
      if (billOfLading && result.documents && result.documents.length > 0) {
        const firstDoc = result.documents[0];
        const { ensureBatchGroup, triggerGroupOCR } = await import('../../services/groupPipelineService');
        const groupId = await ensureBatchGroup(
          tenantId, billOfLading, firstDoc.documentId || '', projectTag
        );
        await triggerGroupOCR(groupId);
      }
    } catch (pipelineErr: any) {
      console.error('[Pipeline] trigger failed:', pipelineErr.message);
    }

    res.json({ success: true, data: result });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 按提单号查询历史审核记录
router.get('/history/by-bl/:blNo', requireActiveTenant, async (req, res) => {
  try {
    const { getAuditHistoryByBL } = await import('../../services/documentAuditService');
    const history = await getAuditHistoryByBL(req.tenant!.tenantId, String(req.params.blNo));
    res.json({ success: true, data: history });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});



// ========== 按提运单号归集 ==========

/** 获取所有提单号分组列表（按提单号归集单据） */
router.get('/bill-of-lading/groups', requireActiveTenant, async (req, res) => {
  try {
    const tenantId = req.tenant!.tenantId;
    const docs = await prisma.document.findMany({
      where: {
        tenantId,
        billOfLading: { not: null },
      },
      orderBy: { updatedAt: 'desc' },
    });

    const groups = new Map<string, any>();
    for (const doc of docs) {
      const bl = doc.billOfLading!;
      if (!groups.has(bl)) {
        groups.set(bl, {
          billOfLading: bl,
          documentCount: 0,
          categories: [] as string[],
          projectTags: [] as string[],
          createdAt: doc.createdAt.toISOString(),
          lastUpdated: doc.updatedAt.toISOString(),
          documents: [],
        });
      }
      const g = groups.get(bl)!;
      g.documentCount++;
      if (!g.categories.includes(doc.category || '')) g.categories.push(doc.category || '');
      if (doc.projectTag && !g.projectTags.includes(doc.projectTag)) g.projectTags.push(doc.projectTag);
      if (doc.createdAt.toISOString() < g.createdAt) g.createdAt = doc.createdAt.toISOString();
      if (doc.updatedAt.toISOString() > g.lastUpdated) g.lastUpdated = doc.updatedAt.toISOString();
      g.documents.push({
        id: doc.id,
        fileName: doc.fileName,
        fileType: doc.fileType,
        category: doc.category,
        projectTag: doc.projectTag,
        contractNo: doc.contractNo,
        status: doc.status,
        auditPassed: doc.auditPassed,
        createdAt: doc.createdAt,
      });
    }

    const sorted = Array.from(groups.values()).sort((a, b) => b.lastUpdated.localeCompare(a.lastUpdated));
    res.json({ success: true, data: sorted });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || '获取提单分组列表失败' });
  }
});

/** 按提单号查询该提单下所有单据 */
router.get('/bill-of-lading/:blNo', requireActiveTenant, async (req, res) => {
  try {
    const tenantId = req.tenant!.tenantId;
    const blNo = req.params.blNo;
    const docs = await prisma.document.findMany({
      where: {
        tenantId,
        billOfLading: blNo,
      },
      orderBy: { createdAt: 'asc' },
    });
    res.json({ success: true, data: docs });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || '查询提单下单据失败' });
  }
});

export default router;
