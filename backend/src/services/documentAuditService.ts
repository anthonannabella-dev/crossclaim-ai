import Tesseract from 'tesseract.js';
import prisma from '../config/database';
import { env } from '../config/env';
import { getClient } from './ai/deepseek';
import { createHash } from 'crypto';
import { cacheGet, cacheSet } from '../config/redis';

// ============================================================
// 单证类型定义
// ============================================================

export type DocType = 'commercial_invoice' | 'packing_list' | 'bill_of_lading' | 'certificate_of_origin' | 'customs_declaration' | 'order_document' | 'payment_document' | 'logistics_document' | 'customs_power_of_attorney';

export const DOC_TYPE_LABELS: Record<DocType, string> = {
  commercial_invoice: '商业发票',
  packing_list: '装箱单',
  bill_of_lading: '提单',
  certificate_of_origin: '原产地证书',
  customs_declaration: '报关单',
  order_document: '订单单(电商平台)',
  payment_document: '支付单(支付企业)',
  logistics_document: '物流单(物流企业)',
  customs_power_of_attorney: '报关委托书',
};

// ============================================================
// 字段定义
// ============================================================

export interface ExtractedField {
  field: string;
  label: string;
  value: string | number | null;
  confidence: number;       // 0-1
  source: 'ocr' | 'ai' | 'manual';
  issue?: string;           // 问题描述（如有）
}

export interface DocumentAuditResult {
  documentId: string;
  fileName: string;
  docType: DocType;
  docTypeLabel: string;
  ocrText: string;
  fields: ExtractedField[];
  issues: AuditIssue[];
  completeness: number;     // 0-100
  passed: boolean;
}

export interface AuditIssue {
  severity: 'error' | 'warning' | 'info';
  field?: string;
  message: string;
  suggestion: string;
}

export interface CrossCheckResult {
  documentPair: [string, string];  // doc IDs
  checks: CrossCheckItem[];
  passed: boolean;
}

export interface CrossCheckItem {
  name: string;
  description: string;
  passed: boolean;
  doc1Value: string;
  doc2Value: string;
  detail: string;
}

// ============================================================
// 各单证类型的预期字段
// ============================================================

