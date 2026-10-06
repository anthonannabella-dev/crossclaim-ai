// PROVIDER FOLLOW-UP INTELLIGENCE / P4（slice A-S5）—— General Evidence Resolver（纯决策层）
// ---------------------------------------------------------------------------
// 目标：把「平台要求补的某项证据」映射到**已存在的**证据资产上，给出 FOUND / PARTIAL / MISSING /
//       CONFLICT / AMBIGUOUS / LOW_CONFIDENCE，并返回 refs / facts / lineage / missing / conflicts / confidence。
// 硬规则：① 只读，不创建证据；② 禁止跨 tenant / 跨 platform account；③ 冲突绝不 last-write-wins，
//        一律 CONFLICT（交 HITL）；④ 键不完整或证据缺少可核对键 → 最多 LOW_CONFIDENCE，绝不猜 FOUND。

import { digestOf } from '../config-execution-durability/digests';

export const EVIDENCE_RESOLVER_VERSION = 'evidence-resolver/v1';

export const EVIDENCE_RESOLUTION_STATUSES = [
  'FOUND',
  'PARTIAL',
  'MISSING',
  'CONFLICT',
  'AMBIGUOUS',
  'LOW_CONFIDENCE',
] as const;
export type EvidenceResolutionStatus = (typeof EVIDENCE_RESOLUTION_STATUSES)[number];

export const EVIDENCE_QUERY_KEYS = [
  'trackingNumber',
  'orderId',
  'shipmentId',
  'invoiceNo',
  'entryNumber',
  'claimItemRef',
  'caseRef',
  'sku',
  'hts',
] as const;
export type EvidenceQueryKey = (typeof EVIDENCE_QUERY_KEYS)[number];

/** 一项需求（例如 Amazon 要求 POD）：可接受多种证据 kind + 校验键。 */
export interface EvidenceRequirement {
  kind: string;
  /** 可接受的证据类型（EvidenceKind / 文档类型等，由调用方给出） */
  acceptableKinds: readonly string[];
  /** 该需求成立所需核对的键（全部匹配才算 FOUND；部分匹配 → PARTIAL） */
  requiredKeys: readonly EvidenceQueryKey[];
}

export interface EvidenceScope {
  organizationId: string;
  platformAccountId: string;
}

/** 候选证据（由只读端口返回；必须**已经**通过 tenant/account 过滤）。 */
export interface EvidenceCandidate {
  evidenceId: string;
  organizationId: string;
  platformAccountId: string | null;
  kind: string;
  title?: string;
  reliability?: number | null;
  capturedAt?: string | null;
  fileAssetId?: string | null;
  /** 可直接核对的键值（tracking/order/invoice/...）；缺失即视为不可核对 */
  keyValues: Partial<Record<EvidenceQueryKey, string>>;
  /** 上游血缘引用（canonical fact / source transaction / package 等） */
  lineage?: readonly string[];
  /** 供审计的原始来源标签（来源适配器/文件摘要） */
  sourceRef?: string;
}

export interface EvidenceResolutionRequest {
  requirement: EvidenceRequirement;
  /** 期望值（来自 case / claim / canonical fact；调用方只读提供） */
  expected: Partial<Record<EvidenceQueryKey, string>>;
}

export interface EvidenceResolutionConflict {
  key: EvidenceQueryKey | 'kind';
  values: string[];
  evidenceIds: string[];
}

export interface EvidenceResolutionResult {
  kind: 'EVIDENCE_RESOLUTION';
  version: string;
  scope: EvidenceScope;
  requirementKind: string;
  status: EvidenceResolutionStatus;
  evidenceReferences: string[];
  matchedFacts: Array<{ evidenceId: string; matchedKeys: EvidenceQueryKey[]; kind: string; sourceRef?: string }>;
  lineage: string[];
  missingEvidence: Array<{ requirementKind: string; missingKeys: EvidenceQueryKey[] }>;
  conflicts: EvidenceResolutionConflict[];
  confidenceBp: number;
  reasons: string[];
  /** 因跨 tenant / 跨 account 被拒的候选（审计可见，但不参与匹配） */
  rejectedForScope: string[];
  resultDigest: string;
}

