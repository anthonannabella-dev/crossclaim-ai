/**
 * Amazon SP-API READ-ONLY adapter boundary（MSG-20261001-25 CHANGE A/B）
 * ---------------------------------------------------------------
 * 依据：
 *   · CHANGE A：本轮只实现只读边界 —— descriptor → auth/credential port abstraction →
 *     read fetch contract → pagination/rate-limit handling → normalization boundary →
 *     既有 Connector Runner（本模块提供前五段与端口，Runner 由调用方注入 sink）。
 *   · CHANGE B：只读能力必须 fail-closed 到 **operation/resource 级**，不允许
 *     `provider.readOnly = true` 式粗粒度；未登记 operation 一律拒绝；write 永远拒绝；
 *     RDT（受限数据）保持独立能力边界。
 *
 * 硬边界（本模块结构上保证）：
 *   · 不读 env、不读凭据、不发网络请求（transport 必须由调用方注入，测试用 mocked transport）；
 *   · 不引用 platform-write 的任何写能力（无 sink、无 ledger、无 orchestrator）；
 *   · 只读操作的 HTTP method 只允许 GET；descriptor 里任何 kind=WRITE 的条目一律拒绝。
 */

export type AmazonOperationKind = 'READ' | 'WRITE';

export interface AmazonOperationDescriptor {
  /** 操作名（SP-API 语义，如 getOrders） */
  operation: string;
  /** 资源族（如 orders / shipments） */
  resource: string;
  kind: AmazonOperationKind;
  /** 只读契约：READ 操作只允许 GET */
  method: 'GET' | 'POST';
  /** 所需 application role / grantless scope（由 provider 固定声明，不可来自请求参数） */
  requiredRoles: readonly string[];
  /** 是否必须携带 Restricted Data Token（受限数据独立边界） */
  requiresRestrictedDataToken: boolean;
  /** 分页模型 */
  pagination: 'NEXT_TOKEN' | 'NONE';
  /** 官方限流口径（burst / 恢复速率）；仅用于退避计算 */
  rateLimit: { burst: number; restorePerSecond: number };
  /** 相对路径模板（不含区域 host） */
  path: string;
}

/**
 * 本轮**登记**的操作集合（代码注册表；未登记一律拒绝）。
 * 说明：条目为只读样板与边界用例，不代表已接入真实账号或已获得真实授权。
 */
export const AMAZON_SP_REGISTERED_OPERATIONS: readonly AmazonOperationDescriptor[] = [
  {
    operation: 'getOrders',
    resource: 'orders',
    kind: 'READ',
    method: 'GET',
    requiredRoles: ['Selling Partner Insights'],
    requiresRestrictedDataToken: false,
    pagination: 'NEXT_TOKEN',
    rateLimit: { burst: 6, restorePerSecond: 0.0167 },
    path: '/orders/v0/orders',
  },
  {
    operation: 'getOrderItems',
    resource: 'orders',
    kind: 'READ',
    method: 'GET',
    requiredRoles: ['Selling Partner Insights'],
    requiresRestrictedDataToken: false,
    pagination: 'NEXT_TOKEN',
    rateLimit: { burst: 6, restorePerSecond: 0.0167 },
    path: '/orders/v0/orders/{orderId}/orderItems',
  },
  {
    operation: 'getRestrictedOrderAddress',
    resource: 'orders',
    kind: 'READ',
    method: 'GET',
    // 受限数据：必须单独持有 RDT 能力，普通 read capability 不足以免责
    requiredRoles: ['Selling Partner Insights'],
    requiresRestrictedDataToken: true,
    pagination: 'NONE',
    rateLimit: { burst: 6, restorePerSecond: 0.0167 },
    path: '/orders/v0/orders/{orderId}/address',
  },
  {
    operation: 'createReport',
    resource: 'reports',
    // 登记但为 WRITE：用于证明「write operation 永远拒绝」而不是靠“没登记”
    kind: 'WRITE',
    method: 'POST',
    requiredRoles: ['Selling Partner Insights'],
    requiresRestrictedDataToken: false,
    pagination: 'NONE',
    rateLimit: { burst: 1, restorePerSecond: 0.0167 },
    path: '/reports/2021-06-30/reports',
  },
] as const;

