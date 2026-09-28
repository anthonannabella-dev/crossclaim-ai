import { Router, Request, Response } from 'express';
import prisma from '../../config/database';
import { authenticate } from '../../middleware/auth';
import { requireActiveTenant } from '../../middleware/tenant';
import { startAutoFill, approveReview, rejectReview, markCustomsAccepted, markCustomsRejected, markReleased, markCompleted, markExported } from '../../services/groupPipelineService';
import { eventEmitter } from '../../services/webhook/eventEmitter';
import { generateCustomsXML, buildDeclaration } from '../../services/declarationBuilder';

const router = Router();
router.use(authenticate);

// Status filter mapping: friendly name → actual DB statuses
const PROCESSING_STATUSES = ['ocr_running','ocr_done','ai_checking','ai_done','auto_filling','auto_filled','pending_review','pre_checking','checked','declaring','declared','customs_review'];

function buildStatusFilter(status: string): any {
  if (!status || status === 'all') return undefined;
  if (status === 'processing') return { in: PROCESSING_STATUSES };
  return status;
}

// 容错解析：DB 中历史/脏数据导致 JSON.parse 抛错时，不再让整个列表/详情接口 500
function safeParse(s: any): any {
  if (s == null) return null;
  if (typeof s !== 'string') return s;
  try { return JSON.parse(s); } catch { return null; }
}

// Stats endpoint — real counts across all groups
router.get('/stats', requireActiveTenant, async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenant!.tenantId;
    const [total, pending, processing, done, error] = await Promise.all([
      prisma.batchGroup.count({ where: { tenantId } }),
      prisma.batchGroup.count({ where: { tenantId, status: 'pending' } }),
      prisma.batchGroup.count({ where: { tenantId, status: { in: PROCESSING_STATUSES } } }),
      prisma.batchGroup.count({ where: { tenantId, status: 'completed' } }),
      prisma.batchGroup.count({ where: { tenantId, status: 'error' } }),
    ]);
    res.json({ success: true, data: { total, pending, processing, done, error } });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 获取分组列表
router.get('/', requireActiveTenant, async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenant!.tenantId;
    const { status, page = '1', pageSize = '20', q, archivedOnly, from, to } = req.query;
    const skip = (parseInt(page as string) - 1) * parseInt(pageSize as string);
    const take = parseInt(pageSize as string);

    const where: any = { tenantId };
    const statusFilter = buildStatusFilter(status as string);
    if (statusFilter) where.status = statusFilter;

    // 归档调档:按提运单号模糊搜 / 仅看已归档 / 归档时间范围
    if (q && (q as string).trim()) {
      where.billOfLading = { contains: (q as string).trim() };
    }
    if (archivedOnly === 'true' || archivedOnly === '1') {
      where.archivedAt = { not: null };
    }
    if (from || to) {
      where.archivedAt = where.archivedAt && typeof where.archivedAt === 'object' ? where.archivedAt : {};
      if (from) (where.archivedAt as any).gte = new Date(from as string);
      if (to) (where.archivedAt as any).lte = new Date((to as string) + 'T23:59:59');
    }

    const [groups, total] = await Promise.all([
      prisma.batchGroup.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip,
        take,
      }),
      prisma.batchGroup.count({ where }),
    ]);

    // 补充每个组的校验状态
    const enriched = await Promise.all(groups.map(async (g: any) => {
      const validations = await prisma.groupValidation.findMany({
        where: { groupId: g.id },
      });
      return {
        ...g,
        createdAt: g.createdAt.toISOString(),
        updatedAt: g.updatedAt.toISOString(),
        archivedAt: g.archivedAt?.toISOString() || null,
        declaredAt: g.declaredAt?.toISOString() || null,
        taxRebateEstimatedAt: g.taxRebateEstimatedAt?.toISOString() || null,
        aiSummary: safeParse(g.aiSummary),
        preCheckResult: safeParse(g.preCheckResult),
        validations: validations.map((v: any) => ({
          id: v.id,
          checkType: v.checkType,
          status: v.status,
          summary: v.summary,
          score: v.score,
          completedAt: v.completedAt?.toISOString() || null,
        })),
      };
    }));

    res.json({ success: true, data: enriched, total });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || '获取分组列表失败' });
  }
});

// 获取单个分组详情
router.get('/:id', requireActiveTenant, async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenant!.tenantId;
    const group = await prisma.batchGroup.findFirst({
      where: { id: req.params.id, tenantId },
    });
    if (!group) {
      res.status(404).json({ success: false, error: '分组不存在' });
      return;
    }

    const docs = await prisma.document.findMany({
      where: { tenantId, billOfLading: group.billOfLading },
      orderBy: { createdAt: 'asc' },
    });

    const validations = await prisma.groupValidation.findMany({
      where: { groupId: group.id },
    });

    res.json({
      success: true,
      data: {
        ...group,
        createdAt: group.createdAt.toISOString(),
        updatedAt: group.updatedAt.toISOString(),
        archivedAt: group.archivedAt?.toISOString() || null,
        aiSummary: safeParse(group.aiSummary),
        documents: docs,
        validations: validations.map((v: any) => ({
          id: v.id,
          checkType: v.checkType,
          status: v.status,
          summary: v.summary,
          score: v.score,
          result: safeParse(v.resultJson),
          completedAt: v.completedAt?.toISOString() || null,
        })),
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || '获取分组详情失败' });
  }
});

