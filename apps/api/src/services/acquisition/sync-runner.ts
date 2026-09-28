/**
 * C-0007 Gate 5 / Phase 4 — internal sync runner.
 * ---------------------------------------------------------------
 * Approved scope: an in-process runner (no Temporal, zero dependency) that
 * drives a SourceConnection once per call:
 *
 *   SourceConnection(ACTIVE) → API connector pull | pending file import retry
 *                            → canonical ingest → SourceTransaction / CanonicalFact
 *
 * Retry policy: exponential backoff 1m / 5m / 15m / 1h, bounded attempts, never
 * infinite. Execution history is **not** persisted (no SourceSyncRun table yet):
 * `lastSyncAt` / `lastError` / `lastErrorAt` describe current state only, while
 * every attempt is recorded as audit evidence.
 */

import type { Channel, PrismaClient, RecoveryDomain, SourceConnectionKind } from '@prisma/client';

import type { AuditWriter } from '../audit';
import type { AdapterImportResult } from '../adapters';
import type { AdapterRegistry } from '../adapters';
import { runImport, type ImportRepository, type ImportResult } from '../ingest';
import type { StorageAdapter } from '../storage';
import { ConnectorRuntimeError, runConnectorPull } from './api-connector-runtime';
import type { SourceConnectionPort } from './types';

export const RETRY_BACKOFF_MS = [60_000, 300_000, 900_000, 3_600_000] as const;
export const DEFAULT_MAX_ATTEMPTS = RETRY_BACKOFF_MS.length + 1;

/** Backoff before the next attempt; null when the attempt budget is exhausted. */
export function backoffForAttempt(
  attempt: number,
  maxAttempts: number = DEFAULT_MAX_ATTEMPTS,
): number | null {
  if (!Number.isInteger(attempt) || attempt < 1) return null;
  if (attempt >= maxAttempts) return null;
  return RETRY_BACKOFF_MS[Math.min(attempt - 1, RETRY_BACKOFF_MS.length - 1)];
}

export function shouldRetry(attempt: number, maxAttempts: number = DEFAULT_MAX_ATTEMPTS): boolean {
  return backoffForAttempt(attempt, maxAttempts) !== null;
}

export function nextAttemptAt(
  attempt: number,
  now: Date,
  maxAttempts: number = DEFAULT_MAX_ATTEMPTS,
): Date | null {
  const backoff = backoffForAttempt(attempt, maxAttempts);
  return backoff === null ? null : new Date(now.getTime() + backoff);
}

export type SyncRunStatus = 'SUCCEEDED' | 'FAILED' | 'BLOCKED' | 'SKIPPED';

export interface SyncRunOutcome {
  runId: string;
  connectionId: string;
  kind: SourceConnectionKind;
  status: SyncRunStatus;
  attempt: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  startedAt: string;
  finishedAt: string;
  detail: string | null;
  import: ImportResult | null;
  pull: AdapterImportResult | null;
}

export interface SyncRunnerDeps {
  prisma: PrismaClient;
  connections: SourceConnectionPort;
  imports: ImportRepository;
  audit: AuditWriter;
  storage: StorageAdapter;
  registry?: AdapterRegistry;
  now?: () => Date;
}

export interface SyncRunInput {
  organizationId: string;
  connectionId: string;
  domain: RecoveryDomain;
  channel: Channel;
  attempt?: number;
  maxAttempts?: number;
  since?: string;
  until?: string;
  cursor?: string | null;
  pageSize?: number;
}

function runIdFor(attempt: number, now: Date): string {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `sync-run-${stamp}-a${attempt}`;
}

interface FileRetryResult {
  status: 'SUCCEEDED' | 'SKIPPED';
  detail: string | null;
  import: ImportResult | null;
}

/**
 * FILE_UPLOAD runs retry the last file asset whose import failed. The bytes come
 * from the storage adapter (never from the caller) and the canonical ingest
 * dedupe keeps the retry idempotent.
 */
async function retryPendingFileImport(
  input: SyncRunInput,
  deps: SyncRunnerDeps,
): Promise<FileRetryResult> {
  const fileAsset = await deps.prisma.fileAsset.findFirst({
    where: { organizationId: input.organizationId, connectionId: input.connectionId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, storageKey: true, sha256: true },
  });
  if (!fileAsset) return { status: 'SKIPPED', detail: 'NO_FILE_ASSET', import: null };

  const latestBatch = await deps.prisma.importBatch.findFirst({
    where: { organizationId: input.organizationId, fileAssetId: fileAsset.id },
    orderBy: { startedAt: 'desc' },
    select: { id: true, status: true },
  });
  if (latestBatch && latestBatch.status !== 'FAILED') {
    return { status: 'SKIPPED', detail: `ALREADY_${latestBatch.status}`, import: null };
  }

  const stored = await deps.storage.get(fileAsset.storageKey, input.organizationId);
  const result = await runImport({
    context: {
      organizationId: input.organizationId,
      domain: input.domain,
      channel: input.channel,
      connectionId: input.connectionId,
    },
    csvText: stored.body.toString('utf8'),
    repository: deps.imports,
    fileAssetId: fileAsset.id,
    ...(deps.now ? { now: deps.now } : {}),
  });

  await deps.audit.record({
    organizationId: input.organizationId,
    actorType: 'SYSTEM',
    actorRef: 'sync-runner',
    action: result.status === 'FAILED' ? 'import.failed' : 'import.retry_completed',
    entityType: 'ImportBatch',
    entityId: result.batchId,
    changes: {
      connectionId: input.connectionId,
      fileAssetId: fileAsset.id,
      sha256: fileAsset.sha256,
      status: result.status,
      rowsOk: result.rowsOk,
      rowsFailed: result.rowsFailed,
      duplicates: result.duplicates,
      retriedFrom: latestBatch?.id ?? null,
    },
  });

  return {
    status: result.status === 'FAILED' ? 'SKIPPED' : 'SUCCEEDED',
    detail: result.status === 'FAILED' ? 'IMPORT_FAILED_AGAIN' : null,
    import: result,
  };
}

