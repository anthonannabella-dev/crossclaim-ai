/**
 * C-0009.1 Validation Run Toolkit — 单元测试（不依赖真实数据）。
 * 依据 MSG-20260928-110：确定性指纹（不是盐）、claimOutcome 枚举、三层状态、
 * TEMPLATE 输入必须 NOT_RUN、任何情况下都不得产出商业结论。
 */

import { describe, expect, it } from 'vitest';

import {
  CLAIM_OUTCOMES,
  FINGERPRINT_LENGTH,
  VALIDATION_COLUMNS,
  anonymizeRow,
  anonymizeRows,
  fingerprint,
  maskFreeText,
} from '../services/validation-run/anonymize';
import {
  parseCsv,
  renderReport,
  rowsFromCsv,
  sha256Of,
  verifyRows,
} from '../services/validation-run/verify';

const NOW = new Date('2026-09-28T18:00:00Z');

function row(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    orderId: '112-845234-4821',
    trackingNo: '1Z999AA10123456784',
    invoiceNo: 'INV-1',
    channel: 'UPS',
    promisedDeliveredAt: '2026-09-01T00:00:00Z',
    actualDeliveredAt: '2026-09-03T00:00:00Z',
    billedAmount: '100.0000',
    billedCurrency: 'USD',
    invoiceAmount: '120.0000',
    invoiceCurrency: 'USD',
    evidenceRef: 'pod/inv-1.pdf',
    settlementRef: '',
    claimOutcome: 'NOT_STARTED',
    note: 'contact ops@example.com or +1 415 555 1234',
    ...overrides,
  };
}

describe('C-0009.1 toolkit — 脱敏', () => {
  it('确定性指纹：同值同输出、不同值不同输出、长度固定（不是加盐）', () => {
    expect(FINGERPRINT_LENGTH).toBe(8);
    expect(fingerprint('invoice-1')).toBe(fingerprint('invoice-1'));
    expect(fingerprint('invoice-1')).not.toBe(fingerprint('invoice-2'));
    expect(fingerprint('invoice-1')).toHaveLength(8);
  });

  it('orderId / trackingNo 复用生产掩码规则；金额币种日期渠道保留', () => {
    const out = anonymizeRow(row());
    expect(out.orderId).toBe('112-****-4821');
    expect(out.trackingNo).toBe('1Z****6784');
    expect(out.invoiceNo).toBe('INV-1');
    expect(out.channel).toBe('UPS');
    expect(out.billedAmount).toBe('100.0000');
    expect(out.invoiceCurrency).toBe('USD');
    expect(out.promisedDeliveredAt).toBe('2026-09-01T00:00:00Z');
  });

  it('evidenceRef / settlementRef 只留确定性占位；自由文本里的邮箱电话被替换', () => {
    const withRefs = anonymizeRow(row({ settlementRef: 'PAYOUT-777' }));
    expect(withRefs.evidenceRef).toBe(`evref-${fingerprint('pod/inv-1.pdf')}`);
    expect(withRefs.settlementRef).toBe(`settle-${fingerprint('PAYOUT-777')}`);
    expect(withRefs.note).not.toContain('ops@example.com');
    expect(withRefs.note).not.toContain('415');
    expect(maskFreeText('12 Main Street')).toContain('<address>');
  });

  it('claimOutcome 缺省为 NOT_STARTED，且枚举与架构方给出的那一组一致', () => {
    const out = anonymizeRow(row({ claimOutcome: '' }));
    expect(out.claimOutcome).toBe('NOT_STARTED');
    expect([...CLAIM_OUTCOMES]).toEqual([
      'NOT_STARTED',
      'IDENTIFIED',
      'SUBMITTED_MANUAL',
      'RECOVERED',
      'REJECTED',
      'UNKNOWN',
    ]);
  });

  it('两次脱敏结果一致（可复现、可 join）', () => {
    const first = anonymizeRows([row(), row({ orderId: '112-000000-0001' })]);
    const second = anonymizeRows([row(), row({ orderId: '112-000000-0001' })]);
    expect(first).toEqual(second);
  });
});

