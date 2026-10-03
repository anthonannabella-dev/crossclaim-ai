/**
 * CARRIER QUEUE #10 FINAL（MSG-20261003-122 ㉓㉕㉛）— carrier response 的 server-side submission truth。
 * ---------------------------------------------------------------
 * 人工补录必须先有真实的人工提交事实（Queue #9B 的 CarrierManualSubmission）。
 * 本 loader 只读该表并按 (organizationId, packageId) 定位 → 不存在即 null（router 映射 404，不伪造 package）。
 * 只读；无外部调用；不返回 credential。
 */

import type { PrismaClient } from '@prisma/client';

import type { CarrierClaimResponseSubmissionRef } from './carrier-claim-response';

export interface CarrierClaimResponseSubmissionSource {
  load(organizationId: string, packageId: string): Promise<CarrierClaimResponseSubmissionRef | null>;
}

export function createPrismaCarrierClaimResponseSubmissionSource(
  prisma: PrismaClient,
): CarrierClaimResponseSubmissionSource {
  return {
    async load(organizationId, packageId) {
      const row = await prisma.carrierManualSubmission.findUnique({
        where: { organizationId_packageId: { organizationId, packageId } },
      });
      if (row === null) return null;
      return {
        packageId: row.packageId,
        submissionRecordId: row.id,
        provider: row.provider as CarrierClaimResponseSubmissionRef['provider'],
        externalAccountId: row.externalAccountId,
        trackingNumber: row.trackingNumber,
      };
    },
  };
}
