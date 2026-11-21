export default function ProfileSettingsPage() {
  return (
    <div className="p-6">
      <div className="rounded-[6px] border border-[var(--hairline)] bg-[var(--bg-sheet)] p-5">
        <p className="font-mono-code text-[11px] uppercase tracking-[0.04em] text-[var(--ink-muted)]">
          ROUTE · /settings/profile
        </p>
        <h2 className="mt-1 text-[16px] font-semibold text-[var(--ink-primary)]">
          个人资料设置
        </h2>
        <p className="mt-1 text-[13px] text-[var(--ink-muted)]">
          自定义显示名称与员工头像，保存后全局实时生效。
        </p>
      </div>
    </div>
  );
}
