/**
 * SEO-3 Node adapter contract: the body cap is enforced while reading (an
 * oversized stream is reported as exceeded instead of being buffered), the
 * route branch only matches when the flag is on, and nothing is written to DB.
 */

import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  isSeoPublicRouteRequest,
  readBodyWithCap,
  requestPath,
  SEO_PUBLIC_BODY_READ,
} from '../services/seo/seo-public-node-adapter';
import { SEO_PUBLIC_ROUTE_PATH } from '../services/seo/seo-public-route';

describe('SEO-3 node adapter', () => {
  it('READS_UNDER_CAP: small bodies are returned intact', async () => {
    const stream = new PassThrough();
    const promise = readBodyWithCap(stream, 100);
    stream.write(Buffer.alloc(40, 1));
    stream.end(Buffer.alloc(10, 2));
    const result = await promise;
    expect(result.ok).toBe(true);
    expect(result.exceeded).toBe(false);
    expect(result.body.byteLength).toBe(50);
  });

  it('STOPS_ON_CAP: exceeding the cap resolves as exceeded without buffering the rest', async () => {
    const stream = new PassThrough();
    const promise = readBodyWithCap(stream, 10);
    // Write past the cap but never end the stream: the promise must still settle.
    stream.write(Buffer.alloc(50, 9));
    const result = await promise;
    expect(result.exceeded).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.body.byteLength).toBe(0);
  });

  it('CAP_IS_8KIB: declared constant matches the handler boundary', () => {
    expect(SEO_PUBLIC_BODY_READ.capBytes).toBe(8 * 1024);
    expect(SEO_PUBLIC_BODY_READ.stopReadingOnExceed).toBe(true);
  });

  it('ROUTE_BRANCH_IS_FLAG_GATED: off by default, on only with the exact flag', () => {
    const req = { url: SEO_PUBLIC_ROUTE_PATH } as unknown as Parameters<typeof isSeoPublicRouteRequest>[0];
    expect(isSeoPublicRouteRequest(req, {} as NodeJS.ProcessEnv)).toBe(false);
    expect(isSeoPublicRouteRequest(req, { PUBLIC_SEO_CHECKER_ENABLED: 'TRUE' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isSeoPublicRouteRequest(req, { PUBLIC_SEO_CHECKER_ENABLED: 'true' } as NodeJS.ProcessEnv)).toBe(true);
  });

  it('PATH_MATCH_IGNORES_QUERY: query strings do not change the branch decision', () => {
    expect(requestPath(SEO_PUBLIC_ROUTE_PATH + '?a=1')).toBe(SEO_PUBLIC_ROUTE_PATH);
    expect(requestPath(undefined)).toBe('/');
  });
});