describe('C-0009.1 toolkit — CSV 解析与校验', () => {
  it('CSV 支持引号与转义引号', () => {
    const parsed = parseCsv('a,b\n"x,1","he said ""hi"""\n');
    expect(parsed[1]).toEqual(['x,1', 'he said "hi"']);
  });

  it('TEMPLATE 输入 → NOT_RUN，不产出任何行数分布', () => {
    const text = '# TEMPLATE — 仅结构示例\norderId,trackingNo\n1,2\n';
    const summary = verifyRows({
      fileName: 'template.csv',
      rawText: text,
      inputKind: 'desensitized-real-structure',
      rows: [{ orderId: '112-****-4821' }],
      now: () => NOW,
    });
    expect(summary.templateDetected).toBe(true);
    expect(summary.validationRunStatus).toBe('NOT_RUN');
    expect(summary.engineeringStatus).toBe('PASS');
    expect(summary.issues).toHaveLength(0);
    expect(summary.rowCountsByChannel).toEqual({});
    expect(summary.commercialConclusion).toBe('OPEN');
  });

  it('合规输入 → 工程 PASS / RUN_RECORDED / 商业结论恒为 OPEN', () => {
    const raw = 'header\nrow\n';
    const summary = verifyRows({
      fileName: 'run-001.csv',
      rawText: raw,
      inputKind: 'desensitized-real-structure',
      rows: [anonymizeRow(row()), anonymizeRow(row({ trackingNo: '1Z999AA10123456785' }))],
      now: () => NOW,
    });
    expect(summary.engineeringStatus).toBe('PASS');
    expect(summary.validationRunStatus).toBe('RUN_RECORDED');
    expect(summary.commercialConclusion).toBe('OPEN');
    expect(summary.inputSha256).toBe(sha256Of(raw));
    expect(summary.rowCountsByChannel).toEqual({ UPS: 2 });
    expect(summary.rowCountsByClaimOutcome).toEqual({ NOT_STARTED: 2 });
  });

  it('结构问题逐类报错（缺字段 / 币种 / 金额格式 / 日期 / 妥投早于承诺 / 重复行 / 非法 claimOutcome）', () => {
    const bad = anonymizeRow(
      row({
        orderId: '',
        trackingNo: '1Z999AA10123456784',
        invoiceNo: 'INV-9',
        billedCurrency: 'XYZ',
        billedAmount: '1.23456',
        promisedDeliveredAt: 'not-a-date',
        actualDeliveredAt: '2026-09-01T00:00:00Z',
        claimOutcome: '追回成功',
      }),
    );
    const duplicate = anonymizeRow(row({ invoiceNo: 'INV-9' }));
    const earlyDelivery = anonymizeRow(
      row({
        trackingNo: '1Z999AA10123456786',
        invoiceNo: 'INV-10',
        promisedDeliveredAt: '2026-09-10T00:00:00Z',
        actualDeliveredAt: '2026-09-01T00:00:00Z',
      }),
    );
    const summary = verifyRows({
      fileName: 'run-bad.csv',
      rawText: 'x\n',
      inputKind: 'desensitized-real-structure',
      rows: [bad, duplicate, earlyDelivery],
      now: () => NOW,
    });
    const codes = summary.issues.map((issue) => issue.code);
    expect(summary.engineeringStatus).toBe('FAIL');
    expect(codes).toContain('MISSING_FIELD');
    expect(codes).toContain('CURRENCY_NOT_ALLOWED');
    expect(codes).toContain('AMOUNT_FORMAT');
    expect(codes).toContain('DATE_UNPARSABLE');
    expect(codes).toContain('DELIVERY_BEFORE_PROMISE');
    expect(codes).toContain('DUPLICATE_ROW');
    expect(codes).toContain('CLAIM_OUTCOME_NOT_ALLOWED');
    expect(summary.validationRunStatus).toBe('RUN_RECORDED');
  });

  it('人读报告带三层状态，并明确「不含商业结论」', () => {
    const summary = verifyRows({
      fileName: 'run-002.csv',
      rawText: 'x\n',
      inputKind: 'desensitized-real-structure',
      rows: [anonymizeRow(row())],
      now: () => NOW,
    });
    const report = renderReport(summary);
    expect(report).toContain('engineeringStatus   : PASS');
    expect(report).toContain('validationRunStatus : RUN_RECORDED');
    expect(report).toContain('commercialConclusion: OPEN');
    expect(report).toContain('不含商业结论');
    expect(report).not.toContain('ARR');
  });

  it('输入列集合就是架构方批准的那 14 列（含 REVISE 追加的两列）', () => {
    expect([...VALIDATION_COLUMNS]).toEqual([
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
    const { header } = rowsFromCsv('orderId,trackingNo\n1,2\n');
    expect(header).toEqual(['orderId', 'trackingNo']);
  });
});
