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
import { loadEnv } from './config/env';
import { createLogger, type Logger, type LogLevel } from './config/logger';
import { checkHealth, healthHttpStatus } from './services/health';
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
  createPrismaAuthUserPort,
  createPrismaMembershipLookup,
  createPrismaSessionPort,
  handleAuthRequest,
  handleDataRequest,
  handleUploadRequest,
} from './services/auth';
import { handleWorkflowRequest } from './services/workflow';

const VERSION = '0.1.0';

export interface ServerDeps {
  prisma: PrismaClient;
  log: Logger;
  /** 可选：注入存储适配层后，`/files/<token>` 才能提供签名下载 */
  storage?: StorageAdapter;
  /** 可选：注入审计写入器后，成功下载会写入 AuditLog */
  audit?: AuditWriter;
  /** 可选：C-0008-A 内部认证端口（/auth/*）的依赖覆写 */
  auth?: import('./services/auth').AuthRouteDeps;
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
const WORKFLOW_PATH =
  /^(?:\/opportunities\/[^/]+\/(?:qualify|reject|case)|\/connections(?:\/[^/]+\/(?:status|credential-ref))?|\/cases\/[^/]+\/(?:commercial-terms|recovery-outcome)|\/billing(?:\/[^/]+\/status)?)$/;

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

export function createServer(deps: ServerDeps): http.Server {
  const { prisma, log, storage, audit } = deps;
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
        }
      : undefined);

  return http.createServer((req, res) => {
    const started = Date.now();
    const url = req.url ?? '/';

    // CHANGE #23：/files/<token> 的 token 是短期访问凭证，绝不写进日志。
    // C-0008-B1：改为在响应结束时统一记录一次，覆盖所有直接写响应的处理器
    // （/auth/*、/uploads、/imports、/opportunities/*、/connections*）。
    const logPath = url.startsWith('/files/') ? '/files/[REDACTED]' : url;
    res.on('finish', () => {
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

    // C-0008-A 内部认证端点：仅服务本地/内部 Web 应用，未做公网暴露
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
    if (auth && (url === '/imports' || url === '/opportunities')) {
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
      handleWorkflowRequest(req, res, { prisma, session: auth.session })
        .then((handled) => {
          if (!handled) send(404, { error: 'not_found' });
        })
        .catch((err) =>
          send(500, { error: err instanceof Error ? err.message : 'workflow_error' }),
        );
      return;
    }

    if (req.method === 'GET' && (url === '/health' || url === '/healthz')) {
      checkHealth({ db: prisma, version: VERSION })
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

export function createRuntime(options: RuntimeOptions): Runtime {
  const { env, prisma, log } = options;

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

  return { server: createServer({ prisma, log, storage, ...(audit ? { audit } : {}) }), storage, audit };
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
