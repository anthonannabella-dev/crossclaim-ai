/**
 * P0-1 收尾（BUSINESS SURVIVAL GATE · 生死线 A）— Return/Export/Destruction → 匹配 → 证据包 → qualification → claim-ready。
 * ---------------------------------------------------------------
 *  · 只使用**已持久化**的 Return 事实（append-only）与报关事实；匹配由确定性 matcher 完成。
 *  · fail-closed：AMBIGUOUS / NO_MATCH / RECONCILIATION_REQUIRED（digest 不一致）一律**零计入** confirmed amount，
 *    且整体状态不得为 READY；HTTP 只读已持久化结果，禁止前端重算。
 *  · qualification 未 QUALIFIED → 不产出 READY（后端强制 Gate）。
 *  · 不触发任何 filing / 外呼 / broker 提交。
 */

import { createHash } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import type { CustomsEntryFactStore } from './customs-entry-fact-store';
import type { CustomsReturnFactStore } from './customs-return-fact-store';
import {
  CUSTOMS_RETURN_MATCHING_BOUNDARY,
  decimal6,
  matchCustomsLinesToReturns,
  type CustomsEntryLineEvidence,
  type CustomsMatchPolicy,
  type CustomsReturnFact,
} from './customs-return-matching';
import type { CustomerQualificationDecision } from '../commercial/customer-qualification-gate';

export const CUSTOMS_RETURN_EVIDENCE_STATUSES = ['READY', 'NOT_READY', 'RECONCILIATION_REQUIRED'] as const;
export type CustomsReturnEvidenceStatus = (typeof CUSTOMS_RETURN_EVIDENCE_STATUSES)[number];

export interface CustomsEntryLineWithDuty extends CustomsEntryLineEvidence {
  dutyAmount: string;
}

export interface CustomsReturnClaimEvidenceResult {
  evidenceId: string;
  status: CustomsReturnEvidenceStatus;
  status_reasons: readonly string[];
  confirmedRecoverableAmountByCurrency: Readonly<Record<string, string>>;
  eligibleQuantityByLine: readonly { lineOrdinal: number; status: string; eligibleQuantity: string; confirmedDutyAmount: string }[];
  qualificationStatus: CustomerQualificationDecision['qualificationStatus'];
  policyId: string;
  policyVersion: string;
  algorithmVersion: string;
  inputDigest: string;
  resultDigest: string;
  computedAt: string;
  readonly filingPerformed: false;
  readonly transportEnabled: false;
  readonly productionCredentials: 'ABSENT';
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return '{' + Object.keys(record).sort().map((key) => JSON.stringify(key) + ':' + canonical(record[key])).join(',') + '}';
  }
  return JSON.stringify(value ?? null);
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function addScaled(left: string, right: string): string {
  const toScaled = (value: string): bigint => {
    const normalised = decimal6(value);
    const negative = normalised.startsWith('-');
    const digits = (negative ? normalised.slice(1) : normalised).replace('.', '');
    return negative ? -BigInt(digits) : BigInt(digits);
  };
  const total = toScaled(left) + toScaled(right);
  const negative = total < 0n;
  const digits = (negative ? -total : total).toString().padStart(7, '0');
  return (negative ? '-' : '') + digits.slice(0, digits.length - 6) + '.' + digits.slice(digits.length - 6);
}

function mulDiv(amount: string, numerator: string, denominator: string): string {
  const toScaled = (value: string): bigint => {
    const normalised = decimal6(value);
    const negative = normalised.startsWith('-');
    const digits = (negative ? normalised.slice(1) : normalised).replace('.', '');
    return negative ? -BigInt(digits) : BigInt(digits);
  };
  const den = toScaled(denominator);
  if (den <= 0n) return '0.000000';
  const value = (toScaled(amount) * toScaled(numerator)) / den;
  return (value < 0n ? '-' : '') + formatScaled(value);
}

