/**
 * O9 / TD-7 — 最小可观测性：metrics 渲染与 `/metrics` 端点开关。
 * 不触网、不写数据库；只验证计数器口径与「默认不暴露」的安全默认值。
 */

import type { PrismaClient } from '@prisma/client';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { createLogger } from '../config/logger';
import { createServer, type ServerDeps } from '../server';
import { createMetrics, statusClassOf } from '../services/metrics';

function stubPrisma(): PrismaClient {
  return {
    auditLog: { create: async () => ({ id: 'audit-1', createdAt: new Date() }), findMany: async () => [] },
    $queryRaw: async () => [{ ok: 1 }],
  } as unknown as PrismaClient;
}

function deps(): ServerDeps {
  return { prisma: stubPrisma(), log: createLogger({ level: 'error', sink: () => undefined }) };
}

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

const originalMetricsEnabled = process.env.METRICS_ENABLED;
const openServers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  if (originalMetricsEnabled === undefined) delete process.env.METRICS_ENABLED;
  else process.env.METRICS_ENABLED = originalMetricsEnabled;

  await Promise.all(
    openServers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
});

describe('metrics：计数器与渲染', () => {
  it('按 method + 状态码分类聚合，并累计耗时', () => {
    const metrics = createMetrics(() => 1_000, 0);
    metrics.observe('GET', 200, 10);
    metrics.observe('GET', 404, 20);
    metrics.observe('post', 500, 30);

    const snapshot = metrics.snapshot();
    expect(snapshot.requestsTotal).toBe(3);
    expect(snapshot.byMethodAndStatus).toEqual({ 'GET|2xx': 1, 'GET|4xx': 1, 'POST|5xx': 1 });
    expect(snapshot.durationSumMs).toBe(60);
    expect(snapshot.durationCount).toBe(3);
    expect(snapshot.uptimeSeconds).toBe(1);
  });

  it('渲染为 Prometheus 文本，且不包含未转义字符', () => {
    const metrics = createMetrics(() => 5_000, 0);
    metrics.observe('GET', 200, 12);
    const rendered = metrics.render();

    expect(rendered).toContain('crossclaim_http_requests_total{method="GET",status_class="2xx"} 1');
    expect(rendered).toContain('crossclaim_http_request_duration_ms_sum 12');
    expect(rendered).toContain('crossclaim_process_uptime_seconds 5');
    expect(rendered).toContain('# TYPE crossclaim_http_requests_total counter');
  });

  it('异常方法名与非法状态码不会破坏标签或计数', () => {
    const metrics = createMetrics(() => 0, 0);
    metrics.observe('GET"\n{evil}', 0, Number.NaN);

    const rendered = metrics.render();
    // 方法名会先大写化，再逐字符转义为安全字符
    expect(rendered).toContain('method="GET___EVIL_"');
    expect(rendered).toContain('status_class="other"');
    expect(rendered).not.toContain('{evil}');
    expect(statusClassOf(0)).toBe('other');
    expect(statusClassOf(503)).toBe('5xx');
  });
});

describe('metrics：/metrics 端点默认不暴露', () => {
  it('未设置 METRICS_ENABLED 时返回 404', async () => {
    delete process.env.METRICS_ENABLED;
    const server = createServer(deps());
    openServers.push(server);
    const base = await listen(server);

    const response = await fetch(`${base}/metrics`);
    expect(response.status).toBe(404);
  });

  it('METRICS_ENABLED=true 时返回 Prometheus 文本并计入请求', async () => {
    process.env.METRICS_ENABLED = 'true';
    const server = createServer(deps());
    openServers.push(server);
    const base = await listen(server);

    await fetch(`${base}/health`);
    const response = await fetch(`${base}/metrics`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    const body = await response.text();
    expect(body).toContain('crossclaim_http_requests_total');
    expect(body).toMatch(/crossclaim_http_requests_total\{method="GET",status_class="2xx"\} \d+/);
  });
});