export type AmazonReadDenialReason =
  | 'OPERATION_NOT_REGISTERED'
  | 'RESOURCE_MISMATCH'
  | 'WRITE_OPERATION_FORBIDDEN'
  | 'READ_METHOD_VIOLATION'
  | 'RDT_CAPABILITY_REQUIRED';

export interface AmazonAdapterCapabilities {
  /** 只读 adapter 是否已在组合根启用（缺省 false = fail-closed） */
  readOnlyAdapterEnabled?: boolean;
  /** 是否持有受限数据（RDT）能力；缺省 false */
  restrictedDataTokenEnabled?: boolean;
}

export interface AmazonReadAuthorization {
  allowed: boolean;
  reason?: AmazonReadDenialReason;
  descriptor?: AmazonOperationDescriptor;
}

/** operation/resource 级授权（fail-closed：未登记、资源不符、写操作、方法违规、缺 RDT 一律拒绝） */
export function authorizeAmazonReadOperation(input: {
  operation: string;
  resource: string;
  capabilities?: AmazonAdapterCapabilities;
}): AmazonReadAuthorization {
  const descriptor = AMAZON_SP_REGISTERED_OPERATIONS.find((item) => item.operation === input.operation);
  if (!descriptor) return { allowed: false, reason: 'OPERATION_NOT_REGISTERED' };
  if (descriptor.resource !== input.resource) return { allowed: false, reason: 'RESOURCE_MISMATCH' };
  if (descriptor.kind !== 'READ') return { allowed: false, reason: 'WRITE_OPERATION_FORBIDDEN' };
  if (descriptor.method !== 'GET') return { allowed: false, reason: 'READ_METHOD_VIOLATION' };
  if (descriptor.requiresRestrictedDataToken && input.capabilities?.restrictedDataTokenEnabled !== true) {
    return { allowed: false, reason: 'RDT_CAPABILITY_REQUIRED' };
  }
  return { allowed: true, descriptor };
}

/** 凭据端口（抽象）：本模块不读 env、不读凭据；未配置实现一律抛错（fail-closed） */
export interface AmazonCredentialPort {
  getLwaAccessToken(): Promise<{ token: string; expiresAt: string }>;
  getRestrictedDataToken?(args: { resource: string }): Promise<{ token: string; expiresAt: string }>;
}

export class AmazonAdapterBoundaryError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(code + ': ' + message);
    this.name = 'AmazonAdapterBoundaryError';
    this.code = code;
  }
}

/** 未配置凭据端口：任何调用都失败关闭（生产组合根必须显式注入真实实现，且当前为 HOLD） */
export function createUnconfiguredAmazonCredentialPort(): AmazonCredentialPort {
  return {
    async getLwaAccessToken() {
      throw new AmazonAdapterBoundaryError(
        'CREDENTIAL_PORT_UNCONFIGURED',
        '凭据端口未配置（本阶段不接真实凭据）',
      );
    },
  };
}

/** 只读传输端口（GET-only）：真实实现属于后续批次；本阶段仅接受注入的 mock/fixture */
export interface AmazonReadTransport {
  get(request: {
    path: string;
    query: Record<string, string>;
    headers: Record<string, string>;
  }): Promise<{ status: number; headers?: Record<string, string>; body: unknown }>;
}

export interface AmazonReadFetchInput {
  operation: string;
  resource: string;
  pathParams?: Record<string, string>;
  query?: Record<string, string>;
  capabilities?: AmazonAdapterCapabilities;
  /** 单次调用最多尝试次数（含首次），用于 429 退避 */
  maxAttempts?: number;
}

export interface AmazonReadFetchResult {
  operation: string;
  attempts: number;
  pages: number;
  records: unknown[];
  nextToken: string | null;
}

export interface AmazonReadFetcherDeps {
  transport: AmazonReadTransport;
  credentials: AmazonCredentialPort;
  /** 退避等待（测试注入即时实现；生产实现后续批次提供） */
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

function fillPath(template: string, pathParams: Record<string, string>): string {
  return template.replace(/\{([^}]+)\}/g, (_match, key: string) => {
    const value = pathParams[key];
    if (typeof value !== 'string' || value === '') {
      throw new AmazonAdapterBoundaryError('PATH_PARAM_MISSING', '缺少路径参数: ' + key);
    }
    return encodeURIComponent(value);
  });
}

