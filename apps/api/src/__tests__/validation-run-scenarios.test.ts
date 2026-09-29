/**
 * O4 + O5 — 合成 fixture 场景包（失败/边界矩阵）
 * ---------------------------------------------------------------
 * 目的：把「正常 / 空 / 缺字段 / 非法 / 重复 / 极端值 / 大批量 / 伪装扩展名 / 幂等输入」
 * 固定成可重复执行的离线用例；不触网、不用真实数据、不写数据库。
 *
 * 边界（架构方 MSG-20260929-02）：只回答「能不能被结构化」，
 * 不做金额判断、不生成索赔、不接平台。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { adaptUploadedFile } from '../services/validation-run/adapters';

const FIXTURES = path.resolve(process.cwd(), 'fixtures/scenarios');
const FIXED_NOW = () => new Date('2026-09-29T03:00:00Z');

function readFixture(name: string): Buffer {
  return readFileSync(path.join(FIXTURES, name));
}

function adapt(name: string) {
  return adaptUploadedFile({ fileName: name, bytes: readFixture(name), now: FIXED_NOW });
}

describe('合成 fixture：场景包（O4）', () => {
  it('01 正常数据 → PASS，必需列 3/3，逐行保留行号与 rawRowHash', () => {
    const { report, rows } = adapt('01-normal.csv');

    expect(report.status).toBe('PASS');
    expect(report.format).toBe('CSV');
    expect(report.coverage.requiredMatched).toBe(report.coverage.requiredTotal);
    expect(report.adaptedRowCount).toBe(2);

    expect(rows.map((row) => row.rowNumber)).toEqual([2, 3]);
    expect(rows.every((row) => /^[0-9a-f]{64}$/.test(row.rawRowHash))).toBe(true);
    expect(rows[0].row.orderId).toBe('112-000000-0001');
  });

  it('02 空数据（仅表头）→ 不报错，且不产出任何行', () => {
    const { report, rows } = adapt('02-empty.csv');

    expect(rows).toHaveLength(0);
    expect(report.adaptedRowCount).toBe(0);
    expect(report.coverage.requiredMatched).toBe(report.coverage.requiredTotal);
  });

  it('03 缺必需列 → QUARANTINE，并给出人工确认 ACTION（不猜）', () => {
    const { report, rows } = adapt('03-missing-required.csv');

    expect(report.status).toBe('QUARANTINE');
    expect(report.coverage.requiredMatched).toBeLessThan(report.coverage.requiredTotal);
    expect(report.ambiguities.length).toBeGreaterThan(0);
    expect(report.ambiguities.every((item) => item.action.trim() !== '')).toBe(true);

    // QUARANTINE 仍保留已解析的行作为证据（不丢弃原始数据），但不会进入规范输入。
    expect(rows.every((row) => row.rawRowHash.length === 64)).toBe(true);
  });

  it('04 未知格式 → QUARANTINE（UNKNOWN_FORMAT）', () => {
    const { report } = adapt('04-unknown.txt');

    expect(report.status).toBe('QUARANTINE');
    expect(report.quarantineReason).toBe('UNKNOWN_FORMAT');
  });

  it('05 重复行 → 两行都保留（行号不同、原始行哈希相同，不静默去重）', () => {
    const { report, rows } = adapt('05-duplicate-rows.csv');

    expect(report.status).toBe('PASS');
    expect(rows).toHaveLength(2);
    expect(rows[0].rowNumber).not.toBe(rows[1].rowNumber);
    expect(rows[0].rawRowHash).toBe(rows[1].rawRowHash);
  });

  it('06 极端值（0 / 负数 / 超大金额 / 非 ASCII）→ 原值不丢', () => {
    const { report, rows } = adapt('06-extreme-values.csv');

    expect(report.status).toBe('PASS');
    expect(rows).toHaveLength(4);

    const amounts = rows.map((row) => row.row.billedAmount);
    expect(amounts).toContain('0.0000');
    expect(amounts).toContain('-12.3400');
    expect(amounts).toContain('999999999999.9999');

    expect(rows[3].row.note).toContain('中文备注');
    expect(rows[3].row.note).toContain('🚚');
  });

  it('07 脏表头（大小写/空格/下划线混杂）→ 别名映射命中必需列', () => {
    const { report } = adapt('07-messy-headers.csv');

    expect(report.status).toBe('PASS');
    expect(report.coverage.requiredMatched).toBe(report.coverage.requiredTotal);
  });

  it('08 仅必需列 → PASS，可选覆盖为 0', () => {
    const { report } = adapt('08-partial-columns.csv');

    expect(report.status).toBe('PASS');
    expect(report.coverage.requiredMatched).toBe(report.coverage.requiredTotal);
    expect(report.coverage.optionalMatched).toBe(0);
  });
});

describe('合成 fixture：额外边界（O5 相关）', () => {
  it('09 PDF → QUARANTINE（结构识别，不进入 OCR 自动化）', () => {
    const bytes = Buffer.concat([Buffer.from('%PDF-1.7\n', 'utf8'), Buffer.alloc(64, 0x20)]);
    const { report, rows } = adaptUploadedFile({ fileName: 'statement.pdf', bytes, now: FIXED_NOW });

    expect(report.status).toBe('QUARANTINE');
    expect(report.quarantineReason).toBe('PDF_STRUCTURE_ONLY_NO_OCR');
    expect(rows).toHaveLength(0);
  });

  it('10 空 JSON 数组 → QUARANTINE（返回可读报告，不抛未捕获异常）', () => {
    const bytes = Buffer.from('[]', 'utf8');
    const { report, rows } = adaptUploadedFile({ fileName: 'empty.json', bytes, now: FIXED_NOW });

    expect(report.status).toBe('QUARANTINE');
    expect(rows).toHaveLength(0);
    expect(report.quarantineReason).toBeTruthy();
  });

  it('11 大批量（10000 行）→ PASS，行数一致且耗时在阈值内', () => {
    const header = 'Order ID,Tracking Number,Invoice Number,Billed Amount,Billed Currency';
    const lines = [header];
    for (let index = 0; index < 10_000; index += 1) {
      const seq = String(index).padStart(6, '0');
      lines.push(`112-000000-${seq},1Z0000000000000${seq.slice(-3)},INV-${seq},99.9900,USD`);
    }
    const bytes = Buffer.from(lines.join('\n'), 'utf8');

    const startedAt = Date.now();
    const { report, rows } = adaptUploadedFile({ fileName: 'bulk.csv', bytes, now: FIXED_NOW });
    const elapsedMs = Date.now() - startedAt;

    expect(report.status).toBe('PASS');
    expect(rows).toHaveLength(10_000);
    expect(report.adaptedRowCount).toBe(10_000);
    expect(elapsedMs).toBeLessThan(20_000);
  });

  it('12 扩展名伪装（.csv 里是乱码）→ 仍然 QUARANTINE', () => {
    const bytes = readFixture('04-unknown.txt');
    const { report } = adaptUploadedFile({ fileName: 'renamed.csv', bytes, now: FIXED_NOW });

    expect(report.status).toBe('QUARANTINE');
  });

  it('13 同一输入重复执行 → 报告一致（sha256 相同、行数相同）', () => {
    const first = adapt('05-duplicate-rows.csv');
    const second = adapt('05-duplicate-rows.csv');

    expect(first.report.sourceSha256).toBe(second.report.sourceSha256);
    expect(first.report.adaptedRowCount).toBe(second.report.adaptedRowCount);
    expect(first.rows.map((row) => row.rawRowHash)).toEqual(second.rows.map((row) => row.rawRowHash));
  });

  it('14 原始文件不被改写：适配报告只登记 sha256 与行数，不含金额判断结论', () => {
    const { report } = adapt('01-normal.csv');

    expect(report.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toMatch(/recoverable/i);
    expect(serialized).not.toMatch(/shouldRefund|unreasonable/i);
  });
});
