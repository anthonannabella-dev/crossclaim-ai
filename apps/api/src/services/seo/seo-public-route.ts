/**
 * SEO-3 PUBLIC ROUTE (module layer) - MSG-20261005-05.
 * Authorized: PUBLIC_ROUTE_IMPLEMENTATION + SEO_8_PUBLIC_SURFACE_CONTRACT.
 * Code wiring only, NOT a production unlock:
 *   - default OFF: only PUBLIC_SEO_CHECKER_ENABLED=true serves requests;
 *   - when off: 404 NOT_ENABLED (leaks nothing about the SEO surface);
 *   - order: flag -> raw bytes <=8 KiB (BEFORE JSON.parse) -> JSON.parse ->
 *     trusted-proxy client IP -> process-level singleton concurrency gate ->
 *     limiter -> real timeout -> handler -> no-store response.
 * No I/O, no route registration here; server.ts wiring is the next unit.
 */

import { handlePublicSeoRequest, type SeoPublicHandlerDeps } from './seo-public-handler';
import { SEO_PUBLIC_MAX_BODY_BYTES } from './seo-public-http-guard';
import type { SeoPublicRequest } from './seo-public-checker';

export const SEO_PUBLIC_ROUTE_PATH = '/public/seo/checker';

/** Default OFF; only an explicit PUBLIC_SEO_CHECKER_ENABLED=true turns it on. */
export function seoPublicCheckerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PUBLIC_SEO_CHECKER_ENABLED === 'true';
}

export interface SeoPublicRouteInput {
  method: string;
  url: string;
  contentType: string | null;
  /** Raw, unparsed body so the size check can run before JSON.parse. */
  rawBody: Buffer | string;
  trustedProxy: boolean;
  clientIp: string | null;
}

export interface SeoPublicRouteDeps extends SeoPublicHandlerDeps {
  env?: NodeJS.ProcessEnv;
}

export interface SeoPublicRouteResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' } as const;

const fail = (status: number, code: string): SeoPublicRouteResponse => ({
  status,
  headers: { 'Cache-Control': 'no-store', ...JSON_HEADERS },
  body: { ok: false, code },
});

const byteLengthOf = (raw: Buffer | string): number =>
  Buffer.isBuffer(raw) ? raw.byteLength : Buffer.byteLength(raw, 'utf8');

const rawToText = (raw: Buffer | string): string => (Buffer.isBuffer(raw) ? raw.toString('utf8') : raw);

export async function handleSeoPublicRoute(
  input: SeoPublicRouteInput,
  deps: SeoPublicRouteDeps,
): Promise<SeoPublicRouteResponse> {
  // 0) default OFF
  if (!seoPublicCheckerEnabled(deps.env)) return fail(404, 'NOT_ENABLED');

  // 1) path match
  const path = input.url.split('?')[0] ?? '';
  if (path !== SEO_PUBLIC_ROUTE_PATH) return fail(404, 'NOT_FOUND');

  // 2) body <= 8 KiB, strictly BEFORE JSON.parse
  const bodyByteLength = byteLengthOf(input.rawBody);
  if (bodyByteLength > SEO_PUBLIC_MAX_BODY_BYTES) return fail(413, 'BODY_TOO_LARGE');

  // 3) JSON.parse (never treat a parse failure as an empty body)
  let parsedBody: SeoPublicRequest | null = null;
  const text = rawToText(input.rawBody).trim();
  if (text !== '') {
    try {
      parsedBody = JSON.parse(text) as SeoPublicRequest;
    } catch {
      return fail(400, 'INVALID_JSON');
    }
  }

  // 4) delegate: shape / rate limit / mandatory gate / real timeout / engine output check
  return handlePublicSeoRequest(
    {
      method: input.method,
      contentType: input.contentType,
      bodyByteLength,
      parsedBody,
      trustedProxy: input.trustedProxy,
      clientIp: input.clientIp,
    },
    deps,
  );
}

/** Boundary: no writes, no charge, no route registration, no raw identifier logging. */
export const SEO_PUBLIC_ROUTE_BOUNDARY = {
  routeRegistered: false,
  defaultEnabled: false,
  envFlag: 'PUBLIC_SEO_CHECKER_ENABLED',
  bodyLimitCheckedBeforeJsonParse: true,
  externalWritePerformed: false,
  databaseWritePerformed: false,
  paymentPerformed: false,
  rawBodyLogged: false,
  corsWildcard: false,
  productionPublicChecker: 'HOLD',
} as const;
