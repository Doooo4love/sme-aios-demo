import Link from "next/link";

export default function AdminOperationsPage() {
  return (
    <div className="p-6">
      <div className="rounded-[6px] border border-[var(--hairline)] bg-[var(--bg-sheet)] p-5">
        <p className="font-mono-code text-[11px] uppercase tracking-[0.04em] text-[var(--ink-muted)]">
          ROUTE · /admin
        </p>
        <h2 className="mt-1 text-[16px] font-semibold text-[var(--ink-primary)]">
          运维控制中心
        </h2>
        <p className="mt-1 text-[13px] text-[var(--ink-muted)]">
          ERP 写入控制、异常队列监控、主体停权与审计检查点。
        </p>
        <div className="mt-4">
          <Link
            href="/admin/exceptions"
            className="inline-flex h-8 items-center rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-subtle)] px-3 text-[12.5px] font-medium text-[var(--ink-primary)] hover:bg-[var(--bg-plane)]"
          >
            查看异常队列
          </Link>
        </div>
      </div>
    </div>
  );
}
