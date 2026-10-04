/**
 * C18-6 — PRISMA STORE：ProviderTenantBinding（current row + append-only lineage）
 * ---------------------------------------------------------------
 * 依据 MSG-20261004-29 的下一阶段要求：
 *   · **同事务**：current binding 的更新/创建与 lineage append 必须在**同一个 DB transaction** 内完成，
 *     任一步失败 → 两边一起回滚；
 *   · **并发 rebind 不丢 lineage**：先对 (organizationId, bindingId) 行加锁（SELECT ... FOR UPDATE），
 *     再做「读旧快照 → 写新 current → 追加 lineage」，避免 silent last-write-wins 的身份漂移；
 *   · 一切查询按租户过滤（organizationId 必传），跨租户不可读。
 *
 * 本模块只做持久化与事务编排，不做任何 provider 网络调用、不读凭据。
 */

import type { PrismaClient } from '@prisma/client';

import type {
  CustomsProviderTenantBinding,
  CustomsProviderTenantBindingQuery,
  CustomsProviderTenantBindingResolution,
} from './customs-provider-tenant-binding';
import {
  deniedProviderBindingResolution,
  isJurisdictionCovered,
  resolveCustomsProviderTenantBinding,
} from './customs-provider-tenant-binding';

export type CustomsProviderBindingLifecycleEvent = 'BOUND' | 'REBOUND' | 'SUSPENDED' | 'REVOKED' | 'RESTORED' | 'REAUTH_REQUIRED';

export interface ProviderTenantBindingRowInput {
  organizationId: string;
  principalRef: string;
  providerId: string;
  bindingScopeVersion: string;
  jurisdictionAnchor: string;
  bindingSlotRef: string;
  bindingScopeKey: string;
  providerTenantRef: string;
  providerAccountRef: string;
  relationship: string;
  relationshipEvidenceRef: string | null;
  relationshipVerifiedAt: Date | null;
  jurisdictionScope: readonly string[];
  status: string;
  verifiedAt: Date | null;
  credentialReference: string | null;
}

/** lineage 的安全 canonical 快照（不含任何 secret / 凭据本体）。 */
export interface ProviderBindingLineageSnapshot {
  providerTenantRef: string;
  providerAccountRef: string;
  principalRef: string;
  bindingScopeVersion: string;
  bindingScopeKey: string;
  bindingSlotRef: string;
  jurisdictionAnchor: string;
  relationship: string;
  relationshipEvidenceRef: string | null;
  relationshipVerifiedAt: string | null;
  jurisdictionScope: readonly string[];
  status: string;
  verifiedAt: string | null;
}

export interface ProviderTenantBindingStore {
  /** 只读解析（FAIL-CLOSED：0 条 → BINDING_UNKNOWN；>1 条 → BINDING_AMBIGUOUS）。 */
  resolve(query: CustomsProviderTenantBindingQuery): Promise<CustomsProviderTenantBindingResolution>;
  /**
   * 写入/更新 current binding **并**追加 lineage 事实，全部在同一事务内。
   * 返回写入后的 lineage id；任一步失败则整体回滚。
   */
  upsertWithLineage(input: {
    row: ProviderTenantBindingRowInput;
    event: CustomsProviderBindingLifecycleEvent;
    actorRef: string;
    note?: string | null;
    occurredAt: Date;
    sourceRef?: string | null;
    snapshotDigest: string;
  }): Promise<{ bindingId: string; lineageId: string }>;
}

const toDomain = (row: {
  organizationId: string;
  principalRef: string;
  bindingScopeVersion: string;
  bindingScopeKey: string;
  bindingSlotRef: string;
  providerId: string;
  providerTenantRef: string;
  providerAccountRef: string;
  relationship: string;
  relationshipEvidenceRef: string | null;
  relationshipVerifiedAt: Date | null;
  jurisdictionScope: string[];
  status: string;
  verifiedAt: Date | null;
  credentialReference: string | null;
  lineage: { event: string; occurredAt: Date; actorRef: string; note: string | null }[];
}): CustomsProviderTenantBinding => ({
  organizationId: row.organizationId,
  principalRef: row.principalRef,
  bindingScopeVersion: row.bindingScopeVersion as CustomsProviderTenantBinding['bindingScopeVersion'],
  bindingScopeKey: row.bindingScopeKey,
  bindingSlotRef: row.bindingSlotRef,
  providerId: row.providerId,
  providerTenantRef: row.providerTenantRef,
  providerAccountRef: row.providerAccountRef,
  relationship: row.relationship as CustomsProviderTenantBinding['relationship'],
  relationshipEvidenceRef: row.relationshipEvidenceRef,
  relationshipVerifiedAt: row.relationshipVerifiedAt === null ? null : row.relationshipVerifiedAt.toISOString(),
  jurisdictionScope: row.jurisdictionScope,
  status: row.status as CustomsProviderTenantBinding['status'],
  verifiedAt: row.verifiedAt === null ? null : row.verifiedAt.toISOString(),
  credentialReference: row.credentialReference,
  lineage: row.lineage.map((entry) => ({
    event: entry.event as CustomsProviderTenantBinding['lineage'][number]['event'],
    at: entry.occurredAt.toISOString(),
    actorRef: entry.actorRef,
    note: entry.note,
  })),
});

