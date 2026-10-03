/**
 * CARRIER QUEUE #5（MSG-20261003-109 ⑪–㉖）— Invoice + POD **只读**事实平面。
 * ---------------------------------------------------------------
 *   · 只建立 carrier-billed facts 与 delivery evidence facts：**不推导** refund due / recovery due / success fee due。
 *   · 金额一律十进制字符串（禁止 float）；货币 3 位大写。
 *   · request identity + response identity 双向绑定（account / invoice reference / tracking）。
 *   · 完整 provider raw payload 不入 customer response，只保留 safe rawReference / artifact reference。
 *   · POD privacy：recipient name 只回 masked；不暴露 signature image / 完整私人姓名 / 完整 payload。
 *   · TRANSPORT=false · platformWriteEnabled=false · productionCredentials=ABSENT · 无真实 provider 调用。
 */

import type { CarrierProvider } from './connector-capability';
import {
  CarrierProviderReadError,
  type CarrierProviderReadErrorCode,
  type CarrierVerifiedAccountRegistry,
} from './carrier-tracking-read';

/** ⑯ charge kind 归一化（raw code 必须保留，未知 → OTHER 不猜）。 */
export const CARRIER_INVOICE_CHARGE_KINDS = [
  'BASE',
  'FUEL',
  'RESIDENTIAL',
  'REMOTE_AREA',
  'ADDRESS_CORRECTION',
  'DIMENSIONAL',
  'OVERSIZE',
  'DUTY_TAX',
  'OTHER',
] as const;
export type CarrierInvoiceChargeKind = (typeof CARRIER_INVOICE_CHARGE_KINDS)[number];

export const CARRIER_POD_DELIVERY_STATUSES = ['DELIVERED', 'ATTEMPTED', 'UNKNOWN'] as const;
export type CarrierPODDeliveryStatus = (typeof CARRIER_POD_DELIVERY_STATUSES)[number];

export const CARRIER_POD_PROOF_TYPES = ['SIGNATURE', 'PHOTO', 'ELECTRONIC', 'UNKNOWN'] as const;
export type CarrierPODProofType = (typeof CARRIER_POD_PROOF_TYPES)[number];

export interface CarrierInvoiceCharge {
  kind: CarrierInvoiceChargeKind;
  rawChargeCode: string;
  amount: string;
  currency: string;
}

export interface CarrierInvoiceFact {
  provider: CarrierProvider;
  externalAccountId: string;
  invoiceReference: string;
  invoiceDate: string | null;
  trackingNumber: string | null;
  shipmentReference: string | null;
  serviceLevel: string | null;
  currency: string;
  baseCharge: string | null;
  fuelSurcharge: string | null;
  accessorialCharges: string | null;
  tax: string | null;
  totalCharge: string;
  billedWeight: string | null;
  billedZone: string | null;
  rawChargeCodes: readonly string[];
  charges: readonly CarrierInvoiceCharge[];
  rawReference: string;
  observedAt: string;
}

export interface CarrierRawInvoiceCharge {
  rawChargeCode: string;
  amount: string;
  currency?: string | null;
}

export interface CarrierRawInvoiceRecord {
  provider: CarrierProvider;
  externalAccountId: string;
  invoiceReference: string;
  invoiceDate?: string | null;
  trackingNumber?: string | null;
  shipmentReference?: string | null;
  serviceLevel?: string | null;
  currency: string;
  totalCharge: string;
  charges?: readonly CarrierRawInvoiceCharge[];
  billedWeight?: string | null;
  billedZone?: string | null;
  rawReference: string;
}

export interface CarrierRawPODRecord {
  provider: CarrierProvider;
  externalAccountId: string;
  trackingNumber: string;
  deliveryStatus: string;
  deliveredAt?: string | null;
  deliveryLocation?: string | null;
  recipientName?: string | null;
  signed?: boolean | null;
  signatureAvailable?: boolean | null;
  proofType?: string | null;
  documentReference?: string | null;
  rawReference: string;
}

