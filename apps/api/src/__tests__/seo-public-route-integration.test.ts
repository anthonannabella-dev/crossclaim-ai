/**
 * SEO-8 public surface contract - real HTTP integration.
 * Boots a real Node http server that uses the same gate and adapter as
 * server.ts, then drives it over the network so the acceptance matrix is
 * proven at the HTTP layer rather than only in unit form.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { createSeoConcurrencyGate } from '../services/seo/seo-public-http-guard';
import { createInMemorySeoPublicRateLimiter } from '../services/seo/seo-rate-limit';
import {
  handleSeoPublicNodeRequest,
  isSeoPublicRouteRequest,
  resetSeoPublicNodeDeps,
} from '../services/seo/seo-public-node-adapter';
import { SEO_PUBLIC_ROUTE_PATH } from '../services/seo/seo-public-route';
import type { SeoPublicCheckerPorts } from '../services/seo/seo-public-checker';
import type { RecoveryRuleDefinition } from '../services/recovery-rules/recovery-rule-definition';

const NOW = new Date('2026-10-05T00:00:00.000Z');
const E1 = 'engine:customs-drawback-eligibility';
const E2 = 'engine:customs-duty-difference';

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
    eligibilityMethod: { kind: 'DECISION_TABLE', basisKey: E1 },
    requiredEvidence: ['evidence:a', 'evidence:b'],
    calculationMethod: { kind: 'DUTY_DIFFERENCE', basisKey: E2 },
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
  listRegisteredBasisKeys: async () => [E1, E2],
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

const ON = { PUBLIC_SEO_CHECKER_ENABLED: 'true', SEO_PUBLIC_TRUSTED_PROXY: 'true' } as NodeJS.ProcessEnv;
const OFF = {} as NodeJS.ProcessEnv;

const servers: http.Server[] = [];
afterEach(async () => {
  resetSeoPublicNodeDeps();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

const start = async (env: NodeJS.ProcessEnv, deps: Parameters<typeof handleSeoPublicNodeRequest>[2]) => {
  resetSeoPublicNodeDeps();
  const server = http.createServer((req, res) => {
    if (isSeoPublicRouteRequest(req, env)) {
      void handleSeoPublicNodeRequest(req, res, { ...deps, env });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, code: 'NOT_HANDLED' }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}${SEO_PUBLIC_ROUTE_PATH}`;
};

const baseDeps = () => ({
  ports: ports(),
  rateLimiter: createInMemorySeoPublicRateLimiter({ capacity: 2, refillPerMinute: 60, now: () => NOW }),
  concurrencyGate: createSeoConcurrencyGate(8),
});

describe('SEO-8 public surface contract (real HTTP)', () => {
  it('FLAG_OFF: request never reaches the SEO surface', async () => {
    const url = await start(OFF, baseDeps());
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBeNull();
  });

  it('POST_ONLY: GET is 405', async () => {
    const url = await start(ON, baseDeps());
    const res = await fetch(url, { method: 'GET' });
    expect(res.status).toBe(405);
  });

  it('BODY_CAP: oversized content-length is refused before reading', async () => {
    const url = await start(ON, baseDeps());
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'x'.repeat(8 * 1024 + 1),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ ok: false, code: 'BODY_TOO_LARGE' });
  });

  it('INVALID_JSON: malformed body is 400', async () => {
    const url = await start(ON, baseDeps());
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{ nope' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, code: 'INVALID_JSON' });
  });

  it('NO_STORE_AND_NO_WILDCARD_CORS: happy path headers', async () => {
    const url = await start(ON, baseDeps());
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' },
      body: JSON.stringify({ slug: 'us-customs-drawback', answers: { reexported: true } }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    const body = (await res.json()) as { estimateLabel?: string };
    expect(body.estimateLabel).toBe('ESTIMATE_ONLY');
  });

  it('TRUSTED_PROXY_FAIL_CLOSED: no trusted proxy configured => 400', async () => {
    const url = await start({ PUBLIC_SEO_CHECKER_ENABLED: 'true' } as NodeJS.ProcessEnv, baseDeps());
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' },
      body: JSON.stringify({ slug: 'us-customs-drawback' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, code: 'UNTRUSTED_CLIENT_IP' });
  });

  it('RATE_LIMIT: the call after the bucket is empty is 429', async () => {
    const deps = {
      ...baseDeps(),
      rateLimiter: createInMemorySeoPublicRateLimiter({ capacity: 1, refillPerMinute: 0, now: () => NOW }),
    };
    const url = await start(ON, deps);
    const call = () =>
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' },
        body: JSON.stringify({ slug: 'us-customs-drawback' }),
      });
    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(429);
  });

  it('TIMEOUT: a slow engine is answered with 504 over HTTP', async () => {
    const deps = {
      ...baseDeps(),
      ports: ports({
        resolveActiveRule: async () => {
          await new Promise((resolve) => setTimeout(resolve, 60));
          return rule();
        },
      }),
      timeoutMs: 5,
    };
    const url = await start(ON, deps);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.11' },
      body: JSON.stringify({ slug: 'us-customs-drawback' }),
    });
    expect(res.status).toBe(504);
    expect(await res.json()).toMatchObject({ ok: false, code: 'ENGINE_TIMEOUT' });
  });
});
