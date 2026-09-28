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

const VERSION = '0.1.0';

export function createServer(deps: { prisma: PrismaClient; log: ReturnType<typeof createLogger> }): http.Server {
  const { prisma, log } = deps;

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