export interface CarrierPODFact {
  provider: CarrierProvider;
  externalAccountId: string;
  trackingNumber: string;
  deliveryStatus: CarrierPODDeliveryStatus;
  deliveredAt: string | null;
  deliveryLocation: string | null;
  /** ⑲：只回 masked 姓名，完整私人姓名不外泄。 */
  recipientNameMasked: string | null;
  signed: boolean;
  signatureAvailable: boolean;
  proofType: CarrierPODProofType;
  /** artifact reference（不是 signature image 本身）。 */
  documentReference: string | null;
  rawReference: string;
  observedAt: string;
}

export interface CarrierInvoiceReadPort {
  getInvoiceFacts(input: {
    provider: CarrierProvider;
    credentialRef: string;
    externalAccountId: string;
    organizationId: string;
    invoiceReference?: string | null;
    trackingNumber?: string | null;
  }): Promise<readonly CarrierRawInvoiceRecord[]>;
}

export interface CarrierPODReadPort {
  getPOD(input: {
    provider: CarrierProvider;
    credentialRef: string;
    externalAccountId: string;
    trackingNumber: string;
    organizationId: string;
  }): Promise<CarrierRawPODRecord>;
}

export type CarrierInvoicePODFailureCode =
  | 'UNKNOWN_CARRIER'
  | 'PLAINTEXT_CREDENTIAL_NOT_SUPPORTED'
  | 'UNSUPPORTED_INPUT'
  | 'CREDENTIAL_REF_REQUIRED'
  | 'TRACKING_NUMBER_REQUIRED'
  | 'TENANT_CONTEXT_REQUIRED'
  | 'UNVERIFIED_ACCOUNT_LINEAGE'
  | 'CROSS_TENANT_ACCOUNT'
  | 'PROVIDER_ACCOUNT_MISMATCH'
  | 'ACCOUNT_MISMATCH'
  | 'INVOICE_IDENTITY_MISMATCH'
  | 'TRACKING_IDENTITY_MISMATCH'
  | 'POD_TRACKING_IDENTITY_MISMATCH'
  | 'INVALID_AMOUNT'
  | 'CURRENCY_REQUIRED'
  | 'CHARGE_CURRENCY_MISMATCH'
  | 'RAW_PAYLOAD_INVALID'
  | CarrierProviderReadErrorCode;

/* ---------------------------------------------------------------- money helpers（十进制字符串，禁止 float） */

export function isDecimalString(value: string): boolean {
  return /^-?\d+(\.\d{1,6})?$/.test(value.trim());
}

/** 精确十进制加法：按最大小数位放大为 BigInt，再加总后还原（不经过浮点）。 */
export function addDecimalStrings(values: readonly string[]): string {
  if (values.length === 0) return '0';
  const scale = values.reduce((max, value) => {
    const dot = value.indexOf('.');
    return Math.max(max, dot >= 0 ? value.length - dot - 1 : 0);
  }, 0);
  let total = 0n;
  for (const value of values) {
    const negative = value.trim().startsWith('-');
    const digits = value.trim().replace('-', '');
    const [whole, fraction = ''] = digits.split('.');
    const scaled = BigInt(whole + fraction.padEnd(scale, '0'));
    total += negative ? -scaled : scaled;
  }
  const negative = total < 0n;
  const absolute = (negative ? -total : total).toString().padStart(scale + 1, '0');
  if (scale === 0) return (negative ? '-' : '') + absolute;
  const whole = absolute.slice(0, absolute.length - scale);
  const fraction = absolute.slice(absolute.length - scale);
  return (negative ? '-' : '') + whole + '.' + fraction;
}

/** ⑲ 姓名掩码：只保留首字符。 */
export function maskRecipientName(name: string | null | undefined): string | null {
  if (typeof name !== 'string' || name.trim() === '') return null;
  const trimmed = name.trim();
  return trimmed.slice(0, 1) + '***';
}

/* ---------------------------------------------------------------- provider adapters（㉒：不做 giant conditional） */

export interface CarrierInvoiceAdapter {
  provider: CarrierProvider;
  chargeKind(rawChargeCode: string): CarrierInvoiceChargeKind;
}

export interface CarrierPODAdapter {
  provider: CarrierProvider;
  deliveryStatus(rawStatus: string): CarrierPODDeliveryStatus;
  proofType(rawProofType: string | null | undefined): CarrierPODProofType;
}

