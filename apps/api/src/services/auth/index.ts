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
  PUBLIC_SIGNUP_FLAG,
  SelfSignupError,
  bootstrapSelfServiceAccount,
  isPublicSignupEnabled,
  normalizeEmail,
  normalizeOrganizationSlug,
  type SelfSignupErrorCode,
  type SelfSignupInput,
  type SelfSignupResult,
} from './self-signup';
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
  createPrismaInvitationMembershipPort,
  createPrismaInvitationPort,
  createPrismaInvitationUserPort,
  createPrismaMembershipLookup,
  createPrismaSessionPort,
} from './auth-prisma';
export {
  INVITATION_TTL_MS,
  InvitationError,
  MAX_INVITATION_ATTEMPTS,
  acceptInvitation,
  createInvitation,
  hashInvitationToken,
  newInvitationToken,
  type InvitationDeps,
  type InvitationErrorCode,
  type InvitationMembershipPort,
  type InvitationPort,
  type InvitationRow,
  type InvitationUserPort,
} from './invitation';
export {
  SESSION_COOKIE,
  SESSION_COOKIE_MAX_AGE_SECONDS,
  clearSessionCookieHeader,
  handleAuthRequest,
  parseCookies,
  sessionCookieHeader,
  type AuthRouteDeps,
} from './http-routes';
export { handleDataRequest, type DataRouteDeps } from './data-routes';
export { MAX_UPLOAD_BYTES, handleUploadRequest, type UploadRouteDeps } from './upload-routes';
