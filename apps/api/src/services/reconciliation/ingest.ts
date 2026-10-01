/**
 * R45 S2 —— Outcome / Reimbursement **ingest**（不含 projector、不含人工受保护写路径）
 * ---------------------------------------------------------------------------
 * 依据：MSG-20261001-47 Q3 —— 批准进入 R45 S2，范围严格限定为：
 *   ProviderOutcomeFact / ReimbursementFact ingest + server-side identity/fingerprint
 *   + replay idempotency + reversal ingest。**不实现 projector**，也**不提前开放**
 *   人工 outcome 的完整受保护 HTTP 路径（人工 approval/evidence 写边界留到 S4）。
 *
 * 语义（MSG-20261001-47 Q3 预登记验收）：
 *   - same external event → **same existing fact**（幂等复用，不是 duplicate → error/new fact）；
 *   - same providerEventId + different resource identity → **distinct facts**（不得误去重）；
 *   - same reversal replay → existing reversal；
 *   - different reversal event → same OBSERVED already fully reversed → **fail-closed**。
 *
 * 复用（R10）：canonical provider reference（R43 S4 canonicalizer）、currency canonicalizer、
 *   R45 S1 已落库的数据库不变量（fingerprint 唯一 / append-only / 冲正同源性 / partial unique）。
 * 边界：NO Settlement · NO Billing · NO Fee · NO RecoveryLedger mutation · NO platform write。
 */

import type { PrismaClient, ProviderOutcomeFact, ReimbursementFact } from '@prisma/client';
import type { Prisma } from '@prisma/client';

import { canonicalCurrency } from '../claim/source-fingerprint';
import { canonicalizeProviderCaseRef } from '../recovery/manual-reference';
import {
  PROVIDER_EVENT_FINGERPRINT_VERSION,
  ProviderEventIdentityError,
  canonicalProvider,
  providerEventFingerprintV1,
  type ProviderOutcomeKind,
  type ReimbursementKind,
} from './fingerprint';
import type { ProviderEventFingerprintInput } from './fingerprint';

export type IngestOutcome = 'CREATED' | 'REUSED';

export interface IngestResult<TFact> {
  outcome: IngestOutcome;
  fact: TFact;
}

export class ReconciliationIngestError extends Error {
  readonly code: string;
  readonly detail?: string;

  constructor(code: string, message: string, detail?: string) {
    super(code + ': ' + message);
    this.name = 'ReconciliationIngestError';
    this.code = code;
    this.detail = detail;
  }
}

/** v1：仅允许自动化来源进入 ingest；人工来源的受保护写路径属于 S4 */
export const AUTOMATED_SOURCE_KINDS = ['OFFICIAL_API', 'PLATFORM_REPORT'] as const;
export type AutomatedSourceKind = (typeof AUTOMATED_SOURCE_KINDS)[number];
export type IngestSourceKind = AutomatedSourceKind | 'MANUAL_WITH_EVIDENCE';

interface CommonIngestInput {
  organizationId: string;
  provider: string;
  /** 资源空间（区分同一 ID 在不同资源空间 —— CHANGE B） */
  sourceResource: string;
  providerEventId?: string | null;
  /** 无稳定事件 ID 时的服务端规范来源身份 */
  canonicalSourceIdentity?: string | null;
  sourceKind: IngestSourceKind;
  sourceRef: string;
  capturedAt: Date;
  parserVersion?: string | null;
  ingestedByUserId: string;
  reasonCode?: string | null;
  note?: string | null;
}

export interface ProviderOutcomeIngestInput extends CommonIngestInput {
  caseId: string;
  claimItemId?: string | null;
  kind: ProviderOutcomeKind;
  /** 用户/来源提供的原始引用；canonical 恒由服务端构造 */
  providerCaseRefRaw?: string | null;
  occurredAt: Date;
  evidenceArtifactIds?: string[];
}

export interface ReimbursementIngestInput extends CommonIngestInput {
  claimItemId?: string | null;
  caseId?: string | null;
  kind: ReimbursementKind;
  /** 仅 OBSERVED 使用；冲正行不携带独立金额语义 */
  amount?: string | number | null;
  currency: string;
  occurredAt: Date;
  /** 冲正必填：被冲正的 OBSERVED 事实 */
  reversesFactId?: string | null;
  providerCaseRefRaw?: string | null;
  orderRef?: string | null;
  rawRefs?: unknown;
  evidenceArtifactIds?: string[];
}

