/**
 * 合成数据种子（开发 / 演示 / 离线端到端用）
 * ---------------------------------------------------------------
 * 原则：
 *   1. **幂等**：全部 upsert，可重复执行；
 *   2. **拒绝生产**：NODE_ENV=production 时直接退出（需显式 SEED_ALLOW_PRODUCTION=1 才放行）；
 *   3. **不打印任何口令**：只回显邮箱与角色；
 *   4. **不制造业务事实**：只建组织 / 用户 / 成员关系 / 一个 FILE_UPLOAD 连接，
 *      不伪造金额、不伪造索赔、不写账本。
 */

import { PrismaClient } from '@prisma/client';

import { assertPasswordPolicy, hashPassword } from '../src/services/auth/password';

const prisma = new PrismaClient();

/** 仅开发用：满足「>=12 字符且含字母+数字」的口令策略 */
const DEV_DEFAULT_PASSWORD = 'dev-only-password-1';

function resolveSeedInput() {
  const email = (process.env.SEED_OWNER_EMAIL ?? 'owner@example.com').trim().toLowerCase();
  const password = process.env.SEED_OWNER_PASSWORD ?? DEV_DEFAULT_PASSWORD;
  const orgName = process.env.SEED_ORG_NAME ?? 'CrossClaim Demo Org';
  const orgSlug = (process.env.SEED_ORG_SLUG ?? 'crossclaim-demo').trim().toLowerCase();
  const displayName = process.env.SEED_OWNER_NAME ?? 'Demo Owner';
  return { email, password, orgName, orgSlug, displayName };
}

async function main() {
  if (process.env.NODE_ENV === 'production' && process.env.SEED_ALLOW_PRODUCTION !== '1') {
    throw new Error('拒绝在生产环境执行 seed（如确需，请显式设置 SEED_ALLOW_PRODUCTION=1）');
  }

  const { email, password, orgName, orgSlug, displayName } = resolveSeedInput();
  assertPasswordPolicy(password);
  const usingDevDefault = password === DEV_DEFAULT_PASSWORD;

  const organization = await prisma.organization.upsert({
    where: { slug: orgSlug },
    update: {},
    create: { name: orgName, slug: orgSlug },
  });

  const user = await prisma.user.upsert({
    where: { email },
    update: {},
    create: {
      email,
      displayName,
      emailVerified: true,
      passwordHash: hashPassword(password),
    },
  });

  await prisma.membership.upsert({
    where: { organizationId_userId: { organizationId: organization.id, userId: user.id } },
    update: { role: 'OWNER', isActive: true },
    create: { organizationId: organization.id, userId: user.id, role: 'OWNER' },
  });

  await prisma.sourceConnection.upsert({
    where: {
      organizationId_channel_label: {
        organizationId: organization.id,
        channel: 'OTHER',
        label: 'Demo file upload',
      },
    },
    update: {},
    create: {
      organizationId: organization.id,
      domain: 'LOGISTICS',
      channel: 'OTHER',
      kind: 'FILE_UPLOAD',
      status: 'ACTIVE',
      label: 'Demo file upload',
    },
  });

  console.log(
    JSON.stringify({
      seeded: true,
      organization: organization.slug,
      ownerEmail: user.email,
      role: 'OWNER',
      passwordFromEnv: !usingDevDefault,
      note: usingDevDefault ? '使用开发默认口令，请勿用于任何真实环境' : '口令来自 SEED_OWNER_PASSWORD',
    }),
  );
}

main()
  .catch((error) => {
    console.error(`SEED_FAILED: ${error instanceof Error ? error.message : 'unknown error'}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
