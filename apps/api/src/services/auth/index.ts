/**
 * C-0008-A auth foundation entry point.
 */

export {
  DEFAULT_SCRYPT_PARAMS,
  AuthValidationError,
  assertPasswordPolicy,
  hashPassword,
  resolveScryptParams,
  verifyPassword,
  type ScryptParams,
} from './password';
export {
  DEFAULT_SESSION_POLICY,
  hashSessionToken,
  issueSession,
  newSessionToken,
  resolveSession,
  revokeAllSessionsForUser,
  revokeSession,
  type ActiveMembership,
  type IssuedSession,
  type MembershipLookupPort,
  type SessionContext,
  type SessionDeps,
  type SessionPolicy,
  type SessionPort,
  type SessionRow,
} from './session';
export {
  AuthError,
  LOCK_DURATION_MS,
  MAX_FAILED_LOGINS,
  loginWithPassword,
  type AuthErrorCode,
  type AuthUserPort,
  type AuthUserRow,
  type LoginDeps,
  type LoginResult,
} from './login';
export {
  createPrismaAuthUserPort,
  createPrismaMembershipLookup,
  createPrismaSessionPort,
} from './auth-prisma';
