/** SEO-3 公开 HTTP 边界单元验收：方法/类型/体积、可信代理 IP、有界并发、响应策略。 */

import { describe, expect, it } from 'vitest';

import {
  createSeoConcurrencyGate,
  deriveAnonymousKey,
  guardSeoHttpRequestShape,
  SEO_PUBLIC_HTTP_GUARD_BOUNDARY,
  SEO_PUBLIC_MAX_BODY_BYTES,
  SEO_PUBLIC_RESPONSE_POLICY,
} from '../services/seo/seo-public-http-guard';

const shape = (over: Partial<{ method: string; contentType: string | null; bodyByteLength: number }> = {}) =>
  guardSeoHttpRequestShape({ method: 'POST', contentType: 'application/json; charset=utf-8', bodyByteLength: 100, ...over });

describe('SEO-3 public HTTP boundary guard', () => {
  it('方法 / Content-Type / body 上限（解析前按字节判断）', () => {
    expect(shape()).toEqual({ ok: true });
    expect(shape({ method: 'GET' })).toEqual({ ok: false, code: 'METHOD_NOT_ALLOWED' });
    expect(shape({ method: 'PUT' })).toEqual({ ok: false, code: 'METHOD_NOT_ALLOWED' });
    expect(shape({ contentType: 'text/plain' })).toEqual({ ok: false, code: 'UNSUPPORTED_MEDIA_TYPE' });
    expect(shape({ contentType: null })).toEqual({ ok: false, code: 'UNSUPPORTED_MEDIA_TYPE' });
    expect(shape({ bodyByteLength: SEO_PUBLIC_MAX_BODY_BYTES + 1 })).toEqual({ ok: false, code: 'BODY_TOO_LARGE' });
    expect(shape({ bodyByteLength: SEO_PUBLIC_MAX_BODY_BYTES })).toEqual({ ok: true });
  });

  it('匿名键：只在可信代理下派生，否则 fail-closed（不信任可伪造头）', () => {
    const ok = deriveAnonymousKey({ trustedProxy: true, clientIp: '203.0.113.7', salt: 's1' });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.key).toMatch(/^[0-9a-f]{64}$/);
    expect(ok.key.includes('203.0.113.7')).toBe(false);

    expect(deriveAnonymousKey({ trustedProxy: false, clientIp: '203.0.113.7', salt: 's1' })).toEqual({
      ok: false,
      code: 'UNTRUSTED_CLIENT_IP',
    });
    expect(deriveAnonymousKey({ trustedProxy: true, clientIp: '', salt: 's1' })).toEqual({
      ok: false,
      code: 'UNTRUSTED_CLIENT_IP',
    });
  });

  it('有界并发：超出上限拒绝，release 后可再获取', () => {
    const gate = createSeoConcurrencyGate(2);
    expect(gate.tryAcquire()).toEqual({ ok: true });
    expect(gate.tryAcquire()).toEqual({ ok: true });
    expect(gate.tryAcquire()).toEqual({ ok: false, code: 'CONCURRENCY_EXCEEDED' });
    gate.release();
    expect(gate.tryAcquire()).toEqual({ ok: true });
    expect(gate.inFlight()).toBe(2);
  });

  it('响应策略：no-store、同源 CORS、不记录 raw body/IP/UA、2–3s 超时', () => {
    expect(SEO_PUBLIC_RESPONSE_POLICY.cacheControl).toBe('no-store');
    expect(SEO_PUBLIC_RESPONSE_POLICY.corsMode).toBe('SAME_ORIGIN_ONLY');
    expect(SEO_PUBLIC_RESPONSE_POLICY.logRawBody).toBe(false);
    expect(SEO_PUBLIC_RESPONSE_POLICY.logRawIp).toBe(false);
    expect(SEO_PUBLIC_RESPONSE_POLICY.logUserAgent).toBe(false);
    expect(SEO_PUBLIC_RESPONSE_POLICY.timeoutMs).toBeGreaterThanOrEqual(2000);
    expect(SEO_PUBLIC_RESPONSE_POLICY.timeoutMs).toBeLessThanOrEqual(3000);
  });

  it('边界自证：纯判断、不外写、不落库、不信任未受信代理的头', () => {
    expect(SEO_PUBLIC_HTTP_GUARD_BOUNDARY).toEqual({
      pureDecisionOnly: true,
      externalWritePerformed: false,
      databaseWritePerformed: false,
      trustsForwardedHeaderWhenProxyUntrusted: false,
      productionCredentials: 'ABSENT',
    });
  });
});
