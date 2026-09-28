import prisma from '../config/database';
import { ensureTenantBucket, tenantBucket, getMinio } from '../config/minio';
import { v4 as uuid } from 'uuid';
import Tesseract from 'tesseract.js';
import pdf from 'pdf-parse';

interface BatchOCRResult {
  documentId: string;
  fileName: string;
  success: boolean;
  text?: string;
  category?: string;
  autoCategory?: string;
  error?: string;
}

const SUPPORTED_FORMATS = ['pdf', 'png', 'jpg', 'jpeg', 'tiff', 'bmp', 'webp'];
const OCR_SERVICE_URL = process.env.OCR_SERVICE_URL || 'http://ocr:8002';

// 批量OCR处理
export async function processBatchOCR(
  tenantId: string,
  files: { buffer: Buffer; originalname: string; mimetype: string }[],
  category?: string
): Promise<BatchOCRResult[]> {
  await ensureTenantBucket(tenantId);
  const minio = getMinio();
  const results: BatchOCRResult[] = [];

  for (const file of files) {
    try {
      const ext = file.originalname.split('.').pop()?.toLowerCase() || 'dat';

      if (!SUPPORTED_FORMATS.includes(ext)) {
        // 失败也落库
        try {
          const failDoc = await prisma.document.create({
            data: {
              tenantId,
              fileName: file.originalname,
              fileType: ext,
              fileSize: file.buffer.length,
              minioPath: '',
              category: category || 'general',
              status: 'failed',
              errorMessage: `不支持的文件格式: .${ext}`,
            },
          });
          results.push({
            documentId: failDoc.id,
            fileName: file.originalname,
            success: false,
            error: `不支持的文件格式: .${ext}`,
          });
        } catch {
          results.push({
            documentId: '',
            fileName: file.originalname,
            success: false,
            error: `不支持的文件格式: .${ext}`,
          });
        }
        continue;
      }

      // 上传到MinIO/本地
      const objectName = `ocr-batch/${category || 'general'}/${uuid()}.${ext}`;
      if (minio) {
        await minio.putObject(tenantBucket(tenantId), objectName, file.buffer);
      }

      // 保存文件记录
      const doc = await prisma.document.create({
        data: {
          tenantId,
          fileName: file.originalname,
          fileType: ext,
          fileSize: file.buffer.length,
          minioPath: objectName,
          category: category || 'general',
        },
      });

      let ocrText = '';
      try {
        if (ext === 'pdf') {
          const pdfData = await pdf(file.buffer);
          ocrText = pdfData.text.slice(0, 10000);
        } else {
          ocrText = await runOCR(file.buffer, file.originalname);
        }
      } catch {
        ocrText = `[OCR失败] ${file.originalname}`;
      }

      await prisma.document.update({
        where: { id: doc.id },
        data: { ocrResult: ocrText },
      });

      results.push({
        documentId: doc.id,
        fileName: file.originalname,
        success: true,
        text: ocrText,
        category: category || 'general',
      });
    } catch (err: any) {
      // 失败也落库
      try {
        const failDoc = await prisma.document.create({
          data: {
            tenantId,
            fileName: file.originalname,
            fileType: file.originalname.split('.').pop()?.toLowerCase() || 'dat',
            fileSize: file.buffer?.length || 0,
            minioPath: '',
            category: category || 'general',
            status: 'failed',
            errorMessage: err.message || '未知错误',
          },
        });
        results.push({
          documentId: failDoc.id,
          fileName: file.originalname,
          success: false,
          error: err.message,
        });
      } catch {
        results.push({
          documentId: '',
          fileName: file.originalname,
          success: false,
          error: err.message,
        });
      }
    }
  }

  // 审计日志
  await prisma.auditLog.create({
    data: {
      tenantId,
      action: 'batch_ocr',
      detail: `批量OCR: ${results.filter(r => r.success).length}/${files.length} 成功`,
    },
  });

  return results;
}

// OCR识别 + 智能分类
export async function ocrWithClassification(
  tenantId: string,
  buffer: Buffer,
  fileName: string
): Promise<BatchOCRResult & { autoCategory?: string }> {
  // 管理员 OCR：跳过数据库持久化，只返回识别结果
  if (tenantId === 'admin') {
    const ext = fileName.split('.').pop()?.toLowerCase() || 'dat';
    const autoCategory = inferCategory(fileName);
    let ocrText = '';
    try {
      if (ext === 'pdf') {
        const pdfData = await pdf(buffer);
        ocrText = pdfData.text.slice(0, 10000);
      } else {
        ocrText = await runOCR(buffer, fileName);
      }
    } catch {}
    return {
      documentId: 'admin',
      fileName,
      success: true,
      text: ocrText || undefined,
      autoCategory,
    };
  }

  const ext = fileName.split('.').pop()?.toLowerCase() || 'dat';
  await ensureTenantBucket(tenantId);

  const minio = getMinio();
  const objectName = `ocr/${uuid()}.${ext}`;
  if (minio) {
    await minio.putObject(tenantBucket(tenantId), objectName, buffer);
  }

  // 根据文件名推断分类
  const autoCategory = inferCategory(fileName);

  let ocrText = '';
  try {
    if (ext === 'pdf') {
      const pdfData = await pdf(buffer);
      ocrText = pdfData.text.slice(0, 10000);
    } else {
      ocrText = await runOCR(buffer, fileName);
    }
  } catch {
    // OCR 失败不影响文件保存和分类
  }

  // 使用事务保证文档创建和 OCR 结果写入的一致性
  const doc = await prisma.$transaction(async (tx: any) => {
    const d = await tx.document.create({
      data: {
        tenantId,
        fileName,
        fileType: ext,
        fileSize: buffer.length,
        minioPath: objectName,
        category: autoCategory,
        ...(ocrText ? { ocrResult: ocrText } : {}),
      },
    });
    return d;
  });

  return {
    documentId: doc.id,
    fileName,
    success: true,
    text: ocrText || undefined,
    autoCategory,
  };
}

// 调用 PaddleOCR 服务，不可用时回退到 Tesseract
async function runOCR(buffer: Buffer, fileName: string): Promise<string> {
  try {
    const base64 = buffer.toString('base64');
    const res = await fetch(`${OCR_SERVICE_URL}/ocr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: base64 }),
      signal: AbortSignal.timeout(30000),
    });
    if (res.ok) {
      const data = await res.json() as { text?: string };
      if (data.text) return data.text.slice(0, 10000);
    }
  } catch {
    // PaddleOCR 不可用，回退到 Tesseract
  }

  // 回退: Tesseract.js (本地 OCR)
  const { data } = await Tesseract.recognize(buffer, 'chi_sim+eng', {
    logger: () => {},
  });
  return data.text.slice(0, 10000);
}

// 根据文件名推断单证类型
function inferCategory(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.includes('declaration') || lower.includes('报关')) return 'customs_declaration';
  if (lower.includes('certificate') || lower.includes('证明')) return 'certificate';
  if (lower.includes('contract') || lower.includes('合同')) return 'contract';
  if (lower.includes('invoice') || lower.includes('发票')) return 'invoice';
  if (lower.includes('packing') || lower.includes('装箱')) return 'packing_list';
  if (lower.includes('bill') || lower.includes('提单')) return 'bill_of_lading';
  return 'general';
}
