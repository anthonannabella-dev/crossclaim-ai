// PROVIDER FOLLOW-UP INTELLIGENCE / P4（slice A-S5）—— 只读 Prisma 证据来源端口
// ---------------------------------------------------------------------------
// 在**查询层**就按 organization + platformAccount 过滤（EvidenceArtifact.accountId 为 null 的 org 级证据也纳入，
// 但因为没有可核对键只会落到 LOW_CONFIDENCE，不会被判成 FOUND）。
// 只读：不创建 / 不修改任何证据；值得抽取为 best-effort，无法核对时明确落到人工复核。
//
// B-S12 变更（如实记录）：ENTRY_LINE 需求要求 `hts` 键，而本端口此前未抽取 HTS，
// 导致真实库里「HTS 写在描述里的 entry summary」永远无法满足 ENTRY_LINE（只能 LOW_CONFIDENCE）。
// 现补充 `hts` 强模式（仅匹配 `1234.56` / `1234.56.78` 形式），与 B-S5 需求目录保持一致。

import type { PrismaClient } from '@prisma/client';

import {
  EVIDENCE_QUERY_KEYS,
  type EvidenceCandidate,
  type EvidenceQueryKey,
  type EvidenceScope,
  type EvidenceSourcePort,
} from './evidence-resolver';

export const EVIDENCE_KEY_EXTRACTION_VERSION = 'evidence-key-extraction/v2';

const KEY_PATTERNS: ReadonlyArray<{ key: EvidenceQueryKey; pattern: RegExp }> = [
  { key: 'trackingNumber', pattern: /\b(?:1Z[0-9A-Z]{10,}|[A-Z]{2}\d{9}[A-Z]{2}|\d{12,22})\b/g },
  { key: 'orderId', pattern: /\b\d{3}-\d{7}-\d{7}\b/g },
  // 发票号常含内部连字符（INV-2026-0001）：整体捕获，且要求前缀后紧跟数字，
  // 避免把普通单词 "invoice" 当成发票号（旧模式会先匹配到 "invoice" 并把它当值）。
  { key: 'invoiceNo', pattern: /\b(?:INV|FACT|BILL)[-_ ]?\d[A-Z0-9._-]{3,}\b/gi },
  { key: 'entryNumber', pattern: /\b[A-Z]{3}[- ]?\d{6,}[- ]?\d?\b/g },
  // B-S12：HTS / HS code（B-S5 的 ENTRY_LINE 需求依赖此键）
  { key: 'hts', pattern: /\b\d{4}\.\d{2}(?:\.\d{2,4})?\b/g },
  { key: 'shipmentId', pattern: /\b(?:SHP|SHIP)[-_ ]?[A-Z0-9]{5,}\b/gi },
];

/** best-effort 键抽取：只从 title/description 文本抽取可核对的强模式（抽不到就不写）。 */
export function extractEvidenceKeyValues(
  text: string,
  wanted: readonly EvidenceQueryKey[],
): Partial<Record<EvidenceQueryKey, string>> {
  const out: Partial<Record<EvidenceQueryKey, string>> = {};
  for (const { key, pattern } of KEY_PATTERNS) {
    if (!wanted.includes(key)) continue;
    const matches = text.match(pattern);
    if (matches && matches.length > 0) {
      out[key] = matches[0].toUpperCase().replace(/\s+/g, '');
    }
  }
  return out;
}

export function createPrismaEvidenceSource(prisma: PrismaClient): EvidenceSourcePort {
  return {
    async findCandidates({ scope, acceptableKinds, requiredKeys }: {
      scope: EvidenceScope;
      acceptableKinds: readonly string[];
      requiredKeys: readonly EvidenceQueryKey[];
    }): Promise<EvidenceCandidate[]> {
      if (acceptableKinds.length === 0) return [];
      const rows = await prisma.evidenceArtifact.findMany({
        where: {
          organizationId: scope.organizationId,
          // 查询点即隔离：本 account + org 级（accountId = null）
          OR: [{ accountId: scope.platformAccountId }, { accountId: null }],
          kind: { in: acceptableKinds as never },
        },
        select: {
          id: true,
          organizationId: true,
          accountId: true,
          kind: true,
          title: true,
          description: true,
          reliability: true,
          capturedAt: true,
          fileAssetId: true,
          connectionId: true,
          externalUrl: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 200,
      });
      return rows.map((row) => {
        const text = [row.title, row.description ?? '', row.externalUrl ?? ''].join(' ');
        const keyValues = extractEvidenceKeyValues(text, requiredKeys);
        return {
          evidenceId: row.id,
          organizationId: row.organizationId,
          platformAccountId: row.accountId,
          kind: row.kind,
          title: row.title,
          reliability: row.reliability,
          capturedAt: row.capturedAt ? row.capturedAt.toISOString() : null,
          fileAssetId: row.fileAssetId,
          keyValues,
          lineage: [
            ...(row.fileAssetId ? [`fileAsset:${row.fileAssetId}`] : []),
            ...(row.connectionId ? [`connection:${row.connectionId}`] : []),
          ],
          sourceRef: row.fileAssetId
            ? `fileAsset:${row.fileAssetId}`
            : row.externalUrl
              ? `external:${row.externalUrl}`
              : `evidence:${row.id}`,
        } satisfies EvidenceCandidate;
      });
    },
  };
}

export const EVIDENCE_RESOLVER_SUPPORTED_KEYS = EVIDENCE_QUERY_KEYS;
