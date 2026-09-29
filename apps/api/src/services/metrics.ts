/**
 * 最小可观测性（O9 / TD-7）：进程内计数器 + Prometheus 文本渲染
 * ---------------------------------------------------------------
 * 原则：
 *   - 零依赖、无副作用、**不采集任何租户/PII 数据**（只按 method 与状态码分类计数）
 *   - 默认**不暴露**：`METRICS_ENABLED=true` 时 `GET /metrics` 才返回，否则 404
 *   - 计数器只存在于进程内（重启清零），足以支撑上线后的 QPS/错误率/延迟观察
 */

export interface MetricsSnapshot {
  uptimeSeconds: number;
  requestsTotal: number;
  /** 键为 `${method}|${statusClass}`，例如 `GET|2xx` */
  byMethodAndStatus: Record<string, number>;
  durationSumMs: number;
  durationCount: number;
}

export interface Metrics {
  observe(method: string, statusCode: number, durationMs: number): void;
  snapshot(): MetricsSnapshot;
  render(): string;
}

/** 2xx / 4xx / 5xx …；非标准状态码归入 `other` */
export function statusClassOf(statusCode: number): string {
  if (!Number.isFinite(statusCode)) return 'other';
  const klass = Math.floor(statusCode / 100);
  return klass >= 1 && klass <= 5 ? `${klass}xx` : 'other';
}

/** Prometheus 标签值转义（只保留安全字符，避免注入） */
function escapeLabel(value: string): string {
  return value.replace(/[^A-Za-z0-9_\-]/g, '_').slice(0, 32);
}

export function createMetrics(now: () => number = Date.now, startedAtMs: number = now()): Metrics {
  const pairs = new Map<string, number>();
  let durationSumMs = 0;
  let durationCount = 0;

  return {
    observe(method, statusCode, durationMs) {
      const methodKey = escapeLabel((method || 'UNKNOWN').toUpperCase());
      const classKey = statusClassOf(statusCode);
      const key = `${methodKey}|${classKey}`;
      pairs.set(key, (pairs.get(key) ?? 0) + 1);
      if (Number.isFinite(durationMs) && durationMs >= 0) {
        durationSumMs += durationMs;
        durationCount += 1;
      }
    },

    snapshot() {
      const requestsTotal = [...pairs.values()].reduce((sum, value) => sum + value, 0);
      return {
        uptimeSeconds: Math.max(0, Math.round((now() - startedAtMs) / 1000)),
        requestsTotal,
        byMethodAndStatus: Object.fromEntries([...pairs.entries()].sort()),
        durationSumMs,
        durationCount,
      };
    },

    render() {
      const snapshot = this.snapshot();
      const lines: string[] = [
        '# HELP crossclaim_http_requests_total HTTP 请求计数（按方法与状态码分类）',
        '# TYPE crossclaim_http_requests_total counter',
      ];
      for (const [key, value] of Object.entries(snapshot.byMethodAndStatus)) {
        const [method, klass] = key.split('|');
        lines.push(
          `crossclaim_http_requests_total{method="${method}",status_class="${klass}"} ${value}`,
        );
      }
      lines.push(
        '# HELP crossclaim_http_request_duration_ms HTTP 请求耗时（毫秒）',
        '# TYPE crossclaim_http_request_duration_ms summary',
        `crossclaim_http_request_duration_ms_sum ${snapshot.durationSumMs}`,
        `crossclaim_http_request_duration_ms_count ${snapshot.durationCount}`,
        '# HELP crossclaim_process_uptime_seconds 进程运行时长（秒）',
        '# TYPE crossclaim_process_uptime_seconds gauge',
        `crossclaim_process_uptime_seconds ${snapshot.uptimeSeconds}`,
        '',
      );
      return lines.join('\n');
    },
  };
}
