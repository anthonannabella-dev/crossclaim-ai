/**
 * C-0008-B1 — internal workflow HTTP endpoints (human opportunity review).
 * ---------------------------------------------------------------
 *   POST /opportunities/:id/qualify   → DETECTED → QUALIFIED
 *   POST /opportunities/:id/reject    → DETECTED → REJECTED (body.reason required)
 *
 * Every request is resolved through the same three-step session check as the
 * C-0008-A endpoints (cookie → Session tokenHash → Membership). The review
 * itself is delegated to services/workflow, so the approved permission matrix,
 * the state machine and the same-transaction AuditLog (actorUserId) are the
 * single implementation of this transition.
 *
 * The endpoints stay internal to this machine; no public exposure in Gate 6.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import type { PrismaClient } from '@prisma/client';

import { parseCookies, SESSION_COOKIE } from '../auth/http-routes';
import { resolveSession, type SessionContext, type SessionDeps } from '../auth/session';
import {
  createManagedConnection,
  listConnections,
  rotateConnectionCredentialRef,
  setConnectionStatus,
} from './connection-management';
import { confirmCommercialTerms, createCaseForOpportunity } from './case-creation';
import { confirmRecoveryOutcome } from './recovery-outcome';
import { getRecoveryReviewStatus, submitRecoveryReview } from './recovery-review';
import { advanceBillingInvoice, listBillingInvoices } from './billing';
import { getAppealPackageState } from './appeal-package';
import { reconcilePayoutItems } from './commission-reconciliation';
import { handlePaymentWebhook } from './payment-webhook';
import { listPaymentReconciliation, toReconciliationCsv } from './payment-reconciliation';
import { replayPaymentEvent, runDueRetries } from './payment-attempt';
import { getCase, getClaimDraft, listCaseEvidence, listCases } from './case-read';
import {
  buildOperationsDashboard,
  listClaimBucketDetail,
  listRecoveryDetail,
} from '../operations/dashboard-projection';
import {
  getOpportunityInsight,
  listOpportunityInsights,
  toExportRows,
} from './opportunity-insight';
import { REJECT_REASONS, WorkflowError, reviewOpportunity } from './opportunity-review';
import { ForbiddenError, assertPermission } from './permissions';

const MAX_BODY_BYTES = 16 * 1024;
const REVIEW_PATH = /^\/opportunities\/([^/]+)\/(qualify|reject|case)$/;
const INSIGHT_LIST_PATH = /^\/opportunities\/insights$/;
const INSIGHT_CSV_PATH = /^\/opportunities\/insights\.csv$/;
const INSIGHT_PATH = /^\/opportunities\/([^/]+)\/basis$/;
const CONNECTION_PATH = /^\/connections(?:\/([^/]+)\/(status|credential-ref))?$/;
const COMMERCIAL_TERMS_PATH = /^\/cases\/([^/]+)\/commercial-terms$/;
const RECOVERY_OUTCOME_PATH = /^\/cases\/([^/]+)\/recovery-outcome$/;
const RECOVERY_REVIEW_PATH = /^\/cases\/([^/]+)\/recovery-review$/;
const APPEAL_PACKAGE_PATH = /^\/cases\/([^/]+)\/appeal-package$/;
const COMMISSION_RECONCILE_PATH = /^\/commissions\/reconcile$/;
const PAYMENTS_PATH = /^\/payments$/;
const PAYMENT_WEBHOOK_PATH = /^\/payments\/webhook$/;
const PAYMENTS_RECONCILIATION_PATH = /^\/payments\/reconciliation$/;
const PAYMENTS_RECONCILIATION_CSV_PATH = /^\/payments\/reconciliation\.csv$/;
const PAYMENT_REPLAY_PATH = /^\/payments\/events\/([^/]+)\/replay$/;
const PAYMENT_RETRY_DUE_PATH = /^\/payments\/processing\/retry-due$/;
const BILLING_PATH = /^\/billing(?:\/([^/]+)\/status)?$/;
const CASE_LIST_PATH = /^\/cases$/;
const CASE_DETAIL_PATH = /^\/cases\/([^/]+)$/;
const CASE_EVIDENCE_PATH = /^\/cases\/([^/]+)\/evidence$/;
const CASE_CLAIM_PATH = /^\/cases\/([^/]+)\/claim$/;
// MSG-20260929-30：运营看板（只读投影，GET only）
const OPERATIONS_DASHBOARD_PATH = /^\/operations\/dashboard$/;
const OPERATIONS_CLAIMS_PATH = /^\/operations\/claims$/;
const OPERATIONS_RECOVERY_PATH = /^\/operations\/recovery$/;

/** 请求体层面的错误（与领域状态无关），统一映射为 400。 */
class HttpBodyError extends Error {
  readonly code = 'INVALID_BODY';

