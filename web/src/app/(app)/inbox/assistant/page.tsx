export default function AssistantPage() {
  return (
    <div className="p-6">
      <div className="rounded-[6px] border border-[var(--hairline)] bg-[var(--bg-sheet)] p-5">
        <p className="font-mono-code text-[11px] uppercase tracking-[0.04em] text-[var(--ink-muted)]">
          ROUTE · /inbox/assistant
        </p>
        <h2 className="mt-1 text-[16px] font-semibold text-[var(--ink-primary)]">
          个人业务助手
        </h2>
        <p className="mt-1 text-[13px] text-[var(--ink-muted)]">
          个人 Agent 工作台对话视图。
        </p>
      </div>
    </div>
  );
}
