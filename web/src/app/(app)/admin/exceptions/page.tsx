export default function AdminExceptionsPage() {
  return (
    <div className="p-6">
      <div className="rounded-[6px] border border-[var(--hairline)] bg-[var(--bg-sheet)] p-5">
        <p className="font-mono-code text-[11px] uppercase tracking-[0.04em] text-[var(--ink-muted)]">
          ROUTE · /admin/exceptions
        </p>
        <h2 className="mt-1 text-[16px] font-semibold text-[var(--ink-primary)]">
          运维异常单据队列
        </h2>
        <p className="mt-1 text-[13px] text-[var(--ink-muted)]">
          查看 NEEDS_OPERATOR 与 OUTCOME_UNKNOWN 状态单据并触发只读回查。
        </p>
      </div>
    </div>
  );
}
