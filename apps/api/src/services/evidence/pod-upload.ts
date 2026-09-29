/**
 * MSG-20260929-17 Q3 — POD 证据文件上传登记（**只登记，不抓取**）
 * ---------------------------------------------------------------
 * 架构方批准的链路：POD File Upload → FileAsset → EvidenceArtifact(kind=POD) → （可选）CaseEvidence。
 *
 * 允许：把**用户自己提供的**签收凭证文件存下来并登记为证据附件。
 * 禁止（本模块绝不实现）：查询物流商、抓取 POD、验证签名真实性、判断责任归属、解析文件内容、OCR、
 * 任何网络调用、任何金额或规则判定。
 *
 * 与既有 CSV 导入链路的区别：这里不做内容扫描/导入，只做「存储 + 证据登记」。
 */

import { createHash, randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import type { AuditWriter } from '../audit';
import type { StorageAdapter } from '../storage';
import { promoteEvidence, type EvidencePromotionPorts } from './promotion';

export const POD_MAX_BYTES_DEFAULT = 10 * 1024 * 1024;

export class PodEvidenceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'PodEvidenceError';
  }
}

export type PodFileKind = 'PDF' | 'IMAGE';

export interface PodUploadInput {
  organizationId: string;
  fileName: string;
  bytes: Buffer;
  mimeType?: string;
  title?: string;
  description?: string;
  capturedAt?: Date;
  /** 可选：把证据挂到某个案件（必须同租户） */
  caseId?: string;
  role?: string;
  createdBy?: string;
}

export interface PodUploadDeps {
  prisma: PrismaClient;
  storage: StorageAdapter;
  audit: AuditWriter;
  now?: () => Date;
  /** 便于测试；默认 10 MiB */
  maxBytes?: number;
}

export interface PodUploadResult {
  fileAssetId: string;
  evidenceId: string;
  reused: boolean;
  caseLinked: boolean;
  fileKind: PodFileKind;
  sha256: string;
  sizeBytes: number;
  title: string;
}

/** 只按魔数识别格式；识别不了就拒绝，绝不当成别的东西处理。 */
export function detectPodFileKind(bytes: Buffer): PodFileKind | null {
  if (bytes.length >= 4 && bytes.subarray(0, 4).toString('utf8') === '%PDF') return 'PDF';
  if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0x89504e47) return 'IMAGE';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'IMAGE';
  return null;
}

function sha256Hex(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

function buildPorts(prisma: PrismaClient, audit: AuditWriter, now?: () => Date): EvidencePromotionPorts {
  return {
    fileAssets: {
      async find(organizationId, fileAssetId) {
        const row = await prisma.fileAsset.findFirst({
          where: { id: fileAssetId, organizationId },
          select: {
            id: true,
            organizationId: true,
            connectionId: true,
            kind: true,
            originalName: true,
            createdAt: true,
          },
        });
        return row ?? null;
      },
    },
    evidence: {
      async findExisting(organizationId, fileAssetId, kind) {
        const row = await prisma.evidenceArtifact.findFirst({
          where: { organizationId, fileAssetId, kind },
          select: { id: true },
        });
        return row ?? null;
      },
      async create(draft) {
        return prisma.evidenceArtifact.create({
          data: {
            organizationId: draft.organizationId,
            kind: draft.kind,
            fileAssetId: draft.fileAssetId,
            connectionId: draft.connectionId,
            externalUrl: draft.externalUrl,
            title: draft.title,
            description: draft.description,
            capturedAt: draft.capturedAt,
          },
          select: { id: true },
        });
      },
      async linkCase(input) {
        await prisma.caseEvidence.create({
          data: {
            organizationId: input.organizationId,
            caseId: input.caseId,
            evidenceId: input.evidenceId,
            role: input.role,
          },
        });
      },
    },
    cases: {
      async find(organizationId, caseId) {
        const row = await prisma.case.findFirst({
          where: { id: caseId, organizationId },
          select: { id: true },
        });
        return row ?? null;
      },
    },
    audit,
    ...(now ? { now } : {}),
  };
}

/**
 * 登记一份用户提供的 POD 证据文件。
 * 只做：格式校验 → 存储 → FileAsset → EvidenceArtifact(kind=POD) → 可选案件关联。
 */
export async function registerPodEvidence(
  input: PodUploadInput,
  deps: PodUploadDeps,
): Promise<PodUploadResult> {
  const at = (deps.now ?? (() => new Date()))();
  const maxBytes = deps.maxBytes ?? POD_MAX_BYTES_DEFAULT;

  if (input.bytes.length === 0) {
    throw new PodEvidenceError('POD_EMPTY_FILE', '文件为空');
  }
  if (input.bytes.length > maxBytes) {
    throw new PodEvidenceError('POD_FILE_TOO_LARGE', '文件超过上限 ' + maxBytes + ' 字节');
  }
  const fileKind = detectPodFileKind(input.bytes);
  if (!fileKind) {
    throw new PodEvidenceError(
      'POD_UNSUPPORTED_FORMAT',
      '只接受 PDF / PNG / JPEG 的签收凭证（不解析内容）',
    );
  }

  const title = (input.title ?? input.fileName).trim();
  if (title === '' || title.length > 512) {
    throw new PodEvidenceError('POD_INVALID_TITLE', 'title 必填且不超过 512 字符');
  }

  const fileAssetId = randomUUID();
  const sha256 = sha256Hex(input.bytes);
  const stored = await deps.storage.put({
    organizationId: input.organizationId,
    fileAssetId,
    body: input.bytes,
    ...(input.mimeType ? { contentType: input.mimeType } : {}),
    expectedSha256: sha256,
  });

  await deps.prisma.fileAsset.create({
    data: {
      id: fileAssetId,
      organizationId: input.organizationId,
      // POD 证据不挂采集连接（它不是导入批次）
      connectionId: null,
      kind: fileKind,
      storageKey: stored.storageKey,
      originalName: input.fileName,
      ...(input.mimeType ? { mimeType: input.mimeType } : {}),
      sizeBytes: stored.size,
      sha256: stored.sha256,
      ...(input.createdBy ? { uploadedBy: input.createdBy } : {}),
    },
  });

  const ports = buildPorts(deps.prisma, deps.audit, deps.now);
  const promoted = await promoteEvidence(
    {
      organizationId: input.organizationId,
      kind: 'POD',
      title,
      source: { type: 'FILE_ASSET', fileAssetId },
      ...(input.description ? { description: input.description } : {}),
      capturedAt: input.capturedAt ?? at,
      ...(input.caseId ? { caseId: input.caseId } : {}),
      ...(input.role ? { role: input.role } : {}),
    },
    ports,
  );

  return {
    fileAssetId,
    evidenceId: promoted.evidenceId,
    reused: promoted.reused,
    caseLinked: promoted.caseLinked,
    fileKind,
    sha256: stored.sha256,
    sizeBytes: stored.size,
    title,
  };
}
