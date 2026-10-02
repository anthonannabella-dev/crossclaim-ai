/**
 * MSG-20261002-68 CHANGE A / MSG-20261002-74 TRACK B BATCH 1 —— Evidence / downstream fact 的
 * account provenance 解析（**兼容外观**）。
 *
 * 自 TRACK B BATCH 1 起，规则本体收敛到共享的 Account Lineage Policy / Resolver Layer：
 *   services/account-lineage/policy.ts
 * 本文件只保留既有导出名（evidence 写入方与既有测试继续可用），语义与冻结口径完全一致：
 *   - 只允许服务端从可信上下文派生 PlatformAccount（connection / case 主张链）；
 *   - 多上下文各自解析后必须一致（不得“连接优先即返回”）；
 *   - 无法唯一确定（缺失 / 歧义 / 跨账户）→ fail-closed（PLATFORM_ACCOUNT_REQUIRED）；
 *   - 不得退回 NULL 写新业务事实（legacy 历史行允许 NULL，新写入不允许）。
 */

import {
  AccountLineageError,
  PLATFORM_ACCOUNT_REQUIRED,
  resolveConsistentAccount,
  resolveFromCase,
  resolveFromConnection,
} from '../account-lineage/policy';

export { PLATFORM_ACCOUNT_REQUIRED };
/** 兼容别名：历史调用方/测试使用 PlatformAccountRequiredError。 */
export { AccountLineageError as PlatformAccountRequiredError };

export async function resolveAccountIdFromConnection(
  tx: Parameters<typeof resolveFromConnection>[0],
  input: { organizationId: string; connectionId: string | null },
): Promise<string> {
  return resolveFromConnection(tx, input);
}

export async function resolveAccountIdFromCase(
  tx: Parameters<typeof resolveFromCase>[0],
  input: { organizationId: string; caseId: string | null },
): Promise<string> {
  return resolveFromCase(tx, input);
}

/**
 * 统一入口：Evidence / downstream fact 写入方只需调用这一个函数。
 * 顺序无关——所有提供的可信上下文都分别解析，然后要求唯一一致。
 */
export async function resolveEvidenceAccountId(
  tx: Parameters<typeof resolveConsistentAccount>[0],
  input: { organizationId: string; connectionId?: string | null; caseId?: string | null },
): Promise<string> {
  return resolveConsistentAccount(tx, input);
}

export type { AccountLineageError };
