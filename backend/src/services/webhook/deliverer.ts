import crypto from 'crypto';
import prisma from '../../config/database';

export interface DeliverResult {
  success: boolean;
  statusCode: number | null;
  durationMs: number;
  error?: string;
  attempt: number;
}

const DELIVERY_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [5_000, 15_000, 45_000]; // 5s, 15s, 45s

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function generateHmacSignature(secret: string, payload: string, timestamp: number): string {
  const message = `${timestamp}.${payload}`;
  return `sha256=${crypto.createHmac('sha256', secret).update(message).digest('hex')}`;
}

async function attemptDelivery(
  url: string,
  body: string,
  headers: Record<string, string>,
): Promise<{ statusCode: number | null; responseBody: string; durationMs: number; error?: string }> {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
      body,
      signal: controller.signal,
    });

    clearTimeout(timeout);
    const durationMs = Date.now() - start;
    const responseBody = await response.text().catch(() => '');
    const truncated = responseBody.slice(0, 1000);

    return {
      statusCode: response.status,
      responseBody: truncated,
      durationMs,
      error: response.ok ? undefined : `HTTP ${response.status}`,
    };
  } catch (err: any) {
    const durationMs = Date.now() - start;
    return {
      statusCode: null,
      responseBody: '',
      durationMs,
      error: err.name === 'AbortError' ? 'Request timeout (10s)' : (err.message || 'Unknown error'),
    };
  }
}

export async function deliverWebhook(
  subscription: { id: string; url: string; secret: string },
  eventType: string,
  payload: Record<string, unknown>,
): Promise<DeliverResult> {
  const deliveryId = crypto.randomUUID();
  const timestamp = Math.floor(Date.now() / 1000);
  const payloadStr = JSON.stringify({
    eventType,
    deliveryId,
    timestamp: new Date().toISOString(),
    data: payload,
  });

  const signature = generateHmacSignature(subscription.secret, payloadStr, timestamp);

  const headers: Record<string, string> = {
    'X-Webhook-Event': eventType,
    'X-Webhook-Delivery-ID': deliveryId,
    'X-Webhook-Timestamp': String(timestamp),
    'X-Webhook-Signature': signature,
  };

  let lastResult: DeliverResult = { success: false, statusCode: null, durationMs: 0, attempt: 0 };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { statusCode, responseBody, durationMs, error } = await attemptDelivery(
      subscription.url,
      payloadStr,
      headers,
    );

    const success = statusCode != null && statusCode >= 200 && statusCode < 300;

    lastResult = { success, statusCode, durationMs, error, attempt };

    // 写入投递日志
    await prisma.webhookDelivery.create({
      data: {
        subscriptionId: subscription.id,
        eventType,
        payload: payloadStr,
        statusCode,
        responseBody,
        durationMs,
        success,
        error,
        attempt,
      },
    }).catch(() => {});

    if (success) return lastResult;

    // 非最后一次尝试则等待重试
    if (attempt < MAX_ATTEMPTS) {
      await sleep(RETRY_DELAYS_MS[attempt - 1]);
    }
  }

  return lastResult;
}
