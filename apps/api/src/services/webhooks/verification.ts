/**
 * TRACK A / PC-10（MSG-20261003-97 ㉑）— 统一 webhook 真实性验证边界。
 * ---------------------------------------------------------------
 * 目标：任何来自 provider / payment / 外部系统的 webhook，**未经验证不得转化为业务事实**。
 * 约束（架构方裁决）：
 *   1) raw body integrity：一律对**原始字节**验签（禁止 JSON.parse → stringify 再验签）；
 *   2) signature：显式算法 / 显式 header / constant-time compare / key·version aware / fail-closed；
 *   3) 未知 provider、未知 signature version → **拒绝**；
 *   4) timestamp：过期或未来超阈值 → 拒绝；
 *   5) secret 只来自 server-side 配置（env / credential reference），绝不回显、绝不写日志；
 *   6) 失败面返回稳定结果码与安全日志字段，不含 secret / 不含原始 payload。
 * 本模块**不**启用 payment / transport / provider OAuth；只做真实性判定。
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export type WebhookSignatureAlgorithm = 'HMAC_SHA256';

/** provider × signature version × algorithm 的显式 registry（避免散落的 if provider ===）。 */
export interface WebhookProviderSpec {
  provider: string;
  /** 承载签名的 header 名（小写） */
  signatureHeader: string;
  /** 受支持的签名版本参数名（例如 v1） */
  signatureVersion: string;
  /** 时间戳参数名（例如 t） */
  timestampParameter: string;
  algorithm: WebhookSignatureAlgorithm;
  /** secret 只允许来自该 server-side 环境变量名 */
  secretEnvKey: string;
  toleranceSeconds: number;
}

export const WEBHOOK_PROVIDER_REGISTRY: readonly WebhookProviderSpec[] = [
  {
    provider: 'STRIPE',
    signatureHeader: 'stripe-signature',
    signatureVersion: 'v1',
    timestampParameter: 't',
    algorithm: 'HMAC_SHA256',
    secretEnvKey: 'PAYMENT_WEBHOOK_SECRET',
    toleranceSeconds: 300,
  },
] as const;

export function resolveWebhookProvider(provider: string): WebhookProviderSpec | null {
  return WEBHOOK_PROVIDER_REGISTRY.find((spec) => spec.provider === provider.toUpperCase()) ?? null;
}

export type WebhookVerificationOutcome =
  | 'VERIFIED'
  | 'UNKNOWN_PROVIDER'
  | 'MISSING_SIGNATURE'
  | 'UNSUPPORTED_SIGNATURE_VERSION'
  | 'MALFORMED_SIGNATURE'
  | 'MISSING_SECRET'
  | 'TIMESTAMP_EXPIRED'
  | 'TIMESTAMP_IN_FUTURE'
  | 'SIGNATURE_MISMATCH';

/** 稳定 HTTP 映射：验签失败一律 400/401，不泄露内部细节。 */
export function webhookFailureStatus(outcome: WebhookVerificationOutcome): number {
  if (outcome === 'VERIFIED') return 200;
  if (outcome === 'MISSING_SECRET') return 503;
  if (outcome === 'SIGNATURE_MISMATCH') return 401;
  return 400;
}

export function rawBodyOf(rawBody: Buffer | string): Buffer {
  return Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8');
}

/** payload hash 只用于关联日志，不可逆、不含原文。 */
export function payloadHashOf(rawBody: Buffer | string): string {
  return createHash('sha256').update(rawBodyOf(rawBody)).digest('hex');
}

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const raw = headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

export interface VerifyWebhookInput {
  provider: string;
  /** 原始请求字节（或与之逐字节等价的字符串） */
  rawBody: Buffer | string;
  headers: Record<string, string | string[] | undefined>;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  toleranceSeconds?: number;
}

export interface WebhookVerificationResult {
  outcome: WebhookVerificationOutcome;
  verified: boolean;
  provider: string | null;
  signatureVersion: string | null;
  timestampSeconds: number | null;
  payloadHash: string;
  /** 可安全写入结构化日志的字段（绝不含 secret / 原始 payload） */
  logFields: Record<string, unknown>;
}

/**
 * 解析 `t=...,v1=...[,v2=...]` 形式的签名 header。
 * 已知版本缺失但存在其它版本参数 → UNSUPPORTED_SIGNATURE_VERSION。
 */
