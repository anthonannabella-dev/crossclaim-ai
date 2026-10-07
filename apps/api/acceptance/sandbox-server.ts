/**
 * CUSTOMER-UX-SANDBOX-E2E — dev/test-only acceptance API bootstrap.
 * ---------------------------------------------------------------
 * 目的：让「真实浏览器 + 真实 HTTP + 真实 PostgreSQL」的客户旅程可以走完
 * **注册 → 邮箱验证 → 登录**，而生产 runtime 一行都不改。
 *
 * 做法：用与生产完全相同的 `createServer()`，只把两处按注入点替换成 sandbox 版本：
 *   1) `signupEnabled = true`（生产默认 fail-closed 关闭）；
 *   2) `lifecycle.delivery` 换成 sandbox sink —— 把验证邮件写进
 *      `reports/acceptance/email-outbox.jsonl`（生产是 EXTERNAL_GATE 的 disabled delivery）。
 * 其余（Prisma / 权限 / 会话 / 审计 / 所有业务路由）与生产一致。
 *
 * 运行：apps/api 下 `npx tsx acceptance/sandbox-server.ts`
 * 端口：ACCEPTANCE_API_PORT（默认 3100）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PrismaClient } from '@prisma/client';

import { createLogger } from '../src/config/logger';
import { createDefaultReadDeps, createServer } from '../src/server';
import { createAuditWriter, createPrismaAuditSink } from '../src/services/audit';
import {
  bootstrapSelfServiceAccount,
  createPrismaAuthTokenAccountPort,
  createPrismaAuthUserPort,
  createPrismaEmailVerificationPort,
  createPrismaMembershipLookup,
  createPrismaPasswordResetPort,
  createPrismaSessionPort,
  type EmailDeliveryPort,
} from '../src/services/auth';
import { LocalFileSystemStorage } from '../src/services/storage';

const PORT = Number(process.env.ACCEPTANCE_API_PORT ?? 3100);
const REPO_ROOT = path.resolve(__dirname, '../../..');
const OUTBOX =
  process.env.ACCEPTANCE_OUTBOX ?? path.join(REPO_ROOT, 'reports', 'acceptance', 'email-outbox.jsonl');
const IP_SALT = 'acceptance-audit-salt-20261007';

/** sandbox 邮件出口：只落文件，绝不外发；与生产 `createDisabledEmailDelivery()` 同一端口形状。 */
const sandboxDelivery: EmailDeliveryPort = {
  async deliver(input) {
    fs.mkdirSync(path.dirname(OUTBOX), { recursive: true });
    fs.appendFileSync(
      OUTBOX,
      JSON.stringify({
        to: input.to,
        kind: input.kind,
        token: input.token,
        expiresAt: input.expiresAt instanceof Date ? input.expiresAt.toISOString() : input.expiresAt,
        at: new Date().toISOString(),
      }) + '\n',
      'utf8',
    );
    return { delivered: true, provider: 'SANDBOX_ACCEPTANCE_SINK' };
  },
};

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const log = createLogger({ level: 'warn', sink: () => undefined });
  const storage = new LocalFileSystemStorage({
    rootDir: process.env.ACCEPTANCE_STORAGE_ROOT ?? path.join(os.tmpdir(), 'crossclaim-acceptance-storage'),
    secret: 'acceptance-storage-secret-20261007',
    publicBaseUrl: 'http://127.0.0.1:' + PORT,
  });
  const audit = createAuditWriter(createPrismaAuditSink(prisma), { ipSalt: IP_SALT });
  const safeLog = (event: string, fields: Record<string, unknown>) => log.warn(event, fields);

  const auth = {
    users: createPrismaAuthUserPort(prisma),
    session: {
      sessions: createPrismaSessionPort(prisma),
      memberships: createPrismaMembershipLookup(prisma),
      audit,
      ipSalt: IP_SALT,
    },
    audit,
    log: safeLog,
    signupEnabled: true,
    selfSignup: (input: { email: string; password: string; organizationName: string; displayName?: string }) =>
      bootstrapSelfServiceAccount(prisma, input, { enabled: true }),
    lifecycle: {
      accounts: createPrismaAuthTokenAccountPort(prisma),
      emailVerification: createPrismaEmailVerificationPort(prisma),
      passwordReset: createPrismaPasswordResetPort(prisma),
      delivery: sandboxDelivery,
      audit,
      log: safeLog,
      ipSalt: IP_SALT,
    },
  };

  const server = createServer({
    prisma,
    log,
    storage,
    audit,
    auth,
    ...createDefaultReadDeps(prisma),
  } as never);

  server.listen(PORT, '127.0.0.1', () => {
    // 只打印机器可读的就绪行，供 harness 等待；不打印任何密钥。
    console.log(
      JSON.stringify({ event: 'ACCEPTANCE_API_READY', port: PORT, outbox: OUTBOX, signupEnabled: true }),
    );
  });

  const shutdown = async () => {
    server.close();
    await prisma.$disconnect().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

void main();
