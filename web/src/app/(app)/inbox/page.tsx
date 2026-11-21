import Link from "next/link";

export default function InboxPage() {
  return (
    <div className="p-6">
      <div className="rounded-[6px] border border-[var(--hairline)] bg-[var(--bg-sheet)] p-5">
        <p className="font-mono-code text-[11px] uppercase tracking-[0.04em] text-[var(--ink-muted)]">
          ROUTE · /inbox
        </p>
        <h2 className="mt-1 text-[16px] font-semibold text-[var(--ink-primary)]">
          会话与协作入口
        </h2>
        <p className="mt-1 text-[13px] text-[var(--ink-muted)]">
          统一会话列表与协作房间入口，将由协作模块挂载。
        </p>
        <div className="mt-4 flex gap-2">
          <Link
            href="/inbox/assistant"
            className="inline-flex h-8 items-center rounded-[4px] bg-[var(--accent)] px-3 text-[12.5px] font-medium text-white hover:bg-[var(--accent-hover)]"
          >
            打开个人业务助手
          </Link>
        </div>
      </div>
    </div>
  );
}
