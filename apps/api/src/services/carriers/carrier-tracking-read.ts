/**
 * CARRIER QUEUE #4（MSG-20261003-107 ⑲–㉞）— Tracking Read Adapter（**read-only** normalized tracking plane）。
 * ---------------------------------------------------------------
 * 目标：在 TRANSPORT=false / production credentials=ABSENT 条件下，把 normalized tracking read plane 做完；
 *       真实 credential 到位后只需接 provider adapter，不重新设计 shipment / tracking normalization。
 * 硬约束：
 *   · 只允许 getTracking / list read —— 不做 shipment mutation / reroute / intercept / claim / pickup / refund。
 *   · carrier account identity 必须 server-derived：credentialRef → SourceConnection → verified carrier PlatformAccount → organization；
 *     trackingNumber 只是查询 key，**不能**单独建立 tenant/account 归属。
 *   · 完整 provider raw JSON 不暴露给 customer API，只保留 safe rawReference（审计 / 后续 SLA evidence 用）。
 *   · provider 差异放在 provider adapter（status map / event fields），核心归一化不做巨型 if(provider)。
 *   · TRANSPORT=false · platformWriteEnabled=false · productionCredentials=ABSENT · 无真实 provider 调用。
 */

import type { CarrierAccountIdentitySource } from './carrier-account-discovery';
import type { CarrierProvider } from './connector-capability';

/** 内部稳定状态枚举（MSG-107 ㉔）。 */
export const CARRIER_TRACKING_STATUSES = [
  'UNKNOWN',
  'LABEL_CREATED',
  'PICKED_UP',
  'IN_TRANSIT',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'EXCEPTION',
  'DELAYED',
  'RETURNED',
  'LOST',
] as const;
export type CarrierTrackingStatus = (typeof CARRIER_TRACKING_STATUSES)[number];

export const CARRIER_TRACKING_EVENT_SOURCES = ['PROVIDER_API', 'PROVIDER_SCAN'] as const;
export type CarrierTrackingEventSource = (typeof CARRIER_TRACKING_EVENT_SOURCES)[number];

export interface CarrierTrackingEvent {
  occurredAt: string;
  status: CarrierTrackingStatus;
  /** provider 原始状态码（不能只留 normalized）。 */
  rawStatusCode: string;
  description: string;
  location: string | null;
  source: CarrierTrackingEventSource;
  /** 确定性去重键（provider + tracking + occurredAt + rawStatusCode + location）。 */
  eventKey: string;
}

export interface CarrierTrackingSnapshot {
  provider: CarrierProvider;
  externalAccountId: string;
  trackingNumber: string;
  shipmentStatus: CarrierTrackingStatus;
  /** provider 原始总状态码（raw 保留）。 */
  carrierStatusCode: string;
  statusText: string;
  origin: string | null;
  destination: string | null;
  shipDate: string | null;
  /** ㉛：为后续 SLA detection 预留 promised / estimated delivery。 */
  estimatedDeliveryAt: string | null;
  deliveredAt: string | null;
  lastEventAt: string | null;
  lastEventLocation: string | null;
  /** ㉛：service level 若可得（SLA 评估前置事实）。 */
  serviceLevel: string | null;
  events: readonly CarrierTrackingEvent[];
  /** ㉚：safe reference / hash / artifact reference —— 不是完整 provider raw JSON。 */
  rawReference: string;
  observedAt: string;
}

/** provider adapter 交给核心归一化层的**受控**记录（不含完整 raw payload）。 */
export interface CarrierRawTrackingEvent {
  occurredAt: string;
  rawStatusCode: string;
  description: string;
  location?: string | null;
  source?: string | null;
}

export interface CarrierRawTrackingRecord {
  provider: CarrierProvider;
  externalAccountId: string;
  trackingNumber: string;
  rawStatusCode: string;
  statusText: string;
  serviceLevel?: string | null;
  origin?: string | null;
  destination?: string | null;
  shipDate?: string | null;
  estimatedDeliveryAt?: string | null;
  deliveredAt?: string | null;
  events?: readonly CarrierRawTrackingEvent[];
  /** 完整 provider payload 留在 provider adapter 侧；这里只带 safe reference。 */
  rawReference: string;
}

