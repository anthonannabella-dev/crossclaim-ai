/** 安全感设计（§十三）：首次连接平台时的心理门槛由客户界面主动回答。 */
export default function SecurityStrip({ title, points }: { title: string; points: string[] }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
      <p className="text-sm font-semibold text-slate-800">{title}</p>
      <ul className="mt-2 grid gap-1 text-xs text-slate-600 sm:grid-cols-2">
        {points.map((point) => (
          <li key={point} className="flex gap-2">
            <span aria-hidden="true" className="text-emerald-600">
              ✓
            </span>
            <span>{point}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