function extractRecords(body: unknown): { records: unknown[]; nextToken: string | null } {
  if (!body || typeof body !== 'object') {
    throw new AmazonAdapterBoundaryError('UNKNOWN_PROVIDER_SHAPE', '响应不是对象');
  }
  const payload = body as Record<string, unknown>;
  const listKey = Object.keys(payload).find((key) => Array.isArray(payload[key]));
  const records = listKey ? (payload[listKey] as unknown[]) : [];
  const tokenCandidate = payload.NextToken ?? payload.nextToken;
  const nextToken = typeof tokenCandidate === 'string' && tokenCandidate !== '' ? tokenCandidate : null;
  return { records, nextToken };
}

/**
 * 单页只读抓取（连接器 cursor「一页一推进」语义）：
 * operation 授权（fail-closed）→ 凭据端口取 LWA token → 单次 GET（可携带 cursor）→ 429 退避重试。
 * 429 重试只重放**同一次只读请求**，不产生任何业务记录副作用。
 */
export async function fetchAmazonReadPage(
  deps: AmazonReadFetcherDeps,
  input: AmazonReadFetchInput & { cursor?: string | null },
): Promise<{ operation: string; attempts: number; records: unknown[]; nextToken: string | null }> {
  const authorization = authorizeAmazonReadOperation({
    operation: input.operation,
    resource: input.resource,
    ...(input.capabilities ? { capabilities: input.capabilities } : {}),
  });
  if (!authorization.allowed || !authorization.descriptor) {
    throw new AmazonAdapterBoundaryError(
      authorization.reason ?? 'OPERATION_NOT_REGISTERED',
      'operation 未获授权（fail-closed）',
    );
  }
  const descriptor = authorization.descriptor;
  const path = fillPath(descriptor.path, input.pathParams ?? {});
  const token = await deps.credentials.getLwaAccessToken();
  const maxAttempts = Math.max(1, input.maxAttempts ?? 3);
  const sleep = deps.sleep ?? (async () => undefined);

  const query: Record<string, string> = { ...(input.query ?? {}) };
  if (input.cursor) query.NextToken = input.cursor;

  let attempts = 0;
  let attempt = 0;
  let response: { status: number; headers?: Record<string, string>; body: unknown } | null = null;
  for (;;) {
    attempt += 1;
    attempts += 1;
    response = await deps.transport.get({
      path,
      query,
      headers: { 'x-amz-access-token': token.token, accept: 'application/json' },
    });
    if (response.status !== 429) break;
    if (attempt >= maxAttempts) {
      throw new AmazonAdapterBoundaryError('AMAZON_READ_THROTTLED', '429 重试次数耗尽');
    }
    // 官方口径：429 可重试，需要退避；退避长度由 descriptor 的恢复速率推导
    await sleep(Math.min(2000, Math.ceil(1000 / Math.max(0.0001, descriptor.rateLimit.restorePerSecond))));
  }
  if (!response) throw new AmazonAdapterBoundaryError('AMAZON_READ_TRANSPORT_FAILED', '无响应');
  if (response.status >= 500) {
    throw new AmazonAdapterBoundaryError('AMAZON_READ_TRANSPORT_FAILED', 'provider 5xx: ' + response.status);
  }
  if (response.status !== 200) {
    throw new AmazonAdapterBoundaryError('AMAZON_READ_UNEXPECTED_STATUS', '状态码: ' + response.status);
  }
  const page = extractRecords(response.body);
  return {
    operation: descriptor.operation,
    attempts,
    records: page.records,
    nextToken: descriptor.pagination === 'NEXT_TOKEN' ? page.nextToken : null,
  };
}

/** 多页只读抓取（内部按单页循环；最多 50 页防失控） */
export async function fetchAmazonReadPages(
  deps: AmazonReadFetcherDeps,
  input: AmazonReadFetchInput,
): Promise<AmazonReadFetchResult> {
  const records: unknown[] = [];
  let pages = 0;
  let attempts = 0;
  let nextToken: string | null = null;
  do {
    const page = await fetchAmazonReadPage(deps, {
      ...input,
      ...(nextToken ? { cursor: nextToken } : {}),
    });
    records.push(...page.records);
    attempts += page.attempts;
    nextToken = page.nextToken;
    pages += 1;
    if (pages > 50) throw new AmazonAdapterBoundaryError('AMAZON_READ_PAGINATION_LIMIT', '分页超过上限');
  } while (nextToken);
  return { operation: input.operation, attempts, pages, records, nextToken: null };
}

