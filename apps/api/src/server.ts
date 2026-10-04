/**
 * CrossClaim API 入口（Gate 1：健康检查 + 签名下载）
 * ---------------------------------------------------------------
 * 用 Node 内置 http，**零新增依赖**。等路由规模上来再决定用哪个框架
 * （Express / Fastify），并通过 AI-BRIDGE 报备 —— 不在此处提前锁死。
 *
 * 暴露：
 *   GET /health | /healthz   健康检查
 *   GET /files/<token>       签名下载（租户校验 + 审计）
 * 其余一律 404。
 *
 * CHANGE #18：真实启动路径必须自己装配 Storage Adapter（此前只有测试路径注入），
 *             否则线上 /files 永远拿不到 storage，属于"纸面可用"。
 */

import http from 'node:http';
import { PrismaClient } from '@prisma/client';
import { createPrismaCustomsEntryFactStore } from './services/customs/customs-entry-fact-store';
import {
  createPrismaCustomsAuthorizationCenterLoader,
  createPrismaCustomsOneClickAuthorizationPlanLoader,
} from './services/customs/customs-authorization-center-loader';
import { createPrismaQualificationAssessmentStore } from './services/commercial/recovery-qualification-store';
import { createPrismaPs04StateLoaders } from './services/independent-site/ps04-state-loaders';
import { loadEnv } from './config/env';
import { createLogger, type Logger, type LogLevel } from './config/logger';
import { checkHealth, healthHttpStatus } from './services/health';
import { getOpsReadiness } from './services/ops/ops-readiness';
import { createRateLimiter, rateLimitPolicyFromEnv } from './services/ops/rate-limit';
import { checkReadiness, countLocalMigrations, readinessHttpStatus } from './services/readiness';
import { killSwitchConfigFromEnv } from './services/operations/kill-switch';
import { EnvValuesError, validateEnvValues } from './config/env';
import {
  createEffectiveKillSwitchResolver,
  type EffectiveKillSwitchResolver,
} from './services/operations/kill-switch-resolver';
import { createMetrics } from './services/metrics';
import {
  createStorageAdapter,
  type StorageAdapter,
  type StorageFactoryDeps,
} from './services/storage';
import { createAuditWriter, createPrismaAuditSink, type AuditWriter } from './services/audit';
import {
  createPrismaConnectionLifecyclePort,
  createPrismaFileAssetLookup,
  createPrismaFileAssetPort,
  createPrismaSourceConnectionPort,
} from './services/acquisition';
import { createPrismaImportRepository } from './services/ingest';
import {
  bootstrapSelfServiceAccount,
  createDisabledEmailDelivery,
  createPrismaAuthTokenAccountPort,
  createPrismaAuthUserPort,
  createPrismaEmailVerificationPort,
  createPrismaPasswordResetPort,
  createPrismaMembershipLookup,
  createPrismaSessionPort,
  handleAuthRequest,
  handleDataRequest,
  handleUploadRequest,
  parseCookies,
  resolveSession,
  readSessionToken,
} from './services/auth';
import { handleWorkflowRequest } from './services/workflow';
import {
  handleSeoPublicNodeRequest,
  isSeoPublicRouteRequest,
} from './services/seo/seo-public-node-adapter';
import type { CarrierClaimPackageSource } from './services/carriers/carrier-manual-submission';
import { createAppActionGuard } from './services/action-guard/runtime-guard-composition';

const VERSION = '0.1.0';

