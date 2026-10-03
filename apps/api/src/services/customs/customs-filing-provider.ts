/**
 * C15 — CUSTOMS FILING PROVIDER CONTRACT（HOST DIRECTIVE 2026-10-03 补充四 §3）
 * ---------------------------------------------------------------
 * provider-neutral：不绑定任何报关行 / ABI / Filing Provider 实现。
 * 能力必须 **operation-level fail-closed**：未声明的能力一律视为不可用。
 * 任何 provider 缺少 Filing capability → 只能回到 CLAIM_READY / BROKER_HANDOFF，
 * **不得**伪造自动提交能力（本文件不发起任何外部写）。
 * 真实 provider 接入（C18）与真实 authority submission 继续 HOLD_EXTERNAL / HOST APPROVAL REQUIRED。
 */

export const CUSTOMS_FILING_OPERATIONS = [
  'DATA_READ',
  'FILING_CREATE',
  'DOCUMENT_UPLOAD',
  'STATUS_READ',
  'RFI_READ',
  'RFI_RESPOND',
  'WEBHOOK',
  'REFUND_STATUS',
] as const;
export type CustomsFilingOperation = (typeof CUSTOMS_FILING_OPERATIONS)[number];

/** 自动 filing 路径至少需要的能力集合（缺一即不可自动）。 */
export const CUSTOMS_AUTO_FILING_REQUIRED_OPERATIONS: readonly CustomsFilingOperation[] = [
  'FILING_CREATE',
  'DOCUMENT_UPLOAD',
  'STATUS_READ',
];

export type CustomsExecutionRoute = 'AUTO_FILING' | 'CLAIM_READY' | 'BROKER_HANDOFF';

export type CustomsRouteReasonCode =
  | 'PROVIDER_READY'
  | 'PROVIDER_NOT_CONNECTED'
  | 'FILING_CAPABILITY_MISSING'
  | 'PROVIDER_REJECTED';

/** provider 声明的能力矩阵；未出现的 operation 一律 false（fail-closed）。 */
export type CustomsFilingCapabilities = Partial<Record<CustomsFilingOperation, boolean>>;

/**
 * provider-neutral 契约。实现方（未来 C18 的单一真实 provider）必须自己保证：
 * request/response 双绑、idempotency、ambiguous response 不盲重试（由 C17 ledger 承担）。
 * 本文件只声明形状，不提供任何真实调用。
 */
export interface CustomsFilingProvider {
  readonly providerId: string;
  readonly displayName: string;
  readonly capabilities: CustomsFilingCapabilities;
  createSubmission(input: CustomsFilingCreateSubmissionInput): Promise<CustomsFilingSubmissionResult>;
  uploadEvidence(input: CustomsFilingUploadEvidenceInput): Promise<CustomsFilingOperationResult>;
  getSubmission(input: CustomsFilingSubmissionLookup): Promise<CustomsFilingSubmissionResult>;
  getSubmissionStatus(input: CustomsFilingSubmissionLookup): Promise<CustomsFilingStatusResult>;
  listRequestsForInformation(input: CustomsFilingSubmissionLookup): Promise<CustomsFilingRfiListResult>;
  respondToRequest(input: CustomsFilingRfiResponseInput): Promise<CustomsFilingOperationResult>;
  getRefundStatus(input: CustomsFilingSubmissionLookup): Promise<CustomsFilingRefundStatusResult>;
}

export interface CustomsFilingCreateSubmissionInput {
  organizationId: string;
  opportunityId: string;
  claimItemId: string;
  packageId: string;
  packageDigest: string;
  jurisdiction: string;
  remedyType: string;
  idempotencyKey: string;
}

export interface CustomsFilingUploadEvidenceInput {
  organizationId: string;
  providerSubmissionId: string;
  evidenceReference: string;
  documentKind: string;
  sha256: string;
  idempotencyKey: string;
}

export interface CustomsFilingSubmissionLookup {
  organizationId: string;
  providerSubmissionId: string;
}

export interface CustomsFilingRfiResponseInput {
  organizationId: string;
  providerSubmissionId: string;
  requestId: string;
  responseReference: string;
  idempotencyKey: string;
}

export interface CustomsFilingSubmissionResult {
  providerSubmissionId: string;
  submissionStatus: string;
  acceptedAt: string | null;
  rawStatusText: string | null;
}

export interface CustomsFilingStatusResult {
  providerSubmissionId: string;
  status: string;
  observedAt: string;
  rawStatusText: string | null;
}

export interface CustomsFilingRfiListResult {
  providerSubmissionId: string;
  requests: ReadonlyArray<{ requestId: string; requestedAt: string; dueAt: string | null; summary: string }>;
}

export interface CustomsFilingRefundStatusResult {
  providerSubmissionId: string;
  refundStatus: string;
  refundedAmount: string | null;
  currency: string | null;
  observedAt: string;
}

export interface CustomsFilingOperationResult {
  ok: boolean;
  providerReference: string | null;
}

/** fail-closed 能力判定：未声明 / 显式 false 一律视为缺失。 */
export function missingFilingCapabilities(
  capabilities: CustomsFilingCapabilities,
  required: readonly CustomsFilingOperation[] = CUSTOMS_AUTO_FILING_REQUIRED_OPERATIONS,
): CustomsFilingOperation[] {
  return required.filter((operation) => capabilities[operation] !== true);
}

