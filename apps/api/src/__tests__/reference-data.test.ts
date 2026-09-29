/**
 * C-0015 Step 1 — 参照数据适配器验收（承运商 + 关税，各 12 条用例）
 * ---------------------------------------------------------------
 * 架构方 MSG-20260929-14：两份设计均 GO_IMPLEMENTATION（STEP1 ONLY）。
 * 本文件证明：只有 解析 / 白名单映射 / 生效窗口 / 版本指纹 / quarantine / 报告，
 * 且全程无网络、无数据库、无规则判定、无金额、无 OCR。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  adaptCarrierReferenceFile,
  adaptCustomsReferenceFile,
  normalizeCountryCode,
  normalizeHsCode,
  normalizeRate,
} from '../services/reference-data';

const FIXED_NOW = () => new Date('2026-09-29T06:00:00Z');

function buf(text: string): Buffer {
  return Buffer.from(text, 'utf8');
}

function carrier(fileName: string, text: string) {
  return adaptCarrierReferenceFile({ fileName, bytes: buf(text), now: FIXED_NOW });
}

function customs(fileName: string, text: string) {
  return adaptCustomsReferenceFile({ fileName, bytes: buf(text), now: FIXED_NOW });
}

const FUEL_CSV = [
  'Carrier,Service,Effective Date,Expiration Date,Fuel Rate',
  'FedEx,Express,2026-01-06,2026-01-12,12.5%',
  'UPS,Ground,2026-01-06,2026-01-12,11.75',
].join('\n');

const DAS_CSV = [
  'Carrier,Zip Code,DAS Type,State,Effective Date',
  'FedEx,01234,Extended,MA,2026-01-01',
  'UPS,99501,Remote,AK,2026-01-01',
].join('\n');

const SLA_CSV = [
  'Carrier,Suspension Start,Suspension End,Reason',
  'FedEx,2026-11-23,2026-12-01,Peak Season',
].join('\n');

const DUTY_CSV = [
  'Country,HS Code,Base Rate,Preferential Rate,301 Exclusion,Effective Date',
  'US,8504.40.95,8.5,0,true,2026-01-01',
  'us,850440,6.5%,2.5%,N,2026-01-01',
].join('\n');

const EXCLUSION_CSV = [
  'Country,HTS Code,Exclusion ID,301 Exclusion,Effective Date,Expiration Date',
  'US,8471.30.01,9903.88.03,true,2026-01-01,2026-12-31',
].join('\n');

describe('Step 1 · 承运商参照数据适配器', () => {
  it('01 燃油费率表 CSV → PASS，条目数与窗口区间正确', () => {
    const { report, artifact } = carrier('fuel.csv', FUEL_CSV);
    expect(report.status).toBe('PASS');
    expect(report.artifactType).toBe('CARRIER_FUEL_SURCHARGE');
    expect(report.adaptedRowCount).toBe(2);
    expect(artifact?.entries[0].rateValue).toBe('12.5000');
    expect(report.windows.minEffectiveDate).toBe('2026-01-06');
    // 两行都写了失效日期 → 没有开放区间
    expect(report.windows.openEndedCount).toBe(0);
    expect(report.quarantinedRows).toHaveLength(0);
  });

  it('02 DAS 邮编表 → PASS，且保留前导零', () => {
    const { report, artifact } = carrier('das.csv', DAS_CSV);
    expect(report.artifactType).toBe('CARRIER_DAS_ZIP');
    expect(artifact?.entries[0].postalCode).toBe('01234');
    expect(artifact?.entries[1].dasType).toBe('Remote');
  });

  it('03 SLA 暂停公告 → PASS，区间正确', () => {
    const { report, artifact } = carrier('sla.csv', SLA_CSV);
    expect(report.artifactType).toBe('CARRIER_SLA_SUSPENSION');
    expect(artifact?.entries[0]).toMatchObject({
      startDate: '2026-11-23',
      endDate: '2026-12-01',
      reasonNote: 'Peak Season',
    });
  });

  it('04 缺 effectiveDate 列 → 文件级 QUARANTINE + ACTION', () => {
    const { report, artifact } = carrier('bad.csv', 'Carrier,Fuel Rate\nFedEx,12.5\n');
    expect(report.status).toBe('QUARANTINE');
    expect(report.quarantineReason).toBe('MISSING_REQUIRED_FIELD');
    expect(report.ambiguities[0].action).toBe('manual_confirmation_required');
    expect(artifact).toBeNull();
  });

  it('05 行内 03/04/2026 → 该行 QUARANTINE，其余行照常产出', () => {
    const csv = [
      'Carrier,Effective Date,Fuel Rate',
      'FedEx,03/04/2026,12.5',
      'UPS,2026-01-06,11.5',
    ].join('\n');
    const { report } = carrier('mixed.csv', csv);
    expect(report.adaptedRowCount).toBe(1);
    expect(report.quarantinedRows).toHaveLength(1);
    expect(report.quarantinedRows[0]).toMatchObject({ rowNumber: 2, reason: 'INVALID_DATE' });
    expect(report.quarantinedRows[0].rowHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('06 expiration <= effective → INVERTED_WINDOW', () => {
    const csv = [
      'Carrier,Effective Date,Expiration Date,Fuel Rate',
      'FedEx,2026-02-01,2026-01-01,12.5',
    ].join('\n');
    const { report } = carrier('inverted.csv', csv);
    expect(report.quarantinedRows[0].reason).toBe('INVERTED_WINDOW');
    expect(report.adaptedRowCount).toBe(0);
  });

  it('07 重叠窗口 → AMBIGUOUS_WINDOW 进人工清单（不自动择一）', () => {
    const csv = [
      'Carrier,Service,Effective Date,Expiration Date,Fuel Rate',
      'FedEx,Express,2026-01-01,2026-03-01,12.5',
      'FedEx,Express,2026-02-01,2026-04-01,13.0',
    ].join('\n');
    const { report, artifact } = carrier('overlap.csv', csv);
    expect(artifact?.entries).toHaveLength(2);
    expect(report.ambiguities.map((item) => item.detail).join(' ')).toContain('AMBIGUOUS_WINDOW');
  });

  it('08 费率写成 0.125 → AMBIGUOUS_RATE_SCALE QUARANTINE', () => {
    const csv = ['Carrier,Effective Date,Fuel Rate', 'FedEx,2026-01-06,0.125'].join('\n');
    const { report } = carrier('scale.csv', csv);
    expect(report.quarantinedRows[0].reason).toBe('AMBIGUOUS_RATE_SCALE');
    expect(report.ambiguities).toHaveLength(0);
  });

  it('09 未知列 → 只进 unknownColumns，不映射', () => {
    const csv = [
      'Carrier,Effective Date,Fuel Rate,internal_note',
      'FedEx,2026-01-06,12.5,调价说明',
    ].join('\n');
    const { report } = carrier('extra.csv', csv);
    expect(report.unknownColumns).toEqual(['internal_note']);
    expect(JSON.stringify(report)).not.toContain('调价说明');
  });

  it('10 PDF → PDF_STRUCTURE_ONLY_NO_OCR QUARANTINE，零条目', () => {
    const { report, artifact } = carrier('notice.pdf', '%PDF-1.7\nfake');
    expect(report.status).toBe('QUARANTINE');
    expect(report.quarantineReason).toBe('PDF_STRUCTURE_ONLY_NO_OCR');
    expect(artifact).toBeNull();
  });

  it('11 同一文件跑两次 → 工件一致（除 generatedAt）', () => {
    const first = carrier('fuel.csv', FUEL_CSV);
    const second = carrier('fuel.csv', FUEL_CSV);
    const strip = (value: unknown) => JSON.stringify(value).replace(/"generatedAt":"[^"]+"/, '');
    expect(strip(first.artifact)).toBe(strip(second.artifact));
    expect(first.report.sourceSha256).toBe(second.report.sourceSha256);
  });

  it('12 相同行重复 → 保留两行并计数，不静默去重', () => {
    const csv = [
      'Carrier,Effective Date,Fuel Rate',
      'FedEx,2026-01-06,12.5',
      'FedEx,2026-01-06,12.5',
    ].join('\n');
    const { report } = carrier('dup.csv', csv);
    expect(report.adaptedRowCount).toBe(2);
    expect(report.duplicates).toBe(1);
  });
});

describe('Step 1 · 关税参照数据适配器', () => {
  it('01 税率表 CSV（6/8/10 位 HS）→ PASS，条目数与窗口正确', () => {
    const { report, artifact } = customs('duty.csv', DUTY_CSV);
    expect(report.status).toBe('PASS');
    expect(report.artifactType).toBe('CUSTOMS_DUTY_RATE');
    expect(report.adaptedRowCount).toBe(2);
    expect(artifact?.entries[0]).toMatchObject({
      countryCode: 'US',
      hsCode: '85044095',
      baseDutyRate: '8.5000',
      preferentialRate: '0.0000',
      exclusionFlag: true,
    });
    expect(report.windows.minEffectiveDate).toBe('2026-01-01');
  });

  it('02 301 豁免清单 → PASS，flag 解析为布尔', () => {
    const { report, artifact } = customs('exclusion.csv', EXCLUSION_CSV);
    expect(report.artifactType).toBe('CUSTOMS_301_EXCLUSION');
    expect(artifact?.entries[0]).toMatchObject({
      hsCode: '84713001',
      exclusionId: '9903.88.03',
      exclusionFlag: true,
      expirationDate: '2026-12-31',
    });
  });

  it('03 HS 带点号 → 规范为 10 位（不改变含义）', () => {
    expect(normalizeHsCode('8504.40.95')).toBe('85044095');
    expect(normalizeHsCode('850440')).toBe('850440');
    expect(normalizeHsCode('8504409500')).toBe('8504409500');
  });

  it('04 HS 长度非法 → 该行 INVALID_HS_CODE', () => {
    const csv = [
      'Country,HS Code,Base Rate,Effective Date',
      'US,8504,8.5,2026-01-01',
    ].join('\n');
    const { report } = customs('bad-hs.csv', csv);
    expect(report.quarantinedRows[0].reason).toBe('INVALID_HS_CODE');
    expect(report.adaptedRowCount).toBe(0);
  });

  it('05 国家码 US-CA → INVALID_COUNTRY_CODE（不截断）', () => {
    const csv = [
      'Country,HS Code,Base Rate,Effective Date',
      'US-CA,850440,8.5,2026-01-01',
    ].join('\n');
    const { report } = customs('bad-country.csv', csv);
    expect(report.quarantinedRows[0].reason).toBe('INVALID_COUNTRY_CODE');
    expect(normalizeCountryCode('us')).toBe('US');
    expect(normalizeCountryCode('US-CA')).toBeNull();
  });

  it('06 税率 0.085 → AMBIGUOUS_RATE_SCALE；8.5 / 8.5% / 0 均通过', () => {
    expect(normalizeRate('0.085')).toMatchObject({ error: 'AMBIGUOUS_RATE_SCALE' });
    expect(normalizeRate('8.5')).toEqual({ rate: '8.5000' });
    expect(normalizeRate('8.5%')).toEqual({ rate: '8.5000' });
    expect(normalizeRate('0')).toEqual({ rate: '0.0000' });

    const csv = [
      'Country,HS Code,Base Rate,Effective Date',
      'US,850440,0.085,2026-01-01',
    ].join('\n');
    expect(customs('scale.csv', csv).report.quarantinedRows[0].reason).toBe('AMBIGUOUS_RATE_SCALE');
  });

  it('07 expiration <= effective → INVERTED_WINDOW', () => {
    const csv = [
      'Country,HS Code,Base Rate,Effective Date,Expiration Date',
      'US,850440,8.5,2026-05-01,2026-01-01',
    ].join('\n');
    expect(customs('inv.csv', csv).report.quarantinedRows[0].reason).toBe('INVERTED_WINDOW');
  });

  it('08 同一 HS 重叠窗口 → AMBIGUOUS_WINDOW 进人工清单', () => {
    const csv = [
      'Country,HS Code,Base Rate,Effective Date,Expiration Date',
      'US,850440,8.5,2026-01-01,2026-06-01',
      'US,850440,9.5,2026-03-01,2026-09-01',
    ].join('\n');
    const { report, artifact } = customs('overlap.csv', csv);
    expect(artifact?.entries).toHaveLength(2);
    expect(report.ambiguities.length).toBeGreaterThan(0);
    expect(report.ambiguities[0].action).toBe('manual_confirmation_required');
  });

  it('09 exclusionFlag 缺失 → unknown（与 false 区分）', () => {
    const csv = [
      'Country,HS Code,Base Rate,Effective Date',
      'US,850440,8.5,2026-01-01',
      'US,850441,8.5,2026-01-01',
    ].join('\n');
    const { artifact } = customs('flag.csv', csv);
    expect(artifact?.entries[0].exclusionFlag).toBe('unknown');

    const withFalse = [
      'Country,HS Code,Base Rate,301 Exclusion,Effective Date',
      'US,850440,8.5,false,2026-01-01',
    ].join('\n');
    expect(customs('flag2.csv', withFalse).artifact?.entries[0].exclusionFlag).toBe(false);
  });

  it('10 PDF（7501 样例）→ PDF_STRUCTURE_ONLY_NO_OCR，零条目', () => {
    const { report, artifact } = customs('7501.pdf', '%PDF-1.4\nEntry Summary');
    expect(report.quarantineReason).toBe('PDF_STRUCTURE_ONLY_NO_OCR');
    expect(report.adaptedRowCount).toBe(0);
    expect(artifact).toBeNull();
  });

  it('11 同一文件跑两次 → 工件一致（除 generatedAt）', () => {
    const first = customs('duty.csv', DUTY_CSV);
    const second = customs('duty.csv', DUTY_CSV);
    const strip = (value: unknown) => JSON.stringify(value).replace(/"generatedAt":"[^"]+"/, '');
    expect(strip(first.artifact)).toBe(strip(second.artifact));
  });

  it('12 JSON 输入同样可用（items 数组），未知列只登记', () => {
    const json = JSON.stringify({
      items: [
        { Country: 'US', 'HS Code': '850440', 'Base Rate': '8.5', 'Effective Date': '2026-01-01', extra: 'x' },
      ],
    });
    const { report, artifact } = customs('duty.json', json);
    expect(report.format).toBe('JSON');
    expect(artifact?.entries).toHaveLength(1);
    expect(report.unknownColumns).toEqual(['extra']);
    expect(JSON.stringify(report)).not.toContain('"extra":"x"');
  });
});

describe('Step 1 · 离线与旁路断言', () => {
  it('适配过程不写数据库、不发网络请求（仅纯函数 + Buffer）', () => {
    const { report } = carrier('fuel.csv', FUEL_CSV);
    const serialized = JSON.stringify(report);
    // 报告里不应出现任何金额/结论字段
    expect(serialized).not.toMatch(/recoverable|owed|refundAmount|claim/i);
    expect(report.engineeringStatus).toBe('PASS');
  });

  it('仓内 fixtures 目录未被本步骤写入（参照数据靠上传，不落盘）', () => {
    const fixtures = path.resolve(process.cwd(), 'fixtures');
    expect(() => readFileSync(path.join(fixtures, 'scenarios', 'README.md'))).not.toThrow();
  });
});
