// PROVIDER FOLLOW-UP INTELLIGENCE / P3 —— 事实层落库（append-only）+ projection 推进
// 原则：原始 provider 事实只追加不修改；projection 仅由事实派生（幂等：无新事实则不推进 generation）。

import type { Prisma, PrismaClient } from '@prisma/client';

import {
  decideProviderFactAppend,
  projectProviderCase,
  toProviderCaseFactRecord,
  toProviderContactFactRecord,
  type ProviderCaseFactInput,
  type ProviderCaseFactRecord,
  type ProviderCaseProjectionView,
  type ProviderContactFactInput,
  type ProviderContactFactRecord,
} from './case-facts';
import type { ProviderCase, ProviderContact, ProviderReadScope } from './provider-case';
import { ProviderSupportError } from './provider-case';

type Tx = Prisma.TransactionClient;

export interface RecordProviderCaseSnapshotInput {
  scope: ProviderReadScope;
  caseItem: ProviderCase;
  contacts: readonly ProviderContact[];
  now: Date;
}

export interface RecordProviderCaseSnapshotResult {
  caseFact: { kind: 'APPENDED' | 'REUSED'; factDigest: string };
  contactFacts: Array<{ contactId: string; factDigest: string; kind: 'APPENDED' | 'REUSED' }>;
  projection: ProviderCaseProjectionView;
  projectionAdvanced: boolean;
}

function assertScopeMatchesCase(scope: ProviderReadScope, caseItem: ProviderCase): void {
  if (
    scope.organizationId !== caseItem.ref.organizationId ||
    scope.platformAccountId !== caseItem.ref.platformAccountId
  ) {
    throw new ProviderSupportError(
      'PROVIDER_SUPPORT_SCOPE_REQUIRED',
      '事实写入的归属必须与读取范围一致（禁止跨 tenant / 跨 platform account 混写）',
    );
  }
}

async function upsertProjectionFromFacts(
  tx: Tx,
  scope: ProviderReadScope,
  providerCaseId: string,
  now: Date,
  advanced: boolean,
): Promise<{ projection: ProviderCaseProjectionView; projectionAdvanced: boolean }> {
  const existing = await tx.providerCaseProjection.findUnique({
    where: {
      organizationId_platformAccountId_providerCaseId: {
        organizationId: scope.organizationId,
        platformAccountId: scope.platformAccountId,
        providerCaseId,
      },
    },
  });
  if (!advanced && existing) {
    return { projection: rowToProjection(existing), projectionAdvanced: false };
  }

  const caseFacts = await tx.providerCaseFact.findMany({
    where: {
      organizationId: scope.organizationId,
      platformAccountId: scope.platformAccountId,
      providerCaseId,
    },
    orderBy: [{ recordedAt: 'asc' }],
  });
  if (caseFacts.length === 0) {
    throw new ProviderSupportError('PROVIDER_SUPPORT_MALFORMED_PAYLOAD', '缺少 case 事实，无法派生 projection');
  }
  const latest = caseFacts[caseFacts.length - 1];
  const contactRows = await tx.providerContactFact.findMany({
    where: {
      organizationId: scope.organizationId,
      platformAccountId: scope.platformAccountId,
      providerCaseId,
    },
    orderBy: [{ occurredAt: 'asc' }],
  });

  const caseFactInput: ProviderCaseFactInput = {
    organizationId: latest.organizationId,
    platformAccountId: latest.platformAccountId,
    providerCaseId: latest.providerCaseId,
    factDigest: latest.factDigest,
    status: latest.status as ProviderCaseFactInput['status'],
    subject: latest.subject ?? null,
    lastContactAt: latest.lastContactAt ? latest.lastContactAt.toISOString() : null,
    attachmentCount: latest.attachmentCount,
    contactKinds: latest.contactKinds ? latest.contactKinds.split(',').filter(Boolean) : [],
    fetchedAt: latest.fetchedAt.toISOString(),
  };
  const contactFactInputs: ProviderContactFactInput[] = contactRows.map((row) => ({
    organizationId: row.organizationId,
    platformAccountId: row.platformAccountId,
    providerCaseId: row.providerCaseId,
    contactId: row.contactId,
    factDigest: row.factDigest,
    kind: row.kind as ProviderContactFactInput['kind'],
    direction: row.direction as ProviderContactFactInput['direction'],
    occurredAt: row.occurredAt.toISOString(),
    attachmentCount: row.attachmentCount,
  }));

  const projected = projectProviderCase({
    previous: existing ? rowToProjection(existing) : null,
    caseFact: caseFactInput,
    contactFacts: contactFactInputs,
    now,
  });

  const saved = await tx.providerCaseProjection.upsert({
    where: {
      organizationId_platformAccountId_providerCaseId: {
        organizationId: projected.organizationId,
        platformAccountId: projected.platformAccountId,
        providerCaseId: projected.providerCaseId,
      },
    },
    create: {
      organizationId: projected.organizationId,
      platformAccountId: projected.platformAccountId,
      platform: projected.platform,
      providerCaseId: projected.providerCaseId,
      status: projected.status,
      subject: projected.subject,
      lastContactAt: projected.lastContactAt ? new Date(projected.lastContactAt) : null,
      contactCount: projected.contactCount,
      attachmentCount: projected.attachmentCount,
      contactKinds: projected.contactKinds,
      generation: projected.generation,
      lastFactDigest: projected.lastFactDigest,
      firstFactAt: new Date(projected.firstFactAt),
      lastFactAt: new Date(projected.lastFactAt),
      updatedAt: now,
    },
    update: {
      status: projected.status,
      subject: projected.subject,
      lastContactAt: projected.lastContactAt ? new Date(projected.lastContactAt) : null,
      contactCount: projected.contactCount,
      attachmentCount: projected.attachmentCount,
      contactKinds: projected.contactKinds,
      generation: projected.generation,
      lastFactDigest: projected.lastFactDigest,
      lastFactAt: new Date(projected.lastFactAt),
      updatedAt: now,
    },
  });
  return { projection: rowToProjection(saved), projectionAdvanced: true };
}

