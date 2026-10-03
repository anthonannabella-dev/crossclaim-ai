/**
 * MSG-20261001-22 CHANGE B 验收：响应必须显式 platformWriteExecuted=false，
 * 且不得泄露 provider success 类字段。
 */

import { describe, expect, it } from 'vitest';

import {
  PLATFORM_WRITE_PROVIDER_SUCCESS_FIELDS,
  PLATFORM_WRITE_RESPONSE_FIELDS,
  assertNoProviderSuccessFields,
  buildPlatformWriteResponse,
} from '../services/platform-write';

describe('MSG-20261001-22 · platform.write HTTP 响应契约', () => {
  it('01 NEEDS_MANUAL 结果 → platformWriteExecuted=false / executionDisposition=NEEDS_MANUAL', () => {
    const body = buildPlatformWriteResponse({ status: 'NEEDS_MANUAL', attemptId: null });
    expect(body.platformWriteExecuted).toBe(false);
    expect(body.executionDisposition).toBe('NEEDS_MANUAL');
    expect(Object.keys(body).every((key) => PLATFORM_WRITE_RESPONSE_FIELDS.includes(key))).toBe(true);
  });

  it('02 provider 成功类字段一律不进入响应（providerRef/sinkCalls 被丢弃）', () => {
    const body = buildPlatformWriteResponse({
      status: 'SUCCEEDED',
      attemptId: 'attempt-1',
      providerRef: 'SIM-0001',
      sinkCalls: 1,
    });
    const keys = Object.keys(body);
    for (const banned of PLATFORM_WRITE_PROVIDER_SUCCESS_FIELDS) {
      expect(keys).not.toContain(banned);
    }
    expect(body.platformWriteExecuted).toBe(false);
    expect(assertNoProviderSuccessFields(body as unknown as Record<string, unknown>)).toBeUndefined();
  });

  it('03 transport 已开启时响应契约未定义 → 直接拒绝（需架构方另行裁决）', () => {
    expect(() =>
      buildPlatformWriteResponse({ status: 'SUCCEEDED', attemptId: 'attempt-2' }, { transportEnabled: true }),
    ).toThrowError(/RESPONSE_CONTRACT_NOT_DEFINED_FOR_ENABLED_TRANSPORT/);
  });

  it('04 泄漏检测：出现 providerRef/externalRef 等字段即拒绝', () => {
    expect(() => assertNoProviderSuccessFields({ status: 'NEEDS_MANUAL', providerRef: 'SIM-1' })).toThrowError(
      /PROVIDER_SUCCESS_FIELD_LEAKED: providerRef/,
    );
    expect(() => assertNoProviderSuccessFields({ externalRef: 'X' })).toThrowError(/externalRef/);
  });

  it('05 各状态透传但真实执行恒为 false（REPLAYED / BLOCKED / FAILED 同口径）', () => {
    for (const status of ['REPLAYED', 'BLOCKED', 'FAILED', 'RETRYABLE', 'UNKNOWN_PROVIDER_RESPONSE'] as const) {
      const body = buildPlatformWriteResponse({ status, attemptId: 'a-1', code: 'SOME_CODE' });
      expect(body.status).toBe(status);
      expect(body.platformWriteExecuted).toBe(false);
      expect(body.executionDisposition).toBe('NEEDS_MANUAL');
    }
  });
});
