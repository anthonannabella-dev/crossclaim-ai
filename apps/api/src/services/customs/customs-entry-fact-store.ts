/**
 * G8（MASTER GAP CLOSURE）— Customs C1–C5 **append-only 持久化**。
 * ---------------------------------------------------------------
 * A. 事实层：contentDigest 幂等（重复 ingest 不产生第二份 immutable fact）；tenant-scoped；lineage 完整。
 * B. 计算投影（DutyTruth / Discrepancy / Eligibility / Estimate）：只 APPEND；latest 由 computedAt (+ id) 确定性推导。
 * C. fail-closed：digest 相同但 immutable payload 不同 → FACT_IMMUTABLE_MISMATCH（绝不静默复用/覆盖）。
 * 边界：只写事实与投影；无 credential / raw payload；不做任何外写（externalWritePerformed=false）。
 */

import { createHash } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import { assertReadOnlyEntryFact, CustomsDutyTruthError } from './customs-duty-truth';
import type { CustomsEntryFact } from './customs-entry-contract';

export const CUSTOMS_PROJECTION_KINDS = ['DUTY_TRUTH', 'DISCREPANCY', 'ELIGIBILITY', 'ESTIMATE'] as const;
export type CustomsProjectionKind = (typeof CUSTOMS_PROJECTION_KINDS)[number];

export const CUSTOMS_ENTRY_FACT_STORE_ERROR_CODES = [
  'NOT_A_READ_ONLY_FACT',
  'INVALID_FACT_INPUT',
  'FACT_IMMUTABLE_MISMATCH',
  'INVALID_PROJECTION_INPUT',
] as const;
export type CustomsEntryFactStoreErrorCode = (typeof CUSTOMS_ENTRY_FACT_STORE_ERROR_CODES)[number];

export class CustomsEntryFactStoreError extends Error {
  readonly code: CustomsEntryFactStoreErrorCode;

  constructor(code: CustomsEntryFactStoreErrorCode, detail: string) {
    super(code + ': ' + detail);
    this.name = 'CustomsEntryFactStoreError';
    this.code = code;
  }
}

export const CUSTOMS_ENTRY_FACT_STORE_BOUNDARY = {
  appendOnly: true,
  projectionHistoryRetained: true,
  latestByComputedAt: true,
  crossTenantRejectedByDb: true,
  credentials: 'ABSENT',
  externalWritePerformed: false,
} as const;

export interface CustomsEntryFactWriteResult {
  status: 'RECORDED' | 'ALREADY_RECORDED';
  factId: string;
  contentDigest: string;
  lineCount: number;
}

export interface CustomsLoadedEntryFact {
  id: string;
  organizationId: string;
  entryNumber: string;
  entryDate: string;
  jurisdiction: string;
  portOfEntry: string;
  importerOfRecordRef: string;
  source: string;
  rawReference: string;
  observedAt: string;
  totalDutyAmountByCurrency: Record<string, string>;
  contentDigest: string;
  lines: readonly { lineOrdinal: number; kind: string; rawCode: string; amount: string; currency: string }[];
}

export interface CustomsProjectionWriteResult {
  status: 'APPENDED' | 'ALREADY_APPENDED';
  projectionId: string;
}

export interface CustomsLoadedProjection {
  id: string;
  kind: CustomsProjectionKind;
  inputFactId: string;
  inputDigest: string;
  algorithmVersion: string;
  resultDigest: string;
  computedAt: string;
  policyId: string | null;
  policyVersion: string | null;
  payload: unknown;
}

export interface CustomsEntryFactStore {
  recordFact(input: { organizationId: string; fact: CustomsEntryFact }): Promise<CustomsEntryFactWriteResult>;
  loadFact(input: { organizationId: string; factId: string }): Promise<CustomsLoadedEntryFact | null>;
  appendProjection(input: {
    organizationId: string;
    kind: CustomsProjectionKind;
    inputFactId: string;
    inputDigest: string;
    algorithmVersion: string;
    resultDigest: string;
    computedAt: Date;
    payload: unknown;
    policyId?: string | null;
    policyVersion?: string | null;
  }): Promise<CustomsProjectionWriteResult>;
  listProjections(input: {
    organizationId: string;
    inputFactId: string;
    kind: CustomsProjectionKind;
  }): Promise<readonly CustomsLoadedProjection[]>;
  loadLatestProjection(input: {
    organizationId: string;
    inputFactId: string;
    kind: CustomsProjectionKind;
  }): Promise<CustomsLoadedProjection | null>;
}