function formatScaled(scaled: bigint): string {
  const negative = scaled < 0n;
  const digits = (negative ? -scaled : scaled).toString().padStart(7, '0');
  return (negative ? '-' : '') + digits.slice(0, digits.length - 6) + '.' + digits.slice(digits.length - 6);
}

/** Return 事实的 contentDigest 重算校验（tampered digest → fail-closed，不计入）。 */
export function verifyReturnFactDigests(facts: readonly CustomsReturnFact[]): { ok: readonly CustomsReturnFact[]; tampered: readonly string[] } {
  const ok: CustomsReturnFact[] = [];
  const tampered: string[] = [];
  for (const fact of facts) {
    const recomputed = sha256({
      organizationId: fact.organizationId,
      platformAccountId: fact.platformAccountId,
      entryNumber: fact.entryNumber,
      htsCode: fact.htsCode,
      sku: fact.sku,
      kind: fact.kind,
      quantity: fact.quantity,
      currency: fact.currency,
      jurisdiction: fact.jurisdiction,
      importerOfRecordRef: fact.importerOfRecordRef,
      source: fact.source,
      rawReference: fact.rawReference,
      observedAt: fact.observedAt,
    });
    if (recomputed === fact.contentDigest) ok.push(fact);
    else tampered.push(fact.returnFactId);
  }
  return { ok, tampered };
}

export const CUSTOMS_RETURN_EVIDENCE_BOUNDARY = {
  ...CUSTOMS_RETURN_MATCHING_BOUNDARY,
  confirmedAmountOnlyForMatched: true,
  httpRecomputesMatching: false,
  frontendMayRecalculate: false,
} as const;

export function createPrismaReturnClaimEvidenceWriter(prisma: PrismaClient) {
  return {
    async append(result: CustomsReturnClaimEvidenceResult, payload: unknown) {
      const existing = await prisma.customsReturnClaimEvidenceRecord.findFirst({
        where: { id: result.evidenceId, organizationId: payload ? (payload as { organizationId: string }).organizationId : '' },
      });
      if (existing) return { status: 'ALREADY_APPENDED' as const, evidenceId: result.evidenceId };
      await prisma.customsReturnClaimEvidenceRecord.create({
        data: {
          id: result.evidenceId,
          organizationId: (payload as { organizationId: string }).organizationId,
          entryFactId: (payload as { entryFactId: string }).entryFactId,
          policyId: result.policyId,
          policyVersion: result.policyVersion,
          algorithmVersion: result.algorithmVersion,
          inputDigest: result.inputDigest,
          resultDigest: result.resultDigest,
          status: result.status,
          qualificationStatus: result.qualificationStatus,
          confirmedRecoverableAmountByCurrency: result.confirmedRecoverableAmountByCurrency as never,
          eligibleQuantityByLine: result.eligibleQuantityByLine as never,
          reasonCodes: [...result.status_reasons] as never,
          payload: (payload ?? {}) as never,
          computedAt: new Date(result.computedAt),
        },
      });
      return { status: 'APPENDED' as const, evidenceId: result.evidenceId };
    },

    async latest(input: { organizationId: string; entryFactId: string }) {
      const rows = await prisma.customsReturnClaimEvidenceRecord.findMany({
        where: { organizationId: input.organizationId, entryFactId: input.entryFactId },
        orderBy: [{ computedAt: 'desc' }, { id: 'desc' }],
      });
      return rows[0] ?? null;
    },
  };
}

/**
 * 运行收尾链路（服务端一次完成：匹配 → 证据 → qualification 门 → claim-ready evidence）。
 */
