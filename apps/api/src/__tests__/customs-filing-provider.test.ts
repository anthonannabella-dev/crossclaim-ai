/**
 * C15 — CUSTOMS FILING PROVIDER CONTRACT 契约层验收（HOST DIRECTIVE 2026-10-03 补充四 §3）。
 * 断言：operation-level fail-closed；缺 Filing capability → CLAIM_READY / BROKER_HANDOFF；
 *       路由决策永不代表已提交；provider 证据门槛缺项 → NEEDS_MANUAL；契约层零外部写。
 */

import { describe, expect, it } from 'vitest';

import {
  CUSTOMS_AUTO_FILING_REQUIRED_OPERATIONS,
  CUSTOMS_FILING_CONTRACT_BOUNDARY,
  CUSTOMS_FILING_OPERATIONS,
  CUSTOMS_PROVIDER_EVIDENCE_FIELDS,
  assessCustomsProviderEvidence,
  missingFilingCapabilities,
  providerSupportsOperation,
  resolveCustomsExecutionRoute,
  type CustomsFilingCapabilities,
} from '../services/customs/customs-filing-provider';

const FULL: CustomsFilingCapabilities = {
  DATA_READ: true,
  FILING_CREATE: true,
  DOCUMENT_UPLOAD: true,
  STATUS_READ: true,
  RFI_READ: true,
  RFI_RESPOND: true,
  WEBHOOK: true,
  REFUND_STATUS: true,
};

