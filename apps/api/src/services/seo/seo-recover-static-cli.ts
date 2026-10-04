/**
 * SEO-4 构建期导出 CLI（MSG-20261004-35 OPTION_B_REVISED）
 * ---------------------------------------------------------------
 * 用法：npx tsx src/services/seo/seo-recover-static-cli.ts [输出路径]
 * 行为：从 RuleVersion 读取**生效**规则 → 已验收 codec/facade → `seo-recover-static-v1` artifact 落盘。
 *
 * 安全默认（fail-closed）：
 *   · 未提供已注册 basis key 注册表时传空数组 → SEO-6 gate 必然不过 → 全部页面 noindex；
 *   · 任何解析失败的规则被跳过并记录，绝不猜测内容；
 *   · 只写白名单 artifact（导出器自校验），不写任何租户/凭据/PII。
 * 声明：本脚本只读规则表 + 写本地 artifact 文件，不产生外写、不调用 provider、不使用生产凭据。
 */

import { writeFileSync } from 'node:fs';

import { PrismaClient } from '@prisma/client';

import { buildRecoverStaticProjectionFromRules } from './seo-recover-static-export';
import { toExportRules } from './seo-recover-rule-source';

export interface RecoverStaticExportSummary {
  outputPath: string;
  pages: number;
  rules: number;
  rejected: readonly { ref: string; reason: string }[];
  indexable: number;
  sourceDigest: string;
}

export async function exportRecoverStaticPages(options: {
  prisma: PrismaClient;
  outputPath: string;
  baseUrl: string;
  now?: Date;
  registeredBasisKeys?: readonly string[];
}): Promise<RecoverStaticExportSummary> {
  const now = options.now ?? new Date();
  const rows = await options.prisma.ruleVersion.findMany({
    where: { isActive: true, definition: { not: undefined } },
    orderBy: [{ ruleSetId: 'asc' }, { effectiveFrom: 'asc' }],
  });

  const source = toExportRules({
    rows,
    now,
    registeredBasisKeys: options.registeredBasisKeys ?? [],
  });

  const artifact = buildRecoverStaticProjectionFromRules({
    rules: source.rules,
    now,
    baseUrl: options.baseUrl,
  });

  writeFileSync(options.outputPath, JSON.stringify(artifact, null, 2) + '\n', 'utf8');

  return {
    outputPath: options.outputPath,
    pages: artifact.pages.length,
    rules: source.rules.length,
    rejected: source.rejected,
    indexable: artifact.pages.filter((page) => page.inSitemap && page.robots === 'index,follow').length,
    sourceDigest: artifact.sourceDigest,
  };
}

const isDirectRun = process.argv[1] !== undefined && process.argv[1].includes('seo-recover-static-cli');
if (isDirectRun) {
  const outputPath = process.argv[2] ?? 'apps/web/.generated/recover-projection.json';
  const baseUrl = process.env.RECOVER_PUBLIC_BASE_URL ?? 'https://crossclaim.example';
  const prisma = new PrismaClient();
  exportRecoverStaticPages({ prisma, outputPath, baseUrl })
    .then((summary) => {
      console.log(
        `RECOVER_PROJECTION_WRITTEN pages=${summary.pages} rules=${summary.rules} indexable=${summary.indexable} ` +
          `rejected=${summary.rejected.length} digest=${summary.sourceDigest.slice(0, 12)}`,
      );
    })
    .finally(() => prisma.$disconnect());
}