function requireNonEmpty(value: string | null | undefined, code: string, label: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length === 0) {
    throw new ReconciliationIngestError(code, label + ' 必填');
  }
  return text;
}

function assertAutomatedSource(input: CommonIngestInput): AutomatedSourceKind {
  if (input.sourceKind === 'MANUAL_WITH_EVIDENCE') {
    // MSG-20261001-47 Q3：人工 outcome 的 approval/evidence 写边界属于 S4，S2 不得提前接受
    throw new ReconciliationIngestError(
      'MANUAL_PATH_DEFERRED',
      '人工录入（MANUAL_WITH_EVIDENCE）必须走 S4 的受保护路径（humanApproval + evidence），S2 ingest 不接收',
    );
  }
  if (!(AUTOMATED_SOURCE_KINDS as readonly string[]).includes(input.sourceKind)) {
    throw new ReconciliationIngestError('INVALID_SOURCE_KIND', 'sourceKind 不在允许集合内');
  }
  return input.sourceKind;
}

function canonicalCurrencyOrFail(currency: string): string {
  const canonical = canonicalCurrency(requireNonEmpty(currency, 'CURRENCY_REQUIRED', 'currency'));
  if (!/^[A-Z]{3}$/.test(canonical)) {
    throw new ReconciliationIngestError('INVALID_CURRENCY', 'currency 必须是 ISO-4217 三字母（大写）');
  }
  return canonical;
}

function canonicalRefOrNull(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  return canonicalizeProviderCaseRef(raw);
}

function isPrismaError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === code;
}

function prismaErrorTarget(error: unknown): string {
  const meta = (error as { meta?: { target?: unknown; message?: unknown; code?: unknown } }).meta;
  if (!meta) return '';
  return [meta.target, meta.message, meta.code].map((v) => (typeof v === 'string' ? v : JSON.stringify(v ?? ''))).join(' ');
}

function mapDbInvariantError(error: unknown): never {
  if (isPrismaError(error, 'P2010') || isPrismaError(error, 'P2004')) {
    const detail = prismaErrorTarget(error);
    throw new ReconciliationIngestError('DB_INVARIANT_REJECTED', '数据库不变量拒绝该写入', detail);
  }
  throw error;
}

/**
 * 身份错误统一暴露为 ingest 层错误码（调用方只需处理一套错误 taxonomy）。
 */
function computeFingerprint(input: ProviderEventFingerprintInput): string {
  try {
    return providerEventFingerprintV1(input).fingerprint;
  } catch (error) {
    if (error instanceof ProviderEventIdentityError) {
      throw new ReconciliationIngestError(error.code, error.message);
    }
    throw error;
  }
}

/**
 * claimItem / case 弱引用归属校验（防御性）：不建 FK，但 ingest 必须先证明同租户。
 */
async function assertClaimItemOwnership(
  prisma: PrismaClient,
  organizationId: string,
  claimItemId: string | null | undefined,
  caseId?: string | null,
): Promise<void> {
  if (!claimItemId) return;
  const claimItem = await prisma.claimItem.findUnique({
    where: { id: claimItemId },
    select: { organizationId: true, caseId: true },
  });
  if (!claimItem) {
    throw new ReconciliationIngestError('CLAIM_ITEM_NOT_FOUND', 'claimItemId 不存在');
  }
  if (claimItem.organizationId !== organizationId) {
    throw new ReconciliationIngestError('CROSS_TENANT_REFERENCE', 'claimItemId 属于其他租户');
  }
  if (caseId && claimItem.caseId && claimItem.caseId !== caseId) {
    throw new ReconciliationIngestError('CASE_BINDING_MISMATCH', 'caseId 与 ClaimItem.caseId 不一致');
  }
}

/**
 * ProviderOutcomeFact ingest（append-only；重复外部事件 → 复用既有事实）。
 */
