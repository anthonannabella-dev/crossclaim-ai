/**
 * C-0009.2 VALIDATION-RUN HARNESS 验收
 * ---------------------------------------------------------------
 * 证明统一入口：导出文件 → 适配 → 规范输入 → 结构校验 → 数据质量 + 商业评审骨架，
 * 且商业结论恒 OPEN、平台只做猜测、全程离线不写库。
 */

import { describe, expect, it } from 'vitest';

import {
  guessPlatform,
  renderHarnessReport,
  runValidationHarness,
} from '../services/validation-run/harness';

const FIXED_NOW = () => new Date('2026-09-29T07:00:00Z');

const SHOPIFY_CSV = [
  'Name,Tracking Number(s),Invoice Number,Billed Amount,Billed Currency,Financial Status',
  'SH-1001,1Z999,INV-1,100.50,USD,paid',
  'SH-1002,1Z888,INV-2,200.00,USD,paid',
].join('\n');

const TEMPLATE_CSV = [
  'TEMPLATE,Order ID,Tracking Number,Invoice Number',
  'TEMPLATE,112-1,1Z1,INV-1',
].join('\n');

function run(fileName: string, text: string, platform?: string) {
  return runValidationHarness({
    fileName,
    bytes: Buffer.from(text, 'utf8'),
    now: FIXED_NOW,
    ...(platform ? { platform } : {}),
  });
}

describe('C-0009.2 · Validation Run Harness', () => {
  it('01 任意平台导出文件 → 统一流程，产出校验摘要且商业结论恒 OPEN', () => {
    const report = run('shopify-orders.csv', SHOPIFY_CSV);
    expect(report.adapterStatus).toBe('PASS');
    expect(report.validationRunStatus).toBe('RUN_RECORDED');
    expect(report.commercialConclusion).toBe('OPEN');
    expect(report.verification).not.toBeNull();
    expect(report.verification?.commercialConclusion).toBe('OPEN');
    expect(report.dataQuality.adaptedRowCount).toBe(2);
  });

  it('02 平台只按表头特征猜测，且标记为未确认', () => {
    const report = run('shopify-orders.csv', SHOPIFY_CSV);
    expect(report.platformGuess).toBe('SHOPIFY');
    expect(report.platformConfirmed).toBe(false);
    expect(report.nextSteps.join(' ')).toContain('confirm_platform_guess');
  });

  it('03 显式声明平台时不再猜测', () => {
    const report = run('unknown-export.csv', SHOPIFY_CSV, 'SHOPIFY');
    expect(report.platformConfirmed).toBe(true);
    expect(report.nextSteps.join(' ')).not.toContain('confirm_platform_guess');
  });

  it('04 缺必需列 → 适配 QUARANTINE，不产出校验摘要', () => {
    const csv = ['Order ID,Billed Amount', '112-1,100.50'].join('\n');
    const report = run('broken.csv', csv);
    expect(report.adapterStatus).toBe('QUARANTINE');
    expect(report.validationRunStatus).toBe('NOT_RUN');
    expect(report.verification).toBeNull();
    expect(report.nextSteps.join(' ')).toContain('adapter_quarantine_review');
  });

  it('05 PDF → QUARANTINE（不做 OCR）', () => {
    const report = run('invoice.pdf', '%PDF-1.7\nstatement');
    expect(report.adapterStatus).toBe('QUARANTINE');
    expect(report.adapterReport.quarantineReason).toBe('PDF_STRUCTURE_ONLY_NO_OCR');
  });

  it('06 模板输入 → NOT_RUN（防止被当成验证记录）', () => {
    const report = run('template-sample.csv', TEMPLATE_CSV);
    expect(report.validationRunStatus).toBe('NOT_RUN');
    expect(report.nextSteps.join(' ')).toContain('template_input_not_a_validation');
  });

  it('07 数据质量：填充率与提示（claimOutcome 为空 → 明确提示）', () => {
    const report = run('shopify-orders.csv', SHOPIFY_CSV);
    expect(report.dataQuality.fillRateByColumn.orderId).toBe(100);
    // 适配器把空 claimOutcome 归一为 NOT_STARTED（因此填充率是 100，但「无结论」仍被提示）
    expect(report.dataQuality.fillRateByColumn.claimOutcome).toBe(100);
    expect(report.dataQuality.fillRateByColumn.evidenceRef).toBe(0);
    expect(report.dataQuality.hints.map((hint) => hint.code)).toContain('CLAIM_OUTCOME_UNKNOWN');
    expect(report.dataQuality.hints.map((hint) => hint.code)).toContain('CLAIM_OUTCOME_UNKNOWN');
  });

  it('08 渲染报告含三层状态与商业评审骨架，且不含商业结论词', () => {
    const markdown = renderHarnessReport(run('shopify-orders.csv', SHOPIFY_CSV));
    expect(markdown).toContain('商业结论：OPEN');
    expect(markdown).toContain('## 商业评审骨架（人工填写）');
    expect(markdown).toContain('## 数据质量');
    expect(markdown).not.toMatch(/recoverable amount|应追回|应退/i);
  });

  it('09 同输入两次 → 报告一致（除 generatedAt）', () => {
    const strip = (value: unknown) => JSON.stringify(value).replace(/"generatedAt":"[^"]+"/g, '');
    expect(strip(run('shopify-orders.csv', SHOPIFY_CSV))).toBe(strip(run('shopify-orders.csv', SHOPIFY_CSV)));
  });

  it('10 平台特征表：不同表头给出不同猜测，未知表头返回 null', () => {
    expect(guessPlatform(['Amazon Order ID', 'FNSKU'])).toMatchObject({ platform: 'AMAZON' });
    expect(guessPlatform(['PO Number', 'Walmart Item Number'])).toMatchObject({ platform: 'WALMART' });
    expect(guessPlatform(['alpha', 'beta'])).toEqual({ platform: null, signature: null });
  });
});
