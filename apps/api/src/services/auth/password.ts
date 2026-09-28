/**
 * C-0008-A — password hashing (Node crypto scrypt, configurable parameters).
 * ---------------------------------------------------------------
 * Approved parameters: N=32768, r=8, p=1 — but must be **configurable** via
 * environment (PASSWORD_SCRYPT_N / _R / _P) so a future upgrade does not need a
 * code change. Storage format is self-describing:
 *
 *   scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>
 *
 * Plaintext and reversible encodings are never used, and nothing here ever logs
 * or returns the password.
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
  keyLength: number;
}

export const DEFAULT_SCRYPT_PARAMS: ScryptParams = { N: 32_768, r: 8, p: 1, keyLength: 64 };

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) return fallback;
  return value;
}

export function resolveScryptParams(
  env: Record<string, string | undefined> = process.env,
): ScryptParams {
  return {
    N: parsePositiveInt(env.PASSWORD_SCRYPT_N, DEFAULT_SCRYPT_PARAMS.N),
    r: parsePositiveInt(env.PASSWORD_SCRYPT_R, DEFAULT_SCRYPT_PARAMS.r),
    p: parsePositiveInt(env.PASSWORD_SCRYPT_P, DEFAULT_SCRYPT_PARAMS.p),
    keyLength: DEFAULT_SCRYPT_PARAMS.keyLength,
  };
}

/** 12+ chars with at least one letter and one digit (MVP policy). */
export function assertPasswordPolicy(password: string): void {
  if (typeof password !== 'string' || password.length < 12) {
    throw new AuthValidationError('密码至少 12 个字符');
  }
  if (password.length > 256) throw new AuthValidationError('密码过长');
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    throw new AuthValidationError('密码必须同时包含字母与数字');
  }
}

export class AuthValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthValidationError';
  }
}

function derive(password: string, salt: Buffer, params: ScryptParams): Buffer {
  return scryptSync(password, salt, params.keyLength, {
    N: params.N,
    r: params.r,
    p: params.p,
    // Node 默认 maxmem 32MiB，N=32768/r=8 恰好触顶，显式放宽
    maxmem: 256 * params.N * params.r,
  });
}

export function hashPassword(
  password: string,
  params: ScryptParams = DEFAULT_SCRYPT_PARAMS,
): string {
  assertPasswordPolicy(password);
  const salt = randomBytes(16);
  const hash = derive(password, salt, params);
  return `scrypt$${params.N}$${params.r}$${params.p}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nRaw, rRaw, pRaw, saltHex, hashHex] = parts;
  const params: ScryptParams = {
    N: Number(nRaw),
    r: Number(rRaw),
    p: Number(pRaw),
    keyLength: hashHex.length / 2,
  };
  if (!Number.isInteger(params.N) || !Number.isInteger(params.r) || !Number.isInteger(params.p)) {
    return false;
  }
  const expected = Buffer.from(hashHex, 'hex');
  if (expected.length === 0) return false;
  const actual = derive(password, Buffer.from(saltHex, 'hex'), params);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
