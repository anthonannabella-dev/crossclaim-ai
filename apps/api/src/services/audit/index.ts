/**
 * 审计模块出口
 * ---------------------------------------------------------------
 * 对外只暴露：写入器、查询函数、端口接口与类型。
 * 刻意**不导出**任何 update / delete —— 审计只增不改。
 */

export * from './types';
export {
  createAuditWriter,
  listAuditTrail,
  normalizeLimit,
  type AuditWriter,
  type AuditWriterOptions,
} from './audit-log';
export {
  DEFAULT_MAX_STRING,
  REDACTED,
  STORAGE_KEY_MASK,
  hashIp,
  looksLikeSecret,
  maskStorageKey,
  sanitizeChanges,
  truncate,
} from './sanitize';
export { createPrismaAuditSink } from './prisma-sink';
