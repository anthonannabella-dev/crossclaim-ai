/**
 * C-0008-A — internal read-only data endpoints for the web app.
 * ---------------------------------------------------------------
 * Every request is resolved through the same three-step session check
 * (tokenHash → Session → Membership) and every query is tenant-scoped by the
 * session's organizationId. Read-only: no writes, no money calculations.
 *
 *   GET /imports        → latest import batches
 *   GET /opportunities  → latest recovery opportunities
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import type { PrismaClient } from '@prisma/client';

import { parseCookies, SESSION_COOKIE } from './http-routes';
import { resolveSession, type SessionContext, type SessionDeps } from './session';

export interface DataRouteDeps {
  prisma: PrismaClient;
  session: SessionDeps;
  limit?: number;
}

function sendJson(res: ServerResponse, code: number, payload: unknown): void {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

async function requireSession(
  req: IncomingMessage,
  res: ServerResponse,
  deps: DataRouteDeps,
): Promise<SessionContext | null> {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  const context = token ? await resolveSession(token, deps.session) : null;
  if (!context) {
    sendJson(res, 401, { error: 'UNAUTHENTICATED' });
    return null;
  }
  return context;
}

export async function handleDataRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: DataRouteDeps,
): Promise<boolean> {
  const path = (req.url ?? '/').split('?')[0];
  const method = req.method ?? 'GET';
  const limit = Math.min(Math.max(deps.limit ?? 20, 1), 100);

  if (method !== 'GET' || (path !== '/imports' && path !== '/opportunities')) return false;

  const context = await requireSession(req, res, deps);
  if (!context) return true;

  if (path === '/imports') {
    const rows = await deps.prisma.importBatch.findMany({
      where: { organizationId: context.organizationId },
      orderBy: { startedAt: 'desc' },
      take: limit,
      select: {
        id: true,
        status: true,
        rowsTotal: true,
        rowsOk: true,
        rowsFailed: true,
        startedAt: true,
        finishedAt: true,
        fileAssetId: true,
        connectionId: true,
      },
    });
    sendJson(res, 200, { items: rows });
    return true;
  }

  const opportunities = await deps.prisma.recoveryOpportunity.findMany({
    where: { organizationId: context.organizationId },
    orderBy: { detectedAt: 'desc' },
    take: limit,
    select: {
      id: true,
      status: true,
      opportunityType: true,
      title: true,
      amountExpected: true,
      amountActual: true,
      recoverableAmount: true,
      currency: true,
      detectedAt: true,
    },
  });
  sendJson(res, 200, {
    items: opportunities.map((row) => ({
      id: row.id,
      status: row.status,
      opportunityType: row.opportunityType,
      title: row.title,
      amountExpected: row.amountExpected === null ? null : row.amountExpected.toFixed(4),
      amountActual: row.amountActual === null ? null : row.amountActual.toFixed(4),
      recoverableAmount: row.recoverableAmount === null ? null : row.recoverableAmount.toFixed(4),
      currency: row.currency,
      detectedAt: row.detectedAt,
    })),
  });
  return true;
}
