/**
 * 导入适配器测试 —— 全部为纯函数测试，不依赖数据库/Prisma。
 * 覆盖：金额与日期的脏数据解析、表头模糊匹配、CSV/XLSX 读取、行级跳过。
 */
jest.mock('../src/config/database', () => ({ __esModule: true, default: {} }));

import ExcelJS from 'exceljs';
import { adaptRows, parseAmount, parseDate } from '../src/services/recovery/import/adapters';
import { DEFAULT_MAPPINGS, resolveColumns } from '../src/services/recovery/import/columns';
import { detectFileType, parseCsv, parseXlsx } from '../src/services/recovery/import/parseFile';

// ============================================================
// 金额解析 —— 报关/物流账单里的金额写法很脏
// ============================================================
describe('parseAmount — 脏金额', () => {
  it('货币符号与千分位', () => {
    expect(parseAmount('$1,234.56')).toBe(1234.56);
    expect(parseAmount('¥ 500')).toBe(500);
    expect(parseAmount('1,000')).toBe(1000);
    expect(parseAmount(' 88.00 ')).toBe(88);
  });

  it('会计括号 = 负数', () => {
    expect(parseAmount('(12.30)')).toBe(-12.3);
    expect(parseAmount('($1,000)')).toBe(-1000);
  });

  it('本来就是负数', () => {
    expect(parseAmount('-45.5')).toBe(-45.5);
  });

  it('非金额一律 undefined，不猜', () => {
    expect(parseAmount('')).toBeUndefined();
    expect(parseAmount('N/A')).toBeUndefined();
    expect(parseAmount('待确认')).toBeUndefined();
    expect(parseAmount(null)).toBeUndefined();
    expect(parseAmount(undefined)).toBeUndefined();
  });
});

// ============================================================
// 日期解析
// ============================================================
describe('parseDate — 多种日期写法', () => {
  it('ISO 与斜杠/点号分隔', () => {
    expect(parseDate('2024-06-17')?.toISOString().slice(0, 10)).toBe('2024-06-17');
    expect(parseDate('2024/06/17')?.toISOString().slice(0, 10)).toBe('2024-06-17');
    expect(parseDate('2024.06.17')?.toISOString().slice(0, 10)).toBe('2024-06-17');
  });

  it('Excel 序列号', () => {
    const d = parseDate('45123');
    expect(d).toBeInstanceOf(Date);
    expect(d?.getUTCFullYear()).toBe(2023);
  });

  it('空值与非法值 undefined', () => {
    expect(parseDate('')).toBeUndefined();
    expect(parseDate('无')).toBeUndefined();
    expect(parseDate(null)).toBeUndefined();
  });
});

// ============================================================
// 表头匹配 —— 客户表头常带后缀
// ============================================================
describe('resolveColumns — 表头匹配', () => {
  it('忽略大小写、空白、下划线', () => {
    const cols = resolveColumns(['tracking_number', 'NET CHARGE', 'currency'], {
      sourceRef: ['Tracking Number'],
      amountActual: ['Net Charge'],
      currency: ['Currency'],
    });
    expect(cols.sourceRef).toBe(0);
    expect(cols.amountActual).toBe(1);
    expect(cols.currency).toBe(2);
  });

  it('带后缀的表头也能命中（Net Charge (USD)）', () => {
    // 用 UPS 的真实默认映射，顺带验证映射表本身
    const cols = resolveColumns(
      ['Tracking #', 'Net Charge (USD)', 'Currency Code'],
      DEFAULT_MAPPINGS.UPS!,
    );
    expect(cols.sourceRef).toBe(0);
    expect(cols.amountActual).toBe(1);
    expect(cols.currency).toBe(2);
  });

  it('表头完全对不上时返回空映射（由调用方决定报错）', () => {
    const cols = resolveColumns(['foo', 'bar'], { sourceRef: ['Tracking Number'] });
    expect(cols.sourceRef).toBeUndefined();
  });
});

// ============================================================
// CSV 读取
// ============================================================
describe('parseCsv', () => {
  it('去掉 BOM，保留原始字符串不自动转型', () => {
    const rows = parseCsv('\uFEFFTracking Number,Net Charge\n1Z999,0012.30\n');
    expect(rows[0]).toEqual(['Tracking Number', 'Net Charge']);
    expect(rows[1]).toEqual(['1Z999', '0012.30']); // 不做 dynamicTyping，避免单号被吃成数字
  });

  it('跳过空行', () => {
    const rows = parseCsv('a,b\n1,2\n\n3,4\n');
    expect(rows).toHaveLength(3);
  });
});