export function createPrismaProviderTenantBindingStore(prisma: PrismaClient): ProviderTenantBindingStore {
  return {
    async resolve(query) {
      const rows = await prisma.customsProviderTenantBinding.findMany({
        where: {
          organizationId: query.organizationId,
          providerId: query.providerId,
          principalRef: query.principalRef,
        },
        include: { lineage: { orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] } },
      });
      const applicable = rows.filter(
        (row) => row.status === 'ACTIVE' && isJurisdictionCovered(row.jurisdictionScope, query.jurisdiction),
      );
      if (applicable.length === 0) return deniedProviderBindingResolution('BINDING_UNKNOWN');
      if (applicable.length > 1) return deniedProviderBindingResolution('BINDING_AMBIGUOUS');
      return resolveCustomsProviderTenantBinding(toDomain(applicable[0]!), query);
    },

    async upsertWithLineage(input) {
      return prisma.$transaction(async (tx) => {
        // 行锁：同一 binding 的并发 rebind 串行化，避免 last-write-wins 丢 lineage。
        const locked = await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "CustomsProviderTenantBinding"
          WHERE "organizationId" = ${input.row.organizationId}
            AND "providerId" = ${input.row.providerId}
            AND "bindingScopeKey" = ${input.row.bindingScopeKey}
          FOR UPDATE
        `;

        const snapshot: ProviderBindingLineageSnapshot = {
          providerTenantRef: input.row.providerTenantRef,
          providerAccountRef: input.row.providerAccountRef,
          principalRef: input.row.principalRef,
          bindingScopeVersion: input.row.bindingScopeVersion,
          bindingScopeKey: input.row.bindingScopeKey,
          bindingSlotRef: input.row.bindingSlotRef,
          jurisdictionAnchor: input.row.jurisdictionAnchor,
          relationship: input.row.relationship,
          relationshipEvidenceRef: input.row.relationshipEvidenceRef,
          relationshipVerifiedAt: input.row.relationshipVerifiedAt?.toISOString() ?? null,
          jurisdictionScope: [...input.row.jurisdictionScope],
          status: input.row.status,
          verifiedAt: input.row.verifiedAt?.toISOString() ?? null,
        };

        const binding = await tx.customsProviderTenantBinding.upsert({
          where: {
            organizationId_providerId_bindingScopeKey: {
              organizationId: input.row.organizationId,
              providerId: input.row.providerId,
              bindingScopeKey: input.row.bindingScopeKey,
            },
          },
          create: {
            organizationId: input.row.organizationId,
            principalRef: input.row.principalRef,
            bindingScopeVersion: input.row.bindingScopeVersion,
            jurisdictionAnchor: input.row.jurisdictionAnchor,
            bindingSlotRef: input.row.bindingSlotRef,
            bindingScopeKey: input.row.bindingScopeKey,
            providerId: input.row.providerId,
            providerTenantRef: input.row.providerTenantRef,
            providerAccountRef: input.row.providerAccountRef,
            relationship: input.row.relationship as never,
            relationshipEvidenceRef: input.row.relationshipEvidenceRef,
            relationshipVerifiedAt: input.row.relationshipVerifiedAt,
            jurisdictionScope: [...input.row.jurisdictionScope],
            status: input.row.status as never,
            verifiedAt: input.row.verifiedAt,
            credentialReference: input.row.credentialReference,
          },
          update: {
            providerTenantRef: input.row.providerTenantRef,
            providerAccountRef: input.row.providerAccountRef,
            relationship: input.row.relationship as never,
            relationshipEvidenceRef: input.row.relationshipEvidenceRef,
            relationshipVerifiedAt: input.row.relationshipVerifiedAt,
            jurisdictionScope: [...input.row.jurisdictionScope],
            status: input.row.status as never,
            verifiedAt: input.row.verifiedAt,
            credentialReference: input.row.credentialReference,
          },
        });

        const lineage = await tx.customsProviderTenantBindingLineage.create({
          data: {
            organizationId: input.row.organizationId,
            bindingId: binding.id,
            event: input.event as never,
            actorRef: input.actorRef,
            note: input.note ?? null,
            snapshot: snapshot as never,
            snapshotDigest: input.snapshotDigest,
            occurredAt: input.occurredAt,
            sourceRef: input.sourceRef ?? null,
          },
        });

        void locked;
        return { bindingId: binding.id, lineageId: lineage.id };
      });
    },
  };
}
