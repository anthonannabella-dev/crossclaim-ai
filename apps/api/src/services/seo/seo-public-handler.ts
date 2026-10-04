/**
 * SEO-3 PUBLIC HANDLER（组合层，**不注册任何 HTTP 路由**）
 * ---------------------------------------------------------------
 * 把审计要求的各层按正确顺序组合成一个可测试的 handler：
 *   1) 请求形状（POST / JSON / ≤8 KiB，解析前）
 *   2) 匿名键（**可信代理**真实 client IP）+ 限流（必须先于昂贵引擎调用）
 *   3) 有界并发闸门
 *   4) 公开 Checker（含 CHANGE A/B schema 校验与 engine 输出校验）
 *   5) 统一响应头（no-store / 同源 CORS）
 *
 * 本模块不做 I/O、不读环境、不注册路由；接线（含共享限流与 CDN/网关）留给 PUBLIC HTTP FINAL。
 */

import {
  runPublicSeoChecker,
  SEO_PUBLIC_TOOL_BOUNDARY,
  type SeoPublicCheckerOutcome,
  type SeoPublicCheckerPorts,
  type SeoPublicRequest,
} from './seo-public-checker';
import {
  createSeoConcurrencyGate,
  deriveAnonymousKey,
  guardSeoHttpRequestShape,
  SEO_PUBLIC_RESPONSE_POLICY,
} from './seo-public-http-guard';
import type { SeoPublicRateLimiter } from './seo-rate-limit';

export interface SeoPublicHandlerDeps {
  ports: SeoPublicCheckerPorts;
  rateLimiter: SeoPublicRateLimiter;
  /** 匿名键盐（服务端持有，不进日志）。 */
  anonymousSalt: string;
  concurrencyGate?: ReturnType<typeof createSeoConcurrencyGate>;
}

export interface SeoPublicHandlerInput {
  method: string;
  contentType: string | null;
  bodyByteLength: number;
  /** 已解析的 JSON body（解析必须发生在 8 KiB 检查之后，由接线层保证）。 */
  parsedBody: SeoPublicRequest | null;
  trustedProxy: boolean;
  clientIp: string | null;
}

export interface SeoPublicHandlerResponse {
  status: number;
  headers: Record<string, string>;
  body: SeoPublicCheckerOutcome | { ok: false; code: string };
}

const responseHeaders = (): Record<string, string> => ({
  'Cache-Control': SEO_PUBLIC_RESPONSE_POLICY.cacheControl,
  'Content-Type': 'application/json; charset=utf-8',
});

const deny = (status: number, code: string): SeoPublicHandlerResponse => ({
  status,
  headers: responseHeaders(),
  body: { ok: false, code },
});

export async function handlePublicSeoRequest(
  input: SeoPublicHandlerInput,
  deps: SeoPublicHandlerDeps,
): Promise<SeoPublicHandlerResponse> {
  // 1) 请求形状（解析前已按字节判断体积）。
  const shape = guardSeoHttpRequestShape({
    method: input.method,
    contentType: input.contentType,
    bodyByteLength: input.bodyByteLength,
  });
  if (!shape.ok) {
    const status = shape.code === 'METHOD_NOT_ALLOWED' ? 405 : shape.code === 'BODY_TOO_LARGE' ? 413 : 415;
    return deny(status, shape.code);
  }

  // 2) 匿名键（只信可信代理）+ 限流（先于任何昂贵工作）。
  const key = deriveAnonymousKey({
    trustedProxy: input.trustedProxy,
    clientIp: input.clientIp,
    salt: deps.anonymousSalt,
  });
  if (!key.ok) return deny(400, key.code);
  const limit = deps.rateLimiter.check(key.key);
  if (!limit.allowed) return deny(429, 'RATE_LIMITED');

  // 3) 有界并发。
  const gate = deps.concurrencyGate ?? createSeoConcurrencyGate();
  const slot = gate.tryAcquire();
  if (!slot.ok) return deny(503, slot.code);

  try {
    // 4) 公开 Checker（内部已含 CHANGE A/B 输入校验 + engine 输出校验）。
    const result = await runPublicSeoChecker(input.parsedBody ?? { slug: '' }, deps.ports);
    if (!result.ok) {
      const status = result.code === 'INVALID_REQUEST' || result.code === 'PII_REJECTED' ? 400 : 404;
      return { status, headers: responseHeaders(), body: result };
    }
    return { status: 200, headers: responseHeaders(), body: result };
  } finally {
    gate.release();
  }
}

/** 边界自证：组合层不注册路由、不外写、不落库、不含租户数据。 */
export const SEO_PUBLIC_HANDLER_BOUNDARY = {
  routeRegistered: false,
  tenantDataIncluded: false,
  externalWritePerformed: false,
  databaseWritePerformed: false,
  rateLimitBeforeEngineCall: true,
  checkerBoundary: SEO_PUBLIC_TOOL_BOUNDARY,
} as const;
