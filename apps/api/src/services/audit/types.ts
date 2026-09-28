/**
 * 审计基础逻辑（C-0003 / Gate 1 · 第 2 项 Audit implementation）
 * ---------------------------------------------------------------
 * 目标：任何会改变系统状态的动作都留痕，且留痕本身**不能成为新的泄露源**。
 *
 * 三条硬规则：
 *   1. **只增不改**：本模块只暴露 `record`（写）与 `listAuditTrail`（读），
 *      不存在 update / delete —— 审计记录不可篡改是底线。
 *   2. **租户隔离**：写入必须带 `organizationId`；查询必须按 `organizationId`
 *      过滤（不提供"查全部租户"的接口）。
 *   3. **不写入敏感值**：`storageKey`、密钥、令牌、原始 IP 等一律不落库 ——
 *      storageKey 用掩码，IP 用加盐哈希。
 */

export type AuditActorType = 'USER' | 'SYSTEM' | 'AI' | 'EXTERNAL';

export const AUDIT_ACTOR_TYPES: readonly AuditActorType[] = ['USER', 'SYSTEM', 'AI', 'EXTERNAL'];

export interface AuditEventInput {
  /** 必填：审计必须归属到租户 */
  organizationId: string;
  actorType: AuditActorType;
  /** 触发者 id（用户 id / 服务名 / 模型名等） */
  actorId?: string;
  /** 点分小写动作名，如 `file.downloaded`、`case.status_changed` */
  action: string;
  entityType?: string;
  entityId?: string;
  /** 变更详情；写入前会被脱敏与截断 */
  changes?: Record<string, unknown>;
  /** 原始 IP **不会**入库，只存加盐哈希 */
  ip?: string;
  userAgent?: string;
}

export interface AuditRecord {
  id: string;
  createdAt: Date;
}

export interface AuditTrailQuery {
  organizationId: string;
  entityType?: string;
  entityId?: string;
  action?: string;
  /** 默认 50，上限 200 */
  limit?: number;
  /** 只取该时间之前的记录（倒序翻页） */
  before?: Date;
}

/** 待落库的审计行（changes 已脱敏；id 由存储生成） */
export interface AuditLogInsert {
  organizationId: string;
  actorType: AuditActorType;
  actorId: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  changes: Record<string, unknown> | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: Date;
}

/** 查询返回的审计行 */
export interface AuditLogRow extends AuditLogInsert {
  id: string;
}

export interface AuditQueryArgs {
  organizationId: string;
  entityType?: string;
  entityId?: string;
  action?: string;
  take: number;
  before?: Date;
}

/** 存储端口：实现可以是 Prisma，也可以是测试用的内存实现 */
export interface AuditSink {
  insert(row: AuditLogInsert): Promise<AuditRecord>;
  query(args: AuditQueryArgs): Promise<AuditLogRow[]>;
}

export class AuditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditError';
  }
}
