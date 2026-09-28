/**
 * AWS SigV4 请求签名（零依赖，node:crypto 实现）
 * ---------------------------------------------------------------
 * 只实现 S3 需要的单次请求签名（PUT / GET / HEAD，非分片上传）。
 * 之所以自己写：Wave 0/1 追求**零新增依赖**，而 S3 签名算法是公开且稳定的；
 * 若后续需要分片上传 / 流式签名，再评估引入官方 SDK（Apache-2.0）并报备。
 */

import { createHash, createHmac } from 'node:crypto';

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface SignableRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  /** body 的 sha256（十六进制），空 body 用空串的 sha256 */
  payloadHash: string;
  region: string;
  service?: string;
  credentials: AwsCredentials;
  date?: Date;
}

export const ALGORITHM = 'AWS4-HMAC-SHA256';
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

export function sha256HexOfString(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function sha256HexOfBuffer(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/** 2026-09-28T07:00:00.000Z → 20260928T070000Z */
export function amzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/** RFC3986 编码（'/' 之外全部转义，S3 的规范路径要求按段处理） */
function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function canonicalizePath(pathname: string): string {
  if (pathname === '' || pathname === '/') return '/';
  return pathname.split('/').map((segment) => encodeRfc3986(segment)).join('/');
}

function canonicalizeQuery(params: URLSearchParams): string {
  const pairs: Array<[string, string]> = [];
  for (const [k, v] of params.entries()) pairs.push([encodeRfc3986(k), encodeRfc3986(v)]);
  pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

/**
 * 返回带 `authorization` 的完整请求头（含 host / x-amz-date / x-amz-content-sha256）。
 * 调用方负责把这些头原样发给服务端，否则签名不匹配。
 */
export function signRequest(request: SignableRequest): Record<string, string> {
  const date = request.date ?? new Date();
  const stamp = amzDate(date);
  const dateStamp = stamp.slice(0, 8);
  const service = request.service ?? 's3';

  const headers: Record<string, string> = {
    ...request.headers,
    host: request.url.host,
    'x-amz-date': stamp,
    'x-amz-content-sha256': request.payloadHash,
  };
  if (request.credentials.sessionToken) {
    headers['x-amz-security-token'] = request.credentials.sessionToken;
  }

  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    normalized[key.toLowerCase()] = value.trim().replace(/\s+/g, ' ');
  }
  const signedHeaderNames = Object.keys(normalized).sort();
  const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${normalized[name]}\n`).join('');
  const signedHeaders = signedHeaderNames.join(';');

  const canonicalRequest = [
    request.method.toUpperCase(),
    canonicalizePath(request.url.pathname),
    canonicalizeQuery(request.url.searchParams),
    canonicalHeaders,
    signedHeaders,
    request.payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${request.region}/${service}/aws4_request`;
  const stringToSign = [
    ALGORITHM,
    stamp,
    scope,
    sha256HexOfString(canonicalRequest),
  ].join('\n');

  const kDate = hmac(`AWS4${request.credentials.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, request.region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  return {
    ...headers,
    authorization:
      `${ALGORITHM} Credential=${request.credentials.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
