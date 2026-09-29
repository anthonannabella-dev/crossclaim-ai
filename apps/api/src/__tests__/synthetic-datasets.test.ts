/**
 * Phase A — 平台级合成数据集断言（纯离线：不触库、不触网）
 * ---------------------------------------------------------------
 * 证明在缺真实导出文件时，各平台解析 / 归一化 / 参照数据路径依然可回归。
 * 纪律：合成数据不能替代真实数据验证（REAL-DATA-VALIDATION-BACKLOG RD-01..RD-07）。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { adaptUploadedFile } from '../services/validation-run/adapters';
import { adaptCarrierReferenceFile, adaptCustomsReferenceFile } from '../services/reference-data';

const FIXTURES = path.resolve(process.cwd(), 'fixtures/synthetic');
const FIXED_NOW = () => new Date('2026-09-29T10:00:00Z');

function bytes(name: string): Buffer {
  return readFileSync(path.join(FIXTURES, name));
}

function adaptExport(name: string) {
  return adaptUploadedFile({ fileName: name, bytes: bytes(name), now: FIXED_NOW });
}

describe('Phase A · 平台合成数据集', () => {
  it('01 Shopify 导出 → PASS，必需列 3/3，多单号只取第一个并记 ambiguity', () => {
    const { report } = adaptExport('shopify-orders-sample.csv');
    expect(report.status).toBe('PASS');
    expect(report.coverage.requiredMatched).toBe(report.coverage.requiredTotal);
    expect(report.adaptedRowCount).toBe(3);
    expect(report.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('02 Amazon / TikTok / Walmart 结算样例 → 均 PASS（别名命中）', () => {
    for (const name of ['amazon-settlement-sample.csv', 'tiktok-settlement-sample.csv']) {
      const { report } = adaptExport(name);
      expect(report.status, name).toBe('PASS');
      expect(report.adaptedRowCount, name).toBe(2);
    }

    // 已知差距（fixtures/synthetic/README.md 与 backlog RD-03）：Walmart 以 PO Number 为主键，
    // 适配器不把 PO 当订单号，因此 QUARANTINE 是正确行为；新增别名需真实文件确认，绝不猜测。
    const walmart = adaptExport('walmart-settlement-sample.csv');
    expect(walmart.report.status).toBe('QUARANTINE');
    expect(walmart.report.unknownColumns).toContain('PO Number');
  });

  it('03 物流账单样例 → 平台专有列只进未知列清单，不猜测', () => {
    const { report } = adaptExport('carrier-invoice-sample.csv');
    expect(report.unknownColumns.length).toBeGreaterThan(0);
    expect(report.status).toBe('PASS');
    expect(report.adaptedRowCount).toBe(2);
  });

  it('04 报关单样例（7501）→ QUARANTINE，且不丢行证据', () => {
    const { report, rows } = adaptExport('customs-7501-sample.csv');
    expect(report.status).toBe('QUARANTINE');
    expect(report.unknownColumns.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.rawRowHash.length === 64)).toBe(true);
  });

  it('05 承运商参照数据（燃油费率 / DAS 邮编）→ PASS 且识别正确类型', () => {
    const fuel = adaptCarrierReferenceFile({ fileName: 'carrier-fuel-rate-sample.csv', bytes: bytes('carrier-fuel-rate-sample.csv'), now: FIXED_NOW });
    const das = adaptCarrierReferenceFile({ fileName: 'carrier-das-zip-sample.csv', bytes: bytes('carrier-das-zip-sample.csv'), now: FIXED_NOW });
    expect(fuel.report.artifactType).toBe('CARRIER_FUEL_SURCHARGE');
    expect(das.report.artifactType).toBe('CARRIER_DAS_ZIP');
    expect(das.artifact?.entries[0].postalCode).toBe('01234');
  });

  it('06 关税参照数据（税率表 / 301 清单）→ PASS 且 HS 规范化', () => {
    const duty = adaptCustomsReferenceFile({ fileName: 'customs-duty-rate-sample.csv', bytes: bytes('customs-duty-rate-sample.csv'), now: FIXED_NOW });
    const list = adaptCustomsReferenceFile({ fileName: 'customs-301-exclusion-sample.csv', bytes: bytes('customs-301-exclusion-sample.csv'), now: FIXED_NOW });
    expect(duty.report.artifactType).toBe('CUSTOMS_DUTY_RATE');
    expect(list.report.artifactType).toBe('CUSTOMS_301_EXCLUSION');
    expect(duty.artifact?.entries[0].hsCode).toBe('85044095');
  });

  it('07 同一文件重复执行 → 报告指纹一致（可复现）', () => {
    const first = adaptExport('amazon-settlement-sample.csv');
    const second = adaptExport('amazon-settlement-sample.csv');
    expect(first.report.sourceSha256).toBe(second.report.sourceSha256);
    expect(first.rows.map((row) => row.rawRowHash)).toEqual(second.rows.map((row) => row.rawRowHash));
  });

  it('08 合成数据不得产出任何商业结论字段', () => {
    const { report } = adaptExport('shopify-orders-sample.csv');
    const serialized = JSON.stringify(report);
    expect(serialized).not.toMatch(/recoverable|owed|shouldRefund|claimAmount/i);
  });
});