export const DOC_FIELDS: Record<DocType, { field: string; label: string; required: boolean; pattern?: RegExp }[]> = {
  commercial_invoice: [
    { field: 'invoiceNo', label: '发票号码', required: true, pattern: /(?:发票号|Invoice\s*No|INV\s*NO|发票号码)[：:\s]*([A-Z0-9\-]{4,30})/i },
    { field: 'invoiceDate', label: '发票日期', required: true, pattern: /(?:发票日期|Invoice\s*Date|日期)[：:\s]*(\d{4}[-/年]\d{1,2}[-/月]\d{1,2}[日]?)/i },
    { field: 'seller', label: '卖方/出口商', required: true, pattern: /(?:卖方|Seller|Exporter|出口商|发货人)[：:\s]*([^\n]{2,80})/i },
    { field: 'buyer', label: '买方/收货人', required: true, pattern: /(?:买方|Buyer|Consignee|收货人|进口商)[：:\s]*([^\n]{2,80})/i },
    { field: 'hsCodes', label: 'HS编码', required: true },
    { field: 'productDesc', label: '商品描述', required: true },
    { field: 'quantity', label: '数量', required: true, pattern: /(?:数量|Quantity|QTY)[：:\s]*([\d,.]+)\s*(?:件|个|台|吨|kg|PCS|TONS|UNITS)?/i },
    { field: 'unitPrice', label: '单价', required: false, pattern: /(?:单价|Unit\s*Price)[：:\s]*\$?([\d,.]+)/i },
    { field: 'totalAmount', label: '总金额', required: true, pattern: /(?:总金额|Total|Amount|合计)[：:\s]*\$?\s*([\d,.]+)/i },
    { field: 'currency', label: '币种', required: true, pattern: /(?:币种|Currency)[：:\s]*(USD|EUR|CNY|JPY|RMB|人民币|美元|欧元|日元)/i },
    { field: 'incoterms', label: '贸易术语', required: false, pattern: /\b(FOB|CIF|CFR|EXW|DAP|DDP|FCA|CPT|CIP)\b/i },
    { field: 'originCountry', label: '原产国', required: true, pattern: /(?:原产国|Origin|Country\s*of\s*Origin|Made\s*in)[：:\s]*([A-Z]{2}|[^\n]{2,20})/i },
  ],
  packing_list: [
    { field: 'packingNo', label: '装箱单号', required: false, pattern: /(?:装箱单号|Packing\s*List\s*No|P\/L\s*No)[：:\s]*([A-Z0-9\-]{4,30})/i },
    { field: 'invoiceRef', label: '对应发票号', required: true, pattern: /(?:发票号|Invoice\s*No|INV)[：:\s]*([A-Z0-9\-]{4,30})/i },
    { field: 'totalPackages', label: '总件数', required: true, pattern: /(?:总件数|Total\s*Packages|件数)[：:\s]*([\d,.]+)\s*(?:件|箱|包|PCS|CTNS|PKGS)?/i },
    { field: 'grossWeight', label: '毛重', required: true, pattern: /(?:毛重|Gross\s*Weight|G\.W\.)[：:\s]*([\d,.]+)\s*(?:KG|KGS|千克|公斤)?/i },
    { field: 'netWeight', label: '净重', required: true, pattern: /(?:净重|Net\s*Weight|N\.W\.)[：:\s]*([\d,.]+)\s*(?:KG|KGS|千克|公斤)?/i },
    { field: 'volume', label: '体积', required: false, pattern: /(?:体积|Volume|CBM|立方米|CBM)[：:\s]*([\d,.]+)\s*(?:CBM|M3|立方米)?/i },
    { field: 'marks', label: '唛头', required: false, pattern: /(?:唛头|Marks?|Shipping\s*Marks?)[：:\s]*([^\n]{2,100})/i },
    { field: 'dimensions', label: '尺寸', required: false },
  ],
  bill_of_lading: [
    { field: 'blNo', label: '提单号', required: true, pattern: /(?:提单号|B\/L\s*No|Bill\s*of\s*Lading\s*No)[：:\s]*([A-Z0-9]{4,30})/i },
    { field: 'vessel', label: '船名', required: true, pattern: /(?:船名|Vessel|M\/V)[：:\s]*([^\n]{2,50})/i },
    { field: 'voyage', label: '航次', required: false, pattern: /(?:航次|Voyage|VOY)[：:\s]*([A-Z0-9]{2,20})/i },
    { field: 'portOfLoading', label: '装货港', required: true, pattern: /(?:装货港|Port\s*of\s*Loading|POL)[：:\s]*([^\n]{2,50})/i },
    { field: 'portOfDischarge', label: '卸货港', required: true, pattern: /(?:卸货港|Port\s*of\s*Discharge|POD)[：:\s]*([^\n]{2,50})/i },
    { field: 'containerNo', label: '集装箱号', required: false, pattern: /(?:箱号|Container\s*No|CNTR)[：:\s]*([A-Z]{4}\d{7})/i },
    { field: 'sealNo', label: '封条号', required: false, pattern: /(?:封号|Seal\s*No)[：:\s]*([A-Z0-9]{4,20})/i },
    { field: 'grossWeight', label: '毛重', required: true, pattern: /(?:毛重|Gross\s*Weight|G\.W\.)[：:\s]*([\d,.]+)\s*(?:KG|KGS)?/i },
    { field: 'packages', label: '件数', required: true, pattern: /(?:件数|Packages|PKGS)[：:\s]*([\d,.]+)\s*(?:件|箱|CTNS)?/i },
    { field: 'shipper', label: '发货人', required: true, pattern: /(?:发货人|Shipper)[：:\s]*([^\n]{2,80})/i },
    { field: 'consignee', label: '收货人', required: true, pattern: /(?:收货人|Consignee)[：:\s]*([^\n]{2,80})/i },
  ],
  certificate_of_origin: [
    { field: 'coNo', label: '证书编号', required: true, pattern: /(?:证书号|Certificate\s*No|CO\s*No|编号)[：:\s]*([A-Z0-9\-]{4,30})/i },
    { field: 'issuingAuthority', label: '签发机构', required: true, pattern: /(?:签发机构|Issuing\s*Authority|Issued\s*by)[：:\s]*([^\n]{2,80})/i },
    { field: 'issueDate', label: '签发日期', required: true, pattern: /(?:签发日期|Issue\s*Date|Date)[：:\s]*(\d{4}[-/年]\d{1,2}[-/月]\d{1,2})/i },
    { field: 'exporter', label: '出口商', required: true, pattern: /(?:出口商|Exporter)[：:\s]*([^\n]{2,80})/i },
    { field: 'consignee', label: '收货人', required: true, pattern: /(?:收货人|Consignee)[：:\s]*([^\n]{2,80})/i },
    { field: 'hsCodes', label: 'HS编码', required: true },
    { field: 'originCriteria', label: '原产地标准', required: true, pattern: /(?:原产地标准|Origin\s*Criterion|WO|RVC|CC|CTH|PSR)/i },
    { field: 'ftaReference', label: '协定依据', required: false, pattern: /(?:RCEP|CAFTA|CKFTA|CHAFTA|CCFTA|Form\s*[A-Z])/i },
  ],
  customs_declaration: [
    { field: 'declarationNo', label: '报关单号', required: true, pattern: /(?:报关单号|Declaration\s*No|海关编号)[：:\s]*(\d{18})/ },
    { field: 'declarant', label: '报关行/申报人', required: true },
    { field: 'importerExporter', label: '进出口商', required: true },
    { field: 'hsCodes', label: 'HS编码', required: true },
    { field: 'declaredValue', label: '申报价值', required: true },
    { field: 'currency', label: '币种', required: true },
    { field: 'transportMode', label: '运输方式', required: true, pattern: /(?:运输方式|Transport|Mode)[：:\s]*(海运|空运|陆运|铁路|Sea|Air|Land|Rail)/i },
    { field: 'portOfEntry', label: '入境口岸', required: true },
    { field: 'documentsAttached', label: '随附单证', required: false },
  ],
  // —— 跨境电商三单(订单/支付/物流)：均带 orderNo 以做三单对碰 ——
  order_document: [
    { field: 'orderNo', label: '订单号', required: true, pattern: /(?:订单号|订单编号|Order\s*No|Order\s*Number|Order\s*ID)[：:\s]*([A-Z0-9\-]{4,40})/i },
    { field: 'platform', label: '电商平台', required: true, pattern: /(?:平台|电商平台|Platform)[：:\s]*([^\n]{2,40})/i },
    { field: 'buyer', label: '买家', required: false, pattern: /(?:买家|买方|Buyer|Customer)[：:\s]*([^\n]{2,80})/i },
    { field: 'quantity', label: '数量', required: false, pattern: /(?:数量|Quantity|QTY)[：:\s]*([\d,.]+)/i },
    { field: 'totalAmount', label: '订单金额', required: false, pattern: /(?:订单金额|金额|Amount|Total)[：:\s]*\$?\s*([\d,.]+)/i },
    { field: 'currency', label: '币种', required: false, pattern: /(?:币种|Currency)[：:\s]*(USD|EUR|CNY|JPY|RMB|人民币|美元)/i },
  ],
  payment_document: [
    { field: 'paymentNo', label: '支付单号', required: true, pattern: /(?:支付单号|支付流水号|Payment\s*No|Transaction\s*No|交易号)[：:\s]*([A-Z0-9\-]{4,40})/i },
    { field: 'orderNo', label: '关联订单号', required: true, pattern: /(?:订单号|关联订单|Order\s*No)[：:\s]*([A-Z0-9\-]{4,40})/i },
    { field: 'paymentEnterprise', label: '支付企业', required: true, pattern: /(?:支付企业|支付机构|Payment\s*(?:Enterprise|Provider))[：:\s]*([^\n]{2,60})/i },
    { field: 'totalAmount', label: '支付金额', required: true, pattern: /(?:支付金额|付款金额|Amount|Paid)[：:\s]*\$?\s*([\d,.]+)/i },
    { field: 'currency', label: '币种', required: false, pattern: /(?:币种|Currency)[：:\s]*(USD|EUR|CNY|JPY|RMB|人民币|美元)/i },
  ],
  logistics_document: [
    { field: 'logisticsNo', label: '物流单号', required: true, pattern: /(?:物流单号|运单号|快递单号|Logistics\s*No|Waybill\s*No|Tracking\s*No)[：:\s]*([A-Z0-9\-]{4,40})/i },
    { field: 'orderNo', label: '关联订单号', required: true, pattern: /(?:订单号|关联订单|Order\s*No)[：:\s]*([A-Z0-9\-]{4,40})/i },
    { field: 'logisticsEnterprise', label: '物流企业', required: true, pattern: /(?:物流企业|承运商|Logistics\s*(?:Enterprise|Provider|Company)|Carrier)[：:\s]*([^\n]{2,60})/i },
    { field: 'consignee', label: '收货人', required: false, pattern: /(?:收货人|Consignee|Receiver)[：:\s]*([^\n]{2,80})/i },
    { field: 'grossWeight', label: '重量', required: false, pattern: /(?:重量|毛重|Weight|G\.W\.)[：:\s]*([\d,.]+)\s*(?:KG|KGS)?/i },
  ],
  customs_power_of_attorney: [
    { field: 'entrustNo', label: '委托书编号', required: false, pattern: /(?:委托书编号|委托编号|编号|No)[：:\s]*([A-Z0-9\-]{4,30})/i },
    { field: 'principal', label: '委托方', required: true, pattern: /(?:委托方|委托单位|委托人|Principal|Entrusting)[：:\s]*([^\n]{2,80})/i },
    { field: 'agent', label: '受托/报关企业', required: true, pattern: /(?:受托方|受托单位|报关企业|代理企业|Agent|Entrusted)[：:\s]*([^\n]{2,80})/i },
    { field: 'scope', label: '委托事项', required: false, pattern: /(?:委托事项|代理范围|Scope)[：:\s]*([^\n]{2,100})/i },
    { field: 'validity', label: '有效期', required: false, pattern: /(?:有效期|Valid|Validity)[：:\s]*([^\n]{2,40})/i },
  ],
};

