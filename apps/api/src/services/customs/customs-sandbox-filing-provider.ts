/**
 * C18-3 — SANDBOX FILING PROVIDER（零外写）
 * ---------------------------------------------------------------
 * 实现 C15 `CustomsFilingProvider` 契约的**进程内沙盒实现**：不发任何网络请求、不读任何凭据、
 * 不产生任何外部写。用途：
 *   · 让 C18 的 DTO / 幂等 / 对账 / 状态映射 / negative-path 在有真实 provider 之前就能端到端验证；
 *   · 作为真实 adapter 的行为基准（同一套不变量：tenant-scoped、幂等、歧义不盲重试）。
 *
 * 硬规则：
 *   · 所有查询都带 organizationId；跨租户读取一律 fail-closed（返回 null / NOT_FOUND）；
 *   · 幂等：同一 idempotencyKey + 同一 payload → 同一 providerSubmissionId；同 key 不同 payload → 冲突；
 *   · 状态只能按显式调用推进，绝不隐式升级（SUBMITTED ≠ ACCEPTED、APPROVED ≠ PAID）。
 */

import type {
  CustomsFilingCapabilities,
  CustomsFilingCreateSubmissionInput,
  CustomsFilingOperationResult,
  CustomsFilingProvider,
  CustomsFilingRefundStatusResult,
  CustomsFilingRfiListResult,
  CustomsFilingRfiResponseInput,
  CustomsFilingStatusResult,
  CustomsFilingSubmissionLookup,
  CustomsFilingSubmissionResult,
  CustomsFilingUploadEvidenceInput,
} from './customs-filing-provider';

export const SANDBOX_FILING_PROVIDER_ID = 'sandbox:customs';

const SANDBOX_CAPABILITIES: CustomsFilingCapabilities = {
  DATA_READ: true,
  FILING_CREATE: true,
  DOCUMENT_UPLOAD: true,
  STATUS_READ: true,
  RFI_READ: true,
  RFI_RESPOND: true,
  WEBHOOK: true,
  REFUND_STATUS: true,
};

export type SandboxFilingError =
  | 'IDEMPOTENCY_KEY_CONFLICT'
  | 'SUBMISSION_NOT_FOUND'
  | 'CROSS_TENANT_ACCESS'
  | 'INVALID_REQUEST';

interface SandboxSubmission {
  providerSubmissionId: string;
  organizationId: string;
  idempotencyKey: string;
  payloadDigest: string;
  status: string;
  acceptedAt: string | null;
  refundStatus: string;
  refundedAmount: string | null;
  currency: string | null;
  evidence: Set<string>;
  rfiRequests: Array<{ requestId: string; requestedAt: string; dueAt: string | null; summary: string }>;
  /** 幂等操作账本：idempotencyKey → payloadDigest（与 C17 同语义：同 key 不同 payload = 冲突）。 */
  operationDigests: Map<string, string>;
  observedAt: string;
}

export interface SandboxFilingProviderOptions {
  now?: () => Date;
}

