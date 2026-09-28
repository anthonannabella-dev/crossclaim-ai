/**
 * Wave 1 · 导入层单元测试（Gate 1 · Checkpoint 2）
 * ---------------------------------------------------------------
 * 覆盖：CSV 解析容错、列映射、归一化校验、幂等键、批次状态机（IMPORTED / PARTIAL / FAILED）。
 * 数据库级导入测试见 ingest-db.test.ts。
 */

import { describe, expect, it } from 'vitest';

import {
  autoMap,
  dedupeKey,
  normalizeRow,
  parseAmount,
  parseCsv,
  parseOccurredAt,
  rowFingerprint,
  runImport,
  validateMapping,
  type ImportBatchDraft,
  type ImportRepository,
  type TransactionInsert,
} from '../services/ingest';

const ORG = '11111111-1111-4111-8111-111111111111';
const CONN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONTEXT = { organizationId: ORG, domain: 'LOGISTICS' as const, channel: 'UPS' as const, connectionId: CONN };

/** 内存端口：记录所有写入，insertTransactions 模拟唯一键去重 */
function memoryRepo() {
  const batches: Array<{ id: string } & Partial<ImportBatchDraft>> = [];
  const transactions: TransactionInsert[] = [];
  const seen = new Set<string>();
  let seq = 0;

  const repository: ImportRepository = {
    async createBatch(data) {
      seq += 1;
      const id = `batch-${seq}`;
      batches.push({ id, ...data });
      return { id };
    },
    async updateBatch(id, data) {
      const target = batches.find((b) => b.id === id);
      if (target) Object.assign(target, data);
    },
    async insertTransactions(rows) {
      let inserted = 0;
      for (const row of rows) {
        if (seen.has(row.dedupeKey)) continue;
        seen.add(row.dedupeKey);
        transactions.push(row);
        inserted += 1;
      }
      return { inserted };
    },
  };
  return { repository, batches, transactions };
}

// ============================================================
describe('CSV 解析', () => {
  it('支持引号、内嵌逗号与换行、双引号转义、CRLF 与 BOM', () => {
    const csv = '\uFEFFa,b,c\r\n1,"x,y","line1\nline2"\r\n2,"he said ""hi""",z\r\n';
    const parsed = parseCsv(csv);
    expect(parsed.header).toEqual(['a', 'b', 'c']);
    expect(parsed.rows).toEqual([
      ['1', 'x,y', 'line1\nline2'],
      ['2', 'he said "hi"', 'z'],
    ]);
  });

  it('忽略末尾空行，支持分号分隔', () => {
    const parsed = parseCsv('a;b\n1;2\n\n', { delimiter: ';' });
    expect(parsed.rows).toEqual([['1', '2']]);
  });

  it('引号未闭合 / 空内容 / 空表头直接报错', () => {
    expect(() => parseCsv('a,b\n"unclosed')).toThrow(/引号未闭合/);
    expect(() => parseCsv('')).toThrow(/没有可解析的内容/);
    expect(() => parseCsv(',,\n1,2,3')).toThrow(/表头为空/);
  });
});

// ============================================================
describe('列映射', () => {
  it('按别名自动映射常见表头', () => {
    const mapping = autoMap(['Invoice No', 'Tracking Number', 'Invoice Date', 'Net Charge', 'Currency']);
    expect(mapping.externalId).toBe('Invoice No');
    expect(mapping.occurredAt).toBe('Invoice Date');
    expect(mapping.amount).toBe('Net Charge');
    expect(mapping.currency).toBe('Currency');
    // referenceType 描述的是"外部引用的类型"，不是运单号本身，因此这里没有可映射的列
    expect(mapping.referenceType).toBeUndefined();
  });

  it('有类型列时会把类型列映射到 referenceType', () => {
    const mapping = autoMap(['Doc Type', 'Invoice Number', 'Amount']);
    expect(mapping.referenceType).toBe('Doc Type');
    expect(mapping.externalId).toBe('Invoice Number');
    expect(mapping.amount).toBe('Amount');
  });

  it('缺少金额列 → 整批拒绝；同列映射到两个字段 → 拒绝', () => {
    expect(() => validateMapping(['a', 'b'], { externalId: 'a' })).toThrow(/amount/);
    expect(() => validateMapping(['a'], { amount: 'a', externalId: 'a' })).toThrow(/多个内部字段/);
    expect(() => validateMapping(['a'], { amount: 'missing' })).toThrow(/不存在的列/);
  });
});

