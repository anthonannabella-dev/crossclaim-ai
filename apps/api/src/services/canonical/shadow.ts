/**
 * C-0006-B1 shadow detection run.
 * ---------------------------------------------------------------
 * The canonical path now "really runs" detection, but writes **only** into
 * `RuleEvaluationShadow`: no RuleEvaluation, no RecoveryOpportunity, no Case,
 * no Settlement. The legacy path keeps running untouched.
 *
 * Input is the business fact layer (ACTIVE CanonicalFacts only):
 *   INVOICE fact  → invoice row (amount/currency/date + tracking number from raw)
 *   TRACKING fact → tracking row (lane/service/weight from raw)
 *
 * CONFLICT facts are excluded from the input and recorded:
 *   - one `canonical_fact.conflict_detected` audit event per excluded fact
 *   - one `rule_evaluation.shadow_completed` summary event per run
 */

import { createHash } from 'node:crypto';

import type { Prisma, PrismaClient } from '@prisma/client';

import type { AuditWriter } from '../audit';
import {
  DETECTION_ENGINE_VERSION,
  parseFreightRateDefinition,
  runFreightRateDetection,
  type DetectionRowOutcome,
  type DetectionScope,
  type InvoiceRow,
  type RuleCandidate,
  type TrackingRow,
} from '../rules';
import { createInMemoryDetectionRepository, type DetectionInputs } from './parity';

export interface ShadowFactRef {
  canonicalFactId: string;
  factKey: string;
}

export interface ShadowEvaluationDraft {
  organizationId: string;
  runId: string;
  engineVersion: string;
  ruleVersionId: string;
  canonicalFactId: string;
  representativeTransactionId: string | null;
  result: 'PASS' | 'OPPORTUNITY';
  computed: unknown;
  message: string | null;
  evaluatedAt: Date;
  dedupeKeyShadow: string;
}

export interface ShadowRunSummary {
  runId: string;
  engineVersion: string;
  factsConsidered: number;
  activeInvoices: number;
  activeTracking: number;
  conflictFactsExcluded: number;
  excludedFactKeys: string[];
  evaluationsWritten: number;
  opportunitiesFound: number;
  outcomes: DetectionRowOutcome[];
  moneyTrace: string;
  factCoverage: {
    sourceTransactions: number;
    activeFactTransactions: number;
    conflictFactTransactions: number;
  };
}

const pickString = (raw: unknown, keys: string[]): string | null => {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
};

function scaled(value: string | null): bigint | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return null;
  const negative = trimmed.startsWith('-');
  const [intPart, fracPart = ''] = (negative ? trimmed.slice(1) : trimmed).split('.');
  const padded = (fracPart + '0000').slice(0, 4);
  const total = BigInt(intPart) * 10_000n + BigInt(padded === '' ? '0' : padded);
  return negative ? -total : total;
}

function formatScaled(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  return `${negative ? '-' : ''}${abs / 10_000n}.${(abs % 10_000n).toString().padStart(4, '0')}`;
}

function sumMoney(outcomes: readonly DetectionRowOutcome[]): string {
  let total = 0n;
  for (const outcome of outcomes) {
    const value = scaled(outcome.recoverable);
    if (value !== null) total += value;
  }
  return formatScaled(total);
}

export function shadowDedupeKey(input: {
  organizationId: string;
  runId: string;
  ruleVersionId: string;
  canonicalFactId: string;
}): string {
  return createHash('sha256')
    .update(
      [input.organizationId, input.runId, input.ruleVersionId, input.canonicalFactId].join('|'),
      'utf8',
    )
    .digest('hex');
}

export interface LoadedShadowInputs {
  inputs: DetectionInputs;
  /** representative SourceTransaction id → (canonicalFactId, factKey) */
  factByTransactionId: Map<string, ShadowFactRef>;
  factsConsidered: number;
  activeInvoices: number;
  activeTracking: number;
  excludedFactKeys: string[];
  coverage: ShadowRunSummary['factCoverage'];
}