type ProjectionRow = {
  organizationId: string;
  platformAccountId: string;
  platform: string;
  providerCaseId: string;
  status: string;
  subject: string | null;
  lastContactAt: Date | null;
  contactCount: number;
  attachmentCount: number;
  contactKinds: string;
  generation: number;
  lastFactDigest: string;
  firstFactAt: Date;
  lastFactAt: Date;
};

export function rowToProjection(row: ProjectionRow): ProviderCaseProjectionView {
  return {
    organizationId: row.organizationId,
    platformAccountId: row.platformAccountId,
    platform: row.platform,
    providerCaseId: row.providerCaseId,
    status: row.status as ProviderCaseProjectionView['status'],
    subject: row.subject,
    lastContactAt: row.lastContactAt ? row.lastContactAt.toISOString() : null,
    contactCount: row.contactCount,
    attachmentCount: row.attachmentCount,
    contactKinds: row.contactKinds,
    generation: row.generation,
    lastFactDigest: row.lastFactDigest,
    firstFactAt: row.firstFactAt.toISOString(),
    lastFactAt: row.lastFactAt.toISOString(),
  };
}

/** 写入一次读取快照：case 事实 + contact 事实（幂等），并推进 projection。 */
export async function recordProviderCaseSnapshot(
  prisma: PrismaClient,
  input: RecordProviderCaseSnapshotInput,
): Promise<RecordProviderCaseSnapshotResult> {
  const { scope, caseItem, contacts, now } = input;
  assertScopeMatchesCase(scope, caseItem);
  const caseRecord: ProviderCaseFactRecord = toProviderCaseFactRecord(caseItem);
  const contactRecords: ProviderContactFactRecord[] = contacts.map((c) => {
    if (c.providerCaseId !== caseItem.ref.providerCaseId) {
      throw new ProviderSupportError(
        'PROVIDER_SUPPORT_SCOPE_REQUIRED',
        'contact 与 case 身份不一致（禁止把其它 case 的沟通记录写入本 case）',
      );
    }
    return toProviderContactFactRecord(c, scope);
  });

  return prisma.$transaction(async (tx) => {
    let advanced = false;

    const existingCaseDigests = (
      await tx.providerCaseFact.findMany({
        where: {
          organizationId: caseRecord.organizationId,
          platformAccountId: caseRecord.platformAccountId,
          providerCaseId: caseRecord.providerCaseId,
        },
        select: { factDigest: true },
      })
    ).map((r) => r.factDigest);
    const caseDecision = decideProviderFactAppend(existingCaseDigests, caseRecord.factDigest);
    if (caseDecision.kind === 'APPEND') {
      await tx.providerCaseFact.create({
        data: {
          organizationId: caseRecord.organizationId,
          platformAccountId: caseRecord.platformAccountId,
          platform: caseRecord.platform,
          providerCaseId: caseRecord.providerCaseId,
          factDigest: caseRecord.factDigest,
          status: caseRecord.status,
          subject: caseRecord.subject,
          providerCreatedAt: caseRecord.providerCreatedAt ? new Date(caseRecord.providerCreatedAt) : null,
          providerUpdatedAt: caseRecord.providerUpdatedAt ? new Date(caseRecord.providerUpdatedAt) : null,
          lastContactAt: caseRecord.lastContactAt ? new Date(caseRecord.lastContactAt) : null,
          contactKinds: caseRecord.contactKinds,
          attachmentCount: caseRecord.attachmentCount,
          adapterId: caseRecord.adapterId,
          adapterVersion: caseRecord.adapterVersion,
          credentialRef: caseRecord.credentialRef,
          connectionRef: caseRecord.connectionRef,
          fetchedAt: new Date(caseRecord.fetchedAt),
          snapshot: caseRecord.snapshot,
          recordedAt: now,
        },
      });
      advanced = true;
    }

    const contactResults: RecordProviderCaseSnapshotResult['contactFacts'] = [];
    for (const record of contactRecords) {
      const existing = (
        await tx.providerContactFact.findMany({
          where: {
            organizationId: record.organizationId,
            platformAccountId: record.platformAccountId,
            providerCaseId: record.providerCaseId,
            contactId: record.contactId,
          },
          select: { factDigest: true },
        })
      ).map((r) => r.factDigest);
      const decision = decideProviderFactAppend(existing, record.factDigest);
      if (decision.kind === 'APPEND') {
        await tx.providerContactFact.create({
          data: {
            organizationId: record.organizationId,
            platformAccountId: record.platformAccountId,
            platform: record.platform,
            providerCaseId: record.providerCaseId,
            contactId: record.contactId,
            factDigest: record.factDigest,
            kind: record.kind,
            direction: record.direction,
            occurredAt: new Date(record.occurredAt),
            bodyText: record.bodyText,
            bodyDigest: record.bodyDigest,
            attachments: record.attachments,
            attachmentCount: record.attachmentCount,
            adapterId: record.adapterId,
            adapterVersion: record.adapterVersion,
            credentialRef: record.credentialRef,
            connectionRef: record.connectionRef,
            fetchedAt: new Date(record.fetchedAt),
            recordedAt: now,
          },
        });
        advanced = true;
      }
      contactResults.push({
        contactId: record.contactId,
        factDigest: record.factDigest,
        kind: decision.kind === 'APPEND' ? 'APPENDED' : 'REUSED',
      });
    }

    const { projection, projectionAdvanced } = await upsertProjectionFromFacts(
      tx,
      scope,
      caseItem.ref.providerCaseId,
      now,
      advanced,
    );

    return {
      caseFact: {
        kind: caseDecision.kind === 'APPEND' ? ('APPENDED' as const) : ('REUSED' as const),
        factDigest: caseRecord.factDigest,
      },
      contactFacts: contactResults,
      projection,
      projectionAdvanced,
    };
  });
}

