import type { PipelineStage, PipelineStageState } from '../../lib/case-view';
import StatusBadge, { type BadgeTone } from './status-badge';

const STATE_TONE: Record<PipelineStageState, BadgeTone> = {
  DONE: 'ok',
  CURRENT: 'pending',
  PENDING: 'neutral',
  BLOCKED: 'warn',
};

const STATE_DOT: Record<PipelineStageState, string> = {
  DONE: 'bg-emerald-600 text-white',
  CURRENT: 'bg-sky-600 text-white',
  PENDING: 'bg-slate-100 text-slate-500',
  BLOCKED: 'bg-amber-500 text-white',
};

/**
 * 追回管线（§八）：客户一眼看到「这笔钱现在进行到哪一步」。
 * 只呈现后端状态推导出的阶段；不表示任何自动提交（External Write = HOLD）。
 */
export default function RecoveryPipeline({
  title,
  subtitle,
  stages,
  labels,
}: {
  title: string;
  subtitle?: string;
  stages: PipelineStage[];
  labels: Record<PipelineStageState, string>;
}) {
  return (
    <div>
      <h2 className="text-base font-semibold text-slate-900">{title}</h2>
      {subtitle ? <p className="mt-1 text-sm text-slate-500">{subtitle}</p> : null}
      <ol className="mt-4 space-y-3">
        {stages.map((stage, index) => (
          <li key={stage.key} className="flex gap-3">
            <span
              aria-hidden="true"
              className={
                'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ' +
                STATE_DOT[stage.state]
              }
            >
              {stage.state === 'DONE' ? '✓' : index + 1}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-medium text-slate-800">{stage.label}</p>
                <StatusBadge tone={STATE_TONE[stage.state]}>{labels[stage.state]}</StatusBadge>
              </div>
              {stage.hint ? <p className="mt-1 text-xs text-amber-800">{stage.hint}</p> : null}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
