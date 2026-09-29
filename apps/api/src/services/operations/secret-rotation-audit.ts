/**
 * Secret Rotation — 安全操作审计（P2-3，MSG-20260929-72）
 * ------------------------------------------------------------------
 * 语义（架构方冻结）：
 *   - 属 **security operation audit**，不是业务 AuditLog 事件
 *   - 只允许字段：secretName / actorUserId / timestamp / result / changeRequestId
 *   - **禁止**：secret value / hash / prefix / suffix / length / oldSecret / newSecret
 *   - 读取 secret 不产生任何审计（本模块只记录"轮换动作"本身）
 *
 * 实现要点：
 *   1) 白名单校验在**构造事件时**发生：任何未知字段一律抛错（错误只报字段名，不含字段值）
 *   2) 默认只写结构化安全日志（logger）；只有显式给出 organizationId（租户作用域的凭据引用轮换）
 *      才同时写 AuditLog —— 平台级 Secret 不写入租户审计表
 */

export const SECRET_ROTATION_ACTION = 'secret.rotated';

export const SECRET_ROTATION_ALLOWED_FIELDS = [
  'secretName',
  'actorUserId',
  'timestamp',
  'result',
  'changeRequestId',
] as const;

export const SECRET_ROTATION_RESULTS = ['SUCCESS', 'FAILED', 'ROLLED_BACK'] as const;
export type SecretRotationResult = (typeof SECRET_ROTATION_RESULTS)[number];

export interface SecretRotationEvent {
  secretName: string;
  actorUserId: string;
  timestamp: string;
  result: SecretRotationResult;
  changeRequestId: string;
}

export class SecretRotationAuditError extends Error {
  readonly code = 'SECRET_ROTATION_AUDIT_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'SecretRotationAuditError';
  }
}

const FORBIDDEN_KEY_HINTS = [
  'value',
  'hash',
  'prefix',
  'suffix',
  'length',
  'oldsecret',
  'newsecret',
  'secretmaterial',
];

/**
 * 构造脱敏审计事件。
 * - 未知字段 → 抛错（消息只含字段名）
 * - 显式的"值类"字段（value/hash/prefix/suffix/length/oldSecret/newSecret）→ 抛错并提示禁止原因
 */
export function buildSecretRotationEvent(input: unknown): SecretRotationEvent {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new SecretRotationAuditError('审计输入必须是对象');
  }
  const record = input as Record<string, unknown>;
  const allowed = new Set<string>(SECRET_ROTATION_ALLOWED_FIELDS);

  for (const key of Object.keys(record)) {
    const normalised = key.toLowerCase();
    const looksLikeValue =
      !allowed.has(key) && FORBIDDEN_KEY_HINTS.some((hint) => normalised.includes(hint));
    if (looksLikeValue) {
      throw new SecretRotationAuditError(`字段 ${key} 不允许出现在轮换审计中（禁止记录 secret 取值/派生信息）`);
    }
    if (!allowed.has(key)) {
      throw new SecretRotationAuditError(`未知字段 ${key}（只允许 ${SECRET_ROTATION_ALLOWED_FIELDS.join(', ')}）`);
    }
  }

  const secretName = record.secretName;
  const actorUserId = record.actorUserId;
  const changeRequestId = record.changeRequestId;
  const timestamp = record.timestamp;
  const result = record.result;

  if (typeof secretName !== 'string' || secretName.trim() === '') {
    throw new SecretRotationAuditError('secretName 必填（只写名称，不写取值）');
  }
  if (typeof actorUserId !== 'string' || actorUserId.trim() === '') {
    throw new SecretRotationAuditError('actorUserId 必填');
  }
  if (typeof changeRequestId !== 'string' || changeRequestId.trim() === '') {
    throw new SecretRotationAuditError('changeRequestId 必填（用于追溯变更单）');
  }
  if (typeof result !== 'string' || !(SECRET_ROTATION_RESULTS as readonly string[]).includes(result)) {
    throw new SecretRotationAuditError(`result 必须是 ${SECRET_ROTATION_RESULTS.join(' | ')}`);
  }

  return {
    secretName,
    actorUserId,
    timestamp: typeof timestamp === 'string' && timestamp !== '' ? timestamp : new Date().toISOString(),
    result: result as SecretRotationResult,
    changeRequestId,
  };
}

