/**
 * R43 S2 —— Recovery Package Implementation
 * ---------------------------------------------------------------------------
 * 依据：MSG-20261001-33（S1 关闭后允许进入 S2）+ MSG-20261001-31 / -32 冻结不变量。
 * 范围（只允许）：package generation → canonical JSON manifest → digest/version →
 *                artifact generation → package CAS lifecycle。
 * 明确不做（属于 S3 及以后）：不注册 recovery.manual_submit、不消费 approval、
 * 不把 ClaimItem 改为 SUBMITTED_MANUAL、不创建 RecoveryManualSubmission、
 * 不接 HTTP submission confirmation、不做任何平台外写、不联动 Settlement/Billing。
 *
 * 身份稳定性纪律（MSG-20261001-33 RISKS）：
 *   - JSON manifest 是**唯一规范事实载体**；PDF 只是从它派生的 human-readable 视图；
 *   - digest 只覆盖业务字段：key 顺序 / Decimal 表达 / 时间格式 / 数组顺序必须规范化；
 *   - exporter 身份、导出时间、文件路径、存储键等**非业务 metadata 不进入 identity**；
 *   - digest 必须与 packageVersion + digestVersion 共同参与 approval binding。
 */

import { createHash } from 'node:crypto';

import type { Prisma, PrismaClient } from '@prisma/client';

import { prepareAuditInsert } from '../audit';

/** 内容结构版本（字段集合变化 → 升版本） */
export const RECOVERY_PACKAGE_VERSION = 'recovery-package/v1';
/** digest 算法版本（显式持久化，便于历史可比） */
export const RECOVERY_PACKAGE_DIGEST_VERSION = 'v1';
/** 材料包必须携带的「未提交」标识 */
export const RECOVERY_NOT_SUBMITTED_LABEL = 'MANUAL SUBMISSION PACKAGE — NOT SUBMITTED';

export const RECOVERY_PACKAGE_GENERATED_ACTION = 'recovery.package_generated';
export const RECOVERY_PACKAGE_EXPORTED_ACTION = 'recovery.package_exported';
export const RECOVERY_PACKAGE_SUPERSEDED_ACTION = 'recovery.package_superseded';
export const RECOVERY_PACKAGE_WITHDRAWN_ACTION = 'recovery.package_withdrawn';

export type RecoveryPackageStatusName = 'GENERATED' | 'EXPORTED' | 'SUPERSEDED' | 'WITHDRAWN';

/** 业务事实输入（**不含** exporter / 时间 / 路径等非业务字段） */
export interface RecoveryManifestFactInput {
  organizationId: string;
  claimItemId: string;
  caseId: string | null;
  platformType: string;
  claimType: string;
  normalizedRefs: readonly string[];
  currency: string;
  amountExpected: string | number | null;
  amountActual: string | number | null;
  recoverableAmount: string | number | null;
  occurredAt: Date | string;
  responsibleParty: string;
  evidence: readonly {
    evidenceId: string;
    evidenceType: string;
    capturedAt: Date | string | null;
  }[];
  /** 组织级更严格保留策略（仅用于展示，不参与 identity） */
  instructionNote?: string | null;
}

export interface RecoveryManifest {
  packageVersion: string;
  claimItemId: string;
  caseId: string | null;
  platformType: string;
  claimType: string;
  normalizedRefs: string[];
  currency: string;
  amountExpected: string | null;
  amountActual: string | null;
  recoverableAmount: string | null;
  occurredAt: string;
  responsibleParty: string;
  evidence: { evidenceId: string; evidenceType: string; capturedAt: string | null }[];
  label: string;
  instructionNote: string | null;
}

export class RecoveryPackageError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(code + ': ' + message);
    this.name = 'RecoveryPackageError';
    this.code = code;
  }
}

