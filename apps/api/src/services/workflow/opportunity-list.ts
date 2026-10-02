/**
 * TRACK A / PC-02 — OPPORTUNITY LIST（customer-visible read projection）.
 * ---------------------------------------------------------------
 * 授权：MSG-20261002-82 ⑥（PC-02 OPPORTUNITY LIST）。
 *
 * 范围（严格）：
 *   1. read API / projection：只读取当前 organization 的 RecoveryOpportunity；
 *      字段限定为 safe 集合，**不**暴露 raw SourceTransaction / secret / credentialRef / internal audit payload。
 *   2. filtering：status / domain / channel / account / detected date / recoverable amount threshold。
 *   3. stable sort + pagination：`detectedAt DESC, id DESC`；cursor 分页；limit 有界（默认 20，最大 100）。
 *   4. account isolation：多 PlatformAccount 时明确显示 opportunity 归属哪个 account；
 *      legacy（accountId = NULL）只标记 LEGACY_UNATTRIBUTED，**绝不**按当前 connection 绑定推断。
 *   5. customer-visible status semantics：内部枚举 → 客户可读状态（含 code + label）。
 *   6. detail entry：返回既有 action 入口（qualify / reject / case flow 的可用性），不重写 case creation logic。
 *
 * 只读：不改检测、不改规则、不改资金链、不新增 Schema。
 * 边界：NO platform write · Payment = 0 · TRANSPORT=false · 无生产凭据。
 */

import {
  Channel,
  OpportunityStatus,
  Prisma,
  RecoveryDomain,
  type PrismaClient,
} from '@prisma/client';

import { WorkflowError } from './opportunity-review';
import { assertPermission } from './permissions';

/** 过滤器取值一律来自 Prisma 枚举（不手写副本，避免与 Schema 漂移）。 */
const STATUSES = Object.values(OpportunityStatus);
const DOMAINS = Object.values(RecoveryDomain);
const CHANNELS = Object.values(Channel);

export const DEFAULT_OPPORTUNITY_PAGE_SIZE = 20;
export const MAX_OPPORTUNITY_PAGE_SIZE = 100;

/** 客户可读状态映射（内部枚举 → 稳定 code + 展示文案）。 */
export const CUSTOMER_STATUS: Record<string, { code: string; label: string }> = {
  DETECTED: { code: 'NEEDS_REVIEW', label: '待确认' },
  QUALIFIED: { code: 'RECOVERABLE', label: '可追回' },
  REJECTED: { code: 'EXCLUDED', label: '已排除' },
  CONVERTED: { code: 'IN_CASE', label: '已进入案件' },
  EXPIRED: { code: 'EXPIRED', label: '已过期' },
};

export interface OpportunityListActor {
  organizationId: string;
  actorUserId: string;
  role: string;
}

export interface OpportunityListQuery {
  status?: unknown;
  domain?: unknown;
  channel?: unknown;
  accountId?: unknown;
  detectedFrom?: unknown;
  detectedTo?: unknown;
  minRecoverable?: unknown;
  limit?: unknown;
  cursor?: unknown;
}

export interface OpportunityListItem {
  id: string;
  status: string;
  customerStatus: { code: string; label: string };
  opportunityType: string;
  title: string;
  description: string | null;
  recoverableAmount: string | null;
  amountExpected: string | null;
  amountActual: string | null;
  currency: string;
  confidence: number | null;
  claimDeadline: string | null;
  detectedAt: string;
  channel: string;
  domain: string;
  accountState: 'ATTRIBUTED' | 'LEGACY_UNATTRIBUTED';
  account: {
    id: string;
    platform: string;
    externalAccountId: string;
    displayName: string;
  } | null;
  actions: { canQualify: boolean; canReject: boolean; canCreateCase: boolean };
}

export interface OpportunityListResult {
  items: OpportunityListItem[];
  nextCursor: string | null;
  hasMore: boolean;
  appliedFilters: Record<string, unknown>;
  pageSize: number;
}

const money = (value: InstanceType<typeof Prisma.Decimal> | null): string | null =>
  value === null
    ? null
    : new Prisma.Decimal(value).toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP).toFixed(4);

function parseEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new WorkflowError('INVALID_INPUT', `${field} 非法：${String(value)}`);
  }
  return value as T;
}

function parseDate(value: unknown, field: string): Date | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new WorkflowError('INVALID_INPUT', `${field} 必须是 ISO 日期`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new WorkflowError('INVALID_INPUT', `${field} 不是合法日期`);
  return parsed;
}

function parseAmount(value: unknown): Prisma.Decimal | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new WorkflowError('INVALID_INPUT', 'minRecoverable 必须是数字');
  }
  try {
    const decimal = new Prisma.Decimal(value);
    if (decimal.isNegative()) throw new Error('negative');
    return decimal;
  } catch {
    throw new WorkflowError('INVALID_INPUT', 'minRecoverable 必须是非负数字');
  }
}

function parseLimit(value: unknown): number {
  if (value === undefined || value === null || value === '') return DEFAULT_OPPORTUNITY_PAGE_SIZE;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_OPPORTUNITY_PAGE_SIZE) {
    throw new WorkflowError(
      'INVALID_INPUT',
      `limit 必须是 1..${MAX_OPPORTUNITY_PAGE_SIZE} 的整数`,
    );
  }
  return parsed;
}

