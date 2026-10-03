'use client';

import { useEffect, useState } from 'react';

import type { Messages } from '../../i18n/dictionaries/zh-CN';

interface RecoveryItem {
  scope: 'CONNECTION' | 'IMPORT' | 'CASE';
  refId: string;
  title: string;
  code: string;
  label: string;
  explanation: string;
  nextAction: string;
  recoverable: boolean;
  safeSummary: string;
  occurredAt: string | null;
  details: Record<string, unknown>;
  retry: { available: boolean; actionable: boolean; reason: string };
}

/**
 * PC-04：客户可见的失败 / 恢复提示。
 * - 只展示服务端返回的稳定 code 与安全摘要（不含 stack / SQL / 内部错误文本）。
 * - 仅当 retry.actionable 为 true 时才渲染重试按钮 —— 目前没有安全 retry endpoint，因此只给指引。
 */
export default function RecoveryBanner({ scope, t }: { scope?: 'CONNECTION' | 'IMPORT' | 'CASE'; t: Messages }) {
  const copy = t.recoveryBanner;
  const [items, setItems] = useState<RecoveryItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch('/api/recovery-states', { cache: 'no-store' });
        if (response.status === 401) {
          if (!cancelled) setError(t.common.sessionExpired);
          return;
        }
        if (!response.ok) {
          if (!cancelled) setError(copy.loadFailed);
          return;
        }
        const body = (await response.json()) as { items: RecoveryItem[] };
        if (!cancelled) setItems(body.items);
      } catch {
        if (!cancelled) setError(t.common.networkError);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [copy, t]);

  if (loading) return null;
  // 错误只作为状态块，不在页面顶部反复打扰
  if (error) return null;
  const visible = scope ? items.filter((item) => item.scope === scope) : items;
  if (visible.length === 0) return null;

  return (
    <div className="space-y-2">
      {visible.map((item) => (
        <div
          key={item.scope + ':' + item.refId}
          className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
        >
          <div className="font-medium">
            {copy.titleWithCode
              .replace('{title}', item.title)
              .replace('{label}', item.label)
              .replace('{code}', item.code)}
          </div>
          <div className="mt-1 text-xs">{item.explanation}</div>
          <div className="mt-1 text-xs">{item.safeSummary}</div>
          <div className="mt-1 text-xs font-medium">
            {copy.nextStep.replace('{action}', item.nextAction)}
          </div>
          {item.retry.actionable ? (
            <button type="button" className="mt-2 rounded border border-amber-500 px-2 py-1 text-xs">
              {copy.retry}
            </button>
          ) : (
            <div className="mt-1 text-[11px] text-amber-800">
              {copy.retryUnavailable.replace('{reason}', item.retry.reason)}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