// ============================================================
// 单证类型自动识别
// ============================================================

const TYPE_KEYWORDS: Record<DocType, { zh: string[]; en: string[] }> = {
  commercial_invoice: {
    zh: ['商业发票', '发票', 'COMMERCIAL INVOICE', 'INVOICE'],
    en: ['commercial invoice', 'invoice', 'inv no', 'invoice no'],
  },
  packing_list: {
    zh: ['装箱单', 'PACKING LIST', 'P/L'],
    en: ['packing list', 'packing', 'p/l', 'packing slip'],
  },
  bill_of_lading: {
    zh: ['提单', 'BILL OF LADING', 'B/L', '海运提单'],
    en: ['bill of lading', 'b/l', 'ocean bill', 'marine bill'],
  },
  certificate_of_origin: {
    zh: ['原产地证书', '原产地证明', 'CERTIFICATE OF ORIGIN', 'C/O'],
    en: ['certificate of origin', 'c/o', 'origin certificate'],
  },
  customs_declaration: {
    zh: ['报关单', '海关申报', 'CUSTOMS DECLARATION', '进口报关'],
    en: ['customs declaration', 'declaration', 'entry summary'],
  },
  order_document: {
    zh: ['订单单', '电商订单', '订单详情', '平台订单', '销售订单', '购物订单'],
    en: ['order document', 'platform order', 'sales order', 'purchase order'],
  },
  payment_document: {
    zh: ['支付单', '支付凭证', '付款单', '支付流水', '交易凭证', 'PAYMENT'],
    en: ['payment document', 'payment order', 'payment receipt', 'transaction'],
  },
  logistics_document: {
    zh: ['物流单', '运单', '物流信息', '快递单', '物流详情', 'WAYBILL', 'LOGISTICS'],
    en: ['logistics document', 'waybill', 'tracking', 'shipping order'],
  },
  customs_power_of_attorney: {
    zh: ['报关委托书', '代理报关委托书', '报关委托', '委托书', '委托代理协议'],
    en: ['power of attorney', 'customs entrustment', 'declaration entrustment'],
  },
};

