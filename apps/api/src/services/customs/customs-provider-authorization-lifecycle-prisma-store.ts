/**
 * C18-7 持久化 — PROVIDER AUTHORIZATION LIFECYCLE STORE（Prisma）
 * ---------------------------------------------------------------
 * 依据 MSG-20261004-29 的下一阶段要求把「授权生命周期」从纯函数变成可持久化事实：
 *   · 只消费 **server-derived** 的 provider 授权事件（验签 webhook / 轮询），不接受调用方自报状态；
 *   · 折叠在 DB 事务内完成，写入 current binding 的 status 与 append-only lineage 事实**同一事务**，
 *     任一步失败 → 两边一起回滚（不留半截状态）；
 *   · 幂等：同一 (bindingId, event, sourceRef) 只落一条 lineage；重放返回 REPLAYED，不重复追加；
 *   · 并发：先对 binding 行加锁（SELECT ... FOR UPDATE），两个独立连接同时应用同一观察时，
 *     只有一个真正追加 lineage，另一个读到已存在事实后返回 REPLAYED（不 last-write-wins）；
 *   · fail-closed：无 binding → BINDING_UNKNOWN；折叠结果为 UNKNOWN（无有效事件 / 全部未来生效）
 *     → AUTHORIZATION_UNKNOWN；同一 effectiveAt 出现互相矛盾事件 → AUTHORIZATION_CONFLICT；三者都不写库。
 *
 * 状态映射（数据库列是「提交闸门」，精确的 provider 状态保存在 append-only snapshot 里）：
 *   ACTIVE            → binding ACTIVE            + lineage RESTORED（仅当此前不是 ACTIVE）
 *   REAUTH_REQUIRED   → binding PENDING_VERIFICATION + lineage REAUTH_REQUIRED
 *   SUSPENDED         → binding SUSPENDED          + lineage SUSPENDED
 *   REVOKED           → binding REVOKED            + lineage REVOKED
 *   EXPIRED           → binding REVOKED            + lineage REVOKED，snapshot.providerStatus = EXPIRED
 *     （`CustomsProviderBindingStatus` 没有 EXPIRED 取值；撤销与过期都是"不可提交"，而精确原因留在快照里；
 *      过期后必须由 effectiveAt 严格更晚的授权事件才能恢复 ACTIVE，由折叠函数保证。）
 *
 * 本模块不做任何 provider 网络调用、不读凭据、不产生外部写。
 */

import { createHash } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import { computeProviderBindingScopeKey } from './customs-provider-tenant-binding';
import {
  deriveProviderAuthorizationState,
  validateProviderAuthorizationEvent,
  type DerivedProviderAuthorizationState,
  type ProviderAuthorizationEvent,
  type ProviderAuthorizationStatus,
} from './customs-provider-authorization-lifecycle';

export type ProviderAuthorizationBindingStatus = 'ACTIVE' | 'PENDING_VERIFICATION' | 'SUSPENDED' | 'REVOKED';

export type ProviderAuthorizationLineageEvent =
  | 'RESTORED'
  | 'REAUTH_REQUIRED'
  | 'SUSPENDED'
  | 'REVOKED';

export interface ProviderAuthorizationObservationInput {
  organizationId: string;
  providerId: string;
  principalRef: string;
  jurisdictionAnchor: string;
  bindingSlotRef: string;
  /** provider 侧已核验事件（server-derived）。 */
  events: readonly ProviderAuthorizationEvent[];
  now: Date;
}

export interface ProviderAuthorizationObservationSnapshot {
  providerStatus: ProviderAuthorizationStatus;
  expiresAt: string | null;
  lastEffectiveAt: string | null;
  lastObservedAt: string | null;
  appliedEventCount: number;
  conflict: boolean;
  /** 触发本次写入（或重放）的事件证据引用。 */
  sourceRef: string;
  /** 只记录判定结果，不含任何凭据本体。 */
  credentialReferenceRecorded: false;
}

