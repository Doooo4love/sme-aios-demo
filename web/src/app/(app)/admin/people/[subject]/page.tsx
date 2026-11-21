export default async function AdminPersonAccessPage({
  params,
}: {
  params: Promise<{ subject: string }>;
}) {
  const { subject } = await params;
  return (
    <div className="p-6">
      <div className="rounded-[6px] border border-[var(--hairline)] bg-[var(--bg-sheet)] p-5">
        <p className="font-mono-code text-[11px] uppercase tracking-[0.04em] text-[var(--ink-muted)]">
          ROUTE · /admin/people/{subject}
        </p>
        <h2 className="mt-1 text-[16px] font-semibold text-[var(--ink-primary)]">
          员工模块授权编辑
        </h2>
        <p className="mt-1 font-mono-code text-[12.5px] text-[var(--ink-muted)]">
          目标主体：{subject}
        </p>
      </div>
    </div>
  );
}