/** 内部归一化表；真实 carrier charge code 表在 sandbox / real-data validation 阶段核对（HOLD_EXTERNAL）。 */
const UPS_CHARGE_KIND_MAP: Readonly<Record<string, CarrierInvoiceChargeKind>> = {
  BASE: 'BASE',
  TP: 'BASE',
  FUEL: 'FUEL',
  RES: 'RESIDENTIAL',
  RESIDENTIAL: 'RESIDENTIAL',
  REMOTE: 'REMOTE_AREA',
  ADDR_CORR: 'ADDRESS_CORRECTION',
  DIM: 'DIMENSIONAL',
  OVSZ: 'OVERSIZE',
  DUTY: 'DUTY_TAX',
};

const FEDEX_CHARGE_KIND_MAP: Readonly<Record<string, CarrierInvoiceChargeKind>> = {
  BASE_CHARGE: 'BASE',
  TRANSPORTATION: 'BASE',
  FUEL_SURCHARGE: 'FUEL',
  RESIDENTIAL_DELIVERY: 'RESIDENTIAL',
  REMOTE_AREA: 'REMOTE_AREA',
  ADDRESS_CORRECTION: 'ADDRESS_CORRECTION',
  DIM_WEIGHT: 'DIMENSIONAL',
  OVERSIZE: 'OVERSIZE',
  DUTIES_TAXES: 'DUTY_TAX',
};

const UPS_INVOICE_ADAPTER: CarrierInvoiceAdapter = {
  provider: 'UPS',
  chargeKind: (rawChargeCode) => UPS_CHARGE_KIND_MAP[rawChargeCode.trim().toUpperCase()] ?? 'OTHER',
};
const FEDEX_INVOICE_ADAPTER: CarrierInvoiceAdapter = {
  provider: 'FEDEX',
  chargeKind: (rawChargeCode) => FEDEX_CHARGE_KIND_MAP[rawChargeCode.trim().toUpperCase()] ?? 'OTHER',
};

const UPS_POD_ADAPTER: CarrierPODAdapter = {
  provider: 'UPS',
  deliveryStatus: (rawStatus) => {
    const code = rawStatus.trim().toUpperCase();
    if (code === 'D' || code === 'DELIVERED') return 'DELIVERED';
    if (code === 'X' || code === 'ATTEMPTED') return 'ATTEMPTED';
    return 'UNKNOWN';
  },
  proofType: (rawProofType) => {
    if (rawProofType === 'SIGNATURE') return 'SIGNATURE';
    if (rawProofType === 'PHOTO') return 'PHOTO';
    if (rawProofType === 'ELECTRONIC') return 'ELECTRONIC';
    return 'UNKNOWN';
  },
};
const FEDEX_POD_ADAPTER: CarrierPODAdapter = {
  provider: 'FEDEX',
  deliveryStatus: (rawStatus) => {
    const code = rawStatus.trim().toUpperCase();
    if (code === 'DL' || code === 'DELIVERED') return 'DELIVERED';
    if (code === 'DE' || code === 'ATTEMPTED') return 'ATTEMPTED';
    return 'UNKNOWN';
  },
  proofType: (rawProofType) => {
    if (rawProofType === 'SIGNATURE') return 'SIGNATURE';
    if (rawProofType === 'PHOTO') return 'PHOTO';
    if (rawProofType === 'ELECTRONIC') return 'ELECTRONIC';
    return 'UNKNOWN';
  },
};

/** 未知 carrier → null（fail-closed）。 */
export function resolveCarrierInvoiceAdapter(provider: string): CarrierInvoiceAdapter | null {
  const normalized = provider.toUpperCase();
  if (normalized === 'UPS') return UPS_INVOICE_ADAPTER;
  if (normalized === 'FEDEX') return FEDEX_INVOICE_ADAPTER;
  return null;
}

export function resolveCarrierPODAdapter(provider: string): CarrierPODAdapter | null {
  const normalized = provider.toUpperCase();
  if (normalized === 'UPS') return UPS_POD_ADAPTER;
  if (normalized === 'FEDEX') return FEDEX_POD_ADAPTER;
  return null;
}

