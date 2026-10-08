/**
 * HISTORICAL_RECOVERY_SCAN_V1 / UI_RESULT_VIEW（轻量产品化；不重构已封板 UI V2）
 * ---------------------------------------------------------------------------
 * 只做只读展示：请求范围 / 实际覆盖 / 状态 / 记录数 / 机会数 / 有效窗口 / 需补证据 / 已过期 / 覆盖完整度。
 * 禁止：跨币种求和、把 estimate 写成到账、把 CLAIM_READY 写成已申报、覆盖不完整却写「全部检查完成」。
 */

export interface HistoricalScanSummaryView {
  scanId: string;
  status: string;
  requestedFrom: string;
  requestedTo: string;
  requestedMonths: number;
  effectiveFrom: string;
  effectiveTo: string;
  coverageFrom: string | null;
  coverageTo: string | null;
  coverage: 'FULL' | 'PARTIAL' | 'SOURCE_LIMITED' | 'UNKNOWN';
  effectiveRangeClamped: boolean;
  shardsTotal: number;
  shardsCompleted: number;
  recordsScanned: number;
  opportunitiesFound: number;
  eligibleFound: number;
  needsEvidenceFound: number;
  expiredFound: number;
  completedAt: string | null;
  disclaimerCodes: readonly string[];
}

export interface HistoricalScanLabels {
  title: string;
  subtitle: string;
  requestedRange: string;
  actualCoverage: string;
  coverageLabel: string;
  coverageFull: string;
  coveragePartial: string;
  coverageSourceLimited: string;
  coverageUnknown: string;
  statusLabel: string;
  recordsScanned: string;
  opportunities: string;
  eligibleWindow: string;
  needsEvidence: string;
  expired: string;
  progressLabel: string;
  notFullNotice: string;
  boundaryNote: string;
  empty: string;
}

function coverageText(summary: HistoricalScanSummaryView, labels: HistoricalScanLabels): string {
  switch (summary.coverage) {
    case 'FULL':
      return labels.coverageFull;
    case 'PARTIAL':
      return labels.coveragePartial;
    case 'SOURCE_LIMITED':
      return labels.coverageSourceLimited;
    default:
      return labels.coverageUnknown;
  }
}

export default function HistoricalScanView({
  summary,
  labels,
}: {
  summary: HistoricalScanSummaryView | null;
  labels: HistoricalScanLabels;
}) {
  if (summary === null) {
    return (
      <section className="rounded-2xl border border-slate-200 bg-white p-6">
        <h1 className="text-xl font-semibold text-slate-900">{labels.title}</h1>
        <p className="mt-2 text-sm text-slate-600">{labels.empty}</p>
      </section>
    );
  }

  const coverage = coverageText(summary, labels);
  // 只有「数据源覆盖确实满足请求区间」时才算完整覆盖（不按请求区间推断）
  const coverageIsFull =
    summary.coverage === 'FULL' &&
    summary.coverageFrom !== null &&
    summary.coverageTo !== null &&
    summary.coverageFrom <= summary.requestedFrom &&
    summary.coverageTo >= summary.requestedTo;

  const rows: Array<{ label: string; value: string }> = [
    { label: labels.requestedRange, value: summary.requestedFrom + ' → ' + summary.requestedTo },
    {
      label: labels.actualCoverage,
      value:
        summary.coverageFrom === null || summary.coverageTo === null
          ? coverage
          : summary.coverageFrom + ' → ' + summary.coverageTo,
    },
    { label: labels.coverageLabel, value: coverage },
    { label: labels.statusLabel, value: summary.status },
    { label: labels.progressLabel, value: summary.shardsCompleted + ' / ' + summary.shardsTotal },
    { label: labels.recordsScanned, value: String(summary.recordsScanned) },
    { label: labels.opportunities, value: String(summary.opportunitiesFound) },
    { label: labels.eligibleWindow, value: String(summary.eligibleFound) },
    { label: labels.needsEvidence, value: String(summary.needsEvidenceFound) },
    { label: labels.expired, value: String(summary.expiredFound) },
  ];

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-6">
      <h1 className="text-xl font-semibold text-slate-900">{labels.title}</h1>
      <p className="mt-2 max-w-2xl text-sm text-slate-600">{labels.subtitle}</p>

      <dl className="mt-5 grid gap-3 sm:grid-cols-2">
        {rows.map((row) => (
          <div key={row.label} className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2">
            <dt className="text-xs text-slate-500">{row.label}</dt>
            <dd className="mt-0.5 text-sm font-medium text-slate-800">{row.value}</dd>
          </div>
        ))}
      </dl>

      {!coverageIsFull ? (
        <p role="status" className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {labels.notFullNotice}
        </p>
      ) : null}

      <p className="mt-4 max-w-2xl text-xs text-slate-500">{labels.boundaryNote}</p>
    </section>
  );
}
