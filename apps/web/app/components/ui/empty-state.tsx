import Link from 'next/link';

/** 有引导性的空状态（含可选主行动）。 */
export default function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body?: string;
  action?: { label: string; href: string };
}) {
  return (
    <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-5 text-sm text-slate-600">
      <p className="font-medium text-slate-800">{title}</p>
      {body ? <p className="mt-1 text-slate-600">{body}</p> : null}
      {action ? (
        <Link
          href={action.href}
          className="mt-3 inline-block rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
        >
          {action.label}
        </Link>
      ) : null}
    </div>
  );
}
