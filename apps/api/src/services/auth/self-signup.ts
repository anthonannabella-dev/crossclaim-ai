/**
 * TRACK A / PC-01A — SELF-SERVICE BOOTSTRAP FOUNDATION.
 * ---------------------------------------------------------------
 * 授权：MSG-20261002-81（PC-01 = AUTHORIZED AS PC-01A；**不得**直接开放 production public signup）。
 *
 * 冻结约束（MSG-81 ⑤）：
 *   A. Atomic bootstrap：User + Organization + Membership(role=OWNER) 同一事务，任一步失败全回滚；
 *      绝不产生「User 无 Organization」或「Organization 无 OWNER」。
 *   B. Existing user protection：同 email 已存在 → 稳定拒绝（EMAIL_ALREADY_REGISTERED），
 *      不得建第二个 User，也不得把既有 User 自动加入新 Organization。
 *   C. Organization identity：name 必填；slug 由服务端规范化、唯一、冲突安全；不信 client slug。
 *   D. OWNER issuance：只有本 bootstrap 事务可为新 Organization 建立唯一 OWNER；
 *      普通成员只能走 invitation / admin membership flow。
 *   E. Password handling：复用既有 auth password hashing / policy；禁止明文与 hash 进入审计。
 *   F. Email verification state：新 User `emailVerified = false`（不得伪造 true）。
 *   G. Session issuance：本服务**不发放**任何 session（未验证邮箱不得获得 production-capable session）。
 *   H. Feature gate：默认 `PUBLIC_SIGNUP_ENABLED=false`（fail-closed）。
 *   I. Audit：`user.self_signup_created` + `organization.bootstrapped`，不含 password / hash / token / secret。
 *
 * 边界：NO platform write · Payment = 0 · TRANSPORT=false · 无生产凭据。
 */

import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import {
  AuthValidationError,
  DEFAULT_SCRYPT_PARAMS,
  assertPasswordPolicy,
  hashPassword,
  type ScryptParams,
} from './password';

export type SelfSignupErrorCode =
  | 'SIGNUP_DISABLED'
  | 'INVALID_EMAIL'
  | 'INVALID_INPUT'
  | 'ORGANIZATION_NAME_REQUIRED'
  | 'EMAIL_ALREADY_REGISTERED';

export class SelfSignupError extends Error {
  readonly code: SelfSignupErrorCode;
  constructor(code: SelfSignupErrorCode, message: string) {
    super(message);
    this.name = 'SelfSignupError';
    this.code = code;
  }
}

/** 环境开关名（PC-01H）：默认关闭。 */
export const PUBLIC_SIGNUP_FLAG = 'PUBLIC_SIGNUP_ENABLED';

export function isPublicSignupEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[PUBLIC_SIGNUP_FLAG] === 'true';
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_MAX = 254;
const ORGANIZATION_NAME_MAX = 120;
const DISPLAY_NAME_MAX = 80;

