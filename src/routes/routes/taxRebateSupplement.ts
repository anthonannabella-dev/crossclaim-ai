import { Router } from 'express';
import prisma from '../../config/database';
import { authenticate } from '../../middleware/auth';
import { requireActiveTenant } from '../../middleware/tenant';

const router = Router();
router.use(authenticate);
router.use(requireActiveTenant);

// ============================================================
// 供应商发票核验
// ============================================================

// 上传并OCR识别供应商发票
router.post('/supplier-invoice/upload', async (req, res) => {
  const tenantId = req.tenant!.tenantId;
  const { declarationId, docId, invoiceNo, invoiceDate, supplierName, supplierTaxId, itemsJson } = req.body;
  
  if (!invoiceNo) {
    res.status(400).json({ error: '请提供发票号码' });
    return;
  }
  
  try {
    // 如果传了docId，从Document读取OCR结果
    let ocrResult = null;
    let items = [];
    
    if (docId) {
      const doc = await prisma.document.findFirst({ where: { id: docId, tenantId } });
      if (doc?.ocrResult) {
        ocrResult = doc.ocrResult;
        try {
          const parsed = JSON.parse(doc.ocrResult);
          items = parsed.items || parsed.lines || [];
        } catch {}
      }
    }
    
    
    // 支持直接传入 itemsJson（手动录入或API调用）
    if (itemsJson) {
      try {
        if (typeof itemsJson === 'string') items = JSON.parse(itemsJson);
        else if (Array.isArray(itemsJson)) items = itemsJson;
      } catch {}
    }
    const invoice = await prisma.supplierInvoice.create({
      data: {
        tenantId,
        declarationId: declarationId || null,
        invoiceNo,
        invoiceDate: invoiceDate ? new Date(invoiceDate) : null,
        supplierName: supplierName || null,
        supplierTaxId: supplierTaxId || null,
        ocrResult: ocrResult ? JSON.stringify(ocrResult) : null,
        itemsJson: items.length > 0 ? JSON.stringify(items) : null,
        docId: docId || null,
      },
    });
    
    res.json({ success: true, data: invoice });
  } catch (err: any) {
    res.status(500).json({ error: err.message || '上传发票失败' });
  }
});

// 三要素比对：发票品名 vs 报关单品名
router.post('/supplier-invoice/:id/match', async (req, res) => {
  const tenantId = req.tenant!.tenantId;
  const { id } = req.params;
  
  try {
    const invoice = await prisma.supplierInvoice.findFirst({ where: { id, tenantId } });
    if (!invoice) { res.status(404).json({ error: '发票不存在' }); return; }
    if (!invoice.declarationId) { res.status(400).json({ error: '发票未关联报关单，请先关联' }); return; }
    
    const declaration = await prisma.declaration.findFirst({ where: { id: invoice.declarationId, tenantId } });
    if (!declaration) { res.status(404).json({ error: '报关单不存在' }); return; }
    
    // 解析报关单明细
    let declItems = [];
    try { declItems = JSON.parse(declaration.itemsJson || '[]'); } catch {}
    
    // 解析发票明细
    let invItems = [];
    try { invItems = JSON.parse(invoice.itemsJson || '[]'); } catch {}
    
    // 如果没有OCR明细，用发票号码做简单校验
    if (invItems.length === 0) {
      invItems = [{ name: invoice.supplierName || '未知商品', quantity: 1, unit: '件' }];
    }
    
    // 三要素比对：品名、数量、单位
    const matchResults = [];
    let matchedCount = 0;
    let totalCount = Math.max(declItems.length, 1);
    
    for (const di of declItems) {
      const declName = (di.description || di.goodsName || '').trim();
      const declQty = di.quantity || 0;
      const declUnit = (di.unit || '').trim();
      
      // 找最匹配的发票行
      let bestScore = 0;
      let bestInv = null;
      
      for (const ii of invItems) {
        const invName = (ii.name || ii.description || ii.goodsName || '').trim();
        const invQty = ii.quantity || 0;
        const invUnit = (ii.unit || '').trim();
        
        // 品名匹配（模糊）
        const nameScore = declName.includes(invName) || invName.includes(declName) ? 60 : 0;
        // 数量匹配
        const qtyScore = Math.abs(declQty - invQty) / Math.max(declQty, 1) < 0.1 ? 20 : 0;
        // 单位匹配
        const unitScore = declUnit === invUnit ? 20 : 0;
        
        const score = nameScore + qtyScore + unitScore;
        if (score > bestScore) { bestScore = score; bestInv = ii; }
      }
      
      matchResults.push({
        declarationItem: { name: declName, quantity: declQty, unit: declUnit },
        invoiceItem: bestInv ? { name: bestInv.name || '', quantity: bestInv.quantity || 0, unit: bestInv.unit || '' } : null,
        score: bestScore,
        passed: bestScore >= 60,
      });
      
      if (bestScore >= 60) matchedCount++;
    }
    
    const matchScore = Math.round((matchedCount / totalCount) * 100);
    const matchStatus = matchScore >= 80 ? 'matched' : 'mismatch';
    const issued = matchResults.filter(r => !r.passed).map(r => r.declarationItem.name);
    
    const detail = JSON.stringify({
      totalItems: totalCount,
      matchedItems: matchedCount,
      score: matchScore,
      issues: issued,
      details: matchResults,
    });
    
    await prisma.supplierInvoice.update({
      where: { id },
      data: { matchStatus, matchScore, matchDetail: detail },
    });
    
    res.json({
      success: true,
      data: { matchStatus, matchScore, issues: issued, details: matchResults },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || '比对失败' });
  }
});