/** 进程内沙盒 provider；实例不共享状态（每个 runtime 一个，测试之间互不污染）。 */
export function createSandboxFilingProvider(options: SandboxFilingProviderOptions = {}): CustomsFilingProvider & {
  /** 仅供测试/对账：显式推进状态（绝不隐式升级）。 */
  advanceStatus(input: { organizationId: string; providerSubmissionId: string; status: string }): CustomsFilingStatusResult;
  setRefundStatus(input: {
    organizationId: string;
    providerSubmissionId: string;
    refundStatus: string;
    refundedAmount?: string | null;
    currency?: string | null;
  }): CustomsFilingRefundStatusResult;
  seedRequestForInformation(input: {
    organizationId: string;
    providerSubmissionId: string;
    requestId: string;
    summary: string;
    dueAt?: string | null;
  }): CustomsFilingRfiListResult;
  listSubmissions(organizationId: string): ReadonlyArray<{ providerSubmissionId: string; status: string }>;
} {
  const now = options.now ?? (() => new Date());
  const submissions = new Map<string, SandboxSubmission>();
  let sequence = 0;

  const digest = (value: unknown): string => {
    const canonical = JSON.stringify(value, Object.keys(value as Record<string, unknown>).sort());
    let hash = 0;
    for (let i = 0; i < canonical.length; i += 1) {
      hash = (hash * 31 + canonical.charCodeAt(i)) % 2147483647;
    }
    return hash.toString(16).padStart(16, '0');
  };

  const findByKey = (organizationId: string, idempotencyKey: string): SandboxSubmission | undefined =>
    [...submissions.values()].find(
      (row) => row.organizationId === organizationId && row.idempotencyKey === idempotencyKey,
    );

  const requireOwned = (input: CustomsFilingSubmissionLookup): SandboxSubmission => {
    const row = submissions.get(input.providerSubmissionId);
    if (!row) throw new Error('SUBMISSION_NOT_FOUND');
    if (row.organizationId !== input.organizationId) throw new Error('CROSS_TENANT_ACCESS');
    return row;
  };

  return {
    providerId: SANDBOX_FILING_PROVIDER_ID,
    displayName: 'Sandbox Customs Filing Provider（零外写）',
    capabilities: SANDBOX_CAPABILITIES,

    async createSubmission(input: CustomsFilingCreateSubmissionInput): Promise<CustomsFilingSubmissionResult> {
      const payloadDigest = digest({
        organizationId: input.organizationId,
        opportunityId: input.opportunityId,
        claimItemId: input.claimItemId,
        packageId: input.packageId,
        packageDigest: input.packageDigest,
        jurisdiction: input.jurisdiction,
        remedyType: input.remedyType,
      });
      const existing = findByKey(input.organizationId, input.idempotencyKey);
      if (existing) {
        if (existing.payloadDigest !== payloadDigest) throw new Error('IDEMPOTENCY_KEY_CONFLICT');
        return {
          providerSubmissionId: existing.providerSubmissionId,
          submissionStatus: existing.status,
          acceptedAt: existing.acceptedAt,
          rawStatusText: existing.status,
        };
      }
      sequence += 1;
      const providerSubmissionId = 'sandbox-sub-' + String(sequence).padStart(4, '0');
      const at = now().toISOString();
      const row: SandboxSubmission = {
        providerSubmissionId,
        organizationId: input.organizationId,
        idempotencyKey: input.idempotencyKey,
        payloadDigest,
        status: 'SUBMITTED',
        acceptedAt: null,
        refundStatus: 'NOT_REFUNDED',
        refundedAmount: null,
        currency: null,
        evidence: new Set(),
        rfiRequests: [],
        operationDigests: new Map(),
        observedAt: at,
      };
      submissions.set(providerSubmissionId, row);
      return { providerSubmissionId, submissionStatus: row.status, acceptedAt: null, rawStatusText: row.status };
    },

    async uploadEvidence(input: CustomsFilingUploadEvidenceInput): Promise<CustomsFilingOperationResult> {
      const row = requireOwned({ organizationId: input.organizationId, providerSubmissionId: input.providerSubmissionId });
      const payloadDigest = digest({
        operation: 'UPLOAD_EVIDENCE',
        evidenceReference: input.evidenceReference,
        documentKind: input.documentKind,
        sha256: input.sha256,
      });
      const existing = row.operationDigests.get(input.idempotencyKey);
      if (existing !== undefined) {
        if (existing !== payloadDigest) throw new Error('IDEMPOTENCY_KEY_CONFLICT');
        return { ok: true, providerReference: input.evidenceReference };
      }
      row.operationDigests.set(input.idempotencyKey, payloadDigest);
      const evidenceKey = input.evidenceReference + ':' + input.sha256;
      if (row.evidence.has(evidenceKey)) {
        return { ok: true, providerReference: input.evidenceReference };
      }
      row.evidence.add(evidenceKey);
      row.observedAt = now().toISOString();
      return { ok: true, providerReference: input.evidenceReference };
    },

    async getSubmission(input: CustomsFilingSubmissionLookup): Promise<CustomsFilingSubmissionResult> {
      const row = requireOwned(input);
      return {
        providerSubmissionId: row.providerSubmissionId,
        submissionStatus: row.status,
        acceptedAt: row.acceptedAt,
        rawStatusText: row.status,
      };
    },

    async getSubmissionStatus(input: CustomsFilingSubmissionLookup): Promise<CustomsFilingStatusResult> {
      const row = requireOwned(input);
      return {
        providerSubmissionId: row.providerSubmissionId,
        status: row.status,
        observedAt: row.observedAt,
        rawStatusText: row.status,
      };
    },

    async listRequestsForInformation(input: CustomsFilingSubmissionLookup): Promise<CustomsFilingRfiListResult> {
      const row = requireOwned(input);
      return { providerSubmissionId: row.providerSubmissionId, requests: row.rfiRequests.map((request) => ({ ...request })) };
    },

    async respondToRequest(input: CustomsFilingRfiResponseInput): Promise<CustomsFilingOperationResult> {
      const row = requireOwned(input);
      const payloadDigest = digest({
        operation: 'RESPOND_RFI',
        requestId: input.requestId,
        responseReference: input.responseReference,
      });
      const existing = row.operationDigests.get(input.idempotencyKey);
      if (existing !== undefined) {
        if (existing !== payloadDigest) throw new Error('IDEMPOTENCY_KEY_CONFLICT');
        return { ok: true, providerReference: input.responseReference };
      }
      row.operationDigests.set(input.idempotencyKey, payloadDigest);
      row.observedAt = now().toISOString();
      return { ok: true, providerReference: input.responseReference };
    },

    async getRefundStatus(input: CustomsFilingSubmissionLookup): Promise<CustomsFilingRefundStatusResult> {
      const row = requireOwned(input);
      return {
        providerSubmissionId: row.providerSubmissionId,
        refundStatus: row.refundStatus,
        refundedAmount: row.refundedAmount,
        currency: row.currency,
        observedAt: row.observedAt,
      };
    },

    advanceStatus(input) {
      const row = requireOwned({ organizationId: input.organizationId, providerSubmissionId: input.providerSubmissionId });
      row.status = input.status;
      if (input.status === 'ACCEPTED' && row.acceptedAt === null) row.acceptedAt = now().toISOString();
      row.observedAt = now().toISOString();
      return {
        providerSubmissionId: row.providerSubmissionId,
        status: row.status,
        observedAt: row.observedAt,
        rawStatusText: row.status,
      };
    },

    setRefundStatus(input) {
      const row = requireOwned({ organizationId: input.organizationId, providerSubmissionId: input.providerSubmissionId });
      row.refundStatus = input.refundStatus;
      row.refundedAmount = input.refundedAmount ?? null;
      row.currency = input.currency ?? null;
      row.observedAt = now().toISOString();
      return {
        providerSubmissionId: row.providerSubmissionId,
        refundStatus: row.refundStatus,
        refundedAmount: row.refundedAmount,
        currency: row.currency,
        observedAt: row.observedAt,
      };
    },

    seedRequestForInformation(input) {
      const row = requireOwned({ organizationId: input.organizationId, providerSubmissionId: input.providerSubmissionId });
      row.rfiRequests.push({
        requestId: input.requestId,
        requestedAt: now().toISOString(),
        dueAt: input.dueAt ?? null,
        summary: input.summary,
      });
      return { providerSubmissionId: row.providerSubmissionId, requests: row.rfiRequests.map((request) => ({ ...request })) };
    },

    listSubmissions(organizationId) {
      return [...submissions.values()]
        .filter((row) => row.organizationId === organizationId)
        .map((row) => ({ providerSubmissionId: row.providerSubmissionId, status: row.status }));
    },
  };
}