export interface NormalizedReadFact {
  fingerprint: string;
  operation: string;
  resource: string;
  record: unknown;
}

export interface QuarantinedReadRecord {
  operation: string;
  resource: string;
  reason: 'MALFORMED_RECORD' | 'UNKNOWN_SHAPE';
  raw: unknown;
}

/** 每 operation 的稳定标识提取器：缺失即隔离（不静默丢弃） */
const IDENTIFIER_EXTRACTORS: Record<string, (record: Record<string, unknown>) => string | null> = {
  getOrders: (record) => (typeof record.AmazonOrderId === 'string' ? record.AmazonOrderId : null),
  getOrderItems: (record) => (typeof record.OrderItemId === 'string' ? record.OrderItemId : null),
  getRestrictedOrderAddress: (record) =>
    typeof record.AmazonOrderId === 'string' ? record.AmazonOrderId : null,
};

/** 规范化边界：未知形状 / 缺标识 → quarantine（绝不静默丢弃） */
export function normalizeAmazonReadRecords(input: {
  operation: string;
  resource: string;
  records: readonly unknown[];
}): { facts: NormalizedReadFact[]; quarantined: QuarantinedReadRecord[] } {
  const facts: NormalizedReadFact[] = [];
  const quarantined: QuarantinedReadRecord[] = [];
  const extractor = IDENTIFIER_EXTRACTORS[input.operation];

  for (const record of input.records) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      quarantined.push({
        operation: input.operation,
        resource: input.resource,
        reason: 'MALFORMED_RECORD',
        raw: record,
      });
      continue;
    }
    if (!extractor) {
      quarantined.push({
        operation: input.operation,
        resource: input.resource,
        reason: 'UNKNOWN_SHAPE',
        raw: record,
      });
      continue;
    }
    const identifier = extractor(record as Record<string, unknown>);
    if (!identifier) {
      quarantined.push({
        operation: input.operation,
        resource: input.resource,
        reason: 'MALFORMED_RECORD',
        raw: record,
      });
      continue;
    }
    facts.push({
      // 稳定指纹：provider + resource + operation + 记录标识（与既有 sourceFingerprint 口径一致：不含金额）
      fingerprint: ['amazon-sp', input.resource, input.operation, identifier].join('::'),
      operation: input.operation,
      resource: input.resource,
      record,
    });
  }
  return { facts, quarantined };
}

/** 只读结果落点端口：由既有 Connector Runner / ingest 管线实现（本模块不写库） */
export interface AmazonReadOnlySink {
  /** 以 fingerprint 幂等 upsert（实现方负责唯一性；重复不新增） */
  upsertFact(fact: NormalizedReadFact): Promise<{ created: boolean }>;
  quarantine(entry: QuarantinedReadRecord): Promise<void>;
}

export interface AmazonReadOnlySyncResult {
  operation: string;
  attempts: number;
  pages: number;
  factsSeen: number;
  factsCreated: number;
  duplicatesSuppressed: number;
  quarantined: number;
}

/** 只读同步：fetch → normalize → 幂等落点（无任何写平台能力） */
export async function runAmazonReadOnlySync(
  deps: { fetcher: AmazonReadFetcherDeps; sink: AmazonReadOnlySink },
  input: AmazonReadFetchInput,
): Promise<AmazonReadOnlySyncResult> {
  const fetched = await fetchAmazonReadPages(deps.fetcher, input);
  const normalized = normalizeAmazonReadRecords({
    operation: fetched.operation,
    resource: input.resource,
    records: fetched.records,
  });

  let factsCreated = 0;
  let duplicatesSuppressed = 0;
  for (const fact of normalized.facts) {
    const result = await deps.sink.upsertFact(fact);
    if (result.created) factsCreated += 1;
    else duplicatesSuppressed += 1;
  }
  for (const entry of normalized.quarantined) {
    await deps.sink.quarantine(entry);
  }

  return {
    operation: fetched.operation,
    attempts: fetched.attempts,
    pages: fetched.pages,
    factsSeen: normalized.facts.length,
    factsCreated,
    duplicatesSuppressed,
    quarantined: normalized.quarantined.length,
  };
}