function parseSignatureHeader(
  header: string,
  spec: WebhookProviderSpec,
): { timestamp: string | null; signatures: string[]; unsupportedVersion: string | null; malformed: boolean } {
  const params = new Map<string, string[]>();
  for (const segment of header.split(',')) {
    const index = segment.indexOf('=');
    if (index <= 0) continue;
    const key = segment.slice(0, index).trim();
    const value = segment.slice(index + 1).trim();
    const list = params.get(key) ?? [];
    list.push(value);
    params.set(key, list);
  }
  const timestamp = params.get(spec.timestampParameter)?.[0] ?? null;
  const signatures = params.get(spec.signatureVersion) ?? [];
  if (signatures.length > 0) return { timestamp, signatures, unsupportedVersion: null, malformed: false };
  const otherVersions = [...params.keys()].filter((key) => /^v\d+$/.test(key));
  if (otherVersions.length > 0) {
    return { timestamp, signatures: [], unsupportedVersion: otherVersions[0] ?? null, malformed: false };
  }
  return { timestamp, signatures: [], unsupportedVersion: null, malformed: true };
}

export function verifyWebhookRequest(input: VerifyWebhookInput): WebhookVerificationResult {
  const env = input.env ?? process.env;
  const rawBody = rawBodyOf(input.rawBody);
  const payloadHash = payloadHashOf(rawBody);
  const spec = resolveWebhookProvider(input.provider);
  const base: Omit<WebhookVerificationResult, 'outcome' | 'verified' | 'logFields'> = {
    provider: spec ? spec.provider : null,
    signatureVersion: spec ? spec.signatureVersion : null,
    timestampSeconds: null,
    payloadHash,
  };
  const fail = (outcome: WebhookVerificationOutcome, extra: Record<string, unknown> = {}): WebhookVerificationResult => ({
    ...base,
    outcome,
    verified: false,
    logFields: {
      provider: spec ? spec.provider : input.provider.toUpperCase(),
      outcome,
      payloadHash,
      ...extra,
    },
  });

  if (!spec) return fail('UNKNOWN_PROVIDER');

  const header = headerValue(input.headers, spec.signatureHeader);
  if (!header || header.trim() === '') return fail('MISSING_SIGNATURE');

  const parsed = parseSignatureHeader(header, spec);
  if (parsed.unsupportedVersion) {
    return fail('UNSUPPORTED_SIGNATURE_VERSION', { receivedSignatureVersion: parsed.unsupportedVersion });
  }
  if (parsed.malformed) return fail('MALFORMED_SIGNATURE');
  if (!parsed.timestamp || parsed.signatures.length === 0) return fail('MALFORMED_SIGNATURE');

  const timestampSeconds = Number(parsed.timestamp);
  if (!Number.isFinite(timestampSeconds)) return fail('MALFORMED_SIGNATURE');
  base.timestampSeconds = timestampSeconds;

  const secret = env[spec.secretEnvKey];
  if (!secret || secret.trim() === '') return fail('MISSING_SECRET');

  const tolerance = input.toleranceSeconds ?? spec.toleranceSeconds;
  const nowSeconds = Math.floor((input.now ? input.now() : new Date()).getTime() / 1000);
  const skew = nowSeconds - timestampSeconds;
  if (skew > tolerance) return fail('TIMESTAMP_EXPIRED', { skewSeconds: skew, toleranceSeconds: tolerance });
  if (-skew > tolerance) return fail('TIMESTAMP_IN_FUTURE', { skewSeconds: skew, toleranceSeconds: tolerance });

  const signedPayload = Buffer.from(parsed.timestamp + '.' + rawBody.toString('utf8'), 'utf8');
  const expected = Buffer.from(createHmac('sha256', secret).update(signedPayload).digest('hex'), 'utf8');
  let matched = false;
  for (const candidate of parsed.signatures) {
    const provided = Buffer.from(candidate, 'utf8');
    if (provided.length === expected.length && timingSafeEqual(provided, expected)) {
      matched = true;
      break;
    }
  }
  if (!matched) return fail('SIGNATURE_MISMATCH');

  return {
    ...base,
    outcome: 'VERIFIED',
    verified: true,
    logFields: {
      provider: spec.provider,
      outcome: 'VERIFIED',
      payloadHash,
      signatureVersion: spec.signatureVersion,
      algorithm: spec.algorithm,
      timestampSeconds,
    },
  };
}
