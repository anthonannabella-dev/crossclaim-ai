// MSG-20260929-36 验收（离线）：固定状态映射、异常角标、L3 白名单、泄露扫描。

import { describe, expect, it } from 'vitest';

import {
  IMPORT_BUCKETS,
  bucketForStatus,
  containsForbiddenKey,
  extractImportErrors,
  flagsFor,
} from '../services/operations/admin-imports';

describe('MSG-36 · D1 固定状态映射（不在 Admin 内新建状态机）', () => {
  it('01 ImportBatch.status → bucket 固定映射', () => {
    expect(bucketForStatus('PENDING', false)).toBe('in_progress');
    expect(bucketForStatus('PARSING', false)).toBe('in_progress');
    expect(bucketForStatus('IMPORTED', false)).toBe('succeeded');
    expect(bucketForStatus('IMPORTED', true)).toBe('retried_success');
    expect(bucketForStatus('PARTIAL', false)).toBe('partial');
    expect(bucketForStatus('FAILED', false)).toBe('failed');
  });

  it('02 未知状态 fail-closed 归入 failed（绝不静默当成功）', () => {
    expect(bucketForStatus('WAITING_REVIEW', false)).toBe('failed');
    expect(bucketForStatus('', false)).toBe('failed');
  });

  it('03 桶集合固定为五个（无新增工作流状态）', () => {
    expect([...IMPORT_BUCKETS]).toEqual(['in_progress', 'succeeded', 'retried_success', 'partial', 'failed']);
  });

  it('04 角标取代新状态：QUALITY_WARNING / RETRIED / UNKNOWN_STATUS', () => {
    expect(flagsFor({ status: 'PARTIAL', rowsFailed: 3, hasRetryEvent: false })).toEqual(['QUALITY_WARNING']);
    expect(flagsFor({ status: 'IMPORTED', rowsFailed: 0, hasRetryEvent: true })).toEqual(['RETRIED']);
    expect(flagsFor({ status: 'WEIRD', rowsFailed: 0, hasRetryEvent: false })).toEqual(['UNKNOWN_STATUS']);
    expect(flagsFor({ status: 'IMPORTED', rowsFailed: 0, hasRetryEvent: false })).toEqual([]);
  });
});

describe('MSG-36 · D2/D3 L3 白名单与零泄露', () => {
  it('05 只提取白名单字段，丢弃原始值与未知键', () => {
    const report = [
      {
        errorCode: 'MISSING_FIELD',
        rowNumber: 7,
        field: 'trackingNo',
        sourceColumnName: 'Tracking Number(s)',
        action: 'SKIPPED',
        rawRow: { trackingNo: '1Z999', customerName: 'ACME' },
        rawValue: '1Z999',
      },
    ];
    const entries = extractImportErrors(report);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      errorCode: 'MISSING_FIELD',
      rowNumber: 7,
      field: 'trackingNo',
      sourceColumnName: 'Tracking Number(s)',
      action: 'SKIPPED',
    });
    expect(containsForbiddenKey(entries)).toBeNull();
  });

  it('06 非数组/非法条目安全返回空或白名单空值', () => {
    expect(extractImportErrors(null)).toEqual([]);
    expect(extractImportErrors({ errorCode: 'X' })).toEqual([]);
    const entries = extractImportErrors([{ errorCode: 123, rowNumber: 'x', rawPayload: {} }]);
    expect(entries[0]).toEqual({ errorCode: null, rowNumber: null, field: null, sourceColumnName: null, action: null });
  });

  it('07 超长字符串被拒（防大对象注入）', () => {
    const entries = extractImportErrors([{ errorCode: 'X'.repeat(500), field: 'ok' }]);
    expect(entries[0]?.errorCode).toBeNull();
    expect(entries[0]?.field).toBe('ok');
  });

  it('08 泄露扫描能发现禁键（含嵌套）', () => {
    expect(containsForbiddenKey({ a: { b: [{ rawRow: {} }] } })).toBe('rawRow');
    expect(containsForbiddenKey({ amount: '1.00' })).toBe('amount');
    expect(containsForbiddenKey({ safe: { nested: ['ok'] } })).toBeNull();
  });

  it('09 金额/币种键一律视为禁键（D4：Admin 不展示金额）', () => {
    for (const key of ['amount', 'currency', 'unitPrice', 'orderValue']) {
      expect(containsForbiddenKey({ payload: { [key]: 'x' } }), key).toBe(key);
    }
  });
});
