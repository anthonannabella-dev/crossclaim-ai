// AGENT EXPERIENCE LAYER / P7 — Standing Authorization 客户管理面（只读 + 撤销）
// ---------------------------------------------------------------------------
// 语义边界（HOST P7 明文）：
//   * 状态**全部**来自后端 durable Standing Authorization（P0 的 `StandingAuthorization` 表）；
//   * 客户端**不得**生成 / 提交 `scopeDigest`，**不得**指定任何 server-only 权限字段
//     （organizationId / platformAccountId / allowedActionTypes / monetaryLimitUsd / effectiveAt / expiresAt …）；
//   * 本入口只暴露两件事：**读取**与**撤销**。授权范围的修改必须先取得条款同意（consent evidence），
//     在没有该流程前**不提供**「静默改范围」的入口（fail-closed，不伪造同意）；
//   * 不执行任何外部动作、不授予任何权限。

import type { IncomingMessage, ServerResponse } from 'node:http';

import type { PrismaClient } from '@prisma/client';

import {
  loadStandingAuthorizationById,
  listStandingAuthorizations,
  revokeStandingAuthorizationScope,
} from './standing-authorization-store';
import type { StandingAuthorizationRecord } from './standing-authorization';
import { CUSTOMS_POA_BOUNDARY } from './action-guard-wiring';
import { RISK_TIER_BOUNDARY } from './risk-tier-policy';

export const STANDING_AUTHORIZATION_HTTP_PATH = /^\/standing-authorizations(?:\/[^/]+\/revoke)?$/;
export const STANDING_AUTHORIZATION_REVOKE_PATH = /^\/standing-authorizations\/([^/]+)\/revoke$/;

export interface StandingAuthorizationSession {
  userId: string;
  organizationId: string;
}

export interface StandingAuthorizationRouteDeps {
  prisma: PrismaClient;
  session: StandingAuthorizationSession;
  now?: () => Date;
}

/** 客户可见视图：server-derived 全字段；`scopeDigest` 只作审计展示（写路径永不接受） */
export function toCustomerAuthorizationView(view: StandingAuthorizationRecord) {
  return {
    authorizationId: view.authorizationId,
    provider: view.provider,
    platformAccountId: view.platformAccountId,
    allowedActionTypes: [...view.allowedActionTypes],
    monetaryLimitUsd: view.monetaryLimitUsd,
    currency: view.currency,
    domain: view.domain,
    jurisdiction: view.jurisdiction,
    effectiveAt: view.effectiveAt,
    expiresAt: view.expiresAt,
    authorizationVersion: view.authorizationVersion,
    termsPolicyVersion: view.termsPolicyVersion,
    revocationState: view.revocation.state,
    revokedAt: view.revocation.revokedAt,
    revokedBy: view.revocation.revokedBy,
    revocationReason: view.revocation.reason,
    /** server-derived；仅用于审计展示（前端不得生成，写路径不接受） */
    scopeDigest: view.scopeDigest,
    createdAt: view.createdAt,
  };
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > 16 * 1024) throw new Error('BODY_TOO_LARGE');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text === '') return {};
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('BODY_NOT_OBJECT');
  return parsed as Record<string, unknown>;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

/**
 * `GET  /standing-authorizations`               → 本租户授权列表（含撤销态）
 * `POST /standing-authorizations/:id/revoke`    → 撤销该授权（服务端解析 scope；只接受 reason）
 */
export async function handleStandingAuthorizationRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: StandingAuthorizationRouteDeps,
): Promise<boolean> {
  const method = (req.method ?? 'GET').toUpperCase();
  const path = (req.url ?? '/').split('?')[0] ?? '/';
  const revoke = STANDING_AUTHORIZATION_REVOKE_PATH.exec(path);
  const now = deps.now?.() ?? new Date();

  if (revoke !== null && method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: 'INVALID_INPUT' });
      return true;
    }
    // 只接受 reason；任何 scope / 权限字段一律忽略（不报错、不采纳）
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (reason === '' || reason.length > 200) {
      sendJson(res, 400, { error: 'REASON_REQUIRED' });
      return true;
    }

    const record = await loadStandingAuthorizationById(deps.prisma, {
      organizationId: deps.session.organizationId,
      authorizationId: revoke[1],
    });
    if (record === null) {
      // 跨租户 / 不存在一律 404（不泄漏存在性）
      sendJson(res, 404, { error: 'NOT_FOUND' });
      return true;
    }

    const result = await revokeStandingAuthorizationScope(deps.prisma, {
      organizationId: record.organizationId,
      platformAccountId: record.platformAccountId,
      provider: record.provider,
      revokedBy: deps.session.userId,
      reason,
      at: now,
    });
    const updated = await loadStandingAuthorizationById(deps.prisma, {
      organizationId: deps.session.organizationId,
      authorizationId: revoke[1],
    });
    sendJson(res, 200, {
      revoked: result.revoked,
      alreadyInactive: result.alreadyInactive,
      authorization: updated === null ? null : toCustomerAuthorizationView(updated),
      /** 恒为 false：撤销只改授权状态，不产生任何外部动作 */
      externalActionPerformed: false,
    });
    return true;
  }

  if (revoke !== null && method !== 'POST') {
    sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    return true;
  }

  if (method === 'GET') {
    const items = await listStandingAuthorizations(deps.prisma, { organizationId: deps.session.organizationId });
    sendJson(res, 200, {
      items: items.map(toCustomerAuthorizationView),
      /** 边界如实回传：授权只满足 humanApproval，不授予外写、不等于 Broker POA */
      standings: {
        grantsExternalWrite: false,
        satisfiesOnly: ['humanApproval'],
        highValueHitl: RISK_TIER_BOUNDARY.highValueHitl,
        standingAuthorizationIsBrokerPoa: CUSTOMS_POA_BOUNDARY.standingAuthorizationIsBrokerPoa,
      },
      executionPerformed: false,
    });
    return true;
  }

  sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  return true;
}

export const STANDING_AUTHORIZATION_HTTP_BOUNDARY = {
  readOnlyPlusRevoke: true,
  scopeFromServerOnly: true,
  acceptsClientScopeDigest: false,
  acceptsServerOnlyFields: false,
  createsAuthorizationWithoutConsent: false,
  silentScopeEdit: 'FORBIDDEN（改范围需先取得条款同意；本入口不提供）',
  externalActionPerformed: false,
  grantsPermissions: false,
  forbidden: [
    'accepting a client-supplied scopeDigest or scope fields',
    'changing an existing authorization scope in place',
    'creating an authorization without server-side consent evidence',
    'treating a standing authorization as a broker POA or external-write permission',
  ],
} as const;
