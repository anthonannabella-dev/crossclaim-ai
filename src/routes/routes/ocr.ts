import { Router } from 'express';
import multer from 'multer';
import { authenticate, authenticateAdmin } from '../../middleware/auth';
import { requireActiveTenant } from '../../middleware/tenant';
import { withQuota } from '../../middleware/usageMiddleware';
import { processBatchOCR, ocrWithClassification } from '../../services/batchOCR';

// 海关报关随附单证文件校验
// 依据: 中国海关总署 2018年 第178号公告、单一窗口技术规范
const CUSTOMS_ALLOWED_EXT = ['pdf', 'png', 'jpg', 'jpeg', 'tiff', 'bmp'];
const CUSTOMS_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB 单张上限
const CUSTOMS_MAX_TOTAL_SIZE = 50 * 1024 * 1024; // 50MB 一批次上限
const CUSTOMS_MAX_BATCH = 50; // 一批次最多10份

function validateCustomsFile(file: Express.Multer.File, index?: number, totalFiles?: number): string | null {
  const ext = file.originalname.split('.').pop()?.toLowerCase();
  if (!ext || !CUSTOMS_ALLOWED_EXT.includes(ext)) {
    return `海关不接受 .${ext || '未知'} 格式，仅支持 PDF/JPG/PNG/TIFF/BMP`;
  }
  if (file.size > CUSTOMS_MAX_FILE_SIZE) {
    return `文件过大 (${(file.size / 1024 / 1024).toFixed(1)}MB)，海关要求单张不超过 10MB`;
  }
  return null;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 51 * 1024 * 1024 }, // 51MB > 批次上限，让校验逻辑拦截
});

const router = Router();

// 双认证中间件：同时支持租户 JWT 和管理员 JWT
router.use((req: any, res: any, next: any) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: '\u672a\u63d0\u4f9b\u6709\u6548\u7684\u8ba4\u8bc1\u4ee4\u724c' });
    return;
  }
  try {
    const token = header.slice(7);
    const jwt = require('jsonwebtoken');
    const { env } = require('../../config/env');
    const payload = jwt.verify(token, env().JWT_SECRET);
    
    // 租户 JWT → 标准认证
    if (payload.tenantId) {
      req.tenant = payload;
      next();
      return;
    }
    
    // 管理员 JWT (admin-login 发的 token)
    if (payload.id && payload.role) {
      req.tenant = { tenantId: 'admin', role: 'admin', subAccountId: undefined };
      req.isAdmin = true;
      next();
      return;
    }
    
    res.status(403).json({ error: '\u65e0\u6cd5\u8bc6\u522b\u7528\u6237\u8eab\u4efd' });
  } catch {
    res.status(401).json({ error: '\u8ba4\u8bc1\u4ee4\u724c\u65e0\u6548\u6216\u5df2\u8fc7\u671f' });
  }
});

// 单文件OCR识别 + 智能分类
router.post('/recognize', upload.single('file'), async (req: any, res: any) => {
  if (!req.file) {
    res.status(400).json({ error: '\u8bf7\u4e0a\u4f20\u6587\u4ef6' });
    return;
  }

  // 海关文件校验
  const fileErr = validateCustomsFile(req.file);
  if (fileErr) {
    res.status(400).json({ success: false, error: fileErr });
    return;
  }

  const tenantId = req.tenant!.tenantId;
  const result = await ocrWithClassification(tenantId, req.file.buffer, req.file.originalname);

  res.json(result);
});

