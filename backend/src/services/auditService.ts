import prisma from '../config/database';

export type AuditEntityType =
  | 'bill_of_lading'
  | 'declaration'
  | 'batch_group'
  | 'document'
  | 'tenant'
  | 'sub_account';

export interface RecordAuditInput {
  tenantId: string;
  action: string;
  detail: string;
  entityType?: AuditEntityType;
  entityId?: string | null;
  operatorId?: string | null;
  ip?: string | null;
}

/**
 * 统一审计日志写入入口。
 * - 永不抛错(审计失败不应阻断主流程),内部已 catch。
 * - 新增 entityType / entityId 用于按提单 / 按申报单 / 按批次精确串联。
 */
export async function recordAudit(input: RecordAuditInput): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        tenantId: input.tenantId,
        action: input.action,
        detail: input.detail,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        operatorId: input.operatorId ?? null,
        ip: input.ip ?? null,
      },
    });
  } catch {
    /* 审计写入失败静默,不影响主流程 */
  }
}
