/**
 * C-0006-B2 Step 3 Final Gate 前置 — duplicate resolution（标记，不删除）.
 * ---------------------------------------------------------------
 * The architecture ruling approves `KEEP_EXISTING` + review-only, but requires
 * an auditable record instead of a silent disappearance:
 *
 *   duplicate report + original RuleEvaluation id + retained id + marked id
 *   + resolution=KEEP_EXISTING + resolver=identity-migration
 *
 * Nothing is deleted or overwritten: the resolution is an audit event, and the
 * switch gate then counts `active unmapped = unmapped − resolved`.
 */

import type { PrismaClient } from '@prisma/client';

import type { AuditWriter } from '../audit';
import { buildDuplicateResolutionReport, type DuplicateResolutionEntry } from './duplicate-resolution';
import { planIdentityBackfill, type IdentityUnmappedReason } from './identity-backfill';

export const IDENTITY_RESOLUTION_ACTION = 'identity.duplicate_resolved';
export const IDENTITY_RESOLVER = 'identity-migration';
export const IDENTITY_DUPLICATE_REPORT = 'C-0006-B2 duplicate-resolution-report';

export interface IdentityResolutionOutcome {
  resolved: number;
  alreadyResolved: number;
  skipped: number;
  resolvedRuleEvaluationIds: string[];
}

export async function resolveEquivalentDuplicates(
  prisma: PrismaClient,
  audit: AuditWriter,
  input: { organizationId?: string; generatedAt?: Date } = {},
): Promise<IdentityResolutionOutcome> {
  const report = await buildDuplicateResolutionReport(prisma, input);
  const existing = await prisma.auditLog.findMany({
    where: {
      ...(input.organizationId ? { organizationId: input.organizationId } : {}),
      action: IDENTITY_RESOLUTION_ACTION,
    },
    select: { entityId: true },
  });
  const alreadyResolved = new Set(existing.map((row) => row.entityId).filter((id): id is string => id !== null));

  const outcome: IdentityResolutionOutcome = {
    resolved: 0,
    alreadyResolved: 0,
    skipped: 0,
    resolvedRuleEvaluationIds: [],
  };

  for (const entry of report.entries) {
    if (alreadyResolved.has(entry.ruleEvaluationId)) {
      outcome.alreadyResolved += 1;
      continue;
    }
    if (entry.recommendation !== 'KEEP_EXISTING' || !entry.equivalent || entry.existingRuleEvaluationIds.length !== 1) {
      outcome.skipped += 1;
      continue;
    }
    await audit.record({
      organizationId: entry.organizationId,
      actorType: 'SYSTEM',
      actorRef: IDENTITY_RESOLVER,
      action: IDENTITY_RESOLUTION_ACTION,
      entityType: 'RuleEvaluation',
      entityId: entry.ruleEvaluationId,
      changes: {
        duplicateReport: IDENTITY_DUPLICATE_REPORT,
        originalRuleEvaluationId: entry.ruleEvaluationId,
        retainedRuleEvaluationId: entry.existingRuleEvaluationIds[0],
        markedRuleEvaluationId: entry.ruleEvaluationId,
        resolution: 'KEEP_EXISTING',
        resolver: IDENTITY_RESOLVER,
        canonicalFactId: entry.targetCanonicalFactId,
        targetCanonicalDedupeKey: entry.targetCanonicalDedupeKey,
        reason: entry.reason,
      },
    });
    outcome.resolved += 1;
    outcome.resolvedRuleEvaluationIds.push(entry.ruleEvaluationId);
  }

  return outcome;
}

export interface IdentitySwitchGate {
  unmapped: Record<IdentityUnmappedReason, number>;
  resolvedUnmapped: number;
  activeUnmapped: number;
  canSwitch: boolean;
  resolvedRuleEvaluationIds: string[];
  pendingEntries: Array<{ ruleEvaluationId: string; reason: IdentityUnmappedReason }>;
}

export async function buildIdentitySwitchGate(
  prisma: PrismaClient,
  input: { organizationId?: string } = {},
): Promise<IdentitySwitchGate> {
  const plan = await planIdentityBackfill(prisma, input.organizationId ? { organizationId: input.organizationId } : {});
  const resolutions = await prisma.auditLog.findMany({
    where: {
      ...(input.organizationId ? { organizationId: input.organizationId } : {}),
      action: IDENTITY_RESOLUTION_ACTION,
    },
    select: { entityId: true, changes: true },
  });
  const resolved = new Set(
    resolutions
      .filter((row) => {
        const changes = row.changes as Record<string, unknown> | null;
        return changes?.resolution === 'KEEP_EXISTING' && changes?.resolver === IDENTITY_RESOLVER;
      })
      .map((row) => row.entityId)
      .filter((id): id is string => id !== null),
  );

  const stillUnmapped = plan.unmappedEntries.filter((entry) => !resolved.has(entry.ruleEvaluationId));
  const resolvedUnmapped = plan.unmappedEntries.length - stillUnmapped.length;

  return {
    unmapped: plan.unmapped,
    resolvedUnmapped,
    activeUnmapped: stillUnmapped.length,
    canSwitch: stillUnmapped.length === 0,
    resolvedRuleEvaluationIds: [...resolved],
    pendingEntries: stillUnmapped,
  };
}

export type { DuplicateResolutionEntry };
