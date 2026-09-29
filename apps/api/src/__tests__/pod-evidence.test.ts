/**
 * MSG-20260929-17 Q3 验收：POD 文件上传登记（仅证据登记，不抓取、不解析、不判责）
 * 真实 PostgreSQL + 本地存储适配层。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createAuditWriter, createPrismaAuditSink } from '../services/audit';
import { LocalFileSystemStorage } from '../services/storage';
import {
  detectPodFileKind,
  registerPodEvidence,
  PodEvidenceError,
} from '../services/evidence/pod-upload';

const prisma = new PrismaClient();
const ORG = 'ee000000-0000-4000-8000-00000000000a';
const ORG_B = 'ee000000-0000-4000-8000-00000000000b';
const SALT = 'gate7-pod-evidence-salt-00001';
const NOW = new Date('2026-09-29T09:00:00Z');

const audit = createAuditWriter(createPrismaAuditSink(prisma), { ipSalt: SALT });
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crossclaim-pod-'));
const storage = new LocalFileSystemStorage({
  rootDir: storageRoot,
  secret: SALT,
  publicBaseUrl: 'http://localhost:3000',
});

const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n', 'utf8'), Buffer.alloc(32, 0x20)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16, 2)]);

let caseId = '';

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(storageRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "CaseEvidence", "EvidenceArtifact", "EvidenceEdge", "Case", "FileAsset", "AuditLog", "Organization" CASCADE;',
  );
  await prisma.organization.createMany({
    data: [
      { id: ORG, name: 'POD 租户', slug: 'pod-org' },
      { id: ORG_B, name: '外部租户', slug: 'pod-org-b' },
    ],
  });
  const created = await prisma.case.create({
    data: { organizationId: ORG, caseNo: 'CASE-POD-1', title: 'POD 案件', domain: 'LOGISTICS' },
  });
  caseId = created.id;
});

function deps() {
  return { prisma, storage, audit, now: () => NOW };
}

describe('MSG-17 Q3 · POD 证据文件上传登记', () => {
  it('01 PDF 上传 → FileAsset 落库 + EvidenceArtifact(kind=POD)', async () => {
    const result = await registerPodEvidence(
      { organizationId: ORG, fileName: 'pod-1.pdf', bytes: PDF, mimeType: 'application/pdf' },
      deps(),
    );
    expect(result.fileKind).toBe('PDF');
    expect(result.sizeBytes).toBe(PDF.length);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);

    const asset = await prisma.fileAsset.findUniqueOrThrow({ where: { id: result.fileAssetId } });
    expect(asset.kind).toBe('PDF');
    expect(asset.connectionId).toBeNull();
    const evidence = await prisma.evidenceArtifact.findUniqueOrThrow({
      where: { id: result.evidenceId },
    });
    expect(evidence.kind).toBe('POD');
    expect(evidence.fileAssetId).toBe(result.fileAssetId);
  });

  it('02 PNG / JPEG 接受；其它格式拒绝且不落任何资产', async () => {
    expect(detectPodFileKind(PNG)).toBe('IMAGE');
    expect(detectPodFileKind(JPEG)).toBe('IMAGE');
    expect(detectPodFileKind(Buffer.from('Order ID,Amount\n1,2\n'))).toBeNull();

    await expect(
      registerPodEvidence(
        { organizationId: ORG, fileName: 'pod.csv', bytes: Buffer.from('a,b\n1,2\n') },
        deps(),
      ),
    ).rejects.toBeInstanceOf(PodEvidenceError);
    expect(await prisma.fileAsset.count()).toBe(0);
    expect(await prisma.evidenceArtifact.count()).toBe(0);
  });

  it('03 超过大小上限 → 拒绝（可用 maxBytes 覆盖做测试）', async () => {
    await expect(
      registerPodEvidence(
        { organizationId: ORG, fileName: 'big.pdf', bytes: PDF },
        { ...deps(), maxBytes: 8 },
      ),
    ).rejects.toMatchObject({ code: 'POD_FILE_TOO_LARGE' });
    expect(await prisma.fileAsset.count()).toBe(0);
  });

  it('04 关联案件 → CaseEvidence 建立；跨租户案件被拒绝', async () => {
    const linked = await registerPodEvidence(
      {
        organizationId: ORG,
        fileName: 'pod-2.pdf',
        bytes: PDF,
        caseId,
        role: 'DELIVERY_PROOF',
      },
      deps(),
    );
    expect(linked.caseLinked).toBe(true);
    expect(await prisma.caseEvidence.count({ where: { caseId } })).toBe(1);

    const otherCase = await prisma.case.create({
      data: { organizationId: ORG_B, caseNo: 'CASE-OTHER-1', title: '外部案件', domain: 'LOGISTICS' },
    });
    await expect(
      registerPodEvidence(
        { organizationId: ORG, fileName: 'pod-3.pdf', bytes: PDF, caseId: otherCase.id },
        deps(),
      ),
    ).rejects.toBeTruthy();
  });

  it('05 仅登记：结果不含金额/规则/责任字段，且写入审计', async () => {
    const result = await registerPodEvidence(
      { organizationId: ORG, fileName: 'pod-4.pdf', bytes: PDF },
      deps(),
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/recoverable|amount|owed|liability|carrierApi|signatureVerified/i);

    const actions = await prisma.auditLog.findMany({
      where: { organizationId: ORG },
      select: { action: true },
    });
    expect(actions.length).toBeGreaterThan(0);
  });
});
