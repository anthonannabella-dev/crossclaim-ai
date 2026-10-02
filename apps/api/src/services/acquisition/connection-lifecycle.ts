/**
 * C-0007 Gate 5 / Phase 1 — SourceConnection lifecycle.
 * ---------------------------------------------------------------
 * Approved boundary: an explicit state machine over the existing
 * `SourceConnectionStatus` enum (no schema change):
 *
 *   NEEDS_AUTH → ACTIVE → { PAUSED | ERROR | REVOKED }
 *   PAUSED     → { ACTIVE | REVOKED }
 *   ERROR      → { ACTIVE | PAUSED | NEEDS_AUTH | REVOKED }
 *   REVOKED    → (terminal)
 *
 * Every transition is audited (`source_connection.status_changed`), credential
 * rotation is audited separately (`source_connection.credential_rotated`) and a
 * credential reference is never written to logs or audit payloads.
 */

import type { Channel, RecoveryDomain, SourceConnectionKind, SourceConnectionStatus } from '@prisma/client';

import type { AuditWriter } from '../audit';
import { AcquisitionError } from './types';

export type ConnectionStatus = SourceConnectionStatus;

export const CONNECTION_TRANSITIONS: Record<ConnectionStatus, readonly ConnectionStatus[]> = {
  NEEDS_AUTH: ['ACTIVE', 'REVOKED'],
  ACTIVE: ['PAUSED', 'ERROR', 'NEEDS_AUTH', 'REVOKED'],
  PAUSED: ['ACTIVE', 'REVOKED'],
  ERROR: ['ACTIVE', 'PAUSED', 'NEEDS_AUTH', 'REVOKED'],
  REVOKED: [],
};

export function canTransition(from: ConnectionStatus, to: ConnectionStatus): boolean {
  return (CONNECTION_TRANSITIONS[from] ?? []).includes(to);
}

export function assertTransition(from: ConnectionStatus, to: ConnectionStatus): void {
  if (from === to) return;
  if (!canTransition(from, to)) {
    throw new AcquisitionError(
      'CONNECTION_KIND_MISMATCH',
      `SourceConnection 状态不允许从 ${from} 迁移到 ${to}（允许：${CONNECTION_TRANSITIONS[from].join(', ') || '无'}）`,
    );
  }
}

export interface ConnectionRecord {
  id: string;
  organizationId: string;
  status: ConnectionStatus;
  kind: SourceConnectionKind;
  domain: RecoveryDomain;
  channel: Channel;
  label: string;
  credentialRef: string | null;
}

export interface ConnectionLifecyclePort {
  find(organizationId: string, connectionId: string): Promise<ConnectionRecord | null>;
  create(draft: {
    organizationId: string;
    domain: RecoveryDomain;
    channel: Channel;
    kind: SourceConnectionKind;
    label: string;
    credentialRef: string | null;
    status: ConnectionStatus;
    /** TRACK B BATCH 3（MSG-20261002-77）：ACTIVE 连接必须已绑定 canonical PlatformAccount。 */
    platformAccountId?: string | null;
  }): Promise<{ id: string }>;
  update(
    organizationId: string,
    connectionId: string,
    patch: {
      status?: ConnectionStatus;
      credentialRef?: string | null;
      lastError?: string | null;
      lastErrorAt?: Date | null;
    },
  ): Promise<void>;
}

export interface ConnectionLifecycleDeps {
  connections: ConnectionLifecyclePort;
  audit: AuditWriter;
  now?: () => Date;
}

const CREDENTIAL_REF_MAX = 128;

function assertCredentialRef(value: string | null): void {
  if (value === null) return;
  if (typeof value !== 'string' || value.trim() === '' || value.length > CREDENTIAL_REF_MAX) {
    throw new AcquisitionError('CONNECTION_KIND_MISMATCH', 'credentialRef 必须是非空且不超过 128 字符的引用名');
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new AcquisitionError('CONNECTION_KIND_MISMATCH', 'credentialRef 含控制字符');
  }
}

/**
 * File upload connections need no external credential, API connections do.
 * This keeps "NEEDS_AUTH" meaningful instead of a decorative default.
 */
export function initialStatusFor(kind: SourceConnectionKind): ConnectionStatus {
  return kind === 'FILE_UPLOAD' ? 'ACTIVE' : 'NEEDS_AUTH';
}

