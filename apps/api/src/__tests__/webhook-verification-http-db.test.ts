/**
 * TRACK A / PC-10 — webhook 验证的 HTTP + PostgreSQL 回归（MSG-20261003-97 ㉑）。
 * 关键不变量：验签失败 / 未知 provider / 缺签名 / raw-byte 变异 / 时间窗失败 → **零业务写入**，
 * 响应与日志均不含 signing secret；verification 先于 parse 与持久化。
 */

import type { AddressInfo } from 'node:net';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createLogger } from '../config/logger';
import { createServer } from '../server';
import { createAuditWriter, createPrismaAuditSink } from '../services/audit';
import { LocalFileSystemStorage } from '../services/storage';

const prisma = new PrismaClient();
const SALT = 'pc10-webhook-salt-0123456789';
const SECRET = 'whsec_pc10_http_test_value';
// HTTP 路径使用服务端真实时钟；签名时间戳必须在容忍窗口内（PC-10 timestamp window）。
const T = String(Math.floor(Date.now() / 1000));
const BODY = JSON.stringify({ id: 'evt_pc10_http', type: 'payment_intent.succeeded', data: { object: { id: 'pi_x' } } });

const audit = createAuditWriter(createPrismaAuditSink(prisma), { ipSalt: SALT });
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crossclaim-pc10-'));
const storage = new LocalFileSystemStorage({ rootDir: storageRoot, secret: SALT, publicBaseUrl: 'http://localhost:3000' });
// PC-10：signing secret 只来自 server-side 配置；测试用值只在进程内设置，绝不打印。
process.env.PAYMENT_WEBHOOK_SECRET = SECRET;
const logLines: string[] = [];
const log = createLogger({
  level: 'warn',
  sink: (line: unknown) => {
    logLines.push(typeof line === 'string' ? line : JSON.stringify(line));
  },
});

function sign(body: string, timestamp: string = T): string {
  return createHmac('sha256', SECRET).update(timestamp + '.' + body, 'utf8').digest('hex');
}

async function withServer<T>(run: (base: string) => Promise<T>): Promise<T> {
  const server = createServer({ prisma, log, audit, storage });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await run('http://127.0.0.1:' + port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function post(base: string, options: { signature?: string; provider?: string; body?: string }) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.signature !== undefined) headers['stripe-signature'] = options.signature;
  if (options.provider !== undefined) headers['x-webhook-provider'] = options.provider;
  const response = await fetch(base + '/payments/webhook', {
    method: 'POST',
    headers,
    body: options.body ?? BODY,
  });
  return { status: response.status, raw: await response.text() };
}

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  delete process.env.PAYMENT_WEBHOOK_SECRET;
  await prisma.$disconnect();
  fs.rmSync(storageRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  logLines.length = 0;
  await prisma.paymentEvent.deleteMany({});
});

describe('PC-10 — webhook verification（HTTP + PostgreSQL）', () => {
  it('无效签名 → 400（既有稳定失败面），零业务写入，响应与日志不含 secret', async () => {
    await withServer(async (base) => {
      const result = await post(base, { signature: 't=' + T + ',v1=' + sign('tampered') });
      expect(result.status).toBe(400);
      expect(result.raw).not.toContain(SECRET);
      expect(await prisma.paymentEvent.count()).toBe(0);
      expect(logLines.join('\n')).not.toContain(SECRET);
    });
  });

  it('缺少签名 → 400，零业务写入', async () => {
    await withServer(async (base) => {
      const result = await post(base, {});
      expect(result.status).toBe(400);
      expect(await prisma.paymentEvent.count()).toBe(0);
    });
  });

  it('未知 provider（x-webhook-provider）→ 400，零业务写入', async () => {
    await withServer(async (base) => {
      const result = await post(base, { signature: 't=' + T + ',v1=' + sign(BODY), provider: 'NOT_A_PROVIDER' });
      expect(result.status).toBe(400);
      expect(await prisma.paymentEvent.count()).toBe(0);
    });
  });

  it('raw-byte 变异（原 body 加空格）→ 400，零业务写入', async () => {
    await withServer(async (base) => {
      const result = await post(base, { signature: 't=' + T + ',v1=' + sign(BODY), body: BODY + ' ' });
      expect(result.status).toBe(400);
      expect(await prisma.paymentEvent.count()).toBe(0);
    });
  });

  it('过期时间戳 → 400，零业务写入', async () => {
    await withServer(async (base) => {
      const oldT = String(Number(T) - 7200);
      const result = await post(base, { signature: 't=' + oldT + ',v1=' + sign(BODY, oldT) });
      expect(result.status).toBe(400);
      expect(await prisma.paymentEvent.count()).toBe(0);
    });
  });

  it('验签通过但无法归属租户 → 200 IGNORED，仍零业务写入（verification 先于持久化）', async () => {
    await withServer(async (base) => {
      const result = await post(base, { signature: 't=' + T + ',v1=' + sign(BODY) });
      expect(process.env.PAYMENT_WEBHOOK_SECRET).toBe(SECRET);
      expect(result.status).toBe(200);
      expect(JSON.parse(result.raw).processingResult).toBe('IGNORED');
      expect(await prisma.paymentEvent.count()).toBe(0);
    });
  });
});
