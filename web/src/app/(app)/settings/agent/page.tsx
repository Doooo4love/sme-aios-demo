export default function AgentSettingsPage() {
  return (
    <div className="p-6">
      <div className="rounded-[6px] border border-[var(--hairline)] bg-[var(--bg-sheet)] p-5">
        <p className="font-mono-code text-[11px] uppercase tracking-[0.04em] text-[var(--ink-muted)]">
          ROUTE · /settings/agent
        </p>
        <h2 className="mt-1 text-[16px] font-semibold text-[var(--ink-primary)]">
          个人 Agent 资料设置
        </h2>
        <p className="mt-1 text-[13px] text-[var(--ink-muted)]">
          自定义个人业务助手的名称与头像，与个人员工资料相互独立。
        </p>
      </div>
    </div>
  );
}
