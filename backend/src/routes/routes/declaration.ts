import { Router } from 'express';
import prisma from '../../config/database';
import { authenticate } from '../../middleware/auth';
import { requireActiveTenant } from '../../middleware/tenant';
import { buildDeclaration, runPreCheck, batchBuildDeclarations } from '../../services/declarationBuilder';
import { withQuota } from '../../middleware/usageMiddleware';

const router = Router();
router.use(authenticate);
router.use(requireActiveTenant);

// 构建报关单
router.post('/build', ...withQuota('declaration_build'), async (req, res) => {
  const tenantId = req.tenant!.tenantId;
  const {
    hsCodes, itemDetails, importerExporter, transportMode, vesselFlight,
    portOfLoading, portOfDischarge, portOfEntry, tradeTerms, currency,
    customsMode, logisticsNo, ecommercePlatform, ecommercePlatformCode, orderNo, paymentNo, deliveryMethod, receiverIdType, receiverIdNumber,
    contractNo, b2bOrderNo, b2bPlatform, b2bOrderAmount, b2bProductUrl,
    warehouseAddress, warehouseCode, inboundOrderNo, destinationCountry, fnSku, returnAddress, estimatedSalesChannel,
    bondedWarehouseId, bondedWarehouseName, consumerIdType, consumerIdNumber, consumerName, consumerPhone, tariffRateApplied, taxReductionType,
    consignee, consignor,
    freightMark, freightRate, freightCurrency,
    insuranceMark, insuranceRate, insuranceCurrency,
    otherMark, otherRate, otherCurrency,
  } = req.body;

  if (!hsCodes || !Array.isArray(hsCodes) || hsCodes.length === 0) {
    res.status(400).json({ success: false, error: '请提供至少一个HS编码' });
    return;
  }

  try {
    const result = await buildDeclaration(tenantId, {
      hsCodes,
      itemDetails,
      importerExporter,
      transportMode,
      vesselFlight,
      portOfLoading,
      portOfDischarge,
      portOfEntry,
      tradeTerms,
      currency,
      customsMode,
      logisticsNo,
      ecommercePlatform,
      ecommercePlatformCode,
      orderNo,
      paymentNo,
      deliveryMethod,
      receiverIdType,
      receiverIdNumber,
      contractNo,
      b2bOrderNo,
      b2bPlatform,
      b2bOrderAmount,
      b2bProductUrl,
      warehouseAddress,
      warehouseCode,
      inboundOrderNo,
      destinationCountry,
      fnSku,
      returnAddress,
      estimatedSalesChannel,
      bondedWarehouseId,
      bondedWarehouseName,
      consumerIdType,
      consumerIdNumber,
      consumerName,
      consumerPhone,
      tariffRateApplied,
      taxReductionType,
      consignee,
      consignor,
      freightMark, freightRate, freightCurrency,
      insuranceMark, insuranceRate, insuranceCurrency,
      otherMark, otherRate, otherCurrency,
    });

    res.json({ success: true, data: result });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || '报关单构建失败' });
  }
});

