/**
 * SEO-3 public route (module layer) contract - MSG-20261005-05.
 * Locks: default OFF, size check before JSON.parse, no wildcard CORS,
 * trusted-proxy fail-closed, rate limit before engine, timeout and gate
 * semantics identical to the already-approved handler.
 */

import { describe, expect, it } from 'vitest';

import { createSeoConcurrencyGate } from '../services/seo/seo-public-http-guard';
import { createInMemorySeoPublicRateLimiter } from '../services/seo/seo-rate-limit';
import {
  handleSeoPublicRoute,
  seoPublicCheckerEnabled,
  SEO_PUBLIC_ROUTE_BOUNDARY,
  SEO_PUBLIC_ROUTE_PATH,
} from '../services/seo/seo-public-route';
import type { SeoPublicCheckerPorts } from '../services/seo/seo-public-checker';
import type { RecoveryRuleDefinition } from '../services/recovery-rules/recovery-rule-definition';

const NOW = new Date('2026-10-05T00:00:00.000Z');

const rule = (): RecoveryRuleDefinition =>
  ({
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
  }) as unknown as RecoveryRuleDefinition;

const ports = (over: Partial<SeoPublicCheckerPorts> = {}): SeoPublicCheckerPorts => ({
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
  ...over,
});

const ENABLED = { PUBLIC_SEO_CHECKER_ENABLED: 'true' } as NodeJS.ProcessEnv;
const DISABLED = {} as NodeJS.ProcessEnv;

const deps = (over: Record<string, unknown> = {}) => ({
  ports: ports(),
  rateLimiter: createInMemorySeoPublicRateLimiter({ capacity: 2, refillPerMinute: 60, now: () => NOW }),
  anonymousSalt: 'salt-1',
  concurrencyGate: createSeoConcurrencyGate(8),
  env: ENABLED,
  ...over,
});

const input = (over: Record<string, unknown> = {}) => ({
  method: 'POST',
  url: SEO_PUBLIC_ROUTE_PATH,
  contentType: 'application/json',
  rawBody: JSON.stringify({ slug: 'us-customs-drawback', answers: { reexported: true } }),
  trustedProxy: true,
  clientIp: '203.0.113.7',
  ...over,
});

describe('SEO-3 public route (module layer)', () => {
  it('DEFAULT_DISABLED: 404 NOT_ENABLED when the flag is absent', async () => {
    expect(seoPublicCheckerEnabled(DISABLED)).toBe(false);
    const res = await handleSeoPublicRoute(input(), deps({ env: DISABLED }));
    expect(res.status).toBe(404);
    expect((res.body as { code: string }).code).toBe('NOT_ENABLED');
  });

  it('BODY_LIMIT_BEFORE_JSON_PARSE: oversized body returns 413, never 400', async () => {
    // Deliberately invalid JSON above the limit: a parse-first implementation would answer 400.
    const huge = '{' + 'x'.repeat(8 * 1024 + 10);
    const res = await handleSeoPublicRoute(input({ rawBody: huge }), deps());
    expect(res.status).toBe(413);
    expect((res.body as { code: string }).code).toBe('BODY_TOO_LARGE');
  });

  it('INVALID_JSON: parse failure is 400, not an empty body', async () => {
    const res = await handleSeoPublicRoute(input({ rawBody: '{ not json' }), deps());
    expect(res.status).toBe(400);
    expect((res.body as { code: string }).code).toBe('INVALID_JSON');
  });

  it('POST_ONLY_AND_NO_WILDCARD_CORS: GET is 405 and no ACAO header is set', async () => {
    const res = await handleSeoPublicRoute(input({ method: 'GET' }), deps());
    expect(res.status).toBe(405);
    expect(res.headers['Access-Control-Allow-Origin']).toBeUndefined();
  });

  it('TRUSTED_PROXY_FAIL_CLOSED: untrusted proxy is 400', async () => {
    const res = await handleSeoPublicRoute(input({ trustedProxy: false }), deps());
    expect(res.status).toBe(400);
    expect((res.body as { code: string }).code).toBe('UNTRUSTED_CLIENT_IP');
  });

  it('RATE_LIMIT_AND_NO_STORE: 200 carries no-store; the next call is 429', async () => {
    const d = deps({
      rateLimiter: createInMemorySeoPublicRateLimiter({ capacity: 1, refillPerMinute: 0, now: () => NOW }),
    });
    const first = await handleSeoPublicRoute(input(), d);
    expect(first.status).toBe(200);
    expect(first.headers['Cache-Control']).toBe('no-store');
    const second = await handleSeoPublicRoute(input(), d);
    expect(second.status).toBe(429);
  });

  it('TIMEOUT_AND_GATE: slow engine is 504; missing gate is 503', async () => {
    const slowPorts = ports({
      resolveActiveRule: async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return rule();
      },
    });
    const slow = await handleSeoPublicRoute(input(), deps({ ports: slowPorts, timeoutMs: 5 }));
    expect(slow.status).toBe(504);
    expect((slow.body as { code: string }).code).toBe('ENGINE_TIMEOUT');

    const noGate = await handleSeoPublicRoute(
      input(),
      deps({ concurrencyGate: undefined as unknown as ReturnType<typeof createSeoConcurrencyGate> }),
    );
    expect(noGate.status).toBe(503);
    expect((noGate.body as { code: string }).code).toBe('CONCURRENCY_GATE_MISSING');
  });

  it('BOUNDARY: default off, not registered, production public still on hold', () => {
    expect(SEO_PUBLIC_ROUTE_BOUNDARY.defaultEnabled).toBe(false);
    expect(SEO_PUBLIC_ROUTE_BOUNDARY.routeRegistered).toBe(false);
    expect(SEO_PUBLIC_ROUTE_BOUNDARY.bodyLimitCheckedBeforeJsonParse).toBe(true);
    expect(SEO_PUBLIC_ROUTE_BOUNDARY.productionPublicChecker).toBe('HOLD');
  });
});