export function detectDocType(text: string, fileName: string): DocType {
  const combined = (text + ' ' + fileName).toLowerCase();
  const scores: [DocType, number][] = [];

  for (const [type, keywords] of Object.entries(TYPE_KEYWORDS)) {
    let score = 0;
    for (const kw of keywords.zh) {
      if (combined.includes(kw.toLowerCase())) score += 3;
    }
    for (const kw of keywords.en) {
      if (combined.includes(kw)) score += 2;
    }
    if (score > 0) scores.push([type as DocType, score]);
  }

  scores.sort((a, b) => b[1] - a[1]);
  return scores[0]?.[0] || 'commercial_invoice';
}

// ============================================================
// OCR 文本提取
// ============================================================

export async function runDocumentOCR(buffer: Buffer, fileName: string): Promise<string> {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  try {
    if (ext === 'pdf') {
      try {
        const pdfParse = (await import('pdf-parse')).default;
        const data = await pdfParse(buffer);
        return (data.text || '').slice(0, 10000).trim();
      } catch {
        // PDF parse failed, try Tesseract as fallback
      }
    }
    // Excel / CSV: 用 SheetJS 解析为文本(箱单、发票明细常为 Excel)
    if (['xlsx', 'xls', 'csv'].includes(ext)) {
      try {
        const XLSX: any = await import('xlsx');
        const wb = XLSX.read(buffer, { type: 'buffer' });
        let text = '';
        for (const name of wb.SheetNames) {
          text += '[' + name + ']\n' + XLSX.utils.sheet_to_csv(wb.Sheets[name]) + '\n';
        }
        return text.slice(0, 10000).trim();
      } catch { /* 解析失败则返回空 */ return ''; }
    }
    // Word: 用 mammoth 提取纯文本(合同、委托书常为 Word);未安装 mammoth 则跳过
    if (ext === 'docx' || ext === 'doc') {
      try {
        const m: any = await import('mammoth');
        const fn = m.extractRawText || (m.default && m.default.extractRawText);
        if (!fn) return '';
        const result = await fn({ buffer });
        return (result.value || '').slice(0, 10000).trim();
      } catch { return ''; }
    }
    // 图片/扫描件：优先阿里云 OCR；未启用或失败则回落本地 Tesseract
    try {
      const { isAliyunOcrEnabled, recognizeImage } = await import('./aliyunOcr');
      if (isAliyunOcrEnabled()) {
        const text = await recognizeImage(buffer);
        if (text) return text.slice(0, 10000).trim();
      }
    } catch (e: any) {
      console.warn('[OCR] 阿里云识别失败，回落 Tesseract:', e?.message || e);
    }
    const { data } = await Tesseract.recognize(buffer, 'chi_sim+eng', { logger: () => {} });
    return (data.text || '').slice(0, 10000).trim();
  } catch {
    return '';
  }
}

// ============================================================
// 字段提取
// ============================================================

