/**
 * SHOPIFY-FILE-ADAPTER（架构方 MSG-20260929-07：GO_IMPLEMENTATION）
 * ---------------------------------------------------------------
 * 边界（逐条对齐裁决）：只做 CSV/XLSX 导入、字段映射、quarantine、canonical input、validation report。
 * 禁止：Shopify API / 自动同步 / dispute 提交 / 退款 / 规则判断 / 佣金计算。
 *
 * 本测试完全离线：不触网、不用凭据、不写数据库。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { adaptUploadedFile } from '../services/validation-run/adapters';

const FIXTURES = path.resolve(process.cwd(), 'fixtures/scenarios/shopify');
const FIXED_NOW = () => new Date('2026-09-29T05:00:00Z');

function adapt(name: string) {
  return adaptUploadedFile({
    fileName: name,
    bytes: readFileSync(path.join(FIXTURES, name)),
    now: FIXED_NOW,
  });
}

describe('Shopify 导出适配：字段映射', () => {
  it('01 Orders 无发票号 → QUARANTINE + invoiceNo ACTION（不拿订单号顶替）', () => {
    const { report } = adapt('01-orders.csv');

    expect(report.status).toBe('QUARANTINE');
    expect(report.coverage.requiredMatched).toBe(2);
    expect(report.coverage.requiredTotal).toBe(3);
    expect(report.mappedColumns.orderId).toBe('Name');
    expect(report.mappedColumns.trackingNo).toBe('Tracking Number');
    expect(report.mappedColumns.invoiceNo).toBeNull();
    expect(report.ambiguities.some((item) => /invoice/i.test(item.field))).toBe(true);
  });

  it('02 带发票号的 Orders → PASS，必需 3/3', () => {
    const { report, rows } = adapt('02-orders-with-invoice.csv');

    expect(report.status).toBe('PASS');
    expect(report.coverage.requiredMatched).toBe(3);
    expect(rows.map((row) => row.row.orderId)).toEqual(['#2001', '#2002']);
    expect(rows.map((row) => row.row.invoiceNo)).toEqual(['INV-2001', 'INV-2002']);
  });

  it('03 Disputes 导出 → 结构化识别（claimOutcome 来自 Dispute Status），不评估胜诉', () => {
    const { report, rows } = adapt('03-disputes.csv');

    expect(report.status).toBe('PASS');
    expect(rows).toHaveLength(2);
    expect(rows[0].row.claimOutcome).toBe('needs_response');
    expect(rows[1].row.claimOutcome).toBe('under_review');

    // 只做结构识别：报告中不得出现胜诉/追回类判断字段
    const serialized = JSON.stringify(report);
    expect(serialized).not.toMatch(/winProbability|recoverable|shouldSubmit/i);
  });

  it('04 多单号 → 取第一个并记 ambiguity（不合并、不择优）', () => {
    const { report, rows } = adapt('04-multi-tracking.csv');

    expect(rows).toHaveLength(1);
    expect(rows[0].row.trackingNo).toBe('1Z0000000000004001');
    expect(report.ambiguities.some((item) => /tracking/i.test(item.field))).toBe(true);
  });

  it('05 缺 orderId → QUARANTINE，且不猜测替代列', () => {
    const { report } = adapt('05-missing-order-id.csv');

    expect(report.status).toBe('QUARANTINE');
    expect(report.mappedColumns.orderId).toBeNull();
    expect(report.ambiguities.length).toBeGreaterThan(0);
  });
});

describe('Shopify 导出适配：治理与鲁棒性', () => {
  it('06 重复行保留行号与原始哈希；原始文件不被改写', () => {
    const bytes = readFileSync(path.join(FIXTURES, '02-orders-with-invoice.csv'));
    const duplicated = Buffer.from(
      `${bytes.toString('utf8').trimEnd()}\n#2001,1Z0000000000002001,INV-2001,USD,88.00,2026-02-01T10:00:00Z`,
      'utf8',
    );
    const { report, rows } = adaptUploadedFile({
      fileName: 'dup.csv',
      bytes: duplicated,
      now: FIXED_NOW,
    });

    expect(report.status).toBe('PASS');
    expect(rows).toHaveLength(3);
    expect(rows[0].rawRowHash).toBe(rows[2].rawRowHash);
    expect(rows[0].rowNumber).not.toBe(rows[2].rowNumber);
  });

  it('07 1 万行批量 → PASS，不丢行，rowNumber 连续', () => {
    const lines = ['Name,Tracking Number,Invoice Number,Currency,Total'];
    for (let index = 0; index < 10_000; index += 1) {
      const seq = String(index).padStart(6, '0');
      lines.push(`#${seq},1Z0000000000${seq},INV-S${seq},USD,10.00`);
    }
    const { report, rows } = adaptUploadedFile({
      fileName: 'shopify-bulk.csv',
      bytes: Buffer.from(lines.join('\n'), 'utf8'),
      now: FIXED_NOW,
    });

    expect(report.status).toBe('PASS');
    expect(rows).toHaveLength(10_000);
    expect(rows[0].rowNumber).toBe(2);
    expect(rows[9_999].rowNumber).toBe(10_001);
  });

  it('08 PDF / 未知格式 → QUARANTINE', () => {
    const pdf = adaptUploadedFile({
      fileName: 'dispute.pdf',
      bytes: Buffer.concat([Buffer.from('%PDF-1.7\n', 'utf8'), Buffer.alloc(32, 0x20)]),
      now: FIXED_NOW,
    });
    const unknown = adaptUploadedFile({
      fileName: 'blob.bin',
      bytes: Buffer.from('%% not a table %%', 'utf8'),
      now: FIXED_NOW,
    });

    expect(pdf.report.status).toBe('QUARANTINE');
    expect(pdf.report.quarantineReason).toBe('PDF_STRUCTURE_ONLY_NO_OCR');
    expect(unknown.report.status).toBe('QUARANTINE');
  });

  it('09 报告不含凭据/平台授权字段（离线边界）', () => {
    const { report } = adapt('02-orders-with-invoice.csv');
    const serialized = JSON.stringify(report);

    expect(serialized).not.toMatch(/accessToken|apiKey|clientSecret|oauth/i);
    expect(report.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