/** Decimal → 固定 4 位小数字符串（禁止浮点表示差异进入 identity） */
function canonicalDecimal(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  const text = typeof value === 'number' ? value.toString() : value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) {
    throw new RecoveryPackageError('INVALID_DECIMAL', '非法金额表达：' + String(value));
  }
  const negative = text.startsWith('-');
  const [intPart, fracPart = ''] = (negative ? text.slice(1) : text).split('.');
  const frac = (fracPart + '0000').slice(0, 4);
  const normalizedInt = intPart.replace(/^0+(?=\d)/, '');
  return (negative ? '-' : '') + normalizedInt + '.' + frac;
}

/** 时间 → UTC ISO-8601 毫秒（固定契约） */
function canonicalTimestamp(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new RecoveryPackageError('INVALID_TIMESTAMP', '非法时间表达：' + String(value));
  }
  return date.toISOString().replace(/\.(\d{3})\d*Z$/, '.$1Z');
}

/** 递归稳定序列化：对象 key 字典序、数组顺序由调用方显式规范化 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map((item) => stableStringify(item)).join(',') + ']';
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + stableStringify(v)).join(',') + '}';
}

/**
 * 构建 canonical manifest（唯一规范事实载体）。
 * 与 MSG-20261001-33 TEST 2 的契约：Decimal / currency / timestamp / null / optional 字段全部固定表达。
 */
export function buildRecoveryManifest(input: RecoveryManifestFactInput): RecoveryManifest {
  if (!input.organizationId || !input.claimItemId) {
    throw new RecoveryPackageError('MISSING_IDENTITY', 'organizationId / claimItemId 必填');
  }
  return {
    packageVersion: RECOVERY_PACKAGE_VERSION,
    claimItemId: input.claimItemId,
    caseId: input.caseId ?? null,
    platformType: input.platformType,
    claimType: input.claimType,
    normalizedRefs: [...new Set(input.normalizedRefs.map((ref) => ref.trim()))].sort(),
    currency: input.currency.trim().toUpperCase(),
    amountExpected: canonicalDecimal(input.amountExpected),
    amountActual: canonicalDecimal(input.amountActual),
    recoverableAmount: canonicalDecimal(input.recoverableAmount),
    occurredAt: canonicalTimestamp(input.occurredAt) as string,
    responsibleParty: input.responsibleParty,
    evidence: input.evidence
      .map((item) => ({
        evidenceId: item.evidenceId,
        evidenceType: item.evidenceType,
        capturedAt: canonicalTimestamp(item.capturedAt),
      }))
      .sort((a, b) => (a.evidenceId < b.evidenceId ? -1 : a.evidenceId > b.evidenceId ? 1 : 0)),
    label: RECOVERY_NOT_SUBMITTED_LABEL,
    instructionNote: input.instructionNote ?? null,
  };
}

/** canonical JSON 字符串（manifest 的规范序列化；PDF 由此派生） */
export function serializeCanonicalManifest(manifest: RecoveryManifest): string {
  return stableStringify(manifest);
}

/** packageDigest = sha256(canonical JSON) */
export function computePackageDigest(manifest: RecoveryManifest): string {
  return createHash('sha256').update(serializeCanonicalManifest(manifest), 'utf8').digest('hex');
}

/**
 * approval basis 的唯一 canonical builder（MSG-20261001-32 CHANGE C）。
 * approval 创建与执行必须都调用本函数，禁止各自拼字符串。
 */
export function buildRecoveryPackageBasisReference(input: {
  claimItemId: string;
  caseId: string;
  packageVersion: string;
  digestVersion: string;
  packageDigest: string;
}): string {
  return [
    'rmp1',
    input.claimItemId,
    input.caseId,
    input.packageVersion,
    input.digestVersion,
    input.packageDigest,
  ].join(':');
}