/** 只读 tracking 端口（真实实现属 HOLD_EXTERNAL；只接受 credentialRef）。 */
export interface CarrierTrackingReadPort {
  getTracking(input: {
    provider: CarrierProvider;
    credentialRef: string;
    externalAccountId: string;
    trackingNumber: string;
    organizationId: string;
  }): Promise<CarrierRawTrackingRecord>;
}

/** 必须区分的读取失败原因（㉗：不得全部压成 TRACKING_FAILED）。 */
export const CARRIER_PROVIDER_READ_ERROR_CODES = [
  'NOT_FOUND',
  'NOT_AUTHORIZED',
  'ACCOUNT_MISMATCH',
  'TEMPORARILY_UNAVAILABLE',
  'RATE_LIMITED',
  'PROVIDER_ERROR',
] as const;
export type CarrierProviderReadErrorCode = (typeof CARRIER_PROVIDER_READ_ERROR_CODES)[number];

export class CarrierProviderReadError extends Error {
  constructor(readonly code: CarrierProviderReadErrorCode, readonly detail?: string) {
    super(code);
    this.name = 'CarrierProviderReadError';
  }
}

export type CarrierTrackingFailureCode =
  | 'UNKNOWN_CARRIER'
  | 'PLAINTEXT_CREDENTIAL_NOT_SUPPORTED'
  | 'UNSUPPORTED_INPUT'
  | 'CREDENTIAL_REF_REQUIRED'
  | 'TRACKING_NUMBER_REQUIRED'
  | 'TENANT_CONTEXT_REQUIRED'
  | 'UNVERIFIED_ACCOUNT_LINEAGE'
  | 'CROSS_TENANT_ACCOUNT'
  | 'PROVIDER_ACCOUNT_MISMATCH'
  | 'RAW_PAYLOAD_INVALID'
  | 'RAW_PAYLOAD_UNSAFE'
  | CarrierProviderReadErrorCode;

/**
 * provider-verified account registry（㉑㉒）：只登记**已验证**的 carrier account lineage。
 * 真实实现必须从 PlatformAccount + SourceConnection provenance 派生；本批提供进程内实现供内部契约与测试使用。
 */
export interface CarrierVerifiedAccountBinding {
  provider: CarrierProvider;
  organizationId: string;
  identitySource: CarrierAccountIdentitySource;
  identityVersion: string;
}

export interface CarrierVerifiedAccountRegistry {
  resolve(input: { credentialRef: string; externalAccountId: string }): CarrierVerifiedAccountBinding | null;
}

export interface InMemoryCarrierVerifiedAccountRegistry extends CarrierVerifiedAccountRegistry {
  record(input: {
    provider: CarrierProvider;
    credentialRef: string;
    externalAccountId: string;
    organizationId: string;
    identitySource: CarrierAccountIdentitySource;
    identityVersion?: string;
  }): void;
}

export function createInMemoryCarrierVerifiedAccountRegistry(): InMemoryCarrierVerifiedAccountRegistry {
  const registry = new Map<string, CarrierVerifiedAccountBinding>();
  const key = (credentialRef: string, externalAccountId: string) => credentialRef + '|' + externalAccountId;
  return {
    record(input) {
      registry.set(key(input.credentialRef, input.externalAccountId), {
        provider: input.provider,
        organizationId: input.organizationId,
        identitySource: input.identitySource,
        identityVersion: input.identityVersion ?? 'carrier-identity-v1',
      });
    },
    resolve(input) {
      return registry.get(key(input.credentialRef, input.externalAccountId)) ?? null;
    },
  };
}

/** provider-specific 归一化适配器（㉙）：status map / event field mapping 各自实现。 */
export interface CarrierTrackingAdapter {
  provider: CarrierProvider;
  parseStatus(rawStatusCode: string): CarrierTrackingStatus;
  mapEvent(raw: CarrierRawTrackingEvent, trackingNumber: string): CarrierTrackingEvent | null;
}