// 合规预检（不导出）。支持两种入参:
//   1) { declaration } 直接传完整报关单数据(单票页/批量构建)
//   2) { id }          传报关单ID, 由系统从草稿/已存记录中取出再校验(批量预检页)
router.post('/pre-check', async (req, res) => {
  let { declaration } = req.body;
  const { id } = req.body;

  // 按 id 拉取已持久化的报关单
  if (!declaration && id) {
    try {
      const { getDeclarationDetail } = await import('../../services/declarationService');
      const detail = await getDeclarationDetail(req.tenant!.tenantId, id);
      if (!detail) {
        res.status(404).json({ success: false, error: '报关单不存在' });
        return;
      }
      declaration = (detail as any).declaration || {};
      declaration.items = (detail as any).items || [];
    } catch (e: any) {
      res.status(500).json({ success: false, error: '读取报关单失败: ' + e.message });
      return;
    }
  }

  if (!declaration || !declaration.items) {
    res.status(400).json({ success: false, error: '请提供完整的报关单数据或有效的报关单ID' });
    return;
  }

  try {
    const { aiPreCheckSupplement } = await import('../../services/declarationBuilder');
    const preCheck = runPreCheck(declaration);

    const aiInsight = String(await aiPreCheckSupplement(declaration, null).catch(() => ''));
    if (aiInsight) {
      preCheck.issues.push({
        severity: 'info', code: 'AI001',
        message: 'AI分析: ' + aiInsight,
      });
    }

    await prisma.auditLog.create({
      data: {
        tenantId: req.tenant!.tenantId,
        action: 'declaration_precheck',
        entityType: ((declaration as any)?.billOfLading || (declaration as any)?.transport?.billOfLading) ? 'bill_of_lading' : null,
        entityId: (declaration as any)?.billOfLading || (declaration as any)?.transport?.billOfLading || null,
        detail: `合规预检: ${declaration.items.length}项 | 得分: ${preCheck.score} | ${preCheck.passed ? '通过' : '未通过'}`,
      },
    }).catch(() => {});

    res.json({ success: true, data: preCheck });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 导出XML
router.post('/export-xml', async (req, res) => {
  const tenantId = req.tenant!.tenantId;
  const { declaration } = req.body;

  if (!declaration) {
    res.status(400).json({ success: false, error: '缺少报关单数据' });
    return;
  }

  try {
    const { generateCustomsXML } = await import('../../services/declarationBuilder');
    const xmlContent = generateCustomsXML(declaration);

    await prisma.auditLog.create({
      data: {
        tenantId,
        action: 'declaration_export_xml',
        entityType: ((declaration as any)?.billOfLading || (declaration as any)?.transport?.billOfLading) ? 'bill_of_lading' : null,
        entityId: (declaration as any)?.billOfLading || (declaration as any)?.transport?.billOfLading || null,
        detail: `XML导出: ${declaration.items?.length || 0}项商品`,
      },
    }).catch(() => {});

    // Webhook事件
    import('../../services/webhook/eventEmitter').then(({ eventEmitter }) =>
      eventEmitter.fire('declaration.xml_exported', tenantId, {
        itemsCount: declaration.items?.length || 0,
        totalValue: declaration.totalValue,
        exportFormat: 'xml',
      }).catch(() => {}),
    );

    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="declaration_${Date.now()}.xml"`);
    res.send(xmlContent);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 导出PDF报关单（无签章，供打印/对单/归档用）
router.post('/export-pdf', async (req, res) => {
  const { declaration, preCheck } = req.body;

  if (!declaration) {
    res.status(400).json({ success: false, error: '\u7f3a\u5c11\u62a5\u5173\u5355\u6570\u636e' });
    return;
  }

  try {
    const { generateDeclarationPDF } = await import('../../services/pdfGenerator');
    const pdfBuffer = await generateDeclarationPDF(declaration, preCheck);

    const tenantId = req.tenant!.tenantId;

    await prisma.auditLog.create({
      data: {
        tenantId,
        action: 'declaration_export_pdf',
        entityType: ((declaration as any)?.billOfLading || (declaration as any)?.transport?.billOfLading) ? 'bill_of_lading' : null,
        entityId: (declaration as any)?.billOfLading || (declaration as any)?.transport?.billOfLading || null,
        detail: `PDF\u5bfc\u51fa: ${declaration.items?.length || 0}\u9879\u5546\u54c1`,
      },
    }).catch(() => {});

    // Webhook事件
    import('../../services/webhook/eventEmitter').then(({ eventEmitter }) =>
      eventEmitter.fire('declaration.xml_exported', tenantId, {
        itemsCount: declaration.items?.length || 0,
        totalValue: declaration.totalValue,
        exportFormat: 'pdf',
      }).catch(() => {}),
    );

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="declaration_${Date.now()}.pdf"`);
    res.send(pdfBuffer);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || 'PDF\u751f\u6210\u5931\u8d25' });
  }
});



// ============================================================
// 草稿箱 + 历史 + 退单重报
// ============================================================

