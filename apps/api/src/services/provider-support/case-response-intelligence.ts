// PROVIDER FOLLOW-UP INTELLIGENCE / P3（slice A-S4）—— Case Response Intelligence（纯决策层）
// ---------------------------------------------------------------------------
// 定位（HOST P3）：
//   ProviderContactFact（原始事实，A-S3）
//     → CaseResponseInterpretation（本模块；AI 解读，advisory only）
//     → RequiredEvidence[]              （需求清单，供 A-S5 Evidence Resolver 消费）
//     → RecommendedNextAction           （建议动作；绝不等于批准，也绝不触发执行）
// 硬规则：AI 不得改金额真值、不得创建证据、不得产生 provider fact、不得直接执行 platform write；
//        低置信或疑似 prompt injection → NEEDS_MANUAL_REVIEW。

import { digestOf } from '../config-execution-durability/digests';
import type { ProviderContact } from './provider-case';

export const CASE_RESPONSE_INTELLIGENCE_VERSION = 'case-response-intelligence/v1';

export const CASE_RESPONSE_CLASSIFICATIONS = [
  'NEED_INVOICE',
  'NEED_POD',
  'NEED_PURCHASE_PROOF',
  'NEED_TRACKING',
  'NEED_DIMENSION_EVIDENCE',
  'NEED_CUSTOMS_DOCUMENT',
  'NEED_RETURN_PROOF',
  'NEED_DESTRUCTION_PROOF',
  'NEED_MORE_INFO',
  'APPROVED',
  'REJECTED',
  'PARTIALLY_APPROVED',
  'CLOSED',
  'WAITING_PROVIDER',
  'WAITING_SELLER',
  'UNKNOWN',
] as const;
export type CaseResponseClassification = (typeof CASE_RESPONSE_CLASSIFICATIONS)[number];

export const REQUIRED_EVIDENCE_KINDS = [
  'COMMERCIAL_INVOICE',
  'PURCHASE_INVOICE',
  'POD',
  'TRACKING_CONFIRMATION',
  'DIMENSION_EVIDENCE',
  'CBP_7501',
  'DUTY_STATEMENT',
  'RETURN_RECORD',
  'DESTRUCTION_CERTIFICATE',
] as const;
export type RequiredEvidenceKind = (typeof REQUIRED_EVIDENCE_KINDS)[number];

export const RECOMMENDED_NEXT_ACTIONS = [
  'EVIDENCE_RESOLUTION',
  'CUSTOMER_EVIDENCE_REQUEST',
  'WAIT',
  'RECORD_OUTCOME',
  'RECORD_REJECTION',
  'CLOSE_CASE',
  'HUMAN_REVIEW',
] as const;
export type RecommendedNextAction = (typeof RECOMMENDED_NEXT_ACTIONS)[number];

/** classification → 需求证据（单源；Evidence Resolver 只消费这里的结果）。 */
export const CLASSIFICATION_REQUIRED_EVIDENCE: Record<CaseResponseClassification, readonly RequiredEvidenceKind[]> = {
  NEED_INVOICE: ['COMMERCIAL_INVOICE', 'PURCHASE_INVOICE'],
  NEED_POD: ['POD'],
  NEED_PURCHASE_PROOF: ['PURCHASE_INVOICE'],
  NEED_TRACKING: ['TRACKING_CONFIRMATION'],
  NEED_DIMENSION_EVIDENCE: ['DIMENSION_EVIDENCE'],
  NEED_CUSTOMS_DOCUMENT: ['CBP_7501', 'DUTY_STATEMENT'],
  NEED_RETURN_PROOF: ['RETURN_RECORD'],
  NEED_DESTRUCTION_PROOF: ['DESTRUCTION_CERTIFICATE'],
  NEED_MORE_INFO: [],
  APPROVED: [],
  REJECTED: [],
  PARTIALLY_APPROVED: [],
  CLOSED: [],
  WAITING_PROVIDER: [],
  WAITING_SELLER: [],
  UNKNOWN: [],
};

