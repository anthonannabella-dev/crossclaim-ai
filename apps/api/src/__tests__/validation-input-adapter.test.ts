/**
 * C-0009.1-A — 平台导出适配器（单元）：CSV / JSON / XLSX / PDF / 未知格式、字段映射、覆盖率和不确定项。
 */

import { describe, expect, it } from 'vitest';

import {
  adaptUploadedFile,
  detectFormat,
  normalizeHeader,
  renderAdapterReport,
  toCanonicalCsv,
} from '../services/validation-run/adapters';

const NOW = new Date('2026-09-29T02:00:00Z');

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** 构造一个最小的 stored 模式 XLSX（仅供本仓库的极简读取器消费）。 */
function buildXlsx(entries: Array<{ name: string; content: string }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.content, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10); // stored
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);

    localParts.push(local, data);
    centralParts.push(central);
    offset += local.length + data.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

const CSV = [
  'Amazon Order ID,Tracking Number,Invoice No,Carrier,Promised Delivery,Delivered At,Freight Charge,Currency,Invoiced Amount,POD,备注',
  '112-845234-4821,1Z999AA10123456784,INV-1,UPS,2026-09-01T00:00:00Z,2026-09-03T00:00:00Z,100.0000,USD,120.0000,pod/inv-1.pdf,delayed 2 days',
].join('\n');

describe('C-0009.1-A — 格式识别与 CSV 映射', () => {
  it('按内容识别 XLSX/PDF，按扩展名识别 CSV/JSON', () => {
    expect(detectFormat('a.csv', Buffer.from('a,b\n1,2'))).toBe('CSV');
    expect(detectFormat('a.json', Buffer.from('[]'))).toBe('JSON');
    expect(detectFormat('a.xlsx', Buffer.from('PK\u0003\u0004abc'))).toBe('XLSX');
    expect(detectFormat('a.pdf', Buffer.from('%PDF-1.7'))).toBe('PDF');
    expect(detectFormat('a.bin', Buffer.from('nonsense'))).toBe('UNKNOWN');
  });

  it('CSV：别名命中 → 规范 14 列；未知列进 quarantine；通用币种进不确定项', () => {
    const result = adaptUploadedFile({ fileName: 'amazon-settlement.csv', bytes: Buffer.from(CSV, 'utf8'), now: () => NOW });
    expect(result.report).toMatchObject({
      format: 'CSV',
      engineeringStatus: 'PASS',
      status: 'PASS',
      originalRowCount: 1,
      adaptedRowCount: 1,
    });
    expect(result.report.mappedColumns.orderId).toBe('Amazon Order ID');
    expect(result.report.mappedColumns.trackingNo).toBe('Tracking Number');
    expect(result.report.mappedColumns.invoiceNo).toBe('Invoice No');
    expect(result.report.coverage.requiredMatched).toBe(3);
    expect(result.report.ambiguities.map((item) => item.field)).toContain('currency');
    expect(result.report.ambiguities.every((item) => item.action === 'manual confirmation required')).toBe(true);

    const row = result.rows[0];
    expect(row.rowNumber).toBe(2);
    expect(row.row.claimOutcome).toBe('NOT_STARTED');
    expect(row.row.billedAmount).toBe('100.0000');
    expect(row.row.note).toContain('delayed');
    expect(row.rawRowHash).toHaveLength(64);
  });

  it('规范化表头：大小写/空格/下划线/连字符一律等价', () => {
    expect(normalizeHeader('Order_ID')).toBe('orderid');
    expect(normalizeHeader('order id')).toBe('orderid');
    expect(normalizeHeader('ORDER-ID')).toBe('orderid');
    expect(normalizeHeader('  Amazon Order ID ')).toBe('amazonorderid');
  });

  it('缺少必需列 → QUARANTINE 且给出 ACTION（不猜）', () => {
    const csv = ['Some Column,Other', 'a,b'].join('\n');
    const result = adaptUploadedFile({ fileName: 'unknown.csv', bytes: Buffer.from(csv, 'utf8'), now: () => NOW });
    expect(result.report.status).toBe('QUARANTINE');
    expect(result.report.quarantineReason).toBe('REQUIRED_COLUMNS_MISSING');
    expect(result.report.unknownColumns).toEqual(['Some Column', 'Other']);
    const unknown = result.report.ambiguities.filter((item) => item.detail.includes('没有对应表头'));
    expect(unknown.map((item) => item.field)).toEqual(['orderId', 'trackingNo', 'invoiceNo']);
  });

  it('规范 CSV 输出可直接喂给既有验证工具链', () => {
    const result = adaptUploadedFile({ fileName: 'amazon-settlement.csv', bytes: Buffer.from(CSV, 'utf8'), now: () => NOW });
    const canonical = toCanonicalCsv(result.rows);
    const header = canonical.split('\n')[0].split(',');
    expect(header).toEqual([
      'orderId',
      'trackingNo',
      'invoiceNo',
      'channel',
      'promisedDeliveredAt',
      'actualDeliveredAt',
      'billedAmount',
      'billedCurrency',
      'invoiceAmount',
      'invoiceCurrency',
      'evidenceRef',
      'settlementRef',
      'claimOutcome',
      'note',
    ]);
  });
});

