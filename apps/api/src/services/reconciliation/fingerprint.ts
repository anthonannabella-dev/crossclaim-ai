/**
 * R45 S2 —— provider / source event identity（版本化服务端指纹 v1）
 * ---------------------------------------------------------------------------
 * 依据：MSG-20261001-45 CHANGE B + MSG-20261001-46 CHANGE B + MSG-20261001-47 Q3。
 *   指纹输入至少包含：**provider + source/resource + providerEventId | canonical source identity
 *   + event kind**；并带 `fingerprintVersion = 'v1'`。
 *   目标：不同资源空间中出现相同 ID 时**不得**被误判为同一事件（不得误去重）；
 *        同一外部事件重复 ingest 必须落到**同一条**事实（不得双计）。
 * 纯函数、无 IO、可单测；不读写数据库、不接触凭据。
 */

import { createHash } from 'node:crypto';

export const PROVIDER_EVENT_FINGERPRINT_VERSION = 'v1';
const SEPARATOR = '|';

export type ProviderOutcomeKind = 'ACCEPTED' | 'ACCEPTANCE_REVOKED';
export type ReimbursementKind = 'OBSERVED' | 'REIMBURSEMENT_REVERSED';
export type ProviderEventKind = ProviderOutcomeKind | ReimbursementKind;

/** 字段内出现分隔符会破坏拼接确定性 —— 统一替换（与既有 source-fingerprint 同口径）。 */
function neutralize(value: string): string {
  return value.split(SEPARATOR).join('_');
}

/** provider 标识：trim + 小写（内部枚举式标识，非展示字段）。 */
export function canonicalProvider(value: string): string {
  return neutralize(value.trim().toLowerCase());
}

/** 资源空间：trim + 小写（例：`finances/reimbursements`、`fba/inventory`）。 */
export function canonicalSourceResource(value: string): string {
  return neutralize(value.trim().toLowerCase());
}

/** 事件类型：trim + 大写（与枚举字面量一致）。 */
export function canonicalEventKind(value: string): string {
  return neutralize(value.trim().toUpperCase());
}

export interface ProviderEventFingerprintInput {
  provider: string;
  /** 资源空间（不是表名）：区分「同一 ID 在不同资源空间」的碰撞（CHANGE B） */
  sourceResource: string;
  eventKind: ProviderEventKind;
  /** provider 原生稳定事件 ID（可空：并非所有来源都提供） */
  providerEventId?: string | null;
  /** 无稳定事件 ID 时的规范来源身份（服务端构造，例如 canonical case ref + 行身份） */
  canonicalSourceIdentity?: string | null;
}

export interface ProviderEventFingerprintResult {
  fingerprint: string;
  version: typeof PROVIDER_EVENT_FINGERPRINT_VERSION;
  parts: readonly string[];
}

export class ProviderEventIdentityError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ProviderEventIdentityError';
    this.code = code;
  }
}

/**
 * 版本化服务端指纹 v1。
 * 规则：
 *   - `providerEventId` 存在 → 身份 = `id:<providerEventId>`（保留原生稳定 ID，不丢弃）；
 *   - 否则必须提供 `canonicalSourceIdentity` → 身份 = `src:<canonicalSourceIdentity>`；
 *   - 两者都缺失 → fail-closed（不得退化为“无身份”，否则重复 ingest 无法去重）。
 */
export function providerEventFingerprintV1(input: ProviderEventFingerprintInput): ProviderEventFingerprintResult {
  const provider = canonicalProvider(input.provider);
  const resource = canonicalSourceResource(input.sourceResource);
  const kind = canonicalEventKind(input.eventKind);
  if (provider.length === 0) throw new ProviderEventIdentityError('PROVIDER_REQUIRED', 'provider 不得为空');
  if (resource.length === 0) throw new ProviderEventIdentityError('SOURCE_RESOURCE_REQUIRED', 'sourceResource 不得为空');
  if (kind.length === 0) throw new ProviderEventIdentityError('EVENT_KIND_REQUIRED', 'eventKind 不得为空');

  const rawEventId = (input.providerEventId ?? '').trim();
  const rawSourceIdentity = (input.canonicalSourceIdentity ?? '').trim();
  let identity: string;
  if (rawEventId.length > 0) {
    identity = 'id:' + neutralize(rawEventId);
  } else if (rawSourceIdentity.length > 0) {
    identity = 'src:' + neutralize(rawSourceIdentity);
  } else {
    throw new ProviderEventIdentityError(
      'MISSING_EVENT_IDENTITY',
      'providerEventId 与 canonicalSourceIdentity 至少提供一个（否则无法建立 ingest 幂等身份）',
    );
  }

  const parts = [PROVIDER_EVENT_FINGERPRINT_VERSION, provider, resource, kind, identity] as const;
  return {
    fingerprint: createHash('sha256').update(parts.join(SEPARATOR), 'utf8').digest('hex'),
    version: PROVIDER_EVENT_FINGERPRINT_VERSION,
    parts,
  };
}
