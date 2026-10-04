/**
 * SEO-3 PUBLIC HANDLER（组合层，**未注册任何 HTTP 路由**）
 * ---------------------------------------------------------------
 * 按裁决要求的固定顺序组合成一个可测试的 handler：
 *   1) 请求形状（POST / JSON / ≤8 KiB）在解密前判
 *   2) 限流（**受信代理**才取真实 client IP）+ 限流在昂贵逻辑前调用
 *   3) 有界并发闸门（**必传**，进程级 singleton；不允许 fail-open 默认）
 *   4) 真执行 Checker（内含 CHANGE A/B schema 校验与 engine 输出校验）
 *   5) 真实 timeout enforcement（MSG-20261005-04 CHANGE C）
 *   6) 统一响应头（no-store / 同源 CORS）
 *
 * 本模块不做 I/O，也不注册路由；接线（含共享/边缘限流）在 PUBLIC HTTP FINAL 后。
 */

import {
  runPublicSeoChecker,
  SEO_PUBLIC_TOOL_BOUNDARY,
  type SeoPublicCheckerOutcome,
  type SeoPublicCheckerPorts,
  type SeoPublicRequest,
} from './seo-public-checker';
import {
  createSeoTimeout,
  deriveAnonymousKey,
  guardSeoHttpRequestShape,
  SEO_PUBLIC_RESPONSE_POLICY,
  type SeoConcurrencyGate,
} from './seo-public-http-guard';
import type { SeoPublicRateLimiter } from './seo-rate-limit';

export interface SeoPublicHandlerDeps {
  ports: SeoPublicCheckerPorts;
  rateLimiter: SeoPublicRateLimiter;
  /** 用于匿名化，禁止落盘原始标识 */
  anonymousSalt: string;
  /**
   * MSG-20261005-04 CHANGE D：**必传**。缺省即 fail-closed（503），
   * 因为每个请求各建一个计数器会让 MAX_CONCURRENCY 形同虚设。
   * 组合根应使用 getSeoPublicConcurrencyGate() 取进程级 singleton。
   */
  concurrencyGate: SeoConcurrencyGate;
  /** 覆盖默认 timeout（毫秒）；只在测试或组合根显式调优时使用。 */
  timeoutMs?: number;
}

export interface SeoPublicHandlerInput {
  method: string;
  contentType: string | null;
  bodyByteLength: number;
  /** 已解析的 JSON body（超过 8 KiB 拒收由调用层保证） */
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
  // 1) 请求形状；在解密前已按字节长度判断
  const shape = guardSeoHttpRequestShape({
    method: input.method,
    contentType: input.contentType,
    bodyByteLength: input.bodyByteLength,
  });
  if (!shape.ok) {
    const status = shape.code === 'METHOD_NOT_ALLOWED' ? 405 : shape.code === 'BODY_TOO_LARGE' ? 413 : 415;
    return deny(status, shape.code);
  }

  // 2) 限流只放可信代理 + 只做匿名键（不落任何原始信息）
  const key = deriveAnonymousKey({
    trustedProxy: input.trustedProxy,
    clientIp: input.clientIp,
    salt: deps.anonymousSalt,
  });
  if (!key.ok) return deny(400, key.code);
  const limit = deps.rateLimiter.check(key.key);
  if (!limit.allowed) return deny(429, 'RATE_LIMITED');

  // 3) 有界并发：闸门必传（CHANGE D）
  const gate = deps.concurrencyGate;
  if (gate === undefined || gate === null) return deny(503, 'CONCURRENCY_GATE_MISSING');
  const slot = gate.tryAcquire();
  if (!slot.ok) return deny(503, slot.code);

  // 4) 真执行 Checker（内部已含 CHANGE A/B 校验 + engine 输出校验）
  const engine = runPublicSeoChecker(input.parsedBody ?? { slug: '' }, deps.ports);
  // 槽位只在**引擎真正结束**时释放：超时后慢任务仍在跑，若立刻释放会突破并发上限。
  let released = false;
  const releaseOnce = (): void => {
    if (!released) {
      released = true;
      gate.release();
    }
  };
  void engine.then(releaseOnce, releaseOnce);

  // 5) 真实 timeout enforcement（CHANGE C）
  const timeout = createSeoTimeout(deps.timeoutMs ?? SEO_PUBLIC_RESPONSE_POLICY.timeoutMs);
  try {
    const result = await Promise.race([engine, timeout.expired]);
    if (result === undefined) return deny(504, 'ENGINE_TIMEOUT');
    if (!result.ok) {
      const status = result.code === 'INVALID_REQUEST' || result.code === 'PII_REJECTED' ? 400 : 404;
      return { status, headers: responseHeaders(), body: result };
    }
    return { status: 200, headers: responseHeaders(), body: result };
  } catch {
    return deny(502, 'ENGINE_FAILED');
  } finally {
    timeout.cancel();
  }
}

/** 边界验证：组合层不注册路由、不写库、不传租户数据。 */
export const SEO_PUBLIC_HANDLER_BOUNDARY = {
  routeRegistered: false,
  tenantDataIncluded: false,
  externalWritePerformed: false,
  databaseWritePerformed: false,
  rateLimitBeforeEngineCall: true,
  /** MSG-20261005-04：闸门必传；timeout 真执行。 */
  concurrencyGateRequired: true,
  timeoutEnforced: true,
  checkerBoundary: SEO_PUBLIC_TOOL_BOUNDARY,
} as const;
