/**
 * C-0013-B — 连接器编排器（pull → normalize → createClaimItem）
 * ---------------------------------------------------------------
 * 架构方裁定（MSG-20260928-136 / -138）：
 *   · 编排器**不调用规则引擎**（金额判断永远归 Rule Engine）
 *   · Fetcher 不产生 ClaimItem；只有 Normalizer 的输出才能落库
 *   · 一律经 `createClaimItem`（`creationContext: 'CONNECTOR_IMPORT'`），保证幂等与审计
 *   · cursor「一页一推进」：整页处理完（含 quarantine 落盘）才写新游标；中途抛错不推进
 */

import { Prisma, type PrismaClient } from '@prisma/client';

import { prepareAuditInsert } from '../audit';
import { CLAIM_PLATFORM_TYPES, createClaimItem, type ClaimPlatformType } from '../claim/claim-items';
import { FINGERPRINT_VERSION } from '../claim/source-fingerprint';
import { WorkflowError } from '../workflow/opportunity-review';
import { assertPermission } from '../workflow/permissions';
import type { CursorStore } from './cursor-store';
import { inputFingerprintOf, type QuarantineSink } from './quarantine';
import { assertReadonlyConnector, type ConnectorDescriptor, type Fetcher, type Normalizer } from './types';

export const CONNECTOR_AUDIT = {
  pullStarted: 'connector.pull_started',
  pullFinished: 'connector.pull_finished',
  versionChanged: 'connector.normalizer_version_changed',
} as const;

const DEFAULT_LIMIT = 200;

export interface RunConnectorPullInput {
  organizationId: string;
  actorUserId: string;
  role: string;
  connector: ConnectorDescriptor;
  /** SourceConnection 引用（游标键的一部分） */
  connectionRef: string;
  resource: string;
  fetcher: Fetcher;
  normalizer: Normalizer;
  limit?: number;
}

export interface RunConnectorPullResult {
  connectorId: string;
  resource: string;
  fetched: number;
  created: number;
  idempotent: number;
  quarantined: number;
  cursor: string | null;
  exhausted: boolean;
  normalizerVersion: string;
  durationMs: number;
}

export interface RunConnectorPullDeps {
  cursorStore: CursorStore;
  quarantine: QuarantineSink;
  now?: () => Date;
}

async function writeConnectorAudit(
  prisma: PrismaClient,
  input: {
    organizationId: string;
    actorUserId: string;
    action: string;
    connectorId: string;
    changes: Record<string, unknown>;
    at: Date;
  },
): Promise<void> {
  const row = prepareAuditInsert(
    {
      organizationId: input.organizationId,
      actorType: 'USER',
      actorUserId: input.actorUserId,
      action: input.action,
      entityType: 'Connector',
      entityId: input.connectorId,
      changes: input.changes,
    },
    { maxStringLength: 512 },
  );
  await prisma.auditLog.create({
    data: {
      organizationId: row.organizationId,
      actorType: row.actorType,
      actorUserId: row.actorUserId,
      actorRef: row.actorRef,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      changes: (row.changes ?? undefined) as Prisma.InputJsonValue | undefined,
      ip: row.ip,
      userAgent: row.userAgent,
      createdAt: input.at,
    },
  });
}