/* ---------------------------------------------------------------- guards */

const ALLOWED_INVOICE_INPUT_KEYS = new Set(['provider', 'credentialRef', 'externalAccountId', 'organizationId', 'invoiceReference', 'trackingNumber']);
const ALLOWED_POD_INPUT_KEYS = new Set(['provider', 'credentialRef', 'externalAccountId', 'organizationId', 'trackingNumber']);
const ALLOWED_RAW_INVOICE_KEYS = new Set(['provider', 'externalAccountId', 'invoiceReference', 'invoiceDate', 'trackingNumber', 'shipmentReference', 'serviceLevel', 'currency', 'totalCharge', 'charges', 'billedWeight', 'billedZone', 'rawReference']);
const ALLOWED_RAW_INVOICE_CHARGE_KEYS = new Set(['rawChargeCode', 'amount', 'currency']);
const ALLOWED_RAW_POD_KEYS = new Set(['provider', 'externalAccountId', 'trackingNumber', 'deliveryStatus', 'deliveredAt', 'deliveryLocation', 'recipientName', 'signed', 'signatureAvailable', 'proofType', 'documentReference', 'rawReference']);
const CREDENTIAL_MATERIAL_KEY = /(token|secret|password|passwd|apikey|api[-_]?key|client[-_]?secret|credential|signatureimage|signatureImage)/i;

