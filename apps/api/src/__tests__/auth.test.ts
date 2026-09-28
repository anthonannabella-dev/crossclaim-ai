/**
 * C-0008-A auth foundation unit tests (no database).
 */

import { describe, expect, it } from 'vitest';

import {
  AuthError,
  AuthValidationError,
  LOCK_DURATION_MS,
  assertPasswordPolicy,
  hashPassword,
  hashSessionToken,
  issueSession,
  loginWithPassword,
  resolveSession,
  resolveScryptParams,
  revokeSession,
  verifyPassword,
  type AuthUserRow,
  type SessionPort,
  type SessionRow,
} from '../services/auth';
import { createAuditWriter, type AuditLogInsert, type AuditLogRow, type AuditSink } from '../services/audit';

const ORG = 'e0000000-0000-4000-8000-000000000001';
const ORG_B = 'e0000000-0000-4000-8000-000000000002';
const USER = 'e0000000-0000-4000-8000-0000000000u1'.replace('u', 'a');
const SALT = 'gate6-auth-audit-salt-0123456789';
const FAST_PARAMS = { N: 1024, r: 8, p: 1, keyLength: 64 };
const NOW = new Date('2026-09-28T17:00:00Z');

class MemoryAuditSink implements AuditSink {
  rows: AuditLogInsert[] = [];
  async insert(row: AuditLogInsert) {
    this.rows.push(row);
    return { id: `audit-${this.rows.length}`, createdAt: row.createdAt };
  }
  async query(): Promise<AuditLogRow[]> {
    return [];
  }
}

function sessionFixture(options: { memberships?: Array<{ organizationId: string; userId: string; role: string }> } = {}) {
  const sink = new MemoryAuditSink();
  const rows = new Map<string, SessionRow>();
  let counter = 0;
  const touches: string[] = [];

  const sessions: SessionPort = {
    async create(row) {
      counter += 1;
      const id = `session-${counter}`;
      rows.set(row.tokenHash, {
        id,
        organizationId: row.organizationId,
        userId: row.userId,
        createdAt: row.createdAt,
        lastSeenAt: row.lastSeenAt,
        expiresAt: row.expiresAt,
        revokedAt: null,
      });
      return { id };
    },
    async findByTokenHash(tokenHash) {
      return rows.get(tokenHash) ?? null;
    },
    async touch(id, at) {
      touches.push(id);
      for (const row of rows.values()) if (row.id === id) row.lastSeenAt = at;
    },
    async revoke(id, at) {
      for (const row of rows.values()) if (row.id === id) row.revokedAt = at;
    },
    async revokeAllForUser(userId, at) {
      let count = 0;
      for (const row of rows.values()) {
        if (row.userId === userId && !row.revokedAt) {
          row.revokedAt = at;
          count += 1;
        }
      }
      return count;
    },
  };

  const memberships = options.memberships ?? [{ organizationId: ORG, userId: USER, role: 'OWNER' }];
  let clock = NOW;
  const deps = {
    sessions,
    memberships: {
      async findActive(organizationId: string, userId: string) {
        return memberships.find((m) => m.organizationId === organizationId && m.userId === userId) ?? null;
      },
      async listActiveForUser(userId: string) {
        return memberships.filter((m) => m.userId === userId);
      },
    },
    audit: createAuditWriter(sink, { ipSalt: SALT }),
    ipSalt: SALT,
    now: () => clock,
  };

  return { deps, sink, rows, touches, setClock: (date: Date) => { clock = date; } };
}

function userFixture(user: Partial<AuthUserRow> = {}) {
  const row: AuthUserRow = {
    id: USER,
    email: 'owner@example.com',
    passwordHash: null,
    status: 'ACTIVE',
    failedLogins: 0,
    lockedUntil: null,
    ...user,
  };
  const failures: Array<{ failedLogins: number; lockedUntil: Date | null }> = [];
  const successes: Date[] = [];
  return {
    row,
    failures,
    successes,
    port: {
      async findByEmail(email: string) {
        return email === row.email ? row : null;
      },
      async recordLoginSuccess(_userId: string, at: Date) {
        successes.push(at);
        row.failedLogins = 0;
        row.lockedUntil = null;
      },
      async recordLoginFailure(_userId: string, failedLogins: number, lockedUntil: Date | null) {
        failures.push({ failedLogins, lockedUntil });
        row.failedLogins = failedLogins;
        row.lockedUntil = lockedUntil;
      },
    },
  };
}