function encodeCursor(detectedAt: Date, id: string): string {
  return Buffer.from(detectedAt.toISOString() + '|' + id, 'utf8').toString('base64url');
}

function decodeCursor(value: unknown): { detectedAt: Date; id: string } | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new WorkflowError('INVALID_INPUT', 'cursor 非法');
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    const separator = decoded.lastIndexOf('|');
    if (separator <= 0) throw new Error('shape');
    const detectedAt = new Date(decoded.slice(0, separator));
    const id = decoded.slice(separator + 1);
    if (Number.isNaN(detectedAt.getTime()) || !id) throw new Error('shape');
    return { detectedAt, id };
  } catch {
    throw new WorkflowError('INVALID_INPUT', 'cursor 非法');
  }
}

export async function listOpportunities(
  prisma: PrismaClient,
  actor: OpportunityListActor,
  query: OpportunityListQuery = {},
): Promise<OpportunityListResult> {
  // 与 opportunity review 同一权限口径；未知角色 fail-closed。
  assertPermission(actor.role, 'reviewOpportunities');

  const status = parseEnum(query.status, STATUSES, 'status');
  const domain = parseEnum(query.domain, DOMAINS, 'domain');
  const channel = parseEnum(query.channel, CHANNELS, 'channel');
  const accountId =
    typeof query.accountId === 'string' && query.accountId.trim() !== '' ? query.accountId.trim() : undefined;
  const detectedFrom = parseDate(query.detectedFrom, 'detectedFrom');
  const detectedTo = parseDate(query.detectedTo, 'detectedTo');
  const minRecoverable = parseAmount(query.minRecoverable);
  const limit = parseLimit(query.limit);
  const cursor = decodeCursor(query.cursor);

  const filters: Prisma.RecoveryOpportunityWhereInput[] = [];
  if (status) filters.push({ status });
  if (domain) filters.push({ domain });
  if (channel) filters.push({ channel });
  if (accountId) filters.push({ accountId });
  if (detectedFrom || detectedTo) {
    filters.push({
      detectedAt: {
        ...(detectedFrom ? { gte: detectedFrom } : {}),
        ...(detectedTo ? { lte: detectedTo } : {}),
      },
    });
  }
  if (minRecoverable) filters.push({ recoverableAmount: { gte: minRecoverable } });

  if (cursor) {
    filters.push({
      OR: [
        { detectedAt: { lt: cursor.detectedAt } },
        { detectedAt: cursor.detectedAt, id: { lt: cursor.id } },
      ],
    });
  }

  const rows = await prisma.recoveryOpportunity.findMany({
    where: { organizationId: actor.organizationId, ...(filters.length ? { AND: filters } : {}) },
    orderBy: [{ detectedAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: {
      id: true,
      status: true,
      opportunityType: true,
      title: true,
      description: true,
      amountExpected: true,
      amountActual: true,
      recoverableAmount: true,
      currency: true,
      confidence: true,
      claimDeadline: true,
      detectedAt: true,
      channel: true,
      domain: true,
      accountId: true,
      // 4：只取展示所需字段；绝不读取 SourceTransaction / credential / token。
      platformAccount: { select: { id: true, platform: true, externalAccountId: true, displayName: true } },
    },
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const items: OpportunityListItem[] = page.map((row) => {
    const customerStatus = CUSTOMER_STATUS[row.status] ?? {
      code: 'UNKNOWN',
      label: row.status,
    };
    return {
      id: row.id,
      status: row.status,
      customerStatus,
      opportunityType: row.opportunityType,
      title: row.title,
      description: row.description,
      recoverableAmount: money(row.recoverableAmount),
      amountExpected: money(row.amountExpected),
      amountActual: money(row.amountActual),
      currency: row.currency,
      confidence: row.confidence,
      claimDeadline: row.claimDeadline ? row.claimDeadline.toISOString() : null,
      detectedAt: row.detectedAt.toISOString(),
      channel: row.channel,
      domain: row.domain,
      // legacy NULL 账户只标记未归因，绝不按 connection 推断（MSG-20261002-82 ⑥4）。
      accountState: row.platformAccount ? 'ATTRIBUTED' : 'LEGACY_UNATTRIBUTED',
      account: row.platformAccount
        ? {
            id: row.platformAccount.id,
            platform: row.platformAccount.platform,
            externalAccountId: row.platformAccount.externalAccountId,
            displayName: row.platformAccount.displayName,
          }
        : null,
      actions: {
        canQualify: row.status === 'DETECTED',
        canReject: row.status === 'DETECTED',
        canCreateCase: row.status === 'QUALIFIED',
      },
    };
  });

  const last = page.at(-1);
  return {
    items,
    nextCursor: hasMore && last ? encodeCursor(last.detectedAt, last.id) : null,
    hasMore,
    appliedFilters: {
      ...(status ? { status } : {}),
      ...(domain ? { domain } : {}),
      ...(channel ? { channel } : {}),
      ...(accountId ? { accountId } : {}),
      ...(detectedFrom ? { detectedFrom: detectedFrom.toISOString() } : {}),
      ...(detectedTo ? { detectedTo: detectedTo.toISOString() } : {}),
      ...(minRecoverable ? { minRecoverable: minRecoverable.toFixed(4) } : {}),
    },
    pageSize: limit,
  };
}
