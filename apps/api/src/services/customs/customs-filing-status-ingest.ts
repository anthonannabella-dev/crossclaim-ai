/**
 * C19（续）— 可信 filing status ingest port（HOST DIRECTIVE §3 / MSG-20261003-123 ⑧）
 * ---------------------------------------------------------------
 * 与人工路径分离：人工补录只能产生 USER_REPORTED；provider/authority 事实必须走本 port，
 * 其 sourceLevel 由 adapter 固定（不接受 client 指定），且未知来源一律拒绝（fail-closed）。
 * 本模块不发起任何 provider 调用（真实 webhook/API 集成 = HOLD_EXTERNAL）。
 */

import type { CustomsFilingSourceLevel, CustomsFilingStatus, CustomsFilingStatusFact } from './customs-filing-status';

export type CustomsTrustedIngestSource = Extract<CustomsFilingSourceLevel, 'PROVIDER_VERIFIED' | 'AUTHORITY_VERIFIED'>;

export interface CustomsFilingStatusIngestInput {
  organizationId: string;
  opportunityId: string;
  status: CustomsFilingStatus;
  providerReference: string | null;
  observedAt: string;
  idempotencyKey: string;
}

export interface CustomsFilingStatusIngestStore {
  append(fact: CustomsFilingStatusFact & { idempotencyKey: string }): Promise<{ created: boolean; fact: CustomsFilingStatusFact }>;
}

export type CustomsFilingStatusIngestResult =
  | { ok: true; status: 'RECORDED' | 'ALREADY_RECORDED'; fact: CustomsFilingStatusFact }
  | { ok: false; reason: 'UNKNOWN_SOURCE' | 'MISSING_PROVIDER_REFERENCE' | 'INVALID_TIMESTAMP' | 'FUTURE_TIMESTAMP' };

/** 只有注册为可信的 adapter 才允许调用（adapter 身份由组合根注入，不来自请求体）。 */
export const CUSTOMS_TRUSTED_INGEST_SOURCES: readonly CustomsTrustedIngestSource[] = [
  'PROVIDER_VERIFIED',
  'AUTHORITY_VERIFIED',
];

export async function ingestCustomsFilingStatus(
  input: {
    source: string;
    adapterId: string;
    payload: CustomsFilingStatusIngestInput;
    recordedAt: string;
  },
  deps: { store: CustomsFilingStatusIngestStore; now?: () => Date },
): Promise<CustomsFilingStatusIngestResult> {
  if (!CUSTOMS_TRUSTED_INGEST_SOURCES.includes(input.source as CustomsTrustedIngestSource)) {
    return { ok: false, reason: 'UNKNOWN_SOURCE' };
  }
  if (input.payload.providerReference === null) return { ok: false, reason: 'MISSING_PROVIDER_REFERENCE' };
  const now = deps.now ? deps.now() : new Date();
  const observedMs = Date.parse(input.payload.observedAt);
  if (Number.isNaN(observedMs)) return { ok: false, reason: 'INVALID_TIMESTAMP' };
  if (observedMs > now.getTime()) return { ok: false, reason: 'FUTURE_TIMESTAMP' };

  const fact: CustomsFilingStatusFact & { idempotencyKey: string } = {
    factId: input.adapterId + ':' + input.payload.idempotencyKey,
    organizationId: input.payload.organizationId,
    opportunityId: input.payload.opportunityId,
    status: input.payload.status,
    sourceLevel: input.source as CustomsTrustedIngestSource,
    providerReference: input.payload.providerReference,
    observedAt: input.payload.observedAt,
    recordedAt: input.recordedAt,
    derivesRecoveredCash: false,
    derivesFee: false,
    idempotencyKey: input.payload.idempotencyKey,
  };
  const appended = await deps.store.append(fact);
  return { ok: true, status: appended.created ? 'RECORDED' : 'ALREADY_RECORDED', fact: appended.fact };
}