function extractFields(docType: DocType, ocrText: string): ExtractedField[] {
  const fieldDefs = DOC_FIELDS[docType];
  const fields: ExtractedField[] = [];

  for (const def of fieldDefs) {
    let value: string | null = null;
    let confidence = 0;
    const source: 'ocr' | 'ai' = 'ocr';

    if (def.pattern) {
      const match = def.pattern.exec(ocrText);
      if (match) {
        value = (match[1] || match[0]).trim();
        confidence = 0.7;
      }
    }

    // For HS codes, use a dedicated pattern
    if (!value && def.field === 'hsCodes') {
      const hsMatches = ocrText.match(/\b(\d{4}[.]\d{2,4})\b/g);
      if (hsMatches) {
        value = [...new Set(hsMatches)].join(', ');
        confidence = 0.65;
      }
    }

    // For product description, take a chunk after HS code area
    if (!value && def.field === 'productDesc') {
      const descMatch = ocrText.match(/(?:商品名称|品名|Description|DESC|货物名称)[：:\s]*([^\n]{5,200})/i);
      if (descMatch) {
        value = descMatch[1].trim();
        confidence = 0.5;
      }
    }

    fields.push({
      field: def.field,
      label: def.label,
      value,
      confidence,
      source,
    });
  }

  return fields;
}

// ============================================================
// AI 语义字段提取（增强版）
// ============================================================

export async function aiExtractFields(docType: DocType, docTypeLabel: string, ocrText: string): Promise<ExtractedField[]> {
  const fieldDefs = DOC_FIELDS[docType];
  try {
    const config = env();
    if (!config.DEEPSEEK_API_KEY || config.DEEPSEEK_API_KEY === 'sk-placeholder' || config.DEEPSEEK_API_KEY === 'sk-local-dev-key') {
      return extractFields(docType, ocrText);
    }

    const { callAI } = await import('./ai/deepseek');

    const fieldList = fieldDefs.map(f => `"${f.field}": "${f.label}"`).join(', ');
    const prompt = `你是一位专业报关单证审核员。请从以下${docTypeLabel}的OCR识别文本中提取关键字段。

OCR文本:
"""
${ocrText.slice(0, 4000)}
"""

请返回JSON格式，每个字段的值和置信度(0-1):
{
${fieldDefs.map(f => `  "${f.field}": {"value": "提取的值或null", "confidence": 0.0-1.0}`).join(',\n')}
}

注意:
- 如果字段无法从文本中找到，value设为null
- confidence低于0.5的字段标注为不确定
- HS编码格式应为数字.数字（如8471.30）
- 金额和数量保留原始格式`;

    const response = await getClient().chat.completions.create({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 1200,
      response_format: { type: 'json_object' },
    });

    const result = JSON.parse(response.choices[0].message.content || '{}');
    return fieldDefs.map(def => ({
      field: def.field,
      label: def.label,
      value: result[def.field]?.value ?? null,
      confidence: result[def.field]?.confidence ?? 0,
      source: 'ai' as const,
    }));
  } catch {
    return extractFields(docType, ocrText);
  }
}

// ============================================================
// 字段校验规则
// ============================================================

export function validateFields(docType: DocType, fields: ExtractedField[]): AuditIssue[] {
  const issues: AuditIssue[] = [];
  const fieldDefs = DOC_FIELDS[docType];
  const fieldMap = new Map(fields.map(f => [f.field, f]));

  // 必填字段缺失检查
  for (const def of fieldDefs) {
    const field = fieldMap.get(def.field);
    if (def.required && (!field || !field.value)) {
      issues.push({
        severity: 'error',
        field: def.field,
        message: `必填字段「${def.label}」缺失`,
        suggestion: `请补充${def.label}信息`,
      });
    }
  }

  // 格式校验
  const hsField = fieldMap.get('hsCodes');
  if (hsField?.value && typeof hsField.value === 'string') {
    const codes = hsField.value.match(/\d{4}[.]\d{2,4}/g) || [];
    if (codes.length === 0) {
      issues.push({
        severity: 'warning',
        field: 'hsCodes',
        message: 'HS编码格式不正确，应为4-6位数字.2-4位数字',
        suggestion: '请检查HS编码格式，如：8471.30',
      });
    }
  }

  const totalField = fieldMap.get('totalAmount');
  if (totalField?.value && typeof totalField.value === 'string') {
    const num = parseFloat(totalField.value.replace(/,/g, ''));
    if (isNaN(num) || num <= 0) {
      issues.push({
        severity: 'warning',
        field: 'totalAmount',
        message: '金额无法解析为有效数字',
        suggestion: '请检查发票金额格式',
      });
    }
  }

  // 低置信度警告
  for (const field of fields) {
    if (field.value && field.confidence > 0 && field.confidence < 0.6) {
      issues.push({
        severity: 'info',
        field: field.field,
        message: `「${field.label}」识别置信度较低 (${Math.round(field.confidence * 100)}%)`,
        suggestion: '建议人工核对确认',
      });
    }
  }

  return issues;
}

// ============================================================
// 主审计函数
// ============================================================