/**
 * UPS 状态映射（内部归一化表；真实 provider 码表在 sandbox / real-data validation 阶段核对 —— HOLD_EXTERNAL）。
 * 未登记码一律 UNKNOWN，不猜测。
 */
const UPS_STATUS_MAP: Readonly<Record<string, CarrierTrackingStatus>> = {
  MP: 'LABEL_CREATED',
  M: 'LABEL_CREATED',
  P: 'PICKED_UP',
  I: 'IN_TRANSIT',
  O: 'OUT_FOR_DELIVERY',
  D: 'DELIVERED',
  X: 'EXCEPTION',
  RS: 'RETURNED',
  DO: 'DELAYED',
};

/** FedEx 状态映射（同上：未登记码 → UNKNOWN）。 */
const FEDEX_STATUS_MAP: Readonly<Record<string, CarrierTrackingStatus>> = {
  OC: 'LABEL_CREATED',
  PU: 'PICKED_UP',
  IT: 'IN_TRANSIT',
  OD: 'OUT_FOR_DELIVERY',
  DL: 'DELIVERED',
  EX: 'EXCEPTION',
  DE: 'DELAYED',
  RS: 'RETURNED',
};

function mapEventFor(
  provider: CarrierProvider,
  statusMap: Readonly<Record<string, CarrierTrackingStatus>>,
  trackingNumber: string,
  raw: CarrierRawTrackingEvent,
): CarrierTrackingEvent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const occurredAt = typeof raw.occurredAt === 'string' ? raw.occurredAt.trim() : '';
  const rawStatusCode = typeof raw.rawStatusCode === 'string' ? raw.rawStatusCode.trim() : '';
  if (occurredAt === '' || rawStatusCode === '') return null;
  const description = typeof raw.description === 'string' ? raw.description.trim() : rawStatusCode;
  const location = typeof raw.location === 'string' && raw.location.trim() !== '' ? raw.location.trim() : null;
  const source: CarrierTrackingEventSource = raw.source === 'PROVIDER_SCAN' ? 'PROVIDER_SCAN' : 'PROVIDER_API';
  return {
    occurredAt,
    status: statusMap[rawStatusCode] ?? 'UNKNOWN',
    rawStatusCode,
    description,
    location,
    source,
    eventKey: [provider, trackingNumber, occurredAt, rawStatusCode, location ?? ''].join('|'),
  };
}

const UPS_TRACKING_ADAPTER: CarrierTrackingAdapter = {
  provider: 'UPS',
  parseStatus: (rawStatusCode) => UPS_STATUS_MAP[rawStatusCode.trim()] ?? 'UNKNOWN',
  mapEvent: (raw, trackingNumber) => mapEventFor('UPS', UPS_STATUS_MAP, trackingNumber, raw),
};
const FEDEX_TRACKING_ADAPTER: CarrierTrackingAdapter = {
  provider: 'FEDEX',
  parseStatus: (rawStatusCode) => FEDEX_STATUS_MAP[rawStatusCode.trim()] ?? 'UNKNOWN',
  mapEvent: (raw, trackingNumber) => mapEventFor('FEDEX', FEDEX_STATUS_MAP, trackingNumber, raw),
};

/** 未知 carrier → null（fail-closed）。 */
export function resolveCarrierTrackingAdapter(provider: string): CarrierTrackingAdapter | null {
  const normalized = provider.toUpperCase();
  if (normalized === 'UPS') return UPS_TRACKING_ADAPTER;
  if (normalized === 'FEDEX') return FEDEX_TRACKING_ADAPTER;
  return null;
}

export interface CarrierTrackingReadDeps {
  port: CarrierTrackingReadPort;
  /** provider-verified account lineage（㉑㉒：account identity 必须 server-derived）。 */
  accounts: CarrierVerifiedAccountRegistry;
  now?: () => Date;
}

export interface CarrierTrackingReadInput {
  provider: string;
  credentialRef?: string | null;
  externalAccountId?: string | null;
  trackingNumber?: string | null;
  organizationId?: string | null;
}