export async function readProviderCaseProjection(
  prisma: PrismaClient,
  scope: Pick<ProviderReadScope, 'organizationId' | 'platformAccountId'> & { providerCaseId: string },
): Promise<ProviderCaseProjectionView | null> {
  const row = await prisma.providerCaseProjection.findUnique({
    where: {
      organizationId_platformAccountId_providerCaseId: {
        organizationId: scope.organizationId,
        platformAccountId: scope.platformAccountId,
        providerCaseId: scope.providerCaseId,
      },
    },
  });
  return row ? rowToProjection(row as ProjectionRow) : null;
}

export async function listProviderCaseFacts(
  prisma: PrismaClient,
  scope: Pick<ProviderReadScope, 'organizationId' | 'platformAccountId'> & { providerCaseId: string },
): Promise<Array<{ id: string; factDigest: string; status: string; recordedAt: string }>> {
  const rows = await prisma.providerCaseFact.findMany({
    where: {
      organizationId: scope.organizationId,
      platformAccountId: scope.platformAccountId,
      providerCaseId: scope.providerCaseId,
    },
    orderBy: { recordedAt: 'asc' },
    select: { id: true, factDigest: true, status: true, recordedAt: true },
  });
  return rows.map((r) => ({
    id: r.id,
    factDigest: r.factDigest,
    status: r.status,
    recordedAt: r.recordedAt.toISOString(),
  }));
}

export async function listProviderContactFacts(
  prisma: PrismaClient,
  scope: Pick<ProviderReadScope, 'organizationId' | 'platformAccountId'> & { providerCaseId: string },
): Promise<Array<{ id: string; contactId: string; factDigest: string; kind: string; occurredAt: string }>> {
  const rows = await prisma.providerContactFact.findMany({
    where: {
      organizationId: scope.organizationId,
      platformAccountId: scope.platformAccountId,
      providerCaseId: scope.providerCaseId,
    },
    orderBy: { occurredAt: 'asc' },
    select: { id: true, contactId: true, factDigest: true, kind: true, occurredAt: true },
  });
  return rows.map((r) => ({
    id: r.id,
    contactId: r.contactId,
    factDigest: r.factDigest,
    kind: r.kind,
    occurredAt: r.occurredAt.toISOString(),
  }));
}