export async function auditDocument(
  documentId: string,
  buffer: Buffer,
  fileName: string,
): Promise<DocumentAuditResult> {
  // Step 1: OCR
  const ocrText = await runDocumentOCR(buffer, fileName);

  // Step 2: 识别单证类型
  const docType = detectDocType(ocrText, fileName);
  const docTypeLabel = DOC_TYPE_LABELS[docType];

  // Step 3: AI字段提取（带回退至正则）
  const fields = await aiExtractFields(docType, docTypeLabel, ocrText);

  // Step 4: 字段校验
  const issues = validateFields(docType, fields);

  // Step 5: 完整性评分
  const fieldDefs = DOC_FIELDS[docType];
  const filledRequired = fieldDefs.filter(d => d.required && fields.find(f => f.field === d.field)?.value).length;
  const totalRequired = fieldDefs.filter(d => d.required).length;
  const completeness = totalRequired > 0 ? Math.round((filledRequired / totalRequired) * 100) : 100;

  // Step 6: 更新数据库
  await prisma.document.update({
    where: { id: documentId },
    data: { ocrResult: ocrText, category: docType },
  }).catch(() => {});

  const hasErrors = issues.some(i => i.severity === 'error');

  return {
    documentId,
    fileName,
    docType,
    docTypeLabel,
    ocrText: ocrText.slice(0, 3000),
    fields: fields.map(f => ({
      ...f,
      value: typeof f.value === 'string' ? f.value.slice(0, 200) : f.value,
    })),
    issues,
    completeness,
    passed: !hasErrors && completeness >= 60,
  };
}

// ============================================================
// 跨单证一致性检查
// ============================================================

export interface CrossCheckInput {
  documents: { id: string; fileName: string; auditResult: DocumentAuditResult }[];
}

export function crossCheckDocuments(docs: CrossCheckInput['documents']): CrossCheckResult[] {
  const results: CrossCheckResult[] = [];
  const docMap = new Map(docs.map(d => [d.id, d.auditResult]));

  for (let i = 0; i < docs.length; i++) {
    for (let j = i + 1; j < docs.length; j++) {
      const doc1 = docs[i].auditResult;
      const doc2 = docs[j].auditResult;
      const checks: CrossCheckItem[] = [];

      const f1 = new Map(doc1.fields.map(f => [f.field, f]));
      const f2 = new Map(doc2.fields.map(f => [f.field, f]));

      // Check 1: HS编码一致性
      const hs1 = f1.get('hsCodes');
      const hs2 = f2.get('hsCodes');
      if (hs1?.value && hs2?.value) {
        const codes1: string[] = String(hs1.value).match(/\d{4}[.]\d{2,4}/g) || [];
        const codes2: string[] = String(hs2.value).match(/\d{4}[.]\d{2,4}/g) || [];
        const overlap = codes1.filter(c => codes2.includes(c));
        const allMatch = codes1.length > 0 && codes1.every(c => codes2.includes(c));
        checks.push({
          name: 'HS编码一致性',
          description: `${doc1.docTypeLabel} vs ${doc2.docTypeLabel}`,
          passed: allMatch || overlap.length >= Math.min(codes1.length, codes2.length),
          doc1Value: codes1.join(', '),
          doc2Value: codes2.join(', '),
          detail: allMatch ? '所有HS编码一致' : overlap.length > 0 ? `${overlap.length}个编码匹配` : 'HS编码不一致',
        });
      }

      // Check 2: 数量/件数一致性 (invoice vs packing list)
      if ((doc1.docType === 'commercial_invoice' && doc2.docType === 'packing_list') ||
          (doc1.docType === 'packing_list' && doc2.docType === 'commercial_invoice')) {
        const inv = doc1.docType === 'commercial_invoice' ? f1 : f2;
        const pl = doc1.docType === 'packing_list' ? f1 : f2;
        const invQty = inv.get('quantity');
        const plPkg = pl.get('totalPackages');
        if (invQty?.value && plPkg?.value) {
          const q1 = parseFloat(String(invQty.value).replace(/,/g, ''));
          const q2 = parseFloat(String(plPkg.value).replace(/,/g, ''));
          const match = !isNaN(q1) && !isNaN(q2) && Math.abs(q1 - q2) / Math.max(q1, q2) < 0.1;
          checks.push({
            name: '数量一致性',
            description: '发票数量 vs 装箱单件数',
            passed: match,
            doc1Value: `${q1}`,
            doc2Value: `${q2}`,
            detail: match ? '数量一致（10%容差内）' : `数量差异: ${Math.abs(q1 - q2)}`,
          });
        }
      }

      // Check 3: 毛重一致性 (packing list vs BL)
      const gw1 = f1.get('grossWeight');
      const gw2 = f2.get('grossWeight');
      if (gw1?.value && gw2?.value) {
        const w1 = parseFloat(String(gw1.value).replace(/,/g, ''));
        const w2 = parseFloat(String(gw2.value).replace(/,/g, ''));
        const match = !isNaN(w1) && !isNaN(w2) && Math.abs(w1 - w2) / Math.max(w1, w2) < 0.05;
        checks.push({
          name: '毛重一致性',
          description: `${doc1.docTypeLabel} vs ${doc2.docTypeLabel}`,
          passed: match,
          doc1Value: `${w1}`,
          doc2Value: `${w2}`,
          detail: match ? '毛重一致（5%容差内）' : `毛重差异: ${Math.abs(w1 - w2).toFixed(2)}`,
        });
      }

      // Check 4: 收货人名称一致性
      const buyer1 = f1.get('buyer') || f1.get('consignee');
      const buyer2 = f2.get('buyer') || f2.get('consignee');
      if (buyer1?.value && buyer2?.value) {
        const b1 = String(buyer1.value).toLowerCase().replace(/[^\w]/g, '');
        const b2 = String(buyer2.value).toLowerCase().replace(/[^\w]/g, '');
        const similarity = b1.length > 0 && b2.length > 0
          ? (b1.includes(b2.slice(0, 4)) || b2.includes(b1.slice(0, 4)))
          : false;
        checks.push({
          name: '收货人一致性',
          description: `${doc1.docTypeLabel} vs ${doc2.docTypeLabel}`,
          passed: similarity,
          doc1Value: String(buyer1.value).slice(0, 40),
          doc2Value: String(buyer2.value).slice(0, 40),
          detail: similarity ? '收货人名称一致' : '收货人名称不匹配',
        });
      }

      // Check 5: 跨境电商三单对碰 —— 订单号一致性(订单/支付/物流任意两单都带 orderNo 时比对)
      const ECM_TYPES = ['order_document', 'payment_document', 'logistics_document'];
      if (ECM_TYPES.includes(doc1.docType) && ECM_TYPES.includes(doc2.docType)) {
        const o1 = f1.get('orderNo');
        const o2 = f2.get('orderNo');
        if (o1?.value && o2?.value) {
          const n1 = String(o1.value).trim().toUpperCase();
          const n2 = String(o2.value).trim().toUpperCase();
          const match = n1.length > 0 && n1 === n2;
          checks.push({
            name: '三单对碰(订单号)',
            description: `${doc1.docTypeLabel} vs ${doc2.docTypeLabel}`,
            passed: match,
            doc1Value: n1,
            doc2Value: n2,
            detail: match ? '订单号一致，三单对碰通过' : '订单号不一致，三单无法对碰（电商监管要求三单关联同一笔交易）',
          });
        }
      }

      results.push({
        documentPair: [docs[i].id, docs[j].id],
        checks,
        passed: checks.length > 0 && checks.every(c => c.passed),
      });
    }
  }

  return results;
}