export async function createConnection(
  input: {
    organizationId: string;
    domain: RecoveryDomain;
    channel: Channel;
    kind: SourceConnectionKind;
    label: string;
    credentialRef?: string | null;
    /** TRACK B BATCH 3：绑定的 canonical PlatformAccount；缺省时连接只能以 NEEDS_AUTH 存在。 */
    platformAccountId?: string | null;
  },
  deps: ConnectionLifecycleDeps,
): Promise<{ id: string; status: ConnectionStatus }> {
  const label = input.label.trim();
  if (!label) throw new AcquisitionError('CONNECTION_KIND_MISMATCH', 'label 不能为空');
  const credentialRef = input.credentialRef ?? null;
  assertCredentialRef(credentialRef);

  // TRACK B BATCH 3（MSG-20261002-77 B3-1 / B3-4）：
  // 未绑定 PlatformAccount 的连接不得是 ACTIVE —— 只能停留在 NEEDS_AUTH（只读冻结，不得 ingest）。
  const platformAccountId = input.platformAccountId ?? null;
  const status: ConnectionStatus = platformAccountId ? initialStatusFor(input.kind) : 'NEEDS_AUTH';
  const created = await deps.connections.create({
    organizationId: input.organizationId,
    domain: input.domain,
    channel: input.channel,
    kind: input.kind,
    label,
    credentialRef,
    status,
    platformAccountId,
  });

  await deps.audit.record({
    organizationId: input.organizationId,
    actorType: 'SYSTEM',
    actorRef: 'connection-lifecycle',
    action: 'source_connection.created',
    entityType: 'SourceConnection',
    entityId: created.id,
    changes: {
      kind: input.kind,
      label,
      domain: input.domain,
      channel: input.channel,
      status,
      hasCredentialRef: credentialRef !== null,
      hasPlatformAccount: platformAccountId !== null,
    },
  });

  return { id: created.id, status };
}

export async function transitionConnection(
  input: { organizationId: string; connectionId: string; to: ConnectionStatus; reason?: string },
  deps: ConnectionLifecycleDeps,
): Promise<{ from: ConnectionStatus; to: ConnectionStatus }> {
  const connection = await deps.connections.find(input.organizationId, input.connectionId);
  if (!connection) {
    throw new AcquisitionError('CONNECTION_NOT_FOUND', `连接 ${input.connectionId} 不存在或不属于该租户`);
  }
  assertTransition(connection.status, input.to);
  if (connection.status === input.to) return { from: connection.status, to: input.to };

  // Capture before the update: the port may return (and mutate) the same object.
  const from = connection.status;
  const at = (deps.now ?? (() => new Date()))();
  await deps.connections.update(input.organizationId, input.connectionId, {
    status: input.to,
    ...(input.to === 'ACTIVE' ? { lastError: null, lastErrorAt: null } : {}),
  });
  await deps.audit.record({
    organizationId: input.organizationId,
    actorType: 'SYSTEM',
    actorRef: 'connection-lifecycle',
    action: 'source_connection.status_changed',
    entityType: 'SourceConnection',
    entityId: input.connectionId,
    changes: { from, to: input.to, ...(input.reason ? { reason: input.reason } : {}), at: at.toISOString() },
  });
  return { from, to: input.to };
}

export async function rotateCredentialRef(
  input: { organizationId: string; connectionId: string; credentialRef: string | null },
  deps: ConnectionLifecycleDeps,
): Promise<void> {
  assertCredentialRef(input.credentialRef);
  const connection = await deps.connections.find(input.organizationId, input.connectionId);
  if (!connection) {
    throw new AcquisitionError('CONNECTION_NOT_FOUND', `连接 ${input.connectionId} 不存在或不属于该租户`);
  }
  if (connection.status === 'REVOKED') {
    throw new AcquisitionError('CONNECTION_KIND_MISMATCH', '已吊销的连接不能轮换凭据引用');
  }

  const previousRef = connection.credentialRef;
  const previousStatus = connection.status;
  await deps.connections.update(input.organizationId, input.connectionId, {
    credentialRef: input.credentialRef,
    // A credential change invalidates the previous authentication assumption.
    status: input.credentialRef === null ? 'NEEDS_AUTH' : previousStatus,
  });
  await deps.audit.record({
    organizationId: input.organizationId,
    actorType: 'SYSTEM',
    actorRef: 'connection-lifecycle',
    action: 'source_connection.credential_rotated',
    entityType: 'SourceConnection',
    entityId: input.connectionId,
    // never log the reference value itself
    changes: {
      hadCredentialRef: previousRef !== null,
      hasCredentialRef: input.credentialRef !== null,
      credentialRefChanged: previousRef !== input.credentialRef,
      status: input.credentialRef === null ? 'NEEDS_AUTH' : previousStatus,
    },
  });
}

export async function markConnectionError(
  input: { organizationId: string; connectionId: string; message: string },
  deps: ConnectionLifecycleDeps,
): Promise<void> {
  const at = (deps.now ?? (() => new Date()))();
  await deps.connections.update(input.organizationId, input.connectionId, {
    status: 'ERROR',
    lastError: input.message.slice(0, 500),
    lastErrorAt: at,
  });
  await deps.audit.record({
    organizationId: input.organizationId,
    actorType: 'SYSTEM',
    actorRef: 'connection-lifecycle',
    action: 'source_connection.status_changed',
    entityType: 'SourceConnection',
    entityId: input.connectionId,
    changes: { to: 'ERROR', reason: input.message.slice(0, 200), at: at.toISOString() },
  });
}
