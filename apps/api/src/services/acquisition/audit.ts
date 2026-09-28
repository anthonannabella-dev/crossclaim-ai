/**
 * Acquisition audit events (C-0005 / Gate 3).
 * ---------------------------------------------------------------
 * Event vocabulary fixed by the Gate 2 final review:
 *   FILE + API : import.completed / import.failed
 *   FILE       : file.uploaded / file.upload_failed
 *   API        : adapter.pull_failed
 *
 * Every event goes through the Gate 1 audit writer, so action-name validation,
 * actor validation and `sanitizeChanges` are shared instead of re-implemented.
 */

import type { AuditWriter } from '../audit';

export const ACQUISITION_ACTOR_REF = 'acquisition-service';

export type AcquisitionAction =
  | 'file.uploaded'
  | 'file.upload_failed'
  | 'import.completed'
  | 'import.failed'
  | 'adapter.pull_failed';

export interface AcquisitionAuditEvent {
  organizationId: string;
  action: AcquisitionAction;
  entityType: string;
  entityId: string;
  changes: Record<string, unknown>;
}

export async function recordAcquisitionEvent(
  writer: AuditWriter,
  event: AcquisitionAuditEvent,
): Promise<void> {
  await writer.record({
    organizationId: event.organizationId,
    actorType: 'SYSTEM',
    actorRef: ACQUISITION_ACTOR_REF,
    action: event.action,
    entityType: event.entityType,
    entityId: event.entityId,
    changes: event.changes,
  });
}

/**
 * Failure paths use this variant: an audit outage must never replace the
 * original acquisition error with an AuditError.
 */
export async function tryRecordAcquisitionEvent(
  writer: AuditWriter,
  event: AcquisitionAuditEvent,
): Promise<void> {
  try {
    await recordAcquisitionEvent(writer, event);
  } catch {
    // intentionally swallowed: the caller rethrows the original failure
  }
}

export function describeError(err: unknown): { code: string; message: string } {
  if (err instanceof Error) {
    const code =
      typeof (err as { code?: unknown }).code === 'string'
        ? String((err as { code?: unknown }).code)
        : err.name;
    return { code, message: err.message.slice(0, 500) };
  }
  return { code: 'UNKNOWN', message: String(err).slice(0, 500) };
}