export interface ServerDeps {
  prisma: PrismaClient;
  log: Logger;
  /** 可选：注入存储适配层后，`/files/<token>` 才能提供签名下载 */
  storage?: StorageAdapter;
  /** 可选：注入审计写入器后，成功下载会写入 AuditLog */
  audit?: AuditWriter;
  /**
   * CARRIER QUEUE #9B FINAL：server-side claim package truth（测试/部署可注入；缺省返回 null → 404，不伪造 package）。
   */
  carrierClaimPackages?: CarrierClaimPackageSource;
  /** C21：server-side customs opportunity truth / 授权就绪 / filing provider / filing status（缺省 fail-closed）。 */
  customsOpportunities?: import('./services/customs/customs-recovery-http').CustomsRecoveryHttpDeps['opportunities'];
  customsAuthorization?: import('./services/customs/customs-authorization-readiness').CustomsAuthorizationFlags;
  /** CA-5：客户授权中心只读投影（缺省 fail-closed 404）。 */
  customsAuthorizationCenter?: import('./services/customs/customs-authorization-center-http').CustomsAuthorizationCenterHttpDeps;
  /** CA-6：一键追回授权计划只读投影（缺省 fail-closed 404）。 */
  customsAuthorizationPlan?: import('./services/customs/customs-authorization-plan-http').CustomsAuthorizationPlanHttpDeps;
  customsFilingProvider?: { providerId: string; capabilities: import('./services/customs/customs-filing-provider').CustomsFilingCapabilities } | null;
  customsFilingStatus?: import('./services/customs/customs-recovery-http').CustomsRecoveryHttpDeps['filingStatus'];
  /** P0-1：已持久化的 claim evidence 读取。 */
  customsReturnEvidence?: { latest(args: { organizationId: string; entryFactId: string }): Promise<Record<string, unknown> | null> };
  /** BG-020：Customs 事实 store（只读读模型）。 */
  customsEntryFactStore?: import('./services/customs/customs-entry-fact-store').CustomsEntryFactStore;
  /** BG-019：Independent-site 关键状态只读面。 */
  independentSiteState?: import('./services/independent-site/ps04-state-read').Ps04StateReadDeps;
  /** CHANGE A：Platform qualification 只读判定投影。 */
  qualificationRead?: import('./services/commercial/qualification-read').QualificationReadDeps;
  /** BG-012：内部触发执行器（router deps 转发）。 */
  customsRecoveryChain?: { run(args: { organizationId: string; entryFactId: string }): Promise<never> };
  /** 可选：C-0008-A 内部认证端口（/auth/*）的依赖覆写 */
  auth?: import('./services/auth').AuthRouteDeps;
  /**
   * 可选：受保护业务入口的运行时守卫（授权项 ②）。
   * 缺省由 createAppActionGuard 装配（READ_ONLY → 拒绝写入）；测试/组合根可显式注入。
   */
  actionGuard?: import('./services/action-guard/runtime-guard').RuntimeActionGuard;
}