export async function runConnectorPull(
  prisma: PrismaClient,
  input: RunConnectorPullInput,
  deps: RunConnectorPullDeps,
): Promise<RunConnectorPullResult> {
  assertPermission(input.role, 'manageClaimItems');
  assertReadonlyConnector(input.connector);
  const now = deps.now ?? (() => new Date());
  const startedAt = now();
  const key = { connectionRef: input.connectionRef, resource: input.resource };

  // 归一化器版本变化：与最近一次 pull_finished 审计比较（不新增存储）
  const lastFinished = await prisma.auditLog.findFirst({
    where: {
      organizationId: input.organizationId,
      action: CONNECTOR_AUDIT.pullFinished,
      entityId: input.connector.connectorId,
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { changes: true },
  });
  const lastVersion =
    lastFinished && lastFinished.changes && typeof lastFinished.changes === 'object'
      ? ((lastFinished.changes as Record<string, unknown>).normalizerVersion as string | undefined)
      : undefined;
  if (lastVersion && lastVersion !== input.normalizer.normalizerVersion) {
    await writeConnectorAudit(prisma, {
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: CONNECTOR_AUDIT.versionChanged,
      connectorId: input.connector.connectorId,
      changes: { from: lastVersion, to: input.normalizer.normalizerVersion, resource: input.resource },
      at: startedAt,
    });
  }

  const cursor = await deps.cursorStore.read(key);
  await writeConnectorAudit(prisma, {
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    action: CONNECTOR_AUDIT.pullStarted,
    connectorId: input.connector.connectorId,
    changes: {
      connectorId: input.connector.connectorId,
      platformType: input.connector.platformType,
      resource: input.resource,
      connectionRef: input.connectionRef,
      normalizerVersion: input.normalizer.normalizerVersion,
      cursorPresent: cursor !== null,
    },
    at: startedAt,
  });

  const page = await input.fetcher.pull({
    resource: input.resource,
    cursor,
    limit: input.limit ?? DEFAULT_LIMIT,
  });

  let created = 0;
  let idempotent = 0;
  let quarantined = 0;

  for (const record of page.records) {
    const normalized = input.normalizer.normalize(record);
    if (!normalized.ok) {
      await deps.quarantine.write({
        connectorId: input.connector.connectorId,
        platformType: input.connector.platformType,
        normalizerVersion: input.normalizer.normalizerVersion,
        reasonCode: normalized.reasonCode,
        inputFingerprint: inputFingerprintOf(input.connector.connectorId, record.resourceRef),
        occurredAt: startedAt.toISOString(),
      });
      quarantined += 1;
      continue;
    }

    const output = normalized.output;
    if (!(CLAIM_PLATFORM_TYPES as readonly string[]).includes(output.platformType)) {
      await deps.quarantine.write({
        connectorId: input.connector.connectorId,
        platformType: input.connector.platformType,
        normalizerVersion: input.normalizer.normalizerVersion,
        reasonCode: 'UNKNOWN_SHAPE',
        inputFingerprint: inputFingerprintOf(input.connector.connectorId, record.resourceRef),
        occurredAt: startedAt.toISOString(),
      });
      quarantined += 1;
      continue;
    }

    try {
      const outcome = await createClaimItem(
        prisma,
        {
          organizationId: input.organizationId,
          actorUserId: input.actorUserId,
          role: input.role,
          platformType: output.platformType as ClaimPlatformType,
          claimType: output.claimType,
          occurredAt: output.occurredAt,
          amountExpected: output.amountExpected ?? null,
          amountActual: output.amountActual ?? null,
          currency: output.currency,
          responsibleParty: output.responsibleParty as never,
          normalizerVersion: output.normalizerVersion,
          normalizedRef: output.normalizedRef,
          sourceFingerprint: output.sourceFingerprintCandidate,
          fingerprintVersion: FINGERPRINT_VERSION,
          creationContext: 'CONNECTOR_IMPORT',
          trustedConnectionId: input.connectionRef,
        },
        { now },
      );
      if (outcome.created) created += 1;
      else idempotent += 1;
    } catch (error) {
      if (error instanceof WorkflowError && error.code === 'SOURCE_IDENTITY_REQUIRED') {
        await deps.quarantine.write({
          connectorId: input.connector.connectorId,
          platformType: input.connector.platformType,
          normalizerVersion: input.normalizer.normalizerVersion,
          reasonCode: 'IDENTITY_UNAVAILABLE',
          inputFingerprint: inputFingerprintOf(input.connector.connectorId, record.resourceRef),
          occurredAt: startedAt.toISOString(),
        });
        quarantined += 1;
        continue;
      }
      throw error;
    }
  }

  // 整页处理完才推进游标（中途抛错时不推进 → 下次重放，靠 ClaimItem 幂等兜底）
  let nextCursor: string | null = cursor;
  if (page.nextCursor !== null) {
    await deps.cursorStore.write(key, page.nextCursor, now);
    nextCursor = page.nextCursor;
  }

  const finishedAt = now();
  const result: RunConnectorPullResult = {
    connectorId: input.connector.connectorId,
    resource: input.resource,
    fetched: page.records.length,
    created,
    idempotent,
    quarantined,
    cursor: nextCursor,
    exhausted: page.nextCursor === null,
    normalizerVersion: input.normalizer.normalizerVersion,
    durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
  };

  await writeConnectorAudit(prisma, {
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    action: CONNECTOR_AUDIT.pullFinished,
    connectorId: input.connector.connectorId,
    changes: {
      connectorId: input.connector.connectorId,
      platformType: input.connector.platformType,
      resource: input.resource,
      normalizerVersion: input.normalizer.normalizerVersion,
      fetched: result.fetched,
      created: result.created,
      idempotent: result.idempotent,
      quarantined: result.quarantined,
      exhausted: result.exhausted,
      durationMs: result.durationMs,
    },
    at: finishedAt,
  });

  return result;
}