describe('C15 — customs filing provider contract', () => {
  it('operation 集合固定为 8 项（不得静默扩充）', () => {
    expect([...CUSTOMS_FILING_OPERATIONS].sort()).toEqual(
      ['DATA_READ', 'DOCUMENT_UPLOAD', 'FILING_CREATE', 'REFUND_STATUS', 'RFI_READ', 'RFI_RESPOND', 'STATUS_READ', 'WEBHOOK'],
    );
  });

  it('未声明 / 显式 false 的能力一律视为缺失（fail-closed）', () => {
    expect(providerSupportsOperation({}, 'FILING_CREATE')).toBe(false);
    expect(providerSupportsOperation({ FILING_CREATE: false }, 'FILING_CREATE')).toBe(false);
    expect(providerSupportsOperation({ FILING_CREATE: true }, 'FILING_CREATE')).toBe(true);
    expect(missingFilingCapabilities({ FILING_CREATE: true })).toEqual(['DOCUMENT_UPLOAD', 'STATUS_READ']);
  });

  it('无 provider → BROKER_HANDOFF（PROVIDER_NOT_CONNECTED）且未提交、未外写', () => {
    const decision = resolveCustomsExecutionRoute(null);
    expect(decision.route).toBe('BROKER_HANDOFF');
    expect(decision.reasonCode).toBe('PROVIDER_NOT_CONNECTED');
    expect(decision.providerId).toBeNull();
    expect(decision.filingSubmitted).toBe(false);
    expect(decision.externalWritePerformed).toBe(false);
  });

  it('provider 缺 FILING_CREATE → CLAIM_READY（绝不 AUTO_FILING）', () => {
    const decision = resolveCustomsExecutionRoute({ providerId: 'broker-a', capabilities: { ...FULL, FILING_CREATE: false } });
    expect(decision.route).toBe('CLAIM_READY');
    expect(decision.reasonCode).toBe('FILING_CAPABILITY_MISSING');
    expect(decision.missingCapabilities).toEqual(['FILING_CREATE']);
    expect(decision.filingSubmitted).toBe(false);
  });

  it('provider 缺 DOCUMENT_UPLOAD 或 STATUS_READ → 同样 fail-closed 到 CLAIM_READY', () => {
    const noUpload = resolveCustomsExecutionRoute({ providerId: 'broker-b', capabilities: { ...FULL, DOCUMENT_UPLOAD: false } });
    expect(noUpload.route).toBe('CLAIM_READY');
    const noStatus = resolveCustomsExecutionRoute({ providerId: 'broker-c', capabilities: { ...FULL, STATUS_READ: false } });
    expect(noStatus.route).toBe('CLAIM_READY');
  });

  it('能力齐备 → AUTO_FILING，但决策仍不表示已提交（orchestration 属 C21）', () => {
    const decision = resolveCustomsExecutionRoute({ providerId: 'broker-full', capabilities: FULL });
    expect(decision.route).toBe('AUTO_FILING');
    expect(decision.reasonCode).toBe('PROVIDER_READY');
    expect(decision.missingCapabilities).toEqual([]);
    expect(decision.filingSubmitted).toBe(false);
    expect(decision.externalWritePerformed).toBe(false);
    expect(decision.transportEnabled).toBe(false);
    expect(decision.productionCredentials).toBe('ABSENT');
  });

  it('只读 provider（无任何 filing 能力）→ CLAIM_READY，缺项完整列出', () => {
    const decision = resolveCustomsExecutionRoute({ providerId: 'read-only', capabilities: { DATA_READ: true, STATUS_READ: true } });
    expect(decision.route).toBe('CLAIM_READY');
    expect([...decision.missingCapabilities].sort()).toEqual(['DOCUMENT_UPLOAD', 'FILING_CREATE']);
  });

  it('自定义 required 集合生效（例如仅做状态回读场景）', () => {
    const decision = resolveCustomsExecutionRoute({ providerId: 'reader', capabilities: { STATUS_READ: true } }, ['STATUS_READ']);
    expect(decision.route).toBe('AUTO_FILING');
    const missing = resolveCustomsExecutionRoute({ providerId: 'reader', capabilities: { STATUS_READ: true } }, ['STATUS_READ', 'WEBHOOK']);
    expect(missing.route).toBe('CLAIM_READY');
    expect(missing.missingCapabilities).toEqual(['WEBHOOK']);
  });

  it('路由决策确定：同输入 → 同决策', () => {
    const a = resolveCustomsExecutionRoute({ providerId: 'x', capabilities: FULL });
    const b = resolveCustomsExecutionRoute({ providerId: 'x', capabilities: { ...FULL } });
    expect(b).toEqual(a);
  });

  it('C18 证据门槛：缺任一关键证据 → NEEDS_MANUAL（不得进入 AUTO_FILING）', () => {
    const partial = assessCustomsProviderEvidence({ REAL_FILING_OPERATION: true, IDEMPOTENCY_SEMANTICS: true });
    expect(partial.eligibleForAutoFiling).toBe(false);
    expect(partial.disposition).toBe('NEEDS_MANUAL');
    expect(partial.missingEvidence.length).toBe(CUSTOMS_PROVIDER_EVIDENCE_FIELDS.length - 2);
  });

  it('C18 证据门槛：全部具备 → AUTO_FILING_ELIGIBLE', () => {
    const full = assessCustomsProviderEvidence(
      Object.fromEntries(CUSTOMS_PROVIDER_EVIDENCE_FIELDS.map((f) => [f, true])) as never,
    );
    expect(full.eligibleForAutoFiling).toBe(true);
    expect(full.disposition).toBe('AUTO_FILING_ELIGIBLE');
    expect(full.missingEvidence).toEqual([]);
  });

  it('契约层零外部写 / 零资金：边界常量自证', () => {
    expect(CUSTOMS_FILING_CONTRACT_BOUNDARY.externalWritePerformed).toBe(false);
    expect(CUSTOMS_FILING_CONTRACT_BOUNDARY.filingSubmitted).toBe(false);
    expect(CUSTOMS_FILING_CONTRACT_BOUNDARY.authoritySubmissionPerformed).toBe(false);
    expect(CUSTOMS_FILING_CONTRACT_BOUNDARY.refundCollected).toBe(false);
    expect(CUSTOMS_FILING_CONTRACT_BOUNDARY.successFeeCalculated).toBe(false);
    expect(CUSTOMS_FILING_CONTRACT_BOUNDARY.transportEnabled).toBe(false);
    expect(CUSTOMS_FILING_CONTRACT_BOUNDARY.platformWriteEnabled).toBe(false);
    expect(CUSTOMS_FILING_CONTRACT_BOUNDARY.productionCredentials).toBe('ABSENT');
  });

  it('自动 filing 必需能力集合固定为 FILING_CREATE / DOCUMENT_UPLOAD / STATUS_READ', () => {
    expect([...CUSTOMS_AUTO_FILING_REQUIRED_OPERATIONS]).toEqual(['FILING_CREATE', 'DOCUMENT_UPLOAD', 'STATUS_READ']);
  });
});
