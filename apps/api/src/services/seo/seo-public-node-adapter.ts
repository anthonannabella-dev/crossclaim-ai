/**
 * SEO-3 public route - Node http adapter (MSG-20261005-05 follow-up).
 * Bridges a plain Node IncomingMessage/ServerResponse to handleSeoPublicRoute:
 *   - reads the body with a hard 8 KiB cap and stops reading as soon as the cap
 *     is exceeded (the oversized request never gets buffered);
 *   - never trusts a forwarded header unless trusted proxy is explicitly configured;
 *   - composes the checker ports lazily from Prisma + an (empty by default) engine registry;
 *   - disabled by default: PUBLIC_SEO_CHECKER_ENABLED must be exactly 'true'.
 * No writes, no payment, no transport, no credentials.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import type { PrismaClient } from '@prisma/client';

import { parseRecoveryRuleDefinition, type RecoveryRuleDefinition } from '../recovery-rules/recovery-rule-definition';
import { SEO_PUBLIC_MAX_BODY_BYTES } from './seo-public-http-guard';
import { getSeoPublicConcurrencyGate } from './seo-public-http-guard';
import { createInMemorySeoPublicRateLimiter, type SeoPublicRateLimiter } from './seo-rate-limit';
import { createSeoPublicCheckerPorts, createSeoPublicEngineRegistry } from './seo-public-ports';
import { handleSeoPublicRoute, SEO_PUBLIC_ROUTE_PATH, seoPublicCheckerEnabled } from './seo-public-route';

export const SEO_PUBLIC_BODY_READ = {
  capBytes: SEO_PUBLIC_MAX_BODY_BYTES,
  stopReadingOnExceed: true,
} as const;

export interface ReadBodyResult {
  ok: boolean;
  body: Buffer;
  exceeded: boolean;
}

/**
 * Read at most `cap` bytes; as soon as the cap is exceeded, stop listening and
 * report `exceeded` instead of buffering the rest.
 */
export function readBodyWithCap(
  stream: NodeJS.ReadableStream,
  cap: number = SEO_PUBLIC_MAX_BODY_BYTES,
): Promise<ReadBodyResult> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    const cleanup = (): void => {
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
    };
    const finish = (result: ReadBodyResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const onData = (chunk: Buffer | string): void => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      size += buf.byteLength;
      if (size > cap) {
        finish({ ok: false, body: Buffer.alloc(0), exceeded: true });
        return;
      }
      chunks.push(buf);
    };
    const onEnd = (): void => finish({ ok: true, body: Buffer.concat(chunks), exceeded: false });
    const onError = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);
  });
}

export interface SeoPublicNodeDeps {
  prisma?: PrismaClient;
  env?: NodeJS.ProcessEnv;
  rateLimiter?: SeoPublicRateLimiter;
}

let CACHED_DEPS: ReturnType<typeof buildDeps> | null = null;

function buildDeps(input: SeoPublicNodeDeps) {
  const env = input.env ?? process.env;
  const prisma = input.prisma;
  const registry = createSeoPublicEngineRegistry();
  return {
    env,
    trustedProxy: env.SEO_PUBLIC_TRUSTED_PROXY === 'true',
    ports:
      prisma === undefined
        ? null
        : createSeoPublicCheckerPorts({
            loadRules: async (): Promise<readonly RecoveryRuleDefinition[]> => {
              const rows = await prisma.ruleVersion.findMany({ where: { isActive: true } });
              const rules: RecoveryRuleDefinition[] = [];
              for (const row of rows) {
                const parsed = parseRecoveryRuleDefinition(row);
                if (parsed.ok) rules.push(parsed.rule);
              }
              return rules;
            },
            registry,
            now: () => new Date(),
          }),
    rateLimiter:
      input.rateLimiter ??
      createInMemorySeoPublicRateLimiter({ capacity: 30, refillPerMinute: 30, ttlMs: 600000, maxBuckets: 5000 }),
    anonymousSalt: env.SEO_PUBLIC_ANONYMOUS_SALT ?? 'dev-only-unsalted',
    concurrencyGate: getSeoPublicConcurrencyGate(),
  };
}

/** Compose deps once per process so the limiter and concurrency gate are shared. */
export function getSeoPublicNodeDeps(input: SeoPublicNodeDeps = {}): ReturnType<typeof buildDeps> {
  if (CACHED_DEPS === null) CACHED_DEPS = buildDeps(input);
  return CACHED_DEPS;
}

/** Test hook: drop the memoised composition. */
export function resetSeoPublicNodeDeps(): void {
  CACHED_DEPS = null;
}

export function requestPath(url: string | undefined): string {
  return (url ?? '/').split('?')[0] ?? '';
}

/** True when this request should be handled by the public SEO route branch. */
export function isSeoPublicRouteRequest(req: IncomingMessage, env: NodeJS.ProcessEnv = process.env): boolean {
  return seoPublicCheckerEnabled(env) && requestPath(req.url) === SEO_PUBLIC_ROUTE_PATH;
}

const trustedClientIp = (req: IncomingMessage): string | null => {
  const forwarded = req.headers['x-forwarded-for'];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const first = typeof raw === 'string' ? raw.split(',')[0]?.trim() : '';
  return first && first !== '' ? first : null;
};

export async function handleSeoPublicNodeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  input: SeoPublicNodeDeps = {},
): Promise<void> {
  const deps = getSeoPublicNodeDeps(input);
  const env = input.env ?? process.env;
  const write = (status: number, headers: Record<string, string>, body: unknown): void => {
    res.writeHead(status, headers);
    res.end(JSON.stringify(body));
  };
  const noStoreJson = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' };

  // Early reject from content-length so an oversized body is not read at all.
  const declared = Number(req.headers['content-length'] ?? '');
  if (Number.isFinite(declared) && declared > SEO_PUBLIC_MAX_BODY_BYTES) {
    write(413, noStoreJson, { ok: false, code: 'BODY_TOO_LARGE' });
    return;
  }

  const read = await readBodyWithCap(req);
  if (read.exceeded) {
    write(413, noStoreJson, { ok: false, code: 'BODY_TOO_LARGE' });
    return;
  }

  const ports = deps.ports;
  if (ports === null) {
    // No rule source composed: refuse rather than pretend to serve.
    write(503, noStoreJson, { ok: false, code: 'RULE_SOURCE_UNAVAILABLE' });
    return;
  }

  const result = await handleSeoPublicRoute(
    {
      method: req.method ?? 'GET',
      url: req.url ?? '/',
      contentType: typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : null,
      rawBody: read.body,
      trustedProxy: deps.trustedProxy,
      clientIp: deps.trustedProxy ? trustedClientIp(req) : null,
    },
    {
      ports,
      rateLimiter: deps.rateLimiter,
      anonymousSalt: deps.anonymousSalt,
      concurrencyGate: deps.concurrencyGate,
      env,
    },
  );
  write(result.status, result.headers, result.body);
}
