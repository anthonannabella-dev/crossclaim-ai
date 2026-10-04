/** SEO-3 handler 组合层验收：顺序（形状→限流→并发→引擎）、状态码与响应头。 */

import { describe, expect, it } from 'vitest';

import { handlePublicSeoRequest, SEO_PUBLIC_HANDLER_BOUNDARY } from '../services/seo/seo-public-handler';
import { createInMemorySeoPublicRateLimiter } from '../services/seo/seo-rate-limit';
import {
  createSeoConcurrencyGate,
  type SeoConcurrencyGate,
} from '../services/seo/seo-public-http-guard';
import type { SeoPublicCheckerPorts } from '../services/seo/seo-public-checker';
import type { RecoveryRuleDefinition } from '../services/recovery-rules/recovery-rule-definition';

const NOW = new Date('2026-10-04T06:00:00.000Z');
const rule = (): RecoveryRuleDefinition => ({
  definitionVersion: 'v1',
  platform: 'CUSTOMS',
  category: 'customs',
  recoveryType: 'drawback',
  jurisdictionScope: 'COUNTRY',
  jurisdictionCodes: ['US'],
  region: null,
  title: 't',
  slug: 'us-customs-drawback',
  problemDescription: 'p',
  eligibility: {
    requiresIorIdentity: true,
    requiresAuthorizedSigner: false,
    requiresBrokerPoa: true,
    requiresFilingAuthorization: true,
    minimumEvidenceCount: 2,
  },
  eligibilityMethod: { kind: 'DECISION_TABLE', basisKey: 'engine:customs-drawback-eligibility' },
  requiredEvidence: ['evidence:a', 'evidence:b'],
  calculationMethod: { kind: 'DUTY_DIFFERENCE', basisKey: 'engine:customs-duty-difference' },
  filingDeadline: { kind: 'STATUTORY', days: 90, sourceReferenceId: 'src:cfr-1900' },
  submissionMode: 'BROKER_FILED',
  feeModel: 'SUCCESS_FEE',
  supportedMode: 'ASSISTED',
  relatedRuleRefs: ['rule:customs-protest'],
  sourceReferences: [{ id: 'src:cfr-1900', label: '19 CFR 190' }],
  capabilities: { checker: true, calculator: true },
  ctaMode: 'FREE_AUDIT_THEN_START',
  ruleVersion: '2026.10.1',
  effectiveFrom: '2026-10-01T00:00:00.000Z',
  effectiveTo: null,
});

const ports = (): SeoPublicCheckerPorts => ({
  resolveActiveRule: async () => rule(),
  listRegisteredBasisKeys: async () => ['engine:customs-drawback-eligibility', 'engine:customs-duty-difference'],
  getPublicInputSchema: async () => ({ fields: { reexported: { kind: 'boolean' } }, allowEmpty: true }),
  runEligibility: async () => ({ eligible: true, reasonCodes: [] }),
  runCalculation: async ({ basisKey }) => ({
    estimate: { min: 100, max: 200, currency: 'USD' },
    basisKey,
    disclaimerKey: 'seo.disclaimer.estimateOnly',
  }),
  now: () => NOW,
});

const deps = () => ({
  ports: ports(),
  rateLimiter: createInMemorySeoPublicRateLimiter({ capacity: 2, refillPerMinute: 60, now: () => NOW }),
  anonymousSalt: 'salt-1',
  // MSG-20261005-04 CHANGE D：闸门必传（组合根应传进程级 singleton）。
  concurrencyGate: createSeoConcurrencyGate(8),
});

const base = (over: Partial<Parameters<typeof handlePublicSeoRequest>[0]> = {}) => ({
  method: 'POST',
  contentType: 'application/json',
  bodyByteLength: 50,
  parsedBody: { slug: 'us-customs-drawback', answers: { reexported: true } },
  trustedProxy: true,
  clientIp: '203.0.113.7',
  ...over,
});