export async function runReturnClaimEvidence(input: {
  entryFactStore: CustomsEntryFactStore;
  returnFactStore: CustomsReturnFactStore;
  writer: ReturnType<typeof createPrismaReturnClaimEvidenceWriter>;
  organizationId: string;
  entryFactId: string;
  entryNumber: string;
  entryLines: readonly CustomsEntryLineWithDuty[];
  matchPolicy: CustomsMatchPolicy;
  qualification: CustomerQualificationDecision;
  algorithmVersion: string;
  computedAt: string;
}): Promise<CustomsReturnClaimEvidenceResult> {
  const entryFact = await input.entryFactStore.loadFact({ organizationId: input.organizationId, factId: input.entryFactId });
  if (!entryFact) throw new Error('ENTRY_FACT_NOT_FOUND');

  const returnFacts = await input.returnFactStore.listReturnFactsForEntry({
    organizationId: input.organizationId,
    entryNumber: input.entryNumber,
  });
  const { ok: usableFacts, tampered } = verifyReturnFactDigests(returnFacts);
  const matching = matchCustomsLinesToReturns({
    entryLines: input.entryLines,
    returnFacts: usableFacts,
    policy: input.matchPolicy,
  });

  const statusReasons: string[] = [];
  if (tampered.length > 0) statusReasons.push('DIGEST_MISMATCH_RECONCILIATION_REQUIRED');
  const confirmed: Record<string, string> = {};
  const perLine: { lineOrdinal: number; status: string; eligibleQuantity: string; confirmedDutyAmount: string }[] = [];

  for (const line of matching.lines) {
    const source = input.entryLines.find((candidate) => candidate.lineOrdinal === line.lineOrdinal);
    if (!source) throw new Error('ENTRY_LINE_NOT_FOUND');
    const counted = line.status === 'EXACT' || line.status === 'PARTIAL';
    if (!counted) statusReasons.push(line.status + '_LINE_' + String(line.lineOrdinal));
    const confirmedDuty = counted ? mulDiv(source.dutyAmount, line.eligibleQuantity, source.quantity) : '0.000000';
    if (counted) {
      confirmed[source.currency] = addScaled(confirmed[source.currency] ?? '0.000000', confirmedDuty);
    }
    perLine.push({
      lineOrdinal: line.lineOrdinal,
      status: line.status,
      eligibleQuantity: line.eligibleQuantity,
      confirmedDutyAmount: confirmedDuty,
    });
  }

  const qualificationOk = input.qualification.qualificationStatus === 'QUALIFIED';
  if (!qualificationOk) statusReasons.push('QUALIFICATION_' + input.qualification.qualificationStatus);

  const status: CustomsReturnEvidenceStatus =
    tampered.length > 0 ? 'RECONCILIATION_REQUIRED' : qualificationOk && statusReasons.length === 0 ? 'READY' : 'NOT_READY';

  const inputDigest = sha256({
    organizationId: input.organizationId,
    entryFactId: input.entryFactId,
    entryLines: input.entryLines,
    returnFactIds: returnFacts.map((fact) => fact.returnFactId).sort(),
    matchPolicy: input.matchPolicy,
    qualificationPolicyVersion: input.qualification.policyVersion,
    algorithmVersion: input.algorithmVersion,
    computedAt: input.computedAt,
  });
  const body = {
    status,
    status_reasons: statusReasons,
    confirmedRecoverableAmountByCurrency: status === 'READY' ? confirmed : status === 'NOT_READY' ? confirmed : {},
    eligibleQuantityByLine: perLine,
    qualificationStatus: input.qualification.qualificationStatus,
    policyId: input.matchPolicy.policyId,
    policyVersion: input.matchPolicy.policyVersion,
    algorithmVersion: input.algorithmVersion,
    inputDigest,
    computedAt: input.computedAt,
  };
  const resultDigest = sha256(body);
  const evidenceId = sha256({ inputDigest, resultDigest }).slice(0, 32);

  const result: CustomsReturnClaimEvidenceResult = {
    evidenceId,
    status,
    status_reasons: statusReasons,
    confirmedRecoverableAmountByCurrency: status === 'RECONCILIATION_REQUIRED' ? {} : confirmed,
    eligibleQuantityByLine: perLine,
    qualificationStatus: input.qualification.qualificationStatus,
    policyId: input.matchPolicy.policyId,
    policyVersion: input.matchPolicy.policyVersion,
    algorithmVersion: input.algorithmVersion,
    inputDigest,
    resultDigest,
    computedAt: input.computedAt,
    filingPerformed: false,
    transportEnabled: false,
    productionCredentials: 'ABSENT',
  };

  await input.writer.append(result, {
    organizationId: input.organizationId,
    entryFactId: input.entryFactId,
    entryNumber: input.entryNumber,
    matching,
    tamperedReturnFactIds: tampered,
    qualification: input.qualification,
  });

  return result;
}