export function providerSupportsOperation(
  capabilities: CustomsFilingCapabilities,
  operation: CustomsFilingOperation,
): boolean {
  return capabilities[operation] === true;
}

export interface CustomsExecutionRouteDecision {
  route: CustomsExecutionRoute;
  reasonCode: CustomsRouteReasonCode;
  providerId: string | null;
  missingCapabilities: readonly CustomsFilingOperation[];
  /** 本决策永不代表已发生外部写。 */
  externalWritePerformed: false;
  filingSubmitted: false;
  transportEnabled: false;
  productionCredentials: 'ABSENT';
}

/**
 * 路由决策（不执行任何调用）：
 *   · 无 provider → BROKER_HANDOFF（PROVIDER_NOT_CONNECTED）
 *   · provider 缺自动 filing 必需能力 → CLAIM_READY（FILING_CAPABILITY_MISSING）
 *   · 全部满足 → AUTO_FILING（PROVIDER_READY）—— 仍需 C16 授权就绪 + C21 server 校验后才可提交
 */
export function resolveCustomsExecutionRoute(
  provider: Pick<CustomsFilingProvider, 'providerId' | 'capabilities'> | null,
  required: readonly CustomsFilingOperation[] = CUSTOMS_AUTO_FILING_REQUIRED_OPERATIONS,
): CustomsExecutionRouteDecision {
  if (provider === null) {
    return {
      route: 'BROKER_HANDOFF',
      reasonCode: 'PROVIDER_NOT_CONNECTED',
      providerId: null,
      missingCapabilities: required,
      externalWritePerformed: false,
      filingSubmitted: false,
      transportEnabled: false,
      productionCredentials: 'ABSENT',
    };
  }

  const missing = missingFilingCapabilities(provider.capabilities, required);
  if (missing.length > 0) {
    return {
      route: 'CLAIM_READY',
      reasonCode: 'FILING_CAPABILITY_MISSING',
      providerId: provider.providerId,
      missingCapabilities: missing,
      externalWritePerformed: false,
      filingSubmitted: false,
      transportEnabled: false,
      productionCredentials: 'ABSENT',
    };
  }

  return {
    route: 'AUTO_FILING',
    reasonCode: 'PROVIDER_READY',
    providerId: provider.providerId,
    missingCapabilities: [],
    externalWritePerformed: false,
    filingSubmitted: false,
    transportEnabled: false,
    productionCredentials: 'ABSENT',
  };
}

/**
 * C18 门槛所需的能力证据（本文件只做形状校验；真实取证属 HOST APPROVAL REQUIRED）。
 * 缺失任一关键证据 → 不得进入 AUTO_FILING。
 */
export const CUSTOMS_PROVIDER_EVIDENCE_FIELDS = [
  'REAL_FILING_OPERATION',
  'IDEMPOTENCY_SEMANTICS',
  'SUBMISSION_IDENTIFIER',
  'STATUS_QUERY',
  'WEBHOOK',
  'DOCUMENT_UPLOAD',
  'AMBIGUOUS_RESPONSE_BEHAVIOR',
  'RETRY_SEMANTICS',
  'CREDENTIAL_LIFECYCLE',
  'SANDBOX_ENVIRONMENT',
  'AUTHORIZATION_POA_REQUIREMENT',
] as const;
export type CustomsProviderEvidenceField = (typeof CUSTOMS_PROVIDER_EVIDENCE_FIELDS)[number];

export type CustomsProviderEvidence = Partial<Record<CustomsProviderEvidenceField, boolean>>;

export interface CustomsProviderEvidenceAssessment {
  eligibleForAutoFiling: boolean;
  missingEvidence: readonly CustomsProviderEvidenceField[];
  disposition: 'AUTO_FILING_ELIGIBLE' | 'NEEDS_MANUAL' | 'BROKER_HANDOFF';
}

export function assessCustomsProviderEvidence(evidence: CustomsProviderEvidence): CustomsProviderEvidenceAssessment {
  const missing = CUSTOMS_PROVIDER_EVIDENCE_FIELDS.filter((field) => evidence[field] !== true);
  if (missing.length === 0) {
    return { eligibleForAutoFiling: true, missingEvidence: [], disposition: 'AUTO_FILING_ELIGIBLE' };
  }
  // 缺关键能力：有 provider 但证据不足 → NEEDS_MANUAL；完全没有 provider 由路由层给 BROKER_HANDOFF。
  return { eligibleForAutoFiling: false, missingEvidence: missing, disposition: 'NEEDS_MANUAL' };
}

/** 边界自证：C15 契约层不产生任何外部写 / 资金动作。 */
export const CUSTOMS_FILING_CONTRACT_BOUNDARY = {
  externalWritePerformed: false,
  filingSubmitted: false,
  authoritySubmissionPerformed: false,
  refundCollected: false,
  successFeeCalculated: false,
  transportEnabled: false,
  platformWriteEnabled: false,
  productionCredentials: 'ABSENT',
} as const;
