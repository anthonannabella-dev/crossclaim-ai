'use client';

import { useState } from 'react';

export interface GoalConsoleLabels {
  title: string;
  subtitle: string;
  placeholder: string;
  submit: string;
  suggestedTitle: string;
  suggestion1: string;
  suggestion2: string;
  suggestion3: string;
  suggestion4: string;
  suggestion5: string;
  busy: string;
  recordedTitle: string;
  recordedBody: string;
  planDomains: string;
  planTasks: string;
  statusNote: string;
  unsupported: string;
  injection: string;
  requestFailed: string;
  networkError: string;
}

interface GoalInterpretation {
  goalType: string;
  domains: string[];
  timeRange: { kind: string; months?: number };
}

interface GoalRecorded {
  goalId: string;
  status: string;
  interpretation: GoalInterpretation;
  plan: { tasks: Array<{ domain: string; dedupeKey: string }> };
}

/**
 * AGENT EXPERIENCE LAYER / P4：Goal Console（AI Recovery Manager）。
 * 只把客户目标文本交给服务端理解并记录 —— **前端不做任何业务判定**，也不声称已执行：
 * 服务端返回 executionPerformed=false，界面据此只展示「已记录 + 已生成计划 + 当前 HOLD」。
 */
export default function GoalConsole({ labels }: { labels: GoalConsoleLabels }) {
  const suggestions = [
    labels.suggestion1,
    labels.suggestion2,
    labels.suggestion3,
    labels.suggestion4,
    labels.suggestion5,
  ];
  const [intent, setIntent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recorded, setRecorded] = useState<GoalRecorded | null>(null);

  async function submit() {
    const text = intent.trim();
    if (text === '' || busy) return;
    setBusy(true);
    setError(null);
    setRecorded(null);
    try {
      const response = await fetch('/api/agent-goals', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ intent: text }),
      });
      if (response.status === 422) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setError(body.error === 'GOAL_INJECTION_SUSPECTED' ? labels.injection : labels.unsupported);
        return;
      }
      if (!response.ok) {
        setError(labels.requestFailed.replace('{status}', String(response.status)));
        return;
      }
      setRecorded((await response.json()) as GoalRecorded);
    } catch {
      setError(labels.networkError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-8">
      <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">{labels.title}</h1>
      <p className="mt-2 max-w-3xl text-sm text-slate-600">{labels.subtitle}</p>
      <div className="mt-4 flex flex-col gap-2 sm:flex-row">
        <input
          value={intent}
          onChange={(event) => setIntent(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void submit();
          }}
          placeholder={labels.placeholder}
          aria-label={labels.title}
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 sm:flex-1"
        />
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy || intent.trim() === ''}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {busy ? labels.busy : labels.submit}
        </button>
      </div>

      <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-slate-400">{labels.suggestedTitle}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {suggestions.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            onClick={() => setIntent(suggestion)}
            className="rounded-full border border-slate-300 px-3 py-1 text-xs text-slate-700 hover:bg-slate-50"
          >
            {suggestion}
          </button>
        ))}
      </div>

      {error ? (
        <p role="alert" className="mt-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {error}
        </p>
      ) : null}

      {recorded ? (
        <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-4">
          <p className="text-sm font-semibold text-slate-900">{labels.recordedTitle}</p>
          <p className="mt-1 text-sm text-slate-600">{labels.recordedBody}</p>
          <p className="mt-2 text-xs text-slate-500">{labels.planDomains}</p>
          <p className="text-sm text-slate-800">{recorded.interpretation.domains.join(' / ')}</p>
          <p className="mt-2 text-sm text-slate-800">
            {labels.planTasks.replace('{count}', String(recorded.plan.tasks.length))}
          </p>
          <p className="mt-2 text-xs text-slate-500">{labels.statusNote}</p>
        </div>
      ) : null}
    </section>
  );
}