export const CLASSIFICATION_RECOMMENDED_ACTION: Record<CaseResponseClassification, RecommendedNextAction> = {
  NEED_INVOICE: 'EVIDENCE_RESOLUTION',
  NEED_POD: 'EVIDENCE_RESOLUTION',
  NEED_PURCHASE_PROOF: 'EVIDENCE_RESOLUTION',
  NEED_TRACKING: 'EVIDENCE_RESOLUTION',
  NEED_DIMENSION_EVIDENCE: 'EVIDENCE_RESOLUTION',
  NEED_CUSTOMS_DOCUMENT: 'EVIDENCE_RESOLUTION',
  NEED_RETURN_PROOF: 'EVIDENCE_RESOLUTION',
  NEED_DESTRUCTION_PROOF: 'EVIDENCE_RESOLUTION',
  NEED_MORE_INFO: 'HUMAN_REVIEW',
  APPROVED: 'RECORD_OUTCOME',
  REJECTED: 'RECORD_REJECTION',
  PARTIALLY_APPROVED: 'RECORD_OUTCOME',
  CLOSED: 'CLOSE_CASE',
  WAITING_PROVIDER: 'WAIT',
  WAITING_SELLER: 'WAIT',
  UNKNOWN: 'HUMAN_REVIEW',
};

export const DEFAULT_INTERPRETATION_CONFIDENCE_THRESHOLD_BP = 7_000;
export const MAX_PROVIDER_TEXT_CHARS = 8_000;

/** 疑似 prompt injection / 越权指令的特征（只用于降级为人工复核，不作为执行依据）。 */
const INJECTION_PATTERNS: readonly RegExp[] = [
  /ignore (all )?(previous|prior) instructions/i,
  /system prompt/i,
  /you are now/i,
  /execute (the )?(following|command)/i,
  /call (the )?tool/i,
  /api[_ -]?key/i,
  /bearer\s+[A-Za-z0-9._-]{8,}/i,
  /transfer|wire|remit/i,
  /approve (immediately|now|without)/i,
];

export interface UntrustedProviderText {
  text: string;
  truncated: boolean;
  injectionSuspected: boolean;
  matchedPatterns: string[];
}

/** provider 文本永远是不可信输入：截断 + 指令特征检测（但绝不据此执行任何动作）。 */
export function readUntrustedProviderText(contact: ProviderContact): UntrustedProviderText {
  const raw = (contact.bodyText ?? '').trim();
  const truncated = raw.length > MAX_PROVIDER_TEXT_CHARS;
  const text = truncated ? raw.slice(0, MAX_PROVIDER_TEXT_CHARS) : raw;
  const matched = INJECTION_PATTERNS.filter((p) => p.test(text)).map((p) => p.source);
  return { text, truncated, injectionSuspected: matched.length > 0, matchedPatterns: matched };
}

export interface CaseResponseClassificationSignal {
  classification: CaseResponseClassification;
  /** 置信度（basis points，0..10000） */
  confidenceBp: number;
  extractedRequirements?: readonly string[];
}

/** 分类器端口：真实实现由注入的 LLM/adapter 提供；本模块只消费结构化结果。 */
export interface CaseResponseClassifierPort {
  classify(input: { text: string; contactId: string; providerCaseId: string }): Promise<CaseResponseClassificationSignal>;
}

export interface CaseResponseInterpretation {
  kind: 'CASE_RESPONSE_INTERPRETATION';
  advisoryOnly: true;
  canAuthorizeExecution: false;
  organizationId: string;
  platformAccountId: string;
  providerCaseId: string;
  sourceContactId: string;
  sourceBodyDigest: string | null;
  classification: CaseResponseClassification;
  confidenceBp: number;
  requiredEvidence: RequiredEvidenceKind[];
  extractedRequirements: string[];
  recommendedNextAction: RecommendedNextAction;
  disposition: 'AUTO' | 'NEEDS_MANUAL_REVIEW';
  dispositionReasons: string[];
  injectionSuspected: boolean;
  model: string;
  promptVersion: string;
  classifierVersion: string;
  createdAt: string;
  interpretationDigest: string;
}

export interface InterpretProviderContactInput {
  scope: { organizationId: string; platformAccountId: string };
  contact: ProviderContact;
  classifier: CaseResponseClassifierPort;
  model: string;
  promptVersion: string;
  createdAt: Date;
  confidenceThresholdBp?: number;
}

function assertKnownClassification(value: string): CaseResponseClassification {
  if (!(CASE_RESPONSE_CLASSIFICATIONS as readonly string[]).includes(value)) {
    return 'UNKNOWN';
  }
  return value as CaseResponseClassification;
}

