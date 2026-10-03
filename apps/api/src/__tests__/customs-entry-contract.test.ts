/**
 * CUSTOMS GAP G4 / C1（MASTER GAP CLOSURE）— Customs Entry Data / Evidence Contract 回归。
 * 断言：fail-closed 原因码、十进制安全求和、多币种拒绝、PII / 凭据字段拒绝、只读事实边界、
 *       不推导 eligibility / recoverable amount、确定性、边界常量。
 */

import { describe, expect, it } from 'vitest';

import {
  CUSTOMS_DUTY_LINE_KINDS,
  CUSTOMS_ENTRY_CONTRACT_BOUNDARY,
  CUSTOMS_ENTRY_CONTRACT_REASONS,
  CUSTOMS_ENTRY_SOURCES,
  CustomsEntryContractError,
  normalizeCustomsEntryFact,
  sumDecimalStrings,
} from '../services/customs/customs-entry-contract';

function baseInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    entryNumber: 'abi-2026-000123',
    entryDate: '2026-09-18',
    jurisdiction: 'us',
    portOfEntry: 'Los Angeles, CA',
    importerOfRecordRef: 'ior_acct_88213',
    source: 'abi_vendor',
    rawReference: 'abi:entry:88213',
    observedAt: '2026-09-19T02:11:00.000Z',
    dutyLines: [
      { kind: 'duty', rawCode: 'DUTY-9901', amount: '1200.00', currency: 'USD' },
      { kind: 'TAX', rawCode: 'MPF', amount: '30.50', currency: 'USD' },
    ],
    ...overrides,
  };
}

function codeOf(input: unknown): string {
  try {
    normalizeCustomsEntryFact(input);
  } catch (error) {
    return error instanceof CustomsEntryContractError ? error.code : 'NOT_A_CONTRACT_ERROR';
  }
  return 'NO_ERROR';
}

describe('normalizeCustomsEntryFact', () => {
  it('合法输入 → 归一化为只读事实并按币种给出合计', () => {
    const fact = normalizeCustomsEntryFact(baseInput());

    expect(fact.entryNumber).toBe('ABI-2026-000123');
    expect(fact.jurisdiction).toBe('US');
    expect(fact.source).toBe('ABI_VENDOR');
    expect(fact.entryDate).toBe('2026-09-18');
    expect(fact.dutyLines).toHaveLength(2);
    expect(fact.dutyLines[0]).toEqual({ kind: 'DUTY', rawCode: 'DUTY-9901', amount: '1200.00', currency: 'USD' });
    expect(fact.totalDutyAmountByCurrency).toEqual({ USD: '1230.50' });

    expect(fact.readOnly).toBe(true);
    expect(fact.filingPerformed).toBe(false);
    expect(fact.paymentPerformed).toBe(false);
    expect(fact.productionCredentials).toBe('ABSENT');
    expect(fact).not.toHaveProperty('recoverableAmount');
    expect(fact).not.toHaveProperty('eligibility');
    expect(fact).not.toHaveProperty('claimPackage');
  });

  it('空 dutyLines → 合计为空映射（不伪造 0 金额行）', () => {
    const fact = normalizeCustomsEntryFact(baseInput({ dutyLines: [] }));
    expect(fact.dutyLines).toEqual([]);
    expect(fact.totalDutyAmountByCurrency).toEqual({});
  });

  it('entryNumber 形状非法 → INVALID_ENTRY_NUMBER', () => {
    expect(codeOf(baseInput({ entryNumber: 'AB' }))).toBe('INVALID_ENTRY_NUMBER');
    expect(codeOf(baseInput({ entryNumber: 'ENTRY 123' }))).toBe('INVALID_ENTRY_NUMBER');
  });

  it('entryDate / observedAt 非法 → INVALID_DATE（含不存在的日历日）', () => {
    expect(codeOf(baseInput({ entryDate: '2026-02-30' }))).toBe('INVALID_DATE');
    expect(codeOf(baseInput({ entryDate: '09/18/2026' }))).toBe('INVALID_DATE');
    expect(codeOf(baseInput({ observedAt: '2026-09-19' }))).toBe('INVALID_DATE');
  });

  it('货币非 3 位大写 → INVALID_CURRENCY', () => {
    expect(codeOf(baseInput({ dutyLines: [{ kind: 'DUTY', rawCode: 'X', amount: '1.00', currency: 'usd' }] }))).toBe('INVALID_CURRENCY');
    expect(codeOf(baseInput({ dutyLines: [{ kind: 'DUTY', rawCode: 'X', amount: '1.00', currency: 'US' }] }))).toBe('INVALID_CURRENCY');
  });

  it('金额非十进制字符串 → INVALID_AMOUNT', () => {
    for (const amount of ['', '1e3', 'NaN', '1.2.3', '1.1234567', 'abc']) {
      expect(codeOf(baseInput({ dutyLines: [{ kind: 'DUTY', rawCode: 'X', amount, currency: 'USD' }] }))).toBe('INVALID_AMOUNT');
    }
  });

  it('多币种 duty line → MIXED_CURRENCY_DUTY_LINES（不跨币种相加）', () => {
    const input = baseInput({
      dutyLines: [
        { kind: 'DUTY', rawCode: 'DUTY-9901', amount: '100.00', currency: 'USD' },
        { kind: 'DUTY', rawCode: 'DUTY-9902', amount: '100.00', currency: 'CAD' },
      ],
    });
    expect(codeOf(input)).toBe('MIXED_CURRENCY_DUTY_LINES');
  });

  it('未知 duty line kind → UNKNOWN_DUTY_LINE_KIND', () => {
    expect(codeOf(baseInput({ dutyLines: [{ kind: 'EXCISE', rawCode: 'EX-1', amount: '5.00', currency: 'USD' }] }))).toBe(
      'UNKNOWN_DUTY_LINE_KIND',
    );
  });

  it('未知 source → UNKNOWN_SOURCE', () => {
    expect(codeOf(baseInput({ source: 'CARRIER_FEED' }))).toBe('UNKNOWN_SOURCE');
    expect(codeOf(baseInput({ source: 42 }))).toBe('UNKNOWN_SOURCE');
  });

  it('PII / 凭据字段（顶层与嵌套）→ RAW_PII_NOT_ALLOWED', () => {
    expect(codeOf(baseInput({ importerName: 'ACME Importers LLC' }))).toBe('RAW_PII_NOT_ALLOWED');
    expect(codeOf(baseInput({ consigneeName: 'Jane Doe' }))).toBe('RAW_PII_NOT_ALLOWED');
    expect(codeOf(baseInput({ contactEmail: 'ops@example.com' }))).toBe('RAW_PII_NOT_ALLOWED');
    expect(codeOf(baseInput({ accessToken: 'redacted' }))).toBe('RAW_PII_NOT_ALLOWED');
    expect(codeOf(baseInput({ credentialSecret: 'redacted' }))).toBe('RAW_PII_NOT_ALLOWED');
    expect(codeOf(baseInput({ rawPayload: { anything: true } }))).toBe('RAW_PII_NOT_ALLOWED');
    expect(
      codeOf(baseInput({ dutyLines: [{ kind: 'DUTY', rawCode: 'X', amount: '1.00', currency: 'USD', contactPhone: '+1-000' }] })),
    ).toBe('RAW_PII_NOT_ALLOWED');
  });

  it('safe reference 含空格 / 自由文本 → INVALID_REQUEST（PII 不得进入引用字段）', () => {
    expect(codeOf(baseInput({ importerOfRecordRef: 'ACME Importers LLC' }))).toBe('INVALID_REQUEST');
    expect(codeOf(baseInput({ rawReference: 'broker email: a@b.com' }))).toBe('INVALID_REQUEST');
  });

  it('顶层形状非法 → INVALID_REQUEST', () => {
    expect(codeOf(null)).toBe('INVALID_REQUEST');
    expect(codeOf([])).toBe('INVALID_REQUEST');
    expect(codeOf('entry')).toBe('INVALID_REQUEST');
    expect(codeOf(baseInput({ dutyLines: 'none' }))).toBe('INVALID_REQUEST');
    expect(codeOf(baseInput({ portOfEntry: '' }))).toBe('INVALID_REQUEST');
  });
});

