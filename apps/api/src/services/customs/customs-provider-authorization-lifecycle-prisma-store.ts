/**
 * C18-7 持久化 — PROVIDER AUTHORIZATION LIFECYCLE STORE（Prisma）
 * ---------------------------------------------------------------
 * 只消费 **server-derived** 的 provider 授权事件（验签 webhook / 轮询），折叠后把结果落到
 * current binding 的 status 与 append-only lineage 事实，全部在同一个 DB 事务内完成。
 *
 * FINAL-2（MSG-20261004-30 三项必修）：
 *   CHANGE A —— 折叠必须在事务内、且**已持久化的历史事件**要与本次 incoming 事件一起参与折叠：
 *               迟到的旧 GRANTED（effectiveAt 早于已记录的 REVOKED）不能复活已撤销的 binding，
 *               SUSPENDED / REAUTH_REQUIRED 也不能解除 REVOKED / EXPIRED 这类 terminal 状态。
 *               历史事件从每条 lineage 事实的 snapshot.triggeringEvent 重建（lineage 是 append-only，
 *               所以那确实就是当时的事实，不需要新增 provider event 表）。
 *   CHANGE B —— 事件主体完整性 + 严格 fail-closed：每个 incoming 事件必须与 input 的
 *               organizationId / providerId / principalRef 一致，否则 AUTHORIZATION_SUBJECT_MISMATCH 且 zero writes；
 *               任意事件校验失败 → 整批拒绝（AUTHORIZATION_EVENT_INVALID），**不再**静默过滤坏事件后继续折叠；
 *               snapshot 额外持久化 providerAuthorizationRef / triggeringEventKind / reasonCode（均非 secret）。
 *   CHANGE C —— 幂等键 (bindingId, event, sourceRef) 由 DB 唯一索引兜底
 *               `CustomsProviderTenantBindingLineage_lifecycle_key`；唯一冲突（P2002）→ 重新读取既有事实 → REPLAYED。
 *
 * 状态映射（数据库列是「提交闸门」，精确的 provider 状态保存在 append-only snapshot 里）：
 *   ACTIVE          → binding ACTIVE               + lineage RESTORED
 *   REAUTH_REQUIRED → binding PENDING_VERIFICATION + lineage REAUTH_REQUIRED
 *   SUSPENDED       → binding SUSPENDED            + lineage SUSPENDED
 *   REVOKED         → binding REVOKED              + lineage REVOKED
 *   EXPIRED         → binding REVOKED              + lineage REVOKED，snapshot.providerStatus = EXPIRED
 *     （`CustomsProviderBindingStatus` 无 EXPIRED 取值；撤销与过期都「不可提交」，精确原因留在快照。）
 *
 * 本模块不做任何 provider 网络调用、不读凭据、不产生外部写。
 */

import { createHash } from 'node:crypto';

import { Prisma, type PrismaClient } from '@prisma/client';

import { computeProviderBindingScopeKey } from './customs-provider-tenant-binding';
import {
  deriveProviderAuthorizationState,
  validateProviderAuthorizationEvent,
  type DerivedProviderAuthorizationState,
  type ProviderAuthorizationEvent,
  type ProviderAuthorizationEventKind,
  type ProviderAuthorizationStatus,
} from './customs-provider-authorization-lifecycle';

export type ProviderAuthorizationBindingStatus = 'ACTIVE' | 'PENDING_VERIFICATION' | 'SUSPENDED' | 'REVOKED';

export type ProviderAuthorizationLineageEvent = 'RESTORED' | 'REAUTH_REQUIRED' | 'SUSPENDED' | 'REVOKED';

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

/** 安全 opaque 的触发事件副本：让以后审计能回答「到底哪个 provider authorization 被撤销/过期」。 */
export interface PersistedTriggeringEvent {
  kind: ProviderAuthorizationEventKind;
  effectiveAt: string;
  observedAt: string;
  expiresAt: string | null;
  reasonCode: string | null;
  sourceRef: string;
  providerAuthorizationRef: string;
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
  /** CHANGE B 追加：非 secret 的主体/原因信息。 */
  providerAuthorizationRef: string;
  triggeringEventKind: ProviderAuthorizationEventKind;
  reasonCode: string | null;
  /** CHANGE A 追加：完整（安全）触发事件，供后续调用重建历史并参与折叠。 */
  triggeringEvent: PersistedTriggeringEvent;
  /** 只记录判定结果，不含任何凭据本体。 */
  credentialReferenceRecorded: false;
}

