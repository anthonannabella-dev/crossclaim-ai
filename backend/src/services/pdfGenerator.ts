import jsPDF from 'jspdf';
import { DeclarationData, CUSTOMS_MODE_INFO, CustomsMode } from './declarationBuilder';

// ============================================================
// 报关单 PDF 生成（不带签章，供打印/对单/归档用）
// ============================================================

const FONT_SIZE_TITLE = 16;
const FONT_SIZE_HEADER = 10;
const FONT_SIZE_BODY = 8;
const FONT_SIZE_SMALL = 7;

const MARGIN_LEFT = 15;
const MARGIN_TOP = 20;
const LINE_HEIGHT = 5;

/**
 * 根据 DeclarationData 生成 PDF Buffer
 */
export async function generateDeclarationPDF(
  declaration: DeclarationData,
  preCheck?: { score: number; passed: boolean; issues: any[] }
): Promise<Buffer> {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

  const modeLabel = declaration.customsMode && declaration.customsMode !== 'normal'
    ? CUSTOMS_MODE_INFO[declaration.customsMode]?.label || declaration.customsMode
    : '\u4e00\u822c\u8d38\u6613';
  const supervisionCode = CUSTOMS_MODE_INFO[declaration.customsMode || 'normal']?.supervisionCode || '0110';

  // ---- 标题 ----
  doc.setFontSize(FONT_SIZE_TITLE);
  doc.text(`\u62a5\u5173\u5355 (${modeLabel})`, 105, 15, { align: 'center' });

  // ---- 表头信息 ----
  let y = MARGIN_TOP + 5;
  doc.setFontSize(FONT_SIZE_HEADER);

  const headerRows: { label: string; value: string }[] = [
    { label: '\u62a5\u5173\u5355\u53f7', value: declaration.declarationNo || '\u81ea\u52a8\u751f\u6210' },
    { label: '\u76d1\u7ba1\u65b9\u5f0f\u4ee3\u7801', value: supervisionCode },
    { label: '\u7533\u62a5\u6a21\u5f0f', value: modeLabel },
    { label: '申报单位', value: defaultStr('-', declaration.declarant) },
    { label: '\u8fdb\u51fa\u53e3\u5546', value: defaultStr('\u2014', declaration.importerExporter) },
    { label: '\u8fd0\u8f93\u65b9\u5f0f', value: defaultStr('\u2014', declaration.transportMode) },
    { label: '\u8d38\u6613\u6761\u6b3e', value: defaultStr('\u2014', declaration.tradeTerms) },
    { label: '\u8d77\u8fd0\u6e2f', value: defaultStr('\u2014', declaration.portOfLoading) },
    { label: '\u76ee\u7684\u6e2f', value: defaultStr('\u2014', declaration.portOfDischarge) },
    { label: '\u5165\u5883\u53e3\u5cb8', value: defaultStr('\u2014', declaration.portOfEntry) },
    { label: '\u5e01\u79cd', value: defaultStr('\u2014', declaration.currency) },
    { label: '\u603b\u91d1\u989d', value: declaration.totalValue?.toFixed(2) || '0.00' },
  ];

  if (declaration.contractNo) headerRows.push({ label: '\u5408\u540c\u53f7', value: declaration.contractNo });
  if (declaration.orderNo) headerRows.push({ label: '\u8ba2\u5355\u53f7', value: declaration.orderNo });
  if (declaration.logisticsNo) headerRows.push({ label: '\u7269\u6d41\u5355\u53f7', value: declaration.logisticsNo });

  // Draw header table
  const colW = 175;
  let x = MARGIN_LEFT;

  // Header in 4 columns
  const cols = 3;
  const cellW = colW / cols;
  let rowIdx = 0;
  for (const row of headerRows) {
    if (rowIdx > 0 && rowIdx % cols === 0) {
      y += LINE_HEIGHT + 1;
    }
    const cx = x + (rowIdx % cols) * cellW;
    doc.setFontSize(FONT_SIZE_SMALL);
    doc.text(row.label + ':', cx, y);
    doc.setFontSize(FONT_SIZE_BODY);
    doc.text(row.value, cx + 22, y);
    rowIdx++;
  }
  y += LINE_HEIGHT + 6;

  // ---- 合规检查结果 ----
  if (preCheck) {
    doc.setFontSize(FONT_SIZE_HEADER);
    doc.text('\u5408\u89c4\u9884\u68c0\u7ed3\u679c', MARGIN_LEFT, y);
    y += 5;
    doc.setFontSize(FONT_SIZE_SMALL);
    doc.text(`\u5f97\u5206: ${preCheck.score}/100  |  \u72b6\u6001: ${preCheck.passed ? '\u2705 \u901a\u8fc7' : '\u274c \u672a\u901a\u8fc7'}  |  \u68c0\u67e5\u89c4\u5219: ${preCheck.issues?.length || 0} \u6761`, MARGIN_LEFT, y);
    y += LINE_HEIGHT + 3;
  }

  // ---- 商品明细表格 ----
  doc.setFontSize(FONT_SIZE_HEADER);
  doc.text('\u5546\u54c1\u660e\u7ec6', MARGIN_LEFT, y);
  y += 5;

  if (declaration.items && declaration.items.length > 0) {
    const tableHeaders = ['#', 'HS\u7f16\u7801', '\u5546\u54c1\u540d\u79f0', '\u6570\u91cf', '\u5355\u4f4d', '\u5355\u4ef7', '\u603b\u4ef7', '\u539f\u4ea7\u56fd'];
    const colWidths = [8, 25, 55, 14, 12, 20, 20, 18];
    const tableX = MARGIN_LEFT;
    const totalW = colWidths.reduce((a, b) => a + b, 0);

    // Header row
    doc.setFontSize(FONT_SIZE_SMALL);
    doc.setFillColor(240, 240, 240);
    let cx = tableX;
    doc.rect(tableX, y - 3, totalW, 6, 'F');
    for (let i = 0; i < tableHeaders.length; i++) {
      doc.text(tableHeaders[i], cx + 1, y + 1);
      cx += colWidths[i];
    }
    y += 5;

    // Data rows
    doc.setFontSize(FONT_SIZE_SMALL);
    for (let i = 0; i < declaration.items.length; i++) {
      const item = declaration.items[i];
      if (y > 270) {
        doc.addPage();
        y = 20;
      }
      cx = tableX;
      doc.rect(tableX, y - 3, totalW, 5);
      doc.text(String(i + 1), cx + 1, y + 1); cx += colWidths[0];
      doc.text(item.hsCode || '', cx + 1, y + 1); cx += colWidths[1];
      const desc = (item.description || '').length > 18 ? (item.description || '').slice(0, 17) + '..' : (item.description || '');
      doc.text(desc, cx + 1, y + 1); cx += colWidths[2];
      doc.text(String(item.quantity ?? ''), cx + 1, y + 1); cx += colWidths[3];
      doc.text(item.unit || '', cx + 1, y + 1); cx += colWidths[4];
      doc.text(item.unitPrice?.toFixed(2) || '', cx + 1, y + 1); cx += colWidths[5];
      doc.text(item.totalPrice?.toFixed(2) || '', cx + 1, y + 1); cx += colWidths[6];
      doc.text(item.originCountry || '', cx + 1, y + 1);
      y += 6;
    }
  }

  // ---- 底部信息 ----
  y = Math.max(y + 10, 265);
  doc.setFontSize(FONT_SIZE_SMALL);
  doc.text(`\u751f\u6210\u65f6\u95f4: ${new Date().toLocaleString('zh-CN')}`, MARGIN_LEFT, y);
  doc.text('\u6ce8: \u6b64PDF\u4ec5\u4f9b\u5185\u90e8\u67e5\u9605/\u6253\u5370\u7528\uff0c\u4e0d\u5177\u6709\u6cd5\u5f8b\u7b7e\u7ae0\u6548\u529b', MARGIN_LEFT, y + 4);

  // 底部页码
  const pageCount = (doc.internal as any).getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFontSize(7);
    doc.text(`\u7b2c ${i} \u9875 / \u5171 ${pageCount} \u9875`, 185, 292, { align: 'right' });
  }

  return Buffer.from(doc.output('arraybuffer'));
}

function defaultStr(fallback: string, val?: string | null): string {
  return val && val.trim() ? val.trim() : fallback;
}