export async function runScheduledSync(
  input: SyncRunInput,
  deps: SyncRunnerDeps,
): Promise<SyncRunOutcome> {
  const now = deps.now ?? (() => new Date());
  const attempt = input.attempt ?? 1;
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const startedAt = now();
  const runId = runIdFor(attempt, startedAt);

  const connection = await deps.prisma.sourceConnection.findFirst({
    where: { id: input.connectionId, organizationId: input.organizationId },
    select: { id: true, kind: true, status: true },
  });

  const base = {
    runId,
    connectionId: input.connectionId,
    kind: (connection?.kind ?? 'MANUAL') as SourceConnectionKind,
    attempt,
    maxAttempts,
    startedAt: startedAt.toISOString(),
    import: null,
    pull: null,
  } satisfies Partial<SyncRunOutcome>;

  if (!connection) {
    return { ...base, status: 'BLOCKED', detail: 'CONNECTION_NOT_FOUND', nextAttemptAt: null, finishedAt: now().toISOString() } as SyncRunOutcome;
  }
  if (connection.status !== 'ACTIVE') {
    return {
      ...base,
      status: 'BLOCKED',
      detail: `CONNECTION_${connection.status}`,
      nextAttemptAt: null,
      finishedAt: now().toISOString(),
    } as SyncRunOutcome;
  }

  try {
    let outcome: { status: SyncRunStatus; detail: string | null; import: ImportResult | null; pull: AdapterImportResult | null };

    if (connection.kind === 'API') {
      if (!deps.registry) throw new Error('runner 缺少 adapter registry');
      const pull = await runConnectorPull(
        {
          organizationId: input.organizationId,
          connectionId: connection.id,
          domain: input.domain,
          channel: input.channel,
          ...(input.since ? { since: input.since } : {}),
          ...(input.until ? { until: input.until } : {}),
          ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
          ...(input.pageSize !== undefined ? { pageSize: input.pageSize } : {}),
        },
        {
          prisma: deps.prisma,
          connections: deps.connections,
          imports: deps.imports,
          audit: deps.audit,
          registry: deps.registry,
          ...(deps.now ? { now: deps.now } : {}),
        },
      );
      outcome = { status: 'SUCCEEDED', detail: null, import: pull.import, pull };
    } else {
      const file = await retryPendingFileImport(input, deps);
      outcome = { status: file.status === 'SUCCEEDED' ? 'SUCCEEDED' : 'SKIPPED', detail: file.detail, import: file.import, pull: null };
    }

    await deps.connections.markSynced(connection.id, now());
    await deps.audit.record({
      organizationId: input.organizationId,
      actorType: 'SYSTEM',
      actorRef: 'sync-runner',
      action: 'sync_run.completed',
      entityType: 'SourceConnection',
      entityId: connection.id,
      changes: {
        runId,
        attempt,
        status: outcome.status,
        detail: outcome.detail,
        importStatus: outcome.import?.status ?? null,
        rowsOk: outcome.import?.rowsOk ?? null,
        recordsPulled: outcome.pull?.recordsPulled ?? null,
        pullErrorCode: outcome.pull?.pullError?.code ?? null,
        // execution history is not persisted yet (no SourceSyncRun schema)
        historyPersisted: false,
      },
    });

    return { ...base, status: outcome.status, detail: outcome.detail, nextAttemptAt: null, finishedAt: now().toISOString(), import: outcome.import, pull: outcome.pull } as SyncRunOutcome;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const blocked = error instanceof ConnectorRuntimeError && error.code !== 'ADAPTER_NOT_FOUND';
    const next = blocked ? null : nextAttemptAt(attempt, now(), maxAttempts);
    await deps.connections.markError(connection.id, message.slice(0, 500), now()).catch(() => undefined);
    await deps.audit
      .record({
        organizationId: input.organizationId,
        actorType: 'SYSTEM',
        actorRef: 'sync-runner',
        action: 'sync_run.failed',
        entityType: 'SourceConnection',
        entityId: connection.id,
        changes: {
          runId,
          attempt,
          maxAttempts,
          message: message.slice(0, 200),
          nextAttemptAt: next ? next.toISOString() : null,
          retryable: next !== null,
        },
      })
      .catch(() => undefined);

    return {
      ...base,
      status: blocked ? 'BLOCKED' : 'FAILED',
      detail: message.slice(0, 200),
      nextAttemptAt: next ? next.toISOString() : null,
      finishedAt: now().toISOString(),
    } as SyncRunOutcome;
  }
}