export function normalizeEmail(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

/** server-side slug 规范化：小写、非字母数字折叠为 '-'、去首尾、限长；空值回退 'org'。 */
export function normalizeOrganizationSlug(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    // 先剥离组合音标（Ü → U + U+0308 → U），避免把音标折叠成连字符。
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || 'org';
}

type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

/** 冲突安全：base、base-2 … base-20，仍冲突则加随机后缀。 */
async function resolveUniqueSlug(tx: Tx, organizationName: string): Promise<string> {
  const base = normalizeOrganizationSlug(organizationName);
  for (let index = 0; index < 20; index += 1) {
    const candidate = index === 0 ? base : base + '-' + (index + 1);
    const existing = await tx.organization.findUnique({ where: { slug: candidate }, select: { id: true } });
    if (!existing) return candidate;
  }
  return base + '-' + randomUUID().slice(0, 8);
}

export interface SelfSignupInput {
  email: unknown;
  password: unknown;
  organizationName: unknown;
  displayName?: unknown;
  /** 客户端**不得**提交可信角色；存在也被忽略（D）。 */
  role?: unknown;
  /** 客户端**不得**提交可信 slug；存在也被忽略（C）。 */
  slug?: unknown;
}

export interface SelfSignupDeps {
  enabled?: boolean;
  now?: () => Date;
  scrypt?: ScryptParams;
}

export interface SelfSignupResult {
  userId: string;
  organizationId: string;
  organizationSlug: string;
  role: 'OWNER';
  emailVerified: false;
  sessionIssued: false;
}

export async function bootstrapSelfServiceAccount(
  prisma: PrismaClient,
  input: SelfSignupInput,
  deps: SelfSignupDeps = {},
): Promise<SelfSignupResult> {
  if (!(deps.enabled ?? isPublicSignupEnabled())) {
    throw new SelfSignupError('SIGNUP_DISABLED', '自助注册当前不可用');
  }

  const email = normalizeEmail(input.email);
  if (!email || email.length > EMAIL_MAX || !EMAIL_RE.test(email)) {
    throw new SelfSignupError('INVALID_EMAIL', '邮箱格式不正确');
  }

  const password = typeof input.password === 'string' ? input.password : '';
  try {
    assertPasswordPolicy(password);
  } catch (error) {
    throw new SelfSignupError(
      'INVALID_INPUT',
      error instanceof AuthValidationError ? error.message : '密码不满足安全策略',
    );
  }

  const organizationName =
    typeof input.organizationName === 'string' ? input.organizationName.trim() : '';
  if (!organizationName) {
    throw new SelfSignupError('ORGANIZATION_NAME_REQUIRED', '组织名称不能为空');
  }
  if (organizationName.length > ORGANIZATION_NAME_MAX) {
    throw new SelfSignupError('INVALID_INPUT', '组织名称过长');
  }

  const displayName =
    (typeof input.displayName === 'string' ? input.displayName.trim() : '').slice(0, DISPLAY_NAME_MAX) ||
    email.split('@')[0];
  const passwordHash = hashPassword(password, deps.scrypt ?? DEFAULT_SCRYPT_PARAMS);
  const at = (deps.now ?? (() => new Date()))();

  return prisma.$transaction(async (tx) => {
    // B：同 email 已存在 → 稳定拒绝；不建第二个 User，也不并入新 Organization。
    const existing = await tx.user.findUnique({ where: { email }, select: { id: true } });
    if (existing) {
      throw new SelfSignupError('EMAIL_ALREADY_REGISTERED', '该邮箱已注册');
    }

    const slug = await resolveUniqueSlug(tx, organizationName);

    const user = await tx.user.create({
      data: { email, passwordHash, displayName, status: 'ACTIVE', emailVerified: false },
      select: { id: true },
    });
    const organization = await tx.organization.create({
      data: { name: organizationName, slug },
      select: { id: true },
    });
    // D：新 Organization 的唯一 OWNER 由本事务建立。
    await tx.membership.create({
      data: {
        organizationId: organization.id,
        userId: user.id,
        role: 'OWNER',
        invitedBy: 'self_signup',
        isActive: true,
      },
    });

    // I：审计不含 password / hash / token / secret。
    await tx.auditLog.create({
      data: {
        organizationId: organization.id,
        actorType: 'USER',
        actorUserId: user.id,
        action: 'user.self_signup_created',
        entityType: 'User',
        entityId: user.id,
        changes: { email, role: 'OWNER', emailVerified: false, organizationSlug: slug },
        createdAt: at,
      },
    });
    await tx.auditLog.create({
      data: {
        organizationId: organization.id,
        actorType: 'USER',
        actorUserId: user.id,
        action: 'organization.bootstrapped',
        entityType: 'Organization',
        entityId: organization.id,
        changes: { name: organizationName, slug, ownerUserId: user.id, source: 'SELF_SIGNUP' },
        createdAt: at,
      },
    });

    // G：不发放 session。
    return {
      userId: user.id,
      organizationId: organization.id,
      organizationSlug: slug,
      role: 'OWNER' as const,
      emailVerified: false as const,
      sessionIssued: false as const,
    };
  });
}
