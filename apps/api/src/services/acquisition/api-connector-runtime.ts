/**
 * C-0007 Gate 5 / Phase 3 — API Connector Runtime (read-only).
 * ---------------------------------------------------------------
 *   SourceConnection(API, ACTIVE) → registry → external adapter
 *     → authenticate → pull → canonical ingest → SourceTransaction → CanonicalFact
 *
 * Approved boundaries:
 *   - read-only: a write surface (submitClaim) is refused outright
 *   - only ACTIVE connections may pull; NEEDS_AUTH / PAUSED / ERROR / REVOKED
 *     are refused fail-closed
 *   - the platform comes from the connection config, never from the caller
 *   - no real platform, no OAuth: adapters are fixture/mock only
 */

import type { Channel, PrismaClient, RecoveryDomain } from '@prisma/client';

import type { AuditWriter } from '../audit';
import {
  implementsWriteSurface,
  type AdapterCredentialRef,
  type AdapterImportResult,
  type AdapterRegistry,
} from '../adapters';
import type { ImportRepository } from '../ingest';
import { runApiAcquisition } from './api-pull-service';
import type { SourceConnectionPort } from './types';

export type ConnectorRuntimeErrorCode =
  | 'CONNECTION_NOT_FOUND'
  | 'CONNECTION_NOT_API'
  | 'CONNECTION_STATUS_BLOCKED'
  | 'CONNECTOR_CONFIG_MISSING'
  | 'ADAPTER_NOT_FOUND'
  | 'ADAPTER_WRITE_SURFACE_BLOCKED'
  | 'CREDENTIAL_NOT_CONFIGURED';

export class ConnectorRuntimeError extends Error {
  readonly code: ConnectorRuntimeErrorCode;

  constructor(code: ConnectorRuntimeErrorCode, message: string) {
    super(message);
    this.name = 'ConnectorRuntimeError';
    this.code = code;
  }
}

export interface ConnectorRuntimeDeps {
  prisma: PrismaClient;
  connections: SourceConnectionPort;
  imports: ImportRepository;
  audit: AuditWriter;
  registry: AdapterRegistry;
  now?: () => Date;
}

export interface ConnectorPullInput {
  organizationId: string;
  connectionId: string;
  domain: RecoveryDomain;
  channel: Channel;
  since?: string;
  until?: string;
  cursor?: string | null;
  pageSize?: number;
}

interface ConnectionConfigRow {
  id: string;
  kind: string;
  status: string;
  credentialRef: string | null;
  config: unknown;
}

function platformOf(config: unknown): string | null {
  if (!config || typeof config !== 'object') return null;
  const value = (config as Record<string, unknown>).platform;
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

export async function runConnectorPull(
  input: ConnectorPullInput,
  deps: ConnectorRuntimeDeps,
): Promise<AdapterImportResult> {
  const connection = (await deps.prisma.sourceConnection.findFirst({
    where: { id: input.connectionId, organizationId: input.organizationId },
    select: { id: true, kind: true, status: true, credentialRef: true, config: true },
  })) as ConnectionConfigRow | null;

  if (!connection) {
    throw new ConnectorRuntimeError(
      'CONNECTION_NOT_FOUND',
      `连接 ${input.connectionId} 不存在或不属于该租户`,
    );
  }
  if (connection.kind !== 'API') {
    throw new ConnectorRuntimeError(
      'CONNECTION_NOT_API',
      `连接 ${connection.id} 类型为 ${connection.kind}，连接器只能驱动 API 连接`,
    );
  }
  if (connection.status !== 'ACTIVE') {
    throw new ConnectorRuntimeError(
      'CONNECTION_STATUS_BLOCKED',
      `连接 ${connection.id} 当前状态为 ${connection.status}，只有 ACTIVE 允许拉取`,
    );
  }

  const platform = platformOf(connection.config);
  if (!platform) {
    throw new ConnectorRuntimeError(
      'CONNECTOR_CONFIG_MISSING',
      `连接 ${connection.id} 缺少 config.platform，无法解析适配器`,
    );
  }
  if (!connection.credentialRef) {
    throw new ConnectorRuntimeError(
      'CREDENTIAL_NOT_CONFIGURED',
      `连接 ${connection.id} 未配置凭据引用（credentialRef）`,
    );
  }

  let adapter;
  try {
    adapter = deps.registry.get(platform);
  } catch {
    throw new ConnectorRuntimeError('ADAPTER_NOT_FOUND', `未注册适配器：${platform}`);
  }
  if (implementsWriteSurface(adapter)) {
    throw new ConnectorRuntimeError(
      'ADAPTER_WRITE_SURFACE_BLOCKED',
      `适配器 ${platform} 实现了写入面（submitClaim），Phase 1 拒绝使用`,
    );
  }

  const credentials: AdapterCredentialRef = { secretRef: connection.credentialRef };
  const result = await runApiAcquisition(
    {
      organizationId: input.organizationId,
      connectionId: connection.id,
      domain: input.domain,
      channel: input.channel,
      credentials,
      ...(input.since ? { since: input.since } : {}),
      ...(input.until ? { until: input.until } : {}),
      ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
      ...(input.pageSize !== undefined ? { pageSize: input.pageSize } : {}),
    },
    {
      adapter,
      connections: deps.connections,
      imports: deps.imports,
      audit: deps.audit,
      ...(deps.now ? { now: deps.now } : {}),
    },
  );

  await deps.audit.record({
    organizationId: input.organizationId,
    actorType: 'SYSTEM',
    actorRef: 'api-connector-runtime',
    action: 'adapter.pull_completed',
    entityType: 'SourceConnection',
    entityId: connection.id,
    changes: {
      connectionId: connection.id,
      platform,
      pages: result.pages,
      recordsPulled: result.recordsPulled,
      importStatus: result.import.status,
      rowsOk: result.import.rowsOk,
      rowsFailed: result.import.rowsFailed,
      duplicates: result.import.duplicates,
      nextCursor: result.nextCursor,
      ...(result.pullError ? { pullErrorCode: result.pullError.code } : {}),
    },
  });

  return result;
}
