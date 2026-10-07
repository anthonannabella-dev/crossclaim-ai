'use client';

import { useState } from 'react';

import {
  isBroadGoalIntent,
  orderGoalSuggestions,
  type GoalSuggestionKey,
  type KeyedGoalSuggestion,
} from '../../lib/goal-input-guidance';

export interface GoalConsoleLabels {
  title: string;
  subtitle: string;
  placeholder: string;
  /** GOAL INPUT UX GUIDANCE：首次使用说明（轻量，不抢占 Hero 主视觉） */
  firstUseHint: string;
  submit: string;
  suggestedTitle: string;
  suggestion1: string;
  suggestion2: string;
  suggestion3: string;
  suggestion4: string;
  /** GOAL INPUT UX GUIDANCE：输入过于宽泛时的自然语言辅助提示（不阻断提交） */
  broadHint: string;
  busy: string;
  recordedTitle: string;
  recordedBody: string;
  planDomains: string;
  scopePlatform: string;
  scopeLogistics: string;
  scopeCustoms: string;
  scopeIndependentSite: string;
  scopeOther: string;
  startedLink: string;
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
 * CUSTOMER-UI-PRODUCTIZATION-V2 / P1：AI Goal Hero。
 * 首页唯一主入口：用客户自己的话描述目标。
 * 只把文本交给服务端理解并记录 —— 前端不做任何业务判定，也不声称已执行；
 * 结果区只出现客户语言（业务范围），**不出现 domain / task namespace / 任务计数**。
 */
export default function GoalConsole({
  labels,
  signals = [],
}: {
  labels: GoalConsoleLabels;
  /** GOAL INPUT UX GUIDANCE：只来自首页已有的只读事实；缺省 = 默认 4 条顺序。 */
  signals?: readonly GoalSuggestionKey[];
}) {
  return <GoalConsoleView labels={labels} signals={signals} />;
}

/**
 * GOAL INPUT UX GUIDANCE：`signals` 只来自首页已有的只读事实（`GET /accounts`），
 * 仅用于调整建议项的**排列**；为空时保持默认 4 条顺序。
 */
export function GoalConsoleView({
  labels,
  signals,
}: {
  labels: GoalConsoleLabels;
  signals: readonly GoalSuggestionKey[];
}) {
  const keyed: KeyedGoalSuggestion[] = [
    { key: 'PLATFORM', text: labels.suggestion1 },
    { key: 'LOGISTICS', text: labels.suggestion2 },
    { key: 'CUSTOMS', text: labels.suggestion3 },
    { key: 'INDEPENDENT_SITE', text: labels.suggestion4 },
  ];
  const suggestions = orderGoalSuggestions(keyed, signals);
  const scopeNames: Record<string, string> = {
    PLATFORM: labels.scopePlatform,
    LOGISTICS: labels.scopeLogistics,
    CUSTOMS: labels.scopeCustoms,
    INDEPENDENT_SITE: labels.scopeIndependentSite,
  };
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

  const scopes =
    recorded === null
      ? []
      : Array.from(new Set(recorded.interpretation.domains.map((domain) => scopeNames[domain] ?? labels.scopeOther)));

  return (
    <section className="rounded-2xl bg-slate-50 p-6 sm:p-10">
      <h1 id="ai-goal-hero" className="max-w-3xl text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">
        {labels.title}
      </h1>
      <p className="mt-3 max-w-2xl text-sm text-slate-600 sm:text-base">{labels.subtitle}</p>
      <div className="mt-6 flex flex-col gap-2 sm:flex-row">
        <input
          value={intent}
          onChange={(event) => setIntent(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void submit();
          }}
          placeholder={labels.placeholder}
          aria-label={labels.title}
          className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-base text-slate-900 sm:flex-1"
        />
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy || intent.trim() === ''}
          className="rounded-xl bg-slate-900 px-5 py-3 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {busy ? labels.busy : labels.submit}
        </button>
      </div>

      {/* 首次使用说明：只解释「说目标即可」，不暗示任何尚未开放的真实外部执行能力。 */}
      <p className="mt-3 max-w-2xl text-xs text-slate-500 sm:text-sm">{labels.firstUseHint}</p>

      {/* 宽泛输入的自然语言提示：仅提示，不阻断提交、不强制补字段、不引入 Wizard。 */}
      {isBroadGoalIntent(intent) && recorded === null ? (
        <p
          role="status"
          className="mt-3 max-w-2xl rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600 sm:text-sm"
        >
          {labels.broadHint}
        </p>
      ) : null}

      <p className="mt-6 text-xs font-semibold uppercase tracking-wide text-slate-400">{labels.suggestedTitle}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {suggestions.map((suggestion) => (
          <button
            key={suggestion.key}
            type="button"
            onClick={() => setIntent(suggestion.text)}
            className="rounded-full border border-slate-300 bg-white px-3 py-1 text-xs text-slate-700 hover:bg-slate-100"
          >
            {suggestion.text}
          </button>
        ))}
      </div>

      {error ? (
        <p role="alert" className="mt-5 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {error}
        </p>
      ) : null}

      {recorded ? (
        <div className="mt-6 rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-sm font-semibold text-slate-900">{labels.recordedTitle}</p>
          <p className="mt-1 max-w-2xl text-sm text-slate-600">{labels.recordedBody}</p>
          <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-slate-400">{labels.planDomains}</p>
          <ul className="mt-2 flex flex-wrap gap-2">
            {scopes.map((scope) => (
              <li key={scope} className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-700">
                {scope}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-slate-500">{labels.statusNote}</p>
          <a href="#customer-tasks" className="mt-3 inline-block text-xs text-slate-600 underline hover:text-slate-900">
            {labels.startedLink}
          </a>
        </div>
      ) : null}
    </section>
  );
}