export const DEFAULT_EVIDENCE_CONFIDENCE_THRESHOLD_BP = 6_000;

function normalizeKeyValue(value: string | undefined): string | null {
  if (value === undefined) return null;
  const normalized = value.trim().toUpperCase().replace(/\s+/g, '');
  return normalized.length === 0 ? null : normalized;
}

function scopeReject(candidate: EvidenceCandidate, scope: EvidenceScope): 'TENANT' | 'ACCOUNT' | null {
  if (candidate.organizationId !== scope.organizationId) return 'TENANT';
  if (candidate.platformAccountId !== null && candidate.platformAccountId !== scope.platformAccountId) {
    return 'ACCOUNT';
  }
  return null;
}

function matchedKeys(
  candidate: EvidenceCandidate,
  requirement: EvidenceRequirement,
  expected: Partial<Record<EvidenceQueryKey, string>>,
): { matched: EvidenceQueryKey[]; mismatched: EvidenceQueryKey[] } {
  const matched: EvidenceQueryKey[] = [];
  const mismatched: EvidenceQueryKey[] = [];
  for (const key of requirement.requiredKeys) {
    const want = normalizeKeyValue(expected[key]);
    const got = normalizeKeyValue(candidate.keyValues[key]);
    if (want && got && want === got) matched.push(key);
    else mismatched.push(key);
  }
  return { matched, mismatched };
}

/**
 * 解析单项证据需求（纯函数、确定性）。
 * 调用方必须先把候选证据交给只读端口（本函数再次执行 tenant/account 过滤作为纵深防御）。
 */
