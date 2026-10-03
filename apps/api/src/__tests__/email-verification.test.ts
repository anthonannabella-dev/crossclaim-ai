/**
 * PC-01B / P0 — EMAIL VERIFICATION + PASSWORD RECOVERY（单元层，内存端口）
 * 验收 MSG-20261003-148/149 A–F：256-bit 熵 / 只存 digest / supersede / 原子消费 /
 * 不改 passwordChangedAt / reset 撤销全部 session / forgot 不暴露存在性。
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  EMAIL_VERIFICATION_TTL_MS,
  PASSWORD_RESET_TTL_MS,
  createFakeEmailDelivery,
  hashAuthToken,
  newAuthToken,
  requestEmailVerification,
  requestPasswordReset,
  resetPasswordWithToken,
  verifyEmailWithToken,
  type AuthAccountRow,
  type AuthLifecycleDeps,
  type AuthTokenOutcome,
  type EmailVerificationPort,
  type PasswordResetPort,
} from '../services/auth/email-verification';
import { verifyPassword } from '../services/auth/password';

interface TokenRow {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  createdAt?: Date;
  requesterIpHash?: string | null;
  consumedAt: Date | null;
  supersededAt: Date | null;
}

function harness(seed?: { accounts?: AuthAccountRow[]; sessions?: number }) {
  const accounts = new Map<string, AuthAccountRow & { passwordChangedAt: Date | null; passwordHash: string | null }>();
  for (const row of seed?.accounts ?? []) {
    accounts.set(row.id, { ...row, passwordChangedAt: null, passwordHash: null });
  }
  const verification: TokenRow[] = [];
  const reset: TokenRow[] = [];
  const audits: Array<{ action: string; changes: Record<string, unknown> }> = [];
  let activeSessions = seed?.sessions ?? 0;

  const find = (rows: TokenRow[], tokenHash: string) => rows.find((row) => row.tokenHash === tokenHash) ?? null;
  const supersede = (rows: TokenRow[], userId: string, at: Date) => {
    let count = 0;
    for (const row of rows) {
      if (row.userId !== userId || row.consumedAt || row.supersededAt) continue;
      row.supersededAt = at;
      count += 1;
    }
    return count;
  };
  const classify = (row: TokenRow | null, at: Date): AuthTokenOutcome => {
    if (!row) return 'INVALID';
    if (row.consumedAt) return 'ALREADY_CONSUMED';
    if (row.supersededAt) return 'SUPERSEDED';
    if (row.expiresAt.getTime() <= at.getTime()) return 'EXPIRED';
    return 'OK';
  };

  const emailVerification: EmailVerificationPort = {
    async supersedeUnconsumed(userId, at) {
      return supersede(verification, userId, at);
    },
    async create(row) {
      const id = randomUUID();
      verification.push({ id, ...row, consumedAt: null, supersededAt: null });
      return { id };
    },
    async consumeAndVerify({ tokenHash, at }) {
      const row = find(verification, tokenHash);
      const outcome = classify(row, at);
      if (outcome !== 'OK' || !row) return { outcome, userId: row?.userId ?? null };
      row.consumedAt = at;
      const account = accounts.get(row.userId);
      if (account) account.emailVerified = true;
      return { outcome: 'OK', userId: row.userId };
    },
  };

  const passwordReset: PasswordResetPort = {
    async supersedeUnconsumed(userId, at) {
      return supersede(reset, userId, at);
    },
    async create(row) {
      const id = randomUUID();
      reset.push({ id, ...row, consumedAt: null, supersededAt: null });
      return { id };
    },
    async consumeAndResetPassword({ tokenHash, newPasswordHash, at }) {
      const row = find(reset, tokenHash);
      const outcome = classify(row, at);
      if (outcome !== 'OK' || !row) return { outcome, userId: row?.userId ?? null, revokedSessions: 0 };
      row.consumedAt = at;
      const account = accounts.get(row.userId);
      if (account) {
        account.passwordHash = newPasswordHash;
        account.passwordChangedAt = at;
      }
      const revokedSessions = activeSessions;
      activeSessions = 0;
      return { outcome: 'OK', userId: row.userId, revokedSessions };
    },
  };

  const delivery = createFakeEmailDelivery();
  const deps: AuthLifecycleDeps = {
    accounts: {
      async findByEmail(email) {
        for (const row of accounts.values()) {
          if (row.email === email) return row;
        }
        return null;
      },
      async findById(userId) {
        return accounts.get(userId) ?? null;
      },
    },
    emailVerification,
    passwordReset,
    delivery,
    audit: {
      async record(event) {
        audits.push({ action: event.action, changes: (event.changes ?? {}) as Record<string, unknown> });
        return { id: randomUUID(), createdAt: new Date() };
      },
    },
    ipSalt: 'unit-test-ip-salt-0123456789',
  };

  return { deps, accounts, verification, reset, delivery, audits, activeSessions: () => activeSessions };
}

const ORG = '11111111-1111-4111-8111-111111111111';
const account = (overrides: Partial<AuthAccountRow> = {}): AuthAccountRow => ({
  id: randomUUID(),
  email: 'user-' + randomUUID().slice(0, 8) + '@example.com',
  emailVerified: false,
  status: 'ACTIVE',
  organizationId: ORG,
  ...overrides,
});

describe('PC-01B — email verification / password recovery（单元）', () => {
  it('A：token ≥ 256-bit，库内只存 SHA-256 digest', () => {
    const token = newAuthToken();
    expect(token.length).toBeGreaterThanOrEqual(43); // 32 bytes base64url
    expect(newAuthToken()).not.toBe(token);
    const digest = hashAuthToken(token);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).toBe(hashAuthToken(token)); // 确定性
    expect(digest).not.toContain(token);
    expect(EMAIL_VERIFICATION_TTL_MS).toBe(24 * 60 * 60 * 1000);
    expect(PASSWORD_RESET_TTL_MS).toBe(60 * 60 * 1000);
  });

  it('B：重发 supersede 旧 token，旧链接不再可用', async () => {
    const user = account();
    const h = harness({ accounts: [user] });
    const first = await requestEmailVerification({ userId: user.id }, h.deps);
    const firstToken = h.delivery.outbox[0]!.token;
    expect(first.issued).toBe(true);

    const second = await requestEmailVerification({ userId: user.id }, h.deps);
    expect(second.supersededTokens).toBe(1);
    const secondToken = h.delivery.outbox[1]!.token;
    expect(secondToken).not.toBe(firstToken);

    expect((await verifyEmailWithToken({ token: firstToken }, h.deps)).outcome).toBe('SUPERSEDED');
    expect(h.accounts.get(user.id)!.emailVerified).toBe(false);
    expect((await verifyEmailWithToken({ token: secondToken }, h.deps)).outcome).toBe('OK');
    expect(h.accounts.get(user.id)!.emailVerified).toBe(true);
  });

  it('C ：同一 token 只能成功消费一次；未知 token = INVALID', async () => {
    const user = account();
    const h = harness({ accounts: [user] });
    await requestEmailVerification({ userId: user.id }, h.deps);
    const token = h.delivery.outbox[0]!.token;
    expect((await verifyEmailWithToken({ token }, h.deps)).outcome).toBe('OK');
    expect((await verifyEmailWithToken({ token }, h.deps)).outcome).toBe('ALREADY_CONSUMED');
    expect((await verifyEmailWithToken({ token: 'not-a-real-token' }, h.deps)).outcome).toBe('INVALID');
    expect((await verifyEmailWithToken({ token: '' }, h.deps)).outcome).toBe('INVALID');
  });

  it('C2：过期 token = EXPIRED，且不改变 emailVerified', async () => {
    const user = account();
    const h = harness({ accounts: [user] });
    const expired = newAuthToken();
    h.verification.push({
      id: randomUUID(),
      userId: user.id,
      tokenHash: hashAuthToken(expired),
      expiresAt: new Date(Date.now() - 1000),
      consumedAt: null,
      supersededAt: null,
    });
    expect((await verifyEmailWithToken({ token: expired }, h.deps)).outcome).toBe('EXPIRED');
    expect(h.accounts.get(user.id)!.emailVerified).toBe(false);
  });

  it('D：邮箱验证不动 passwordChangedAt', async () => {
    const user = account();
    const h = harness({ accounts: [user] });
    const before = h.accounts.get(user.id)!.passwordChangedAt;
    await requestEmailVerification({ userId: user.id }, h.deps);
    await verifyEmailWithToken({ token: h.delivery.outbox[0]!.token }, h.deps);
    expect(h.accounts.get(user.id)!.passwordChangedAt).toBe(before);
    expect(h.accounts.get(user.id)!.passwordChangedAt).toBeNull();
  });

  it('E：reset 原子生效（改 hash + passwordChangedAt + 撤销全部 session）', async () => {
    const user = account();
    const h = harness({ accounts: [user], sessions: 3 });
    await expect(
      resetPasswordWithToken({ token: 'whatever', newPassword: 'short' }, h.deps),
    ).rejects.toThrow();

    await requestPasswordReset({ email: user.email }, h.deps);
    const token = h.delivery.outbox[0]!.token;
    const result = await resetPasswordWithToken({ token, newPassword: 'reset-pass-1234' }, h.deps);
    expect(result.outcome).toBe('OK');
    expect(result.revokedSessions).toBe(3);
    expect(h.activeSessions()).toBe(0);
    expect(h.accounts.get(user.id)!.passwordChangedAt).not.toBeNull();
    expect(verifyPassword('reset-pass-1234', h.accounts.get(user.id)!.passwordHash!)).toBe(true);
    // 同一 reset token 不得二次使用
    expect((await resetPasswordWithToken({ token, newPassword: 'reset-pass-5678' }, h.deps)).outcome).toBe(
      'ALREADY_CONSUMED',
    );
  });

  it('F：forgot-password 对存在/不存在邮箱返回完全相同的对外结果', async () => {
    const user = account();
    const h = harness({ accounts: [user] });
    const existing = await requestPasswordReset({ email: user.email }, h.deps);
    const unknown = await requestPasswordReset({ email: 'nobody-' + randomUUID().slice(0, 8) + '@example.com' }, h.deps);
    expect(existing).toEqual(unknown);
    expect(existing).toEqual({ accepted: true });
    expect(h.reset.length).toBe(1); // 只有存在的邮箱签发了 token
    expect(h.delivery.outbox.length).toBe(1);
    // 停用账号同样不签发
    const disabled = account({ status: 'DISABLED' });
    h.accounts.set(disabled.id, { ...disabled, passwordChangedAt: null, passwordHash: null });
    expect(await requestPasswordReset({ email: disabled.email }, h.deps)).toEqual({ accepted: true });
    expect(h.reset.length).toBe(1);
  });

  it('审计不含明文 token（A：token 不进 AuditLog）', async () => {
    const user = account();
    const h = harness({ accounts: [user] });
    await requestEmailVerification({ userId: user.id }, h.deps);
    const token = h.delivery.outbox[0]!.token;
    await verifyEmailWithToken({ token }, h.deps);
    await requestPasswordReset({ email: user.email }, h.deps);
    const resetToken = h.delivery.outbox[1]!.token;
    await resetPasswordWithToken({ token: resetToken, newPassword: 'reset-pass-1234' }, h.deps);

    expect(h.audits.map((row) => row.action)).toEqual([
      'user.email_verification_requested',
      'user.email_verified',
      'user.password_reset_requested',
      'user.password_reset_completed',
    ]);
    const payload = JSON.stringify(h.audits);
    expect(payload).not.toContain(token);
    expect(payload).not.toContain(resetToken);
    expect(payload).not.toContain('passwordHash');
  });

  it('已验证账号不得再次签发验证 token', async () => {
    const user = account({ emailVerified: true });
    const h = harness({ accounts: [user] });
    const result = await requestEmailVerification({ userId: user.id }, h.deps);
    expect(result.issued).toBe(false);
    expect(result.reason).toBe('ALREADY_VERIFIED');
    expect(h.verification.length).toBe(0);
    expect(h.delivery.outbox.length).toBe(0);
  });
});