// 保存草稿/更新草稿
router.post('/save-draft', async (req, res) => {
  const tenantId = req.tenant!.tenantId;
  const { declaration, preCheck } = req.body;
  if (!declaration) { res.status(400).json({ success: false, error: '\u7f3a\u5c11\u62a5\u5173\u5355\u6570\u636e' }); return; }
  try {
    const { saveDraft } = await import('../../services/declarationService');
    const result = await saveDraft(tenantId, declaration, preCheck);
    res.json({ success: true, data: { id: result.id } });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

// 提交（草稿 -> 已提交）
router.post('/:id/submit', async (req, res) => {
  try {
    const { submitDeclaration } = await import('../../services/declarationService');
    await submitDeclaration(req.tenant!.tenantId, req.params.id);
    res.json({ success: true });
  } catch (err: any) { res.status(400).json({ success: false, error: err.message }); }
});

// 退单
router.post('/:id/reject', async (req, res) => {
  try {
    const { rejectDeclaration } = await import('../../services/declarationService');
    await rejectDeclaration(req.tenant!.tenantId, req.params.id, req.body.code, req.body.reason);
    res.json({ success: true });
  } catch (err: any) { res.status(400).json({ success: false, error: err.message }); }
});

// 重报（退单 -> 已重报，可改单）
router.post('/:id/resubmit', async (req, res) => {
  try {
    const { resubmitDeclaration } = await import('../../services/declarationService');
    await resubmitDeclaration(req.tenant!.tenantId, req.params.id, req.body.declaration, req.body.preCheck);
    res.json({ success: true });
  } catch (err: any) { res.status(400).json({ success: false, error: err.message }); }
});

// 完成报关
router.post('/:id/complete', async (req, res) => {
  try {
    const { completeDeclaration } = await import('../../services/declarationService');
    await completeDeclaration(req.tenant!.tenantId, req.params.id);
    res.json({ success: true });
  } catch (err: any) { res.status(400).json({ success: false, error: err.message }); }
});

// 查询列表（草稿箱/历史）
router.get('/list', async (req, res) => {
  try {
    const { listDeclarations } = await import('../../services/declarationService');
    const { status, customsMode, page, pageSize } = req.query;
    const result = await listDeclarations(req.tenant!.tenantId, {
      status: status as string, customsMode: customsMode as string,
      page: page ? Number(page) : 1, pageSize: pageSize ? Number(pageSize) : 20,
    });
    res.json({ success: true, data: result });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

// 单条详情
router.get('/:id/detail', async (req, res) => {
  try {
    const { getDeclarationDetail } = await import('../../services/declarationService');
    const detail = await getDeclarationDetail(req.tenant!.tenantId, req.params.id);
    if (!detail) { res.status(404).json({ success: false, error: '\u4e0d\u5b58\u5728' }); return; }
    res.json({ success: true, data: detail });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

// 删除草稿
router.delete('/:id', async (req, res) => {
  try {
    const { deleteDeclaration } = await import('../../services/declarationService');
    await deleteDeclaration(req.tenant!.tenantId, req.params.id);
    res.json({ success: true });
  } catch (err: any) { res.status(400).json({ success: false, error: err.message }); }
});

// ============================================================
// Excel 导入/导出
// ============================================================

// 导出 Excel
router.get('/export-excel', async (req, res) => {
  try {
    const { listDeclarations, exportDeclarationsToExcel } = await import('../../services/declarationService');
    const { status, customsMode } = req.query;
    const result = await listDeclarations(req.tenant!.tenantId, {
      status: status as string, customsMode: customsMode as string, page: 1, pageSize: 5000,
    });
    const buffer = exportDeclarationsToExcel(result.items);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="declarations_${Date.now()}.xlsx"`);
    res.send(buffer);
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

// 下载批量导入模板(xlsx, 含表头+示例+填表说明)
router.get('/import-template', async (req, res) => {
  try {
    const { generateImportTemplate } = await import('../../services/declarationService');
    const buf = generateImportTemplate();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="batch_import_template.xlsx"');
    res.send(buf);
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

// 导入 Excel
router.post('/import-excel', async (req, res) => {
  try {
    const { importDeclarationsFromExcel } = await import('../../services/declarationService');
    const { buffer } = req.body;
    if (!buffer) { res.status(400).json({ success: false, error: '\u7f3a\u5c11Excel\u6570\u636e' }); return; }
    const decoded = Buffer.from(buffer, 'base64');
    const parsed = importDeclarationsFromExcel(decoded);
    res.json({ success: true, data: { count: parsed.length, items: parsed } });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

// 把多个报关单 XML 打包成 ZIP 返回(服务端打包, 单文件下载)
router.post('/zip-xml', async (req, res) => {
  const { files } = req.body as { files?: { name?: string; content?: string }[] };
  if (!Array.isArray(files) || files.length === 0) {
    res.status(400).json({ success: false, error: '请提供要打包的XML文件列表' });
    return;
  }
  try {
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    const used = new Set<string>();
    files.forEach((f, i) => {
      if (!f || !f.content) return;
      let name = (f.name || `declaration_${i + 1}`).replace(/[\\/:*?"<>|]+/g, '_');
      if (!name.toLowerCase().endsWith('.xml')) name += '.xml';
      while (used.has(name)) name = name.replace(/\.xml$/i, '') + `_${i}.xml`;
      used.add(name);
      zip.file(name, f.content);
    });
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="declarations_${Date.now()}.zip"`);
    res.send(buf);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || 'ZIP打包失败' });
  }
});


// 批量构建+持久化
router.post('/batch-export', async (req, res) => {
  const tenantId = req.tenant!.tenantId;
  const { batches } = req.body;

  if (!batches || !Array.isArray(batches) || batches.length === 0) {
    res.status(400).json({ success: false, error: '请提供批量申报数据' });
    return;
  }

  try {
    const results = await batchBuildDeclarations(tenantId, batches);

    // 所有数据都持久化到 Declaration 表（含预检未通过，方便用户修正）
    const savedIds: string[] = [];
    for (const r of results) {
      try {
        const { saveDraft } = await import('../../services/declarationService');
        const saved = await saveDraft(tenantId, r.declaration, r.preCheck);
        savedIds.push(saved.id);
      } catch (saveErr: any) {
        console.error('批量导入保存失败:', saveErr.message);
      }
    }

    res.json({
      success: true,
      data: {
        declarations: results.map(r => ({
          declarationNo: r.declaration.declarationNo,
          summary: `${r.declaration.items.length}项 | 总金额${r.declaration.totalValue.toFixed(2)} | 合规: ${r.preCheck.passed ? '通过' : '未通过'}`,
          itemCount: r.declaration.items.length,
          preCheck: r.preCheck,
          xml: r.xmlContent,
        })),
        count: results.length,
        savedCount: savedIds.length,
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 获取最近构建历史
router.get('/history', async (req, res) => {
  const records = await prisma.auditLog.findMany({
    where: {
      tenantId: req.tenant!.tenantId,
      action: { in: ['declaration_build', 'declaration_precheck', 'declaration_export_xml'] },
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  res.json(records);
});

// ============================================================
// 提运单归集
// ============================================================

// 提运单列表（按提单号归集）
router.get('/bill-of-lading/list', async (req, res) => {
  try {
    const { listBillOfLading } = await import('../../services/declarationService');
    const groups = await listBillOfLading(req.tenant!.tenantId);
    res.json({ success: true, data: groups });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 按提运单号查询详情
router.get('/bill-of-lading/:blNo', async (req, res) => {
  try {
    const { getDeclarationsByBL } = await import('../../services/declarationService');
    const group = await getDeclarationsByBL(req.tenant!.tenantId, req.params.blNo);
    if (!group) {
      res.status(404).json({ success: false, error: '提运单不存在' });
      return;
    }
    res.json({ success: true, data: group });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 按提单号聚合全链路时间线: 单证 / 申报 / 批次流水线 / 报文快照 / 操作日志
// 把分散在四个模块的事件按提单号合并成一条按时间排序的轨迹,供前端一屏追溯。
router.get('/bill-of-lading/:blNo/timeline', async (req, res) => {
  try {
    const tenantId = req.tenant!.tenantId;
    const blNo = decodeURIComponent(req.params.blNo);

    const [docs, decls, groups, logs] = await Promise.all([
      prisma.document.findMany({
        where: { tenantId, billOfLading: blNo },
        select: { id: true, fileName: true, category: true, status: true, auditPassed: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.declaration.findMany({
        where: { tenantId, billOfLading: blNo },
        select: { id: true, declarationNo: true, status: true, customsMode: true, totalValue: true, currency: true, score: true, preCheckPassed: true, rejectionReason: true, createdAt: true, updatedAt: true },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.batchGroup.findMany({
        where: { tenantId, billOfLading: blNo },
        select: { id: true, status: true, docCount: true, declarationId: true, xmlPath: true, declarationSnapshotAt: true, declaredAt: true, archivedAt: true, taxRebateStatus: true, createdAt: true, updatedAt: true },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.auditLog.findMany({
        where: {
          tenantId,
          OR: [
            { entityType: 'bill_of_lading', entityId: blNo }, // 精确串联
            { detail: { contains: blNo } },                    // 兼容存量未打标日志
          ],
        },
        orderBy: { createdAt: 'asc' },
        take: 500,
      }),
    ]);

    if (docs.length === 0 && decls.length === 0 && groups.length === 0 && logs.length === 0) {
      res.status(404).json({ success: false, error: '该提单号下无任何记录' });
      return;
    }

    type Ev = { time: string; source: string; type: string; title: string; status?: string | null; refId?: string; meta?: any };
    const events: Ev[] = [];

    for (const d of docs) {
      events.push({
        time: d.createdAt.toISOString(), source: 'document', type: 'doc_uploaded',
        title: `上传单证: ${d.fileName}`, status: d.auditPassed == null ? d.status : (d.auditPassed ? '校验通过' : '校验未通过'),
        refId: d.id, meta: { category: d.category },
      });
    }
    for (const dec of decls) {
      events.push({
        time: dec.createdAt.toISOString(), source: 'declaration', type: 'declaration_created',
        title: `生成报关单${dec.declarationNo ? ' ' + dec.declarationNo : ''}`, status: dec.status,
        refId: dec.id, meta: { customsMode: dec.customsMode, totalValue: dec.totalValue, currency: dec.currency, score: dec.score, preCheckPassed: dec.preCheckPassed },
      });
      if (dec.updatedAt && dec.updatedAt.getTime() !== dec.createdAt.getTime()) {
        events.push({
          time: dec.updatedAt.toISOString(), source: 'declaration', type: 'declaration_status',
          title: `报关单状态: ${dec.status}`, status: dec.status, refId: dec.id,
          meta: dec.rejectionReason ? { rejectionReason: dec.rejectionReason } : undefined,
        });
      }
    }
    for (const g of groups) {
      events.push({ time: g.createdAt.toISOString(), source: 'batch_group', type: 'group_created', title: `创建批次(${g.docCount}份单证)`, status: g.status, refId: g.id });
      if (g.declarationSnapshotAt) events.push({ time: g.declarationSnapshotAt.toISOString(), source: 'batch_group', type: 'xml_snapshot', title: '生成申报报文快照(可调档)', status: g.status, refId: g.id, meta: { xmlPath: g.xmlPath } });
      if (g.declaredAt) events.push({ time: g.declaredAt.toISOString(), source: 'batch_group', type: 'declared', title: '已申报', status: g.status, refId: g.id });
      if (g.archivedAt) events.push({ time: g.archivedAt.toISOString(), source: 'batch_group', type: 'archived', title: '已归档(可调档检索)', status: g.status, refId: g.id });
    }
    for (const l of logs) {
      events.push({ time: l.createdAt.toISOString(), source: 'audit', type: l.action, title: l.detail, refId: l.id, meta: { operatorId: l.operatorId || null, ip: l.ip || null } });
    }

    events.sort((a, b) => a.time.localeCompare(b.time));

    const latestGroup = groups[groups.length - 1];
    res.json({
      success: true,
      data: {
        billOfLading: blNo,
        summary: {
          currentStatus: latestGroup?.status || decls[decls.length - 1]?.status || 'unknown',
          documentCount: docs.length,
          declarationCount: decls.length,
          batchGroupCount: groups.length,
          hasXmlSnapshot: groups.some((g: any) => !!g.declarationSnapshotAt),
          archived: groups.some((g: any) => !!g.archivedAt),
          operationCount: logs.length,
          firstActivityAt: events[0]?.time || null,
          lastActivityAt: events[events.length - 1]?.time || null,
        },
        timeline: events,
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || '获取提单时间线失败' });
  }
});

export default router;
