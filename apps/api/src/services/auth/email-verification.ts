/**
 * PC-01B / P0 — EMAIL VERIFICATION LIFECYCLE + PASSWORD RECOVERY
 * ---------------------------------------------------------------
 * 授权：MSG-20261003-148 / MSG-20261003-149（POST-ACCEPTANCE GAP CLOSURE）
 *   APPROVE_WITH_REVISIONS。冻结边界：
 *     A. token 熵 ≥ 256-bit；库内**只存 digest**（SHA-256）；明文 token 不进库 / 不进日志 / 不进 AuditLog。
 *     B. resend 必须 supersede 该用户此前所有未消费的 verification token。
 *     C. email 验证原子：consume（CAS）→ 置 emailVerified=true；同一 token 并发最多一个成功。
 *     D. email 验证**不得**修改 passwordChangedAt。
 *     E. password reset 原子：consume → 新 hash → passwordChangedAt → 撤销全部 session；任一步失败全部回滚。
 *     F. forgot-password 不得通过 status / body / error code 暴露邮箱是否存在。
 *     G. EMAIL_DELIVERY = EXTERNAL_GATE：本模块只提供 disabled（默认）与 fake（测试）投递适配器。
 *
 * 边界：不接生产邮件服务 · 真实外写 HOLD · Payment = 0 · TRANSPORT=false。
 */

import { createHash, randomBytes } from 'node:crypto';

import type { AuditWriter } from '../audit';
import {
  DEFAULT_SCRYPT_PARAMS,
  assertPasswordPolicy,
  hashPassword,
  type ScryptParams,
} from './password';

/** verification 链接有效期（24h）。 */
export const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
/** reset 链接有效期（60min）。 */
export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;
/** 256-bit 令牌。 */
export const AUTH_TOKEN_BYTES = 32;

export type AuthTokenPurpose = 'EMAIL_VERIFICATION' | 'PASSWORD_RESET';

/** 令牌消费结果。`OK` 之外的取值都不得改变账号状态。 */
export type AuthTokenOutcome = 'OK' | 'INVALID' | 'EXPIRED' | 'ALREADY_CONSUMED' | 'SUPERSEDED';

export function newAuthToken(): string {
  return randomBytes(AUTH_TOKEN_BYTES).toString('base64url');
}

/** 只以 digest 落库 / 查询；token 明文永不持久化。 */
export function hashAuthToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** 请求方 IP 只存加盐哈希；缺 IP 或缺盐时不落库（不回退明文）。 */
export function hashRequesterIp(ip: string | undefined, salt: string | undefined): string | null {
  if (!ip || !salt) return null;
  return createHash('sha256').update(salt + '|' + ip, 'utf8').digest('hex');
}

export interface AuthAccountRow {
  id: string;
  email: string;
  emailVerified: boolean;
  status: string;
  /** 主租户（用于审计归属）；无成员身份时为 null。 */
  organizationId: string | null;
}

export interface AuthTokenAccountPort {
  findByEmail(email: string): Promise<AuthAccountRow | null>;
  findById(userId: string): Promise<AuthAccountRow | null>;
}

export interface EmailVerificationPort {
  /** B：把该用户既有的未消费 token 全部标记 superseded，返回受影响行数。 */
  supersedeUnconsumed(userId: string, at: Date): Promise<number>;
  create(row: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    createdAt: Date;
    requesterIpHash: string | null;
  }): Promise<{ id: string }>;
  /** C：原子 consume + 置 emailVerified=true（不得触碰 passwordChangedAt）。 */
  consumeAndVerify(input: {
    tokenHash: string;
    at: Date;
  }): Promise<{ outcome: AuthTokenOutcome; userId: string | null }>;
}

export interface PasswordResetPort {
  supersedeUnconsumed(userId: string, at: Date): Promise<number>;
  create(row: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    createdAt: Date;
    requesterIpHash: string | null;
  }): Promise<{ id: string }>;
  /** E：原子 consume → 改 hash → passwordChangedAt → 撤销全部 session。 */
  consumeAndResetPassword(input: {
    tokenHash: string;
    newPasswordHash: string;
    at: Date;
  }): Promise<{ outcome: AuthTokenOutcome; userId: string | null; revokedSessions: number }>;
}

export interface EmailDeliveryResult {
  delivered: boolean;
  provider: string;
}

export interface EmailDeliveryPort {
  deliver(input: {
    to: string;
    kind: AuthTokenPurpose;
    token: string;
    expiresAt: Date;
  }): Promise<EmailDeliveryResult>;
}

/** G：默认适配器 —— 不投递、不落盘 token，只登记投递意图（EXTERNAL_GATE）。 */
export function createDisabledEmailDelivery(): EmailDeliveryPort {
  return {
    async deliver() {
      return { delivered: false, provider: 'DISABLED_EXTERNAL_GATE' };
    },
  };
}

