import { PrismaClient } from '@prisma/client';
import * as XLSX from 'xlsx';
import { jsPDF } from 'jspdf';

const prisma = new PrismaClient();

export interface ReportOptions {
  tenantId: string;
  dateFrom?: string;
  dateTo?: string;
  format: 'xlsx' | 'pdf';
  type: 'compliance' | 'cbam' | 'declaration' | 'summary';
}

interface DataRow {
  [key: string]: unknown;
}

interface ComplianceRow {
  项目: string;
  数量: number | string;
  状态: string;
  备注: string;
}

export async function generateReport(options: ReportOptions): Promise<{ buffer: Buffer; fileName: string; mimeType: string }> {
  switch (options.type) {
    case 'compliance': return generateComplianceReport(options);
    case 'cbam': return generateCBAMReport(options);
    case 'declaration': return generateDeclarationReport(options);
    case 'summary': return generateSummaryReport(options);
    default: throw new Error(`Unknown report type: ${options.type}`);
  }
}

async function buildDateFilter(dateFrom?: string, dateTo?: string) {
  const filter: Record<string, Date | undefined> = {};
  if (dateFrom) filter.gte = new Date(dateFrom);
  if (dateTo) filter.lte = new Date(dateTo);
  return Object.keys(filter).length > 0 ? filter : undefined;
}

async function generateComplianceReport(options: ReportOptions): Promise<{ buffer: Buffer; fileName: string; mimeType: string }> {
  const { tenantId, dateFrom, dateTo } = options;
  const dateFilter = await buildDateFilter(dateFrom, dateTo);

  const [docCount, auditCount, declarationCount, cbamCount, originCount] = await Promise.all([
    prisma.document.count({ where: { tenantId, ...(dateFilter ? { createdAt: dateFilter } : {}) } }),
    prisma.auditLog.count({ where: { tenantId, ...(dateFilter ? { createdAt: dateFilter } : {}) } }),
    prisma.auditLog.count({ where: { tenantId, action: { contains: 'declaration' }, ...(dateFilter ? { createdAt: dateFilter } : {}) } }),
    prisma.cBAMRecord.count({ where: { tenantId } }),
    prisma.document.count({ where: { tenantId, category: 'certificate_of_origin', ...(dateFilter ? { createdAt: dateFilter } : {}) } }),
  ]);

  const rows: ComplianceRow[] = [
    { 项目: '单证处理总量', 数量: docCount, 状态: '正常', 备注: '含发票/装箱单/提单等' },
    { 项目: 'AI审计次数', 数量: auditCount, 状态: '正常', 备注: 'DeepSeek AI 辅助审计' },
    { 项目: '报关单生成', 数量: declarationCount, 状态: '正常', 备注: '含XML合规导出' },
    { 项目: 'CBAM碳计算', 数量: cbamCount, 状态: '正常', 备注: '欧盟碳关税预估' },
    { 项目: 'FTA原产地分析', 数量: originCount, 状态: '正常', 备注: 'RCEP/东盟/中韩/中澳/中瑞' },
  ];

  if (options.format === 'xlsx') {
    return buildXLSX(rows as unknown as DataRow[], '合规报告', 'compliance-report.xlsx');
  }

  return buildPDF(rows as unknown as DataRow[], ['项目', '数量', '状态', '备注'], '合规统计报告', 'compliance-report.pdf');
}

async function generateCBAMReport(options: ReportOptions): Promise<{ buffer: Buffer; fileName: string; mimeType: string }> {
  const { tenantId } = options;
  const records = await prisma.cBAMRecord.findMany({
    where: { tenantId },
    orderBy: { calculatedAt: 'desc' },
    take: 100,
  });

  const rows = records.map((r: any) => ({
    HS编码: r.hsCode || '',
    行业: r.riskLevel || '',
    排放量: r.embeddedEmissions?.toString() || '',
    碳价: r.carbonPrice?.toString() || '',
    预估成本: r.estimatedCost?.toString() || '',
    风险等级: r.riskLevel || '',
  }));

  if (options.format === 'xlsx') {
    return buildXLSX(rows as unknown as DataRow[], 'CBAM碳成本', 'cbam-report.xlsx');
  }

  const headers = Object.keys(rows[0] || {});
  return buildPDF(rows as unknown as DataRow[], headers, 'CBAM碳关税成本报告', 'cbam-report.pdf');
}