describe('C-0008-A — password hashing', () => {
  it('stores a self-describing scrypt hash and verifies it', () => {
    const hash = hashPassword('correct-horse-1', FAST_PARAMS);
    expect(hash.startsWith('scrypt$1024$8$1$')).toBe(true);
    expect(hash).not.toContain('correct-horse-1');
    expect(verifyPassword('correct-horse-1', hash)).toBe(true);
    expect(verifyPassword('wrong-horse-1', hash)).toBe(false);
    expect(verifyPassword('correct-horse-1', 'not-a-hash')).toBe(false);
  });

  it('enforces the password policy and configurable parameters', () => {
    expect(() => assertPasswordPolicy('short1')).toThrow(AuthValidationError);
    expect(() => assertPasswordPolicy('longenoughwithoutdigit')).toThrow(AuthValidationError);
    expect(() => hashPassword('no-digit-password', FAST_PARAMS)).toThrow(AuthValidationError);

    expect(resolveScryptParams({})).toEqual({ N: 32_768, r: 8, p: 1, keyLength: 64 });
    expect(resolveScryptParams({ PASSWORD_SCRYPT_N: '1024', PASSWORD_SCRYPT_R: '4' })).toMatchObject({
      N: 1024,
      r: 4,
      p: 1,
    });
    expect(resolveScryptParams({ PASSWORD_SCRYPT_N: 'abc' }).N).toBe(32_768);
  });
});

describe('C-0008-A — sessions', () => {
  it('issues a hashed session and resolves it through the membership check', async () => {
    const fixture = sessionFixture();
    const issued = await issueSession({ organizationId: ORG, userId: USER }, fixture.deps);

    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(fixture.rows.has(hashSessionToken(issued.token))).toBe(true);
    expect(fixture.rows.has(issued.token)).toBe(false);

    const context = await resolveSession(issued.token, fixture.deps);
    expect(context).toMatchObject({ organizationId: ORG, userId: USER, role: 'OWNER' });
    expect(context?.sessionId).toBe(issued.sessionId);
  });

  it('expires on idle timeout and on absolute expiry, with audit evidence', async () => {
    const fixture = sessionFixture();
    const issued = await issueSession({ organizationId: ORG, userId: USER }, fixture.deps);

    fixture.setClock(new Date(NOW.getTime() + 31 * 60 * 1000));
    expect(await resolveSession(issued.token, fixture.deps)).toBeNull();
    expect(fixture.sink.rows.some((row) => row.action === 'auth.session_expired')).toBe(true);

    const second = sessionFixture();
    const issued2 = await issueSession({ organizationId: ORG, userId: USER }, second.deps);
    second.setClock(new Date(NOW.getTime() + 13 * 60 * 60 * 1000));
    expect(await resolveSession(issued2.token, second.deps)).toBeNull();
  });

  it('requires an active membership and throttles lastSeenAt writes', async () => {
    const noMembership = sessionFixture({ memberships: [] });
    const issued = await issueSession({ organizationId: ORG, userId: USER }, noMembership.deps);
    expect(await resolveSession(issued.token, noMembership.deps)).toBeNull();

    const fixture = sessionFixture();
    const session = await issueSession({ organizationId: ORG, userId: USER }, fixture.deps);
    fixture.setClock(new Date(NOW.getTime() + 60 * 1000));
    expect(await resolveSession(session.token, fixture.deps)).not.toBeNull();
    expect(fixture.touches).toHaveLength(0);

    fixture.setClock(new Date(NOW.getTime() + 6 * 60 * 1000));
    expect(await resolveSession(session.token, fixture.deps)).not.toBeNull();
    expect(fixture.touches).toEqual([session.sessionId]);
  });

  it('rejects a foreign tenant and revoked sessions', async () => {
    const fixture = sessionFixture();
    const session = await issueSession({ organizationId: ORG, userId: USER }, fixture.deps);
    expect(await resolveSession(session.token, fixture.deps, ORG_B)).toBeNull();

    await revokeSession({ sessionId: session.sessionId, organizationId: ORG, reason: 'LOGOUT' }, fixture.deps);
    expect(await resolveSession(session.token, fixture.deps)).toBeNull();
    expect(fixture.sink.rows.some((row) => row.action === 'auth.session_revoked')).toBe(true);
  });
});