export type ProviderAuthorizationApplyOutcome = 'APPLIED' | 'REPLAYED' | 'UNCHANGED';

export type ProviderAuthorizationObservationResult =
  | {
      ok: false;
      reasonCode: 'BINDING_UNKNOWN' | 'AUTHORIZATION_UNKNOWN' | 'AUTHORIZATION_CONFLICT';
      externalWritePerformed: false;
      transportEnabled: false;
      productionCredentials: 'ABSENT';
    }
  | {
      ok: true;
      outcome: ProviderAuthorizationApplyOutcome;
      bindingId: string;
      bindingStatus: ProviderAuthorizationBindingStatus;
      lineageId: string | null;
      derived: DerivedProviderAuthorizationState;
      externalWritePerformed: false;
      transportEnabled: false;
      productionCredentials: 'ABSENT';
    };

export interface ProviderAuthorizationLifecycleStore {
  applyObservation(input: ProviderAuthorizationObservationInput): Promise<ProviderAuthorizationObservationResult>;
}

const DENIED = (
  reasonCode: 'BINDING_UNKNOWN' | 'AUTHORIZATION_UNKNOWN' | 'AUTHORIZATION_CONFLICT',
): ProviderAuthorizationObservationResult => ({
  ok: false,
  reasonCode,
  externalWritePerformed: false,
  transportEnabled: false,
  productionCredentials: 'ABSENT',
});

const eventOrderKey = (event: ProviderAuthorizationEvent): string =>
  `${event.effectiveAt}|${event.observedAt}|${event.sourceRef}`;

/** 与折叠函数一致的「参与折叠的最后一条事件」；用于幂等去重键。 */
const lastAppliedEvent = (
  events: readonly ProviderAuthorizationEvent[],
  now: Date,
): ProviderAuthorizationEvent | null => {
  const nowMs = now.getTime();
  const valid = (events ?? []).filter(
    (event) => validateProviderAuthorizationEvent(event).ok && Date.parse(event.effectiveAt) <= nowMs,
  );
  if (valid.length === 0) return null;
  return [...valid].sort((a, b) => {
    const ka = eventOrderKey(a);
    const kb = eventOrderKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  })[valid.length - 1]!;
};

export const mapProviderStatusToBinding = (
  status: ProviderAuthorizationStatus,
): { bindingStatus: ProviderAuthorizationBindingStatus; lineageEvent: ProviderAuthorizationLineageEvent } | null => {
  switch (status) {
    case 'ACTIVE':
      return { bindingStatus: 'ACTIVE', lineageEvent: 'RESTORED' };
    case 'REAUTH_REQUIRED':
      return { bindingStatus: 'PENDING_VERIFICATION', lineageEvent: 'REAUTH_REQUIRED' };
    case 'SUSPENDED':
      return { bindingStatus: 'SUSPENDED', lineageEvent: 'SUSPENDED' };
    case 'REVOKED':
    case 'EXPIRED':
      return { bindingStatus: 'REVOKED', lineageEvent: 'REVOKED' };
    default:
      return null;
  }
};

const digestOf = (snapshot: ProviderAuthorizationObservationSnapshot): string =>
  createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');