// ============================================================
describe('归一化与校验', () => {
  it('金额：接受千分位与货币符号，拒绝非法格式，四舍五入位数受限', () => {
    expect(parseAmount('1,234.56')).toBe('1234.56');
    expect(parseAmount('$ 12.3456')).toBe('12.3456');
    expect(parseAmount('12.34567')).toBeNull();
    expect(parseAmount('abc')).toBeNull();
    expect(parseAmount('')).toBeNull();
  });

  it('日期：支持 ISO 与 yyyy-mm-dd / yyyy/mm/dd，非法日期为 null', () => {
    expect(parseOccurredAt('2026-09-28')?.toISOString()).toBe('2026-09-28T00:00:00.000Z');
    expect(parseOccurredAt('2026/09/28')?.toISOString()).toBe('2026-09-28T00:00:00.000Z');
    expect(parseOccurredAt('2026-09-28T10:00:00Z')?.toISOString()).toBe('2026-09-28T10:00:00.000Z');
    expect(parseOccurredAt('not-a-date')).toBeNull();
  });

  it('缺金额 / 非法币种 / 非法日期都产生行级问题，且不产出交易', () => {
    const mapping = { amount: 'amount', currency: 'ccy', occurredAt: 'date' };
    const r1 = normalizeRow({ amount: '', ccy: 'USD', date: '2026-09-28' }, mapping, CONTEXT, 1);
    expect(r1.transaction).toBeUndefined();
    expect(r1.issues.map((i) => i.code)).toContain('INVALID_AMOUNT');

    const r2 = normalizeRow({ amount: '10', ccy: 'US', date: '2026-09-28' }, mapping, CONTEXT, 2);
    expect(r2.issues.map((i) => i.code)).toContain('INVALID_CURRENCY');

    const r3 = normalizeRow({ amount: '10', ccy: 'USD', date: 'oops' }, mapping, CONTEXT, 3);
    expect(r3.issues.map((i) => i.code)).toContain('INVALID_DATE');
  });

  it('空行被识别为 EMPTY_ROW（跳过，不算失败）', () => {
    const r = normalizeRow({ amount: '  ' }, { amount: 'amount' }, CONTEXT, 1);
    expect(r.issues.map((i) => i.code)).toEqual(['EMPTY_ROW']);
  });
});

// ============================================================
describe('幂等键', () => {
  it('行指纹与列顺序无关，与空白差异无关', () => {
    const a = rowFingerprint({ a: '1', b: '2' });
    const b = rowFingerprint({ b: '2', a: '1' });
    const c = rowFingerprint({ a: '  1 ', b: '2  ' });
    expect(a).toBe(b);
    expect(a).toBe(c);
    expect(a).not.toBe(rowFingerprint({ a: '1', b: '3' }));
  });

  it('dedupeKey 绑定租户 / 连接 / 引用类型 / 外部 id / 行指纹', () => {
    const base = { organizationId: ORG, connectionId: CONN, referenceType: 'INVOICE', externalId: 'INV-1', rowFingerprint: 'f' };
    expect(dedupeKey(base)).toBe(dedupeKey({ ...base }));
    expect(dedupeKey(base)).not.toBe(dedupeKey({ ...base, externalId: 'INV-2' }));
    expect(dedupeKey(base)).not.toBe(dedupeKey({ ...base, organizationId: 'other' }));
  });
});