/** G：测试用 fake 适配器（内存 outbox；仅测试注入，不接生产邮件服务）。 */
export function createFakeEmailDelivery(): EmailDeliveryPort & {
  outbox: Array<{ to: string; kind: AuthTokenPurpose; token: string; expiresAt: Date }>;
} {
  const outbox: Array<{ to: string; kind: AuthTokenPurpose; token: string; expiresAt: Date }> = [];
  return {
    outbox,
    async deliver(input) {
      outbox.push(input);
      return { delivered: true, provider: 'FAKE_TEST' };
    },
  };
}

export interface AuthLifecycleDeps {
  accounts: AuthTokenAccountPort;
  emailVerification: EmailVerificationPort;
  passwordReset: PasswordResetPort;
  delivery: EmailDeliveryPort;
  audit?: AuditWriter;
  log?: (event: string, fields: Record<string, unknown>) => void;
  scrypt?: ScryptParams;
  now?: () => Date;
  ipSalt?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeAuthEmail(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

async function safeAudit(
  deps: AuthLifecycleDeps,
  event: {
    organizationId: string | null;
    actorType: 'SYSTEM';
    actorRef: string;
    action: string;
    entityType: string;
    entityId: string;
    changes: Record<string, unknown>;
  },
): Promise<void> {
  if (!deps.audit || !event.organizationId) {
    deps.log?.('auth_lifecycle_audit_skipped', { action: event.action });
    return;
  }
  await deps.audit
    .record({
      organizationId: event.organizationId,
      actorType: event.actorType,
      actorRef: event.actorRef,
      action: event.action,
      entityType: event.entityType,
      entityId: event.entityId,
      changes: event.changes,
    })
    .catch((error: unknown) => {
      deps.log?.('auth_lifecycle_audit_failed', {
        action: event.action,
        reason: error instanceof Error ? error.message : 'unknown',
      });
    });
}

export interface RequestVerificationInput {
  userId: string | unknown;
  ip?: string | undefined;
}

export interface RequestVerificationResult {
  issued: boolean;
  reason: 'ISSUED' | 'ACCOUNT_NOT_FOUND' | 'ALREADY_VERIFIED' | 'INVALID_USER';
  expiresAt: Date | null;
  delivery: EmailDeliveryResult | null;
  supersededTokens: number;
}

/**
 * 触发（或重发）邮箱验证。B：先 supersede 旧 token，再签发新 token。
 * 明文 token 只交给投递适配器，绝不返回给调用方（HTTP 层因此不可能泄漏）。
 */
export async function requestEmailVerification(
  input: RequestVerificationInput,
  deps: AuthLifecycleDeps,
): Promise<RequestVerificationResult> {
  const now = deps.now ?? (() => new Date());
  const at = now();
  const userId = typeof input.userId === 'string' ? input.userId : '';
  if (!userId) {
    return { issued: false, reason: 'INVALID_USER', expiresAt: null, delivery: null, supersededTokens: 0 };
  }

  const account = await deps.accounts.findById(userId);
  if (!account) {
    return { issued: false, reason: 'ACCOUNT_NOT_FOUND', expiresAt: null, delivery: null, supersededTokens: 0 };
  }
  if (account.emailVerified) {
    return { issued: false, reason: 'ALREADY_VERIFIED', expiresAt: null, delivery: null, supersededTokens: 0 };
  }

  const supersededTokens = await deps.emailVerification.supersedeUnconsumed(account.id, at);
  const token = newAuthToken();
  const expiresAt = new Date(at.getTime() + EMAIL_VERIFICATION_TTL_MS);
  const created = await deps.emailVerification.create({
    userId: account.id,
    tokenHash: hashAuthToken(token),
    expiresAt,
    createdAt: at,
    requesterIpHash: hashRequesterIp(input.ip, deps.ipSalt),
  });
  const delivery = await deps.delivery.deliver({
    to: account.email,
    kind: 'EMAIL_VERIFICATION',
    token,
    expiresAt,
  });

  await safeAudit(deps, {
    organizationId: account.organizationId,
    actorType: 'SYSTEM',
    actorRef: 'auth-service',
    action: 'user.email_verification_requested',
    entityType: 'EmailVerificationToken',
    entityId: created.id,
    changes: {
      userId: account.id,
      expiresAt: expiresAt.toISOString(),
      supersededTokens,
      delivered: delivery.delivered,
      deliveryProvider: delivery.provider,
    },
  });

  return { issued: true, reason: 'ISSUED', expiresAt, delivery, supersededTokens };
}

export interface VerifyEmailInput {
  token: unknown;
}

export interface VerifyEmailResult {
  outcome: AuthTokenOutcome;
  userId: string | null;
}

/** C：原子消费 verification token 并置 emailVerified=true。 */
export async function verifyEmailWithToken(
  input: VerifyEmailInput,
  deps: AuthLifecycleDeps,
): Promise<VerifyEmailResult> {
  const now = deps.now ?? (() => new Date());
  const token = typeof input.token === 'string' ? input.token.trim() : '';
  if (!token) return { outcome: 'INVALID', userId: null };

  const result = await deps.emailVerification.consumeAndVerify({ tokenHash: hashAuthToken(token), at: now() });
  if (result.outcome !== 'OK' || !result.userId) return result;

  const account = await deps.accounts.findById(result.userId);
  await safeAudit(deps, {
    organizationId: account?.organizationId ?? null,
    actorType: 'SYSTEM',
    actorRef: 'auth-service',
    action: 'user.email_verified',
    entityType: 'User',
    entityId: result.userId,
    changes: { emailVerified: true, source: 'EMAIL_VERIFICATION_LINK' },
  });
  return result;
}

/** 便于 HTTP 层统一口径：任何非 OK 结果都不得改变账号状态。 */
export function isVerifiedOutcome(outcome: AuthTokenOutcome): boolean {
  return outcome === 'OK';
}

export interface RequestPasswordResetResult {
  /** F：对外永远同形（不区分邮箱是否存在 / 是否已停用）。 */
  accepted: true;
}

export async function requestPasswordReset(
  input: { email: unknown; ip?: string | undefined },
  deps: AuthLifecycleDeps,
): Promise<RequestPasswordResetResult> {
  const now = deps.now ?? (() => new Date());
  const at = now();
  const email = normalizeAuthEmail(input.email);

  if (!email || email.length > 254 || !EMAIL_RE.test(email)) return { accepted: true };

  const account = await deps.accounts.findByEmail(email);
  if (!account || account.status !== 'ACTIVE') {
    deps.log?.('password_reset_requested', { matched: false });
    return { accepted: true };
  }

  const supersededTokens = await deps.passwordReset.supersedeUnconsumed(account.id, at);
  const token = newAuthToken();
  const expiresAt = new Date(at.getTime() + PASSWORD_RESET_TTL_MS);
  const created = await deps.passwordReset.create({
    userId: account.id,
    tokenHash: hashAuthToken(token),
    expiresAt,
    createdAt: at,
    requesterIpHash: hashRequesterIp(input.ip, deps.ipSalt),
  });
  const delivery = await deps.delivery.deliver({
    to: account.email,
    kind: 'PASSWORD_RESET',
    token,
    expiresAt,
  });

  await safeAudit(deps, {
    organizationId: account.organizationId,
    actorType: 'SYSTEM',
    actorRef: 'auth-service',
    action: 'user.password_reset_requested',
    entityType: 'PasswordResetToken',
    entityId: created.id,
    changes: {
      userId: account.id,
      expiresAt: expiresAt.toISOString(),
      supersededTokens,
      delivered: delivery.delivered,
      deliveryProvider: delivery.provider,
    },
  });

  return { accepted: true };
}

export interface ResetPasswordResult {
  outcome: AuthTokenOutcome;
  userId: string | null;
  revokedSessions: number;
}

/** E：原子 reset（consume + hash + passwordChangedAt + revoke all sessions）。 */
export async function resetPasswordWithToken(
  input: { token: unknown; newPassword: unknown },
  deps: AuthLifecycleDeps,
): Promise<ResetPasswordResult> {
  const now = deps.now ?? (() => new Date());
  const token = typeof input.token === 'string' ? input.token.trim() : '';
  const newPassword = typeof input.newPassword === 'string' ? input.newPassword : '';

  assertPasswordPolicy(newPassword);
  if (!token) return { outcome: 'INVALID', userId: null, revokedSessions: 0 };

  const newPasswordHash = hashPassword(newPassword, deps.scrypt ?? DEFAULT_SCRYPT_PARAMS);
  const result = await deps.passwordReset.consumeAndResetPassword({
    tokenHash: hashAuthToken(token),
    newPasswordHash,
    at: now(),
  });
  if (result.outcome !== 'OK' || !result.userId) return result;

  const account = await deps.accounts.findById(result.userId);
  await safeAudit(deps, {
    organizationId: account?.organizationId ?? null,
    actorType: 'SYSTEM',
    actorRef: 'auth-service',
    action: 'user.password_reset_completed',
    entityType: 'User',
    entityId: result.userId,
    changes: { passwordChanged: true, revokedSessions: result.revokedSessions },
  });
  return result;
}