export function resolveEvidence(input: {
  scope: EvidenceScope;
  candidates: readonly EvidenceCandidate[];
  request: EvidenceResolutionRequest;
  confidenceThresholdBp?: number;
}): EvidenceResolutionResult {
  const { scope, request } = input;
  const threshold = input.confidenceThresholdBp ?? DEFAULT_EVIDENCE_CONFIDENCE_THRESHOLD_BP;
  const rejectedForScope: string[] = [];
  const inScope: EvidenceCandidate[] = [];
  const seen = new Set<string>();
  for (const candidate of input.candidates) {
    if (seen.has(candidate.evidenceId)) continue;
    seen.add(candidate.evidenceId);
    if (scopeReject(candidate, scope) !== null) {
      rejectedForScope.push(candidate.evidenceId);
      continue;
    }
    inScope.push(candidate);
  }

  const kindCompatible = inScope.filter((c) =>
    request.requirement.acceptableKinds.includes(c.kind),
  );
  const missingKeysAll = [...request.requirement.requiredKeys];

  if (kindCompatible.length === 0) {
    return build({
      status: 'MISSING',
      evidenceReferences: [],
      matchedFacts: [],
      lineage: [],
      missingEvidence: [{ requirementKind: request.requirement.kind, missingKeys: missingKeysAll }],
      conflicts: [],
      confidenceBp: 0,
      reasons: inScope.length > 0 ? ['NO_KIND_COMPATIBLE_EVIDENCE'] : ['NO_EVIDENCE_IN_SCOPE'],
      rejectedForScope,
    });
  }

  const evaluated = kindCompatible.map((candidate) => {
    const { matched, mismatched } = matchedKeys(candidate, request.requirement, request.expected);
    return { candidate, matched, mismatched };
  });

  const full = evaluated.filter((e) => e.matched.length === request.requirement.requiredKeys.length);
  const partial = evaluated.filter(
    (e) => e.matched.length > 0 && e.matched.length < request.requirement.requiredKeys.length,
  );
  const keyless = evaluated.filter((e) => e.matched.length === 0);

  // 冲突检测：同一 requirement 下，同一键出现 ≥2 个不同值（含 kind 冲突）
  const conflicts: EvidenceResolutionConflict[] = [];
  const valuesByKey = new Map<string, Map<string, string[]>>();
  for (const { candidate } of evaluated) {
    const entries: Array<[string, string | undefined]> = [
      ['kind', candidate.kind],
      ...request.requirement.requiredKeys.map(
        (key) => [key, candidate.keyValues[key]] as [string, string | undefined],
      ),
    ];
    for (const [key, value] of entries) {
      const normalized = normalizeKeyValue(value);
      if (!normalized) continue;
      if (!valuesByKey.has(key)) valuesByKey.set(key, new Map());
      const bucket = valuesByKey.get(key) as Map<string, string[]>;
      bucket.set(normalized, [...(bucket.get(normalized) ?? []), candidate.evidenceId]);
    }
  }
  for (const [key, bucket] of valuesByKey) {
    if (bucket.size > 1 && request.requirement.requiredKeys.includes(key as EvidenceQueryKey)) {
      conflicts.push({
        key: key as EvidenceQueryKey,
        values: [...bucket.keys()].sort(),
        evidenceIds: [...bucket.values()].flat().sort(),
      });
    }
  }
  if (conflicts.length > 0) {
    return build({
      status: 'CONFLICT',
      evidenceReferences: conflicts.flatMap((c) => c.evidenceIds),
      matchedFacts: [],
      lineage: [],
      missingEvidence: [],
      conflicts,
      confidenceBp: 0,
      reasons: ['CONFLICTING_EVIDENCE_VALUES'],
      rejectedForScope,
    });
  }

  if (full.length === 1) {
    const only = full[0];
    const reliability = only.candidate.reliability ?? null;
    const confidenceBp = confidenceFrom(reliability, request.requirement.requiredKeys.length);
    if (confidenceBp < threshold) {
      return build({
        status: 'LOW_CONFIDENCE',
        evidenceReferences: [only.candidate.evidenceId],
        matchedFacts: [
          {
            evidenceId: only.candidate.evidenceId,
            matchedKeys: only.matched,
            kind: only.candidate.kind,
            ...(only.candidate.sourceRef ? { sourceRef: only.candidate.sourceRef } : {}),
          },
        ],
        lineage: [...(only.candidate.lineage ?? [])],
        missingEvidence: [],
        conflicts: [],
        confidenceBp,
        reasons: ['BELOW_CONFIDENCE_THRESHOLD'],
        rejectedForScope,
      });
    }
    return build({
      status: 'FOUND',
      evidenceReferences: [only.candidate.evidenceId],
      matchedFacts: [
        {
          evidenceId: only.candidate.evidenceId,
          matchedKeys: only.matched,
          kind: only.candidate.kind,
          ...(only.candidate.sourceRef ? { sourceRef: only.candidate.sourceRef } : {}),
        },
      ],
      lineage: [...(only.candidate.lineage ?? [])],
      missingEvidence: [],
      conflicts: [],
      confidenceBp,
      reasons: ['UNIQUE_KEY_MATCH'],
      rejectedForScope,
    });
  }

  if (full.length > 1) {
    // 多个候选都完全匹配：无法判定唯一权威证据 → AMBIGUOUS（交 HITL）
    return build({
      status: 'AMBIGUOUS',
      evidenceReferences: full.map((e) => e.candidate.evidenceId).sort(),
      matchedFacts: [],
      lineage: [],
      missingEvidence: [],
      conflicts: [],
      confidenceBp: 0,
      reasons: ['MULTIPLE_FULL_MATCHES'],
      rejectedForScope,
    });
  }

  if (partial.length > 0) {
    const best = partial.slice().sort((a, b) => b.matched.length - a.matched.length)[0];
    const missing = request.requirement.requiredKeys.filter((k) => !best.matched.includes(k));
    return build({
      status: 'PARTIAL',
      evidenceReferences: [best.candidate.evidenceId],
      matchedFacts: [
        {
          evidenceId: best.candidate.evidenceId,
          matchedKeys: best.matched,
          kind: best.candidate.kind,
          ...(best.candidate.sourceRef ? { sourceRef: best.candidate.sourceRef } : {}),
        },
      ],
      lineage: [...(best.candidate.lineage ?? [])],
      missingEvidence: [{ requirementKind: request.requirement.kind, missingKeys: missing }],
      conflicts: [],
      confidenceBp: confidenceFrom(best.candidate.reliability ?? null, request.requirement.requiredKeys.length),
      reasons: ['PARTIAL_KEY_MATCH'],
      rejectedForScope,
    });
  }

  // 存在同 kind 证据但没有任何可核对键 → 只能 LOW_CONFIDENCE（绝不猜 FOUND）
  return build({
    status: 'LOW_CONFIDENCE',
    evidenceReferences: keyless.map((e) => e.candidate.evidenceId).sort(),
    matchedFacts: [],
    lineage: [],
    missingEvidence: [{ requirementKind: request.requirement.kind, missingKeys: missingKeysAll }],
    conflicts: [],
    confidenceBp: 0,
    reasons: ['EVIDENCE_WITHOUT_VERIFIABLE_KEYS'],
    rejectedForScope,
  });

  function build(partialResult: {
    status: EvidenceResolutionStatus;
    evidenceReferences: string[];
    matchedFacts: EvidenceResolutionResult['matchedFacts'];
    lineage: string[];
    missingEvidence: EvidenceResolutionResult['missingEvidence'];
    conflicts: EvidenceResolutionConflict[];
    confidenceBp: number;
    reasons: string[];
    rejectedForScope: string[];
  }): EvidenceResolutionResult {
    const body = {
      version: EVIDENCE_RESOLVER_VERSION,
      scope,
      requirementKind: request.requirement.kind,
      status: partialResult.status,
      evidenceReferences: partialResult.evidenceReferences,
      matchedFacts: partialResult.matchedFacts,
      lineage: partialResult.lineage,
      missingEvidence: partialResult.missingEvidence,
      conflicts: partialResult.conflicts,
      confidenceBp: partialResult.confidenceBp,
      reasons: partialResult.reasons,
      rejectedForScope: partialResult.rejectedForScope,
    };
    return {
      kind: 'EVIDENCE_RESOLUTION',
      ...body,
      resultDigest: digestOf(body),
    };
  }
}

