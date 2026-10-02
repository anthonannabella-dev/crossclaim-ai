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
import { ActionGuardApprovalVerificationError } from '../action-guard/approval-verifier';
import { createHitlSubmissionBoundary } from '../action-guard/hitl-submission';
import { ActionGuardNotConfiguredError } from '../action-guard/guard-enforcement';
import {
  APPEAL_SUBMIT_ACTION,
  CLAIM_SUBMIT_ACTION,
  PAYMENT_CAPTURE_ACTION,
  PAYMENT_REPLAY_ACTION,
  PAYMENT_RETRY_DUE_ACTION,
  RECOVERY_CONFIRMATION_ACTION,
} from '../action-guard/approval-verifier';
import {
  PAYMENT_APPROVAL_EVENT_ACTION,
  PAYMENT_CONSUMED_EVENT_ACTION,
  PAYMENT_REJECTED_EVENT_ACTION,
  PAYMENT_REPLAY_CONSUMED_EVENT_ACTION,
  PAYMENT_REQUIRED_EVENT_ACTION,
  PAYMENT_RETRY_DUE_CONSUMED_EVENT_ACTION,
} from '../action-guard/approval-tx-verify';
import { ApprovalBoundaryError } from '../action-guard/approval-tx-verify';
import { createPrismaActionGuardAuditPort } from '../action-guard/runtime-guard-composition';
import {
  PlatformWriteRequestError,
  requestPlatformWrite,
} from '../platform-write/http-request';
import {
  RecoveryManualHttpError,
  requestManualRecoveryReference,
  requestManualRecoverySubmit,
  requestManualRecoverySubmitApproval,
  requestManualRecoveryReferenceApproval,
} from '../recovery/http-request';
import { ManualReferenceError } from '../recovery/manual-reference';
import type { AuditWriter } from '../audit';
import { submitClaimWithApproval } from '../claims/claim-submission';
import { BILLING_DRAFT_ACTION, createBillingDraft } from '../billing/billing-draft';
import { submitAppealWithApproval } from '../appeals/appeal-submission';
import { buildAppealSubmissionSnapshot, appealSubmissionDigest } from '../appeals/appeal-snapshot';
import { EVIDENCE_READ_ACTION } from '../evidence/evidence-read';
import { CLAIM_PREPARE_ACTION, prepareClaimDraft } from '../claims/claim-preparation';
import {
  ActionGuardApprovalRequiredError,
  ActionGuardDeniedError,
  type RuntimeActionGuard,
} from '../action-guard/runtime-guard';
import { rebindLegacyConnection } from './connection-onboarding';
import { getRecoveryReviewStatus, submitRecoveryReview } from './recovery-review';
import { readReplaySnapshot, submitPaymentReplayReview, submitPaymentReview } from './payment';
import {
  executeRetryBatch,
  freezeRetryBatch,
  readRetryBatch,
  submitRetryBatchReview,
} from './payment-retry-batch';
import { advanceBillingInvoice, listBillingInvoices } from './billing';
import { getAppealPackageState } from './appeal-package';
import { reconcilePayoutItems } from './commission-reconciliation';
import { handlePaymentWebhook } from './payment-webhook';
import { listPaymentReconciliation, toReconciliationCsv } from './payment-reconciliation';
import { replayPaymentEvent } from './payment-attempt';
import { getCase, getClaimDraft, listCaseEvidence, listCases } from './case-read';
import { getMember, getPermissionMatrix, listMembers } from '../operations/admin-membership';
import {
  CsrfRejectedError,
  RateLimitedError,
  assertKillSwitchCsrf,
  changeKillSwitch,
  enforceKillSwitchRateLimit,
  getKillSwitchStatus,
  killSwitchConfigFromEnv,
} from '../operations/kill-switch';
import {
  createEffectiveKillSwitchResolver,
  type EffectiveKillSwitchResolver,
} from '../operations/kill-switch-resolver';
import {
  getRecoveryReviewItem,
  listRecoveryReviewQueue,
} from '../operations/admin-recovery-review';
import {
  getImportBatch,
  getImportQualitySummary,
  listImportBatches,
  listImportErrors,
} from '../operations/admin-imports';
import {
  assertAdminAccess,
  getAdminSystemHealth,
  getAuditEntry,
  getTenantOverview,
  listAuditEntries,
} from '../operations/admin-console';
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
const CONNECTION_PATH = /^\/connections(?:\/([^/]+)\/(status|credential-ref|rebind))?$/;
const COMMERCIAL_TERMS_PATH = /^\/cases\/([^/]+)\/commercial-terms$/;
const RECOVERY_OUTCOME_PATH = /^\/cases\/([^/]+)\/recovery-outcome$/;
const RECOVERY_REVIEW_PATH = /^\/cases\/([^/]+)\/recovery-review$/;
// R6：支付域审批入口（受认证会话；审批人 OWNER/ADMIN）
const PAYMENT_REVIEW_PATH = /^\/billing\/([^/]+)\/payment-review$/;
const APPEAL_PACKAGE_PATH = /^\/cases\/([^/]+)\/appeal-package$/;
const COMMISSION_RECONCILE_PATH = /^\/commissions\/reconcile$/;
const PAYMENTS_PATH = /^\/payments$/;
const PAYMENT_WEBHOOK_PATH = /^\/payments\/webhook$/;
const PAYMENTS_RECONCILIATION_PATH = /^\/payments\/reconciliation$/;
const PAYMENTS_RECONCILIATION_CSV_PATH = /^\/payments\/reconciliation\.csv$/;
const PAYMENT_REPLAY_PATH = /^\/payments\/events\/([^/]+)\/replay$/;
// ② 第二批 replay：最小受认证审批入口（REQUEST / APPROVE / REJECT）
const PAYMENT_REPLAY_REVIEW_PATH = /^\/payments\/events\/([^/]+)\/replay-review$/;
const PAYMENT_RETRY_DUE_PATH = /^\/payments\/processing\/retry-due$/;
// ② 第二批 retry-due：冻结清单（freeze）与批次审批（review）最小受认证入口
const PAYMENT_RETRY_DUE_FREEZE_PATH = /^\/payments\/processing\/retry-due\/freeze$/;
const PAYMENT_RETRY_DUE_REVIEW_PATH = /^\/payments\/processing\/retry-due\/review$/;
const BILLING_PATH = /^\/billing(?:\/([^/]+)\/status)?$/;
const CASE_LIST_PATH = /^\/cases$/;
const CASE_DETAIL_PATH = /^\/cases\/([^/]+)$/;
const CASE_EVIDENCE_PATH = /^\/cases\/([^/]+)\/evidence$/;
const CASE_CLAIM_PATH = /^\/cases\/([^/]+)\/claim$/;
// ② RUNTIME BUSINESS BLOCKING：claim.submit（人工提交入口；平台外写保持 NEEDS_MANUAL）
const CASE_CLAIM_SUBMIT_PATH = /^\/cases\/([^/]+)\/claim\/submit$/;
// ② 下一小批次（MSG-20261001-07 §6）：claim.prepare（内部准备写入 · INTERNAL_WRITE · 无人审批）
const CASE_CLAIM_PREPARE_PATH = /^\/cases\/([^/]+)\/claim\/prepare$/;
// ② 下一小批次（MSG-20261001-10 §5）：billing.draft（账单草稿写入 · INTERNAL_WRITE · 无人审批）
const CASE_BILLING_DRAFT_PATH = /^\/cases\/([^/]+)\/billing\/draft$/;
// ② 下一小批次（MSG-20261001-14 §5）：appeal.submit（Appeal 人工提交 · 独立动作与审批绑定）
const CASE_APPEAL_SUBMIT_PATH = /^\/cases\/([^/]+)\/appeal\/submit$/;
// R37 P1（MSG-20261001-22 CHANGE A）：平台真实写回入口（EXTERNAL_WRITE · transport 恒关）
const CASE_PLATFORM_WRITE_PATH = /^\/cases\/([^/]+)\/platform\/write$/;
// R44（MSG-20261001-39 NEXT）：人工追回提交入口（受保护动作 · 复用 R43 S3/S4 服务，不复制事务逻辑）
const CASE_RECOVERY_MANUAL_SUBMIT_PATH = /^\/cases\/([^/]+)\/recovery\/manual-submit$/;
const CASE_RECOVERY_MANUAL_REFERENCE_PATH = /^\/cases\/([^/]+)\/recovery\/manual-reference$/;
// R44-A（MSG-20261001-41 NEXT）：人工提交审批创建入口（只创建审批事实，不执行提交）
const CASE_RECOVERY_MANUAL_APPROVAL_PATH = /^\/cases\/([^/]+)\/recovery\/manual-submit-approval$/;
// R44-B（MSG-20261001-42 NEXT）：reference 补录的独立审批创建入口
const CASE_RECOVERY_MANUAL_REFERENCE_APPROVAL_PATH = /^\/cases\/([^/]+)\/recovery\/manual-reference-approval$/;
// MSG-20260929-30：运营看板（只读投影，GET only）
const OPERATIONS_DASHBOARD_PATH = /^\/operations\/dashboard$/;
const OPERATIONS_CLAIMS_PATH = /^\/operations\/claims$/;
const OPERATIONS_RECOVERY_PATH = /^\/operations\/recovery$/;
// MSG-20260929-34：Admin Console Phase 1（只读；A1/A3/A6）
const ADMIN_TENANT_OVERVIEW_PATH = /^\/admin\/tenant-overview$/;
const ADMIN_AUDIT_LIST_PATH = /^\/admin\/audit$/;
const ADMIN_AUDIT_DETAIL_PATH = /^\/admin\/audit\/([^/]+)$/;
const ADMIN_SYSTEM_HEALTH_PATH = /^\/admin\/system-health$/;
// MSG-20260929-36：Admin Phase 2 / A4（只读导入与校验运维视图）
const ADMIN_IMPORTS_PATH = /^\/admin\/imports$/;
const ADMIN_IMPORT_QUALITY_PATH = /^\/admin\/imports\/quality-summary$/;
const ADMIN_IMPORT_ERRORS_PATH = /^\/admin\/imports\/([^/]+)\/errors$/;
const ADMIN_IMPORT_DETAIL_PATH = /^\/admin\/imports\/([^/]+)$/;
// MSG-20260929-37：Admin Phase 3 / A5（只读恢复复核队列；无审批捷径）
const ADMIN_RECOVERY_REVIEW_PATH = /^\/admin\/recovery-review$/;
const ADMIN_RECOVERY_REVIEW_ITEM_PATH = /^\/admin\/recovery-review\/([^/]+)$/;
// MSG-20260929-39：Admin Phase 4 / A2（只读身份视图；无写路径、邮箱掩码）
const ADMIN_MEMBERS_PATH = /^\/admin\/members$/;
const ADMIN_PERMISSION_MATRIX_PATH = /^\/admin\/permission-matrix$/;
const ADMIN_MEMBER_DETAIL_PATH = /^\/admin\/members\/([^/]+)$/;
// MSG-20260929-53：Kill Switch 只读状态（GET only；变更路径不在本增量）
const ADMIN_KILL_SWITCH_PATH = /^\/admin\/kill-switch$/;

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
  /** MSG-20260929-68：由 server 创建的进程内 resolver 单例（未提供时回退到本地 WeakMap 缓存） */
  killSwitchResolver?: EffectiveKillSwitchResolver;
  /**
   * 授权项 ②（MSG-20260930-16 §6）：受保护业务入口必须经过 Action Guard。
   * 未注入时受保护入口**一律拒绝**（fail closed），不允许"无守卫直接执行"。
   */
  actionGuard?: RuntimeActionGuard;
  /** Platforms of the adapters registered in this deployment (API connections only). */
  registeredPlatforms?: readonly string[];
  now?: () => Date;
  /** 审计写入端口（缺省时按 server.ts 同策略自建；claim.submit 等受保护入口需要它记录人工提交） */
  audit?: AuditWriter;
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
  // MSG-20260929-60：Kill Switch 变更入口的两类边界错误
  if (error instanceof CsrfRejectedError) return { code: 403, error: error.code };
  if (error instanceof RateLimitedError) return { code: 429, error: error.code };
  // 授权项 ②：Action Guard 三类拒绝稳定映射（不吞、不转 500）
  if (error instanceof ActionGuardDeniedError) return { code: 403, error: error.code };
  if (error instanceof ActionGuardApprovalRequiredError) return { code: 409, error: error.code };
  if (error instanceof ActionGuardApprovalVerificationError) return { code: 403, error: error.code };
  if (error instanceof ActionGuardNotConfiguredError) return { code: 403, error: error.code };
  // R37 P1：platform.write 入口的结构化拒绝（客户端自证 / 幂等键不一致 / 目标不存在等）
  if (error instanceof PlatformWriteRequestError) return { code: error.httpStatus, error: error.code };
  // R44：人工追回提交入口的结构化拒绝（客户端自证 / 幂等键不一致 / 目标不存在等）
  if (error instanceof RecoveryManualHttpError) return { code: error.httpStatus, error: error.code };
  if (error instanceof ManualReferenceError) {
    return { code: error.code === 'PROVIDER_CASE_REF_CONFLICT' ? 409 : 400, error: error.code };
  }
  // R2：锁内审批核验失败 → 403 + 精确原因（APPROVAL_*）
  if (error instanceof ApprovalBoundaryError) return { code: 403, error: error.reason };
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
      case 'PAYMENT_SOURCE_CONFLICT':
      case 'ATTEMPT_ALREADY_RUNNING':
      case 'CLAIM_ITEM_CASE_REQUIRED':
      case 'BILLING_BASIS_REQUIRED':
      case 'BILLING_REISSUE_REQUIRES_NEW_NUMBER':
      case 'APPEAL_BODY_REQUIRED':
      case 'PLATFORM_ACCOUNT_REQUIRED':
      case 'ACCOUNT_BINDING_IMMUTABLE':
      case 'CONNECTION_NOT_ACTIVE':
      case 'UNVERIFIED_PLATFORM_IDENTITY':
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

