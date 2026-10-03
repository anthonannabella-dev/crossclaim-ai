/**
 * CUSTOMS GAP G4 / C7（MASTER GAP CLOSURE · 架构方 Q3 = PASS）— Handoff-Only 边界契约。
 * ---------------------------------------------------------------
 * C7 = 只做交接：生成 handoff artifact（清单 / 说明 / 支持文件 manifest）与 acknowledgement 归一化；
 * 由客户自主提交或 broker 人工承接。
 *
 * 禁止（架构方 Q3 明文）：自动 filing / 自动点击海关或报关系统提交；broker API write；ABI/EDI write；
 * 自动支付政府费用；把 package generated 当成 filing succeeded；把 handoff 当成 recovered truth。
 * 边界持续：HOLD_EXTERNAL · TRANSPORT=false · filingSubmitted=false · 无生产凭据。
 */

import { createHash } from 'node:crypto';

import { CUSTOMS_PACKAGE_CHECKLIST, type CustomsClaimReadyPackage } from './customs-claim-ready-package';

export const CUSTOMS_HANDOFF_TARGETS = ['CUSTOMER_SELF', 'BROKER', 'PORTAL_DEEPLINK'] as const;
export type CustomsHandoffTarget = (typeof CUSTOMS_HANDOFF_TARGETS)[number];

export const CUSTOMS_HANDOFF_FORBIDDEN_ACTIONS = [
  'AUTO_FILING',
  'AUTO_PORTAL_SUBMIT',
  'BROKER_API_WRITE',
  'ABI_EDI_WRITE',
  'GOVERNMENT_FEE_PAYMENT',
  'TREAT_PACKAGE_AS_FILING',
  'TREAT_HANDOFF_AS_RECOVERED_TRUTH',
] as const;
export type CustomsHandoffForbiddenAction = (typeof CUSTOMS_HANDOFF_FORBIDDEN_ACTIONS)[number];

export const CUSTOMS_HANDOFF_INSTRUCTIONS = [
  'REVIEW_PACKAGE_CHECKLIST',
  'DOWNLOAD_SUPPORTING_DOCUMENTS',
  'SUBMIT_THROUGH_AUTHORIZED_CHANNEL',
  'RECORD_ACKNOWLEDGEMENT_AFTER_SUBMISSION',
] as const;

export const CUSTOMS_ACKNOWLEDGEMENT_CHANNELS = ['PORTAL', 'EMAIL', 'MANUAL', 'BROKER_PORTAL'] as const;
export type CustomsAcknowledgementChannel = (typeof CUSTOMS_ACKNOWLEDGEMENT_CHANNELS)[number];
export const CUSTOMS_ACKNOWLEDGEMENT_ACTORS = ['CUSTOMER', 'BROKER'] as const;
export type CustomsAcknowledgementActor = (typeof CUSTOMS_ACKNOWLEDGEMENT_ACTORS)[number];

export const CUSTOMS_HANDOFF_ERROR_CODES = [
  'INVALID_HANDOFF_INPUT',
  'INVALID_HANDOFF_TARGET',
  'HANDOFF_PACKAGE_NOT_READY',
  'BROKER_REFERENCE_REQUIRED',
  'INVALID_ACKNOWLEDGEMENT',
] as const;
export type CustomsHandoffErrorCode = (typeof CUSTOMS_HANDOFF_ERROR_CODES)[number];

export class CustomsHandoffError extends Error {
  readonly code: CustomsHandoffErrorCode;
  readonly path: string;

  constructor(code: CustomsHandoffErrorCode, fieldPath: string, detail: string) {
    super(code + ' @ ' + fieldPath + ': ' + detail);
    this.name = 'CustomsHandoffError';
    this.code = code;
    this.path = fieldPath;
  }
}

export interface CustomsHandoffArtifact {
  handoffId: string;
  packageId: string;
  target: CustomsHandoffTarget;
  brokerReference: string | null;
  supportingDocumentsManifest: readonly string[];
  checklist: readonly string[];
  instructions: readonly string[];
  forbiddenActions: readonly CustomsHandoffForbiddenAction[];
  requestedAt: string;
  readonly handoffOnly: true;
  readonly filingPerformed: false;
  readonly submissionPerformed: false;
  readonly externalWritePerformed: false;
  readonly transportEnabled: false;
  readonly productionCredentials: 'ABSENT';
}

export interface CustomsHandoffAcknowledgement {
  acknowledgementId: string;
  handoffId: string;
  packageId: string;
  actor: CustomsAcknowledgementActor;
  channel: CustomsAcknowledgementChannel;
  acknowledgedAt: string;
  reference: string;
  readonly recordedByHuman: true;
  readonly filingPerformed: false;
  readonly recoveredTruthDerived: false;
  readonly externalWritePerformed: false;
}

const SAFE_REFERENCE_PATTERN = /^[A-Za-z0-9._:@#/-]{1,96}$/;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

function fail(code: CustomsHandoffErrorCode, fieldPath: string, detail: string): never {
  throw new CustomsHandoffError(code, fieldPath, detail);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map((item) => canonical(item)).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return '{' + Object.keys(record).sort().map((key) => JSON.stringify(key) + ':' + canonical(record[key])).join(',') + '}';
  }
  return JSON.stringify(value ?? null);
}

