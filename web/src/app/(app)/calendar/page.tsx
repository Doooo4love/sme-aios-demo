export default function CalendarPage() {
  return (
    <div className="p-6">
      <div className="rounded-[6px] border border-[var(--hairline)] bg-[var(--bg-sheet)] p-5">
        <p className="font-mono-code text-[11px] uppercase tracking-[0.04em] text-[var(--ink-muted)]">
          ROUTE · /calendar
        </p>
        <h2 className="mt-1 text-[16px] font-semibold text-[var(--ink-primary)]">
          站内日程与会议
        </h2>
        <p className="mt-1 text-[13px] text-[var(--ink-muted)]">
          查看个人日程与协作房间会议安排。
        </p>
      </div>
    </div>
  );
}
