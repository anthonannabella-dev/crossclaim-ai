/**
 * TRACK B BATCH 1 (B1-1) —— Account Lineage Policy / Resolver Layer（共享真相源）
 * ===============================================================
 * 架构方冻结规则（MSG-20261002-73 §④⑤ / MSG-20261002-74 ③ BATCH 1）：
 *   - tenant scoped：每次查询都必须带 organizationId；
 *   - server derived：只从服务端可信上下文派生，客户端提交的 account 一律不可信；
 *   - exactly one：多上下文各自解析后必须收敛到唯一 PlatformAccount；
 *   - missing / ambiguity / mismatch → fail-closed（PLATFORM_ACCOUNT_REQUIRED 或等价 stable code）；
 *   - no guessing：禁止按 label / channel 推断、禁止取租户第一个 account、禁止历史多数票；
 *   - no silent NULL：active new facts 不得因为无法派生而写 NULL。
 *
 * 本层是**策略真相源**，不是把所有领域硬塞进一支巨型函数：调用方按上下文选择受控 resolver
 * （fromConnection / fromTransaction / fromCanonicalFact / fromOpportunity / fromCase），
 * 但所有 resolver 共享同一套 invariant 与 error code。
 */

import type { Prisma } from '@prisma/client';

/** 统一 stable code：无法唯一确定 canonical PlatformAccount。 */
export const PLATFORM_ACCOUNT_REQUIRED = 'PLATFORM_ACCOUNT_REQUIRED';

/**
 * fail-closed 错误。历史名称 PlatformAccountRequiredError 保留为兼容别名
 * （evidence/account-scope.ts 继续 re-export），name 保持旧值以免日志/断言漂移。
 */
export class AccountLineageError extends Error {
  readonly code = PLATFORM_ACCOUNT_REQUIRED;
  constructor(reason: string) {
    super(`${PLATFORM_ACCOUNT_REQUIRED}: ${reason}`);
    this.name = 'PlatformAccountRequiredError';
  }
}

type Tx = Prisma.TransactionClient;

/**
 * exactly-one 收敛：候选集合（含 NULL / undefined / 空串）必须恰好收敛到 **一个非空 account**。
 * 任何 NULL / 空值都会使集合不唯一 → fail-closed（C2 冻结口径：含 NULL 主张链一律拒绝）。
 */
export function requireUniqueAccount(
  candidates: readonly (string | null | undefined)[],
  reason: string,
): string {
  const distinct = new Set(candidates);
  if (distinct.size !== 1) throw new AccountLineageError(reason);
  const only = [...distinct][0];
  if (typeof only !== 'string' || only.length === 0) {
    throw new AccountLineageError(reason);
  }
  return only;
}

/** connection 上下文派生（同租户复核；未绑定 → fail-closed）。 */
export async function resolveFromConnection(
  tx: Tx,
  input: { organizationId: string; connectionId: string | null },
): Promise<string> {
  if (!input.connectionId) throw new AccountLineageError('缺少可追溯的连接上下文');
  const connection = await tx.sourceConnection.findFirst({
    where: { id: input.connectionId, organizationId: input.organizationId },
    select: { platformAccountId: true },
  });
  if (!connection?.platformAccountId) throw new AccountLineageError('连接未绑定 PlatformAccount');
  return connection.platformAccountId;
}

/** SourceTransaction 上下文派生（行必须已归因）。 */
export async function resolveFromTransaction(
  tx: Tx,
  input: { organizationId: string; sourceTransactionId: string | null },
): Promise<string> {
  if (!input.sourceTransactionId) throw new AccountLineageError('缺少 SourceTransaction 上下文');
  const row = await tx.sourceTransaction.findFirst({
    where: { id: input.sourceTransactionId, organizationId: input.organizationId },
    select: { accountId: true },
  });
  if (!row?.accountId) throw new AccountLineageError('SourceTransaction 未归因到 PlatformAccount');
  return row.accountId;
}

/** CanonicalFact 上下文派生（事实必须已归因；legacy NULL 事实不可作为新写入来源）。 */
export async function resolveFromCanonicalFact(
  tx: Tx,
  input: { organizationId: string; canonicalFactId: string | null },
): Promise<string> {
  if (!input.canonicalFactId) throw new AccountLineageError('缺少 CanonicalFact 上下文');
  const row = await tx.canonicalFact.findFirst({
    where: { id: input.canonicalFactId, organizationId: input.organizationId },
    select: { accountId: true },
  });
  if (!row?.accountId) throw new AccountLineageError('CanonicalFact 未归因到 PlatformAccount');
  return row.accountId;
}

/** RecoveryOpportunity 上下文派生（机会必须已归因）。 */
export async function resolveFromOpportunity(
  tx: Tx,
  input: { organizationId: string; opportunityId: string | null },
): Promise<string> {
  if (!input.opportunityId) throw new AccountLineageError('缺少 RecoveryOpportunity 上下文');
  const row = await tx.recoveryOpportunity.findFirst({
    where: { id: input.opportunityId, organizationId: input.organizationId },
    select: { accountId: true },
  });
  if (!row?.accountId) throw new AccountLineageError('RecoveryOpportunity 未归因到 PlatformAccount');
  return row.accountId;
}

/**
 * case 上下文派生：case 的 claim 主张链优先，无主张时回落 case → CaseOpportunity → Opportunity.accountId。
 * 无主张且 opportunity 链不唯一 / 含 NULL → fail-closed（与 C2 冻结口径一致）。
 */
export async function resolveFromCase(
  tx: Tx,
  input: { organizationId: string; caseId: string | null },
): Promise<string> {
  if (!input.caseId) throw new AccountLineageError('缺少 case 上下文');
  const items = await tx.claimItem.findMany({
    where: { organizationId: input.organizationId, caseId: input.caseId },
    select: { accountId: true },
  });
  if (items.length > 0) {
    // 主张链存在时**不得**回落到 opportunity 链；含 NULL / 多账户一律 fail-closed。
    return requireUniqueAccount(
      items.map((item) => item.accountId),
      'case 下的主张未收敛到唯一 PlatformAccount',
    );
  }
  const links = await tx.caseOpportunity.findMany({
    where: { organizationId: input.organizationId, caseId: input.caseId },
    select: { opportunity: { select: { accountId: true } } },
  });
  return requireUniqueAccount(
    links.map((link) => link.opportunity?.accountId ?? null),
    'case 的 opportunity 链未收敛到唯一 PlatformAccount',
  );
}

/** 多上下文一致性：各自解析后必须收敛到同一个 PlatformAccount。 */
export async function resolveConsistentAccount(
  tx: Tx,
  input: {
    organizationId: string;
    connectionId?: string | null;
    caseId?: string | null;
  },
): Promise<string> {
  const resolved: string[] = [];
  if (input.connectionId) {
    resolved.push(
      await resolveFromConnection(tx, {
        organizationId: input.organizationId,
        connectionId: input.connectionId,
      }),
    );
  }
  if (input.caseId) {
    resolved.push(
      await resolveFromCase(tx, {
        organizationId: input.organizationId,
        caseId: input.caseId,
      }),
    );
  }
  if (resolved.length === 0) {
    throw new AccountLineageError('缺少可信身份上下文（连接或 case）');
  }
  return requireUniqueAccount(resolved, '提供的身份上下文未收敛到唯一 PlatformAccount');
}