export type CarrierTrackingReadOutcome =
  | {
      ok: true;
      snapshot: CarrierTrackingSnapshot;
      readOnly: true;
      transportEnabled: false;
      platformWriteEnabled: false;
      productionCredentials: 'ABSENT';
    }
  | { ok: false; reason: CarrierTrackingFailureCode };

const ALLOWED_INPUT_KEYS = new Set(['provider', 'credentialRef', 'externalAccountId', 'trackingNumber', 'organizationId']);
const ALLOWED_RAW_KEYS = new Set([
  'provider',
  'externalAccountId',
  'trackingNumber',
  'rawStatusCode',
  'statusText',
  'serviceLevel',
  'origin',
  'destination',
  'shipDate',
  'estimatedDeliveryAt',
  'deliveredAt',
  'events',
  'rawReference',
]);
const CREDENTIAL_MATERIAL_KEY = /(token|secret|password|passwd|apikey|api[-_]?key|client[-_]?secret|credential)/i;

function scanKeys(source: unknown, allowed: Set<string>): CarrierTrackingFailureCode | null {
  if (typeof source !== 'object' || source === null) return 'UNSUPPORTED_INPUT';
  for (const key of Object.keys(source as Record<string, unknown>)) {
    if (allowed.has(key)) continue;
    return CREDENTIAL_MATERIAL_KEY.test(key) ? 'PLAINTEXT_CREDENTIAL_NOT_SUPPORTED' : 'RAW_PAYLOAD_UNSAFE';
  }
  return null;
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function normalizeEvents(
  adapter: CarrierTrackingAdapter,
  trackingNumber: string,
  rawEvents: readonly CarrierRawTrackingEvent[] | undefined,
): CarrierTrackingEvent[] | null {
  const events: CarrierTrackingEvent[] = [];
  const seen = new Set<string>();
  for (const raw of rawEvents ?? []) {
    const mapped = adapter.mapEvent(raw, trackingNumber);
    if (!mapped) return null;
    if (seen.has(mapped.eventKey)) continue;
    seen.add(mapped.eventKey);
    events.push(mapped);
  }
  events.sort((left, right) => {
    if (left.occurredAt !== right.occurredAt) return left.occurredAt < right.occurredAt ? -1 : 1;
    if (left.rawStatusCode !== right.rawStatusCode) return left.rawStatusCode < right.rawStatusCode ? -1 : 1;
    return left.eventKey < right.eventKey ? -1 : left.eventKey > right.eventKey ? 1 : 0;
  });
  return events;
}

export function normalizeCarrierTracking(
  adapter: CarrierTrackingAdapter,
  raw: CarrierRawTrackingRecord,
  observedAt: Date,
): CarrierTrackingSnapshot | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const rawFailure = scanKeys(raw, ALLOWED_RAW_KEYS);
  if (rawFailure) return null;
  if (raw.provider !== adapter.provider) return null;
  const externalAccountId = typeof raw.externalAccountId === 'string' ? raw.externalAccountId.trim() : '';
  const trackingNumber = typeof raw.trackingNumber === 'string' ? raw.trackingNumber.trim() : '';
  const rawStatusCode = typeof raw.rawStatusCode === 'string' ? raw.rawStatusCode.trim() : '';
  const rawReference = typeof raw.rawReference === 'string' ? raw.rawReference.trim() : '';
  if (externalAccountId === '' || trackingNumber === '' || rawStatusCode === '' || rawReference === '') return null;
  const events = normalizeEvents(adapter, trackingNumber, raw.events);
  if (!events) return null;
  const lastEvent = events.length > 0 ? events[events.length - 1] : null;
  return {
    provider: adapter.provider,
    externalAccountId,
    trackingNumber,
    shipmentStatus: adapter.parseStatus(rawStatusCode),
    carrierStatusCode: rawStatusCode,
    statusText: typeof raw.statusText === 'string' ? raw.statusText.trim() : rawStatusCode,
    origin: optionalText(raw.origin),
    destination: optionalText(raw.destination),
    shipDate: optionalText(raw.shipDate),
    estimatedDeliveryAt: optionalText(raw.estimatedDeliveryAt),
    deliveredAt: optionalText(raw.deliveredAt),
    lastEventAt: lastEvent ? lastEvent.occurredAt : null,
    lastEventLocation: lastEvent ? lastEvent.location : null,
    serviceLevel: optionalText(raw.serviceLevel),
    events,
    rawReference,
    observedAt: observedAt.toISOString(),
  };
}

