/**
 * C-0008-B1 — user-triggered SourceConnection management.
 * ---------------------------------------------------------------
 * The Gate 5 lifecycle rules stay authoritative (the same transition table,
 * the same "file upload needs no credential / API needs auth" initial status),
 * but a human-triggered change has to be attributed to that human and written
 * atomically with the row:
 *
 *   · permission  : manageConnections (OWNER / ADMIN only)
 *   · UPDATE      : inside the same transaction
 *   · AuditLog    : actorType=USER, actorUserId=<signed-in user>
 *
 * Safety rules from the ruling are enforced here, not in the route layer:
 *   · credentialRef is a *reference*, never a secret value
 *   · an API connection may only name a registered adapter platform
 *   · no secret, token or hash is ever written to the audit payload
 */

import {
  Channel,
  Prisma,
  RecoveryDomain,
  SourceConnectionKind,
  SourceConnectionStatus,
  type PrismaClient,
} from '@prisma/client';

import { AcquisitionError, assertTransition, initialStatusFor } from '../acquisition';
import { looksLikeSecret, prepareAuditInsert } from '../audit';
import { WorkflowError } from './opportunity-review';
import { assertPermission } from './permissions';

const LABEL_MAX = 100;
const CREDENTIAL_REF_MAX = 128;

const CHANNELS = Object.values(Channel) as readonly string[];
const DOMAINS = Object.values(RecoveryDomain) as readonly string[];
const STATUSES = Object.values(SourceConnectionStatus) as readonly string[];

/** Kinds a user may create from the UI. External-pull kinds are limited to API/FILE_UPLOAD for now. */
const CREATABLE_KINDS: readonly string[] = ['FILE_UPLOAD', 'API'];

export interface ConnectionView {
  id: string;
  label: string;
  kind: SourceConnectionKind;
  domain: RecoveryDomain;
  channel: Channel;
  status: string;
  hasCredentialRef: boolean;
  platform: string | null;
  lastError: string | null;
  lastErrorAt: Date | null;
  lastSyncAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConnectionManagementDeps {
  /**
   * Platforms of the adapters actually registered in this deployment. An API
   * connection may only reference one of them; an empty list therefore fails
   * closed (no adapter registered ⇒ no API connection).
   */
  registeredPlatforms?: readonly string[];
  now?: () => Date;
}

export interface ConnectionActor {
  organizationId: string;
  actorUserId: string;
  role: string;
}

export function assertLabel(label: unknown): string {
  const value = typeof label === 'string' ? label.trim() : '';
  if (value === '' || value.length > LABEL_MAX) {
    throw new WorkflowError('INVALID_INPUT', `label 必须为 1..${LABEL_MAX} 个字符`);
  }
  return value;
}

export function assertEnum<T extends string>(value: unknown, allowed: readonly string[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new WorkflowError('INVALID_INPUT', `${field} 非法：${String(value)}`);
  }
  return value as T;
}

/**
 * A credential *reference* (for example "aws-prod-key-01") is accepted; an
 * actual secret value is not. Rotation therefore can never be used to smuggle
 * a live credential into the database from the browser.
 */
export function assertCredentialRef(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new WorkflowError('INVALID_INPUT', 'credentialRef 必须是字符串或 null');
  }
  const ref = value.trim();
  if (ref === '') return null;
  if (ref.length > CREDENTIAL_REF_MAX) {
    throw new WorkflowError('INVALID_INPUT', `credentialRef 不得超过 ${CREDENTIAL_REF_MAX} 个字符`);
  }
  if (/[\u0000-\u001f\u007f]/.test(ref)) {
    throw new WorkflowError('INVALID_INPUT', 'credentialRef 含控制字符');
  }
  if (looksLikeSecret(ref)) {
    throw new WorkflowError(
      'SECRET_NOT_ACCEPTED',
      'credentialRef 只接受引用名，不接受真实密钥或令牌',
    );
  }
  return ref;
}

function platformOf(config: Prisma.JsonValue | null | undefined): string | null {
  if (config && typeof config === 'object' && !Array.isArray(config)) {
    const value = (config as Record<string, unknown>).platform;
    if (typeof value === 'string') return value;
  }
  return null;
}

