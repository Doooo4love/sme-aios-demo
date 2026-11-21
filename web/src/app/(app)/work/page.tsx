import Link from "next/link";

export default function WorkPage() {
  return (
    <div className="p-6">
      <div className="rounded-[6px] border border-[var(--hairline)] bg-[var(--bg-sheet)] p-5">
        <p className="font-mono-code text-[11px] uppercase tracking-[0.04em] text-[var(--ink-muted)]">
          ROUTE · /work
        </p>
        <h2 className="mt-1 text-[16px] font-semibold text-[var(--ink-primary)]">
          待办审批与业务队列
        </h2>
        <p className="mt-1 text-[13px] text-[var(--ink-muted)]">
          待我处理、已提交提案与受控预审案件工作区。
        </p>
        <div className="mt-4">
          <Link
            href="/orders/new"
            className="inline-flex h-8 items-center rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-subtle)] px-3 text-[12.5px] font-medium text-[var(--ink-primary)] hover:bg-[var(--bg-plane)]"
          >
            新建订单进件
          </Link>
        </div>
      </div>
    </div>
  );
}