/**
 * 只读 tracking 读取（read-only first）：先证明 account lineage 属于该 tenant，再调用 provider 端口并归一化。
 * trackingNumber 只作为查询 key —— 单独出现**不能**建立 tenant / account 归属。
 */
export async function readCarrierTracking(
  deps: CarrierTrackingReadDeps,
  input: CarrierTrackingReadInput,
): Promise<CarrierTrackingReadOutcome> {
  const adapter = resolveCarrierTrackingAdapter(input.provider);
  if (!adapter) return { ok: false, reason: 'UNKNOWN_CARRIER' };

  const shapeFailure = scanKeys(input, ALLOWED_INPUT_KEYS);
  if (shapeFailure) return { ok: false, reason: shapeFailure };

  const credentialRef = typeof input.credentialRef === 'string' ? input.credentialRef.trim() : '';
  if (credentialRef === '') return { ok: false, reason: 'CREDENTIAL_REF_REQUIRED' };
  const trackingNumber = typeof input.trackingNumber === 'string' ? input.trackingNumber.trim() : '';
  if (trackingNumber === '') return { ok: false, reason: 'TRACKING_NUMBER_REQUIRED' };
  const organizationId = typeof input.organizationId === 'string' ? input.organizationId.trim() : '';
  if (organizationId === '') return { ok: false, reason: 'TENANT_CONTEXT_REQUIRED' };
  const externalAccountId = typeof input.externalAccountId === 'string' ? input.externalAccountId.trim() : '';
  if (externalAccountId === '') return { ok: false, reason: 'UNVERIFIED_ACCOUNT_LINEAGE' };

  const binding = deps.accounts.resolve({ credentialRef, externalAccountId });
  if (!binding) return { ok: false, reason: 'UNVERIFIED_ACCOUNT_LINEAGE' };
  if (binding.provider !== adapter.provider) return { ok: false, reason: 'PROVIDER_ACCOUNT_MISMATCH' };
  if (binding.organizationId !== organizationId) return { ok: false, reason: 'CROSS_TENANT_ACCOUNT' };

  let raw: CarrierRawTrackingRecord;
  try {
    raw = await deps.port.getTracking({
      provider: adapter.provider,
      credentialRef,
      externalAccountId,
      trackingNumber,
      organizationId,
    });
  } catch (error) {
    if (error instanceof CarrierProviderReadError) return { ok: false, reason: error.code };
    return { ok: false, reason: 'PROVIDER_ERROR' };
  }

  const snapshot = normalizeCarrierTracking(adapter, raw, (deps.now ?? (() => new Date()))());
  if (!snapshot) return { ok: false, reason: 'RAW_PAYLOAD_INVALID' };

  return {
    ok: true,
    snapshot,
    readOnly: true,
    transportEnabled: false,
    platformWriteEnabled: false,
    productionCredentials: 'ABSENT',
  };
}

/**
 * 测试 / 本地 fixture：tracking read port（**不发起任何网络请求**）。
 * 未登记的 provider+trackingNumber → CarrierProviderReadError(NOT_FOUND)。
 */
export function createSandboxCarrierTrackingReadPort(
  fixtures: Partial<Record<CarrierProvider, Readonly<Record<string, CarrierRawTrackingRecord>>>> = {},
): CarrierTrackingReadPort {
  return {
    async getTracking(input) {
      const byTracking = fixtures[input.provider];
      const found = byTracking ? byTracking[input.trackingNumber] : undefined;
      if (!found) throw new CarrierProviderReadError('NOT_FOUND', input.trackingNumber);
      return found;
    },
  };
}
