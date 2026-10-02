/**
 * MSG-20261002-68 CHANGE A —— Evidence / downstream fact 的 account provenance 解析。
 *
 * 规则（架构方冻结）：
 *   - 只允许服务端从**可信上下文**派生 PlatformAccount：连接上下文或 case 的 account-scoped 主张链；
 *   - 客户端不得提交可信 platformAccountId；
 *   - 无法唯一确定 account（缺失 / 歧义 / 跨账户）→ fail-closed（PLATFORM_ACCOUNT_REQUIRED）；
 *   - **不得**退回 NULL 写新业务事实（legacy 历史行允许 NULL，但新写入路径不允许）。
 */

import type { Prisma } from '@prisma/client';

/**
 * 统一入口：Evidence / downstream fact 写入方只需调用这一个函数。
 * 顺序 = 连接上下文（最可信）→ case 主张链；两者都无法唯一确定 → fail-closed。
 * 客户端传入的任何 account 值都不参与判定。
 */
export async function resolveEvidenceAccountId(
  tx: Tx,
  input: { organizationId: string; connectionId?: string | null; caseId?: string | null },
): Promise<string> {
  // MSG-20261002-69：多上下文必须**各自解析后一致性验证**，不得“连接优先即返回”。
  const resolved: string[] = [];
  if (input.connectionId) {
    resolved.push(
      await resolveAccountIdFromConnection(tx, {
        organizationId: input.organizationId,
        connectionId: input.connectionId,
      }),
    );
  }
  if (input.caseId) {
    resolved.push(
      await resolveAccountIdFromCase(tx, {
        organizationId: input.organizationId,
        caseId: input.caseId,
      }),
    );
  }
  if (resolved.length === 0) {
    throw new PlatformAccountRequiredError('既无连接上下文也无 case 主张链，无法派生 provenance');
  }
  if (new Set(resolved).size !== 1) {
    throw new PlatformAccountRequiredError('多身份上下文不一致（connection 与 case 指向不同 PlatformAccount）');
  }
  return resolved[0];
}

export const PLATFORM_ACCOUNT_REQUIRED = 'PLATFORM_ACCOUNT_REQUIRED';

export class PlatformAccountRequiredError extends Error {
  readonly code = PLATFORM_ACCOUNT_REQUIRED;
  constructor(reason: string) {
    super(`${PLATFORM_ACCOUNT_REQUIRED}: ${reason}`);
    this.name = 'PlatformAccountRequiredError';
  }
}

type Tx = Prisma.TransactionClient;

/** 连接上下文派生：SourceConnection.platformAccountId（同租户复核）。 */
export async function resolveAccountIdFromConnection(
  tx: Tx,
  input: { organizationId: string; connectionId: string | null },
): Promise<string> {
  if (!input.connectionId) {
    throw new PlatformAccountRequiredError('缺少可追溯的连接上下文');
  }
  const connection = await tx.sourceConnection.findFirst({
    where: { id: input.connectionId, organizationId: input.organizationId },
    select: { platformAccountId: true },
  });
  if (!connection?.platformAccountId) {
    throw new PlatformAccountRequiredError('连接未绑定 PlatformAccount');
  }
  return connection.platformAccountId;
}

/**
 * case 上下文派生：从 case 的 claim 主张链读取 account。
 * 全部主张同属一个非空 account → 返回该 account；无主张 / 存在多个 account / 含旧 NULL 主张 → fail-closed。
 */
export async function resolveAccountIdFromCase(
  tx: Tx,
  input: { organizationId: string; caseId: string | null },
): Promise<string> {
  if (!input.caseId) {
    throw new PlatformAccountRequiredError('缺少 case 上下文');
  }
  const items = await tx.claimItem.findMany({
    where: { organizationId: input.organizationId, caseId: input.caseId },
    select: { accountId: true },
  });
  const accounts = new Set(items.map((item) => item.accountId));
  if (accounts.size === 1 && !accounts.has(null)) {
    return [...accounts][0] as string;
  }
  if (items.length > 0) {
    throw new PlatformAccountRequiredError('case 下的主张未收敛到唯一 PlatformAccount');
  }
  const links = await tx.caseOpportunity.findMany({
    where: { organizationId: input.organizationId, caseId: input.caseId },
    select: { opportunity: { select: { accountId: true } } },
  });
  const oppAccounts = new Set(links.map((link) => link.opportunity?.accountId ?? null));
  if (oppAccounts.size !== 1 || oppAccounts.has(null)) {
    throw new PlatformAccountRequiredError('case 的 opportunity 链未收敛到唯一 PlatformAccount');
  }
  return [...oppAccounts][0] as string;
}