// ============================================================
// 流水线操作端点
// ============================================================

// 启动自动填制（AI校验完成后触发）
router.post('/:id/start-auto-fill', requireActiveTenant, async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenant!.tenantId;
    const group = await prisma.batchGroup.findFirst({ where: { id: req.params.id, tenantId } });
    if (!group) { res.status(404).json({ success: false, error: '分组不存在' }); return; }

    await startAutoFill(group.id);
    res.json({ success: true, message: '已启动自动填制' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 人工复核通过
router.post('/:id/approve-review', requireActiveTenant, async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenant!.tenantId;
    const group = await prisma.batchGroup.findFirst({ where: { id: req.params.id, tenantId } });
    if (!group) { res.status(404).json({ success: false, error: '分组不存在' }); return; }

    const result = await approveReview(group.id, req.body?.declaration);

    eventEmitter.fire('batch.review_approved', tenantId, {
      groupId: group.id,
      billOfLading: group.billOfLading,
      score: result.score,
      passed: result.passed,
    }).catch(() => {});

    res.json({ success: true, data: result, message: result.passed ? '复核通过，已自动进入预检申报流程' : '预检未通过，请修正后重新复核' });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// 人工复核驳回
router.post('/:id/reject-review', requireActiveTenant, async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenant!.tenantId;
    const group = await prisma.batchGroup.findFirst({ where: { id: req.params.id, tenantId } });
    if (!group) { res.status(404).json({ success: false, error: '分组不存在' }); return; }

    const { reason } = req.body;
    await rejectReview(group.id, reason || '人工复核驳回');

    eventEmitter.fire('batch.review_rejected', tenantId, {
      groupId: group.id,
      billOfLading: group.billOfLading,
      reason,
    }).catch(() => {});

    res.json({ success: true, message: '已驳回，系统将重新填制' });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// 海关回执处理
router.post('/:id/customs-response', requireActiveTenant, async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenant!.tenantId;
    const group = await prisma.batchGroup.findFirst({ where: { id: req.params.id, tenantId } });
    if (!group) { res.status(404).json({ success: false, error: '分组不存在' }); return; }

    const { action, code, reason } = req.body;

    switch (action) {
      case 'accepted':
        await markCustomsAccepted(group.id);
        break;
      case 'rejected':
        if (!code || !reason) {
          res.status(400).json({ success: false, error: '退单需提供code和reason' });
          return;
        }
        await markCustomsRejected(group.id, code, reason);
        break;
      case 'released':
        await markReleased(group.id);
        break;
      case 'completed':
        await markCompleted(group.id);
        break;
      default:
        res.status(400).json({ success: false, error: '无效操作: ' + action });
        return;
    }

    eventEmitter.fire('batch.customs_response', tenantId, {
      groupId: group.id,
      billOfLading: group.billOfLading,
      action,
    }).catch(() => {});

    res.json({ success: true, message: '海关回执已处理' });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// 删除提运单分组 (含关联文档)
router.delete('/:id', requireActiveTenant, async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenant!.tenantId;
    const group = await prisma.batchGroup.findFirst({
      where: { id: req.params.id, tenantId },
    });
    if (!group) { res.status(404).json({ success: false, error: '不存在' }); return; }

    await prisma.document.deleteMany({ where: { batchGroupId: req.params.id } }).catch(() => {});
    await prisma.batchGroup.delete({ where: { id: req.params.id } });

    res.json({ success: true, message: '已删除' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || '删除失败' });
  }
});

// 导出整组 XML
// 单票报关单商品项数上限(按客户端/口岸调整;业内常见约50项,超出需分单申报)
const MAX_ITEMS_PER_DECLARATION = 50;

// 组装报关单数据(XML/CSV 导出共用)
async function assembleDeclarationData(group: any) {
  const docs = await prisma.document.findMany({
    where: { tenantId: group.tenantId, billOfLading: group.billOfLading },
  });
  let declarationData: any = {};
  if (group.declarationId) {
    const decl = await prisma.declaration.findFirst({
      where: { id: group.declarationId, tenantId: group.tenantId },
    });
    if (decl) {
      try {
        declarationData = JSON.parse(decl.declarationJson || '{}');
        declarationData.items = JSON.parse(decl.itemsJson || '[]');
        declarationData.declarationNo = decl.declarationNo || ('EXP-' + group.billOfLading);
        declarationData.documents = docs.map((d: any) => d.fileName);
        declarationData.totalValue = decl.totalValue ?? declarationData.totalValue ?? 0;
      } catch { /* fall through */ }
    }
  }
  if (!declarationData.items || declarationData.items.length === 0) {
    declarationData = {
      declarant: '', importerExporter: '', consignee: '', consignor: '',
      transportMode: '', vesselFlight: group.billOfLading || '',
      portOfLoading: '', portOfDischarge: '', portOfEntry: '',
      tradeTerms: 'FOB', currency: 'USD', totalValue: 0,
      freightMark: undefined, freightRate: undefined, freightCurrency: 'USD',
      insuranceMark: undefined, insuranceRate: undefined, insuranceCurrency: 'USD',
      otherMark: undefined, otherRate: undefined, otherCurrency: 'USD',
      declarationNo: 'EXP-' + group.billOfLading,
      items: [{ lineNo: 1, hsCode: '', quantity: 1, unit: '件', unitPrice: 0, totalPrice: 0, description: '', model: '',
        legalQty: undefined, legalUnit: '', legalQty2: undefined, legalUnit2: '', currency: 'USD', originCountry: '中国' }],
      documents: docs.map((d: any) => d.fileName),
    };
  }
  return declarationData;
}

router.get('/:id/export-xml', requireActiveTenant, async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenant!.tenantId;
    const group = await prisma.batchGroup.findFirst({
      where: { id: req.params.id, tenantId },
    });
    if (!group) {
      res.status(404).json({ success: false, error: '分组不存在' });
      return;
    }

    const declarationData = await assembleDeclarationData(group);
    const xml = generateCustomsXML(declarationData);

    const fileName = `declaration_${group.billOfLading || group.id}.xml`;

    // 项数上限提示:超出单票上限,前端据此提示分单
    if ((declarationData.items?.length || 0) > MAX_ITEMS_PER_DECLARATION) {
      res.setHeader('X-Item-Count-Warning', String(declarationData.items.length));
      res.setHeader('X-Item-Count-Limit', String(MAX_ITEMS_PER_DECLARATION));
    }

    // 导出即完成「线下申报登记」:checked → declared(已导出·已申报·待回执)
    await markExported(group.id, fileName).catch(() => {});

    res.setHeader('Content-Type', 'application/xml');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(xml);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || '导出XML失败' });
  }
});