function scanKeys(source: unknown, allowed: Set<string>): CarrierInvoicePODFailureCode | null {
  if (typeof source !== 'object' || source === null) return 'RAW_PAYLOAD_INVALID';
  for (const key of Object.keys(source as Record<string, unknown>)) {
    if (allowed.has(key)) continue;
    return CREDENTIAL_MATERIAL_KEY.test(key) ? 'PLAINTEXT_CREDENTIAL_NOT_SUPPORTED' : 'RAW_PAYLOAD_INVALID';
  }
  return null;
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function tenantContext(organizationId: unknown): string | null {
  return typeof organizationId === 'string' && organizationId.trim() !== '' ? organizationId.trim() : null;
}

function mapProviderError(error: unknown): CarrierInvoicePODFailureCode {
  if (error instanceof CarrierProviderReadError) return error.code;
  return 'PROVIDER_ERROR';
}

/** 共享前置：provider / 输入形状 / credentialRef / tenant / verified account lineage。 */
function preflight(
  accounts: CarrierVerifiedAccountRegistry,
  input: { provider: string; credentialRef?: string | null; externalAccountId?: string | null; organizationId?: string | null },
  allowedInputKeys: Set<string>,
  provider: CarrierProvider | null,
): { ok: true; credentialRef: string; externalAccountId: string; organizationId: string } | { ok: false; reason: CarrierInvoicePODFailureCode } {
  if (!provider) return { ok: false, reason: 'UNKNOWN_CARRIER' };
  const shapeFailure = scanKeys(input, allowedInputKeys);
  if (shapeFailure) return { ok: false, reason: shapeFailure };
  const credentialRef = typeof input.credentialRef === 'string' ? input.credentialRef.trim() : '';
  if (credentialRef === '') return { ok: false, reason: 'CREDENTIAL_REF_REQUIRED' };
  const organizationId = tenantContext(input.organizationId);
  if (!organizationId) return { ok: false, reason: 'TENANT_CONTEXT_REQUIRED' };
  const externalAccountId = typeof input.externalAccountId === 'string' ? input.externalAccountId.trim() : '';
  if (externalAccountId === '') return { ok: false, reason: 'UNVERIFIED_ACCOUNT_LINEAGE' };
  const binding = accounts.resolve({ credentialRef, externalAccountId });
  if (!binding) return { ok: false, reason: 'UNVERIFIED_ACCOUNT_LINEAGE' };
  if (binding.provider !== provider) return { ok: false, reason: 'PROVIDER_ACCOUNT_MISMATCH' };
  if (binding.organizationId !== organizationId) return { ok: false, reason: 'CROSS_TENANT_ACCOUNT' };
  return { ok: true, credentialRef, externalAccountId, organizationId };
}

/* ---------------------------------------------------------------- invoice read plane */

export interface CarrierInvoiceReadDeps {
  port: CarrierInvoiceReadPort;
  accounts: CarrierVerifiedAccountRegistry;
  now?: () => Date;
}

export interface CarrierInvoiceReadInput {
  provider: string;
  credentialRef?: string | null;
  externalAccountId?: string | null;
  organizationId?: string | null;
  invoiceReference?: string | null;
  trackingNumber?: string | null;
}

export type CarrierInvoiceReadOutcome =
  | {
      ok: true;
      facts: readonly CarrierInvoiceFact[];
      readOnly: true;
      transportEnabled: false;
      platformWriteEnabled: false;
      productionCredentials: 'ABSENT';
      /** ⑮：只建立 carrier-billed facts —— 不做 eligibility / refund / fee 推导。 */
      billingTruthOnly: true;
    }
  | { ok: false; reason: CarrierInvoicePODFailureCode };

function normalizeInvoice(
  adapter: CarrierInvoiceAdapter,
  request: { externalAccountId: string; invoiceReference: string | null; trackingNumber: string | null },
  raw: CarrierRawInvoiceRecord,
  observedAt: Date,
): CarrierInvoiceFact | CarrierInvoicePODFailureCode {
  const rawFailure = scanKeys(raw, ALLOWED_RAW_INVOICE_KEYS);
  if (rawFailure) return rawFailure;
  if (raw.provider !== adapter.provider) return 'RAW_PAYLOAD_INVALID';
  const externalAccountId = typeof raw.externalAccountId === 'string' ? raw.externalAccountId.trim() : '';
  if (externalAccountId !== request.externalAccountId) return 'ACCOUNT_MISMATCH';
  const invoiceReference = typeof raw.invoiceReference === 'string' ? raw.invoiceReference.trim() : '';
  if (invoiceReference === '') return 'RAW_PAYLOAD_INVALID';
  // ㉑ request identity ↔ response identity 双向绑定
  if (request.invoiceReference && invoiceReference !== request.invoiceReference) return 'INVOICE_IDENTITY_MISMATCH';
  const rawTracking = optionalText(raw.trackingNumber);
  if (request.trackingNumber && rawTracking !== request.trackingNumber) return 'TRACKING_IDENTITY_MISMATCH';
  // MSG-110 ⑭：核心 truth plane 只接受 canonical（provider adapter 负责 canonicalization）。
  const currency = typeof raw.currency === 'string' ? raw.currency.trim() : '';
  if (!/^[A-Z]{3}$/.test(currency)) return 'CURRENCY_REQUIRED';
  const totalCharge = typeof raw.totalCharge === 'string' ? raw.totalCharge.trim() : '';
  if (!isDecimalString(totalCharge)) return 'INVALID_AMOUNT';
  const rawReference = typeof raw.rawReference === 'string' ? raw.rawReference.trim() : '';
  if (rawReference === '') return 'RAW_PAYLOAD_INVALID';

  const charges: CarrierInvoiceCharge[] = [];
  const rawChargeCodes: string[] = [];
  for (const charge of raw.charges ?? []) {
    const chargeFailure = scanKeys(charge, ALLOWED_RAW_INVOICE_CHARGE_KEYS);
    if (chargeFailure) return chargeFailure;
    const rawChargeCode = typeof charge.rawChargeCode === 'string' ? charge.rawChargeCode.trim() : '';
    const amount = typeof charge.amount === 'string' ? charge.amount.trim() : '';
    if (rawChargeCode === '' || !isDecimalString(amount)) return 'INVALID_AMOUNT';
    // MSG-110 ⑰⑱：charge currency 必须 canonical 且与 invoice currency 一致（禁止混币加总）。
    const explicitCurrency = optionalText(charge.currency);
    if (explicitCurrency !== null && !/^[A-Z]{3}$/.test(explicitCurrency)) return 'CURRENCY_REQUIRED';
    if (explicitCurrency !== null && explicitCurrency !== currency) return 'CHARGE_CURRENCY_MISMATCH';
    const chargeCurrency = explicitCurrency ?? currency;
    rawChargeCodes.push(rawChargeCode);
    charges.push({
      kind: adapter.chargeKind(rawChargeCode),
      rawChargeCode,
      amount,
      currency: chargeCurrency,
    });
  }

  const sumKinds = (kinds: readonly CarrierInvoiceChargeKind[]): string | null => {
    const amounts = charges.filter((charge) => kinds.includes(charge.kind)).map((charge) => charge.amount);
    return amounts.length === 0 ? null : addDecimalStrings(amounts);
  };

  return {
    provider: adapter.provider,
    externalAccountId,
    invoiceReference,
    invoiceDate: optionalText(raw.invoiceDate),
    trackingNumber: rawTracking,
    shipmentReference: optionalText(raw.shipmentReference),
    serviceLevel: optionalText(raw.serviceLevel),
    currency,
    baseCharge: sumKinds(['BASE']),
    fuelSurcharge: sumKinds(['FUEL']),
    accessorialCharges: sumKinds(['RESIDENTIAL', 'REMOTE_AREA', 'ADDRESS_CORRECTION', 'DIMENSIONAL', 'OVERSIZE', 'OTHER']),
    tax: sumKinds(['DUTY_TAX']),
    totalCharge,
    billedWeight: optionalText(raw.billedWeight),
    billedZone: optionalText(raw.billedZone),
    rawChargeCodes,
    charges,
    rawReference,
    observedAt: observedAt.toISOString(),
  };
}

export async function readCarrierInvoiceFacts(
  deps: CarrierInvoiceReadDeps,
  input: CarrierInvoiceReadInput,
): Promise<CarrierInvoiceReadOutcome> {
  const adapter = resolveCarrierInvoiceAdapter(input.provider);
  const pre = preflight(deps.accounts, input, ALLOWED_INVOICE_INPUT_KEYS, adapter?.provider ?? null);
  if (!pre.ok) return { ok: false, reason: pre.reason };

  const invoiceReference = optionalText(input.invoiceReference);
  const trackingNumber = optionalText(input.trackingNumber);

  let raw: readonly CarrierRawInvoiceRecord[];
  try {
    raw = await deps.port.getInvoiceFacts({
      provider: adapter!.provider,
      credentialRef: pre.credentialRef,
      externalAccountId: pre.externalAccountId,
      organizationId: pre.organizationId,
      invoiceReference,
      trackingNumber,
    });
  } catch (error) {
    return { ok: false, reason: mapProviderError(error) };
  }
  if (!Array.isArray(raw)) return { ok: false, reason: 'RAW_PAYLOAD_INVALID' };
  if (raw.length === 0) return { ok: false, reason: 'NOT_FOUND' };

  const observedAt = (deps.now ?? (() => new Date()))();
  const facts: CarrierInvoiceFact[] = [];
  for (const record of raw) {
    const normalized = normalizeInvoice(adapter!, { externalAccountId: pre.externalAccountId, invoiceReference, trackingNumber }, record, observedAt);
    if (typeof normalized === 'string') return { ok: false, reason: normalized };
    facts.push(normalized);
  }

  return { ok: true, facts, readOnly: true, transportEnabled: false, platformWriteEnabled: false, productionCredentials: 'ABSENT', billingTruthOnly: true };
}

/* ---------------------------------------------------------------- POD read plane */

export interface CarrierPODReadDeps {
  port: CarrierPODReadPort;
  accounts: CarrierVerifiedAccountRegistry;
  now?: () => Date;
}

export interface CarrierPODReadInput {
  provider: string;
  credentialRef?: string | null;
  externalAccountId?: string | null;
  trackingNumber?: string | null;
  organizationId?: string | null;
}

export type CarrierPODReadOutcome =
  | {
      ok: true;
      pod: CarrierPODFact;
      readOnly: true;
      transportEnabled: false;
      platformWriteEnabled: false;
      productionCredentials: 'ABSENT';
      /** ⑳：POD 只是 carrier 返回的 delivery evidence —— 不是 claim / SLA 判定。 */
      deliveryEvidenceOnly: true;
    }
  | { ok: false; reason: CarrierInvoicePODFailureCode };

export async function readCarrierPOD(
  deps: CarrierPODReadDeps,
  input: CarrierPODReadInput,
): Promise<CarrierPODReadOutcome> {
  const adapter = resolveCarrierPODAdapter(input.provider);
  const pre = preflight(deps.accounts, input, ALLOWED_POD_INPUT_KEYS, adapter?.provider ?? null);
  if (!pre.ok) return { ok: false, reason: pre.reason };

  const trackingNumber = typeof input.trackingNumber === 'string' ? input.trackingNumber.trim() : '';
  if (trackingNumber === '') return { ok: false, reason: 'TRACKING_NUMBER_REQUIRED' };

  let raw: CarrierRawPODRecord;
  try {
    raw = await deps.port.getPOD({
      provider: adapter!.provider,
      credentialRef: pre.credentialRef,
      externalAccountId: pre.externalAccountId,
      trackingNumber,
      organizationId: pre.organizationId,
    });
  } catch (error) {
    return { ok: false, reason: mapProviderError(error) };
  }

  const rawFailure = scanKeys(raw, ALLOWED_RAW_POD_KEYS);
  if (rawFailure) return { ok: false, reason: rawFailure };
  if (raw.provider !== adapter!.provider) return { ok: false, reason: 'RAW_PAYLOAD_INVALID' };
  const rawAccountId = typeof raw.externalAccountId === 'string' ? raw.externalAccountId.trim() : '';
  if (rawAccountId !== pre.externalAccountId) return { ok: false, reason: 'ACCOUNT_MISMATCH' };
  const rawTracking = typeof raw.trackingNumber === 'string' ? raw.trackingNumber.trim() : '';
  if (rawTracking !== trackingNumber) return { ok: false, reason: 'POD_TRACKING_IDENTITY_MISMATCH' };
  const rawReference = typeof raw.rawReference === 'string' ? raw.rawReference.trim() : '';
  if (rawReference === '') return { ok: false, reason: 'RAW_PAYLOAD_INVALID' };

  const pod: CarrierPODFact = {
    provider: adapter!.provider,
    externalAccountId: pre.externalAccountId,
    trackingNumber,
    deliveryStatus: adapter!.deliveryStatus(typeof raw.deliveryStatus === 'string' ? raw.deliveryStatus : ''),
    deliveredAt: optionalText(raw.deliveredAt),
    deliveryLocation: optionalText(raw.deliveryLocation),
    recipientNameMasked: maskRecipientName(raw.recipientName),
    signed: raw.signed === true,
    signatureAvailable: raw.signatureAvailable === true,
    proofType: adapter!.proofType(raw.proofType),
    documentReference: optionalText(raw.documentReference),
    rawReference,
    observedAt: (deps.now ?? (() => new Date()))().toISOString(),
  };

  return { ok: true, pod, readOnly: true, transportEnabled: false, platformWriteEnabled: false, productionCredentials: 'ABSENT', deliveryEvidenceOnly: true };
}

/* ---------------------------------------------------------------- sandbox fixtures（无网络） */

export function createSandboxCarrierInvoiceReadPort(
  fixtures: Partial<Record<CarrierProvider, readonly CarrierRawInvoiceRecord[]>> = {},
): CarrierInvoiceReadPort {
  return {
    async getInvoiceFacts(input) {
      const all = fixtures[input.provider] ?? [];
      return all.filter((record) => {
        if (input.invoiceReference && record.invoiceReference !== input.invoiceReference) return false;
        if (input.trackingNumber && (record.trackingNumber ?? '') !== input.trackingNumber) return false;
        return true;
      });
    },
  };
}

export function createSandboxCarrierPODReadPort(
  fixtures: Partial<Record<CarrierProvider, Readonly<Record<string, CarrierRawPODRecord>>>> = {},
): CarrierPODReadPort {
  return {
    async getPOD(input) {
      const byTracking = fixtures[input.provider];
      const found = byTracking ? byTracking[input.trackingNumber] : undefined;
      if (!found) throw new CarrierProviderReadError('NOT_FOUND', input.trackingNumber);
      return found;
    },
  };
}