describe('SEO-3 public handler composition', () => {
  it('正常路径：200 + ESTIMATE_ONLY + no-store 头', async () => {
    const res = await handlePublicSeoRequest(base(), deps());
    expect(res.status).toBe(200);
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect((res.body as { estimateLabel?: string }).estimateLabel).toBe('ESTIMATE_ONLY');
  });

  it('形状先于一切：GET→405、text/plain→415、超体积→413', async () => {
    expect((await handlePublicSeoRequest(base({ method: 'GET' }), deps())).status).toBe(405);
    expect((await handlePublicSeoRequest(base({ contentType: 'text/plain' }), deps())).status).toBe(415);
    expect((await handlePublicSeoRequest(base({ bodyByteLength: 9000 }), deps())).status).toBe(413);
  });

  it('不可信代理 → 400（不派生限流键，也不进入引擎）', async () => {
    const res = await handlePublicSeoRequest(base({ trustedProxy: false }), deps());
    expect(res.status).toBe(400);
    expect((res.body as { code: string }).code).toBe('UNTRUSTED_CLIENT_IP');
  });

  it('限流先于引擎：容量用尽 → 429', async () => {
    const d = deps();
    expect((await handlePublicSeoRequest(base(), d)).status).toBe(200);
    expect((await handlePublicSeoRequest(base(), d)).status).toBe(200);
    const third = await handlePublicSeoRequest(base(), d);
    expect(third.status).toBe(429);
    expect((third.body as { code: string }).code).toBe('RATE_LIMITED');
  });

  it('未知 answer key → 400（CHANGE A 在 handler 组合下仍生效）', async () => {
    const res = await handlePublicSeoRequest(
      base({ parsedBody: { slug: 'us-customs-drawback', answers: { reexported: true, phone: 'x' } } }),
      deps(),
    );
    expect(res.status).toBe(400);
    expect((res.body as { code: string }).code).toBe('INVALID_REQUEST');
  });

  it('边界自证：未注册路由，且限流先于引擎调用', () => {
    expect(SEO_PUBLIC_HANDLER_BOUNDARY.routeRegistered).toBe(false);
    expect(SEO_PUBLIC_HANDLER_BOUNDARY.rateLimitBeforeEngineCall).toBe(true);
    expect(SEO_PUBLIC_HANDLER_BOUNDARY.tenantDataIncluded).toBe(false);
  });

  it('有界并发：闸门饱和 → 503；请求结束后必定释放槽位', async () => {
    const { createSeoConcurrencyGate } = await import('../services/seo/seo-public-http-guard');
    const gate = createSeoConcurrencyGate(1);
    const d = { ...deps(), concurrencyGate: gate };

    // 先占满唯一槽位（模拟一个还在处理中的请求）。
    expect(gate.tryAcquire()).toEqual({ ok: true });
    const saturated = await handlePublicSeoRequest(base(), d);
    expect(saturated.status).toBe(503);
    expect((saturated.body as { code: string }).code).toBe('CONCURRENCY_EXCEEDED');

    // 释放后可以正常处理，并且处理结束会把槽位还回去。
    gate.release();
    expect((await handlePublicSeoRequest(base(), d)).status).toBe(200);
    expect(gate.inFlight()).toBe(0);
  });
});

describe('SEO-3 runtime 防护（MSG-20261005-04 CHANGE C/D/E）', () => {
  it('CHANGE_C：engine 超时 → 504 ENGINE_TIMEOUT，且槽位保留到引擎真正结束才释放', async () => {
    const gate = createSeoConcurrencyGate(1);
    const slowPorts = {
      ...ports(),
      resolveActiveRule: async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return rule();
      },
    };
    const slowDeps = { ...deps(), ports: slowPorts, concurrencyGate: gate, timeoutMs: 5 };
    const res = await handlePublicSeoRequest(base(), slowDeps);
    expect(res.status).toBe(504);
    expect((res.body as { code: string }).code).toBe('ENGINE_TIMEOUT');
    // 慢任务仍在跑：槽位不能被提前释放，否则并发上限会被突破。
    expect(gate.inFlight()).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(gate.inFlight()).toBe(0);
  });

  it('CHANGE_D-1：闸门缺失 → fail-closed 503（不允许每请求自建计数器）', async () => {
    const missing = {
      ...deps(),
      concurrencyGate: undefined as unknown as SeoConcurrencyGate,
    };
    const res = await handlePublicSeoRequest(base(), missing);
    expect(res.status).toBe(503);
    expect((res.body as { code: string }).code).toBe('CONCURRENCY_GATE_MISSING');
  });

  it('CHANGE_D-2：同一 deps 并发 N+1 → 前 N 占槽、第 N+1 个 503', async () => {
    const gate = createSeoConcurrencyGate(2);
    const slowPorts = {
      ...ports(),
      resolveActiveRule: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return rule();
      },
    };
    const d = {
      ...deps(),
      ports: slowPorts,
      concurrencyGate: gate,
      timeoutMs: 5000,
      rateLimiter: createInMemorySeoPublicRateLimiter({
        capacity: 10,
        refillPerMinute: 60,
        now: () => NOW,
      }),
    };
    const results = await Promise.all([
      handlePublicSeoRequest(base(), d),
      handlePublicSeoRequest(base(), d),
      handlePublicSeoRequest(base(), d),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 503]);
    expect(gate.inFlight()).toBe(0);
  });

  it('CHANGE_E：in-memory limiter 有 TTL 与 max-size（不无界增长）', () => {
    const limiter = createInMemorySeoPublicRateLimiter({
      capacity: 1,
      refillPerMinute: 1,
      ttlMs: 1000,
      maxBuckets: 2,
      now: () => NOW,
    });
    limiter.check('k1');
    limiter.check('k2');
    limiter.check('k3');
    expect(limiter.maxSize()).toBe(2);
    expect(limiter.size()).toBeLessThanOrEqual(2);
  });
});
