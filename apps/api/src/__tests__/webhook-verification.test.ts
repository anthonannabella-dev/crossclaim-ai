/**
 * TRACK A / PC-10 — 统一 webhook verification boundary 单元回归（MSG-20261003-97 ㉑）。
 * 覆盖：valid / invalid / missing signature、unknown provider、unknown signature version、
 * raw-byte 变异、timestamp 过期与未来超窗口、secret 缺失 fail-closed、日志字段不含 secret 与原文。
 */

import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  WEBHOOK_PROVIDER_REGISTRY,
  resolveWebhookProvider,
  verifyWebhookRequest,
  webhookFailureStatus,
} from '../services/webhooks/verification';

const SECRET = 'whsec_test_only_value_not_a_real_secret';
const ENV = { PAYMENT_WEBHOOK_SECRET: SECRET };
const AT = new Date(1_770_000_000_000);
const T = String(Math.floor(AT.getTime() / 1000));

function sign(body: string, timestamp: string = T, secret: string = SECRET): string {
  return createHmac('sha256', secret).update(timestamp + '.' + body, 'utf8').digest('hex');
}

const BODY = JSON.stringify({ id: 'evt_pc10', type: 'payment_intent.succeeded' });
const headers = (signature?: string) =>
  signature === undefined ? {} : { 'stripe-signature': signature };

describe('PC-10 — webhook verification boundary', () => {
  it('registry 是唯一 provider/version 来源（STRIPE × v1 × HMAC_SHA256）', () => {
    expect(resolveWebhookProvider("STRIPE")?.signatureVersion).toBe("v1");
    expect(resolveWebhookProvider("stripe")?.algorithm).toBe("HMAC_SHA256");
    expect(WEBHOOK_PROVIDER_REGISTRY.every((spec) => spec.secretEnvKey.startsWith("PAYMENT_"))).toBe(true);
  });

  it('valid signature accepted（含 timestamp 在窗口内）', () => {
    const result = verifyWebhookRequest({ provider: 'STRIPE', rawBody: BODY, headers: headers('t=' + T + ',v1=' + sign(BODY)), env: ENV, now: () => AT });
    expect(result.outcome).toBe('VERIFIED');
    expect(result.verified).toBe(true);
    expect(webhookFailureStatus(result.outcome)).toBe(200);
    expect(JSON.stringify(result.logFields)).not.toContain(SECRET);
  });

  it('invalid signature rejected（constant-time compare → SIGNATURE_MISMATCH / 401）', () => {
    const result = verifyWebhookRequest({ provider: 'STRIPE', rawBody: BODY, headers: headers('t=' + T + ',v1=' + sign('tampered')), env: ENV, now: () => AT });
    expect(result.outcome).toBe('SIGNATURE_MISMATCH');
    expect(webhookFailureStatus(result.outcome)).toBe(401);
  });

  it('missing signature rejected', () => {
    const result = verifyWebhookRequest({ provider: 'STRIPE', rawBody: BODY, headers: {}, env: ENV, now: () => AT });
    expect(result.outcome).toBe('MISSING_SIGNATURE');
  });

  it('unknown provider rejected（即使签名本身有效）', () => {
    const result = verifyWebhookRequest({ provider: 'NOT_A_PROVIDER', rawBody: BODY, headers: headers('t=' + T + ',v1=' + sign(BODY)), env: ENV, now: () => AT });
    expect(result.outcome).toBe('UNKNOWN_PROVIDER');
    expect(result.provider).toBeNull();
    expect(webhookFailureStatus(result.outcome)).toBe(400);
  });

  it('unknown signature version rejected（只给 v2）', () => {
    const result = verifyWebhookRequest({ provider: 'STRIPE', rawBody: BODY, headers: headers('t=' + T + ',v2=' + sign(BODY)), env: ENV, now: () => AT });
    expect(result.outcome).toBe('UNSUPPORTED_SIGNATURE_VERSION');
  });

  it('raw-byte mutation invalidates signature（加一个空格即失效）', () => {
    const signature = 't=' + T + ',v1=' + sign(BODY);
    expect(verifyWebhookRequest({ provider: 'STRIPE', rawBody: BODY, headers: headers(signature), env: ENV, now: () => AT }).outcome).toBe('VERIFIED');
    expect(verifyWebhookRequest({ provider: 'STRIPE', rawBody: BODY + ' ', headers: headers(signature), env: ENV, now: () => AT }).outcome).toBe('SIGNATURE_MISMATCH');
  });

  it('timestamp expired / future beyond skew rejected；边界内接受', () => {
    const oldT = String(Number(T) - 3600);
    const futureT = String(Number(T) + 3600);
    expect(verifyWebhookRequest({ provider: 'STRIPE', rawBody: BODY, headers: headers('t=' + oldT + ',v1=' + sign(BODY, oldT)), env: ENV, now: () => AT }).outcome).toBe('TIMESTAMP_EXPIRED');
    expect(verifyWebhookRequest({ provider: 'STRIPE', rawBody: BODY, headers: headers('t=' + futureT + ',v1=' + sign(BODY, futureT)), env: ENV, now: () => AT }).outcome).toBe('TIMESTAMP_IN_FUTURE');
    const edgeT = String(Number(T) - 299);
    expect(verifyWebhookRequest({ provider: 'STRIPE', rawBody: BODY, headers: headers('t=' + edgeT + ',v1=' + sign(BODY, edgeT)), env: ENV, now: () => AT }).outcome).toBe('VERIFIED');
  });

  it('missing secret → fail-closed（MISSING_SECRET / 503），不落任何业务事实', () => {
    const result = verifyWebhookRequest({ provider: 'STRIPE', rawBody: BODY, headers: headers('t=' + T + ',v1=' + sign(BODY)), env: {}, now: () => AT });
    expect(result.outcome).toBe('MISSING_SECRET');
    expect(webhookFailureStatus(result.outcome)).toBe(503);
  });

  it('安全日志字段：不含 secret、不含原始 payload、只含 hash 与结构信息', () => {
    const ok = verifyWebhookRequest({ provider: 'STRIPE', rawBody: BODY, headers: headers('t=' + T + ',v1=' + sign(BODY)), env: ENV, now: () => AT });
    const raw = JSON.stringify(ok.logFields);
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain('evt_pc10');
    expect(ok.logFields.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