// 批量OCR识别录入
router.post('/parse-to-declaration', upload.single('file'), async (req: any, res: any) => {
  if (!req.file) {
    res.status(400).json({ error: '\u8bf7\u4e0a\u4f20\u6587\u4ef6' });
    return;
  }

  // 海关文件校验
  const fileErr = validateCustomsFile(req.file);
  if (fileErr) {
    res.status(400).json({ success: false, error: fileErr });
    return;
  }

  try {
    const { processBatchOCR } = await import('../../services/batchOCR');
    const { extractFieldsFromOCR, ocrToDeclaration } = await import('../../services/ocrParser');
    const tenantId = req.tenant!.tenantId;
    const targetMode = req.body.mode || 'normal';

    // Step 1: OCR 识别
    const ocrResult = await processBatchOCR(tenantId, [{
      buffer: req.file.buffer,
      originalname: req.file.originalname,
      mimetype: req.file.mimetype,
    }], 'customs_declaration');

    if (!ocrResult[0]?.success || !ocrResult[0]?.text) {
      res.status(400).json({ error: 'OCR \u8bc6\u522b\u5931\u8d25', ocrError: ocrResult[0]?.error });
      return;
    }

    // Step 2: AI 结构化解析
    const parsed = await extractFieldsFromOCR(ocrResult[0].text, req.file.originalname, targetMode);

    res.json({
      success: true,
      data: {
        ocrText: ocrResult[0].text.slice(0, 2000),
        parsed,
        documentId: ocrResult[0].documentId,
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || '\u89e3\u6790\u5931\u8d25' });
  }
});

// 跨境电商智能识别 — 上传订单/运单/装箱单 → OCR → AI提取电商申报字段
router.post('/parse-ecommerce', upload.single('file'), async (req: any, res: any) => {
  if (!req.file && !req.body.text) {
    res.status(400).json({ error: '\u8bf7\u4e0a\u4f20\u6587\u4ef6\u6216\u63d0\u4f9b\u6587\u672c' });
    return;
  }

  try {
    const { extractFieldsFromOCR } = await import('../../services/ocrParser');
    const tenantId = req.tenant!.tenantId;
    const targetMode = req.body.mode || '9610';

    let ocrText = req.body.text || '';
    let sourceName = req.body.text ? 'manual-text' : (req.file?.originalname || 'file');
    let documentId = '';

    if (!ocrText && req.file) {
      const { processBatchOCR } = await import('../../services/batchOCR');
      const ocrResult = await processBatchOCR(tenantId, [{
        buffer: req.file.buffer,
        originalname: req.file.originalname,
        mimetype: req.file.mimetype,
      }], 'customs_declaration');

      if (!ocrResult[0]?.success || !ocrResult[0]?.text) {
        res.status(400).json({ error: 'OCR \u8bc6\u522b\u5931\u8d25', ocrError: ocrResult[0]?.error });
        return;
      }
      ocrText = ocrResult[0].text;
      documentId = ocrResult[0].documentId || '';
    }

    const parsed = await extractFieldsFromOCR(ocrText, sourceName, targetMode);

    res.json({
      success: true,
      data: {
        ocrText: ocrText.slice(0, 2000),
        parsed: {
          // 跨境电商核心字段
          orderNo: parsed.orderNo || null,
          paymentNo: parsed.paymentNo || null,
          logisticsNo: parsed.logisticsNo || null,
          ecommercePlatform: parsed.ecommercePlatform || null,
          ecommercePlatformCode: parsed.ecommercePlatformCode || null,
          deliveryMethod: parsed.deliveryMethod || null,
          transportMode: parsed.transportMode || null,
          currency: parsed.currency || 'USD',
          declarant: parsed.declarant || null,
          importerExporter: parsed.importerExporter || null,
          portOfEntry: parsed.portOfEntry || null,
          tradeTerms: parsed.tradeTerms || null,
          totalValue: null,
          items: (parsed.items || []).map((item: any, i: number) => ({
            itemNo: i + 1,
            hsCode: item.hsCode || null,
            description: item.description || null,
            quantity: item.quantity || null,
            unit: item.unit || null,
            unitPrice: item.unitPrice || null,
            totalPrice: item.totalPrice || null,
            currency: item.currency || parsed.currency || 'USD',
            originCountry: item.originCountry || 'CN',
          })),
        },
        documentId: documentId,
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || '\u89e3\u6790\u5931\u8d25' });
  }
});

router.post('/batch', upload.array('files', CUSTOMS_MAX_BATCH), async (req: any, res: any) => {
  if (!req.files || (Array.isArray(req.files) && req.files.length === 0)) {
    res.status(400).json({ error: '\u8bf7\u4e0a\u4f20\u81f3\u5c11\u4e00\u4e2a\u6587\u4ef6' });
    return;
  }

  // 海关文件校验（批量）
  const files = req.files as Express.Multer.File[];
  if (files.length > CUSTOMS_MAX_BATCH) {
    res.status(400).json({ success: false, error: `\u4e00\u6b21\u6700\u591a\u4e0a\u4f20 ${CUSTOMS_MAX_BATCH} \u4efd\u6587\u4ef6` });
    return;
  }
  const totalSize = files.reduce((s, f) => s + f.size, 0);
  if (totalSize > CUSTOMS_MAX_TOTAL_SIZE) {
    res.status(400).json({ success: false, error: `\u6587\u4ef6\u603b\u5927\u5c0f (${(totalSize / 1024 / 1024).toFixed(1)}MB) \u8d85\u9650\uff0c\u6d77\u5173\u8981\u6c42\u4e00\u6279\u6b21\u4e0d\u8d85\u8fc7 50MB` });
    return;
  }
  for (const f of files) {
    const err = validateCustomsFile(f);
    if (err) {
      res.status(400).json({ success: false, error: `[${f.originalname}] ${err}` });
      return;
    }
  }

  const tenantId = req.tenant!.tenantId;
  const category = req.body.category;
  const ocrInputs = (req.files as Express.Multer.File[]).map((f: any) => ({
    buffer: f.buffer,
    originalname: f.originalname,
    mimetype: f.mimetype,
  }));

  const results = await processBatchOCR(tenantId, ocrInputs, category);

  res.json({ total: ocrInputs.length, results });
});

export default router;
