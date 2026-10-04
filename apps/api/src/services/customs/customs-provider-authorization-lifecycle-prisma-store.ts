/**
 * C18-7 持久化 — PROVIDER AUTHORIZATION LIFECYCLE STORE（Prisma）
 * ---------------------------------------------------------------
 * 只消费 **server-derived** 的 provider 授权事件（验签 webhook / 轮询），折叠后把结果落到
 * current binding 的 status 与 append-only lineage 事实，全部在同一个 DB 事务内完成。
 *
 * 因为 lineage 同时是「下一次 fold 的 durable history」，本 store 的契约是：
 *   **每一个会影响未来 fold 的已核验 provider 观察都必须耐久化**，无论它是否改变了提交闸门。
 *
 * MSG-20261004-30（FINAL-2）：
 *   CHANGE A —— 折叠在事务内、且纳入已持久化的历史事件（从 lineage 的 snapshot 重建）。
 *   CHANGE B —— 事件主体完整性 + 任意非法事件整批 fail-closed（zero writes）；snapshot 记录
 *               providerAuthorizationRef / triggeringEventKind / reasonCode。
 *   CHANGE C —— 幂等键 (bindingId, event, sourceRef) 由 DB 唯一索引兜底（P2002 → 重读 → REPLAYED）。
 *
 * MSG-20261004-31（FINAL-3）：
 *   CHANGE D —— 闸门未变化的合法观察也必须落事实，事件语义用新增的 `AUTHORIZATION_OBSERVED`
 *               （「收到并验证了一个观察，但没有改变闸门」），不再用会误导的 `RESTORED`，也不再丢弃事实。
 *               一次调用携带多个事件时，snapshot.observedEvents 保存**全部**参与折叠的事件（不止最后一条）。
 *   CHANGE E —— REPLAYED 路径（含 P2002 兜底）必须返回与正常路径相同的 fold 真值
 *               （persisted history + incoming），不得退回 incoming-only。
 *
 * 状态映射（数据库列是「提交闸门」，精确的 provider 状态保存在 append-only snapshot 里）：
 *   ACTIVE          → binding ACTIVE               + lineage RESTORED（仅当闸门确实由非 ACTIVE 变 ACTIVE）
 *   REAUTH_REQUIRED → binding PENDING_VERIFICATION + lineage REAUTH_REQUIRED
 *   SUSPENDED       → binding SUSPENDED            + lineage SUSPENDED
 *   REVOKED         → binding REVOKED              + lineage REVOKED
 *   EXPIRED         → binding REVOKED              + lineage REVOKED，snapshot.providerStatus = EXPIRED
 *   闸门不变        → 事件语义 AUTHORIZATION_OBSERVED（精确 provider 状态仍在 snapshot）
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

export type ProviderAuthorizationLineageEvent =
  | 'RESTORED'
  | 'REAUTH_REQUIRED'
  | 'SUSPENDED'
  | 'REVOKED'
  | 'AUTHORIZATION_OBSERVED';

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

/** 安全 opaque 的事件副本：让以后审计能回答「到底哪个 provider authorization 被撤销/续期/过期」。 */
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
  /** 非 secret 的主体/原因信息。 */
  providerAuthorizationRef: string;
  triggeringEventKind: ProviderAuthorizationEventKind;
  reasonCode: string | null;
  /** 参与本次折叠的最后一条 incoming 事件（可读性）。 */
  triggeringEvent: PersistedTriggeringEvent;
  /** CHANGE D：本次调用**全部**参与折叠的事件，保证未来 fold 可完整重建。 */
  observedEvents: PersistedTriggeringEvent[];
  /** 只记录判定结果，不含任何凭据本体。 */
  credentialReferenceRecorded: false;
}

export type ProviderAuthorizationApplyOutcome = 'APPLIED' | 'REPLAYED';

export type ProviderAuthorizationDeniedReason =
  | 'BINDING_UNKNOWN'
  | 'AUTHORIZATION_UNKNOWN'
  | 'AUTHORIZATION_CONFLICT'
  | 'AUTHORIZATION_SUBJECT_MISMATCH'
  | 'AUTHORIZATION_EVENT_INVALID'
  | 'AUTHORIZATION_HISTORY_INVALID'
  | 'AUTHORIZATION_IDEMPOTENCY_CONFLICT';

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
      /** 历史 + 本次事件一起折叠后的状态（REPLAYED 路径必须给出同样的真值）。 */
      derived: DerivedProviderAuthorizationState;
      /** 仅由历史折叠出的状态。 */
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

/**
 * 本次调用中排序最后的一条 incoming 事件（**不按 now 过滤**）。
 * CHANGE F 之后未来生效的事件也要耐久化，因此事实的 sourceRef 不能只在「已生效」的事件里挑。
 */