// ============================================================
// XLSX 读取（真建一个工作簿再读回来）
// ============================================================
describe('parseXlsx', () => {
  it('往返读取：表头 + 数值 + 日期单元格', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    ws.addRow(['Tracking Number', 'Net Charge', 'Shipment Date']);
    ws.addRow(['1Z999AA10123456784', 1234.56, new Date('2024-06-17T00:00:00Z')]);
    ws.addRow(['1Z999AA10123456785', 88, new Date('2024-06-18T00:00:00Z')]);

    const buf = await wb.xlsx.writeBuffer();
    const matrix = await parseXlsx(Buffer.from(buf as ArrayBuffer));

    expect(matrix[0]).toEqual(['Tracking Number', 'Net Charge', 'Shipment Date']);
    expect(matrix[1][0]).toBe('1Z999AA10123456784');
    expect(matrix[1][1]).toBe('1234.56');
    expect(matrix[1][2]).toContain('2024-06-17');
  });
});

describe('detectFileType', () => {
  it('按扩展名判定', () => {
    expect(detectFileType('a.CSV')).toBe('csv');
    expect(detectFileType('a.xlsx')).toBe('xlsx');
    expect(detectFileType('账单.XLSM')).toBe('xlsx');
    expect(detectFileType('无扩展名')).toBe('csv');
  });
});

// ============================================================
// adaptRows —— 端到端把 CSV 变成 NormalizedRow
// ============================================================
describe('adaptRows — UPS 账单', () => {
  const csvWithService = [
    'Tracking Number,Shipment Date,Net Charge,Currency Code,Service',
    '1Z999AA10123456784,2024-06-17,"$1,234.56",USD,Ground',
    '1Z999AA10123456785,2024-06-18,88.00,USD,Ground',
    ',,N/A,USD,Air',              // ← 无单号且金额不可解析，应被跳过
  ].join('\n');

  it('正常行被归一化，脏行被记入 skipped 且带行号', () => {
    const matrix = parseCsv(csvWithService);
    const result = adaptRows('UPS', matrix);

    expect(result.rows).toHaveLength(2);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].line).toBe(4);          // 表头占第 1 行
    expect(result.skipped[0].reason).toContain('无金额且无单号');

    const first = result.rows[0];
    expect(first.sourceRef).toBe('1Z999AA10123456784');
    expect(first.amountActual).toBe(1234.56);
    expect(first.currency).toBe('USD');
    expect(first.occurredAt?.toISOString().slice(0, 10)).toBe('2024-06-17');
    expect(first.signalType).toBe('Ground');          // 来自 Service 列
    expect(first.raw['Net Charge']).toBe('$1,234.56'); // 原始行被完整保留
  });

  it('没有类型列时回落到渠道默认漏损类型', () => {
    const matrix = parseCsv('Tracking Number,Net Charge\n1Z999,10.00\n');
    const result = adaptRows('UPS', matrix);
    expect(result.rows[0].signalType).toBe('FREIGHT_CHARGE_MISBILL');
  });

  it('表头完全无法识别时明确报错，而不是静默产出空结果', () => {
    expect(() => adaptRows('UPS', [['无关系列A', '无关系列B'], ['1', '2']]))
      .toThrow(/无法识别/);
  });

  it('自定义 mapping 可以救回不认识的表头', () => {
    const matrix = parseCsv('运单编号,应收金额\nSF123,66.00\n');
    const result = adaptRows('UPS', matrix, {
      sourceRef: ['运单编号'],
      amountActual: ['应收金额'],
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].sourceRef).toBe('SF123');
    expect(result.rows[0].amountActual).toBe(66);
  });

  it('空文件不抛异常，返回一条说明性 skipped', () => {
    const result = adaptRows('UPS', []);
    expect(result.rows).toHaveLength(0);
    expect(result.skipped[0].reason).toBe('文件为空');
  });
});

// ============================================================
// Amazon 报表（列名与 UPS/FedEx 完全不同）
// ============================================================
describe('adaptRows — Amazon 报表', () => {
  it('识别 reimbursement-id / amount-total 这类小写带连字符的列名', () => {
    const csv = [
      'reimbursement-id,approval-date,amount-total,currency,reason',
      'REIMB-001,2024-06-17,45.90,USD,FBA Inventory Lost',
    ].join('\n');
    const result = adaptRows('AMAZON', parseCsv(csv));

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].sourceRef).toBe('REIMB-001');
    expect(result.rows[0].amountExpected).toBe(45.9);
    expect(result.rows[0].signalType).toBe('FBA Inventory Lost');
  });
});