describe('C-0008-A — login', () => {
  const password = 'correct-horse-1';

  it('logs in successfully and never puts secrets in the audit trail', async () => {
    const fixture = sessionFixture();
    const user = userFixture({ passwordHash: hashPassword(password, FAST_PARAMS) });
    const result = await loginWithPassword(
      { email: 'Owner@Example.com', password, ip: '203.0.113.9', userAgent: 'vitest' },
      { users: user.port, session: fixture.deps, audit: fixture.deps.audit },
    );

    expect(result.organizationId).toBe(ORG);
    expect(result.role).toBe('OWNER');
    expect(user.successes).toHaveLength(1);
    const auditJson = JSON.stringify(fixture.sink.rows);
    expect(auditJson).not.toContain(password);
    expect(auditJson).not.toContain(result.token);
    expect(fixture.sink.rows.some((row) => row.action === 'auth.login_succeeded')).toBe(true);
  });

  it('counts failures and locks the account for 15 minutes after 5 attempts', async () => {
    const fixture = sessionFixture();
    const user = userFixture({ passwordHash: hashPassword(password, FAST_PARAMS) });
    const deps = { users: user.port, session: fixture.deps, audit: fixture.deps.audit, now: () => NOW };

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await expect(loginWithPassword({ email: user.row.email, password: 'wrong-horse-1' }, deps)).rejects.toThrow(
        AuthError,
      );
    }
    expect(user.failures).toHaveLength(4);
    expect(user.failures[3].lockedUntil).toBeNull();

    await expect(loginWithPassword({ email: user.row.email, password: 'wrong-horse-1' }, deps)).rejects.toThrow(
      AuthError,
    );
    expect(user.failures[4].failedLogins).toBe(5);
    expect(user.failures[4].lockedUntil?.getTime()).toBe(NOW.getTime() + LOCK_DURATION_MS);

    await expect(loginWithPassword({ email: user.row.email, password }, deps)).rejects.toThrow(/锁定/);
    const reasons = fixture.sink.rows
      .filter((row) => row.action === 'auth.login_failed')
      .map((row) => (row.changes as Record<string, unknown>).reason);
    expect(reasons).toContain('BAD_PASSWORD');
    expect(reasons).toContain('ACCOUNT_LOCKED');
  });

  it('rejects disabled accounts, unknown emails and ambiguous organizations', async () => {
    const disabled = userFixture({ passwordHash: hashPassword(password, FAST_PARAMS), status: 'DISABLED' });
    await expect(
      loginWithPassword(
        { email: disabled.row.email, password },
        { users: disabled.port, session: sessionFixture().deps, audit: sessionFixture().deps.audit },
      ),
    ).rejects.toThrow(/停用/);

    const unknown = userFixture();
    await expect(
      loginWithPassword(
        { email: 'nobody@example.com', password },
        { users: unknown.port, session: sessionFixture().deps, audit: sessionFixture().deps.audit },
      ),
    ).rejects.toThrow(AuthError);

    const twoOrgs = sessionFixture({
      memberships: [
        { organizationId: ORG, userId: USER, role: 'OWNER' },
        { organizationId: ORG_B, userId: USER, role: 'VIEWER' },
      ],
    });
    const user = userFixture({ passwordHash: hashPassword(password, FAST_PARAMS) });
    await expect(
      loginWithPassword(
        { email: user.row.email, password },
        { users: user.port, session: twoOrgs.deps, audit: twoOrgs.deps.audit },
      ),
    ).rejects.toThrow(/多个组织/);

    const pinned = await loginWithPassword(
      { email: user.row.email, password, organizationId: ORG_B },
      { users: user.port, session: twoOrgs.deps, audit: twoOrgs.deps.audit },
    );
    expect(pinned.organizationId).toBe(ORG_B);
  });
});