async function generateDeclarationReport(options: ReportOptions): Promise<{ buffer: Buffer; fileName: string; mimeType: string }> {
  const { tenantId, dateFrom, dateTo } = options;
  const dateFilter = await buildDateFilter(dateFrom, dateTo);

  const logs = await prisma.auditLog.findMany({
    where: { tenantId, action: { contains: 'declaration' }, ...(dateFilter ? { createdAt: dateFilter } : {}) },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });

  const rows = logs.map((log: any) => ({
    时间: log.createdAt.toISOString().slice(0, 10),
    操作: log.action,
    详情: log.detail?.slice(0, 100) || '',
  }));

  if (options.format === 'xlsx') {
    return buildXLSX(rows as unknown as DataRow[], '报关单历史', 'declaration-report.xlsx');
  }

  const headers = ['时间', '操作', '详情'];
  return buildPDF(rows as unknown as DataRow[], headers, '报关单操作记录', 'declaration-report.pdf');
}

async function generateSummaryReport(options: ReportOptions): Promise<{ buffer: Buffer; fileName: string; mimeType: string }> {
  const { tenantId } = options;

  const [docCount, hscodeCount, paymentCount, cbamHighRisk] = await Promise.all([
    prisma.document.count({ where: { tenantId } }),
    prisma.hSCode.count(),
    prisma.payment.count({ where: { tenantId, status: 'success' } }),
    prisma.cBAMRecord.count({ where: { tenantId, riskLevel: 'HIGH' } }),
  ]);

  const rows = [
    { 指标: '单证总量', 数值: docCount, 说明: '累计上传处理' },
    { 指标: 'HS编码库', 数值: hscodeCount, 说明: '可查询税号' },
    { 指标: '成功付款', 数值: paymentCount, 说明: '累计支付记录' },
    { 指标: 'CBAM高风险', 数值: cbamHighRisk, 说明: '碳关税>€100K' },
  ];

  if (options.format === 'xlsx') {
    return buildXLSX(rows as unknown as DataRow[], '经营总览', 'summary-report.xlsx');
  }

  return buildPDF(rows as unknown as DataRow[], ['指标', '数值', '说明'], '经营总览报告', 'summary-report.pdf');
}

// --- XLSX Builder ---
function buildXLSX(rows: DataRow[], sheetName: string, fileName: string): { buffer: Buffer; fileName: string; mimeType: string } {
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  return {
    buffer: buffer as Buffer,
    fileName,
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
}

// --- PDF Builder ---
function buildPDF(rows: DataRow[], headers: string[], title: string, fileName: string): { buffer: Buffer; fileName: string; mimeType: string } {
  const doc = new jsPDF({ orientation: 'landscape' });

  doc.setFontSize(16);
  doc.text(title, 14, 20);
  doc.setFontSize(10);
  doc.text(`生成时间: ${new Date().toISOString().slice(0, 10)}`, 14, 28);

  // Table
  const startY = 36;
  const cellPadding = 4;
  const colWidth = (doc.internal.pageSize.width - 28) / Math.max(headers.length, 1);

  doc.setFontSize(9);
  doc.setFillColor(41, 98, 255);
  doc.setTextColor(255, 255, 255);

  headers.forEach((h, i) => {
    doc.rect(14 + i * colWidth, startY, colWidth, 10, 'F');
    doc.text(h, 14 + i * colWidth + cellPadding, startY + 7);
  });

  doc.setTextColor(0, 0, 0);
  rows.forEach((row, rowIdx) => {
    const y = startY + 10 + rowIdx * 10;
    if (rowIdx % 2 === 0) {
      doc.setFillColor(245, 247, 250);
      doc.rect(14, y, colWidth * headers.length, 10, 'F');
    }
    headers.forEach((h, colIdx) => {
      const val = String(row[h] ?? '');
      doc.text(val.slice(0, 30), 14 + colIdx * colWidth + cellPadding, y + 7);
    });
  });

  const buffer = Buffer.from(doc.output('arraybuffer'));
  return { buffer, fileName, mimeType: 'application/pdf' };
}