/** PDF 派生视图：只呈现 canonical manifest 的内容，不引入任何独立业务事实 */
export function renderManifestPdfLines(manifest: RecoveryManifest, digest: string): string[] {
  const lines = [
    'CrossClaim — RECOVERY SUBMISSION PACKAGE',
    RECOVERY_NOT_SUBMITTED_LABEL,
    '',
    'packageVersion: ' + manifest.packageVersion,
    'digestVersion: ' + RECOVERY_PACKAGE_DIGEST_VERSION,
    'packageDigest: ' + digest,
    'claimItemId: ' + manifest.claimItemId,
    'caseId: ' + (manifest.caseId ?? '-'),
    'platformType: ' + manifest.platformType,
    'claimType: ' + manifest.claimType,
    'normalizedRefs: ' + (manifest.normalizedRefs.join(', ') || '-'),
    'currency: ' + manifest.currency,
    'amountExpected: ' + (manifest.amountExpected ?? '-'),
    'amountActual: ' + (manifest.amountActual ?? '-'),
    'recoverableAmount: ' + (manifest.recoverableAmount ?? '-'),
    'occurredAt: ' + manifest.occurredAt,
    'responsibleParty: ' + manifest.responsibleParty,
    'evidence: ' + (manifest.evidence.map((item) => item.evidenceId).join(', ') || '-'),
    'instruction: ' + (manifest.instructionNote ?? '-'),
  ];
  return lines;
}