function sha256Hex(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function requireSafeReference(value: unknown, fieldPath: string, code: CustomsHandoffErrorCode): string {
  if (typeof value !== 'string') fail(code, fieldPath, 'expected a string');
  const trimmed = value.trim();
  if (!SAFE_REFERENCE_PATTERN.test(trimmed)) {
    fail(code, fieldPath, 'expected a machine-safe reference (no spaces / free text / PII)');
  }
  return trimmed;
}

function requireInstant(value: unknown, fieldPath: string, code: CustomsHandoffErrorCode): string {
  if (typeof value !== 'string') fail(code, fieldPath, 'expected a string');
  const trimmed = value.trim();
  if (!ISO_INSTANT_PATTERN.test(trimmed) || Number.isNaN(Date.parse(trimmed))) {
    fail(code, fieldPath, 'expected an ISO-8601 UTC instant');
  }
  return trimmed;
}

/** 生成 handoff artifact（只交接；不提交、不外写、不产生 recovered truth）。 */
export function buildCustomsHandoffArtifact(input: {
  pkg: CustomsClaimReadyPackage;
  target: CustomsHandoffTarget;
  brokerReference?: string | null;
  requestedAt: string;
}): CustomsHandoffArtifact {
  const pkg = input?.pkg;
  if (!pkg || typeof pkg.packageId !== 'string' || !Array.isArray(pkg.evidenceReferences)) {
    fail('INVALID_HANDOFF_INPUT', 'pkg', 'expected a claim-ready package');
  }
  if (pkg.readiness !== 'READY') {
    fail('HANDOFF_PACKAGE_NOT_READY', 'pkg.readiness', 'package must be READY before handoff');
  }
  if (!(CUSTOMS_HANDOFF_TARGETS as readonly string[]).includes(String(input.target))) {
    fail('INVALID_HANDOFF_TARGET', 'target', 'unknown handoff target');
  }
  const target = input.target;
  let brokerReference: string | null = null;
  if (target === 'BROKER') {
    if (input.brokerReference === undefined || input.brokerReference === null) {
      fail('BROKER_REFERENCE_REQUIRED', 'brokerReference', 'broker handoff requires a safe broker reference');
    }
    brokerReference = requireSafeReference(input.brokerReference, 'brokerReference', 'BROKER_REFERENCE_REQUIRED');
  } else if (input.brokerReference !== undefined && input.brokerReference !== null) {
    brokerReference = requireSafeReference(input.brokerReference, 'brokerReference', 'INVALID_HANDOFF_INPUT');
  }
  const requestedAt = requireInstant(input.requestedAt, 'requestedAt', 'INVALID_HANDOFF_INPUT');

  const supportingDocumentsManifest = pkg.evidenceReferences.map((ref) => ref.kind + ':' + ref.reference).sort();

  return {
    handoffId: sha256Hex({ packageId: pkg.packageId, target, brokerReference, requestedAt }).slice(0, 32),
    packageId: pkg.packageId,
    target,
    brokerReference,
    supportingDocumentsManifest,
    checklist: pkg.checklist.length > 0 ? [...pkg.checklist] : [...CUSTOMS_PACKAGE_CHECKLIST],
    instructions: [...CUSTOMS_HANDOFF_INSTRUCTIONS],
    forbiddenActions: [...CUSTOMS_HANDOFF_FORBIDDEN_ACTIONS],
    requestedAt,
    handoffOnly: true,
    filingPerformed: false,
    submissionPerformed: false,
    externalWritePerformed: false,
    transportEnabled: false,
    productionCredentials: 'ABSENT',
  };
}

/** 归一化人工 acknowledgement（事后确认；不代表已提交或已追回）。 */
export function normalizeCustomsHandoffAcknowledgement(input: unknown): CustomsHandoffAcknowledgement {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    fail('INVALID_ACKNOWLEDGEMENT', 'input', 'expected a plain object');
  }
  const record = input as Record<string, unknown>;
  const handoffId = requireSafeReference(record.handoffId, 'handoffId', 'INVALID_ACKNOWLEDGEMENT');
  const packageId = requireSafeReference(record.packageId, 'packageId', 'INVALID_ACKNOWLEDGEMENT');
  const actor = String(record.actor ?? '').toUpperCase();
  if (!(CUSTOMS_ACKNOWLEDGEMENT_ACTORS as readonly string[]).includes(actor)) {
    fail('INVALID_ACKNOWLEDGEMENT', 'actor', 'actor must be CUSTOMER or BROKER');
  }
  const channel = String(record.channel ?? '').toUpperCase();
  if (!(CUSTOMS_ACKNOWLEDGEMENT_CHANNELS as readonly string[]).includes(channel)) {
    fail('INVALID_ACKNOWLEDGEMENT', 'channel', 'unknown acknowledgement channel');
  }
  const acknowledgedAt = requireInstant(record.acknowledgedAt, 'acknowledgedAt', 'INVALID_ACKNOWLEDGEMENT');
  const reference = requireSafeReference(record.reference, 'reference', 'INVALID_ACKNOWLEDGEMENT');

  return {
    acknowledgementId: sha256Hex({ handoffId, packageId, actor, channel, acknowledgedAt, reference }).slice(0, 32),
    handoffId,
    packageId,
    actor: actor as CustomsAcknowledgementActor,
    channel: channel as CustomsAcknowledgementChannel,
    acknowledgedAt,
    reference,
    recordedByHuman: true,
    filingPerformed: false,
    recoveredTruthDerived: false,
    externalWritePerformed: false,
  };
}
