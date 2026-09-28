import { PrismaClient } from '@prisma/client';

// Prisma 客户端扩展: 自动注入租户隔离
// 所有租户数据操作自动添加 tenantId 过滤
// 注意: 这只是应用层防护，RLS 是数据库层防护

type PrismaQueryParams = {
  operation: string;
  args: any;
  query: (args: any) => Promise<any>;
};

export function withTenantScope(prisma: PrismaClient, tenantId: string) {
  return prisma.$extends({
    query: {
      document: {
        async $allOperations({ operation, args, query }: PrismaQueryParams) {
          if (['create', 'createMany'].includes(operation)) {
            args.data.tenantId = tenantId;
          }
          if (['findMany', 'findFirst', 'findUnique', 'count'].includes(operation)) {
            args.where = { ...(args.where || {}), tenantId };
          }
          return query(args);
        },
      },
      payment: {
        async $allOperations({ operation, args, query }: PrismaQueryParams) {
          if (['create', 'createMany'].includes(operation)) {
            args.data.tenantId = tenantId;
          }
          if (['findMany', 'findFirst', 'findUnique', 'count', 'updateMany', 'deleteMany'].includes(operation)) {
            args.where = { ...(args.where || {}), tenantId };
          }
          return query(args);
        },
      },
      cBAMRecord: {
        async $allOperations({ operation, args, query }: PrismaQueryParams) {
          if (['create', 'createMany'].includes(operation)) {
            args.data.tenantId = tenantId;
          }
          if (['findMany', 'findFirst', 'findUnique', 'count'].includes(operation)) {
            args.where = { ...(args.where || {}), tenantId };
          }
          return query(args);
        },
      },
      subAccount: {
        async $allOperations({ operation, args, query }: PrismaQueryParams) {
          if (['create', 'createMany'].includes(operation)) {
            args.data.tenantId = tenantId;
          }
          if (['findMany', 'findFirst', 'findUnique', 'count'].includes(operation)) {
            args.where = { ...(args.where || {}), tenantId };
          }
          return query(args);
        },
      },
      apiToken: {
        async $allOperations({ operation, args, query }: PrismaQueryParams) {
          if (['create', 'createMany'].includes(operation)) {
            args.data.tenantId = tenantId;
          }
          if (['findMany', 'findFirst', 'findUnique', 'count'].includes(operation)) {
            args.where = { ...(args.where || {}), tenantId };
          }
          return query(args);
        },
      },
      auditLog: {
        async $allOperations({ operation, args, query }: PrismaQueryParams) {
          if (['create', 'createMany'].includes(operation)) {
            args.data.tenantId = tenantId;
          }
          if (['findMany', 'findFirst', 'findUnique', 'count'].includes(operation)) {
            args.where = { ...(args.where || {}), tenantId };
          }
          return query(args);
        },
      },
    },
  });
}

export { PrismaClient };
