/**
 * TRACK A / PC-11A（MSG-20261003-99 ⑲）— OAuth state 生命周期（内部契约；不发起真实授权）。
 * ---------------------------------------------------------------
 * state 语义：
 *   · 不透明随机值（不含 PII / 不含 secret），与 provider + organization + user + 回调边界绑定；
 *   · **一次性**：consume 原子取出并删除，重放 / 并发只有一次成功；
 *   · 有 TTL（默认 600s）；过期 → EXPIRED；
 *   · provider / 租户 / 用户不匹配 → 对应 *_MISMATCH（且不返回任何绑定信息）。
 * 说明：默认实现为**进程内** store（与 PC-08 的限流基线同口径）；多实例部署需共享存储，
 * 这属于生产启用项（PC-11B），本批只提供端口与契约。
 */

import { createHash, randomBytes as randomBytesImpl } from 'node:crypto';

import { resolveProviderContract } from './provider-integration-contract';

export const DEFAULT_OAUTH_STATE_TTL_SECONDS = 600;

export interface OAuthStateRecord {
  state: string;
  provider: string;
  organizationId: string;
  userId: string;
  /** 该 state 绑定的回调路径（必须命中 provider 契约登记的边界） */
  callbackPath: string;
  /**
   * PC-11A FINAL（CHANGE B）：PKCE code_verifier —— **仅保存在服务端**，
   * 绝不进入 URL / 浏览器可读字段 / 日志 / 公开返回。
   */
  codeVerifier: string | null;
  issuedAt: Date;
  expiresAt: Date;
}

export interface OAuthStateStore {
  save(record: OAuthStateRecord): Promise<void>;
  /** 原子取出并删除（single-use）：并发 / 重放只有一次能拿到记录。 */
  take(state: string): Promise<OAuthStateRecord | null>;
}

export class InMemoryOAuthStateStore implements OAuthStateStore {
  private readonly records = new Map<string, OAuthStateRecord>();
  async save(record: OAuthStateRecord): Promise<void> {
    this.records.set(record.state, record);
  }
  async take(state: string): Promise<OAuthStateRecord | null> {
    const found = this.records.get(state) ?? null;
    this.records.delete(state);
    return found;
  }
}

export type OAuthStateFailure =
  | 'UNKNOWN_PROVIDER'
  | 'CALLBACK_PATH_NOT_ALLOWED'
  | 'UNKNOWN'
  | 'EXPIRED'
  | 'PROVIDER_MISMATCH'
  | 'TENANT_MISMATCH'
  | 'USER_MISMATCH'
  | 'CALLBACK_MISMATCH';

export interface IssueOAuthStateInput {
  provider: string;
  organizationId: string;
  userId: string;
  callbackPath: string;
  ttlSeconds?: number;
}

export interface IssuedOAuthState {
  state: string;
  provider: string;
  callbackPath: string;
  authorizationUrl: string;
  expiresAt: Date;
  /** PKCE challenge（公开值；可放 URL）。verifier 永不出现在此处。 */
  codeChallenge: string | null;
  codeChallengeMethod: 'S256' | null;
  /** 生产可用性恒 false：本批只发 state，不发起真实授权。 */
  productionAuthorizationEnabled: false;
}

export async function issueOAuthState(
  store: OAuthStateStore,
  input: IssueOAuthStateInput,
  deps: { now?: () => Date; randomBytes?: (size: number) => Buffer } = {},
): Promise<IssuedOAuthState> {
  const contract = resolveProviderContract(input.provider);
  if (!contract) throw new Error('UNKNOWN_PROVIDER');
  if (contract.callbackPath !== input.callbackPath) throw new Error('CALLBACK_PATH_NOT_ALLOWED');
  const now = (deps.now ?? (() => new Date()))();
  const ttl = input.ttlSeconds ?? DEFAULT_OAUTH_STATE_TTL_SECONDS;
  const state = (deps.randomBytes ?? randomBytesImpl)(32).toString('hex');
  const pkce = contract.pkce;
  const codeVerifier = pkce.required ? (deps.randomBytes ?? randomBytesImpl)(32).toString('base64url') : null;
  const codeChallenge =
    codeVerifier && pkce.method === 'S256'
      ? createHash('sha256').update(codeVerifier, 'utf8').digest('base64url')
      : null;
  const record: OAuthStateRecord = {
    state,
    provider: contract.provider,
    organizationId: input.organizationId,
    userId: input.userId,
    callbackPath: contract.callbackPath,
    codeVerifier,
    issuedAt: now,
    expiresAt: new Date(now.getTime() + ttl * 1000),
  };
  await store.save(record);
  return {
    state,
    provider: contract.provider,
    callbackPath: contract.callbackPath,
    // 授权 URL 只是边界占位（真实 provider 端点属 PC-11B）；不含 client id / secret。
    authorizationUrl:
      contract.callbackPath + '?state=' + state + (codeChallenge ? '&code_challenge=' + codeChallenge + '&code_challenge_method=S256' : ''),
    expiresAt: record.expiresAt,
    codeChallenge,
    codeChallengeMethod: codeChallenge ? 'S256' : null,
    productionAuthorizationEnabled: false,
  };
}

export interface ConsumeOAuthStateInput {
  state: string;
  provider: string;
  organizationId: string;
  userId: string;
  callbackPath?: string;
}

export type ConsumeOAuthStateResult =
  | { ok: true; record: OAuthStateRecord }
  | { ok: false; reason: OAuthStateFailure };

/**
 * 消费 state（一次性）。任何不匹配都会**烧掉**该 state 并只返回原因码 ——
 * 不返回绑定信息，避免被用来探测其他租户。
 */
export async function consumeOAuthState(
  store: OAuthStateStore,
  input: ConsumeOAuthStateInput,
  deps: { now?: () => Date } = {},
): Promise<ConsumeOAuthStateResult> {
  const record = await store.take(input.state);
  if (!record) return { ok: false, reason: 'UNKNOWN' };
  const now = (deps.now ?? (() => new Date()))();
  if (record.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: 'EXPIRED' };
  if (record.provider !== input.provider.toUpperCase()) return { ok: false, reason: 'PROVIDER_MISMATCH' };
  if (record.organizationId !== input.organizationId) return { ok: false, reason: 'TENANT_MISMATCH' };
  if (record.userId !== input.userId) return { ok: false, reason: 'USER_MISMATCH' };
  if (input.callbackPath !== undefined && record.callbackPath !== input.callbackPath) return { ok: false, reason: 'CALLBACK_MISMATCH' };
  return { ok: true, record };
}