/**
 * 生成 AI 解读（advisory only）。
 * 注意：产物里**没有**金额 / eligibility / 证据实体等字段 —— AI 无法借本模块改写真值。
 */
export async function interpretProviderContact(
  input: InterpretProviderContactInput,
): Promise<CaseResponseInterpretation> {
  const threshold = input.confidenceThresholdBp ?? DEFAULT_INTERPRETATION_CONFIDENCE_THRESHOLD_BP;
  const untrusted = readUntrustedProviderText(input.contact);
  const signal = await input.classifier.classify({
    text: untrusted.text,
    contactId: input.contact.contactId,
    providerCaseId: input.contact.providerCaseId,
  });
  const classification = assertKnownClassification(signal.classification);
  const confidenceBp = Math.max(0, Math.min(10_000, Math.round(signal.confidenceBp)));

  const dispositionReasons: string[] = [];
  if (classification === 'UNKNOWN') dispositionReasons.push('CLASSIFICATION_UNKNOWN');
  if (classification === 'NEED_MORE_INFO') dispositionReasons.push('AMBIGUOUS_REQUEST');
  if (confidenceBp < threshold) dispositionReasons.push('LOW_CONFIDENCE');
  if (untrusted.injectionSuspected) dispositionReasons.push('PROMPT_INJECTION_SUSPECTED');
  if (untrusted.truncated) dispositionReasons.push('PROVIDER_TEXT_TRUNCATED');

  const disposition: 'AUTO' | 'NEEDS_MANUAL_REVIEW' =
    dispositionReasons.some((r) =>
      r === 'CLASSIFICATION_UNKNOWN' || r === 'LOW_CONFIDENCE' || r === 'PROMPT_INJECTION_SUSPECTED' || r === 'AMBIGUOUS_REQUEST',
    )
      ? 'NEEDS_MANUAL_REVIEW'
      : 'AUTO';

  const requiredEvidence = [...CLASSIFICATION_REQUIRED_EVIDENCE[classification]];
  const extractedRequirements = (signal.extractedRequirements ?? []).slice(0, 20).map((r) => String(r).slice(0, 200));

  const base = {
    version: CASE_RESPONSE_INTELLIGENCE_VERSION,
    organizationId: input.scope.organizationId,
    platformAccountId: input.scope.platformAccountId,
    providerCaseId: input.contact.providerCaseId,
    sourceContactId: input.contact.contactId,
    sourceBodyDigest: input.contact.bodyDigest ?? null,
    classification,
    confidenceBp,
    requiredEvidence,
    recommendedNextAction: CLASSIFICATION_RECOMMENDED_ACTION[classification],
    model: input.model,
    promptVersion: input.promptVersion,
    classifierVersion: CASE_RESPONSE_INTELLIGENCE_VERSION,
    createdAt: input.createdAt.toISOString(),
  };

  return {
    kind: 'CASE_RESPONSE_INTERPRETATION',
    advisoryOnly: true,
    canAuthorizeExecution: false,
    ...base,
    extractedRequirements,
    disposition,
    dispositionReasons,
    injectionSuspected: untrusted.injectionSuspected,
    interpretationDigest: digestOf(base),
  };
}

export function isCaseResponseClassification(value: string): value is CaseResponseClassification {
  return (CASE_RESPONSE_CLASSIFICATIONS as readonly string[]).includes(value);
}

/** 边界断言：任何试图用 AI 解读直接执行/改真值的调用都必须 fail-closed。 */
export const CASE_RESPONSE_INTELLIGENCE_BOUNDARY = {
  advisoryOnly: true,
  canAuthorizeExecution: false,
  forbidden: [
    'mutating amounts or canonical truth',
    'creating evidence artifacts',
    'producing provider facts',
    'invoking platform write',
    'approving high-value recovery',
    'granting execution rights',
  ],
  lowConfidenceDisposition: 'NEEDS_MANUAL_REVIEW',
} as const;

export function assertInterpretationIsAdvisory(record: {
  advisoryOnly?: boolean;
  canAuthorizeExecution?: boolean;
}): void {
  if (record.advisoryOnly !== true || record.canAuthorizeExecution !== false) {
    throw new Error('CASE_RESPONSE_INTERPRETATION_MUST_BE_ADVISORY_ONLY');
  }
}
