/**
 * CrossClaim API 入口（Wave 0 最小可运行版）
 * ---------------------------------------------------------------
 * 用 Node 内置 http，**零新增依赖**。等路由规模上来再决定用哪个框架
 * （Express / Fastify），并通过 AI-BRIDGE 报备 —— 不在此处提前锁死。
 *
 * 当前只暴露 /health；其余一律 404。
 */

import http from 'node:http';
import { PrismaClient } from '@prisma/client';
import { loadEnv } from './config/env';
import { createLogger, type LogLevel } from './config/logger';
import { checkHealth, healthHttpStatus } from './services/health';
import type { StorageAdapter } from './services/storage';

const VERSION = '0.1.0';

export interface ServerDeps {
  prisma: PrismaClient;
  log: ReturnType<typeof createLogger>;
  /** 可选：注入存储适配层后，`/files/<token>` 才能提供签名下载 */
  storage?: StorageAdapter;
}

export function createServer(deps: ServerDeps): http.Server {
  const { prisma, log, storage } = deps;

  return http.createServer((req, res) => {
    const started = Date.now();
    const url = req.url ?? '/';

    const send = (code: number, payload: unknown) => {
      const body = JSON.stringify(payload);
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
      res.end(body);
      log.info('http_request', { method: req.method, path: url, status: code, ms: Date.now() - started });
    };

    if (req.method === 'GET' && (url === '/health' || url === '/healthz')) {
      checkHealth({ db: prisma, version: VERSION })
        .then((result) => send(healthHttpStatus(result), result))
        .catch((err) =>
          send(503, { status: 'degraded', error: err instanceof Error ? err.message : 'unknown' }),
        );
      return;
    }

    // 签名下载：裸 storageKey 永不出现；签名 / 过期 / 租户三类校验都在适配层内部完成
    if (req.method === 'GET' && url.startsWith('/files/')) {
      if (!storage) {
        send(404, { error: 'not_found', path: '/files' });
        return;
      }
      const token = decodeURIComponent(url.slice('/files/'.length));
      storage
        .openSignedUrl(token)
        .then((object) => {
          res.writeHead(200, {
            'content-type': object.metadata.contentType ?? 'application/octet-stream',
            'content-length': String(object.body.byteLength),
            'content-disposition': `${object.disposition}; filename="${object.filename ?? 'download'}"`,
            'cache-control': 'private, max-age=60',
            'x-content-type-options': 'nosniff',
          });
          res.end(object.body);
          log.info('file_downloaded', { bytes: object.body.byteLength });
        })
        .catch(() => {
          // 不区分"签名错 / 已过期 / 越权"，避免被用来探测
          send(403, { error: 'invalid_or_expired_token' });
        });
      return;
    }

    send(404, { error: 'not_found', path: url });
  });
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

  const server = createServer({ prisma, log });
  server.listen(port, () => log.info('server_listening', { port, env: env.NODE_ENV }));

  const shutdown = async (signal: string) => {
    log.info('shutting_down', { signal });
    server.close();
    await prisma.$disconnect().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