// 供应商发票列表
router.get('/supplier-invoice/list', async (req, res) => {
  const tenantId = req.tenant!.tenantId;
  const { declarationId, status } = req.query;
  
  const where = { tenantId } as any;
  if (declarationId) where.declarationId = declarationId;
  if (status) where.matchStatus = status;
  
  const items = await prisma.supplierInvoice.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  
  res.json({ success: true, data: items });
});

// ============================================================
// 出口发票管理
// ============================================================

router.post('/export-invoice/create', async (req, res) => {
  const tenantId = req.tenant!.tenantId;
  const { declarationId, invoiceNo, invoiceDate, totalAmount, contractNo } = req.body;
  
  if (!invoiceNo || !totalAmount) {
    res.status(400).json({ error: '缺少必填字段' });
    return;
  }
  
  const invoice = await prisma.exportInvoice.create({
    data: {
      tenantId,
      declarationId: declarationId || null,
      invoiceNo,
      invoiceDate: invoiceDate ? new Date(invoiceDate) : new Date(),
      totalAmount,
      contractNo: contractNo || null,
    },
  });
  
  res.json({ success: true, data: invoice });
});

router.get('/export-invoice/list', async (req, res) => {
  const tenantId = req.tenant!.tenantId;
  const items = await prisma.exportInvoice.findMany({
    where: { tenantId },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  res.json({ success: true, data: items });
});

// ============================================================
// 收汇跟踪
// ============================================================

router.post('/receipt/create', async (req, res) => {
  const tenantId = req.tenant!.tenantId;
  const { declarationId, receiptNo, receiptDate, receiptAmount, currency, exchangeRate, bankName, payerName, docId } = req.body;
  
  if (!receiptNo || !receiptAmount) {
    res.status(400).json({ error: '缺少必填字段' });
    return;
  }
  
  const amountCNY = receiptAmount * (exchangeRate || 7.1);
  
  // 检查是否超期210天
  let overdueStatus = 'normal';
  if (receiptDate) {
    const daysSinceExport = Math.floor((Date.now() - new Date(receiptDate).getTime()) / 86400000);
    if (daysSinceExport > 210) overdueStatus = 'overdue';
  }
  
  const record = await prisma.receiptRecord.create({
    data: {
      tenantId,
      declarationId: declarationId || null,
      receiptNo,
      receiptDate: receiptDate ? new Date(receiptDate) : new Date(),
      receiptAmount,
      currency: currency || 'USD',
      exchangeRate: exchangeRate || 7.1,
      amountCNY: Math.round(amountCNY * 100) / 100,
      bankName: bankName || null,
      payerName: payerName || null,
      overdueStatus,
      docId: docId || null,
    },
  });
  
  res.json({ success: true, data: record });
});

router.get('/receipt/list', async (req, res) => {
  const tenantId = req.tenant!.tenantId;
  const items = await prisma.receiptRecord.findMany({
    where: { tenantId },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  res.json({ success: true, data: items });
});

// ============================================================
// 备案单证归档
// ============================================================

router.post('/archive/create', async (req, res) => {
  const tenantId = req.tenant!.tenantId;
  const { declarationId, name } = req.body;
  
  if (!name) { res.status(400).json({ error: '请输入单证组名称' }); return; }
  
  const archive = await prisma.recordArchive.create({
    data: {
      tenantId,
      declarationId: declarationId || null,
      name,
    },
  });
  
  res.json({ success: true, data: archive });
});

// 更新单证状态
router.put('/archive/:id/update-docs', async (req, res) => {
  const tenantId = req.tenant!.tenantId;
  const { id } = req.params;
  const { hasContract, hasTransport, hasDeclaration, hasInvoice, hasPackingList, hasReceipt } = req.body;
  
  const archive = await prisma.recordArchive.findFirst({ where: { id, tenantId } });
  if (!archive) { res.status(404).json({ error: '不存在' }); return; }
  
  const update: any = {};
  if (hasContract !== undefined) update.hasContract = hasContract;
  if (hasTransport !== undefined) update.hasTransport = hasTransport;
  if (hasDeclaration !== undefined) update.hasDeclaration = hasDeclaration;
  if (hasInvoice !== undefined) update.hasInvoice = hasInvoice;
  if (hasPackingList !== undefined) update.hasPackingList = hasPackingList;
  if (hasReceipt !== undefined) update.hasReceipt = hasReceipt;
  
  // 自动判断状态
  const all = {
    contract: update.hasContract ?? archive.hasContract,
    transport: update.hasTransport ?? archive.hasTransport,
    declaration: update.hasDeclaration ?? archive.hasDeclaration,
    invoice: update.hasInvoice ?? archive.hasInvoice,
    packing: update.hasPackingList ?? archive.hasPackingList,
    receipt: update.hasReceipt ?? archive.hasReceipt,
  };
  const complete = Object.values(all).every(Boolean);
  update.status = complete ? 'complete' : 'incomplete';
  
  // 如果全部齐全则归档
  if (complete) {
    update.archiveDate = new Date();
    // 保存10年
    const tenYears = new Date();
    tenYears.setFullYear(tenYears.getFullYear() + 10);
    update.expiryDate = tenYears;
  }
  
  await prisma.recordArchive.update({ where: { id }, data: update });
  
  res.json({ success: true, data: { ...archive, ...update } });
});

router.get('/archive/list', async (req, res) => {
  const tenantId = req.tenant!.tenantId;
  const items = await prisma.recordArchive.findMany({
    where: { tenantId },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  res.json({ success: true, data: items });
});

// ============================================================
// 退税记录（状态机）
// ============================================================

// 创建退税申报记录（从计算器结果创建）
router.post('/record/create', async (req, res) => {
  const tenantId = req.tenant!.tenantId;
  const { declarationId, hsCode, description, quantity, unit, fobAmountUSD, fobAmountCNY, exportRate, vatRate, rebateAmount, nonRefundable } = req.body;
  
  const record = await prisma.taxRebateRecord.create({
    data: {
      tenantId,
      declarationId: declarationId || null,
      hsCode,
      description: description || '',
      quantity: quantity || 0,
      unit: unit || '件',
      fobAmountUSD: fobAmountUSD || 0,
      fobAmountCNY: fobAmountCNY || 0,
      exportRate: exportRate || 0,
      vatRate: vatRate || 0,
      rebateAmount: rebateAmount || 0,
      nonRefundable: nonRefundable || 0,
      status: 'calculated',
      calculatedAt: new Date(),
    },
  });
  
  res.json({ success: true, data: record });
});

// 更新进度
router.put('/record/:id/progress', async (req, res) => {
  const tenantId = req.tenant!.tenantId;
  const { id } = req.params;
  const { status, supplierInvoiceId, exportInvoiceId, receiptId, archiveId, note } = req.body;
  
  const validStatuses = ['calculated', 'invoice_matched', 'receipt_confirmed', 'documents_ready', 'submitted', 'under_review', 'refunded', 'rejected'];
  if (status && !validStatuses.includes(status)) {
    res.status(400).json({ error: '无效状态值' });
    return;
  }
  
  const update: any = {};
  if (status) update.status = status;
  if (supplierInvoiceId !== undefined) update.supplierInvoiceId = supplierInvoiceId;
  if (exportInvoiceId !== undefined) update.exportInvoiceId = exportInvoiceId;
  if (receiptId !== undefined) update.receiptId = receiptId;
  if (archiveId !== undefined) update.archiveId = archiveId;
  if (note !== undefined) update.note = note;
  
  if (status === 'submitted') update.submittedAt = new Date();
  if (status === 'under_review') update.reviewedAt = new Date();
  if (status === 'refunded') update.refundedAt = new Date();
  
  await prisma.taxRebateRecord.updateMany({ where: { id, tenantId }, data: update });
  
  res.json({ success: true });
});

// 退税记录列表
router.get('/record/list', async (req, res) => {
  const tenantId = req.tenant!.tenantId;
  const { status } = req.query;
  
  const where = { tenantId } as any;
  if (status) where.status = status;
  
  const items = await prisma.taxRebateRecord.findMany({
    where,
    orderBy: { updatedAt: 'desc' },
    take: 200,
  });
  
  res.json({ success: true, data: items });
});

// 退税统计数据
router.get('/record/stats', async (req, res) => {
  const tenantId = req.tenant!.tenantId;
  
  const all = await prisma.taxRebateRecord.findMany({ where: { tenantId }, select: { status: true, rebateAmount: true } });
  
  const stats = {
    total: all.length,
    totalRebate: Math.round(all.reduce((s: any, r: any) => s + r.rebateAmount, 0) * 100) / 100,
    byStatus: {} as Record<string, { count: number; amount: number }>,
  };
  
  for (const r of all) {
    if (!stats.byStatus[r.status]) stats.byStatus[r.status] = { count: 0, amount: 0 };
    stats.byStatus[r.status].count++;
    stats.byStatus[r.status].amount += r.rebateAmount;
  }
  
  res.json({ success: true, data: stats });
});

export default router;