const lastIncomingEvent = (
  events: readonly ProviderAuthorizationEvent[],
): ProviderAuthorizationEvent | null => {
  const valid = (events ?? []).filter((event) => validateProviderAuthorizationEvent(event).ok);
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

interface LineageSnapshotShape {
  triggeringEvent?: PersistedTriggeringEvent;
  observedEvents?: PersistedTriggeringEvent[];
}

const persistedEventsOf = (snapshot: unknown): PersistedTriggeringEvent[] => {
  const shape = (snapshot ?? null) as LineageSnapshotShape | null;
  if (!shape) return [];
  // CHANGE H：字段**存在**就以它为准（包括显式空数组）。
  // gate reconciliation 的 transition 事实 observedEvents = []，表示「没有任何新的 provider observation」，
  // 绝不能 fallback 到 triggeringEvent，否则同一条 provider 事件会被 fold 两次（污染 appliedEventCount 与历史真实性）。
  if (Array.isArray(shape.observedEvents)) return shape.observedEvents;
  return shape.triggeringEvent ? [shape.triggeringEvent] : [];
};

/** idempotency identity（幂等键维度）：同一 identity 但 payload 不同 = 真正的幂等冲突。 */
const identityOf = (event: {
  kind: string;
  effectiveAt: string;
  observedAt: string;
  sourceRef: string;
}): string => [event.kind, event.effectiveAt, event.observedAt, event.sourceRef].join('|');

/** 完整 canonical payload（CHANGE G：必须比较 providerAuthorizationRef / expiresAt / reasonCode）。 */
const payloadOf = (event: {
  kind: string;
  effectiveAt: string;
  observedAt: string;
  sourceRef: string;
  providerAuthorizationRef: string;
  expiresAt?: string | null;
  reasonCode?: string | null;
}): string =>
  [
    event.kind,
    event.effectiveAt,
    event.observedAt,
    event.sourceRef,
    event.providerAuthorizationRef,
    event.expiresAt ?? '',
    event.reasonCode ?? '',
  ].join('|');

/** 从 append-only lineage 重建历史事件；任何不可重建的事实 → fail-closed。 */
const rebuildHistory = (
  rows: readonly { snapshot: unknown }[],
  subject: { organizationId: string; providerId: string; principalRef: string },
): { ok: true; events: ProviderAuthorizationEvent[] } | { ok: false } => {
  const events: ProviderAuthorizationEvent[] = [];
  for (const row of rows) {
    for (const stored of persistedEventsOf(row.snapshot)) {
      const rebuilt: ProviderAuthorizationEvent = {
        providerId: subject.providerId,
        providerAuthorizationRef: stored.providerAuthorizationRef,
        organizationId: subject.organizationId,
        principalRef: subject.principalRef,
        kind: stored.kind,
        effectiveAt: stored.effectiveAt,
        observedAt: stored.observedAt,
        expiresAt: stored.expiresAt ?? null,
        reasonCode: stored.reasonCode ?? null,
        sourceRef: stored.sourceRef,
      };
      if (!validateProviderAuthorizationEvent(rebuilt).ok) return { ok: false };
      events.push(rebuilt);
    }
  }
  return { ok: true, events };
};

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

        // CHANGE A：读回已持久化的历史事件（lineage 的 snapshot 就是当时的事实）。
        const lineageRows = await tx.customsProviderTenantBindingLineage.findMany({
          where: { organizationId: input.organizationId, bindingId: binding.id },
          orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
        });
        const rebuilt = rebuildHistory(lineageRows, input);
        if (!rebuilt.ok) return DENIED('AUTHORIZATION_HISTORY_INVALID');
        const history = rebuilt.events;

        const priorDerived = deriveProviderAuthorizationState(history, input.now);
        const incoming = input.events ?? [];
        const trigger = lastIncomingEvent(incoming);
        if (trigger === null) return DENIED('AUTHORIZATION_UNKNOWN');

        // CHANGE G：同一 idempotency identity 但 payload 不同 → 真正的幂等冲突，不得静默当成重放。
        for (const event of incoming) {
          const match = history.find((h) => identityOf(h) === identityOf(event));
          if (match && payloadOf(match) !== payloadOf(event)) {
            return DENIED('AUTHORIZATION_IDEMPOTENCY_CONFLICT');
          }
        }
        const allRecorded = incoming.every((event) => history.some((h) => payloadOf(h) === payloadOf(event)));

        // CHANGE G：精确重放不得重复 fold —— derived 直接取已持久化历史的折叠真值（不再 + incoming）。
        const derived = allRecorded
          ? priorDerived
          : deriveProviderAuthorizationState([...history, ...incoming], input.now);
        if (!allRecorded && derived.conflict) return DENIED('AUTHORIZATION_CONFLICT');
        // CHANGE F：未来生效的合法观察不改闸门，但仍必须耐久化（mapped 为 null 表示「当前不生效」）。
        const mapped = derived.status === 'UNKNOWN' ? null : mapProviderStatusToBinding(derived.status);
        if (derived.status !== 'UNKNOWN' && mapped === null) return DENIED('AUTHORIZATION_UNKNOWN');
        const gateChanged = mapped !== null && binding.status !== mapped.bindingStatus;
        const observedPersisted = incoming.map(toPersistedTriggeringEvent);
        // CHANGE H：allRecorded 说明这条观察**已经在历史里**；此时若闸门仍需对齐（未来事件到期），
        // 产生的是「内部闸门对齐」的 transition 事实，而不是一次新的 provider observation ingest。
        const isReconciliation = allRecorded && gateChanged;

        if (allRecorded && !gateChanged) {
          const existing = await tx.customsProviderTenantBindingLineage.findFirst({
            where: { organizationId: input.organizationId, bindingId: binding.id, sourceRef: trigger.sourceRef },
          });
          return {
            ok: true as const,
            outcome: 'REPLAYED' as const,
            bindingId: binding.id,
            bindingStatus: binding.status as ProviderAuthorizationBindingStatus,
            lineageId: existing?.id ?? null,
            derived,
            priorDerived,
            externalWritePerformed: false as const,
            transportEnabled: false as const,
            productionCredentials: 'ABSENT' as const,
          };
        }

        // CHANGE D：闸门变化用 transition 事件语义；闸门不变（含「全部尚未生效」）落 AUTHORIZATION_OBSERVED。
        const eventToWrite: ProviderAuthorizationLineageEvent = gateChanged
          ? mapped!.lineageEvent
          : 'AUTHORIZATION_OBSERVED';

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
          observedEvents: isReconciliation ? [] : observedPersisted,
          credentialReferenceRecorded: false,
        };

        if (gateChanged) {
          await tx.customsProviderTenantBinding.update({
            where: { id: binding.id },
            data: { status: mapped.bindingStatus as never },
          });
        }

        const lineage = await tx.customsProviderTenantBindingLineage.create({
          data: {
            organizationId: input.organizationId,
            bindingId: binding.id,
            event: eventToWrite as never,
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
          bindingStatus: gateChanged
            ? mapped!.bindingStatus
            : (binding.status as ProviderAuthorizationBindingStatus),
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
        // CHANGE E：这里必须用 persisted history + incoming 的同一 fold 真值，不能退回 incoming-only。
        if (!isUniqueViolation(error)) throw error;
        const binding = await prisma.customsProviderTenantBinding.findFirst({
          where: { organizationId: input.organizationId, providerId: input.providerId, bindingScopeKey },
        });
        if (binding === null) return DENIED('BINDING_UNKNOWN');
        const rows = await prisma.customsProviderTenantBindingLineage.findMany({
          where: { organizationId: input.organizationId, bindingId: binding.id },
          orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
        });
        const rebuilt = rebuildHistory(rows, input);
        if (!rebuilt.ok) return DENIED('AUTHORIZATION_HISTORY_INVALID');
        const priorDerived = deriveProviderAuthorizationState(rebuilt.events, input.now);
        const incomingEvents = input.events ?? [];
        const trigger = lastIncomingEvent(incomingEvents);
        if (trigger === null) return DENIED('AUTHORIZATION_UNKNOWN');
        // CHANGE G：P2002 后必须确认 incoming 的**全量 payload** 已持久化；同 identity 不同 payload → 冲突。
        for (const event of incomingEvents) {
          const match = rebuilt.events.find((h) => identityOf(h) === identityOf(event));
          if (match && payloadOf(match) !== payloadOf(event)) {
            return DENIED('AUTHORIZATION_IDEMPOTENCY_CONFLICT');
          }
        }
        const allRecorded = incomingEvents.every((event) =>
          rebuilt.events.some((h) => payloadOf(h) === payloadOf(event)),
        );
        if (!allRecorded) return DENIED('AUTHORIZATION_HISTORY_INVALID');
        const derived = priorDerived;
        const existing = await prisma.customsProviderTenantBindingLineage.findFirst({
          where: { organizationId: input.organizationId, bindingId: binding.id, sourceRef: trigger.sourceRef },
        });
        if (existing === null) throw error;
        return {
          ok: true,
          outcome: 'REPLAYED',
          bindingId: binding.id,
          bindingStatus: binding.status as ProviderAuthorizationBindingStatus,
          lineageId: existing.id,
          derived,
          priorDerived,
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
