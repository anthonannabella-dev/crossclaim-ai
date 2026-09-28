import { Router, Request, Response } from 'express';
import multer from 'multer';
import prisma from '../../config/database';
import { authenticate } from '../../middleware/auth';
import { requireActiveTenant } from '../../middleware/tenant';
import { recognizeImage, parseDocument, extractWithAI } from '../../services/ocrParser';
import fs from 'fs';
import path from 'path';
import os from 'os';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 单文件 ≤20MB
});

const router = Router();
router.use(authenticate);
router.use(requireActiveTenant);

/**
 * POST /api/ocr/recognize
 * 上传图片进行 OCR 识别，返回纯文本内容
 */
router.post('/recognize', upload.single('file'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '请上传文件' });
    }

    // 保存临时文件
    const ext = path.extname(req.file.originalname) || '.jpg';
    const tempPath = path.join(os.tmpdir(), `ocr_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
    fs.writeFileSync(tempPath, req.file.buffer);

    try {
      // 调用阿里云 OCR 识别
      const rawText = await recognizeImage(tempPath);

      // 清理临时文件
      fs.unlinkSync(tempPath);

      return res.json({
        success: true,
        text: rawText,
        fileName: req.file.originalname,
        fileSize: req.file.size,
      });
    } catch (err) {
      // 清理临时文件
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      throw err;
    }
  } catch (err: any) {
    console.error('[OCR] 识别失败:', err.message);
    return res.status(500).json({
      error: 'OCR 识别失败',
      message: err.message,
      code: err.code,
    });
  }
});

/**
 * POST /api/ocr/parse
 * 上传图片进行 OCR + AI 结构化提取
 * Body (multipart): file + category (invoice/packing_list/bill_of_lading/contract)
 */
router.post('/parse', upload.single('file'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '请上传文件' });
    }

    const category = (req.body.category as string) || '';

    // 保存临时文件
    const ext = path.extname(req.file.originalname) || '.jpg';
    const tempPath = path.join(os.tmpdir(), `ocr_parse_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
    fs.writeFileSync(tempPath, req.file.buffer);

    try {
      // 调用 OCR + AI 结构化提取
      const result = await parseDocument(tempPath, category);

      // 清理临时文件
      fs.unlinkSync(tempPath);

      return res.json({
        success: true,
        data: result,
        fileName: req.file.originalname,
        category,
      });
    } catch (err) {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      throw err;
    }
  } catch (err: any) {
    console.error('[OCR Parse] 结构化提取失败:', err.message);
    return res.status(500).json({
      error: 'OCR 结构化提取失败',
      message: err.message,
    });
  }
});

/**
 * GET /api/ocr/status
 * 检查 OCR 服务状态
 */
router.get('/status', async (_req: Request, res: Response) => {
  const keyId = process.env.ALIYUN_OCR_ACCESS_KEY_ID;
  const keySecret = process.env.ALIYUN_OCR_ACCESS_KEY_SECRET;

  res.json({
    configured: !!(keyId && keySecret),
    keyIdPrefix: keyId ? keyId.slice(0, 6) + '...' : null,
  });
});

export default router;