export const CUSTOMS_RETURN_EVIDENCE_ROLES = ['OWNER', 'ADMIN', 'OPS'] as const;

/** HTTP：POST（受 Gate 保护，服务端运行链路；不合格/冲突 → 409，不触发任何外呼）。 */
export async function postReturnClaimEvidence(input: {
  session: { organizationId: string; actorUserId: string; role: string };
  run: () => Promise<CustomsReturnClaimEvidenceResult>;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!(CUSTOMS_RETURN_EVIDENCE_ROLES as readonly string[]).includes(input.session.role)) {
    return { status: 403, body: { error: 'FORBIDDEN', reason: 'ROLE_NOT_PERMITTED' } };
  }
  const result = await input.run();
  const boundary = {
    filingSubmitted: false,
    transportEnabled: false,
    externalWritePerformed: false,
    productionCredentials: 'ABSENT',
  };
  if (result.status === 'READY') return { status: 200, body: { ...result, boundary } };
  return {
    status: 409,
    body: { ...result, boundary, error: 'CLAIM_EVIDENCE_NOT_READY' },
  };
}

export const CUSTOMS_RETURN_EVIDENCE_READ_ROLES = ['OWNER', 'ADMIN', 'OPS', 'FINANCE'] as const;

/**
 * HTTP GET /customs-entry-facts/:entryFactId/return-claim-evidence —— **只读**已持久化结果。
 *  · 绝不在此层重算匹配 / 金额；前端只能消费这里返回的已裁决数据。
 *  · 无记录 → 404；角色不允许 → 403；跨租户由 deps 的 tenant-scoped 查询保证不可见。
 */
export async function getReturnClaimEvidenceView(input: {
  session: { organizationId: string; actorUserId: string; role: string };
  deps: { latest: (args: { organizationId: string; entryFactId: string }) => Promise<Record<string, unknown> | null> };
  entryFactId: string;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!(CUSTOMS_RETURN_EVIDENCE_READ_ROLES as readonly string[]).includes(input.session.role)) {
    return { status: 403, body: { error: 'FORBIDDEN', reason: 'ROLE_NOT_PERMITTED' } };
  }
  if (typeof input.entryFactId !== 'string' || input.entryFactId.trim() === '') {
    return { status: 400, body: { error: 'INVALID_REQUEST', reason: 'ENTRY_FACT_ID_REQUIRED' } };
  }
  const row = await input.deps.latest({
    organizationId: input.session.organizationId,
    entryFactId: input.entryFactId,
  });
  if (!row) return { status: 404, body: { error: 'NOT_FOUND' } };
  return {
    status: 200,
    body: {
      evidence: {
        evidenceId: row.id,
        status: row.status,
        statusReasons: row.reasonCodes,
        confirmedRecoverableAmountByCurrency: row.confirmedRecoverableAmountByCurrency,
        eligibleQuantityByLine: row.eligibleQuantityByLine,
        qualificationStatus: row.qualificationStatus,
        policyId: row.policyId,
        policyVersion: row.policyVersion,
        algorithmVersion: row.algorithmVersion,
        computedAt: (row.computedAt as Date).toISOString(),
        payload: row.payload,
      },
      boundary: {
        readOnly: true,
        recomputedOnRead: false,
        frontendMayRecalculate: false,
        filingSubmitted: false,
        transportEnabled: false,
        externalWritePerformed: false,
        productionCredentials: 'ABSENT',
      },
    },
  };
}
