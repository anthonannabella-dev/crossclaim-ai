/**
 * SEO-3 PUBLIC HTTP BOUNDARY GUARD（纯函数 + 端口契约）
 * ---------------------------------------------------------------
 * 来源：架构方 PUBLIC API SECURITY 审计（reviewed 3066ac2）要求的公开 HTTP 最小防护。
 * 本模块只做**判断与派生**，不监听端口、不发送请求、不写库；真正的接线在 SEO-4/HTTP FINAL。
 *
 * 覆盖：POST only · Content-Type application/json · body ≤ 8 KiB（解析前）· rate limit 先于昂贵引擎
 * · 总超时 2–3s · 有界并发 · Cache-Control: no-store · same-origin CORS（禁止 ACAO: *）
 * · 不记录 raw body/IP/UA · 匿名 key 必须来自**可信代理**的真实 client IP。
 */

import { createHash } from 'node:crypto';

export const SEO_PUBLIC_MAX_BODY_BYTES = 8 * 1024;
export const SEO_PUBLIC_TIMEOUT_MS = 2500;
export const SEO_PUBLIC_MAX_CONCURRENCY = 8;

export type SeoHttpRejectionCode =
  | 'METHOD_NOT_ALLOWED'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'BODY_TOO_LARGE'
  | 'UNTRUSTED_CLIENT_IP'
  | 'CONCURRENCY_EXCEEDED';

export type SeoHttpGuardResult = { ok: true } | { ok: false; code: SeoHttpRejectionCode };

/** 方法 + Content-Type + body 大小（**在解析 JSON 之前**用字节长度判断）。 */
export function guardSeoHttpRequestShape(input: {
  method: string;
  contentType: string | null;
  bodyByteLength: number;
}): SeoHttpGuardResult {
  if (String(input.method).toUpperCase() !== 'POST') return { ok: false, code: 'METHOD_NOT_ALLOWED' };
  const contentType = (input.contentType ?? '').toLowerCase();
  if (!contentType.startsWith('application/json')) return { ok: false, code: 'UNSUPPORTED_MEDIA_TYPE' };
  if (!Number.isFinite(input.bodyByteLength) || input.bodyByteLength < 0) {
    return { ok: false, code: 'BODY_TOO_LARGE' };
  }
  if (input.bodyByteLength > SEO_PUBLIC_MAX_BODY_BYTES) return { ok: false, code: 'BODY_TOO_LARGE' };
  return { ok: true };
}

/**
 * 匿名键派生：**只信任**可信代理提供的 client IP。
 * 非可信代理时不得退化为信任用户可伪造的 X-Forwarded-For。
 */
export function deriveAnonymousKey(input: {
  trustedProxy: boolean;
  clientIp: string | null;
  salt: string;
}): { ok: true; key: string } | { ok: false; code: 'UNTRUSTED_CLIENT_IP' } {
  if (!input.trustedProxy) return { ok: false, code: 'UNTRUSTED_CLIENT_IP' };
  const ip = (input.clientIp ?? '').trim();
  if (ip === '') return { ok: false, code: 'UNTRUSTED_CLIENT_IP' };
  return {
    ok: true,
    key: createHash('sha256').update(input.salt + '|' + ip, 'utf8').digest('hex'),
  };
}

/** 有界并发闸门（进程内参考实现；生产应换成跨进程/共享实现）。 */
export function createSeoConcurrencyGate(max: number = SEO_PUBLIC_MAX_CONCURRENCY) {
  let inFlight = 0;
  return {
    tryAcquire(): SeoHttpGuardResult {
      if (inFlight >= max) return { ok: false, code: 'CONCURRENCY_EXCEEDED' };
      inFlight += 1;
      return { ok: true };
    },
    release(): void {
      if (inFlight > 0) inFlight -= 1;
    },
    inFlight: () => inFlight,
  };
}

/** 响应头与日志策略（纯数据，便于接线时统一）。 */
export const SEO_PUBLIC_RESPONSE_POLICY = {
  cacheControl: 'no-store',
  /** 禁止 `Access-Control-Allow-Origin: *`：只允许同源（或显式白名单）。 */
  corsMode: 'SAME_ORIGIN_ONLY',
  logRawBody: false,
  logRawIp: false,
  logUserAgent: false,
  timeoutMs: SEO_PUBLIC_TIMEOUT_MS,
} as const;

/** 边界自证：本模块不外写、不落库、不读取凭据。 */
export const SEO_PUBLIC_HTTP_GUARD_BOUNDARY = {
  pureDecisionOnly: true,
  externalWritePerformed: false,
  databaseWritePerformed: false,
  trustsForwardedHeaderWhenProxyUntrusted: false,
  productionCredentials: 'ABSENT',
} as const;