export function assertPlatform(input: {
  kind: SourceConnectionKind;
  platform: unknown;
  registeredPlatforms: readonly string[];
}): string | null {
  if (input.kind !== 'API') return null;
  const platform = typeof input.platform === 'string' ? input.platform.trim() : '';
  if (platform === '') {
    throw new WorkflowError('INVALID_INPUT', 'API 连接必须指定已注册的适配器 platform');
  }
  if (!input.registeredPlatforms.includes(platform)) {
    throw new WorkflowError(
      'PLATFORM_NOT_REGISTERED',
      `platform ${platform} 未注册适配器，拒绝创建 API 连接`,
    );
  }
  return platform;
}

export async function listConnections(
  prisma: PrismaClient,
  actor: ConnectionActor,
): Promise<ConnectionView[]> {
  assertPermission(actor.role, 'manageConnections');

  const rows = await prisma.sourceConnection.findMany({
    where: { organizationId: actor.organizationId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      label: true,
      kind: true,
      domain: true,
      channel: true,
      status: true,
      credentialRef: true,
      config: true,
      lastError: true,
      lastErrorAt: true,
      lastSyncAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  // credentialRef itself is never returned to the browser — only whether it exists.
  return rows.map(({ credentialRef, config, ...row }) => ({
    ...row,
    hasCredentialRef: credentialRef !== null,
    platform: platformOf(config),
  }));
}

export interface CreateManagedConnectionInput extends ConnectionActor {
  label: unknown;
  kind: unknown;
  domain: unknown;
  channel: unknown;
  platform?: unknown;
  credentialRef?: unknown;
  /**
   * TRACK B BATCH 3（MSG-20261002-77 B3-1）：
   * 只接受 BIND_EXISTING（引用本租户已存在的 PlatformAccount）；
   * 缺省时连接以 NEEDS_AUTH 创建（只读冻结，不得 ingest，直到 binding 建立）。
   * 客户端提交的 account 只是「目标引用」，服务端仍必须复核同租户存在性。
   */
  account?: unknown;
}

export async function createManagedConnection(
  prisma: PrismaClient,
  input: CreateManagedConnectionInput,
  deps: ConnectionManagementDeps = {},
): Promise<{ id: string; status: string }> {
  assertPermission(input.role, 'manageConnections');

  const label = assertLabel(input.label);
  const kind = assertEnum<SourceConnectionKind>(input.kind, CREATABLE_KINDS, 'kind');
  const domain = assertEnum<RecoveryDomain>(input.domain, DOMAINS, 'domain');
  const channel = assertEnum<Channel>(input.channel, CHANNELS, 'channel');
  const credentialRef = assertCredentialRef(input.credentialRef);
  const platform = assertPlatform({
    kind,
    platform: input.platform,
    registeredPlatforms: deps.registeredPlatforms ?? [],
  });

  const at = (deps.now ?? (() => new Date()))();
  if (kind === 'API' && credentialRef === null) {
    throw new WorkflowError('INVALID_INPUT', 'API 连接必须提供 credentialRef（引用名，不是密钥）');
  }

  return prisma.$transaction(async (tx) => {
    const existing = await tx.sourceConnection.findFirst({
      where: { organizationId: input.organizationId, channel, label },
      select: { id: true },
    });
    if (existing) {
      throw new WorkflowError('DUPLICATE_CONNECTION', `同一渠道下已存在同名连接：${label}`);
    }

    const requestedAccount = input.account as
      | { mode?: unknown; platformAccountId?: unknown }
      | undefined;
    let boundAccountId: string | null = null;
    if (requestedAccount !== undefined && requestedAccount !== null) {
      if (requestedAccount.mode !== 'BIND_EXISTING') {
        throw new WorkflowError(
          'PLATFORM_ACCOUNT_REQUIRED',
          'PLATFORM_ACCOUNT_REQUIRED: 只接受 BIND_EXISTING（引用本租户已存在的 PlatformAccount）',
        );
      }
      const targetId =
        typeof requestedAccount.platformAccountId === 'string'
          ? requestedAccount.platformAccountId.trim()
          : '';
      if (!targetId) {
        throw new WorkflowError(
          'PLATFORM_ACCOUNT_REQUIRED',
          'PLATFORM_ACCOUNT_REQUIRED: BIND_EXISTING 必须提供 platformAccountId',
        );
      }
      const target = await tx.platformAccount.findFirst({
        where: { id: targetId, organizationId: input.organizationId },
        select: { id: true },
      });
      if (!target) {
        throw new WorkflowError(
          'PLATFORM_ACCOUNT_REQUIRED',
          'PLATFORM_ACCOUNT_REQUIRED: PlatformAccount 不存在或不属于该租户',
        );
      }
      boundAccountId = target.id;
    }
    // MSG-20261002-77 B3-1 / B3-4：未绑定账户的连接不得是 ACTIVE。
    const status = boundAccountId ? initialStatusFor(kind) : 'NEEDS_AUTH';

    const created = await tx.sourceConnection.create({
      data: {
        organizationId: input.organizationId,
        domain,
        channel,
        kind,
        label,
        credentialRef,
        status,
        platformAccountId: boundAccountId,
        ...(platform ? { config: { platform } } : {}),
      },
      select: { id: true },
    });

    const row = prepareAuditInsert(
      {
        organizationId: input.organizationId,
        actorType: 'USER',
        actorUserId: input.actorUserId,
        action: 'source_connection.created',
        entityType: 'SourceConnection',
        entityId: created.id,
        changes: {
          kind,
          label,
          domain,
          channel,
          status,
          platform,
          hasCredentialRef: credentialRef !== null,
          platformAccountId: boundAccountId,
          bindingMode: boundAccountId ? 'BIND_EXISTING' : null,
        },
      },
      { maxStringLength: 512 },
    );
    await tx.auditLog.create({
      data: {
        organizationId: row.organizationId,
        actorType: row.actorType,
        actorUserId: row.actorUserId,
        actorRef: row.actorRef,
        action: row.action,
        entityType: row.entityType,
        entityId: row.entityId,
        changes: (row.changes ?? undefined) as Prisma.InputJsonValue | undefined,
        ip: row.ip,
        userAgent: row.userAgent,
        createdAt: at,
      },
    });

    return { id: created.id, status };
  });
}

export interface SetConnectionStatusInput extends ConnectionActor {
  connectionId: string;
  to: unknown;
  reason?: unknown;
}

export async function setConnectionStatus(
  prisma: PrismaClient,
  input: SetConnectionStatusInput,
  deps: ConnectionManagementDeps = {},
): Promise<{ from: string; to: string }> {
  assertPermission(input.role, 'manageConnections');

  const to = assertEnum<string>(input.to, STATUSES, 'status');
  const reason = typeof input.reason === 'string' ? input.reason.slice(0, 200) : undefined;
  const at = (deps.now ?? (() => new Date()))();

  return prisma.$transaction(async (tx) => {
    const connection = await tx.sourceConnection.findFirst({
      where: { id: input.connectionId, organizationId: input.organizationId },
      select: { id: true, status: true },
    });
    if (!connection) {
      throw new WorkflowError('NOT_FOUND', `连接 ${input.connectionId} 不存在或不属于该租户`);
    }
    if (connection.status === to) {
      throw new WorkflowError('ILLEGAL_TRANSITION', `连接已处于 ${to}，无需重复迁移`);
    }
    try {
      // Gate 5 的状态机是唯一权威；这里只把它的错误类型翻译成工作流错误码，
      // 以便 HTTP 层返回 409 而不是 500。
      assertTransition(connection.status, to as SourceConnectionStatus);
    } catch (error) {
      if (error instanceof AcquisitionError) {
        throw new WorkflowError('ILLEGAL_TRANSITION', error.message);
      }
      throw error;
    }

    // 与机会复核同样的原子性要求：CAS 到「读到的那个状态」，避免并发迁移互相覆盖。
    const updated = await tx.sourceConnection.updateMany({
      where: { id: connection.id, organizationId: input.organizationId, status: connection.status },
      data: {
        status: to as SourceConnectionStatus,
        ...(to === 'ACTIVE' ? { lastError: null, lastErrorAt: null } : {}),
      },
    });
    if (updated.count !== 1) {
      throw new WorkflowError('ILLEGAL_TRANSITION', '连接状态已被其他操作改变，请刷新后重试');
    }

    const row = prepareAuditInsert(
      {
        organizationId: input.organizationId,
        actorType: 'USER',
        actorUserId: input.actorUserId,
        action: 'source_connection.status_changed',
        entityType: 'SourceConnection',
        entityId: connection.id,
        changes: {
          from: connection.status,
          to,
          ...(reason ? { reason } : {}),
          at: at.toISOString(),
        },
      },
      { maxStringLength: 512 },
    );
    await tx.auditLog.create({
      data: {
        organizationId: row.organizationId,
        actorType: row.actorType,
        actorUserId: row.actorUserId,
        actorRef: row.actorRef,
        action: row.action,
        entityType: row.entityType,
        entityId: row.entityId,
        changes: (row.changes ?? undefined) as Prisma.InputJsonValue | undefined,
        ip: row.ip,
        userAgent: row.userAgent,
        createdAt: at,
      },
    });

    return { from: connection.status, to };
  });
}

export interface RotateCredentialRefInput extends ConnectionActor {
  connectionId: string;
  credentialRef: unknown;
}

export async function rotateConnectionCredentialRef(
  prisma: PrismaClient,
  input: RotateCredentialRefInput,
  deps: ConnectionManagementDeps = {},
): Promise<{ hasCredentialRef: boolean; status: string }> {
  assertPermission(input.role, 'manageConnections');
  const credentialRef = assertCredentialRef(input.credentialRef);
  const at = (deps.now ?? (() => new Date()))();

  return prisma.$transaction(async (tx) => {
    const connection = await tx.sourceConnection.findFirst({
      where: { id: input.connectionId, organizationId: input.organizationId },
      select: { id: true, status: true, credentialRef: true },
    });
    if (!connection) {
      throw new WorkflowError('NOT_FOUND', `连接 ${input.connectionId} 不存在或不属于该租户`);
    }
    if (connection.status === 'REVOKED') {
      throw new WorkflowError('ILLEGAL_TRANSITION', '已吊销的连接不允许再轮换凭据引用');
    }

    const status = credentialRef === null ? 'NEEDS_AUTH' : connection.status;
    // CAS 到「读到的状态 + 读到的引用」，两次并发轮换不会互相覆盖。
    const updated = await tx.sourceConnection.updateMany({
      where: {
        id: connection.id,
        organizationId: input.organizationId,
        status: connection.status,
        credentialRef: connection.credentialRef,
      },
      data: { credentialRef, status },
    });
    if (updated.count !== 1) {
      throw new WorkflowError('ILLEGAL_TRANSITION', '连接凭据引用已被其他操作改变，请刷新后重试');
    }

    const row = prepareAuditInsert(
      {
        organizationId: input.organizationId,
        actorType: 'USER',
        actorUserId: input.actorUserId,
        action: 'source_connection.credential_rotated',
        entityType: 'SourceConnection',
        entityId: connection.id,
        // Never the reference value itself — only the shape of the change.
        changes: {
          hadCredentialRef: connection.credentialRef !== null,
          hasCredentialRef: credentialRef !== null,
          credentialRefChanged: connection.credentialRef !== credentialRef,
          status,
          at: at.toISOString(),
        },
      },
      { maxStringLength: 512 },
    );
    await tx.auditLog.create({
      data: {
        organizationId: row.organizationId,
        actorType: row.actorType,
        actorUserId: row.actorUserId,
        actorRef: row.actorRef,
        action: row.action,
        entityType: row.entityType,
        entityId: row.entityId,
        changes: (row.changes ?? undefined) as Prisma.InputJsonValue | undefined,
        ip: row.ip,
        userAgent: row.userAgent,
        createdAt: at,
      },
    });

    return { hasCredentialRef: credentialRef !== null, status };
  });
}
