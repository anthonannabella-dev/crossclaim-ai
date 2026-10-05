/** RSI Adapter 安全过滤验收：只回发现码、不回原文、fail-closed */

import { describe, expect, it } from 'vitest';

import {
  RSI_ADAPTER_SAFETY_BOUNDARY,
  RSI_SENSITIVE_KINDS,
  scanSensitiveData,
  scanSensitivePayload,
  sha256Hex,
} from '../services/autonomy/rsi-adapter-safety';

describe('RSI adapter safety filter', () => {
  it('RSI_ADAPTER_FILTER_CLEAN_TEXT_IS_CLEAN：普通文本不产生发现码', () => {
    const scan = scanSensitiveData('duty drawback eligibility summary for a commercial importer');
    expect(scan.clean).toBe(true);
    expect(scan.findings).toEqual([]);
  });

  it('RSI_ADAPTER_FILTER_DETECTS_SECRET：API key / 私钥头被识别为 SECRET', () => {
    expect(scanSensitiveData('token sk-ABCDEFGHIJKLMNOPQRSTUV').findings).toContain('SECRET');
    expect(scanSensitiveData('aws AKIAIOSFODNN7EXAMPLE used').findings).toContain('SECRET');
    expect(scanSensitiveData('-----BEGIN RSA PRIVATE KEY-----').findings).toContain('SECRET');
    expect(scanSensitiveData('api_key = "abcdef1234567890"').findings).toContain('SECRET');
  });

  it('RSI_ADAPTER_FILTER_DETECTS_PII：邮箱 / 电话 / 身份证号 / 银行卡分别成码', () => {
    expect(scanSensitiveData('contact ops@example.com now').findings).toContain('PII_EMAIL');
    expect(scanSensitiveData('call +1 415 555 2671 today').findings).toContain('PII_PHONE');
    expect(scanSensitiveData('ssn 123-45-6789 on file').findings).toContain('PII_GOV_ID');
    expect(scanSensitiveData('card 4111 1111 1111 1111').findings).toContain('PII_PAYMENT_CARD');
    expect(scanSensitiveData('claim_id: ABC123456789').findings).toContain('CUSTOMER_RECORD');
  });

  it('RSI_ADAPTER_FILTER_CARD_REQUIRES_LUHN：不通过 Luhn 的数字串不算银行卡', () => {
    const scan = scanSensitiveData('reference 1234 5678 9012 3456 only');
    expect(scan.findings).not.toContain('PII_PAYMENT_CARD');
  });

  it('RSI_ADAPTER_FILTER_MULTIPLE_FINDINGS_ARE_SORTED：多种发现码稳定排序', () => {
    const scan = scanSensitiveData('ops@example.com with api_key = "abcdef1234567890"');
    expect(scan.clean).toBe(false);
    expect(scan.findings).toEqual([...scan.findings].sort());
    expect(scan.findings).toContain('SECRET');
    expect(scan.findings).toContain('PII_EMAIL');
  });

  it('RSI_ADAPTER_FILTER_PAYLOAD_SCAN_IS_RECURSIVE：结构化载荷递归扫描', () => {
    const scan = scanSensitivePayload({ task: { notes: ['safe', 'reach me at ops@example.com'] } });
    expect(scan.clean).toBe(false);
    expect(scan.findings).toContain('PII_EMAIL');
    expect(scanSensitivePayload({ task: { notes: ['safe'] } }).clean).toBe(true);
  });

  it('RSI_ADAPTER_FILTER_DIGEST_HELPER_IS_STABLE：sha256 口径稳定（promptDigest/outputDigest 共用）', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('abc')).toHaveLength(64);
  });

  it('RSI_ADAPTER_FILTER_BOUNDARY：只回发现码、不回原文，且 fail-closed', () => {
    expect(RSI_ADAPTER_SAFETY_BOUNDARY.returnsFindingCodesOnly).toBe(true);
    expect(RSI_ADAPTER_SAFETY_BOUNDARY.returnsMatchedText).toBe(false);
    expect(RSI_ADAPTER_SAFETY_BOUNDARY.failClosed).toBe(true);
    expect(RSI_SENSITIVE_KINDS).toContain('CUSTOMER_RECORD');
  });
});