export async function loadShadowInputs(
  prisma: PrismaClient,
  input: { organizationId: string; scope: DetectionScope; candidates: RuleCandidate[] },
): Promise<LoadedShadowInputs> {
  const scopeWhere = {
    organizationId: input.organizationId,
    domain: input.scope.domain,
    channel: input.scope.channel,
  };

  const [facts, conflictFacts, sourceTransactions] = await Promise.all([
    prisma.canonicalFact.findMany({
      where: { ...scopeWhere, status: 'ACTIVE' },
      select: {
        id: true,
        factKey: true,
        referenceType: true,
        externalId: true,
        occurredAt: true,
        amount: true,
        currency: true,
        sources: { select: { sourceTransactionId: true } },
      },
      orderBy: { externalId: 'asc' },
    }),
    prisma.canonicalFact.findMany({
      where: { ...scopeWhere, status: 'CONFLICT' },
      select: { id: true, factKey: true },
      orderBy: { factKey: 'asc' },
    }),
    prisma.sourceTransaction.count({ where: scopeWhere }),
  ]);

  const transactionIds = facts.flatMap((fact) => fact.sources.map((source) => source.sourceTransactionId));
  const rawRows = transactionIds.length
    ? await prisma.sourceTransaction.findMany({
        where: { organizationId: input.organizationId, id: { in: transactionIds } },
        select: { id: true, raw: true },
      })
    : [];
  const rawById = new Map(rawRows.map((row) => [row.id, row.raw]));

  const invoices: InvoiceRow[] = [];
  const tracking: TrackingRow[] = [];
  const factByTransactionId = new Map<string, ShadowFactRef>();

  for (const fact of facts) {
    const representative = fact.sources[0]?.sourceTransactionId ?? null;
    if (!representative) continue;
    factByTransactionId.set(representative, { canonicalFactId: fact.id, factKey: fact.factKey });
    const raw = rawById.get(representative);

    if (fact.referenceType === 'INVOICE') {
      invoices.push({
        sourceTransactionId: representative,
        externalId: fact.externalId,
        occurredAt: fact.occurredAt,
        amount: fact.amount === null ? null : fact.amount.toFixed(4),
        currency: fact.currency,
        trackingNumber: pickString(raw, ['Tracking Number', 'trackingNumber', 'tracking']),
      });
    } else if (fact.referenceType === 'TRACKING') {
      tracking.push({
        sourceTransactionId: representative,
        externalId: fact.externalId,
        lane: pickString(raw, ['Lane', 'lane']),
        service: pickString(raw, ['Service', 'service']),
        weightKg: pickString(raw, ['Weight Kg', 'weightKg', 'weight']),
      });
    }
  }

  return {
    inputs: { invoices, tracking, candidates: input.candidates },
    factByTransactionId,
    factsConsidered: facts.length,
    activeInvoices: invoices.length,
    activeTracking: tracking.length,
    excludedFactKeys: conflictFacts.map((fact) => fact.factKey),
    coverage: {
      sourceTransactions,
      activeFactTransactions: transactionIds.length,
      conflictFactTransactions: conflictFacts.length,
    },
  };
}

export interface ShadowRunDeps {
  prisma: PrismaClient;
  organizationId: string;
  scope: DetectionScope;
  audit?: AuditWriter;
  runId?: string;
  engineVersion?: string;
  now?: () => Date;
}