describe('sumDecimalStrings', () => {
  it('BigInt 精确求和，输出最少 2 位小数', () => {
    expect(sumDecimalStrings(['1200.00', '30.50'])).toBe('1230.50');
    expect(sumDecimalStrings(['0.10', '0.20'])).toBe('0.30');
    expect(sumDecimalStrings(['999999999.99', '0.01'])).toBe('1000000000.00');
    expect(sumDecimalStrings(['0.123456', '0.000001'])).toBe('0.123457');
    expect(sumDecimalStrings(['-10.00', '4.50'])).toBe('-5.50');
    expect(sumDecimalStrings([])).toBe('0.00');
  });

  it('非十进制输入 → INVALID_AMOUNT', () => {
    expect(() => sumDecimalStrings(['1.00', 'x'])).toThrowError(CustomsEntryContractError);
  });
});

describe('contract boundary', () => {
  it('确定性：同一输入两次归一化结果完全一致', () => {
    const first = normalizeCustomsEntryFact(baseInput());
    const second = normalizeCustomsEntryFact(baseInput());
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('边界常量：只读 / 不 filing / 不 payment / 无 FX / 不推导金额', () => {
    expect(CUSTOMS_ENTRY_CONTRACT_BOUNDARY.readOnly).toBe(true);
    expect(CUSTOMS_ENTRY_CONTRACT_BOUNDARY.filingPerformed).toBe(false);
    expect(CUSTOMS_ENTRY_CONTRACT_BOUNDARY.paymentPerformed).toBe(false);
    expect(CUSTOMS_ENTRY_CONTRACT_BOUNDARY.productionCredentials).toBe('ABSENT');
    expect(CUSTOMS_ENTRY_CONTRACT_BOUNDARY.transportEnabled).toBe(false);
    expect(CUSTOMS_ENTRY_CONTRACT_BOUNDARY.appliesFxConversion).toBe(false);
    expect(CUSTOMS_ENTRY_CONTRACT_BOUNDARY.derivesEligibility).toBe(false);
    expect(CUSTOMS_ENTRY_CONTRACT_BOUNDARY.derivesRecoverableAmount).toBe(false);
    expect(CUSTOMS_ENTRY_CONTRACT_BOUNDARY.buildsClaimPackage).toBe(false);
    expect(CUSTOMS_ENTRY_CONTRACT_BOUNDARY.performsFiling).toBe(false);
    expect(CUSTOMS_ENTRY_CONTRACT_BOUNDARY.performsPayment).toBe(false);
    expect(CUSTOMS_ENTRY_CONTRACT_REASONS).toHaveLength(9);
    expect(CUSTOMS_ENTRY_SOURCES).toContain('ABI_VENDOR');
    expect(CUSTOMS_DUTY_LINE_KINDS).toContain('INTEREST');
  });
});
