/**
 * C-0013-B — 连接器抽象层（**纯类型，无运行时、无凭据、无网络**）
 * ---------------------------------------------------------------
 * 架构方裁定（MSG-20260928-128 / -136 / -138）：
 *   · Fetcher 只拉数据，**不得直接产生 ClaimItem**；Normalizer 只做形状归一化；
 *     金额判断与可追回金额永远归 Rule Engine
 *   · `ConnectorDescriptor` 必须有**不可变 `connectorId`**（审计定位，不依赖运行时对象名）
 *   · 只读 scope 必须显式声明且非空（空 = 有写权限的连接器 → 拒绝）
 *   · `NormalizerOutput` **不得**出现 recoverableAmount / ruleVersionId / decision 这类判断字段
 *   · quarantine 只回答「能不能理解这条数据」，不得混入「值不值得追回」
 */

export const CONNECTOR_AUTH_KINDS = ['OAUTH', 'API_KEY', 'FILE_UPLOAD'] as const;
export type ConnectorAuthKind = (typeof CONNECTOR_AUTH_KINDS)[number];

export interface ConnectorDescriptor {
  /** 不可变身份：审计里用它，不用运行时对象名 */
  connectorId: string;
  platformType: string;
  authKind: ConnectorAuthKind;
  /** 只读 scope；必须非空 */
  readonly readonlyScopes: readonly string[];
  readonly resources: readonly string[];
  rateLimitPerMinute?: number;
}

export class ConnectorContractError extends Error {
  readonly code = 'CONNECTOR_CONTRACT';

  constructor(message: string) {
    super(message);
    this.name = 'ConnectorContractError';
  }
}

/** 只读与身份契约：缺 connectorId 或没有只读 scope 的连接器一律拒绝。 */
export function assertReadonlyConnector(descriptor: ConnectorDescriptor): void {
  if (!descriptor.connectorId || descriptor.connectorId.trim() === '') {
    throw new ConnectorContractError('连接器必须有不可变 connectorId');
  }
  if (!descriptor.readonlyScopes || descriptor.readonlyScopes.length === 0) {
    throw new ConnectorContractError('连接器必须声明至少一个只读 scope（空 = 潜在写权限）');
  }
  if (!descriptor.resources || descriptor.resources.length === 0) {
    throw new ConnectorContractError('连接器必须声明至少一个 resource');
  }
}

export interface FetcherRecord {
  /** 平台侧资源引用（用于诊断，不是幂等键本身） */
  resourceRef: string;
  payload: Record<string, unknown>;
  fetchedAt: Date;
}

export interface FetcherPage {
  records: FetcherRecord[];
  nextCursor: string | null;
}

export interface Fetcher {
  /** 只读；不解析业务；不产生 ClaimItem */
  pull(input: { resource: string; cursor: string | null; limit: number }): Promise<FetcherPage>;
}

/** quarantine 只用于「无法理解数据」，禁止业务判断词（如 NOT_RECOVERABLE / LOW_VALUE）。 */
export const QUARANTINE_REASON_CODES = [
  'MISSING_FIELD',
  'INVALID_TYPE',
  'AMOUNT_FORMAT',
  'IDENTITY_UNAVAILABLE',
  'UNKNOWN_SHAPE',
] as const;
export type QuarantineReasonCode = (typeof QUARANTINE_REASON_CODES)[number];

export interface NormalizerOutput {
  platformType: string;
  claimType: string;
  occurredAt: Date;
  amountExpected?: string | null;
  amountActual?: string | null;
  currency: string;
  responsibleParty: string;
  /** 参与指纹计算的稳定引用 */
  normalizedRef: string;
  normalizerVersion: string;
  /** 由 C-0013-A 的 sourceFingerprintV1 计算，Normalizer 只负责声明 */
  sourceFingerprintCandidate: string;
}

export type NormalizeResult =
  | { ok: true; output: NormalizerOutput }
  | { ok: false; reasonCode: QuarantineReasonCode };

export interface Normalizer {
  readonly normalizerVersion: string;
  readonly platformType: string;
  normalize(record: FetcherRecord): NormalizeResult;
}