function headerValue(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw;
}

/**
 * 生效值解析器（EFFECTIVE-KILL-SWITCH-RESOLUTION-DESIGN，MSG-20260929-65 GO）。
 * 进程内单例（按 prisma 客户端缓存）：只有单例才能让 §12.3 的进程内缓存生效。
 * 控制面写入成功后由写路径主动 invalidate。
 */
const killSwitchResolvers = new WeakMap<object, EffectiveKillSwitchResolver>();
function resolveKillSwitchResolver(deps: WorkflowRouteDeps): EffectiveKillSwitchResolver {
  return deps.killSwitchResolver ?? killSwitchResolverFor(deps.prisma);
}

function killSwitchResolverFor(prisma: PrismaClient): EffectiveKillSwitchResolver {
  let resolver = killSwitchResolvers.get(prisma);
  if (!resolver) {
    resolver = createEffectiveKillSwitchResolver({
      // 只读端口（I2：类型层面即无写路径）
      controlRequests: { findMany: (args) => prisma.killSwitchRequest.findMany(args) },
      config: killSwitchConfigFromEnv(),
    });
    killSwitchResolvers.set(prisma, resolver);
  }
  return resolver;
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
  const paymentReviewPath = PAYMENT_REVIEW_PATH.exec(path);
  const appealPath = APPEAL_PACKAGE_PATH.exec(path);
  const commissionPath = COMMISSION_RECONCILE_PATH.test(path);
  const paymentsPath = PAYMENTS_PATH.test(path);
  const webhookPath = PAYMENT_WEBHOOK_PATH.test(path);
  const reconciliationPath = PAYMENTS_RECONCILIATION_PATH.test(path);
  const reconciliationCsvPath = PAYMENTS_RECONCILIATION_CSV_PATH.test(path);
  const replayPath = PAYMENT_REPLAY_PATH.exec(path);
  const replayReviewPath = PAYMENT_REPLAY_REVIEW_PATH.exec(path);
  const retryDuePath = PAYMENT_RETRY_DUE_PATH.test(path);
  const retryDueFreezePath = PAYMENT_RETRY_DUE_FREEZE_PATH.exec(path);
  const retryDueReviewPath = PAYMENT_RETRY_DUE_REVIEW_PATH.exec(path);
  const billingPath = BILLING_PATH.exec(path);
  const caseListPath = CASE_LIST_PATH.test(path);
  const caseDetail = CASE_DETAIL_PATH.exec(path);
  const caseEvidence = CASE_EVIDENCE_PATH.exec(path);
  const caseClaim = CASE_CLAIM_PATH.exec(path);
  const caseClaimSubmit = CASE_CLAIM_SUBMIT_PATH.exec(path);
  const caseClaimPrepare = CASE_CLAIM_PREPARE_PATH.exec(path);
  const caseBillingDraft = CASE_BILLING_DRAFT_PATH.exec(path);
  const caseAppealSubmit = CASE_APPEAL_SUBMIT_PATH.exec(path);
  const casePlatformWrite = CASE_PLATFORM_WRITE_PATH.exec(path);
  const caseRecoveryManualSubmit = CASE_RECOVERY_MANUAL_SUBMIT_PATH.exec(path);
  const caseRecoveryManualReference = CASE_RECOVERY_MANUAL_REFERENCE_PATH.exec(path);
  const caseRecoveryManualApproval = CASE_RECOVERY_MANUAL_APPROVAL_PATH.exec(path);
  const caseRecoveryManualReferenceApproval = CASE_RECOVERY_MANUAL_REFERENCE_APPROVAL_PATH.exec(path);
  const operationsDashboard = OPERATIONS_DASHBOARD_PATH.test(path);
  const operationsClaims = OPERATIONS_CLAIMS_PATH.test(path);
  const operationsRecovery = OPERATIONS_RECOVERY_PATH.test(path);
  const adminTenantOverview = ADMIN_TENANT_OVERVIEW_PATH.test(path);
  const adminAuditList = ADMIN_AUDIT_LIST_PATH.test(path);
  const adminAuditDetail = ADMIN_AUDIT_DETAIL_PATH.exec(path);
  const adminSystemHealth = ADMIN_SYSTEM_HEALTH_PATH.test(path);
  const adminImportsList = ADMIN_IMPORTS_PATH.test(path);
  const adminImportQuality = ADMIN_IMPORT_QUALITY_PATH.test(path);
  const adminImportErrors = ADMIN_IMPORT_ERRORS_PATH.exec(path);
  const adminImportDetail = ADMIN_IMPORT_DETAIL_PATH.exec(path);
  const adminRecoveryReviewList = ADMIN_RECOVERY_REVIEW_PATH.test(path);
  const adminRecoveryReviewItem = ADMIN_RECOVERY_REVIEW_ITEM_PATH.exec(path);
  const adminMembersList = ADMIN_MEMBERS_PATH.test(path);
  const adminPermissionMatrix = ADMIN_PERMISSION_MATRIX_PATH.test(path);
  const adminMemberDetail = ADMIN_MEMBER_DETAIL_PATH.exec(path);
  const adminKillSwitch = ADMIN_KILL_SWITCH_PATH.test(path);
  const adminAny =
    adminTenantOverview ||
    adminAuditList ||
    adminAuditDetail !== null ||
    adminSystemHealth ||
    adminImportsList ||
    adminImportQuality ||
    adminImportErrors !== null ||
    adminImportDetail !== null ||
    adminRecoveryReviewList ||
    adminRecoveryReviewItem !== null ||
    adminMembersList ||
    adminPermissionMatrix ||
    adminMemberDetail !== null ||
    adminKillSwitch;
  if (!adminAny && !operationsDashboard && !operationsClaims && !operationsRecovery && !review && !insightList && !insightCsv && !insight && !connection && !termsPath && !outcomePath && !reviewPath && !paymentReviewPath && !appealPath && !commissionPath && !paymentsPath && !webhookPath && !reconciliationPath && !reconciliationCsvPath && !replayPath && !replayReviewPath && !retryDuePath && !retryDueFreezePath && !retryDueReviewPath && !billingPath && !caseListPath && !caseDetail && !caseEvidence && !caseClaim && !caseClaimSubmit && !caseClaimPrepare && !caseBillingDraft && !caseAppealSubmit && !casePlatformWrite && !caseRecoveryManualSubmit && !caseRecoveryManualReference && !caseRecoveryManualApproval && !caseRecoveryManualReferenceApproval) {
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
  // MSG-20260929-40：Admin Console 与 Operations 看板都是只读 GET 面。
  // 此前未登记，GET 请求在方法闸门处直接 405（与端点内的 GET-only 校验重复）。
  const allowed =
    // MSG-20260929-60：Kill Switch 变更入口是唯一的 Admin POST 面；其余 Admin 端点保持只读 GET
    adminKillSwitch
      ? ['GET', 'POST']
      : adminAny || operationsDashboard || operationsClaims || operationsRecovery
      ? ['GET']
      : connection && !connection[2]
        ? ['GET', 'POST']
        : reviewPath
          ? ['GET', 'POST']
          : billingPath && !billingPath[1]
            ? ['GET']
            : insightList ||
                insightCsv ||
                insight ||
                appealPath ||
                caseListPath ||
                caseDetail ||
                caseEvidence ||
                caseClaim ||
                reconciliationPath ||
                reconciliationCsvPath
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
    if (replayReviewPath) {
      // ② 第二批 replay：最小受认证审批入口（受认证会话；审批人 OWNER/ADMIN）
      const body = await readJsonBody(req);
      const result = await submitPaymentReplayReview(
        deps.prisma,
        {
          organizationId: context.organizationId,
          actorUserId: context.userId,
          role: context.role,
          paymentEventId: replayReviewPath[1] ?? '',
          decision: body.decision === 'APPROVE' ? 'APPROVE' : body.decision === 'REJECT' ? 'REJECT' : 'REQUEST',
          ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
          ...(typeof body.approvalTtlMs === 'number' ? { approvalTtlMs: body.approvalTtlMs } : {}),
        },
        deps.now ? { now: deps.now } : {},
      );
      sendJson(res, 200, result);
      return true;
    }

    if (replayPath) {
      // ② 第二批 replay：受保护资金动作（Action Guard + 服务端审批绑定；缺 approvalId → 409，不可绕过）
      const body = await readJsonBody(req);
      const paymentEventId = replayPath[1] ?? '';
      const approvalId = typeof body.approvalId === 'string' ? body.approvalId : undefined;
      if (!deps.actionGuard) {
        // fail closed：受保护入口必须在组合根注入 Action Guard
        throw new ActionGuardNotConfiguredError(PAYMENT_REPLAY_ACTION);
      }
      // 指纹由服务端组装（提交侧比对输入）；执行侧会在事件锁内重读事实再次比对
      const fingerprint = await readReplaySnapshot(deps.prisma, {
        organizationId: context.organizationId,
        paymentEventId,
      });
      const boundary = createHitlSubmissionBoundary({
        guard: deps.actionGuard,
        prisma: deps.prisma,
        approvalVerifier: {
          prisma: deps.prisma,
          approvalEventAction: PAYMENT_APPROVAL_EVENT_ACTION,
          requiredEventAction: PAYMENT_REQUIRED_EVENT_ACTION,
          rejectedEventAction: PAYMENT_REJECTED_EVENT_ACTION,
          // 支付域没有独立的 revoked 事件：拒绝即为撤销；不得回落到 recovery.approval_revoked
          revokedEventAction: PAYMENT_REJECTED_EVENT_ACTION,
          consumedEventAction: PAYMENT_REPLAY_CONSUMED_EVENT_ACTION,
          targetEntityType: 'PaymentEvent',
        },
        audit: createPrismaActionGuardAuditPort(deps.prisma),
      });
      const result = await boundary.submit({
        action: PAYMENT_REPLAY_ACTION,
        organizationId: context.organizationId,
        actorUserId: context.userId,
        targetRef: paymentEventId,
        approvalId,
        payload: {
          recoveredAmount: fingerprint.amount,
          currency: fingerprint.currency,
          basisReference: fingerprint.basisReference,
          evidenceArtifactId: fingerprint.evidenceArtifactId,
        },
        perform: () =>
          replayPaymentEvent(
            deps.prisma,
            {
              organizationId: context.organizationId,
              actorUserId: context.userId,
              role: context.role,
              paymentEventId,
              reason: body.reason,
              note: body.note,
              ...(approvalId ? { approvalId } : {}),
            },
            deps.now ? { now: deps.now } : {},
          ),
      });
      sendJson(res, 200, result);
      return true;
    }

    if (retryDueFreezePath) {
      // ② 第二批 retry-due：冻结当前到期清单（服务端 batchId + 排序清单指纹 + 有效期/数量上限）
      const body = await readJsonBody(req);
      const result = await freezeRetryBatch(
        deps.prisma,
        {
          organizationId: context.organizationId,
          actorUserId: context.userId,
          role: context.role,
          ...(typeof body.limit === 'number' ? { limit: body.limit } : {}),
          ...(typeof body.ttlMs === 'number' ? { ttlMs: body.ttlMs } : {}),
        },
        deps.now ? { now: deps.now } : {},
      );
      sendJson(res, 200, result);
      return true;
    }

    if (retryDueReviewPath) {
      // ② 第二批 retry-due：批次审批（REQUEST / APPROVE / REJECT；审批人 OWNER/ADMIN）
      const body = await readJsonBody(req);
      const result = await submitRetryBatchReview(
        deps.prisma,
        {
          organizationId: context.organizationId,
          actorUserId: context.userId,
          role: context.role,
          batchId: typeof body.batchId === 'string' ? body.batchId : '',
          decision: body.decision === 'APPROVE' ? 'APPROVE' : body.decision === 'REJECT' ? 'REJECT' : 'REQUEST',
          ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
          ...(typeof body.approvalTtlMs === 'number' ? { approvalTtlMs: body.approvalTtlMs } : {}),
        },
        deps.now ? { now: deps.now } : {},
      );
      sendJson(res, 200, result);
      return true;
    }

    if (retryDuePath) {
      // ② 第二批 retry-due：受保护执行（Action Guard + 批次审批；缺 approvalId → 409，不可绕过）
      const body = await readJsonBody(req);
      const batchId = typeof body.batchId === 'string' ? body.batchId : '';
      const approvalId = typeof body.approvalId === 'string' ? body.approvalId : undefined;
      if (!deps.actionGuard) {
        throw new ActionGuardNotConfiguredError(PAYMENT_RETRY_DUE_ACTION);
      }
      // 提交侧指纹输入：批次摘要（执行侧会在批次锁内重读并再次核对）
      const batch = await readRetryBatch(deps.prisma, {
        organizationId: context.organizationId,
        batchId,
      });
      if (!batch) throw new WorkflowError('NOT_FOUND', `批次 ${batchId} 不存在或不属于该租户`);
      const boundary = createHitlSubmissionBoundary({
        guard: deps.actionGuard,
        prisma: deps.prisma,
        approvalVerifier: {
          prisma: deps.prisma,
          approvalEventAction: PAYMENT_APPROVAL_EVENT_ACTION,
          requiredEventAction: PAYMENT_REQUIRED_EVENT_ACTION,
          rejectedEventAction: PAYMENT_REJECTED_EVENT_ACTION,
          revokedEventAction: PAYMENT_REJECTED_EVENT_ACTION,
          consumedEventAction: PAYMENT_RETRY_DUE_CONSUMED_EVENT_ACTION,
          targetEntityType: 'PaymentRetryBatch',
        },
        audit: createPrismaActionGuardAuditPort(deps.prisma),
      });
      const result = await boundary.submit({
        action: PAYMENT_RETRY_DUE_ACTION,
        organizationId: context.organizationId,
        actorUserId: context.userId,
        targetRef: batch.batchId,
        approvalId,
        payload: {
          recoveredAmount: null,
          currency: null,
          basisReference: batch.batchId,
          evidenceArtifactId: batch.digest,
        },
        perform: () =>
          executeRetryBatch(
            deps.prisma,
            {
              organizationId: context.organizationId,
              actorUserId: context.userId,
              role: context.role,
              batchId: batch.batchId,
              ...(approvalId ? { approvalId } : {}),
            },
            deps.now ? { now: deps.now } : {},
          ),
      });
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
          // CHANGE A（R2）：审批必须绑定"本次操作"的规范化载荷；动作由服务端固定，不接受客户端指定
          boundPayload:
            typeof body.decision === 'string' && body.decision.trim().toUpperCase() === 'APPROVE'
              ? {
                  recoveredAmount: body.recoveredAmount,
                  currency: body.currency,
                  basisReference: body.basisReference,
                  evidenceArtifactId: body.evidenceArtifactId,
                }
              : undefined,
          boundAction: RECOVERY_CONFIRMATION_ACTION,
        },
        deps.now,
      );
      sendJson(res, 200, result);
      return true;
    }

    if (paymentReviewPath) {
      const invoiceId = paymentReviewPath[1] ?? '';
      const body = await readJsonBody(req);
      const decision = typeof body.decision === 'string' ? body.decision.trim().toUpperCase() : '';
      const result = await submitPaymentReview(
        deps.prisma,
        {
          ...actor,
          invoiceId,
          decision: decision as 'REQUEST' | 'APPROVE' | 'REJECT',
          reason: typeof body.reason === 'string' ? body.reason : undefined,
          // R6 CHANGE A：审批必须绑定真实账单操作（金额/币种/依据 + from→to）
          ...(decision === 'APPROVE'
            ? {
                boundPayload: {
                  amount: body.amount,
                  currency: body.currency,
                  basisReference: body.basisReference ?? body.paymentReference,
                  evidenceArtifactId: body.evidenceArtifactId,
                  from: body.from,
                  to: body.to,
                },
                boundAction: PAYMENT_CAPTURE_ACTION,
                approvalTtlMs: typeof body.approvalTtlMs === 'number' ? body.approvalTtlMs : undefined,
              }
            : {}),
        },
        deps.now ? { now: deps.now } : {},
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
      // ② 下一小批次（MSG-20261001-13 §5）：证据读取受保护动作 evidence.read（READ_ONLY）
      if (!deps.actionGuard) {
        // fail closed：受保护入口必须在组合根注入 Action Guard
        throw new ActionGuardNotConfiguredError(EVIDENCE_READ_ACTION);
      }
      // 只读动作：无人工审批；能力状态不可用/缺 guard 时失败关闭。
      await deps.actionGuard.assertAllowed({
        action: EVIDENCE_READ_ACTION,
        actorUserId: actor.actorUserId,
        organizationId: actor.organizationId,
      });
      // 租户 / 主体权限 / 案件归属检查由既有只读投影完成（跨租户 404、无权限 403）
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

    if (caseClaimSubmit) {
      // ② RUNTIME BUSINESS BLOCKING：Claim 人工提交（HITL）——受保护动作 claim.submit
      const body = await readJsonBody(req);
      const caseId = caseClaimSubmit[1] ?? '';
      const approvalId = typeof body.approvalId === 'string' ? body.approvalId : undefined;
      if (!deps.actionGuard) {
        // fail closed：受保护入口必须在组合根注入 Action Guard
        throw new ActionGuardNotConfiguredError(CLAIM_SUBMIT_ACTION);
      }
      // 审批目标 = 案件（HITL 复核事件族挂在 Case 上，与第一批 /recovery-outcome 同域）
      const claim = await deps.prisma.claim.findFirst({
        where: { organizationId: actor.organizationId, caseId, round: 1 },
        select: { id: true, status: true },
      });
      if (!claim) {
        throw new WorkflowError('NOT_FOUND', `案件 ${caseId} 没有第 1 轮 Claim`);
      }
      const boundary = createHitlSubmissionBoundary({
        guard: deps.actionGuard,
        prisma: deps.prisma,
        audit: createPrismaActionGuardAuditPort(deps.prisma),
      });
      const outcome = await boundary.submit({
        action: CLAIM_SUBMIT_ACTION,
        organizationId: actor.organizationId,
        actorUserId: actor.actorUserId,
        targetRef: caseId,
        approvalId,
        // 审批指纹绑定：claim.submit 无金额语义 → 只绑定本轮 Claim 依据
        // （payload 字段名沿用既有契约：basisReference；资金动作仍必须带金额/币种/依据）
        payload: { basisReference: claim.id },
        // ALLOW 后进入**原子提交服务**：锁内完整重验审批与主体，并把
        // 「Claim CAS + claim.submitted_by_human + 审批消费」放在同一事务（R19 CHANGE A/B）
        perform: () =>
          submitClaimWithApproval(
            {
              organizationId: actor.organizationId,
              actorUserId: actor.actorUserId,
              role: actor.role,
              caseId,
              claimId: claim.id,
              ...(approvalId ? { approvalId } : {}),
              ...(typeof body.note === 'string' && body.note.trim() !== '' ? { note: body.note } : {}),
            },
            {
              prisma: deps.prisma,
              ...(deps.now ? { now: deps.now } : {}),
            },
          ),
      });
      // outcome 自带 externalSubmission='NEEDS_MANUAL' 与 platformWriteExecuted=false（零平台外写）
      sendJson(res, 200, outcome);
      return true;
    }

    if (caseClaimPrepare) {
      // ② 下一小批次：Claim 内部准备写入（受保护动作 claim.prepare · INTERNAL_WRITE）
      const body = await readJsonBody(req);
      const caseId = caseClaimPrepare[1] ?? '';
      if (!deps.actionGuard) {
        // fail closed：受保护入口必须在组合根注入 Action Guard
        throw new ActionGuardNotConfiguredError(CLAIM_PREPARE_ACTION);
      }
      // INTERNAL_WRITE：只需能力闸门（Kill Switch scope=workflow + 动作 feature + 控制面模式），
      // 不引入人工审批；审批只用于满足 humanApproval 的动作（claim.submit 等）。
      await deps.actionGuard.assertAllowed({
        action: CLAIM_PREPARE_ACTION,
        actorUserId: actor.actorUserId,
        organizationId: actor.organizationId,
      });
      // 放行后执行内部准备写入：租户隔离 + 动作权限 + 业务审计同事务（审计失败整笔回滚）
      const prepared = await prepareClaimDraft(
        {
          organizationId: actor.organizationId,
          actorUserId: actor.actorUserId,
          role: actor.role,
          caseId,
          target: typeof body.target === 'string' ? body.target : '',
          draftText: typeof body.draftText === 'string' ? body.draftText : '',
        },
        {
          prisma: deps.prisma,
          ...(deps.now ? { now: deps.now } : {}),
        },
      );
      // 内部准备写入：恒不触达平台，也不推进 Claim 状态
      sendJson(res, 200, prepared);
      return true;
    }

    if (caseAppealSubmit) {
      // ② 下一小批次：Appeal 人工提交（受保护动作 appeal.submit；与 claim.submit 互不通用）
      const body = await readJsonBody(req);
      const caseId = caseAppealSubmit[1] ?? '';
      if (!deps.actionGuard) {
        throw new ActionGuardNotConfiguredError(APPEAL_SUBMIT_ACTION);
      }
      // CHANGE B（MSG-20261001-15）：本批次只支持 round=2；多候选必须失败关闭（不任意取一条）
      const appealCandidates = await deps.prisma.appeal.findMany({
        where: { organizationId: actor.organizationId, caseId, round: 2 },
        select: { id: true, status: true, round: true, claimId: true, finalText: true, aiDraftText: true },
      });
      if (appealCandidates.length === 0) {
        throw new WorkflowError('NOT_FOUND', `案件 ${caseId} 没有 round=2 的 Appeal`);
      }
      if (appealCandidates.length > 1) {
        throw new WorkflowError('ILLEGAL_TRANSITION', '同一案件存在多条 round=2 Appeal，需人工澄清后再提交');
      }
      const appeal = appealCandidates[0]!;
      // CHANGE A：预检绑定与执行核验同一「服务端快照摘要」（空正文失败关闭）
      const snapshot = buildAppealSubmissionSnapshot({
        appealId: appeal.id,
        caseId,
        claimId: appeal.claimId,
        round: appeal.round,
        finalText: appeal.finalText,
        aiDraftText: appeal.aiDraftText,
      });
      if (!snapshot) throw new WorkflowError('APPEAL_BODY_REQUIRED', 'Appeal 正文为空，不能作为有效提交内容');
      const snapshotReference = appealSubmissionDigest(snapshot);
      const approvalId = typeof body.approvalId === 'string' ? body.approvalId : undefined;
      const boundary = createHitlSubmissionBoundary({
        guard: deps.actionGuard,
        prisma: deps.prisma,
        audit: createPrismaActionGuardAuditPort(deps.prisma),
      });
      const outcome = await boundary.submit({
        action: APPEAL_SUBMIT_ACTION,
        organizationId: actor.organizationId,
        actorUserId: actor.actorUserId,
        targetRef: caseId,
        approvalId,
        // 审批指纹绑定：appeal.submit 只绑定本条 Appeal 依据（与 claim.submit 不同的动作+载荷）
        payload: { basisReference: snapshotReference },
        perform: () =>
          submitAppealWithApproval(
            {
              organizationId: actor.organizationId,
              actorUserId: actor.actorUserId,
              role: actor.role,
              caseId,
              appealId: appeal.id,
              ...(approvalId ? { approvalId } : {}),
              ...(typeof body.note === 'string' && body.note.trim() !== '' ? { note: body.note } : {}),
            },
            { prisma: deps.prisma, ...(deps.now ? { now: deps.now } : {}) },
          ),
      });
      sendJson(res, 200, outcome);
      return true;
    }

    if (casePlatformWrite) {
      // R37 P1/P2：平台真实写回入口（EXTERNAL_WRITE · transport 恒关）
      // 快照/摘要由服务端重算，客户端自证字段一律拒绝；响应恒为 platformWriteExecuted=false。
      const body = await readJsonBody(req);
      const caseId = casePlatformWrite[1] ?? '';
      const result = await requestPlatformWrite(
        {
          organizationId: context.organizationId,
          actorUserId: context.userId,
          role: context.role,
          caseId,
        },
        body,
        {
          prisma: deps.prisma,
          ...(deps.actionGuard ? { actionGuard: deps.actionGuard } : {}),
        },
      );
      sendJson(res, result.httpStatus, result.body);
      return true;
    }
    if (caseRecoveryManualSubmit) {
      // R44：人工追回提交（受保护动作 recovery.manual_submit · 复用 R43 S3 服务；零平台外写）
      const body = await readJsonBody(req);
      const caseId = caseRecoveryManualSubmit[1] ?? '';
      const result = await requestManualRecoverySubmit(
        {
          organizationId: actor.organizationId,
          actorUserId: actor.actorUserId,
          role: actor.role,
          caseId,
        },
        body,
        {
          prisma: deps.prisma,
          ...(deps.actionGuard ? { actionGuard: deps.actionGuard } : {}),
          ...(deps.now ? { now: deps.now } : {}),
        },
      );
      sendJson(res, result.httpStatus, result.body);
      return true;
    }
    if (caseRecoveryManualReferenceApproval) {
      // R44-B：创建 reference 补录审批（canonical 恒服务端构造；不创建 Reference、不消费审批）
      const body = await readJsonBody(req);
      const caseId = caseRecoveryManualReferenceApproval[1] ?? '';
      const result = await requestManualRecoveryReferenceApproval(
        { organizationId: actor.organizationId, actorUserId: actor.actorUserId, role: actor.role, caseId },
        body,
        { prisma: deps.prisma, ...(deps.actionGuard ? { actionGuard: deps.actionGuard } : {}), ...(deps.now ? { now: deps.now } : {}) },
      );
      sendJson(res, result.httpStatus, result.body);
      return true;
    }
    if (caseRecoveryManualApproval) {
      // R44-A：创建人工提交审批（REQUEST / APPROVE；不执行提交、不消费审批）
      const body = await readJsonBody(req);
      const caseId = caseRecoveryManualApproval[1] ?? '';
      const result = await requestManualRecoverySubmitApproval(
        {
          organizationId: actor.organizationId,
          actorUserId: actor.actorUserId,
          role: actor.role,
          caseId,
        },
        body,
        {
          prisma: deps.prisma,
          ...(deps.actionGuard ? { actionGuard: deps.actionGuard } : {}),
          ...(deps.now ? { now: deps.now } : {}),
        },
      );
      sendJson(res, result.httpStatus, result.body);
      return true;
    }
    if (caseRecoveryManualReference) {
      // R44：人工提交后补录 provider case reference（独立受保护动作 · 独立 binding · append-only）
      const body = await readJsonBody(req);
      const caseId = caseRecoveryManualReference[1] ?? '';
      const result = await requestManualRecoveryReference(
        {
          organizationId: actor.organizationId,
          actorUserId: actor.actorUserId,
          role: actor.role,
          caseId,
        },
        body,
        {
          prisma: deps.prisma,
          ...(deps.actionGuard ? { actionGuard: deps.actionGuard } : {}),
          ...(deps.now ? { now: deps.now } : {}),
        },
      );
      sendJson(res, result.httpStatus, result.body);
      return true;
    }
    if (caseBillingDraft) {
      // ② 下一小批次：账单草稿写入（受保护动作 billing.draft · INTERNAL_WRITE）
      const body = await readJsonBody(req);
      const caseId = caseBillingDraft[1] ?? '';
      if (!deps.actionGuard) {
        // fail closed：受保护入口必须在组合根注入 Action Guard
        throw new ActionGuardNotConfiguredError(BILLING_DRAFT_ACTION);
      }
      // INTERNAL_WRITE：只需能力闸门（Kill Switch scope=billing + 动作 feature + 控制面模式），
      // 不引入人工审批；本批次不推进收款/到账/扣划，也不触达平台。
      await deps.actionGuard.assertAllowed({
        action: BILLING_DRAFT_ACTION,
        actorUserId: actor.actorUserId,
        organizationId: actor.organizationId,
      });
      const drafted = await createBillingDraft(
        {
          organizationId: actor.organizationId,
          actorUserId: actor.actorUserId,
          role: actor.role,
          caseId,
          ...(typeof body.note === 'string' ? { note: body.note } : {}),
        },
        {
          prisma: deps.prisma,
          ...(deps.now ? { now: deps.now } : {}),
        },
      );
      sendJson(res, 200, drafted);
      return true;
    }

    // MSG-20260929-53：Kill Switch 只读状态；MSG-20260929-60：新增变更入口（POST /admin/kill-switch）
    if (adminKillSwitch) {
      if (method === 'GET') {
        sendJson(
          res,
          200,
          await getKillSwitchStatus(
            {
              prisma: deps.prisma,
              config: killSwitchConfigFromEnv(),
              // 生效值 = Config Layer 与 Control Plane 的只读合成投影（不落库）
              effective: (scope, organizationId) =>
                resolveKillSwitchResolver(deps).resolve(scope, organizationId),
            },
            { organizationId: context.organizationId, role: context.role },
            { ...(deps.now ? { now: deps.now } : {}) },
          ),
        );
        return true;
      }
      // 1) CSRF：同源（Origin/Referer ↔ Host）+ 自定义头，服务端强制
      assertKillSwitchCsrf({
        origin: headerValue(req.headers.origin),
        referer: headerValue(req.headers.referer),
        host: headerValue(req.headers.host),
        csrfHeader: headerValue(req.headers['x-crossclaim-csrf']),
      });
      // 2) 速率限制（SECURITY_INCIDENT 例外；紧急路径仍必须留痕）
      const body = await readJsonBody(req);
      enforceKillSwitchRateLimit(actor, body.scope, body.reasonCode);
      // 3) 变更（幂等 / 双人确认 / CAS / 审计同事务）
      const changeResult = await changeKillSwitch(
        { prisma: deps.prisma, config: killSwitchConfigFromEnv() },
        actor,
        {
          scope: body.scope,
          target: body.target,
          phase: body.phase,
          reasonCode: body.reasonCode,
          ...(body.note !== undefined ? { note: body.note } : {}),
          ...(body.requestId !== undefined ? { requestId: body.requestId } : {}),
          idempotencyKey: body.idempotencyKey,
        },
        { ...(deps.now ? { now: deps.now } : {}) },
      );
      // 控制面写入成功后主动失效该租户缓存（§12.3；跨实例陈旧窗口 <= TTL）
      if (typeof body.scope === 'string') {
        resolveKillSwitchResolver(deps).invalidate(context.organizationId, body.scope);
      }
      sendJson(res, 200, changeResult);
      return true;
    }

    // MSG-20260929-39：Admin Phase 4 / A2（只读身份视图；GET only；无写路径）
    if (adminMembersList || adminPermissionMatrix || adminMemberDetail) {
      if ((req.method ?? 'GET') !== 'GET') {
        sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
        return true;
      }
      const memberQuery = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
      const memberActor = { organizationId: context.organizationId, role: context.role };
      // MSG-20260929-40：A2 三端点统一走 Admin 模块鉴权。
      // 修正前 /admin/permission-matrix 在路由层没有任何角色校验（服务层也不校验），
      // 任何已登录角色（含 VIEWER）都能读到完整角色×权限矩阵。
      assertAdminAccess(context.role, 'userMembership');
      if (adminPermissionMatrix) {
        sendJson(res, 200, getPermissionMatrix());
        return true;
      }
      if (adminMembersList) {
        sendJson(
          res,
          200,
          await listMembers(
            { prisma: deps.prisma },
            {
              ...memberActor,
              filter: { cursor: memberQuery.get('cursor') ?? undefined, limit: memberQuery.get('limit') ?? undefined },
            },
          ),
        );
        return true;
      }
      sendJson(
        res,
        200,
        await getMember({ prisma: deps.prisma }, { ...memberActor, userId: adminMemberDetail?.[1] ?? '' }),
      );
      return true;
    }

    // MSG-20260929-37：Admin Phase 3 / A5（只读；GET only；无审批端点、无金额）
    if (adminRecoveryReviewList || adminRecoveryReviewItem) {
      if ((req.method ?? 'GET') !== 'GET') {
        sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
        return true;
      }
      const reviewQuery = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
      const reviewDeps = { prisma: deps.prisma, ...(deps.now ? { now: deps.now } : {}) };
      const reviewActor = { organizationId: context.organizationId, role: context.role };
      if (adminRecoveryReviewList) {
        sendJson(
          res,
          200,
          await listRecoveryReviewQueue(reviewDeps, {
            ...reviewActor,
            filter: {
              bucket: reviewQuery.get('bucket') ?? undefined,
              cursor: reviewQuery.get('cursor') ?? undefined,
              limit: reviewQuery.get('limit') ?? undefined,
            },
          }),
        );
        return true;
      }
      sendJson(
        res,
        200,
        await getRecoveryReviewItem(reviewDeps, {
          ...reviewActor,
          caseId: adminRecoveryReviewItem?.[1] ?? '',
        }),
      );
      return true;
    }

    // MSG-20260929-36：Admin Phase 2 / A4（只读；GET only；无下载、无金额、无原始行）
    if (adminImportsList || adminImportQuality || adminImportErrors || adminImportDetail) {
      if ((req.method ?? 'GET') !== 'GET') {
        sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
        return true;
      }
      const importQuery = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
      const importDeps = { prisma: deps.prisma, ...(deps.now ? { now: deps.now } : {}) };
      const importActor = { organizationId: context.organizationId, role: context.role };
      if (adminImportsList) {
        sendJson(
          res,
          200,
          await listImportBatches(importDeps, {
            ...importActor,
            filter: {
              bucket: importQuery.get('bucket') ?? undefined,
              channel: importQuery.get('channel') ?? undefined,
              cursor: importQuery.get('cursor') ?? undefined,
              limit: importQuery.get('limit') ?? undefined,
            },
          }),
        );
        return true;
      }
      if (adminImportQuality) {
        sendJson(res, 200, await getImportQualitySummary(importDeps, importActor));
        return true;
      }
      if (adminImportErrors) {
        sendJson(
          res,
          200,
          await listImportErrors(importDeps, {
            ...importActor,
            batchId: adminImportErrors[1] ?? '',
            limit: importQuery.get('limit') ?? undefined,
          }),
        );
        return true;
      }
      sendJson(
        res,
        200,
        await getImportBatch(importDeps, { ...importActor, batchId: adminImportDetail?.[1] ?? '' }),
      );
      return true;
    }

    // MSG-20260929-34：Admin Console Phase 1（只读；GET only；不写 AuditLog、无写路径）
    if (adminAny) {
      if ((req.method ?? 'GET') !== 'GET') {
        sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
        return true;
      }
      const adminQuery = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
      const adminDeps = { prisma: deps.prisma, ...(deps.now ? { now: deps.now } : {}) };
      const actor = { organizationId: context.organizationId, role: context.role };
      if (adminTenantOverview) {
        sendJson(res, 200, await getTenantOverview(adminDeps, actor));
        return true;
      }
      if (adminAuditList) {
        sendJson(
          res,
          200,
          await listAuditEntries(adminDeps, {
            ...actor,
            filter: {
              action: adminQuery.get('action') ?? undefined,
              actorUserId: adminQuery.get('actorUserId') ?? undefined,
              entityType: adminQuery.get('entityType') ?? undefined,
              entityId: adminQuery.get('entityId') ?? undefined,
              from: adminQuery.get('from') ?? undefined,
              to: adminQuery.get('to') ?? undefined,
              cursor: adminQuery.get('cursor') ?? undefined,
              limit: adminQuery.get('limit') ?? undefined,
            },
          }),
        );
        return true;
      }
      if (adminAuditDetail) {
        sendJson(res, 200, await getAuditEntry(adminDeps, { ...actor, auditId: adminAuditDetail[1] ?? '' }));
        return true;
      }
      sendJson(res, 200, await getAdminSystemHealth(adminDeps, actor));
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
      // P4（② 第二批）：资金/状态推进是受保护动作 payment.capture —— 守卫 + 支付域审批绑定
      const approvalId = typeof body.approvalId === 'string' ? body.approvalId : undefined;
      if (!deps.actionGuard) {
        throw new ActionGuardNotConfiguredError(PAYMENT_CAPTURE_ACTION);
      }
      const boundary = createHitlSubmissionBoundary({
        guard: deps.actionGuard,
        prisma: deps.prisma,
        // 支付域审批族（挂 BillingInvoice），与 recovery 的 Case 族分开
        approvalVerifier: {
          prisma: deps.prisma,
          approvalEventAction: PAYMENT_APPROVAL_EVENT_ACTION,
          requiredEventAction: PAYMENT_REQUIRED_EVENT_ACTION,
          rejectedEventAction: PAYMENT_REJECTED_EVENT_ACTION,
          // 支付域没有独立的 revoked 事件：拒绝即为撤销；不得回落到 recovery.approval_revoked
          revokedEventAction: PAYMENT_REJECTED_EVENT_ACTION,
          consumedEventAction: PAYMENT_CONSUMED_EVENT_ACTION,
          targetEntityType: 'BillingInvoice',
        },
        audit: createPrismaActionGuardAuditPort(deps.prisma),
      });
      const result = await boundary.submit({
        action: PAYMENT_CAPTURE_ACTION,
        organizationId: actor.organizationId,
        actorUserId: actor.actorUserId,
        targetRef: billingPath[1] ?? '',
        approvalId,
        payload: {
          recoveredAmount: body.amount,
          currency: body.currency,
          basisReference: body.paymentReference ?? body.note,
          evidenceArtifactId: body.evidenceArtifactId,
        },
        perform: () =>
          advanceBillingInvoice(
            deps.prisma,
            {
              ...actor,
              invoiceId: billingPath[1],
              to: body.to,
              paymentReference: body.paymentReference,
              note: body.note,
              ...(approvalId
                ? {
                    approvalId,
                    // 与服务端审批绑定的同一规范化载荷（锁内重验逐项比对）
                    approvalPayload: {
                      amount: body.amount,
                      currency: body.currency,
                      basisReference: body.paymentReference ?? body.note,
                      evidenceArtifactId: body.evidenceArtifactId,
                    },
                  }
                : {}),
            },
            deps.now,
          ),
      });
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
      const caseId = outcomePath[1] ?? '';
      const approvalId = typeof body.approvalId === 'string' ? body.approvalId : undefined;
      if (!deps.actionGuard) {
        // fail closed：受保护入口必须在组合根注入 Action Guard
        throw new ActionGuardNotConfiguredError('commission.charge');
      }
      // 资金确认是受保护动作：闸门 + 服务端审批绑定（HITL 复核状态）双重校验，
      // 拒绝/审批不通过/能力或审计异常时 confirmRecoveryOutcome 不会被调用（零业务副作用）。
      const boundary = createHitlSubmissionBoundary({
        guard: deps.actionGuard,
        prisma: deps.prisma,
        // CHANGE D：审批核验结果写入可关联的安全审计（action_guard.approval_decision）
        audit: createPrismaActionGuardAuditPort(deps.prisma),
      });
      const outcome = await boundary.submit({
        action: 'commission.charge',
        organizationId: actor.organizationId,
        actorUserId: actor.actorUserId,
        targetRef: caseId,
        approvalId,
        // CHANGE A：把本次提交载荷交给审批校验逐项比对（金额/币种/依据/证据）
        payload: {
          recoveredAmount: body.recoveredAmount,
          currency: body.currency,
          basisReference: body.basisReference,
          evidenceArtifactId: body.evidenceArtifactId,
        },
        perform: () =>
          confirmRecoveryOutcome(
            deps.prisma,
            {
              ...actor,
              caseId,
              recoveredAmount: body.recoveredAmount,
              currency: body.currency,
              basisReference: body.basisReference,
              evidenceArtifactId: body.evidenceArtifactId,
              note: body.note,
              // CHANGE A（R2）：把审批与操作身份贯穿到资金执行（原子消费的前提）
              approvalId,
              operationId: approvalId ? `approval:${approvalId}` : undefined,
            },
            deps.now,
          ),
      });
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
            account: body.account,
          },
          { ...(deps.registeredPlatforms ? { registeredPlatforms: deps.registeredPlatforms } : {}), ...(deps.now ? { now: deps.now } : {}) },
        );
        sendJson(res, 201, created);
        return true;
      }

      const body = await readJsonBody(req);
      if (sub === 'rebind') {
        // MSG-20261002-78 T3：legacy unbound 的显式一次性追认（NULL → account，只影响未来行为）。
        const rebound = await rebindLegacyConnection(
          deps.prisma,
          {
            ...actor,
            connectionId,
            targetPlatformAccountId: body.targetPlatformAccountId,
            reason: body.reason,
          },
          { ...(deps.now ? { now: deps.now } : {}) },
        );
        sendJson(res, 200, rebound);
        return true;
      }
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
    // MSG-33 CHANGE A：错误响应必须带**非空**领域名，便于调用方断言具体原因
    const errorName =
      typeof name === 'string' && name !== ''
        ? name
        : typeof (error as { code?: unknown })?.code === 'string' && (error as { code?: string }).code !== ''
          ? String((error as { code?: string }).code)
          : 'UNEXPECTED_ERROR';
    const reason =
      error instanceof ActionGuardApprovalVerificationError
        ? error.reason
        : error instanceof ApprovalBoundaryError
          ? error.reason
          : undefined;
    sendJson(res, code, {
      error: errorName,
      ...(reason && reason !== 'VERIFIER_MISSING' ? { reason } : {}),
      ...(code === 400 && review?.[2] === 'reject' ? { allowedReasons: [...REJECT_REASONS] } : {}),
    });
    return true;
  }
}