const P2002 = 'P2002';

function fail(code: CustomsEntryFactStoreErrorCode, detail: string): never {
  throw new CustomsEntryFactStoreError(code, detail);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return '{' + Object.keys(record).sort().map((key) => JSON.stringify(key) + ':' + canonical(record[key])).join(',') + '}';
  }
  return JSON.stringify(value ?? null);
}

function sha256Hex(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

/** immutable payload 规范化（事实的可比较身份；不含任何可变字段）。 */
export function canonicalCustomsEntryFactPayload(fact: CustomsEntryFact): unknown {
  return {
    entryNumber: fact.entryNumber,
    entryDate: fact.entryDate,
    jurisdiction: fact.jurisdiction,
    portOfEntry: fact.portOfEntry,
    importerOfRecordRef: fact.importerOfRecordRef,
    source: fact.source,
    rawReference: fact.rawReference,
    observedAt: fact.observedAt,
    dutyLines: fact.dutyLines.map((line) => ({
      kind: line.kind,
      rawCode: line.rawCode,
      amount: decimal6(line.amount),
      currency: line.currency,
    })),
  };
}

export function computeCustomsEntryContentDigest(fact: CustomsEntryFact): string {
  return sha256Hex(canonicalCustomsEntryFactPayload(fact));
}

function decimal6FromDb(value: unknown): string {
  const candidate = value as { toFixed?: (digits: number) => string } | null;
  if (candidate && typeof candidate.toFixed === 'function') return candidate.toFixed(6);
  return decimal6(String(value));
}

function decimal6(value: string): string {
  const trimmed = value.trim();
  const negative = trimmed.startsWith('-');
  const digits = negative ? trimmed.slice(1) : trimmed;
  const [whole, fraction = ''] = digits.split('.');
  return (negative ? '-' : '') + whole + '.' + fraction.padEnd(6, '0').slice(0, 6);
}

export function customsEntryFactId(organizationId: string, contentDigest: string): string {
  return sha256Hex({ organizationId, contentDigest }).slice(0, 32);
}

export function customsEntryDutyLineId(factId: string, lineOrdinal: number): string {
  return sha256Hex({ factId, lineOrdinal }).slice(0, 32);
}

export function customsProjectionId(input: {
  organizationId: string;
  kind: CustomsProjectionKind;
  inputFactId: string;
  inputDigest: string;
  algorithmVersion: string;
  resultDigest: string;
  computedAt: Date;
}): string {
  return sha256Hex({ ...input, computedAt: input.computedAt.toISOString() }).slice(0, 32);
}

type FactRowLike = {
  id: string;
  organizationId: string;
  entryNumber: string;
  entryDate: Date;
  jurisdiction: string;
  portOfEntry: string;
  importerOfRecordRef: string;
  source: string;
  rawReference: string;
  observedAt: Date;
  contentDigest: string;
  totalDutyAmountByCurrency?: unknown;
  dutyLines?: readonly { lineOrdinal: number; kind: string; rawCode: string; amount: unknown; currency: string }[];
};

function dbFactPayload(row: FactRowLike): unknown {
  return {
    entryNumber: row.entryNumber,
    entryDate: row.entryDate.toISOString().slice(0, 10),
    jurisdiction: row.jurisdiction,
    portOfEntry: row.portOfEntry,
    importerOfRecordRef: row.importerOfRecordRef,
    source: row.source,
    rawReference: row.rawReference,
    observedAt: row.observedAt.toISOString(),
    dutyLines: (row.dutyLines ?? [])
      .slice()
      .sort((left, right) => left.lineOrdinal - right.lineOrdinal)
      .map((line) => ({
        kind: line.kind,
        rawCode: line.rawCode,
        amount: decimal6FromDb(line.amount),
        currency: line.currency,
      })),
  };
}

function assertImmutablePayloadMatches(row: FactRowLike, fact: CustomsEntryFact): void {
  const stored = dbFactPayload(row);
  const incoming = canonicalCustomsEntryFactPayload(fact);
  if (canonical(stored) !== canonical(incoming)) {
    fail(
      'FACT_IMMUTABLE_MISMATCH',
      'contentDigest ' + row.contentDigest + ' 已存在但 immutable payload 不同（fail-closed，禁止覆盖或静默复用）',
    );
  }
}

export function createPrismaCustomsEntryFactStore(
  prisma: PrismaClient,
  deps: { computeDigest?: (fact: CustomsEntryFact) => string } = {},
): CustomsEntryFactStore {
  const computeDigest = deps.computeDigest ?? computeCustomsEntryContentDigest;

  async function loadFactRow(organizationId: string, where: { id?: string; contentDigest?: string }): Promise<FactRowLike | null> {
    const row = await prisma.customsEntryFactRecord.findFirst({
      where: { organizationId, ...where },
      include: { dutyLines: { orderBy: { lineOrdinal: 'asc' } } },
    });
    return (row as unknown as FactRowLike) ?? null;
  }

  return {
    async recordFact({ organizationId, fact }) {
      if (typeof organizationId !== 'string' || organizationId.trim() === '') {
        fail('INVALID_FACT_INPUT', 'organizationId 必填');
      }
      try {
        assertReadOnlyEntryFact(fact);
      } catch (error) {
        if (error instanceof CustomsDutyTruthError) fail('NOT_A_READ_ONLY_FACT', error.message);
        throw error;
      }
      const contentDigest = computeDigest(fact);
      const factId = customsEntryFactId(organizationId, contentDigest);

      const existing = await loadFactRow(organizationId, { contentDigest });
      if (existing) {
        assertImmutablePayloadMatches(existing, fact);
        return { status: 'ALREADY_RECORDED', factId: existing.id, contentDigest, lineCount: existing.dutyLines?.length ?? 0 };
      }

      try {
        await prisma.$transaction(async (tx) => {
          await tx.customsEntryFactRecord.create({
            data: {
              id: factId,
              organizationId,
              source: fact.source,
              entryNumber: fact.entryNumber,
              entryDate: new Date(fact.entryDate + 'T00:00:00.000Z'),
              jurisdiction: fact.jurisdiction,
              portOfEntry: fact.portOfEntry,
              importerOfRecordRef: fact.importerOfRecordRef,
              rawReference: fact.rawReference,
              contentDigest,
              totalDutyAmountByCurrency: fact.totalDutyAmountByCurrency as never,
              observedAt: new Date(fact.observedAt),
            },
          });
          await tx.customsEntryDutyLineRecord.createMany({
            data: fact.dutyLines.map((line, index) => ({
              id: customsEntryDutyLineId(factId, index),
              organizationId,
              factId,
              lineOrdinal: index,
              kind: line.kind,
              rawCode: line.rawCode,
              amount: decimal6(line.amount) as never,
              currency: line.currency,
            })),
          });
        });
        return { status: 'RECORDED', factId, contentDigest, lineCount: fact.dutyLines.length };
      } catch (error) {
        if ((error as { code?: string }).code !== P2002) throw error;
        const raced = await loadFactRow(organizationId, { contentDigest });
        if (!raced) throw error;
        assertImmutablePayloadMatches(raced, fact);
        return { status: 'ALREADY_RECORDED', factId: raced.id, contentDigest, lineCount: raced.dutyLines?.length ?? 0 };
      }
    },

    async loadFact({ organizationId, factId }) {
      const row = await loadFactRow(organizationId, { id: factId });
      if (!row) return null;
      return {
        id: row.id,
        organizationId: row.organizationId,
        entryNumber: row.entryNumber,
        entryDate: row.entryDate.toISOString().slice(0, 10),
        jurisdiction: row.jurisdiction,
        portOfEntry: row.portOfEntry,
        importerOfRecordRef: row.importerOfRecordRef,
        source: row.source,
        rawReference: row.rawReference,
        observedAt: row.observedAt.toISOString(),
        totalDutyAmountByCurrency: (row.totalDutyAmountByCurrency as Record<string, string>) ?? {},
        contentDigest: row.contentDigest,
        lines: (row.dutyLines ?? []).map((line) => ({
          lineOrdinal: line.lineOrdinal,
          kind: line.kind,
          rawCode: line.rawCode,
          amount: decimal6FromDb(line.amount),
          currency: line.currency,
        })),
      };
    },

    async appendProjection(input) {
      if (!(CUSTOMS_PROJECTION_KINDS as readonly string[]).includes(input.kind)) {
        fail('INVALID_PROJECTION_INPUT', '未知投影类型');
      }
      for (const field of ['organizationId', 'inputFactId', 'inputDigest', 'algorithmVersion', 'resultDigest'] as const) {
        if (typeof input[field] !== 'string' || input[field].trim() === '') {
          fail('INVALID_PROJECTION_INPUT', field + ' 必填');
        }
      }
      if (!(input.computedAt instanceof Date) || Number.isNaN(input.computedAt.getTime())) {
        fail('INVALID_PROJECTION_INPUT', 'computedAt 必须是有效 Date');
      }
      const projectionId = customsProjectionId(input);
      const model = projectionModel(prisma, input.kind);
      const existing = await model.findFirst({ where: { id: projectionId, organizationId: input.organizationId } });
      if (existing) return { status: 'ALREADY_APPENDED', projectionId };
      try {
        await model.create({
          data: {
            id: projectionId,
            organizationId: input.organizationId,
            inputFactId: input.inputFactId,
            inputDigest: input.inputDigest,
            algorithmVersion: input.algorithmVersion,
            resultDigest: input.resultDigest,
            computedAt: input.computedAt,
            payload: input.payload as never,
            ...(input.kind === 'ELIGIBILITY' || input.kind === 'ESTIMATE'
              ? { policyId: input.policyId ?? '', policyVersion: input.policyVersion ?? '' }
              : {}),
          },
        });
      } catch (error) {
        if ((error as { code?: string }).code !== P2002) throw error;
        return { status: 'ALREADY_APPENDED', projectionId };
      }
      return { status: 'APPENDED', projectionId };
    },

    async listProjections({ organizationId, inputFactId, kind }) {
      const model = projectionModel(prisma, kind);
      const rows = await model.findMany({
        where: { organizationId, inputFactId },
        orderBy: [{ computedAt: 'desc' }, { id: 'desc' }],
      });
      return (rows as unknown as Record<string, unknown>[]).map((row) => mapProjection(kind, row));
    },

    async loadLatestProjection({ organizationId, inputFactId, kind }) {
      const rows = await this.listProjections({ organizationId, inputFactId, kind });
      return rows[0] ?? null;
    },
  };
}

type ProjectionDelegate = {
  findFirst(args: { where: Record<string, unknown> }): Promise<Record<string, unknown> | null>;
  findMany(args: { where: Record<string, unknown>; orderBy?: unknown }): Promise<Record<string, unknown>[]>;
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
};

function projectionModel(prisma: PrismaClient, kind: CustomsProjectionKind): ProjectionDelegate {
  switch (kind) {
    case 'DUTY_TRUTH':
      return prisma.customsDutyTruthRecord as unknown as ProjectionDelegate;
    case 'DISCREPANCY':
      return prisma.customsDiscrepancyRecord as unknown as ProjectionDelegate;
    case 'ELIGIBILITY':
      return prisma.customsEligibilityRecord as unknown as ProjectionDelegate;
    case 'ESTIMATE':
      return prisma.customsRecoveryEstimateRecord as unknown as ProjectionDelegate;
    default:
      return fail('INVALID_PROJECTION_INPUT', '未知投影类型');
  }
}

function mapProjection(kind: CustomsProjectionKind, row: Record<string, unknown>): CustomsLoadedProjection {
  return {
    id: String(row.id),
    kind,
    inputFactId: String(row.inputFactId),
    inputDigest: String(row.inputDigest),
    algorithmVersion: String(row.algorithmVersion),
    resultDigest: String(row.resultDigest),
    computedAt: (row.computedAt as Date).toISOString(),
    policyId: (row.policyId as string | undefined) ?? null,
    policyVersion: (row.policyVersion as string | undefined) ?? null,
    payload: row.payload,
  };
}
