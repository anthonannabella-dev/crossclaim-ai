// PROVIDER FOLLOW-UP INTELLIGENCE / P3（slice A-S4）—— 解读落库（append-only、幂等、tenant-scoped）

import type { PrismaClient } from '@prisma/client';

import {
  CASE_RESPONSE_INTELLIGENCE_BOUNDARY,
  assertInterpretationIsAdvisory,
  type CaseResponseInterpretation,
} from './case-response-intelligence';
import { ProviderSupportError } from './provider-case';

export interface PersistInterpretationResult {
  kind: 'APPENDED' | 'REUSED';
  interpretationId: string;
  interpretationDigest: string;
}

/** 写入 AI 解读：同 (org, account, contact, classifierVersion, model, promptVersion) 幂等复用。 */
export async function persistCaseResponseInterpretation(
  prisma: PrismaClient,
  input: { interpretation: CaseResponseInterpretation; platform?: string; now: Date },
): Promise<PersistInterpretationResult> {
  const record = input.interpretation;
  assertInterpretationIsAdvisory(record);
  if (!CASE_RESPONSE_INTELLIGENCE_BOUNDARY.advisoryOnly || record.canAuthorizeExecution !== false) {
    throw new ProviderSupportError(
      'PROVIDER_SUPPORT_MALFORMED_PAYLOAD',
      'AI 解读必须是 advisory only（不得携带执行能力）',
    );
  }
  const existing = await prisma.providerCaseResponseInterpretation.findFirst({
    where: {
      organizationId: record.organizationId,
      platformAccountId: record.platformAccountId,
      sourceContactId: record.sourceContactId,
      classifierVersion: record.classifierVersion,
      model: record.model,
      promptVersion: record.promptVersion,
    },
    select: { id: true, interpretationDigest: true },
  });
  if (existing) {
    if (existing.interpretationDigest !== record.interpretationDigest) {
      throw new ProviderSupportError(
        'PROVIDER_SUPPORT_MALFORMED_PAYLOAD',
        '同一 (contact, classifierVersion, model, promptVersion) 的解读摘要不一致（禁止 silent overwrite）',
      );
    }
    return { kind: 'REUSED', interpretationId: existing.id, interpretationDigest: existing.interpretationDigest };
  }
  const created = await prisma.providerCaseResponseInterpretation.create({
    data: {
      organizationId: record.organizationId,
      platformAccountId: record.platformAccountId,
      platform: input.platform ?? 'AMAZON',
      providerCaseId: record.providerCaseId,
      sourceContactId: record.sourceContactId,
      sourceBodyDigest: record.sourceBodyDigest,
      classification: record.classification,
      confidenceBp: record.confidenceBp,
      requiredEvidence: JSON.stringify(record.requiredEvidence),
      extractedRequirements: JSON.stringify(record.extractedRequirements),
      recommendedNextAction: record.recommendedNextAction,
      disposition: record.disposition,
      dispositionReasons: JSON.stringify(record.dispositionReasons),
      injectionSuspected: record.injectionSuspected,
      model: record.model,
      promptVersion: record.promptVersion,
      classifierVersion: record.classifierVersion,
      interpretationDigest: record.interpretationDigest,
      createdAt: new Date(record.createdAt),
      recordedAt: input.now,
    },
  });
  return { kind: 'APPENDED', interpretationId: created.id, interpretationDigest: record.interpretationDigest };
}

export async function listCaseResponseInterpretations(
  prisma: PrismaClient,
  scope: { organizationId: string; platformAccountId: string; providerCaseId: string },
): Promise<
  Array<{
    id: string;
    sourceContactId: string;
    classification: string;
    disposition: string;
    recommendedNextAction: string;
    requiredEvidence: string[];
    confidenceBp: number;
    injectionSuspected: boolean;
    recordedAt: string;
  }>
> {
  const rows = await prisma.providerCaseResponseInterpretation.findMany({
    where: {
      organizationId: scope.organizationId,
      platformAccountId: scope.platformAccountId,
      providerCaseId: scope.providerCaseId,
    },
    orderBy: { recordedAt: 'asc' },
  });
  return rows.map((row) => ({
    id: row.id,
    sourceContactId: row.sourceContactId,
    classification: row.classification,
    disposition: row.disposition,
    recommendedNextAction: row.recommendedNextAction,
    requiredEvidence: JSON.parse(row.requiredEvidence) as string[],
    confidenceBp: row.confidenceBp,
    injectionSuspected: row.injectionSuspected,
    recordedAt: row.recordedAt.toISOString(),
  }));
}
