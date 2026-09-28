import prisma from '../config/database';
import { getRedis } from '../config/redis';
import { getMinio } from '../config/minio';
import { logger } from '../config/logger';
import os from 'os';

interface ServiceStatus {
  status: 'healthy' | 'degraded' | 'down';
  latencyMs: number;
  error?: string;
}

interface HealthReport {
  status: 'healthy' | 'degraded' | 'down';
  uptime: number;
  memory: { usedMB: number; totalMB: number; percent: number };
  cpu: { loadAvg: number[] };
  services: Record<string, ServiceStatus>;
  checkedAt: string;
}

async function checkPostgres(): Promise<ServiceStatus> {
  const start = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { status: 'healthy', latencyMs: Date.now() - start };
  } catch (err: any) {
    logger.error(`[Health] PostgreSQL down: ${err.message}`);
    return { status: 'down', latencyMs: Date.now() - start, error: err.message };
  }
}

async function checkRedis(): Promise<ServiceStatus> {
  const start = Date.now();
  try {
    const redis = getRedis();
    if (!redis) return { status: 'degraded', latencyMs: 0, error: 'Redis not configured' };
    await redis.ping();
    return { status: 'healthy', latencyMs: Date.now() - start };
  } catch (err: any) {
    logger.error(`[Health] Redis down: ${err.message}`);
    return { status: 'down', latencyMs: Date.now() - start, error: err.message };
  }
}

async function checkMinio(): Promise<ServiceStatus> {
  const start = Date.now();
  try {
    const minio = getMinio();
    if (!minio) return { status: 'degraded', latencyMs: 0, error: 'MinIO not configured' };
    await minio.listBuckets();
    return { status: 'healthy', latencyMs: Date.now() - start };
  } catch (err: any) {
    logger.error(`[Health] MinIO down: ${err.message}`);
    return { status: 'down', latencyMs: Date.now() - start, error: err.message };
  }
}

export async function getHealthReport(): Promise<HealthReport> {
  const [pg, redis, minioStorage] = await Promise.all([
    checkPostgres(),
    checkRedis(),
    checkMinio(),
  ]);

  const services = { postgres: pg, redis, minio: minioStorage };
  const anyDown = Object.values(services).some(s => s.status === 'down');
  const anyDegraded = Object.values(services).some(s => s.status === 'degraded');

  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  return {
    status: anyDown ? 'down' : anyDegraded ? 'degraded' : 'healthy',
    uptime: process.uptime(),
    memory: {
      usedMB: Math.round(usedMem / 1024 / 1024),
      totalMB: Math.round(totalMem / 1024 / 1024),
      percent: Math.round((usedMem / totalMem) * 100),
    },
    cpu: { loadAvg: os.loadavg() },
    services,
    checkedAt: new Date().toISOString(),
  };
}

// Alert if services are down (called by health check cron)
export async function checkAndAlert() {
  const report = await getHealthReport();
  if (report.status !== 'healthy') {
    logger.warn(`[Health] System status: ${report.status}`, report.services);
    // TODO: integrate with notification hub for SMS/email alerts
  }
}