// ============================================================
// 批量审计（多单证上传+审计+交叉检查）
// ============================================================

export async function batchAudit(
  tenantId: string,
  files: { buffer: Buffer; fileName: string; originalName: string }[],
): Promise<{
  documents: DocumentAuditResult[];
  crossChecks: CrossCheckResult[];
  overallPassed: boolean;
  summary: { total: number; passed: number; errors: number; warnings: number };
}> {
  const documents: DocumentAuditResult[] = [];

  for (const file of files) {
    // 创建文档记录
    const doc = await prisma.document.create({
      data: {
        tenantId,
        fileName: file.originalName,
        fileType: file.originalName.split('.').pop()?.toLowerCase() || 'unknown',
        fileSize: file.buffer.length,
        minioPath: `audit/${Date.now()}_${file.originalName}`,
      },
    });

    // 审计
    const result = await auditDocument(doc.id, file.buffer, file.originalName);
    documents.push(result);

    // 更新OCR结果
    await prisma.document.update({
      where: { id: doc.id },
      data: { ocrResult: result.ocrText, category: result.docType },
    }).catch(() => {});
  }

  // 交叉检查
  const crossChecks = documents.length >= 2
    ? crossCheckDocuments(documents.map(d => ({ id: d.documentId, fileName: d.fileName, auditResult: d })))
    : [];

  const totalIssues = documents.reduce((sum, d) => sum + d.issues.length, 0);
  const errors = documents.reduce((sum, d) => sum + d.issues.filter(i => i.severity === 'error').length, 0);
  const warnings = documents.reduce((sum, d) => sum + d.issues.filter(i => i.severity === 'warning').length, 0);

  return {
    documents,
    crossChecks,
    overallPassed: documents.every(d => d.passed) && crossChecks.every(c => c.passed),
    summary: {
      total: documents.length,
      passed: documents.filter(d => d.passed).length,
      errors,
      warnings,
    },
  };
}


// ============================================================
// 提运单同组交叉比对
// ============================================================