// 报关单导出 CSV(对账/退税/留档用,非申报;铺平为表头+每行一个商品)
router.get('/:id/export-csv', requireActiveTenant, async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenant!.tenantId;
    const group = await prisma.batchGroup.findFirst({ where: { id: req.params.id, tenantId } });
    if (!group) { res.status(404).json({ success: false, error: '分组不存在' }); return; }
    const d = await assembleDeclarationData(group);
    const items: any[] = d.items || [];
    const esc = (v: any) => {
      const s = (v === null || v === undefined) ? '' : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const header = ['提单号', '报关单号', '贸易条款', '总价', '币制', '项号', 'HS编码', '品名', '数量', '单位', '单价', '总价(项)', '原产国'];
    const rows = items.map((it, i) => [
      group.billOfLading || '', d.declarationNo || '', d.tradeTerms || '', d.totalValue ?? '', d.currency || '',
      i + 1, it.hsCode || '', it.description || '', it.quantity ?? '', it.unit || '', it.unitPrice ?? '', it.totalPrice ?? '', it.originCountry || '',
    ]);
    // \uFEFF BOM 让 Excel 正确识别 UTF-8 中文
    const csv = '\uFEFF' + [header, ...rows].map(r => r.map(esc).join(',')).join('\r\n');
    if (items.length > MAX_ITEMS_PER_DECLARATION) {
      res.setHeader('X-Item-Count-Warning', String(items.length));
      res.setHeader('X-Item-Count-Limit', String(MAX_ITEMS_PER_DECLARATION));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="declaration_${group.billOfLading || group.id}.csv"`);
    res.send(csv);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || '导出CSV失败' });
  }
});

// 按提运单号启动自动化流水线(item2)
router.post('/start-by-bl', requireActiveTenant, async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenant!.tenantId;
    const { billOfLading, projectTag } = req.body;
    if (!billOfLading) { res.status(400).json({ success: false, error: '请提供提运单号' }); return; }
    const firstDoc = await prisma.document.findFirst({ where: { tenantId, billOfLading } });
    if (!firstDoc) { res.status(404).json({ success: false, error: '该提运单下暂无单据' }); return; }
    const { ensureBatchGroup, triggerGroupOCR } = await import('../../services/groupPipelineService');
    const groupId = await ensureBatchGroup(tenantId, billOfLading, firstDoc.id, projectTag || '');
    await triggerGroupOCR(groupId);
    res.json({ success: true, data: { groupId }, message: '已启动自动化流水线' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || '启动流水线失败' });
  }
});

// 按提运单号做跨单证一致性快检(item3)
router.get('/cross-check/:bl', requireActiveTenant, async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenant!.tenantId;
    const { groupCrossCheckByBL } = await import('../../services/documentAuditService');
    const result = await groupCrossCheckByBL(tenantId, String(req.params.bl));
    res.json({ success: true, data: result });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || '一致性校验失败' });
  }
});

export default router;
