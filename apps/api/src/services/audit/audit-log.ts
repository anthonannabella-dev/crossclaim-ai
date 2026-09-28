/**
 * 审计写入与查询
 * ---------------------------------------------------------------
 * 写入前做完整校验 + 脱敏；查询永远带租户过滤。
 * 本模块**不提供** update / delete —— 审计记录只增不改。
 */

import { AuditError, AUDIT_ACTOR_TYPES, type AuditActorType, type AuditEventInput, type AuditLogInsert, type AuditQueryArgs, type AuditRecord, type AuditSink, type AuditTrailQuery } from './types';
import { hashIp, sanitizeChanges, truncate } from './sanitize';

const ACTION_RE = /^[a-z][a-z0-9_.]{2,63}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;
const MAX_USER_AGENT = 256;

export interface AuditWriterOptions {
  /** 用于 IP 加盐哈希；未配置则拒绝写入带 IP 的审计 */
  ipSalt: string;
  now?: () => Date;
  /** 默认 512，测试可调小 */
  maxStringLength?: number;
}

export interface AuditWriter {
  record(event: AuditEventInput): Promise<AuditRecord>;
}

function assertOrganizationId(organizationId: string): void {
  if (typeof organizationId !== 'string' || !UUID_RE.test(organizationId)) {
    throw new AuditError('审计必须归属到合法租户（organizationId 必须是 UUID）');
  }
}

function assertActorType(actorType: AuditActorType): void {
  if (!AUDIT_ACTOR_TYPES.includes(actorType)) {
    throw new AuditError(`未知的 actorType: ${String(actorType)}`);
  }
}

function assertAction(action: string): void {
  if (typeof action !== 'string' || !ACTION_RE.test(action)) {
    throw new AuditError('action 必须是点分小写命名（如 file.downloaded）');
  }
}

function assertOptionalId(value: string | undefined, field: string): void {
  if (value === undefined) return;
  if (typeof value !== 'string' || value.trim() === '' || value.length > 128) {
    throw new AuditError(`${field} 非法`);
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new AuditError(`${field} 含控制字符`);
  }
}

/**
 * actor 语义校验（CHANGE #16）：
 *   USER            → 必须有 actorUserId（用户 id），且不得带 actorRef
 *   SYSTEM/AI/EXTERNAL → 必须有 actorRef（服务/模型/外部身份），且不得带 actorUserId
 * 一个字段不再同时承担两种含义，数据库另有 CHECK 兜底。
 */
function assertActorIdentity(event: AuditEventInput): void {
  if (event.actorType === 'USER') {
    if (!event.actorUserId) throw new AuditError('USER actor 必须提供 actorUserId');
    if (!UUID_RE.test(event.actorUserId)) throw new AuditError('actorUserId 必须是 UUID');
    if (event.actorRef) throw new AuditError('USER actor 不得带 actorRef');
    return;
  }
  if (event.actorUserId) {
    throw new AuditError('非 USER actor 不得带 actorUserId（避免误挂用户引用）');
  }
  if (!event.actorRef) throw new AuditError('非 USER actor 必须提供 actorRef');
  assertOptionalId(event.actorRef, 'actorRef');
}

/**
 * Audit row preparation (CHANGE #55)
 * ---------------------------------------------------------------
 * Single safety path shared by every audit writer: validation + sanitize ->
 * AuditLogInsert row. Keeps exactly one implementation of the Gate 1 contract.
 *   non-transactional : prepareAuditInsert -> AuditSink.insert
 *   transactional     : prepareAuditInsert -> tx.auditLog.create
 */
export interface PrepareAuditOptions {
  /** Required only when raw ip is supplied; it is never stored in clear. */
  ipSalt?: string;
  now?: () => Date;
  maxStringLength?: number;
}

export function prepareAuditInsert(
  event: AuditEventInput,
  options: PrepareAuditOptions = {},
): AuditLogInsert {
  assertOrganizationId(event.organizationId);
  assertActorType(event.actorType);
  assertActorIdentity(event);
  assertAction(event.action);
  assertOptionalId(event.entityType, 'entityType');
  assertOptionalId(event.entityId, 'entityId');

  let ip: string | null = null;
  if (event.ip) {
    const salt = options.ipSalt;
    if (!salt || salt.length < 16) {
      throw new AuditError('audit ip salt missing or too short for ip hashing');
    }
    ip = hashIp(event.ip, salt);
  }

  return {
    organizationId: event.organizationId,
    actorType: event.actorType,
    actorUserId: event.actorUserId ?? null,
    actorRef: event.actorRef ?? null,
    action: event.action,
    entityType: event.entityType ?? null,
    entityId: event.entityId ?? null,
    changes: event.changes
      ? sanitizeChanges(event.changes, { maxString: options.maxStringLength ?? 512 })
      : null,
    ip,
    userAgent: event.userAgent ? truncate(event.userAgent, MAX_USER_AGENT) : null,
    createdAt: options.now ? options.now() : new Date(),
  };
}

export function createAuditWriter(sink: AuditSink, options: AuditWriterOptions): AuditWriter {
  if (!options.ipSalt || options.ipSalt.length < 16) {
    throw new AuditError('审计 IP 盐值未配置或过短');
  }

  return {
    async record(event: AuditEventInput): Promise<AuditRecord> {
      return sink.insert(prepareAuditInsert(event, options));
    },
  };
}

export function normalizeLimit(limit?: number): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isFinite(limit) || limit <= 0) throw new AuditError('limit 非法');
  return Math.min(Math.floor(limit), MAX_LIMIT);
}

export async function listAuditTrail(
  sink: AuditSink,
  query: AuditTrailQuery,
): Promise<Array<AuditRecord & { action: string; actorType: AuditActorType }>> {
  assertOrganizationId(query.organizationId);
  // 即使调用方不给任何筛选条件，也永远带 organizationId —— 不提供跨租户导出
  const args: AuditQueryArgs = {
    organizationId: query.organizationId,
    take: normalizeLimit(query.limit),
    ...(query.actorUserId ? { actorUserId: query.actorUserId } : {}),
    ...(query.actorRef ? { actorRef: query.actorRef } : {}),
    ...(query.entityType ? { entityType: query.entityType } : {}),
    ...(query.entityId ? { entityId: query.entityId } : {}),
    ...(query.action ? { action: query.action } : {}),
    ...(query.before ? { before: query.before } : {}),
  };

  const rows = await sink.query(args);
  return rows.map((row) => ({
    id: row.id,
    createdAt: row.createdAt,
    action: row.action,
    actorType: row.actorType,
  }));
}