/** 按提单号查找该提单下的所有文档，执行交叉比对 */
export async function groupCrossCheckByBL(
  tenantId: string,
  blNo: string,
): Promise<{
  blNo: string;
  documents: DocumentAuditResult[];
  crossChecks: CrossCheckResult[];
  overallPassed: boolean;
  summary: { total: number; passed: number; warnings: number };
}> {
  // 走 billOfLading 列(归集时落列, 已建索引)直接取该提单文档,
  // 不再扫全表 + 逐份正则提取(列是归集权威键, 比从OCR文本重新推断更准也更快)
  const matched = await prisma.document.findMany({
    where: { tenantId, billOfLading: blNo, ocrResult: { not: null } },
    orderBy: { updatedAt: 'desc' },
  });

  // 缓存键含文档指纹(id+updatedAt): 任一文档变化即自动失效(无需手动清缓存),
  // 同一提单短期内重复核对直接命中, 不重跑每份文档的付费 AI 抽取。Redis 不可用时自动降级为直算。
  const fingerprint = createHash('sha1')
    .update(matched.map((d: { id: string; updatedAt: Date }) => `${d.id}:${d.updatedAt.getTime()}`).join('|'))
    .digest('hex').slice(0, 16);
  const cacheKey = `crosscheck:${tenantId}:${blNo}:${fingerprint}`;
  const cachedRaw = await cacheGet(cacheKey);
  if (cachedRaw) {
    try { return JSON.parse(cachedRaw); } catch { /* 命中但解析失败则重算 */ }
  }

  const { aiExtractFields, DOC_FIELDS } = await import('./documentAuditService');
  const auditResults: DocumentAuditResult[] = [];

  for (const doc of matched) {
    const docType = detectDocType(doc.ocrResult || '', doc.fileName) || 'commercial_invoice';
    const docTypeLabel = DOC_TYPE_LABELS[docType as DocType];
    const fields = await aiExtractFields(docType, docTypeLabel, doc.ocrResult || '');
    const fieldDefs = DOC_FIELDS[docType] || [];
    const filledRequired = fieldDefs.filter((d: any) => d.required && fields.find((f: any) => f.field === d.field)?.value).length;
    const totalRequired = fieldDefs.filter((d: any) => d.required).length;
    const issues = (validateFields as any)(docType, fields) || [];

    auditResults.push({
      documentId: doc.id,
      fileName: doc.fileName,
      docType,
      docTypeLabel,
      ocrText: (doc.ocrResult || '').slice(0, 3000),
      fields: fields.map((f: any) => ({ ...f, value: typeof f.value === 'string' ? f.value.slice(0, 200) : f.value })),
      issues,
      completeness: totalRequired > 0 ? Math.round((filledRequired / totalRequired) * 100) : 100,
      passed: !issues.some((i: any) => i.severity === 'error') && (totalRequired === 0 || filledRequired / totalRequired >= 0.6),
    });
  }

  const crossChecks = auditResults.length >= 2
    ? crossCheckDocuments(auditResults.map(d => ({ id: d.documentId, fileName: d.fileName, auditResult: d })))
    : [];

  const passed = auditResults.filter(d => d.passed).length;
  const warnings = auditResults.reduce((s, d) => s + d.issues.filter((i: any) => i.severity === 'warning').length, 0);

  const result = {
    blNo,
    documents: auditResults,
    crossChecks,
    overallPassed: auditResults.every(d => d.passed) && crossChecks.every(c => c.passed),
    summary: { total: auditResults.length, passed, warnings },
  };

  // 写入缓存(1小时TTL兜底; 文档变化时指纹变, 旧键自然失效)
  await cacheSet(cacheKey, JSON.stringify(result), 3600);
  return result;
}

/** 从OCR文本中提取提单号 */
export function extractBLFromText(text: string): string | null {
  const patterns = [
    /(?:提单号|B\/L\s*(?:No|#|\.)?|BILL\s+OF\s+LADING\s*(?:No|#|\.)?)[:\s]*([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)/i,
    /(?:MAWB|HAWB|MBL|HBL)[:\s]*([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m && m[1]) return m[1].trim();
  }
  return null;
}

// ============================================================
// 联动历史复核
// ============================================================

export interface AuditHistoryRecord {
  documentId: string;
  fileName: string;
  docType: DocType;
  docTypeLabel: string;
  blNo: string;
  auditDate: string;
  auditedBy: string;
  passed: boolean;
  completeness: number;
  fields: ExtractedField[];
  issues: AuditIssue[];
}

/** 按提单号查询所有历史审核记录 */
export async function getAuditHistoryByBL(tenantId: string, blNo: string): Promise<AuditHistoryRecord[]> {
  // 走 billOfLading 列直接取该提单文档; 历史列表用免费正则抽取字段,
  // 不再每次浏览都触发付费 AI 调用(详细 AI 字段在主动发起审核时才跑)
  const matched = await prisma.document.findMany({
    where: { tenantId, billOfLading: blNo, ocrResult: { not: null } },
    orderBy: { updatedAt: 'desc' },
  });

  const results: AuditHistoryRecord[] = [];
  for (const doc of matched) {
    const ocrText = doc.ocrResult || '';
    if (!ocrText) continue;

    const docType: DocType = detectDocType(ocrText, doc.fileName) || 'commercial_invoice';
    const label = DOC_TYPE_LABELS[docType];
    const fields = extractFields(docType, ocrText);

    results.push({
      documentId: doc.id,
      fileName: doc.fileName,
      docType,
      docTypeLabel: label,
      blNo,
      auditDate: doc.updatedAt.toISOString(),
      auditedBy: 'AI自动审核',
      passed: (doc as any).auditPassed === true,
      completeness: (doc as any).auditScore || 0,
      fields,
      issues: [],
    });
  }

  return results;
}