export type ProviderAuthorizationApplyOutcome = 'APPLIED' | 'REPLAYED' | 'UNCHANGED';

export type ProviderAuthorizationDeniedReason =
  | 'BINDING_UNKNOWN'
  | 'AUTHORIZATION_UNKNOWN'
  | 'AUTHORIZATION_CONFLICT'
  | 'AUTHORIZATION_SUBJECT_MISMATCH'
  | 'AUTHORIZATION_EVENT_INVALID'
  | 'AUTHORIZATION_HISTORY_INVALID';

export type ProviderAuthorizationObservationResult =
  | {
      ok: false;
      reasonCode: ProviderAuthorizationDeniedReason;
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
      /** 历史 + 本次事件一起折叠后的状态。 */
      derived: DerivedProviderAuthorizationState;
      /** 仅由历史折叠出的状态（用于证明「迟到的旧事件不能复活 terminal」）。 */
      priorDerived: DerivedProviderAuthorizationState;
      externalWritePerformed: false;
      transportEnabled: false;
      productionCredentials: 'ABSENT';
    };

export interface ProviderAuthorizationLifecycleStore {
  applyObservation(input: ProviderAuthorizationObservationInput): Promise<ProviderAuthorizationObservationResult>;
}

const DENIED = (reasonCode: ProviderAuthorizationDeniedReason): ProviderAuthorizationObservationResult => ({
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

const toPersistedTriggeringEvent = (event: ProviderAuthorizationEvent): PersistedTriggeringEvent => ({
  kind: event.kind,
  effectiveAt: event.effectiveAt,
  observedAt: event.observedAt,
  expiresAt: event.expiresAt ?? null,
  reasonCode: event.reasonCode ?? null,
  sourceRef: event.sourceRef,
  providerAuthorizationRef: event.providerAuthorizationRef,
});

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

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

      // CHANGE B：先做主体完整性 + 严格校验；任何不合格 → 整批 fail-closed（zero writes，连事务都不开）。
      for (const event of input.events ?? []) {
        if (!validateProviderAuthorizationEvent(event).ok) return DENIED('AUTHORIZATION_EVENT_INVALID');
        if (
          event.organizationId !== input.organizationId ||
          event.providerId !== input.providerId ||
          event.principalRef !== input.principalRef
        ) {
          return DENIED('AUTHORIZATION_SUBJECT_MISMATCH');
        }
      }

      const applyInsideTransaction = async (
        tx: Prisma.TransactionClient,
      ): Promise<ProviderAuthorizationObservationResult> => {
        // 行锁：同一 binding 的并发观察串行化，保证「读历史 → 折叠 → 写新 → 追加事实」不被交错。
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

        // CHANGE A：读回已持久化的历史事件（lineage 的 triggeringEvent 就是当时的事实）。
        const lineageRows = await tx.customsProviderTenantBindingLineage.findMany({
          where: { organizationId: input.organizationId, bindingId: binding.id },
          orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
        });
        const history: ProviderAuthorizationEvent[] = [];
        for (const row of lineageRows) {
          const stored = (row.snapshot as { triggeringEvent?: PersistedTriggeringEvent } | null)?.triggeringEvent;
          if (!stored) continue; // 早于本机制的 lineage 事实（例如 binding store 的 BOUND）不带事件，跳过。
          const rebuilt: ProviderAuthorizationEvent = {
            providerId: input.providerId,
            providerAuthorizationRef: stored.providerAuthorizationRef,
            organizationId: input.organizationId,
            principalRef: input.principalRef,
            kind: stored.kind,
            effectiveAt: stored.effectiveAt,
            observedAt: stored.observedAt,
            expiresAt: stored.expiresAt ?? null,
            reasonCode: stored.reasonCode ?? null,
            sourceRef: stored.sourceRef,
          };
          // 历史事实若不可重建/不合法 → fail-closed，绝不「猜」一个状态。
          if (!validateProviderAuthorizationEvent(rebuilt).ok) return DENIED('AUTHORIZATION_HISTORY_INVALID');
          history.push(rebuilt);
        }

        const priorDerived = deriveProviderAuthorizationState(history, input.now);
        const derived = deriveProviderAuthorizationState([...history, ...(input.events ?? [])], input.now);
        if (derived.conflict) return DENIED('AUTHORIZATION_CONFLICT');
        if (derived.status === 'UNKNOWN') return DENIED('AUTHORIZATION_UNKNOWN');
        const mapped = mapProviderStatusToBinding(derived.status);
        if (mapped === null) return DENIED('AUTHORIZATION_UNKNOWN');
        // 幂等键取「本次 incoming 事件中真正参与折叠的最后一条」。
        const trigger = lastAppliedEvent(input.events, input.now);
        if (trigger === null) return DENIED('AUTHORIZATION_UNKNOWN');

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
            priorDerived,
            externalWritePerformed: false as const,
            transportEnabled: false as const,
            productionCredentials: 'ABSENT' as const,
          };
        }

        // 只有**闸门状态真的变化**才追加事实：terminal 下收到 SUSPENDED / 迟到旧 GRANTED / 对已 ACTIVE 的 binding
        // 再确认一次授权，都不应伪造一条事件语义（否则会写出「RESTORED」这种暗示此前不可用的假事实）。
        if (binding.status === mapped.bindingStatus) {
          return {
            ok: true as const,
            outcome: 'UNCHANGED' as const,
            bindingId: binding.id,
            bindingStatus: binding.status as ProviderAuthorizationBindingStatus,
            lineageId: null,
            derived,
            priorDerived,
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
          providerAuthorizationRef: trigger.providerAuthorizationRef,
          triggeringEventKind: trigger.kind,
          reasonCode: trigger.reasonCode ?? null,
          triggeringEvent: toPersistedTriggeringEvent(trigger),
          credentialReferenceRecorded: false,
        };

        if (binding.status !== mapped.bindingStatus) {
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
          priorDerived,
          externalWritePerformed: false as const,
          transportEnabled: false as const,
          productionCredentials: 'ABSENT' as const,
        };
      };

      try {
        return await prisma.$transaction(applyInsideTransaction);
      } catch (error) {
        // CHANGE C：DB 唯一索引兜底（另一 writer 先提交了同一 (bindingId,event,sourceRef)）→ 重新读取 → REPLAYED。
        // 事务已整体回滚，因此这里在事务外重新读取，绝不留下半截状态。
        if (!isUniqueViolation(error)) throw error;
        const binding = await prisma.customsProviderTenantBinding.findFirst({
          where: { organizationId: input.organizationId, providerId: input.providerId, bindingScopeKey },
        });
        if (binding === null) return DENIED('BINDING_UNKNOWN');
        const trigger = lastAppliedEvent(input.events, input.now);
        if (trigger === null) return DENIED('AUTHORIZATION_UNKNOWN');
        const derived = deriveProviderAuthorizationState(input.events, input.now);
        const mapped = mapProviderStatusToBinding(derived.status);
        if (mapped === null) return DENIED('AUTHORIZATION_UNKNOWN');
        const existing = await prisma.customsProviderTenantBindingLineage.findFirst({
          where: {
            organizationId: input.organizationId,
            bindingId: binding.id,
            event: mapped.lineageEvent as never,
            sourceRef: trigger.sourceRef,
          },
        });
        if (existing === null) throw error;
        return {
          ok: true,
          outcome: 'REPLAYED',
          bindingId: binding.id,
          bindingStatus: binding.status as ProviderAuthorizationBindingStatus,
          lineageId: existing.id,
          derived,
          priorDerived: derived,
          externalWritePerformed: false,
          transportEnabled: false,
          productionCredentials: 'ABSENT',
        };
      }
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