function confidenceFrom(reliability: number | null, requiredKeyCount: number): number {
  if (requiredKeyCount === 0) return 0;
  const base = reliability === null ? 6_000 : Math.round(reliability * 10_000);
  return Math.max(0, Math.min(10_000, base));
}

/** 只读证据来源端口：实现方**必须**在查询层就按 tenant/account 过滤。 */
export interface EvidenceSourcePort {
  findCandidates(input: {
    scope: EvidenceScope;
    acceptableKinds: readonly string[];
    requiredKeys: readonly EvidenceQueryKey[];
  }): Promise<EvidenceCandidate[]>;
}

export function createInMemoryEvidenceSource(candidates: readonly EvidenceCandidate[]): EvidenceSourcePort {
  return {
    async findCandidates({ scope, acceptableKinds }) {
      return candidates.filter(
        (c) =>
          c.organizationId === scope.organizationId &&
          (c.platformAccountId === null || c.platformAccountId === scope.platformAccountId) &&
          acceptableKinds.includes(c.kind),
      );
    },
  };
}

/** 批量解析（多个需求共享同一次候选查询；结果顺序与请求顺序一致）。 */
export async function resolveRequiredEvidence(input: {
  scope: EvidenceScope;
  requirements: readonly EvidenceResolutionRequest[];
  source: EvidenceSourcePort;
  confidenceThresholdBp?: number;
}): Promise<EvidenceResolutionResult[]> {
  const results: EvidenceResolutionResult[] = [];
  for (const request of input.requirements) {
    const candidates = await input.source.findCandidates({
      scope: input.scope,
      acceptableKinds: request.requirement.acceptableKinds,
      requiredKeys: request.requirement.requiredKeys,
    });
    results.push(
      resolveEvidence({
        scope: input.scope,
        candidates,
        request,
        ...(input.confidenceThresholdBp !== undefined
          ? { confidenceThresholdBp: input.confidenceThresholdBp }
          : {}),
      }),
    );
  }
  return results;
}