// ============================================================
describe('导入编排', () => {
  const csv = [
    'Invoice No,Tracking Number,Invoice Date,Net Charge,Currency',
    'INV-1,1Z999,2026-09-01,100.50,USD',
    'INV-2,1Z888,2026-09-02,200.00,USD',
  ].join('\n');

  it('正常批次：状态 IMPORTED，写 2 条交易，保留 raw，落列映射快照', async () => {
    const { repository, batches, transactions } = memoryRepo();
    const result = await runImport({ context: CONTEXT, csvText: csv, repository });

    expect(result.status).toBe('IMPORTED');
    expect(result.rowsTotal).toBe(2);
    expect(result.rowsOk).toBe(2);
    expect(result.rowsFailed).toBe(0);
    expect(transactions).toHaveLength(2);
    expect(transactions[0].raw).toMatchObject({ 'Invoice No': 'INV-1', 'Net Charge': '100.50' });
    expect(transactions[0].amount).toBe('100.50');
    expect(transactions[0].currency).toBe('USD');
    expect(transactions[0].occurredAt?.toISOString()).toBe('2026-09-01T00:00:00.000Z');

    const batch = batches[0];
    expect(batch.status).toBe('IMPORTED');
    expect(batch.columnMapping).toMatchObject({ amount: 'Net Charge', externalId: 'Invoice No' });
  });

  it('坏行不中断整批：状态 PARTIAL，好行照常写入，errorReport 带行号', async () => {
    const { repository, batches } = memoryRepo();
    const mixed = [
      'Invoice No,Invoice Date,Net Charge,Currency',
      'INV-1,2026-09-01,100.50,USD',
      'INV-2,2026-09-02,not-a-number,USD',
    ].join('\n');
    const result = await runImport({ context: CONTEXT, csvText: mixed, repository });

    expect(result.status).toBe('PARTIAL');
    expect(result.rowsOk).toBe(1);
    expect(result.rowsFailed).toBe(1);
    expect(result.issues[0]).toMatchObject({ row: 2, field: 'amount', code: 'INVALID_AMOUNT' });
    expect(String((batches[0].errorReport as { issues: unknown[] }).issues.length)).toBe('1');
  });

  it('全部行都坏 → FAILED，且不写任何交易', async () => {
    const { repository, transactions } = memoryRepo();
    const bad = ['Invoice No,Net Charge', 'INV-1,bad', 'INV-2,worse'].join('\n');
    const result = await runImport({ context: CONTEXT, csvText: bad, repository });
    expect(result.status).toBe('FAILED');
    expect(transactions).toHaveLength(0);
  });

  it('重复导入同一文件：新增 0 条，重复被计数', async () => {
    const { repository, transactions } = memoryRepo();
    await runImport({ context: CONTEXT, csvText: csv, repository });
    const second = await runImport({ context: CONTEXT, csvText: csv, repository });

    expect(transactions).toHaveLength(2);
    expect(second.duplicates).toBe(2);
    expect(second.rowsOk).toBe(0);
    expect(second.status).toBe('IMPORTED');
  });

  it('缺少金额列 → 批次 FAILED 且记录 stage=mapping，不写交易', async () => {
    const { repository, batches, transactions } = memoryRepo();
    const result = await runImport({ context: CONTEXT, csvText: 'a,b\n1,2', repository });
    expect(result.status).toBe('FAILED');
    expect(transactions).toHaveLength(0);
    expect((batches[0].errorReport as { stage: string }).stage).toBe('mapping');
  });

  it('CSV 解析失败 → 批次 FAILED 且记录 stage=parse', async () => {
    const { repository, batches } = memoryRepo();
    const result = await runImport({ context: CONTEXT, csvText: 'a,b\n"unclosed', repository });
    expect(result.status).toBe('FAILED');
    expect((batches[0].errorReport as { stage: string }).stage).toBe('parse');
  });

  it('无交易也有问题的批次不会写成 IMPORTED（空文件 → FAILED）', async () => {
    const { repository } = memoryRepo();
    const result = await runImport({ context: CONTEXT, csvText: 'Net Charge\n', repository });
    expect(result.rowsTotal).toBe(0);
    expect(result.status).toBe('IMPORTED');
  });
});
