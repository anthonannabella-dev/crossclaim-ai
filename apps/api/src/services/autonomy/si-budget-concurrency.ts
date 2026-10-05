/**
 * SI-COST-OPTIMIZATION C3 —— concurrencyLimit enforcement（多进程 / 多实例语义）
 * ---------------------------------------------------------------
 * 硬约束（MSG-20261005-37 NEXT #4）：
 *   - 必须支持多进程 / 多实例：**不接受**仅本机内存 counter 作为最终 enforcement；
 *   - 复用现有 PostgreSQL advisory lock 机制（不新增 usage / lease 事实表）；
 *   - 真实 PG concurrency regression（两客户端并发 → 恰好允许 limit 个）。
 *
 * 语义：
 *   对「当前调用涉及且配置了 concurrencyLimit 的每一层 scope」各占用 1 个 slot
 *   （platform:* → org:<id> → account:<id> → incident:<id> → task:<id>，固定顺序防死锁）；
 *   任一层无空闲 slot → 整体拒绝（AI_BUDGET_CONCURRENCY_EXCEEDED），不触碰 provider / ledger。
 *   槽位锁为 **事务级 advisory lock**：调用结束（提交 / 回滚 / 连接断开）即自动释放。
 *   因此它是「跨实例互斥」的，而不是进程内计数。
 */

import type { Prisma, PrismaClient } from '@prisma/client';

import type { AiBudgetScopeName } from './si-budget-policy-store';

type Db = PrismaClient | Prisma.TransactionClient;

export interface AiBudgetRefs {
  organizationId?: string | null;
  accountId?: string | null;
  incidentId?: string | null;
  taskId?: string | null;
}

export interface AiConcurrencyScope {
  scope: AiBudgetScopeName;
  scopeRef: string;
  concurrencyLimit: number;
}

export const AI_CONCURRENCY_BOUNDARY = {
  mechanism: 'POSTGRESQL_ADVISORY_XACT_LOCK_SLOTS（跨实例互斥）',
  inProcessCounterOnly: 'FORBIDDEN',
  newTruthTable: 'FORBIDDEN（不新增 usage / lease 表；仅 advisory lock）',
  lockOrder: ['platform:*', 'org:<id>', 'account:<id>', 'incident:<id>', 'task:<id>'],
  callerProvidedLockKey: 'FORBIDDEN',
  onExhaustion: 'AI_BUDGET_CONCURRENCY_EXCEEDED（不触达 provider / 不写 ledger / 无重试风暴）',
  level0RuleAffected: false,
} as const;

const slotKey = (scope: AiBudgetScopeName, scopeRef: string, slot: number): string =>
  'ai-concurrency:' + scope + ':' + scopeRef + ':slot:' + slot;

/**
 * 列出当前 refs 下**已配置 concurrencyLimit** 的 scope（tenant-safe；只读）。
 * 与 `resolveEffectiveAiBudget` / guarded write 使用同一 tenant 绑定规则。
 */
export async function listAiBudgetConcurrencyScopes(db: Db, refs: AiBudgetRefs): Promise<AiConcurrencyScope[]> {
  if ((refs.accountId || refs.incidentId || refs.taskId) && !refs.organizationId) {
    throw new Error('AI_BUDGET_TENANT_IDENTITY_REQUIRED');
  }
  const keys: Array<{ scope: AiBudgetScopeName; scopeRef: string; organizationId: string }> = [
    { scope: 'PLATFORM', scopeRef: '*', organizationId: '' },
  ];
  if (refs.organizationId) {
    keys.push({ scope: 'ORGANIZATION', scopeRef: refs.organizationId, organizationId: refs.organizationId });
  }
  if (refs.organizationId && refs.accountId) {
    keys.push({ scope: 'ACCOUNT', scopeRef: refs.accountId, organizationId: refs.organizationId });
  }
  if (refs.organizationId && refs.incidentId) {
    keys.push({ scope: 'INCIDENT', scopeRef: refs.incidentId, organizationId: refs.organizationId });
  }
  if (refs.organizationId && refs.taskId) {
    keys.push({ scope: 'TASK', scopeRef: refs.taskId, organizationId: refs.organizationId });
  }
  const rows = await db.aiBudgetPolicy.findMany({
    where: { OR: keys as never },
    select: { scope: true, scopeRef: true, organizationId: true, concurrencyLimit: true },
  });
  const order: Record<string, number> = { PLATFORM: 0, ORGANIZATION: 1, ACCOUNT: 2, INCIDENT: 3, TASK: 4 };
  return rows
    .filter((row) => typeof row.concurrencyLimit === 'number' && Number.isInteger(row.concurrencyLimit) && row.concurrencyLimit > 0)
    .filter((row) => row.scope === 'PLATFORM' || row.organizationId === refs.organizationId)
    .map((row) => ({ scope: row.scope as AiBudgetScopeName, scopeRef: row.scopeRef, concurrencyLimit: row.concurrencyLimit as number }))
    .sort((a, b) => (order[a.scope] ?? 9) - (order[b.scope] ?? 9));
}

export type AiConcurrencyGateResult<T> =
  | { ok: true; value: T; heldKeys: readonly string[] }
  | { ok: false; reason: 'AI_BUDGET_CONCURRENCY_EXCEEDED'; blockingKey: string | null; heldKeys: readonly string[] };

/**
 * 在「所有受影响层级各占 1 个 slot」的前提下执行 `run`。
 * 未配置任何 concurrencyLimit → 直接执行（不开启事务，零额外开销）。
 * 任一层占不到 slot → 事务回滚（已占 slot 一并释放）并返回 rejected。
 */
export async function withAiBudgetConcurrencySlots<T>(input: {
  prisma: PrismaClient;
  refs: AiBudgetRefs;
  run: () => Promise<T>;
  /** 事务超时（覆盖 run 的墙钟时间）；默认 60s */
  holdTimeoutMs?: number;
}): Promise<AiConcurrencyGateResult<T>> {
  const scopes = await listAiBudgetConcurrencyScopes(input.prisma, input.refs);
  if (scopes.length === 0) {
    return { ok: true, value: await input.run(), heldKeys: [] };
  }
  const holdTimeoutMs = input.holdTimeoutMs ?? 60_000;
  return input.prisma.$transaction(
    async (tx) => {
      const heldKeys: string[] = [];
      for (const scope of scopes) {
        let acquired = false;
        for (let slot = 0; slot < scope.concurrencyLimit; slot += 1) {
          const key = slotKey(scope.scope, scope.scopeRef, slot);
          const rows = await tx.$queryRawUnsafe<{ locked: boolean }[]>(
            'SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked',
            key,
          );
          if (rows[0]?.locked === true) {
            heldKeys.push(key);
            acquired = true;
            break;
          }
        }
        if (!acquired) {
          // 抛错 → 事务回滚 → 已占 slot 自动释放（不留下半占用状态）
          throw new Error('AI_BUDGET_CONCURRENCY_EXCEEDED:' + scope.scope + ':' + scope.scopeRef);
        }
      }
      const value = await input.run();
      return { ok: true as const, value, heldKeys: heldKeys as readonly string[] };
    },
    { timeout: holdTimeoutMs, maxWait: 30_000 },
  ).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const match = /AI_BUDGET_CONCURRENCY_EXCEEDED(?::([^:]+):(.*))?/.exec(message);
    if (!match) throw error;
    return {
      ok: false as const,
      reason: 'AI_BUDGET_CONCURRENCY_EXCEEDED' as const,
      blockingKey: match[1] ? match[1] + ':' + match[2] : null,
      heldKeys: [] as readonly string[],
    };
  });
}