  constructor(message: string) {
    super(message);
    this.name = 'HttpBodyError';
  }
}

export interface WorkflowRouteDeps {
  prisma: PrismaClient;
  session: SessionDeps;
  /** Platforms of the adapters registered in this deployment (API connections only). */
  registeredPlatforms?: readonly string[];
  now?: () => Date;
  /** C-0010-C2：结构化安全日志出口（webhook 验签失败、版本不一致等） */
  log?: (event: string, fields: Record<string, unknown>) => void;
}

function sendJson(res: ServerResponse, code: number, payload: unknown): void {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new HttpBodyError('请求体过大');
    chunks.push(buffer);
  }
  if (size === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    throw new HttpBodyError('请求体不是合法 JSON');
  }
}

function statusFor(error: unknown): { code: number; error: string } {
  if (error instanceof HttpBodyError) return { code: 400, error: error.code };
  if (error instanceof ForbiddenError) return { code: 403, error: error.code };
  if (error instanceof WorkflowError) {
    switch (error.code) {
      case 'NOT_FOUND':
        return { code: 404, error: error.code };
      case 'ILLEGAL_TRANSITION':
      case 'DUPLICATE_CONNECTION':
      case 'SCOPE_NOT_SUPPORTED':
      case 'COMMERCIAL_TERMS_PENDING':
      case 'CLAIM_NOT_APPROVED':
      case 'CURRENCY_MISMATCH':
      case 'REVIEW_REQUIRED':
      case 'PAYMENT_CONTEXT_REQUIRED':
      case 'ATTEMPT_ALREADY_RUNNING':
      case 'CLAIM_ITEM_CASE_REQUIRED':
        return { code: 409, error: error.code };
      case 'FORBIDDEN':
        return { code: 403, error: error.code };
      case 'REASON_REQUIRED':
      case 'INVALID_REASON':
      case 'INVALID_INPUT':
      case 'SECRET_NOT_ACCEPTED':
      case 'PLATFORM_NOT_REGISTERED':
      case 'INVALID_COMMERCIAL_TERMS':
      case 'INVALID_FIELD':
      case 'PAYMENT_REFERENCE_REQUIRED':
      case 'RULE_AMOUNT_MISMATCH':
      case 'SOURCE_IDENTITY_REQUIRED':
      case 'INVALID_WINDOW':
        return { code: 400, error: error.code };
      case 'CASE_NOT_CREATED':
        return { code: 500, error: error.code };
      default:
        return { code: 400, error: 'INVALID_REQUEST' };
    }
  }
  return { code: 500, error: 'WORKFLOW_ERROR' };
}

function requireString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' ? value : undefined;
}