export async function runCanonicalShadow(deps: ShadowRunDeps): Promise<ShadowRunSummary> {
  const now = deps.now ?? (() => new Date());
  const engineVersion = deps.engineVersion ?? DETECTION_ENGINE_VERSION;
  const runId =
    deps.runId ??
    `shadow-run-${now().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;

  const candidates = await deps.prisma.ruleVersion.findMany({
    where: {
      isActive: true,
      ruleSet: {
        scope: 'FREIGHT_RATE',
        domain: deps.scope.domain,
        channel: deps.scope.channel,
        isActive: true,
        OR: [{ organizationId: deps.organizationId }, { organizationId: null }],
      },
    },
    select: {
      id: true,
      tier: true,
      version: true,
      effectiveFrom: true,
      effectiveTo: true,
      isActive: true,
      definition: true,
    },
  });
  const ruleCandidates: RuleCandidate[] = candidates.map((row) => ({
    ruleVersionId: row.id,
    tier: row.tier,
    version: row.version,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    isActive: row.isActive,
    definition: parseFreightRateDefinition(row.definition),
  }));

  const loaded = await loadShadowInputs(deps.prisma, {
    organizationId: deps.organizationId,
    scope: deps.scope,
    candidates: ruleCandidates,
  });

  const memory = createInMemoryDetectionRepository(loaded.inputs);
  const run = await runFreightRateDetection({
    organizationId: deps.organizationId,
    scope: deps.scope,
    repository: memory,
  });

  const drafts: ShadowEvaluationDraft[] = [];
  let opportunities = 0;
  for (const persisted of memory.persisted) {
    const ref = loaded.factByTransactionId.get(persisted.sourceTransactionId);
    if (!ref) continue;
    if (persisted.result === 'OPPORTUNITY') opportunities += 1;
    drafts.push({
      organizationId: deps.organizationId,
      runId,
      engineVersion,
      ruleVersionId: persisted.ruleVersionId,
      canonicalFactId: ref.canonicalFactId,
      representativeTransactionId: persisted.sourceTransactionId,
      result: persisted.result,
      computed: persisted.computed,
      message: persisted.message,
      evaluatedAt: now(),
      dedupeKeyShadow: shadowDedupeKey({
        organizationId: deps.organizationId,
        runId,
        ruleVersionId: persisted.ruleVersionId,
        canonicalFactId: ref.canonicalFactId,
      }),
    });
  }

  let written = 0;
  for (const draft of drafts) {
    await deps.prisma.ruleEvaluationShadow.upsert({
      where: { dedupeKeyShadow: draft.dedupeKeyShadow },
      create: {
        organizationId: draft.organizationId,
        runId: draft.runId,
        engineVersion: draft.engineVersion,
        ruleVersionId: draft.ruleVersionId,
        canonicalFactId: draft.canonicalFactId,
        representativeTransactionId: draft.representativeTransactionId,
        result: draft.result,
        computed: draft.computed as Prisma.InputJsonValue,
        message: draft.message,
        evaluatedAt: draft.evaluatedAt,
        dedupeKeyShadow: draft.dedupeKeyShadow,
      },
      update: {
        result: draft.result,
        computed: draft.computed as Prisma.InputJsonValue,
        message: draft.message,
        evaluatedAt: draft.evaluatedAt,
      },
    });
    written += 1;
  }

  const moneyTrace = sumMoney(run.outcomes);
  const summary: ShadowRunSummary = {
    runId,
    engineVersion,
    factsConsidered: loaded.factsConsidered,
    activeInvoices: loaded.activeInvoices,
    activeTracking: loaded.activeTracking,
    conflictFactsExcluded: loaded.excludedFactKeys.length,
    excludedFactKeys: loaded.excludedFactKeys,
    evaluationsWritten: written,
    opportunitiesFound: opportunities,
    outcomes: run.outcomes,
    moneyTrace,
    factCoverage: loaded.coverage,
  };

  if (deps.audit) {
    for (const factKey of loaded.excludedFactKeys) {
      try {
        await deps.audit.record({
          organizationId: deps.organizationId,
          actorType: 'SYSTEM',
          actorRef: 'canonical-shadow-runner',
          action: 'canonical_fact.conflict_detected',
          entityType: 'CanonicalFact',
          entityId: factKey,
          changes: {
            runId,
            factKey,
            conflictType: 'SOURCE_CONFLICT',
            organizationId: deps.organizationId,
          },
        });
      } catch {
        // best effort: an audit outage must not fail the shadow run
      }
    }
    try {
      await deps.audit.record({
        organizationId: deps.organizationId,
        actorType: 'SYSTEM',
        actorRef: 'canonical-shadow-runner',
        action: 'rule_evaluation.shadow_completed',
        entityType: 'RuleEvaluationShadow',
        entityId: runId,
        changes: {
          runId,
          engineVersion,
          evaluatedCount: written,
          excludedConflictCount: loaded.excludedFactKeys.length,
          matchedCount: written,
          mismatchCount: 0,
          moneyDelta: '0.0000',
          parityStatus: 'PENDING',
        },
      });
    } catch {
      // best effort
    }
  }

  return summary;
}