export function createPrismaProviderAuthorizationLifecycleStore(
  prisma: PrismaClient,
): ProviderAuthorizationLifecycleStore {
  return {
    async applyObservation(input) {
      const bindingScopeKey = computeProviderBindingScopeKey({
        principalRef: input.principalRef,
        jurisdictionAnchor: input.jurisdictionAnchor,
        bindingSlotRef: input.bindingSlotRef,
      });

      const derived = deriveProviderAuthorizationState(input.events, input.now);
      if (derived.conflict) return DENIED('AUTHORIZATION_CONFLICT');
      if (derived.status === 'UNKNOWN') return DENIED('AUTHORIZATION_UNKNOWN');
      const mapped = mapProviderStatusToBinding(derived.status);
      if (mapped === null) return DENIED('AUTHORIZATION_UNKNOWN');
      const trigger = lastAppliedEvent(input.events, input.now);
      if (trigger === null) return DENIED('AUTHORIZATION_UNKNOWN');

      return prisma.$transaction(async (tx) => {
        // 行锁：同一 binding 的并发观察串行化，保证「读旧 → 写新 → 追加事实」不被交错。
        await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "CustomsProviderTenantBinding"
          WHERE "organizationId" = ${input.organizationId}
            AND "providerId" = ${input.providerId}
            AND "bindingScopeKey" = ${bindingScopeKey}
          FOR UPDATE
        `;

        const binding = await tx.customsProviderTenantBinding.findFirst({
          where: {
            organizationId: input.organizationId,
            providerId: input.providerId,
            bindingScopeKey,
          },
        });
        if (binding === null) return DENIED('BINDING_UNKNOWN');

        const existing = await tx.customsProviderTenantBindingLineage.findFirst({
          where: {
            organizationId: input.organizationId,
            bindingId: binding.id,
            event: mapped.lineageEvent as never,
            sourceRef: trigger.sourceRef,
          },
        });
        if (existing !== null) {
          return {
            ok: true as const,
            outcome: 'REPLAYED' as const,
            bindingId: binding.id,
            bindingStatus: binding.status as ProviderAuthorizationBindingStatus,
            lineageId: existing.id,
            derived,
            externalWritePerformed: false as const,
            transportEnabled: false as const,
            productionCredentials: 'ABSENT' as const,
          };
        }

        const statusChanged = binding.status !== mapped.bindingStatus;
        const restoreWithoutChange = mapped.lineageEvent === 'RESTORED' && !statusChanged;
        if (restoreWithoutChange) {
          return {
            ok: true as const,
            outcome: 'UNCHANGED' as const,
            bindingId: binding.id,
            bindingStatus: binding.status as ProviderAuthorizationBindingStatus,
            lineageId: null,
            derived,
            externalWritePerformed: false as const,
            transportEnabled: false as const,
            productionCredentials: 'ABSENT' as const,
          };
        }

        const snapshot: ProviderAuthorizationObservationSnapshot = {
          providerStatus: derived.status,
          expiresAt: derived.expiresAt,
          lastEffectiveAt: derived.lastEffectiveAt,
          lastObservedAt: derived.lastObservedAt,
          appliedEventCount: derived.appliedEventCount,
          conflict: derived.conflict,
          sourceRef: trigger.sourceRef,
          credentialReferenceRecorded: false,
        };

        if (statusChanged) {
          await tx.customsProviderTenantBinding.update({
            where: { id: binding.id },
            data: { status: mapped.bindingStatus as never },
          });
        }

        const lineage = await tx.customsProviderTenantBindingLineage.create({
          data: {
            organizationId: input.organizationId,
            bindingId: binding.id,
            event: mapped.lineageEvent as never,
            actorRef: `system:provider-observation:${input.providerId}`,
            note: null,
            snapshot: snapshot as never,
            snapshotDigest: digestOf(snapshot),
            occurredAt: input.now,
            sourceRef: trigger.sourceRef,
          },
        });

        return {
          ok: true as const,
          outcome: 'APPLIED' as const,
          bindingId: binding.id,
          bindingStatus: mapped.bindingStatus,
          lineageId: lineage.id,
          derived,
          externalWritePerformed: false as const,
          transportEnabled: false as const,
          productionCredentials: 'ABSENT' as const,
        };
      });
    },
  };
}

/** 边界自证：本 store 只写内部表，不产生任何外部写 / 传输 / 凭据使用。 */
export const CUSTOMS_PROVIDER_AUTHORIZATION_LIFECYCLE_STORE_BOUNDARY = {
  externalWritePerformed: false,
  filingSubmitted: false,
  transportEnabled: false,
  providerAuthorizationMutationPerformed: false,
  credentialReadPerformed: false,
  productionCredentials: 'ABSENT',
  writesOnly: ['CustomsProviderTenantBinding.status', 'CustomsProviderTenantBindingLineage'],
} as const;