/** 最小 PDF writer（无第三方依赖；确定性输出，不含时间/路径/凭据） */
export function renderManifestPdf(manifest: RecoveryManifest, digest: string): Buffer {
  const escape = (text: string) => text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const lines = renderManifestPdfLines(manifest, digest).map(escape);
  const content =
    'BT /F1 10 Tf 50 780 Td 14 TL\n' +
    lines.map((line) => '(' + line + ') Tj T*').join('\n') +
    '\nET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    '<< /Length ' + Buffer.byteLength(content, 'latin1') + ' >>\nstream\n' + content + '\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n';
  for (const offset of offsets) {
    pdf += String(offset).padStart(10, '0') + ' 00000 n \n';
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

// ---------------------------------------------------------------------------
// 持久化：generation（幂等）+ CAS 生命周期 + artifact 落库
// ---------------------------------------------------------------------------

type TxClient = Prisma.TransactionClient;

async function audit(
  client: TxClient | PrismaClient,
  input: {
    organizationId: string;
    actorUserId: string | null;
    action: string;
    entityId: string;
    changes: Record<string, unknown>;
    at: Date;
  },
): Promise<void> {
  const row = prepareAuditInsert(
    {
      organizationId: input.organizationId,
      actorType: input.actorUserId ? 'USER' : 'SYSTEM',
      actorUserId: input.actorUserId ?? undefined,
      action: input.action,
      entityType: 'RecoveryPackage',
      entityId: input.entityId,
      changes: input.changes,
    },
    { maxStringLength: 512, now: () => input.at },
  );
  await client.auditLog.create({
    data: {
      organizationId: row.organizationId,
      actorType: row.actorType,
      actorUserId: row.actorUserId,
      actorRef: row.actorRef,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      changes: (row.changes ?? undefined) as Prisma.InputJsonValue | undefined,
      ip: row.ip,
      userAgent: row.userAgent,
      createdAt: input.at,
    },
  });
}

export interface GeneratePackageResult {
  packageId: string;
  packageVersion: string;
  digestVersion: string;
  packageDigest: string;
  status: RecoveryPackageStatusName;
  created: boolean;
}

/**
 * 生成（或复用）材料包：相同业务输入 → 相同 digest → **不产生第二条逻辑 package**。
 */
export async function generateRecoveryPackage(
  input: { fact: RecoveryManifestFactInput; actorUserId: string | null },
  deps: { prisma: PrismaClient; now?: () => Date },
): Promise<GeneratePackageResult> {
  const manifest = buildRecoveryManifest(input.fact);
  const digest = computePackageDigest(manifest);
  const now = deps.now ?? (() => new Date());
  const { organizationId, claimItemId } = input.fact;

  const existing = await deps.prisma.recoveryPackage.findFirst({
    where: { organizationId, claimItemId, packageVersion: RECOVERY_PACKAGE_VERSION, packageDigest: digest },
    select: { id: true, status: true },
  });
  if (existing) {
    return {
      packageId: existing.id,
      packageVersion: RECOVERY_PACKAGE_VERSION,
      digestVersion: RECOVERY_PACKAGE_DIGEST_VERSION,
      packageDigest: digest,
      status: existing.status as RecoveryPackageStatusName,
      created: false,
    };
  }

  try {
    return await deps.prisma.$transaction(async (tx) => {
      const at = now();
      const created = await tx.recoveryPackage.create({
        data: {
          organizationId,
          claimItemId,
          caseId: manifest.caseId,
          packageVersion: RECOVERY_PACKAGE_VERSION,
          digestVersion: RECOVERY_PACKAGE_DIGEST_VERSION,
          packageDigest: digest,
          completenessSnapshot: manifest.evidence.map((item) => item.evidenceId),
          generatedByUserId: input.actorUserId,
          generatedAt: at,
        },
        select: { id: true, status: true },
      });
      await audit(tx, {
        organizationId,
        actorUserId: input.actorUserId,
        action: RECOVERY_PACKAGE_GENERATED_ACTION,
        entityId: created.id,
        changes: {
          claimItemId,
          caseId: manifest.caseId,
          packageVersion: RECOVERY_PACKAGE_VERSION,
          digestVersion: RECOVERY_PACKAGE_DIGEST_VERSION,
          packageDigest: digest,
          evidenceCount: manifest.evidence.length,
        },
        at,
      });
      return {
        packageId: created.id,
        packageVersion: RECOVERY_PACKAGE_VERSION,
        digestVersion: RECOVERY_PACKAGE_DIGEST_VERSION,
        packageDigest: digest,
        status: created.status as RecoveryPackageStatusName,
        created: true,
      };
    });
  } catch (error) {
    // 并发下唯一约束命中 → 复用既有 package（不产生第二条逻辑 package）
    if (String((error as Error).message).includes('Unique constraint')) {
      const raced = await deps.prisma.recoveryPackage.findFirstOrThrow({
        where: { organizationId, claimItemId, packageVersion: RECOVERY_PACKAGE_VERSION, packageDigest: digest },
        select: { id: true, status: true },
      });
      return {
        packageId: raced.id,
        packageVersion: RECOVERY_PACKAGE_VERSION,
        digestVersion: RECOVERY_PACKAGE_DIGEST_VERSION,
        packageDigest: digest,
        status: raced.status as RecoveryPackageStatusName,
        created: false,
      };
    }
    throw error;
  }
}

export type PackageTransitionInput =
  | { to: 'EXPORTED' }
  | { to: 'SUPERSEDED'; reason: string }
  | { to: 'WITHDRAWN'; reason: string };

/**
 * 受控 CAS 生命周期：
 *   GENERATED → EXPORTED（可重复，**非终态**）
 *   GENERATED / EXPORTED → SUPERSEDED | WITHDRAWN（终态，需 reason + actor，不可回退）
 */
export async function transitionRecoveryPackage(
  input: {
    organizationId: string;
    packageId: string;
    actorUserId: string;
    transition: PackageTransitionInput;
  },
  deps: { prisma: PrismaClient; now?: () => Date },
): Promise<{ status: RecoveryPackageStatusName; changed: boolean }> {
  const now = deps.now ?? (() => new Date());
  const current = await deps.prisma.recoveryPackage.findFirst({
    where: { id: input.packageId, organizationId: input.organizationId },
    select: { id: true, status: true },
  });
  if (!current) throw new RecoveryPackageError('PACKAGE_NOT_FOUND', '材料包不存在或不属于该租户');

  const from = current.status as RecoveryPackageStatusName;
  const to = input.transition.to;

  if (from === 'SUPERSEDED' || from === 'WITHDRAWN') {
    if (to === from) return { status: from, changed: false };
    throw new RecoveryPackageError('PACKAGE_TERMINAL', '终态材料包不可再变更状态：' + from);
  }
  if (to === 'EXPORTED') {
    if (from === 'EXPORTED') return { status: from, changed: false };
  }
  if (to === 'SUPERSEDED' || to === 'WITHDRAWN') {
    if (!input.transition.reason.trim()) {
      throw new RecoveryPackageError('TRANSITION_REASON_REQUIRED', '进入终态必须提供 reason');
    }
  }

  const at = now();
  const result = await deps.prisma.recoveryPackage.updateMany({
    where: { id: input.packageId, organizationId: input.organizationId, status: from },
    data:
      to === 'EXPORTED'
        ? { status: 'EXPORTED', updatedAt: at }
        : {
            status: to,
            transitionReason: input.transition.reason,
            transitionActorUserId: input.actorUserId,
            updatedAt: at,
          },
  });
  if (result.count === 0) {
    throw new RecoveryPackageError('ILLEGAL_TRANSITION', '并发状态跃迁失败（CAS 未命中）：' + from + ' → ' + to);
  }

  const action =
    to === 'EXPORTED'
      ? RECOVERY_PACKAGE_EXPORTED_ACTION
      : to === 'SUPERSEDED'
        ? RECOVERY_PACKAGE_SUPERSEDED_ACTION
        : RECOVERY_PACKAGE_WITHDRAWN_ACTION;
  await audit(deps.prisma, {
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    action,
    entityId: input.packageId,
    changes: {
      from,
      to,
      ...(to === 'SUPERSEDED' || to === 'WITHDRAWN' ? { reason: input.transition.reason } : {}),
    },
    at,
  });
  return { status: to, changed: true };
}

export interface PersistArtifactInput {
  organizationId: string;
  packageId: string;
  exportedByUserId: string;
  storageKeyPrefix: string;
  originalNameBase: string;
  manifest: RecoveryManifest;
}

/**
 * 落库导出产物：JSON manifest（规范事实载体）+ PDF（派生视图）。
 * 只引用既有 FileAsset；同内容重复导出不新增第二份 artifact（唯一键由 DB 保证）。
 */
export async function persistPackageArtifacts(
  input: PersistArtifactInput,
  deps: { prisma: PrismaClient; now?: () => Date },
): Promise<{ manifestArtifactId: string; pdfArtifactId: string; packageDigest: string }> {
  const now = deps.now ?? (() => new Date());
  const canonicalJson = serializeCanonicalManifest(input.manifest);
  const digest = computePackageDigest(input.manifest);
  const pdf = renderManifestPdf(input.manifest, digest);

  const artifacts = [
    {
      kind: 'JSON_MANIFEST' as const,
      payload: Buffer.from(canonicalJson, 'utf8'),
      fileKind: 'OTHER' as const,
      extension: 'json',
      mime: 'application/json',
    },
    {
      kind: 'PDF' as const,
      payload: pdf,
      fileKind: 'PDF' as const,
      extension: 'pdf',
      mime: 'application/pdf',
    },
  ];

  const created: string[] = [];
  for (const artifact of artifacts) {
    const sha256 = sha256Hex(artifact.payload);
    const existing = await deps.prisma.recoveryPackageArtifact.findFirst({
      where: { organizationId: input.organizationId, packageId: input.packageId, artifactKind: artifact.kind, sha256 },
      select: { id: true },
    });
    if (existing) {
      created.push(existing.id);
      continue;
    }
    const at = now();
    const file = await deps.prisma.fileAsset.create({
      data: {
        organizationId: input.organizationId,
        kind: artifact.fileKind,
        storageKey: `${input.storageKeyPrefix}/${input.packageId}/${artifact.kind.toLowerCase()}-${sha256}.${artifact.extension}`,
        originalName: `${input.originalNameBase}-${artifact.kind.toLowerCase()}.${artifact.extension}`,
        mimeType: artifact.mime,
        sizeBytes: artifact.payload.byteLength,
        sha256,
        uploadedBy: input.exportedByUserId,
      },
      select: { id: true },
    });
    const row = await deps.prisma.recoveryPackageArtifact.create({
      data: {
        organizationId: input.organizationId,
        packageId: input.packageId,
        artifactKind: artifact.kind,
        fileAssetId: file.id,
        sha256,
        exportedByUserId: input.exportedByUserId,
        exportedAt: at,
      },
      select: { id: true },
    });
    created.push(row.id);
  }

  return { manifestArtifactId: created[0], pdfArtifactId: created[1], packageDigest: digest };
}
