/**
 * C-0008-B1 — every request must produce exactly one structured log line.
 * ---------------------------------------------------------------------
 * The C-0008-A endpoints (/auth/*, /uploads, /imports, /opportunities) and the
 * C-0008-B1 endpoints (/connections*) write their responses directly, so the
 * request log moved to the response `finish` event in server.ts. This test
 * pins that behaviour down: one line per request, real status code, and the
 * /files/<token> path stays redacted.
 */

import type { PrismaClient } from '@prisma/client';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';

import { createLogger } from '../config/logger';
import { createServer, type ServerDeps } from '../server';
import type { AuditWriter } from '../services/audit';
import type { AuthRouteDeps } from '../services/auth';

const ORG = '11111111-1111-4111-8111-111111111111';
const SALT = 'gate6-http-logging-salt-01234567';
const SECRET_PATH = 'AAAA.BBBB.CCCC';

function stubPrisma(): PrismaClient {
  return {
    auditLog: {
      create: async () => ({ id: 'audit-1', createdAt: new Date() }),
      findMany: async () => [],
    },
    $queryRaw: async () => [{ ok: 1 }],
  } as unknown as PrismaClient;
}

function stubAuth(audit: AuditWriter): AuthRouteDeps {
  return {
    users: { findByEmail: async () => null },
    session: {
      sessions: {
        create: async () => ({ id: 's' }),
        findByTokenHash: async () => null,
        touch: async () => undefined,
        revoke: async () => undefined,
        revokeAllForUser: async () => 0,
      },
      memberships: { findActive: async () => null },
      audit,
      ipSalt: SALT,
    },
    audit,
  } as unknown as AuthRouteDeps;
}

const stubAudit = { record: async () => ({ id: 'a' }) } as unknown as AuditWriter;

async function withServer<T>(deps: Partial<ServerDeps>, run: (base: string) => Promise<T>): Promise<T> {
  const server = createServer({
    prisma: stubPrisma(),
    log: deps.log ?? createLogger({ level: 'error', sink: () => undefined }),
    auth: stubAuth(stubAudit),
    ...deps,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function requestLines(lines: string[]): Array<Record<string, unknown>> {
  return lines
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry.msg === 'http_request');
}

describe('C-0008-B1 — 统一请求日志', () => {
  it('每个请求恰好一条 http_request，状态码真实，/files 路径被脱敏', async () => {
    const lines: string[] = [];
    const log = createLogger({ level: 'info', sink: (line) => lines.push(line) });

    await withServer({ log }, async (base) => {
      const unauth = await fetch(`${base}/auth/me`);
      expect(unauth.status).toBe(401);

      const connections = await fetch(`${base}/connections`);
      expect(connections.status).toBe(401);

      const review = await fetch(`${base}/opportunities/${ORG}/qualify`, { method: 'POST' });
      expect(review.status).toBe(401);

      const unknown = await fetch(`${base}/nope`);
      expect(unknown.status).toBe(404);

      const file = await fetch(`${base}/files/${SECRET_PATH}`);
      expect([400, 403, 503]).toContain(file.status);
    });

    const entries = requestLines(lines);
    expect(entries).toHaveLength(5);

    const byPath = Object.fromEntries(entries.map((entry) => [entry.path, entry.status]));
    expect(byPath).toMatchObject({
      '/auth/me': 401,
      '/connections': 401,
      [`/opportunities/${ORG}/qualify`]: 401,
      '/nope': 404,
      '/files/[REDACTED]': expect.any(Number),
    });

    for (const entry of entries) {
      expect(typeof entry.ms).toBe('number');
      expect(entry.method).toBeTruthy();
    }

    const all = lines.join('\n');
    expect(all).not.toContain(SECRET_PATH);
    expect(all).toContain('/files/[REDACTED]');
  });
});