export interface SecretRotationAuditDeps {
  /** 结构化安全日志出口（默认路径；不含任何取值） */
  log?: (event: string, fields: Record<string, unknown>) => void;
  /** 仅租户作用域轮换（如 credentialRef）才提供：写 AuditLog */
  auditLogWriter?: (event: SecretRotationEvent, organizationId: string) => Promise<void>;
  organizationId?: string;
}

/**
 * 记录一次 Secret 轮换动作（脱敏）。
 * - 永远写结构化安全日志
 * - 仅当同时提供 organizationId 与 auditLogWriter 时写 AuditLog（租户作用域）
 * - 日志字段与审计字段一致：只有名称/操作者/时间/结果/变更单号
 */
export async function recordSecretRotation(
  deps: SecretRotationAuditDeps,
  input: unknown,
): Promise<SecretRotationEvent> {
  const event = buildSecretRotationEvent(input);
  deps.log?.(SECRET_ROTATION_ACTION, {
    secretName: event.secretName,
    actorUserId: event.actorUserId,
    result: event.result,
    changeRequestId: event.changeRequestId,
    timestamp: event.timestamp,
  });
  if (deps.organizationId && deps.auditLogWriter) {
    await deps.auditLogWriter(event, deps.organizationId);
  }
  return event;
}

/** Secret 轮换登记（仅名称；P2-3 冻结范围） */
export interface SecretInventoryEntry {
  name: string;
  /** 轮换策略：可停机型 / 可重叠型 / 引用名型 */
  rotationClass: 'stop-and-start' | 'overlap' | 'reference-only';
  /** 重叠窗口（分钟；overlap 类才需要） */
  overlapWindowMinutes?: number;
  /** 影响的运行时面 */
  impact: string;
  /** 执行者是否必须是宿主 */
  hostApprovalRequired: boolean;
}

export const SECRET_INVENTORY: readonly SecretInventoryEntry[] = [
  {
    name: 'DATABASE_URL',
    rotationClass: 'stop-and-start',
    impact: '数据库连接（轮换期间短暂不可用；需滚动重启）',
    hostApprovalRequired: true,
  },
  {
    name: 'SESSION_SECRET',
    rotationClass: 'overlap',
    overlapWindowMinutes: 60,
    impact: '会话令牌派生（轮换会使既有会话失效，需公告）',
    hostApprovalRequired: true,
  },
  {
    name: 'AUDIT_IP_SALT',
    rotationClass: 'overlap',
    overlapWindowMinutes: 0,
    impact: '审计 IP 哈希（历史哈希不重算，仅新增行使用新盐）',
    hostApprovalRequired: true,
  },
  {
    name: 'STORAGE_URL_SECRET',
    rotationClass: 'overlap',
    overlapWindowMinutes: 30,
    impact: '签名下载令牌（旧链接在窗口内仍需可验证）',
    hostApprovalRequired: true,
  },
  {
    name: 'STRIPE_WEBHOOK_SECRET',
    rotationClass: 'overlap',
    overlapWindowMinutes: 30,
    impact: 'Webhook 验签（窗口内双密钥验证，之后旧密钥失效）',
    hostApprovalRequired: true,
  },
  {
    name: 'SOURCE_CONNECTION_CREDENTIAL_REF',
    rotationClass: 'reference-only',
    impact: '连接凭据**引用名**（真实值在外部密钥管理；仓库只存引用）',
    hostApprovalRequired: true,
  },
  {
    name: 'OAUTH_CLIENT_CREDENTIAL_REF',
    rotationClass: 'reference-only',
    impact: '未来 OAuth 凭据引用（占位；接入需另行批准）',
    hostApprovalRequired: true,
  },
] as const;

/** 轮换流程（架构方冻结顺序） */
export const SECRET_ROTATION_FLOW = [
  'prepare',
  'generate',
  'overlap-window',
  'switch',
  'verify',
  'revoke-old',
  'audit',
] as const;

/** 回滚流程（必须覆盖"新值无效"场景） */
export const SECRET_ROTATION_ROLLBACK = [
  'detect-invalid-new-secret',
  'restore-old-secret',
  'verify',
  'audit-failure',
] as const;