export async function ingestProviderOutcomeFact(
  prisma: PrismaClient,
  input: ProviderOutcomeIngestInput,
): Promise<IngestResult<ProviderOutcomeFact>> {
  const organizationId = requireNonEmpty(input.organizationId, 'ORGANIZATION_REQUIRED', 'organizationId');
  const caseId = requireNonEmpty(input.caseId, 'CASE_REQUIRED', 'caseId');
  const sourceRef = requireNonEmpty(input.sourceRef, 'SOURCE_REF_REQUIRED', 'sourceRef');
  const ingestedByUserId = requireNonEmpty(input.ingestedByUserId, 'ACTOR_REQUIRED', 'ingestedByUserId');
  const provider = canonicalProvider(requireNonEmpty(input.provider, 'PROVIDER_REQUIRED', 'provider'));
  const sourceKind = assertAutomatedSource(input);
  await assertClaimItemOwnership(prisma, organizationId, input.claimItemId, caseId);

  const fingerprint = computeFingerprint({
    provider,
    sourceResource: input.sourceResource,
    eventKind: input.kind,
    providerEventId: input.providerEventId,
    canonicalSourceIdentity: input.canonicalSourceIdentity,
  });

  try {
    const fact = await prisma.providerOutcomeFact.create({
      data: {
        organizationId,
        caseId,
        claimItemId: input.claimItemId ?? null,
        provider,
        kind: input.kind,
        providerCaseRefCanonical: canonicalRefOrNull(input.providerCaseRefRaw),
        occurredAt: input.occurredAt,
        providerEventId: input.providerEventId?.trim() || null,
        providerEventFingerprint: fingerprint,
        fingerprintVersion: PROVIDER_EVENT_FINGERPRINT_VERSION,
        sourceKind,
        sourceRef,
        capturedAt: input.capturedAt,
        parserVersion: input.parserVersion ?? null,
        ingestedByUserId,
        evidenceArtifactIds: input.evidenceArtifactIds ?? [],
        reasonCode: input.reasonCode ?? null,
        note: input.note ?? null,
      },
    });
    return { outcome: 'CREATED', fact };
  } catch (error) {
    if (isPrismaError(error, 'P2002') && prismaErrorTarget(error).includes('providerEventFingerprint')) {
      const existing = await prisma.providerOutcomeFact.findUnique({
        where: { organizationId_providerEventFingerprint: { organizationId, providerEventFingerprint: fingerprint } },
      });
      if (!existing) throw error;
      return { outcome: 'REUSED', fact: existing };
    }
    mapDbInvariantError(error);
  }
}

/**
 * ReimbursementFact ingest（OBSERVED / REIMBURSEMENT_REVERSED）。
 * 冲正：自身指纹幂等；不同冲正事件指向同一 OBSERVED → fail-closed（partial unique 兜底）。
 */
