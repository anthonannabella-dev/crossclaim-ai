/**
 * Phase A — 跨平台统一入口 E2E smoke（离线，不触库/不触网）
 * ---------------------------------------------------------------
 * 用 apps/api/fixtures/synthetic 的平台级合成数据贯通：
 *   导出文件 → 适配器 → 规范输入 → 结构校验 → 数据质量 → 商业评审骨架
 * 断言：能进管线的一律 RUN_RECORDED 且商业结论恒 OPEN；
 *       不能进管线的一律 QUARANTINE/NOT_RUN 且给出可解释的下一步。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { runValidationHarness, renderHarnessReport } from '../services/validation-run/harness';

const FIXTURES = path.resolve(process.cwd(), 'fixtures/synthetic');
const FIXED_NOW = () => new Date('2026-09-29T11:00:00Z');

function run(name: string) {
  return runValidationHarness({
    fileName: name,
    bytes: readFileSync(path.join(FIXTURES, name)),
    now: FIXED_NOW,
  });
}

describe('Phase A · 跨平台统一入口 smoke', () => {
  it('01 Shopify / Amazon / TikTok 结算样例 → 全部 RUN_RECORDED 且商业结论 OPEN', () => {
    for (const name of [
      'shopify-orders-sample.csv',
      'amazon-settlement-sample.csv',
      'tiktok-settlement-sample.csv',
    ]) {
      const report = run(name);
      expect(report.adapterStatus, name).toBe('PASS');
      expect(report.validationRunStatus, name).toBe('RUN_RECORDED');
      expect(report.commercialConclusion, name).toBe('OPEN');
      expect(report.verification, name).not.toBeNull();
    }
  });

  it('02 Walmart（PO Number 主键）→ 适配 QUARANTINE，管线不产出商业报告', () => {
    const report = run('walmart-settlement-sample.csv');
    expect(report.adapterStatus).toBe('QUARANTINE');
    expect(report.validationRunStatus).toBe('NOT_RUN');
    expect(report.verification).toBeNull();
    expect(report.nextSteps.join(' ')).toContain('adapter_quarantine_review');
  });

  it('03 报关单（7501）→ 适配 QUARANTINE（缺 canonical 必需列），下一步可解释', () => {
    const report = run('customs-7501-sample.csv');
    expect(report.adapterStatus).toBe('QUARANTINE');
    expect(report.validationRunStatus).toBe('NOT_RUN');
    expect(report.dataQuality.unknownColumns.length).toBeGreaterThan(0);
  });

  it('04 数据质量：进入管线的文件给出各规范列填充率与提示', () => {
    const report = run('amazon-settlement-sample.csv');
    expect(report.dataQuality.fillRateByColumn.orderId).toBe(100);
    expect(Object.keys(report.dataQuality.fillRateByColumn).length).toBeGreaterThan(10);
    expect(report.dataQuality.hints.map((hint) => hint.code)).toContain('CLAIM_OUTCOME_UNKNOWN');
  });

  it('05 平台识别只是猜测（未确认），并要求人工确认', () => {
    const report = run('shopify-orders-sample.csv');
    expect(report.platformConfirmed).toBe(false);
    expect(report.nextSteps.join(' ')).toContain('confirm_platform_guess');
  });

  it('06 渲染报告：三层状态 + 数据质量 + 商业评审骨架，且不含商业结论词', () => {
    const markdown = renderHarnessReport(run('tiktok-settlement-sample.csv'));
    expect(markdown).toContain('商业结论：OPEN');
    expect(markdown).toContain('## 数据质量');
    expect(markdown).toContain('## 商业评审骨架（人工填写）');
    expect(markdown).not.toMatch(/recoverable amount|应追回|应退/i);
  });

  it('07 同一文件重复执行 → 报告一致（除 generatedAt）', () => {
    const strip = (value: unknown) => JSON.stringify(value).replace(/"generatedAt":"[^"]+"/g, '');
    expect(strip(run('shopify-orders-sample.csv'))).toBe(strip(run('shopify-orders-sample.csv')));
  });
});
