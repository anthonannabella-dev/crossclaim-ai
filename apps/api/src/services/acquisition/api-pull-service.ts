/**
 * API acquisition (C-0005 / Gate 3).
 * ---------------------------------------------------------------
 *   SourceConnection(kind=API) → ExternalAdapter.authenticate/pull → canonical ingest
 *
 * The adapter layer stays read-only (Gate 1 contract): no write surface, no
 * platform field promoted into a canonical field, no real third-party call in
 * this gate — tests use a fixture/mock adapter.
 *
 * Audit vocabulary: `adapter.pull_failed` for transport/auth/pagination failures,
 * `import.completed` / `import.failed` for the ingest outcome.
 */

import type { Channel, RecoveryDomain } from '@prisma/client';

import type { AuditWriter } from '../audit';
import {
  runAdapterImport,
  type AdapterCredentialRef,
  type AdapterImportResult,
  type ExternalAdapter,
} from '../adapters';
import type { ImportRepository } from '../ingest';
import { describeError, recordAcquisitionEvent, tryRecordAcquisitionEvent } from './audit';
import { AcquisitionError, type SourceConnectionPort } from './types';

export interface ApiPullInput {
  organizationId: string;
  connectionId: string;
  domain: RecoveryDomain;
  channel: Channel;
  credentials: AdapterCredentialRef;
  since?: string;
  until?: string;
  cursor?: string | null;
  pageSize?: number;
  createdBy?: string;
}

export interface ApiPullDeps {
  adapter: ExternalAdapter;
  connections: SourceConnectionPort;
  imports: ImportRepository;
  audit: AuditWriter;
  now?: () => Date;
}

export interface ApiPullResult extends AdapterImportResult {
  connectionId: string;
}

export async function runApiAcquisition(
  input: ApiPullInput,
  deps: ApiPullDeps,
): Promise<ApiPullResult> {
  const now = deps.now ?? (() => new Date());

  const connection = await deps.connections.find(input.organizationId, input.connectionId);
  if (!connection) {
    throw new AcquisitionError(
      'CONNECTION_NOT_FOUND',
      `连接 ${input.connectionId} 不存在或不属于该租户`,
    );
  }
  if (connection.organizationId !== input.organizationId) {
    throw new AcquisitionError('CONNECTION_TENANT_MISMATCH', '连接不属于该租户');
  }
  if (connection.kind !== 'API') {
    throw new AcquisitionError(
      'CONNECTION_KIND_MISMATCH',
      `连接 ${connection.id} 的类型为 ${connection.kind}，接口拉取只能用 API 连接`,
    );
  }

  const platform = deps.adapter.platform;
  let result: AdapterImportResult;
  try {
    result = await runAdapterImport({
      adapter: deps.adapter,
      credentials: input.credentials,
      context: {
        organizationId: input.organizationId,
        domain: input.domain,
        channel: input.channel,
        connectionId: connection.id,
        ...(input.createdBy ? { createdBy: input.createdBy } : {}),
      },
      repository: deps.imports,
      ...(input.since ? { since: input.since } : {}),
      ...(input.until ? { until: input.until } : {}),
      ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
      ...(input.pageSize !== undefined ? { pageSize: input.pageSize } : {}),
      now,
    });
  } catch (err) {
    const failure = describeError(err);
    await tryRecordAcquisitionEvent(deps.audit, {
      organizationId: input.organizationId,
      action: 'adapter.pull_failed',
      entityType: 'SourceConnection',
      entityId: connection.id,
      changes: {
        connectionId: connection.id,
        source: 'API',
        platform,
        failure,
      },
    });
    await deps.connections.markError(connection.id, failure.message, now());
    throw err;
  }

  if (result.pullError) {
    await recordAcquisitionEvent(deps.audit, {
      organizationId: input.organizationId,
      action: 'adapter.pull_failed',
      entityType: 'SourceConnection',
      entityId: connection.id,
      changes: {
        connectionId: connection.id,
        source: 'API',
        platform,
        partial: true,
        recordsPulled: result.recordsPulled,
        pullError: result.pullError,
      },
    });
  }

  await recordAcquisitionEvent(deps.audit, {
    organizationId: input.organizationId,
    action: result.import.status === 'FAILED' ? 'import.failed' : 'import.completed',
    entityType: 'ImportBatch',
    entityId: result.import.batchId,
    changes: {
      connectionId: connection.id,
      source: 'API',
      platform,
      status: result.import.status,
      pages: result.pages,
      recordsPulled: result.recordsPulled,
      rowsOk: result.import.rowsOk,
      rowsFailed: result.import.rowsFailed,
      duplicates: result.import.duplicates,
      issueCount: result.import.issues.length,
      ...(result.pullError ? { pullErrorCode: result.pullError.code } : {}),
    },
  });

  if (result.pullError || result.import.status === 'FAILED') {
    await deps.connections.markError(
      connection.id,
      result.pullError
        ? `pull partially failed: ${result.pullError.code}`
        : `import ${result.import.batchId} failed`,
      now(),
    );
  } else {
    await deps.connections.markSynced(connection.id, now());
  }

  return { ...result, connectionId: connection.id };
}