/** 只保留文件名，剥掉路径与危险字符（CR/LF/引号/反斜杠/NUL） */
function safeFilename(filename: string | undefined): string {
  const base = (filename ?? 'download').split(/[\\/]/).pop() ?? 'download';
  const cleaned = base.replace(/[\u0000-\u001f\u007f"\\]/g, '').trim();
  return cleaned.length > 0 ? cleaned.slice(0, 200) : 'download';
}

/** 纯 ASCII 回退名（老客户端/代理用） */
function asciiFilename(filename: string | undefined): string {
  const ascii = safeFilename(filename)
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/[;"\\]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 120);
  return ascii.length > 0 ? ascii : 'download';
}

const RFC5987_EXTRA = /[!'()*]/g;

/** C-0008-B1 / B2-1：工作流端点路径（机会复核 qualify|reject、建案 case、连接管理），其余路径走默认 404。 */
/** MSG-20260929-10 Q1：导入失败明细只读端点（脱敏投影，见 services/auth/data-routes.ts）。 */
const IMPORT_ERROR_REPORT_PATH = /^\/imports\/[^/]+\/error-report$/;

/** MSG-20260929-40：只读的 /operations/*（看板）与 /admin/*（Admin Console）也要进工作流分发，
 *  否则请求在 server 层就落到默认 404 —— 端点「纸面存在、实际不可达」。 */
const WORKFLOW_PATH =
  /^(?:\/carrier-claim-packages\/[^/]+\/(?:manual-submission|responses)|\/customs-entry-facts\/[^/]+(?:\/(?:return-claim-evidence|recovery-chain))?|\/independent-site-disputes\/[^/]+\/state|\/platform-accounts\/[^/]+\/qualification|\/customs-opportunities\/[^/]+\/(?:start-recovery|filing-status|authorization-center|authorization-plan)|\/opportunities(?:\/(?:insights(?:\.csv)?|[^/]+\/(?:qualify|reject|case|basis)))?|\/connections(?:\/[^/]+\/(?:status|credential-ref|rebind))?|\/recovery-states|\/recovery-money|\/accounts|\/entitlements|\/commercial-readiness|\/commercial\/(?:policies(?:\/[^/]+(?:\/accept)?)?|acceptances)|\/provider-readiness|\/payment-activation-readiness|\/cases(?:\/[^/]+\/(?:commercial-terms|recovery-outcome|recovery-review|appeal\/(?:submit|package)|claim(?:\/(?:submit|prepare|package))?|claim-package|billing\/draft|evidence|platform\/write|recovery\/(?:manual-submit|manual-reference|manual-submit-approval|manual-reference-approval))|\/[^/]+)?|\/billing(?:\/[^/]+\/(?:status|payment-review))?|\/commissions\/reconcile|\/payments(?:\/webhook|\/reconciliation(?:\.csv)?|\/events\/[^/]+\/(?:replay|replay-review)|\/processing\/retry-due(?:\/(?:freeze|review))?)?|\/operations\/(?:dashboard|claims|recovery)|\/admin\/(?:tenant-overview|audit(?:\/[^/]+)?|system-health|imports(?:\/[^/]+(?:\/errors)?)?|recovery-review(?:\/[^/]+)?|members(?:\/[^/]+)?|permission-matrix|kill-switch))$/;

/** CHANGE #20：Unicode 文件名走 RFC 5987 的 filename*=UTF-8''，同时给 ASCII 回退名 */
export function buildContentDisposition(
  disposition: 'inline' | 'attachment',
  filename: string | undefined,
): string {
  const encoded = encodeURIComponent(safeFilename(filename)).replace(
    RFC5987_EXTRA,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${disposition}; filename="${asciiFilename(filename)}"; filename*=UTF-8''${encoded}`;
}

let metrics: ReturnType<typeof createMetrics> | undefined;

/**
 * MSG-20260929-68 S3：进程级只读探针 —— 能否完成一次控制面读取与生效值解析。
 * 使用哨兵租户 id（不存在的组织），不读取任何真实租户数据，也不外泄任何租户信息。
 */

async function probeKillSwitchResolver(resolver: EffectiveKillSwitchResolver): Promise<boolean> {
  const sentinelOrganizationId = '00000000-0000-4000-8000-000000000000';
  const results = await resolver.resolveAll(sentinelOrganizationId);
  return results.every((item) => item.degraded !== true);
}

export function createServer(deps: ServerDeps): http.Server {
  const { prisma, log, storage, audit } = deps;
  // MSG-20260929-68：进程内 resolver 单例（只读端口；控制面写入后由写路径 invalidate）
  const killSwitchResolver = createEffectiveKillSwitchResolver({
    controlRequests: { findMany: (args) => prisma.killSwitchRequest.findMany(args) },
    config: killSwitchConfigFromEnv(),
  });
  /**
   * PC-08 CHANGE B：期望迁移数复用既有 countLocalMigrations()（只读；不执行 migrate）。
   * 不可读时返回 -1，由 readiness 事实投影映射为 UNKNOWN / MIGRATION_MISMATCH。
   */
  const expectedMigrations = countLocalMigrations();
  /**
   * PC-08 CHANGE D：最小安全 storage 探针（只读 head：验证读取路径与 key 形状，不写入、不删除）。
   * 不返回 storageKey / secret / path。
   */
  const storageProbe = storage
    ? async (): Promise<boolean> => {
        const probeOrg = '00000000-0000-4000-8000-000000000000';
        const probeKey = probeOrg + '/00/' + probeOrg;
        const meta = await storage.head(probeKey, probeOrg);
        return meta === null || typeof meta === 'object';
      }
    : undefined;

  /** PC-08：匿名入口的 rate limit 基线（每次装配读取环境；进程内固定窗口）。 */
  const rateLimitPolicy = rateLimitPolicyFromEnv();
  const authRateLimiter = createRateLimiter(rateLimitPolicy);
  /** PC-08：Action Guard 单例（缺省装配为 READ_ONLY 姿态），供 workflow 分支与 ops 视图共享。 */
  const actionGuard = deps.actionGuard ?? createAppActionGuard({ prisma, killSwitchResolver });
  // 审计 IP 盐值只影响“谁”的哈希；缺失时保持空值（不阻塞服务启动）
  const auditIpSalt = (() => {
    try {
      const env = loadEnv();
      return env.AUDIT_IP_SALT ?? env.STORAGE_URL_SECRET ?? '';
    } catch {
      return '';
    }
  })();
  const auth: import('./services/auth').AuthRouteDeps | undefined =
    deps.auth ??
    (audit
      ? {
          users: createPrismaAuthUserPort(prisma),
          session: {
            sessions: createPrismaSessionPort(prisma),
            memberships: createPrismaMembershipLookup(prisma),
            audit,
            ipSalt: auditIpSalt,
          },
          audit,
          // C-0008-A 裁定：未知邮箱失败登录没有租户归属 → 只写结构化安全日志
          log: (event, fields) => log.warn(event, fields),
          // PC-01A：默认关闭（PUBLIC_SIGNUP_ENABLED=false），fail-closed。
          signupEnabled: process.env.PUBLIC_SIGNUP_ENABLED === 'true',
          selfSignup: (input) =>
            bootstrapSelfServiceAccount(prisma, input, {
              enabled: process.env.PUBLIC_SIGNUP_ENABLED === 'true',
            }),
          // PC-01B（MSG-20261003-148/149）：邮箱验证 / 密码重置生命周期；EMAIL_DELIVERY 仍为 EXTERNAL_GATE。
          lifecycle: {
            accounts: createPrismaAuthTokenAccountPort(prisma),
            emailVerification: createPrismaEmailVerificationPort(prisma),
            passwordReset: createPrismaPasswordResetPort(prisma),
            delivery: createDisabledEmailDelivery(),
            audit,
            log: (event, fields) => log.warn(event, fields),
            ipSalt: auditIpSalt,
          },
        }
      : undefined);

  return http.createServer((req, res) => {
    const started = Date.now();
    // O9：进程内计数器（只按方法与状态码分类，不采集租户/PII 数据）
    metrics ??= createMetrics();
    const url = req.url ?? '/';

    // CHANGE #23：/files/<token> 的 token 是短期访问凭证，绝不写进日志。
    // C-0008-B1：改为在响应结束时统一记录一次，覆盖所有直接写响应的处理器
    // （/auth/*、/uploads、/imports、/opportunities/*、/connections*）。
    const logPath = url.startsWith('/files/') ? '/files/[REDACTED]' : url;
    res.on('finish', () => {
      metrics?.observe(req.method ?? 'UNKNOWN', res.statusCode, Date.now() - started);
      log.info('http_request', {
        method: req.method,
        path: logPath,
        status: res.statusCode,
        ms: Date.now() - started,
      });
    });

    const send = (code: number, payload: unknown) => {
      const body = JSON.stringify(payload);
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
      res.end(body);
    };

    // SEO-3 public read-only checker (MSG-20261005-05). Disabled unless
    // PUBLIC_SEO_CHECKER_ENABLED === 'true'; it must never fall through to
    // the session-based branches below.
    if (isSeoPublicRouteRequest(req)) {
      void handleSeoPublicNodeRequest(req, res, { prisma }).catch(() =>
        send(500, { ok: false, code: 'SEO_PUBLIC_ROUTE_ERROR' }),
      );
      return;
    }

    // C-0008-A 内部认证端点：仅服务本地/内部 Web 应用，未做公网暴露
    // PC-08：最敏感的匿名入口限流基线（只拒绝过量请求，不读取/记录任何凭据）。
    const anonymousAuthPaths = [
      '/auth/login',
      '/auth/signup',
      '/auth/forgot-password',
      '/auth/reset-password',
      '/auth/resend-verification',
      '/auth/verify-email',
    ];
    if (req.method === 'POST' && anonymousAuthPaths.includes(url)) {
      const clientKey = (req.socket.remoteAddress ?? 'unknown') + '|' + url;
      const decision = authRateLimiter.check(url, clientKey);
      if (!decision.allowed) {
        res.writeHead(429, {
          'content-type': 'application/json; charset=utf-8',
          'retry-after': String(Math.ceil(decision.retryAfterMs / 1000)),
        });
        res.end(JSON.stringify({ error: 'RATE_LIMITED', retryAfterMs: decision.retryAfterMs }));
        return;
      }
    }

    if (auth && url.startsWith('/auth/')) {
      handleAuthRequest(req, res, auth)
        .then((handled) => {
          if (!handled) send(404, { error: 'not_found' });
        })
        .catch((err) =>
          send(500, { error: err instanceof Error ? err.message : 'auth_error' }),
        );
      return;
    }

    // C-0008-A 内部上传端点（会话保护；文件字节经内容扫描后进入导入流水线）
    if (auth && storage && url === '/uploads') {
      handleUploadRequest(req, res, {
        prisma,
        session: auth.session,
        connectionLifecycle: createPrismaConnectionLifecyclePort(prisma),
        connections: createPrismaSourceConnectionPort(prisma),
        fileAssets: createPrismaFileAssetPort(prisma),
        fileAssetLookup: createPrismaFileAssetLookup(prisma),
        storage,
        imports: createPrismaImportRepository(prisma, { audit }),
        audit: audit as AuditWriter,
      })
        .then((handled) => {
          if (!handled) send(404, { error: 'not_found' });
        })
        .catch((err) =>
          send(500, { error: err instanceof Error ? err.message : 'upload_error' }),
        );
      return;
    }

    // C-0008-A 内部只读数据端点（导入批次 / 追回机会），同样仅面向内部 Web
    if (
      auth &&
      // PC-02（MSG-20261002-82 ⑥）：bare `/opportunities` 现由 workflow 路由提供
      // 客户可见机会列表（filter + cursor 分页）；旧 data-routes 机会列表入口已退役。
      (url === '/imports' ||
        IMPORT_ERROR_REPORT_PATH.test(url.split('?')[0] ?? ''))
    ) {
      handleDataRequest(req, res, { prisma, session: auth.session })
        .then((handled) => {
          if (!handled) send(404, { error: 'not_found' });
        })
        .catch((err) =>
          send(500, { error: err instanceof Error ? err.message : 'data_error' }),
        );
      return;
    }

    // C-0008-B1 / B2-1 内部工作流端点：机会复核、建案、连接管理；会话与角色矩阵由服务层校验
    if (auth && WORKFLOW_PATH.test(url.split('?')[0] ?? '')) {
      handleWorkflowRequest(req, res, {
        prisma,
        // CARRIER QUEUE #9B FINAL：人工提交记录路由的 server-side package truth
        ...(deps.carrierClaimPackages ? { carrierClaimPackages: deps.carrierClaimPackages } : {}),
...(deps.customsOpportunities ? { customsOpportunities: deps.customsOpportunities } : {}),
...(deps.customsAuthorization ? { customsAuthorization: deps.customsAuthorization } : {}),
      // CA-5 FINAL（MSG-20261004-09）：真实 Prisma tenant-scoped loader（缺省即装配，不再用进程级授权 flags）
      ...(deps.customsAuthorizationCenter
        ? { customsAuthorizationCenter: deps.customsAuthorizationCenter }
        : {
            customsAuthorizationCenter: createPrismaCustomsAuthorizationCenterLoader(prisma, {
              ...(deps.customsFilingProvider !== undefined ? { provider: deps.customsFilingProvider } : {}),
            }),
          }),
      ...(deps.customsAuthorizationPlan
        ? { customsAuthorizationPlan: deps.customsAuthorizationPlan }
        : {
            customsAuthorizationPlan: createPrismaCustomsOneClickAuthorizationPlanLoader(prisma, {
              ...(deps.customsFilingProvider !== undefined ? { provider: deps.customsFilingProvider } : {}),
            }),
          }),
      ...(deps.customsAuthorizationCenter ? { customsAuthorizationCenter: deps.customsAuthorizationCenter } : {}),
...(deps.customsFilingProvider !== undefined ? { customsFilingProvider: deps.customsFilingProvider } : {}),
...(deps.customsFilingStatus ? { customsFilingStatus: deps.customsFilingStatus } : {}),
...(deps.customsReturnEvidence ? { customsReturnEvidence: deps.customsReturnEvidence } : {}),
      ...(deps.customsEntryFactStore ? { customsEntryFactStore: deps.customsEntryFactStore } : {}),
      ...(deps.independentSiteState ? { independentSiteState: deps.independentSiteState } : {}),
      ...(deps.qualificationRead ? { qualificationRead: deps.qualificationRead } : {}),
...(deps.customsRecoveryChain ? { customsRecoveryChain: deps.customsRecoveryChain } : {}),
        session: auth.session,
        // 授权项 ②（MSG-20260930-16 §6）：受保护入口的运行时闸门；缺省 READ_ONLY → 拒绝写入
        actionGuard,
        // ② claim.submit：人工提交（claim.submitted_by_human）沿用同一个 AuditWriter；
        // 未注入时由路由按同策略自建，盐值不足则 fail closed
        ...(audit ? { audit } : {}),
        killSwitchResolver,
        // C-0010-C2：webhook 的结构化安全日志（验签失败 / 版本不一致）必须落到运行时 logger
        log: (event, fields) => log.warn(event, fields),
      })
        .then((handled) => {
          if (!handled) send(404, { error: 'not_found' });
        })
        .catch((err) =>
          send(500, { error: err instanceof Error ? err.message : 'workflow_error' }),
        );
      return;
    }

    // O9：默认不暴露；只有显式开启才返回 Prometheus 文本
    if (req.method === 'GET' && url === '/metrics') {
      if (process.env.METRICS_ENABLED !== 'true') {
        send(404, { error: 'not_found' });
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
      res.end(metrics?.render() ?? '');
      return;
    }

    // P2-1（MSG-20260929-70 D1）：readiness 独立于 liveness；只返回原因码
    // PC-08 CHANGE A：/health/ready 复用既有真实 readiness path（与 /readyz 同一实现）。
    if (req.method === 'GET' && (url === '/readyz' || url === '/health/ready')) {
      checkReadiness({
        databaseProbe: async () => {
          await prisma.$queryRaw`SELECT 1`;
        },
        appliedMigrations: async () => {
          const rows = (await prisma.$queryRaw`
            SELECT count(*)::int AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL
          `) as Array<{ count: number }>;
          return rows[0]?.count ?? 0;
        },
        expectedMigrations: countLocalMigrations(),
        resolverProbe: () => probeKillSwitchResolver(killSwitchResolver),
        version: VERSION,
      })
        .then((result) => send(readinessHttpStatus(result), result))
        .catch(() =>
          send(503, {
            ready: false,
            reasons: ['DATABASE_UNAVAILABLE'],
            checkedAt: new Date().toISOString(),
            version: VERSION,
          }),
        );
      return;
    }

    // PC-08：liveness 与 readiness 分离（liveness 只证明进程存活，不依赖任何下游）。
    if (req.method === 'GET' && url === '/health/live') {
      send(200, { status: 'ok', kind: 'liveness', checkedAt: new Date().toISOString() });
      return;
    }

    // PC-08：只读运维就绪视图（需要 OWNER / ADMIN 会话）。
    if (req.method === 'GET' && url === '/ops-readiness') {
      if (!auth) {
        send(503, { error: 'ops_unavailable' });
        return;
      }
      const cookie = readSessionToken(parseCookies(req.headers.cookie));
      if (!cookie) {
        send(401, { error: 'UNAUTHENTICATED' });
        return;
      }
      resolveSession(cookie, auth.session)
        .then(async (context) => {
          if (!context) {
            send(401, { error: 'UNAUTHENTICATED' });
            return;
          }
          if (context.role !== 'OWNER' && context.role !== 'ADMIN') {
            send(403, { error: 'FORBIDDEN' });
            return;
          }
          const readiness = await getOpsReadiness({
            prisma,
            killSwitchProbe: () => probeKillSwitchResolver(killSwitchResolver),
            actionGuardConfigured: Boolean(actionGuard),
            rateLimit: rateLimitPolicy,
            ...(expectedMigrations >= 0 ? { expectedMigrations } : {}),
            ...(storageProbe ? { storageProbe } : {}),
          });
          send(200, readiness);
        })
        .catch(() => send(503, { error: 'ops_unavailable' }));
      return;
    }

    if (req.method === 'GET' && (url === '/health' || url === '/healthz')) {
      checkHealth({
        db: prisma,
        version: VERSION,
        killSwitch: () => probeKillSwitchResolver(killSwitchResolver),
      })
        .then((result) => send(healthHttpStatus(result), result))
        .catch((err) =>
          send(503, { status: 'degraded', error: err instanceof Error ? err.message : 'unknown' }),
        );
      return;
    }

    // 签名下载：裸 storageKey 永不出现；解密 / 过期 / 租户三类校验都在适配层内部完成
    if (req.method === 'GET' && url.startsWith('/files/')) {
      // CHANGE #21：没有 storage（或没有 audit）时不得提供下载 —— fail closed
      if (!storage || !audit) {
        send(503, { error: 'file_download_unavailable' });
        return;
      }

      // CHANGE #19：畸形百分号编码不得抛异常击穿 handler
      let token: string;
      try {
        token = decodeURIComponent(url.slice('/files/'.length));
      } catch {
        send(400, { error: 'malformed_token' });
        return;
      }
      if (token.length === 0 || token.length > 4096) {
        send(403, { error: 'invalid_or_expired_token' });
        return;
      }

      storage
        .openSignedUrl(token)
        .then(async (object) => {
          // CHANGE #17 + #21：审计必须**先写成功**，才允许把字节发出去。
          // 审计失败 = 不允许无痕下载 → 503，绝不返回文件内容。
          try {
            await audit.record({
              organizationId: object.organizationId,
              actorType: 'EXTERNAL',
              actorRef: 'signed-url',
              action: 'file.downloaded',
              entityType: 'FileAsset',
              entityId: object.fileAssetId,
              changes: {
                disposition: object.disposition,
                bytes: object.body.byteLength,
                filename: object.filename ?? null,
              },
              ...(req.socket.remoteAddress ? { ip: req.socket.remoteAddress } : {}),
              ...(req.headers['user-agent'] ? { userAgent: String(req.headers['user-agent']) } : {}),
            });
          } catch (err) {
            log.error('audit_write_failed', {
              action: 'file.downloaded',
              reason: err instanceof Error ? err.name : 'unknown',
            });
            send(503, { error: 'audit_unavailable' });
            return;
          }

          res.writeHead(200, {
            'content-type': object.metadata.contentType ?? 'application/octet-stream',
            'content-length': String(object.body.byteLength),
            'content-disposition': buildContentDisposition(object.disposition, object.filename),
            'cache-control': 'private, max-age=60',
            'x-content-type-options': 'nosniff',
          });
          res.end(object.body);
          log.info('file_downloaded', { bytes: object.body.byteLength });
        })
        .catch((err: unknown) => {
          // 失败请求只进普通安全日志，不污染审计表（避免攻击流量灌库）
          log.warn('file_download_denied', {
            reason: err instanceof Error ? err.name : 'unknown',
          });
          // 不区分"签名错 / 已过期 / 越权"，避免被用来探测
          send(403, { error: 'invalid_or_expired_token' });
        });
      return;
    }

    send(404, { error: 'not_found', path: url });
  });
}

// ============================================================
// 运行时装配（CHANGE #18）：env → storage → audit → server
// ============================================================

export interface RuntimeOptions {
  env: Record<string, string>;
  prisma: PrismaClient;
  log: Logger;
  storageDeps?: StorageFactoryDeps;
}

export interface Runtime {
  server: http.Server;
  storage: StorageAdapter;
  audit: AuditWriter | null;
}

/**
 * CHANGE C/E（MSG-20261003-142）— **默认只读运行时装配**。
 * createRuntime 与 runtime E2E 共用同一函数，杜绝「service/HTTP 已实现但 composition root 没接」。
 * 全部只读：只装配 store / loader，不引入任何外部调用。
 */
export function createDefaultReadDeps(prisma: PrismaClient) {
  const qualificationStore = createPrismaQualificationAssessmentStore(prisma);
  return {
    customsEntryFactStore: createPrismaCustomsEntryFactStore(prisma),
    qualificationRead: {
      loadLatest: (args: { organizationId: string; platformAccountId: string }) => qualificationStore.loadLatestAssessment(args),
    },
    independentSiteState: createPrismaPs04StateLoaders(prisma),
    // CA-5：授权中心只读 loader（tenant-scoped 事实派生；无 route/lineage 事实即 404 fail-closed）
    customsAuthorizationCenter: createPrismaCustomsAuthorizationCenterLoader(prisma),
  };
}

export function createRuntime(options: RuntimeOptions): Runtime {
  const { env, prisma, log } = options;

  // P2-1（MSG-20260929-70）：取值层面 fail fast（只报变量名与原因码，绝不回显取值）
  const envValidation = validateEnvValues(env);
  if (envValidation.errors.length > 0) {
    throw new EnvValuesError(envValidation.errors);
  }
  for (const warning of envValidation.warnings) {
    log.warn('env_warning', { code: warning });
  }

  // S3 驱动缺凭据时必须 fail fast，不静默回退 local
  const storage = createStorageAdapter(env, options.storageDeps ?? {});

  const auditSalt = env.AUDIT_IP_SALT ?? env.STORAGE_URL_SECRET ?? '';
  let audit: AuditWriter | null = null;
  if (auditSalt) {
    if (auditSalt.length < 16) {
      throw new Error('审计 IP 盐值过短：AUDIT_IP_SALT（或回退的 STORAGE_URL_SECRET）至少 16 位');
    }
    audit = createAuditWriter(createPrismaAuditSink(prisma), { ipSalt: auditSalt });
  } else {
    log.warn('audit_disabled', { reason: 'AUDIT_IP_SALT / STORAGE_URL_SECRET 均未配置' });
  }

  return {
    server: createServer({ prisma, log, storage, ...(audit ? { audit } : {}), ...createDefaultReadDeps(prisma) } as never),
    storage,
    audit,
  };
}

/* istanbul ignore next -- 入口引导，测试不覆盖 */
if (require.main === module) {
  const env = loadEnv();
  const log = createLogger({
    level: (env.LOG_LEVEL as LogLevel) ?? 'info',
    bindings: { service: 'crossclaim-api', version: VERSION },
  });
  const prisma = new PrismaClient();
  const port = Number(env.PORT ?? 3000);

  const { server } = createRuntime({ env, prisma, log });
  server.listen(port, () =>
    log.info('server_listening', {
      port,
      env: env.NODE_ENV,
      storage: env.STORAGE_DRIVER ?? 'local',
    }),
  );

  const shutdown = async (signal: string) => {
    log.info('shutting_down', { signal });
    server.close();
    await prisma.$disconnect().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
