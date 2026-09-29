/**
 * Operations Console E1/E2 辅助夹具（仅开发库）
 *   --counts  打印只读快照计数（JSON）
 *   默认      幂等创建 OPS / FINANCE / VIEWER 三个演示账号（成员于演示组织）
 * 不创建任何业务事实；口令仅为开发默认口令。
 */
import { PrismaClient } from '@prisma/client';

import { hashPassword } from '../src/services/auth/password';

const prisma = new PrismaClient();
const FAST_PARAMS = { N: 1024, r: 8, p: 1, keyLength: 64 };
const PASSWORD = 'dev-only-password-1';
const ORG_SLUG = 'crossclaim-demo';

async function counts() {
  const [user, membership, session, invitation, audit, cases, claim, settlement] = await Promise.all([
    prisma.user.count(),
    prisma.membership.count(),
    prisma.session.count(),
    prisma.userInvitation.count(),
    prisma.auditLog.count(),
    prisma.case.count(),
    prisma.claim.count(),
    prisma.settlement.count(),
  ]);
  console.log(
    JSON.stringify({ user, membership, session, invitation, audit, cases, claim, settlement }),
  );
}

async function ensureRoleUsers() {
  const org = await prisma.organization.findFirstOrThrow({ where: { slug: ORG_SLUG } });
  for (const [email, role, displayName] of [
    ['console-ops@example.com', 'OPS', 'Console OPS'],
    ['console-finance@example.com', 'FINANCE', 'Console FINANCE'],
    ['console-viewer@example.com', 'VIEWER', 'Console VIEWER'],
  ] as const) {
    const user = await prisma.user.upsert({
      where: { email },
      update: {},
      create: {
        email,
        passwordHash: hashPassword(PASSWORD, FAST_PARAMS),
        displayName,
        status: 'ACTIVE',
        emailVerified: true,
      },
    });
    await prisma.membership.upsert({
      where: { organizationId_userId: { organizationId: org.id, userId: user.id } },
      update: { role, isActive: true },
      create: { organizationId: org.id, userId: user.id, role, isActive: true },
    });
    console.log(`ROLE_READY ${role}`);
  }
}

const mode = process.argv[2];

(mode === '--counts' ? counts() : ensureRoleUsers())
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : error);
    await prisma.$disconnect();
    process.exit(1);
  });