describe('C-0009.1-A — JSON / XLSX / PDF', () => {
  it('JSON 对象数组：键并集做表头', () => {
    const json = JSON.stringify([
      { order_id: '112-1', tracking_number: '1Z1', invoice_no: 'INV-1', amount: '10.0000' },
      { order_id: '112-2', tracking_number: '1Z2', invoice_no: 'INV-2' },
    ]);
    const result = adaptUploadedFile({ fileName: 'export.json', bytes: Buffer.from(json, 'utf8'), now: () => NOW });
    expect(result.report.format).toBe('JSON');
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].row.orderId).toBe('112-1');
    expect(result.report.coverage.requiredMatched).toBe(3);
  });

  it('XLSX：共享字符串 + 首张工作表可读（零依赖）', () => {
    const xlsx = buildXlsx([
      {
        name: 'xl/sharedStrings.xml',
        content:
          '<?xml version="1.0"?><sst><si><t>Order ID</t></si><si><t>Tracking</t></si><si><t>Invoice</t></si>' +
          '<si><t>112-1</t></si><si><t>1Z1</t></si><si><t>INV-1</t></si></sst>',
      },
      {
        name: 'xl/worksheets/sheet1.xml',
        content:
          '<?xml version="1.0"?><worksheet><sheetData>' +
          '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>' +
          '<row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2" t="s"><v>4</v></c><c r="C2" t="s"><v>5</v></c></row>' +
          '</sheetData></worksheet>',
      },
    ]);
    const result = adaptUploadedFile({ fileName: 'walmart-settlement.xlsx', bytes: xlsx, now: () => NOW });
    expect(result.report.format).toBe('XLSX');
    expect(result.report.status).toBe('PASS');
    expect(result.rows[0].row.orderId).toBe('112-1');
    expect(result.rows[0].row.invoiceNo).toBe('INV-1');
  });

  it('PDF 只做结构识别：QUARANTINE + ACTION（不做 OCR 自动化）', () => {
    const result = adaptUploadedFile({ fileName: 'customs.pdf', bytes: Buffer.from('%PDF-1.7 dummy'), now: () => NOW });
    expect(result.report).toMatchObject({ format: 'PDF', status: 'QUARANTINE', quarantineReason: 'PDF_STRUCTURE_ONLY_NO_OCR' });
    expect(result.rows).toHaveLength(0);
  });
});

describe('C-0009.1-A — 报告', () => {
  it('报告含覆盖率、未知列与不确定项，且不含业务判断词', () => {
    const result = adaptUploadedFile({ fileName: 'amazon-settlement.csv', bytes: Buffer.from(CSV, 'utf8'), now: () => NOW });
    const md = renderAdapterReport(result.report);
    expect(md).toContain('必需列：3/3');
    expect(md).toContain('UNKNOWN: `currency`');
    expect(md).toContain('ACTION: manual confirmation required');
    for (const forbidden of ['可追回', '不合理费用', '应赔', 'PROFITABLE']) {
      expect(md).not.toContain(forbidden);
    }
  });
});
