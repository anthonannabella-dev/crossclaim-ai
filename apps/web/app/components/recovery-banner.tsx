'use client';

import { useEffect, useState } from 'react';

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
 * - 仅当 retry.actionable 为 true 时才渲染「重试」按钮 —— 目前没有安全 retry endpoint，因此只给指引。
 */
export default function RecoveryBanner({ scope }: { scope?: 'CONNECTION' | 'IMPORT' | 'CASE' }) {
  const [items, setItems] = useState<RecoveryItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch('/api/recovery-states', { cache: 'no-store' });
        if (response.status === 401) {
          if (!cancelled) setError('会话已失效，请重新登录');
          return;
        }
        if (!response.ok) {
          if (!cancelled) setError('无法加载恢复状态');
          return;
        }
        const body = (await response.json()) as { items: RecoveryItem[] };
        if (!cancelled) setItems(body.items);
      } catch {
        if (!cancelled) setError('网络错误');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) return null;
  if (error) return null; // 不要在页面顶部反复打扰：错误只作为状态块
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
            {item.title} · {item.label}（{item.code}）
          </div>
          <div className="mt-1 text-xs">{item.explanation}</div>
          <div className="mt-1 text-xs">{item.safeSummary}</div>
          <div className="mt-1 text-xs font-medium">下一步：{item.nextAction}</div>
          {item.retry.actionable ? (
            <button type="button" className="mt-2 rounded border border-amber-500 px-2 py-1 text-xs">
              重试
            </button>
          ) : (
            <div className="mt-1 text-[11px] text-amber-800">
              该问题暂不支持一键重试（{item.retry.reason}）
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