export async function ingestReimbursementFact(
  prisma: PrismaClient,
  input: ReimbursementIngestInput,
): Promise<IngestResult<ReimbursementFact>> {
  const organizationId = requireNonEmpty(input.organizationId, 'ORGANIZATION_REQUIRED', 'organizationId');
  const sourceRef = requireNonEmpty(input.sourceRef, 'SOURCE_REF_REQUIRED', 'sourceRef');
  const ingestedByUserId = requireNonEmpty(input.ingestedByUserId, 'ACTOR_REQUIRED', 'ingestedByUserId');
  const provider = canonicalProvider(requireNonEmpty(input.provider, 'PROVIDER_REQUIRED', 'provider'));
  const currency = canonicalCurrencyOrFail(input.currency);
  const sourceKind = assertAutomatedSource(input);
  await assertClaimItemOwnership(prisma, organizationId, input.claimItemId, input.caseId ?? null);

  let amountValue: string | null = null;
  let reversesFactId: string | null = null;

  if (input.kind === 'OBSERVED') {
    if (input.amount === null || input.amount === undefined || input.amount === '') {
      throw new ReconciliationIngestError('AMOUNT_REQUIRED', 'OBSERVED 必须提供 amount');
    }
    const numeric = typeof input.amount === 'number' ? input.amount : Number(String(input.amount));
    if (!Number.isFinite(numeric) || numeric <= 0) {
      throw new ReconciliationIngestError('AMOUNT_MUST_BE_POSITIVE', 'OBSERVED.amount 必须 > 0（冲正不得用负金额表达）');
    }
    amountValue = numeric.toFixed(4);
  } else {
    reversesFactId = requireNonEmpty(input.reversesFactId, 'REVERSES_FACT_REQUIRED', 'reversesFactId');
    if (input.amount !== null && input.amount !== undefined && input.amount !== '') {
      throw new ReconciliationIngestError(
        'REVERSAL_AMOUNT_NOT_ALLOWED',
        '冲正行不携带独立金额语义（amount 必须为空，金额由 reversesFactId 指向的事实取得）',
      );
    }
    const target = await prisma.reimbursementFact.findUnique({ where: { id: reversesFactId } });
    if (!target) throw new ReconciliationIngestError('REVERSAL_TARGET_NOT_FOUND', 'reversesFactId 不存在');
    if (target.organizationId !== organizationId) {
      throw new ReconciliationIngestError('REVERSAL_CROSS_TENANT', '冲正目标属于其他租户');
    }
    if (target.kind !== 'OBSERVED') {
      throw new ReconciliationIngestError('REVERSAL_TARGET_NOT_OBSERVED', '冲正目标必须是 OBSERVED 事实');
    }
    if (target.provider !== provider) {
      throw new ReconciliationIngestError('REVERSAL_PROVIDER_MISMATCH', '冲正 target provider 与冲正事实不一致');
    }
    if (target.currency !== currency) {
      throw new ReconciliationIngestError('REVERSAL_CURRENCY_MISMATCH', '冲正 target currency 与冲正事实不一致');
    }
  }

  const fingerprint = computeFingerprint({
    provider,
    sourceResource: input.sourceResource,
    eventKind: input.kind,
    providerEventId: input.providerEventId,
    canonicalSourceIdentity: input.canonicalSourceIdentity,
  });

  try {
    const fact = await prisma.reimbursementFact.create({
      data: {
        organizationId,
        claimItemId: input.claimItemId ?? null,
        caseId: input.caseId ?? null,
        provider,
        kind: input.kind,
        reversesFactId,
        amount: amountValue,
        currency,
        occurredAt: input.occurredAt,
        providerEventId: input.providerEventId?.trim() || null,
        providerEventFingerprint: fingerprint,
        fingerprintVersion: PROVIDER_EVENT_FINGERPRINT_VERSION,
        providerCaseRefCanonical: canonicalRefOrNull(input.providerCaseRefRaw),
        orderRef: input.orderRef ?? null,
        rawRefs: input.rawRefs === null || input.rawRefs === undefined ? undefined : (input.rawRefs as Prisma.InputJsonValue),
        sourceKind,
        sourceRef,
        capturedAt: input.capturedAt,
        parserVersion: input.parserVersion ?? null,
        ingestedByUserId,
        evidenceArtifactIds: input.evidenceArtifactIds ?? [],
        reasonCode: input.reasonCode ?? null,
        note: input.note ?? null,
      },
    });
    return { outcome: 'CREATED', fact };
  } catch (error) {
    if (isPrismaError(error, 'P2002')) {
      const target = prismaErrorTarget(error);
      if (target.includes('providerEventFingerprint')) {
        const existing = await prisma.reimbursementFact.findUnique({
          where: { organizationId_providerEventFingerprint: { organizationId, providerEventFingerprint: fingerprint } },
        });
        if (!existing) throw error;
        // same reversal replay → 返回既有事实（幂等），不视为新的业务 reversal
        if (input.kind === 'REIMBURSEMENT_REVERSED' && existing.reversesFactId !== reversesFactId) {
          throw new ReconciliationIngestError(
            'IDENTITY_COLLISION',
            '同一指纹已存在于不同业务目标（identity 冲突），fail-closed',
          );
        }
        return { outcome: 'REUSED', fact: existing };
      }
      if (target.includes('reimbursement_fact_full_reversal_unique') || target.includes('reversesFactId')) {
        // 两个不同 reversal event 指向同一 OBSERVED → 第二个 fail-closed
        throw new ReconciliationIngestError(
          'REVERSAL_ALREADY_APPLIED',
          '该 OBSERVED 事实已存在有效 full reversal（不同冲正事件不得重复冲正）',
        );
      }
    }
    mapDbInvariantError(error);
  }
}