export async function handleWorkflowRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WorkflowRouteDeps,
): Promise<boolean> {
  const path = (req.url ?? '/').split('?')[0];
  const review = REVIEW_PATH.exec(path);
  const insightList = INSIGHT_LIST_PATH.test(path);
  const insightCsv = INSIGHT_CSV_PATH.test(path);
  const insight = INSIGHT_PATH.exec(path);
  const connection = CONNECTION_PATH.exec(path);
  const termsPath = COMMERCIAL_TERMS_PATH.exec(path);
  const outcomePath = RECOVERY_OUTCOME_PATH.exec(path);
  const reviewPath = RECOVERY_REVIEW_PATH.exec(path);
  const appealPath = APPEAL_PACKAGE_PATH.exec(path);
  const commissionPath = COMMISSION_RECONCILE_PATH.test(path);
  const paymentsPath = PAYMENTS_PATH.test(path);
  const webhookPath = PAYMENT_WEBHOOK_PATH.test(path);
  const reconciliationPath = PAYMENTS_RECONCILIATION_PATH.test(path);
  const reconciliationCsvPath = PAYMENTS_RECONCILIATION_CSV_PATH.test(path);
  const replayPath = PAYMENT_REPLAY_PATH.exec(path);
  const retryDuePath = PAYMENT_RETRY_DUE_PATH.test(path);
  const billingPath = BILLING_PATH.exec(path);
  const caseListPath = CASE_LIST_PATH.test(path);
  const caseDetail = CASE_DETAIL_PATH.exec(path);
  const caseEvidence = CASE_EVIDENCE_PATH.exec(path);
  const caseClaim = CASE_CLAIM_PATH.exec(path);
  const operationsDashboard = OPERATIONS_DASHBOARD_PATH.test(path);
  const operationsClaims = OPERATIONS_CLAIMS_PATH.test(path);
  const operationsRecovery = OPERATIONS_RECOVERY_PATH.test(path);
  if (!operationsDashboard && !operationsClaims && !operationsRecovery && !review && !insightList && !insightCsv && !insight && !connection && !termsPath && !outcomePath && !reviewPath && !appealPath && !commissionPath && !paymentsPath && !webhookPath && !reconciliationPath && !reconciliationCsvPath && !replayPath && !retryDuePath && !billingPath && !caseListPath && !caseDetail && !caseEvidence && !caseClaim) {
    return false;
  }

  // Webhook 不走会话：先验签（原始 body），再决定是否处理
  if (webhookPath) {
    if ((req.method ?? 'GET') !== 'POST') {
      sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
      return true;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > 1024 * 1024) {
        sendJson(res, 413, { error: 'PAYLOAD_TOO_LARGE' });
        return true;
      }
      chunks.push(buffer);
    }
    const result = await handlePaymentWebhook(
      deps.prisma,
      {
        rawBody: Buffer.concat(chunks).toString('utf8'),
        signatureHeader:
          typeof req.headers['stripe-signature'] === 'string' ? req.headers['stripe-signature'] : undefined,
      },
      {
        ...(deps.now ? { now: deps.now } : {}),
        ...(deps.log ? { log: deps.log } : {}),
      },
    );
    sendJson(res, result.httpStatus, result);
    return true;
  }

  const method = req.method ?? 'GET';
  const allowed =
    connection && !connection[2]
      ? ['GET', 'POST']
      : reviewPath
        ? ['GET', 'POST']
        : billingPath && !billingPath[1]
          ? ['GET']
        : insightList || insightCsv || insight || appealPath || caseListPath || caseDetail || caseEvidence || caseClaim || reconciliationPath || reconciliationCsvPath
            ? ['GET']
            : ['POST'];
  if (!allowed.includes(method)) {
    sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    return true;
  }

  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  const context: SessionContext | null = token ? await resolveSession(token, deps.session) : null;
  if (!context) {
    sendJson(res, 401, { error: 'UNAUTHENTICATED' });
    return true;
  }

  const actor = {
    organizationId: context.organizationId,
    actorUserId: context.userId,
    role: context.role,
  };

  try {
    if (replayPath) {
      // C-0010-B2：重放（TD-PAYMENT-003：必须给出白名单原因；无 paymentId → 409）
      const body = await readJsonBody(req);
      const result = await replayPaymentEvent(
        deps.prisma,
        {
          organizationId: context.organizationId,
          actorUserId: context.userId,
          role: context.role,
          paymentEventId: replayPath[1] ?? '',
          reason: body.reason,
          note: body.note,
        },
        deps.now ? { now: deps.now } : {},
      );
      sendJson(res, 200, result);
      return true;
    }

    if (retryDuePath) {
      // C-0010-B2：自动重放到期 attempt（无队列 / 无后台线程；由宿主侧调度调用）
      const body = await readJsonBody(req);
      const result = await runDueRetries(
        deps.prisma,
        {
          organizationId: context.organizationId,
          role: context.role,
          ...(typeof body.limit === 'number' ? { limit: body.limit } : {}),
        },
        deps.now ? { now: deps.now } : {},
      );
      sendJson(res, 200, result);
      return true;
    }

    if (reconciliationPath || reconciliationCsvPath) {
      // C-0010-B：财务对账差异清单（只读；不做任何自动修账）
      const report = await listPaymentReconciliation(
        deps.prisma,
        { organizationId: context.organizationId, role: context.role },
        deps.now ? { now: deps.now } : {},
      );
      if (reconciliationCsvPath) {
        res.writeHead(200, {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': 'attachment; filename="payment-reconciliation.csv"',
          'cache-control': 'no-store',
        });
        res.end(toReconciliationCsv(report));
        return true;
      }
      sendJson(res, 200, report);
      return true;
    }

    if (paymentsPath) {
      // FINANCE 可见范围：发票支付状态 / 金额 / 时间；不含 provider 事件元数据与安全字段
      assertPermission(context.role, 'viewBilling');
      const items = await deps.prisma.payment.findMany({
        where: { organizationId: context.organizationId },
        orderBy: { createdAt: 'desc' },
        take: 200,
        select: {
          id: true,
          invoiceId: true,
          amount: true,
          currency: true,
          status: true,
          createdAt: true,
          invoice: { select: { invoiceNo: true, status: true } },
        },
      });
      sendJson(res, 200, {
        items: items.map((row) => ({
          id: row.id,
          invoiceId: row.invoiceId,
          invoiceNo: row.invoice?.invoiceNo ?? null,
          invoiceStatus: row.invoice?.status ?? null,
          amount: row.amount.toFixed(4),
          currency: row.currency,
          status: row.status,
          createdAt: row.createdAt,
        })),
      });
      return true;
    }

    if (commissionPath) {
      const body = await readJsonBody(req);
      const summary = await reconcilePayoutItems(
        deps.prisma,
        {
          ...actor,
          items: Array.isArray(body.items) ? (body.items as never[]) : [],
          dryRun: body.dryRun !== false,
        },
        { ...(deps.now ? { now: deps.now } : {}) },
      );
      sendJson(res, 200, summary);
      return true;
    }

    if (appealPath) {
      sendJson(
        res,
        200,
        await getAppealPackageState(
          deps.prisma,
          { organizationId: context.organizationId, role: context.role },
          appealPath[1] ?? '',
        ),
      );
      return true;
    }

    if (reviewPath) {
      const caseId = reviewPath[1] ?? '';
      if ((req.method ?? 'GET') === 'GET') {
        sendJson(
          res,
          200,
          await getRecoveryReviewStatus(
            deps.prisma,
            { organizationId: context.organizationId, role: context.role },
            caseId,
          ),
        );
        return true;
      }
      const body = await readJsonBody(req);
      const result = await submitRecoveryReview(
        deps.prisma,
        {
          ...actor,
          caseId,
          decision: body.decision,
          reason: body.reason,
          recoveredAmount: body.recoveredAmount,
          currency: body.currency,
        },
        deps.now,
      );
      sendJson(res, 200, result);
      return true;
    }

    if (insightCsv) {
      // D3：导出清单（架构方指定的 5 列；不含任何凭据/内部信息）
      const insights = await listOpportunityInsights(deps.prisma, {
        organizationId: context.organizationId,
        role: context.role,
      });
      const rows = toExportRows(insights);
      const header = ['opportunity_id', 'invoice_reference', 'recoverable_amount', 'rule_reason', 'evidence_reference'];
      const csv = [
        header.join(','),
        ...rows.map((row) =>
          [row.opportunityId, row.invoiceReference, row.recoverableAmount, row.ruleReason, row.evidenceReference]
            .map((cell) => `"${String(cell).replace(/"/g, '""')}"`)
            .join(','),
        ),
      ].join('\n');
      res.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="opportunities.csv"',
        'cache-control': 'no-store',
      });
      res.end(csv);
      return true;
    }
    if (insightList) {
      sendJson(res, 200, {
        items: await listOpportunityInsights(deps.prisma, {
          organizationId: context.organizationId,
          role: context.role,
        }),
      });
      return true;
    }
    if (insight) {
      sendJson(
        res,
        200,
        await getOpportunityInsight(
          deps.prisma,
          { organizationId: context.organizationId, role: context.role },
          insight[1] ?? '',
        ),
      );
      return true;
    }

    if (caseListPath) {
      sendJson(res, 200, {
        items: await listCases(deps.prisma, { organizationId: context.organizationId, role: context.role }),
      });
      return true;
    }
    if (caseDetail) {
      sendJson(
        res,
        200,
        await getCase(deps.prisma, { organizationId: context.organizationId, role: context.role }, caseDetail[1] ?? ''),
      );
      return true;
    }
    if (caseEvidence) {
      sendJson(res, 200, {
        items: await listCaseEvidence(
          deps.prisma,
          { organizationId: context.organizationId, role: context.role },
          caseEvidence[1] ?? '',
        ),
      });
      return true;
    }
    if (caseClaim) {
      // 正文只在此端点返回；列表接口不返回正文（裁定）
      sendJson(
        res,
        200,
        await getClaimDraft(
          deps.prisma,
          { organizationId: context.organizationId, role: context.role },
          caseClaim[1] ?? '',
        ),
      );
      return true;
    }

    // MSG-20260929-30：运营看板（只读投影；GET only；不写 AuditLog、无写路径）
    if (operationsDashboard || operationsClaims || operationsRecovery) {
      if ((req.method ?? 'GET') !== 'GET') {
        sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
        return true;
      }
      const query = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
      const dashboardDeps = { prisma: deps.prisma, ...(deps.now ? { now: deps.now } : {}) };
      if (operationsDashboard) {
        sendJson(
          res,
          200,
          await buildOperationsDashboard(dashboardDeps, {
            organizationId: context.organizationId,
            role: context.role,
            window: query.get('window') ?? undefined,
          }),
        );
        return true;
      }
      if (operationsClaims) {
        sendJson(
          res,
          200,
          await listClaimBucketDetail(dashboardDeps, {
            organizationId: context.organizationId,
            role: context.role,
            bucket: query.get('bucket') ?? undefined,
            cursor: query.get('cursor') ?? undefined,
            limit: query.get('limit') ?? undefined,
          }),
        );
        return true;
      }
      sendJson(
        res,
        200,
        await listRecoveryDetail(dashboardDeps, {
          organizationId: context.organizationId,
          role: context.role,
          cursor: query.get('cursor') ?? undefined,
          limit: query.get('limit') ?? undefined,
        }),
      );
      return true;
    }

    if (billingPath) {
      if (!billingPath[1]) {
        sendJson(res, 200, {
          items: await listBillingInvoices(deps.prisma, {
            organizationId: context.organizationId,
            role: context.role,
          }),
        });
        return true;
      }
      const body = await readJsonBody(req);
      const result = await advanceBillingInvoice(
        deps.prisma,
        {
          ...actor,
          invoiceId: billingPath[1],
          to: body.to,
          paymentReference: body.paymentReference,
          note: body.note,
        },
        deps.now,
      );
      sendJson(res, 200, result);
      return true;
    }

    if (outcomePath) {
      const body = await readJsonBody(req);
      // 裁定：不接受 simulateSettlement（用户侧永不触发合成资金）
      if (Object.prototype.hasOwnProperty.call(body, 'simulateSettlement')) {
        throw new WorkflowError(
          'INVALID_FIELD',
          'simulateSettlement 不允许由用户侧请求提交（仅测试/演示环境使用）',
        );
      }
      const outcome = await confirmRecoveryOutcome(
        deps.prisma,
        {
          ...actor,
          caseId: outcomePath[1] ?? '',
          recoveredAmount: body.recoveredAmount,
          currency: body.currency,
          basisReference: body.basisReference,
          evidenceArtifactId: body.evidenceArtifactId,
          note: body.note,
        },
        deps.now,
      );
      sendJson(res, outcome.created ? 201 : 200, outcome);
      return true;
    }

    if (termsPath) {
      const body = await readJsonBody(req);
      const confirmed = await confirmCommercialTerms(
        deps.prisma,
        {
          ...actor,
          caseId: termsPath[1] ?? '',
          commercialTerms: body.commercialTerms,
        },
        deps.now,
      );
      sendJson(res, 200, { ...confirmed, commercialTermsPending: false });
      return true;
    }

    if (connection) {
      const connectionId = connection[1];
      const sub = connection[2];

      if (!connectionId) {
        if (method === 'GET') {
          sendJson(res, 200, { items: await listConnections(deps.prisma, actor) });
          return true;
        }
        const body = await readJsonBody(req);
        const created = await createManagedConnection(
          deps.prisma,
          {
            ...actor,
            label: body.label,
            kind: body.kind,
            domain: body.domain,
            channel: body.channel,
            platform: body.platform,
            credentialRef: body.credentialRef,
          },
          { ...(deps.registeredPlatforms ? { registeredPlatforms: deps.registeredPlatforms } : {}), ...(deps.now ? { now: deps.now } : {}) },
        );
        sendJson(res, 201, created);
        return true;
      }

      const body = await readJsonBody(req);
      if (sub === 'status') {
        const result = await setConnectionStatus(
          deps.prisma,
          { ...actor, connectionId, to: body.to, reason: body.reason },
          { ...(deps.now ? { now: deps.now } : {}) },
        );
        sendJson(res, 200, result);
        return true;
      }

      const result = await rotateConnectionCredentialRef(
        deps.prisma,
        {
          ...actor,
          connectionId,
          credentialRef: body.credentialRef === undefined ? null : body.credentialRef,
        },
        { ...(deps.now ? { now: deps.now } : {}) },
      );
      sendJson(res, 200, result);
      return true;
    }

    const opportunityId = review?.[1] ?? '';
    if (review?.[2] === 'case') {
      const body = await readJsonBody(req);
      // 裁定 3：收到 simulateSettlement 一律拒绝，绝不静默忽略。
      if (Object.prototype.hasOwnProperty.call(body, 'simulateSettlement')) {
        throw new WorkflowError(
          'INVALID_FIELD',
          'simulateSettlement 不允许由用户侧请求提交（仅测试/演示环境使用）',
        );
      }
      const created = await createCaseForOpportunity(
        deps.prisma,
        {
          ...actor,
          opportunityId,
          commercialTerms: body.commercialTerms,
        },
        deps.now,
      );
      sendJson(res, 201, {
        caseId: created.caseId,
        caseNo: created.caseNo,
        opportunityId: created.opportunityId,
        claimId: created.claimId,
        created: created.created,
        // 费率是否仍待 OWNER / ADMIN 确认（B2-1 Step 1 业务条件）
        commercialTermsPending: created.commercialTermsPending,
      });
      return true;
    }

    const decision = review?.[2] === 'reject' ? 'REJECT' : 'QUALIFY';
    let reason: string | undefined;
    if (decision === 'REJECT') {
      const body = await readJsonBody(req);
      reason = requireString(body, 'reason');
    }

    const result = await reviewOpportunity(
      deps.prisma,
      {
        ...actor,
        opportunityId,
        decision,
        ...(reason !== undefined ? { reason } : {}),
      },
      deps.now,
    );

    sendJson(res, 200, {
      opportunityId: result.opportunityId,
      from: result.from,
      to: result.to,
      reason: result.reason,
    });
    return true;
  } catch (error) {
    const { code, error: name } = statusFor(error);
    sendJson(res, code, {
      error: name,
      ...(code === 400 && review?.[2] === 'reject' ? { allowedReasons: [...REJECT_REASONS] } : {}),
    });
    return true;
  }
}
