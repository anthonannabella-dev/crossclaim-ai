/**
 * G11（MASTER GAP CLOSURE）— Customs 恢复链服务层：从**已持久化的只读事实**重算 C1→C6 并 append 计算投影。
 * ---------------------------------------------------------------
 *  · 事实来源 = customs-entry-fact-store（append-only）；本服务不写事实，只 append 计算投影。
 *  · 重算完全确定性：C2 真值 / C3 差异（外部 expectations 快照引用）/ C4 资格（政策）/ C5 估算（政策）。
 *  · 输出 = claim-ready package（C6，estimateOnly、不可计费、不提交）+ 本次 append 的投影元数据。
 *  · 边界：不发起任何外部调用；filingSubmitted=false / TRANSPORT=false / HOLD_EXTERNAL。
 */

import { createHash } from 'node:crypto';

import { type CustomsEntryFact } from './customs-entry-contract';
import { computeCustomsDutyTruth } from './customs-duty-truth';
import { compareCustomsClassification, type CustomsRateExpectation } from './customs-classification-discrepancy';
import { evaluateCustomsEligibility, type CustomsEligibilityPolicy } from './customs-recovery-eligibility';
import { estimateCustomsRecovery, type CustomsEstimatePolicy } from './customs-recovery-estimate';
import type { CustomsEntryFactStore, CustomsProjectionKind } from './customs-entry-fact-store';
import {
  assembleCustomsClaimReadyPackage,
  type CustomsClaimReadyPackage,
  type CustomsEvidenceReference,
} from './customs-claim-ready-package';

export const CUSTOMS_CHAIN_SERVICE_ERROR_CODES = [
  'FACT_NOT_FOUND',
  'INVALID_INPUT',
  'FACT_TAMPERED_AFTER_LOAD',
] as const;
export type CustomsChainServiceErrorCode = (typeof CUSTOMS_CHAIN_SERVICE_ERROR_CODES)[number];

export class CustomsChainServiceError extends Error {
  readonly code: CustomsChainServiceErrorCode;

  constructor(code: CustomsChainServiceErrorCode, detail: string) {
    super(code + ': ' + detail);
    this.name = 'CustomsChainServiceError';
    this.code = code;
  }
}

export interface CustomsChainPolicies {
  eligibility: CustomsEligibilityPolicy;
  estimate: CustomsEstimatePolicy;
}

export interface CustomsChainRunResult {
  package: CustomsClaimReadyPackage;
  projections: readonly { kind: CustomsProjectionKind; projectionId: string; status: 'APPENDED' | 'ALREADY_APPENDED' }[];
  algorithmVersion: string;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return '{' + Object.keys(record).sort().map((key) => JSON.stringify(key) + ':' + canonical(record[key])).join(',') + '}';
  }
  return JSON.stringify(value ?? null);
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

/** 把持久化行还原为 C1 只读事实（readOnly/filing/payment 标记为只读态）。 */
export function toReadOnlyEntryFact(loaded: {
  entryNumber: string;
  entryDate: string;
  jurisdiction: string;
  portOfEntry: string;
  importerOfRecordRef: string;
  source: string;
  rawReference: string;
  observedAt: string;
  totalDutyAmountByCurrency: Record<string, string>;
  lines: readonly { lineOrdinal: number; kind: string; rawCode: string; amount: string; currency: string }[];
}): CustomsEntryFact {
  return {
    entryNumber: loaded.entryNumber,
    entryDate: loaded.entryDate,
    jurisdiction: loaded.jurisdiction,
    portOfEntry: loaded.portOfEntry,
    importerOfRecordRef: loaded.importerOfRecordRef,
    source: loaded.source as CustomsEntryFact['source'],
    rawReference: loaded.rawReference,
    dutyLines: loaded.lines
      .slice()
      .sort((left, right) => left.lineOrdinal - right.lineOrdinal)
      .map((line) => ({
        kind: line.kind as CustomsEntryFact['dutyLines'][number]['kind'],
        rawCode: line.rawCode,
        amount: line.amount,
        currency: line.currency,
      })),
    totalDutyAmountByCurrency: loaded.totalDutyAmountByCurrency,
    observedAt: loaded.observedAt,
    readOnly: true,
    filingPerformed: false,
    paymentPerformed: false,
    productionCredentials: 'ABSENT',
  };
}

/**
 * 运行 C1→C6 恢复链（只读事实 → 计算投影 append → claim-ready package）。
 */
export async function runCustomsRecoveryChain(input: {
  store: CustomsEntryFactStore;
  organizationId: string;
  factId: string;
  expectations: readonly CustomsRateExpectation[];
  policies: CustomsChainPolicies;
  evidenceReferences: readonly CustomsEvidenceReference[];
  algorithmVersion: string;
  computedAt: Date;
}): Promise<CustomsChainRunResult> {
  if (!input.algorithmVersion || input.algorithmVersion.trim() === '') {
    throw new CustomsChainServiceError('INVALID_INPUT', 'algorithmVersion 必填');
  }
  const loaded = await input.store.loadFact({ organizationId: input.organizationId, factId: input.factId });
  if (!loaded) throw new CustomsChainServiceError('FACT_NOT_FOUND', '事实不存在或不属于该租户');

  const fact = toReadOnlyEntryFact(loaded);
  const truth = computeCustomsDutyTruth(fact);
  const discrepancy = compareCustomsClassification({ fact, expectations: input.expectations });
  const assessment = evaluateCustomsEligibility({ fact, truth, discrepancy, policy: input.policies.eligibility });
  const estimate = estimateCustomsRecovery({ fact, assessment, policy: input.policies.estimate });

  const pkg = assembleCustomsClaimReadyPackage({
    fact,
    truth,
    discrepancy,
    assessment,
    estimate,
    provenance: {
      policyId: input.policies.eligibility.policyId,
      policyVersion: input.policies.eligibility.policyVersion,
      algorithmVersion: input.algorithmVersion,
    },
    evidenceReferences: input.evidenceReferences,
    computedAt: input.computedAt.toISOString(),
  });

  const base = {
    organizationId: input.organizationId,
    inputFactId: input.factId,
    inputDigest: loaded.contentDigest,
    algorithmVersion: input.algorithmVersion,
    computedAt: input.computedAt,
  };
  const writes: { kind: CustomsProjectionKind; payload: unknown; policy: boolean }[] = [
    { kind: 'DUTY_TRUTH', payload: truth, policy: false },
    { kind: 'DISCREPANCY', payload: discrepancy, policy: false },
    { kind: 'ELIGIBILITY', payload: assessment, policy: true },
    { kind: 'ESTIMATE', payload: estimate, policy: true },
  ];

  const projections: { kind: CustomsProjectionKind; projectionId: string; status: 'APPENDED' | 'ALREADY_APPENDED' }[] = [];
  for (const write of writes) {
    const result = await input.store.appendProjection({
      ...base,
      kind: write.kind,
      resultDigest: digest(write.payload),
      payload: write.payload,
      policyId: write.policy ? input.policies.eligibility.policyId : null,
      policyVersion: write.policy ? input.policies.eligibility.policyVersion : null,
    });
    projections.push({ kind: write.kind, projectionId: result.projectionId, status: result.status });
  }

  return { package: pkg, projections, algorithmVersion: input.algorithmVersion };
}
